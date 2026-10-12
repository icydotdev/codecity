#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "../src/collect.mjs";
import { layout } from "../src/layout.mjs";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(`repocity [folder] [-o map.html] [--land plain|corporate|beach] [--no-open]

Draws the git repository in [folder] (default: here) as a town, one building
for every file, and opens it in your browser. Nothing leaves your machine.
--land chooses what the town stands on; the buildings are the same in each.`);
  process.exit(0);
}
const take = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? null : args.splice(i, 2)[1];
};
const out = take("-o") ?? take("--out");
const land = take("--land") ?? take("--theme");
if (land && !["plain", "corporate", "beach"].includes(land)) {
  console.error(`repocity: no land called "${land}". There is plain, corporate and beach.`);
  process.exit(1);
}
const open = !args.includes("--no-open");
const dir = path.resolve(args.find((a) => !a.startsWith("-")) ?? ".");

let repo;
try {
  repo = collect(dir);
} catch (error) {
  console.error(`repocity: ${dir} is not inside a git repository (${String(error.message).split("\n")[0]})`);
  process.exit(1);
}
if (!repo.files.length) {
  console.error("repocity: git knows of no files here yet.");
  process.exit(1);
}

const plan = layout(repo.files);
const round = (n) => Math.round(n * 1000) / 1000;
const placeOf = new Map(plan.plots.map((plot, i) => [plot.file.path, i]));
const data = {
  name: repo.name,
  root: repo.root,
  branch: repo.branch,
  head: repo.head,
  at: repo.at,
  land,
  authors: repo.authors,
  w: round(plan.w),
  h: round(plan.h),
  dirs: plan.dirs.map((d) => ({ path: d.path, label: d.label, depth: d.depth, x: round(d.x), y: round(d.y), w: round(d.w), h: round(d.h) })),
  files: plan.plots.map(({ file, depth, x, y, w, h }) => ({ ...file, uses: file.uses.map((used) => placeOf.get(used)), depth, x: round(x), y: round(y), w: round(w), h: round(h) })),
};

const here = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(here, "../src/viewer.html"), "utf8")
  .replace("__TITLE__", () => repo.name.replace(/[<>&]/g, ""))
  .replace("__DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c"));

const target = path.resolve(out ?? path.join(os.tmpdir(), "repocity", `${repo.name}.html`));
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, page);
console.log(`${repo.name}: ${repo.files.length} files → ${target}`);
if (open) execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [target], () => {});
