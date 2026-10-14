// Builds codecity.icy.dev into _site/: this page, its pictures, and a live map of the React
// repository drawn by the codecity in this commit. Run after `npm run build`; Vercel runs both.
// Maps of other repositories are not built here: the site forwards those to the drawing server
// (service/), as set out in vercel.json.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "_site");
const run = (command, args) => execFileSync(command, args, { stdio: ["ignore", "inherit", "inherit"] });

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "demo"), { recursive: true });
cpSync(path.join(root, "site"), out, { recursive: true, filter: (from) => !from.endsWith("build.mjs") });
cpSync(path.join(root, "assets"), path.join(out, "assets"), { recursive: true });

// Commits and folders only: the history is read by name, and the files as they are today.
const react = path.join(os.tmpdir(), "codecity-react");
rmSync(react, { recursive: true, force: true });
run("git", ["clone", "--quiet", "--filter=blob:none", "--single-branch", "https://github.com/react/react", react]);
const head = execFileSync("git", ["-C", react, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
run(process.execPath, [path.join(root, "dist/cli.js"), react, "-o", path.join(out, "demo/react.html"), "--no-browser", "--link", `https://github.com/react/react/blob/${head}`]);
rmSync(react, { recursive: true, force: true });
