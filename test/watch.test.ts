import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { watchCity } from "../src/server.js";

// The live map is what `codecity` does by default, on every system. This is the whole loop: serve
// the page, hear about a saved file, send the new town. It is the test most likely to differ
// between macOS, Linux and Windows, because watching a folder is done differently on each.

/** The next town the watcher sends, as text. */
function nextTown(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}/events`, (response) => {
      let seen = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        seen += chunk;
        const at = seen.indexOf("event: city");
        if (at >= 0 && seen.indexOf("\n\n", at) >= 0) {
          request.destroy();
          resolve(seen.slice(at));
        }
      });
    });
    request.on("error", (error) => (request.destroyed ? undefined : reject(error)));
  });
}

test("a saved file reaches the open page, in a folder inside a folder", async () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "codecity-watch-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
  writeFileSync(path.join(dir, "src", "deep", "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");

  const watcher = await watchCity(dir, { port: 3900 + Math.floor(Math.random() * 400), land: null });
  try {
    const page = await fetch(watcher.url).then((response) => response.text());
    expect(page, "the page carries the town").toContain("src/deep/a.ts");

    const town = nextTown(watcher.url);
    // Give the connection a moment to open, then save a new file two folders down.
    await new Promise((done) => setTimeout(done, 400));
    writeFileSync(path.join(dir, "src", "deep", "b.ts"), 'import { a } from "./a";\nexport const b = a;\n');
    expect(await town).toContain("src/deep/b.ts");
  } finally {
    watcher.close();
  }
}, 30_000);
