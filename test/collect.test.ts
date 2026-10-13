import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, findImports, lastPull, plainJson, profile, readLog, resolveImport, sizeLog } from "../src/collect.js";
import { matters } from "../src/server.js";

test("a file's silhouette: its floors run from the end of the file up to its first lines", () => {
  const wide = "x".repeat(70);
  const shape = profile([...Array(60).fill("ab"), ...Array(60).fill(wide)].join("\n") + "\n");
  expect(shape.lines).toBe(120);
  expect(shape.floors).toHaveLength(2);
  expect(shape.floors[0]![0], "the long lines at the end of the file are the wide ground floor").toBeGreaterThan(shape.floors[1]![0]);
});

test("imports are read as written, whichever way they are written", () => {
  const text = `import a from "./a";
import {
  b,
  c,
} from '../lib/b.js';
import type { T } from "@/types";
import "./side-effect.css";
export * from "./again";
export const name = "not-an-import";
const d = require("./d");
const e = await import("./e");
import react from "react";`;
  expect(findImports(text).sort()).toEqual(["../lib/b.js", "./a", "./again", "./d", "./e", "./side-effect.css", "@/types", "react"].sort());
});

test("an import is found as a file here, and a package is not", () => {
  const here = new Set(["src/a.ts", "src/lib/b.ts", "src/ui/index.tsx", "types.ts", "src/x.json"]);
  const has = (path: string) => here.has(path);
  const aliases = [{ prefix: "@/", target: "" }];
  expect(resolveImport("./lib/b", "src/a.ts", has, aliases)).toBe("src/lib/b.ts");
  expect(resolveImport("../a", "src/lib/b.ts", has, aliases)).toBe("src/a.ts");
  expect(resolveImport("./lib/b.js", "src/a.ts", has, aliases), "a .js ending that means the .ts file").toBe("src/lib/b.ts");
  expect(resolveImport("./ui", "src/a.ts", has, aliases), "a folder means its index").toBe("src/ui/index.tsx");
  expect(resolveImport("@/types", "src/a.ts", has, aliases)).toBe("types.ts");
  expect(resolveImport("./x.json", "src/a.ts", has, aliases)).toBe("src/x.json");
  expect(resolveImport("react", "src/a.ts", has, aliases)).toBeNull();
  expect(resolveImport("../../outside", "src/a.ts", has, aliases)).toBeNull();
});

test("a tsconfig's comments and trailing commas go, and its strings are left alone", () => {
  const text = `{
  // where things are
  "compilerOptions": {
    "paths": { "@/*": ["./*"], }, /* the alias */
  },
  "include": ["**/*.ts", ".next/types/**/*.ts",],
}`;
  expect(JSON.parse(plainJson(text))).toEqual({ compilerOptions: { paths: { "@/*": ["./*"] } }, include: ["**/*.ts", ".next/types/**/*.ts"] });
});

const LOG = ["\x01300\x02Ana\n\n10\t2\tsrc/a.ts\n-\t-\tlogo.png\n", "\x01200\x02Ben\n\n5\t0\tsrc/a.ts\n3\t3\tgone.ts\n", "\x01100\x02Ana\n\n20\t0\tsrc/a.ts\n"].join("");

test("the log is read into what git remembers of each file", () => {
  const past = readLog(LOG);
  const a = past.get("src/a.ts")!;
  expect([a.birth, a.modified, a.commits]).toEqual([100, 300, 3]);
  expect([...a.authors]).toEqual([["Ana", 2], ["Ben", 1]]);
  expect(a.changes, "time and lines gained, newest first").toEqual([300, 8, 200, 5, 100, 20]);
  expect(past.get("logo.png")!.changes, "a file that is not text has no lines to count").toEqual([300, 0]);
  expect([...readLog(LOG, new Set(["src/a.ts"])).keys()], "files that no longer exist are not kept").toEqual(["src/a.ts"]);
});

test("the log is read the same when it only has names", () => {
  const past = readLog("\x01300\x02Ana\n\nsrc/a.ts\nsrc/b.ts\n\x01100\x02Ana\n\nsrc/a.ts\n");
  expect(past.get("src/a.ts")).toMatchObject({ birth: 100, modified: 300, commits: 2 });
  expect(past.get("src/b.ts")).toMatchObject({ birth: 300, commits: 1 });
});

