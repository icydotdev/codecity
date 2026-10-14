#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCity, LANDS, page, type Land } from "./city.js";
import { watchCity } from "./server.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  Usage: codecity [folder] [options]

  Renders the git repository in [folder] (default: the current directory)
  as a 3D map, one building per file, and keeps it up to date as files
  change. Runs locally; no data leaves your machine.

  Options:
    -o <file>         Write the map to one HTML file and stop, to keep or share
    --once            The same, to a temporary folder
    --port <number>   Port to serve the live map on (default: 3737)
    --theme <name>    Theme: ${LANDS.join(", ")} (default: auto)
    --link <url>      Link each file to <url>/<path> instead of opening it
                      in VS Code, for maps you publish. For a GitHub
                      repository: https://github.com/<owner>/<repo>/blob/main
    --no-browser      Don't open the browser automatically
    -h, --help        Show this help message
`);
  process.exit(0);
}

const take = (...flags: string[]): string | null => {
  for (const flag of flags) {
    const i = args.indexOf(flag);
    if (i >= 0) return args.splice(i, 2)[1] ?? null;
  }
  return null;
};
const has = (...flags: string[]): boolean => {
  let found = false;
  for (const flag of flags) {
    const i = args.indexOf(flag);
    if (i >= 0) args.splice(i, 1), (found = true);
  }
  return found;
};
const fail = (message: string): never => {
  console.error(`\n  Error: ${message}\n`);
  process.exit(1);
};

const out = take("-o", "--out");
// "plain" was the name of the theme that is now light or dark, whichever the machine is set to.
const wanted = ((name) => (name === "plain" ? "auto" : name))(take("--land", "--theme"));
const port = Number(take("--port") ?? 3737);
const link = take("--link");
// Watching used to be asked for. It is what happens now, so the flag is accepted and does nothing.
has("-w", "--watch");
const once = has("--once", "--no-watch");
const watching = !once && out === null;
const noBrowser = has("--no-browser", "--no-open");
const unknown = args.find((arg) => arg.startsWith("-"));
if (unknown) fail(`Unknown option ${unknown}. Try codecity --help`);
if (wanted && !(LANDS as readonly string[]).includes(wanted)) fail(`Unknown theme "${wanted}". Available: ${LANDS.join(", ")}.`);
if (link !== null && !/^https?:\/\/\S+$/.test(link)) fail("--link needs a web address that starts with http:// or https://.");
if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port needs a number between 1 and 65535.");
const land = wanted as Land | null;
const dir = path.resolve(args[0] ?? ".");

const show = (target: string) => {
  if (noBrowser) return;
  execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [target], () => {});
};
const explain = (error: unknown): never => {
  const message = String((error as Error).message ?? error).split("\n")[0]!;
  return fail(/not a git repository|ENOENT|Command failed: git/.test(message) ? `${dir} is not inside a git repository.` : message);
};

if (watching) {
  try {
    const watcher = await watchCity(dir, { port, land, log: (line) => console.log(`  ${line}`) });
    console.log(`\n  🏙️  Watching ${dir}\n      ${watcher.url}\n\n  Ctrl+C to stop.\n`);
    show(watcher.url);
    process.on("SIGINT", () => {
      watcher.close();
      process.exit(0);
    });
  } catch (error) {
    explain(error);
  }
} else {
  try {
    const { city } = buildCity(dir, { land, link });
    if (!city.files.length) fail("Git knows of no files here yet.");
    const target = path.resolve(out ?? path.join(os.tmpdir(), "codecity", `${city.name}.html`));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, page(city));
    console.log(`\n  🏙️  ${city.name}: ${city.files.length.toLocaleString()} files → ${target}\n`);
    if (city.quick) console.log("  The history is very long, so the timelapse shows when buildings appeared but not how they grew.\n");
    show(target);
  } catch (error) {
    explain(error);
  }
}