test("a file's length through time ends at the length it has now", () => {
  expect(sizeLog([300, 8, 200, 5, 100, 20], 33)).toEqual([100, 20, 200, 25, 300, 33]);
  expect(sizeLog([300, 8, 200, 5, 100, 20], 66), "the sums drifted, so they are stretched to fit").toEqual([100, 40, 200, 50, 300, 66]);
  expect(sizeLog([300, 0, 100, 0], 50), "nothing was measured: it is its present length throughout").toEqual([100, 50, 300, 50]);
  expect(sizeLog([], 50)).toEqual([]);
});

test("a long history is thinned, keeping its first and last moments", () => {
  const changes = Array.from({ length: 200 }, (_, i) => [1000 - i, 1]).flat();
  const log = sizeLog(changes, 200, 24);
  expect(log).toHaveLength(48);
  expect([log[0], log[1]]).toEqual([801, 1]);
  expect([log.at(-2), log.at(-1)]).toEqual([1000, 200]);
});

test("the watcher looks again for a saved file or a commit, and not for git's own housekeeping", () => {
  expect(matters("src/app.ts")).toBe(true);
  expect(matters(".git/HEAD")).toBe(true);
  expect(matters(".git/index")).toBe(true);
  expect(matters(".git/refs/heads/main")).toBe(true);
  expect(matters(".git/index.lock")).toBe(false);
  expect(matters(".git/objects/ab/cdef")).toBe(false);
  expect(matters("node_modules/react/index.js")).toBe(false);
  expect(matters("packages/web/node_modules/x/y.js")).toBe(false);
});

test("the last pull is found among HEAD's moves, whether it merged or rebased", () => {
  const move = (hash: string, what: string, at = 100) => ({ hash, what, at });
  expect(lastPull([move("c", "commit: mine"), move("b", "pull: Fast-forward", 90), move("a", "commit: before")]), "a plain pull: one move").toEqual({ from: "a", to: "b", at: 90 });
  expect(
    lastPull([move("f", "pull --rebase (finish): returning to refs/heads/main", 80), move("e", "pull --rebase (pick): mine"), move("d", "pull --rebase (start): checkout abc"), move("a", "commit: mine")]),
    "a rebasing pull is several moves in a row, and what came before it is before the oldest",
  ).toEqual({ from: "a", to: "f", at: 80 });
  expect(lastPull([move("b", "commit: two"), move("a", "commit: one")]), "never pulled").toBeNull();
  expect(lastPull([move("a", "pull: Fast-forward")]), "nothing on record before it").toBeNull();
  expect(lastPull([move("b", "checkout: moving from pull-fix to main"), move("a", "commit: one")]), "a branch with pull in its name is not a pull").toBeNull();
});

test("a real pull: the files it changed are named, whenever their commits were written", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codecity-pull-"));
  const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe" });
  const [theirs, mine] = [path.join(dir, "theirs"), path.join(dir, "mine")];
  execFileSync("git", ["init", "-q", "-b", "main", theirs]);
  writeFileSync(path.join(theirs, "a.ts"), "one\n");
  writeFileSync(path.join(theirs, "b.ts"), "one\n");
  run(theirs, "add", "-A");
  run(theirs, "commit", "-q", "-m", "first");
  execFileSync("git", ["clone", "-q", theirs, mine]);
  expect(collect(mine).repo.pull, "a fresh clone has pulled nothing").toBeNull();

  writeFileSync(path.join(theirs, "b.ts"), "one\ntwo\n");
  writeFileSync(path.join(theirs, "c.ts"), "new\n");
  run(theirs, "add", "-A");
  // Written long ago: its date must not matter, only that the pull brought it.
  run(theirs, "commit", "-q", "-m", "second", "--date=2001-01-01T00:00:00");
  run(mine, "pull", "-q", "--ff-only");
  const pull = collect(mine).repo.pull;
  expect(pull?.files.sort()).toEqual(["b.ts", "c.ts"]);
  expect(pull!.at, "when it arrived here, not when it was written").toBeGreaterThan(Date.now() / 1000 - 120);
}, 30_000);
