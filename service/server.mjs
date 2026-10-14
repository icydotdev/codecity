// codecity on the web: give it a public GitHub repository, get the map at a link to share.
//
// Made to run on one small box at a fixed price. It clones and draws one repository at a time,
// keeps the finished maps on disk for a day, and turns work away rather than taking on more:
// a queue of ten, a size limit, time limits on each step and a few new maps per visitor per
// hour. When it is busy, people are told so; the bill stays the same.
//
// The one thing a host charges for by use is bandwidth, so that has a monthly budget too. It is
// counted in bytes actually sent and kept on disk, and once it is spent, maps are not served
// again until the next month.
//
// No dependencies beyond Node and git. The drawing is done by the codecity command in ../dist,
// in a process of its own, so a repository too big for the box takes down that process and
// not this one.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const number = (name, fallback) => Number(process.env[name] ?? fallback);
const LIMIT = {
  /** Repository size as GitHub reports it, all history included. Only recent history is cloned. */
  repoMB: number("MAX_REPO_MB", 2000),
  /** Commits of history to clone. The timeline starts here on older repositories. */
  depth: number("HISTORY_DEPTH", 3000),
  cloneSeconds: number("CLONE_SECONDS", 120),
  drawSeconds: number("DRAW_SECONDS", 120),
  /** Memory for the drawing process. With git beside it, this keeps a 512 MB box standing. */
  drawMB: number("DRAW_MB", 360),
  /** Repositories waiting to be drawn. More than this and people are asked to come back later. */
  queue: number("MAX_QUEUE", 10),
  /** New maps one visitor may ask for in an hour. Maps already drawn are not counted. */
  perHour: number("MAPS_PER_VISITOR_PER_HOUR", 5),
  cacheMB: number("CACHE_MB", 500),
  /** How old a map may be before it is drawn again. The old one is shown meanwhile. */
  freshHours: number("FRESH_HOURS", 24),
  /** Bytes this service may send in a calendar month (UTC). Keep it under the plan's allowance. */
  monthGB: number("BANDWIDTH_GB_PER_MONTH", 3),
};
const PORT = number("PORT", 3000);
/** What must outlast a restart: the maps, and the bandwidth spent this month. A persistent disk. */
const HOME = process.env.DATA_DIR ?? "/tmp/codecity";
const MAPS = path.join(HOME, "maps");
const USAGE = path.join(HOME, "usage.json");
/** Clones, which need not: scratch space, not on the disk. */
const WORK = process.env.WORK_DIR ?? "/tmp/codecity-work";
/** Optional. Without it GitHub answers 60 lookups an hour; with any token, 5,000. */
const TOKEN = process.env.GITHUB_TOKEN;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

const HOUR = 3_600_000;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const keyOf = (full) => full.toLowerCase();
const mapFile = (key) => path.join(MAPS, key.replace("/", "__") + ".html.gz");
const ago = (ms) => Date.now() - ms;

// ------------------------------------------------------------------ GitHub
/** What GitHub says about a repository, remembered for ten minutes. */
const lookups = new Map();
async function lookUp(owner, name) {
  const key = keyOf(`${owner}/${name}`);
  const known = lookups.get(key);
  if (known && ago(known.at) < 10 * 60_000) return known.answer;
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "codecity", ...(TOKEN && { authorization: `Bearer ${TOKEN}` }) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { problem: "github" };
  }
  // Out of lookups, or GitHub is down: not remembered, so the next try asks again.
  if (!response.ok && response.status !== 404) return { problem: "github" };
  const repo = response.ok ? await response.json() : null;
  const answer = !repo || repo.private ? { problem: "missing" } : { full: repo.full_name, branch: repo.default_branch, mb: repo.size / 1024 };
  if (lookups.size > 5000) lookups.clear();
  lookups.set(key, { at: Date.now(), answer });
  return answer;
}

// ------------------------------------------------------------------ bandwidth
const month = () => new Date().toISOString().slice(0, 7);
const nextMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
};
let usage = { month: month(), bytes: 0 };
let saving = null;
function spend(bytes) {
  if (usage.month !== month()) usage = { month: month(), bytes: 0 };
  usage.bytes += bytes;
  // Written at most every five seconds: a crash loses that much counting at most.
  saving ??= setTimeout(() => {
    saving = null;
    fs.writeFile(USAGE, JSON.stringify(usage)).catch((error) => console.error(`usage not saved: ${error.message}`));
  }, 5000);
}
const spent = () => usage.month === month() && usage.bytes >= LIMIT.monthGB * 1e9;

// ------------------------------------------------------------------ drawing
/** Repositories waiting, in order, and the one being drawn. */
const waiting = [];
let drawing = null;
/** Recent failures, so a repository that cannot be drawn is not tried again on every refresh. */
const failures = new Map();

const placeInLine = (key) => (drawing?.key === key ? 0 : waiting.findIndex((job) => job.key === key) + 1);
const inLine = (key) => drawing?.key === key || waiting.some((job) => job.key === key);

/** Add a repository to the queue. False when the queue is full. */
function ask(repo) {
  const key = keyOf(repo.full);
  if (inLine(key)) return true;
  if (waiting.length >= LIMIT.queue) return false;
  waiting.push({ key, repo, asked: Date.now() });
  next();
  return true;
}

async function next() {
  if (drawing || !waiting.length) return;
  drawing = waiting.shift();
  const { key, repo } = drawing;
  const started = Date.now();
  try {
    await draw(repo);
    failures.delete(key);
    console.log(`drew ${repo.full} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    failures.set(key, { at: Date.now(), why: error.why ?? "It could not be drawn." });
    console.log(`failed ${repo.full}: ${error.message.split("\n")[0]}`);
  } finally {
    drawing = null;
    next();
  }
}

/** Run a command; kill it and everything it started if it takes longer than `seconds`. */
function run(command, args, seconds, why) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err = (err + chunk).slice(-2000)));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL"); // git starts helpers of its own; they go too
      } catch {}
    }, seconds * 1000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const error = new Error(`${command} ${signal ? `killed (${signal})` : `exited ${code}`}: ${err.trim()}`);
      error.why = signal ? `It took longer than ${seconds} seconds to ${why}, which is the limit here. Big repositories are best drawn on your own machine.` : `It could not be ${why === "clone" ? "cloned" : "drawn"}.`;
      reject(error);
    });
  });
}

async function draw({ full, branch }) {
  const key = keyOf(full);
  const name = full.split("/")[1];
  // The same folder every time: the map remembers your last visit by where the repository was.
  const place = path.join(WORK, key.replace("/", "__"));
  const dir = path.join(place, name);
  await fs.rm(place, { recursive: true, force: true });
  await fs.mkdir(place, { recursive: true });
  try {
    await run(
      "git",
      ["-c", "pack.threads=1", "clone", "--quiet", "--single-branch", "--no-tags", "--branch", branch, "--depth", String(LIMIT.depth), `https://github.com/${full}.git`, dir],
      LIMIT.cloneSeconds,
      "clone",
    );
    const head = (await run("git", ["-C", dir, "rev-parse", "HEAD"], 10, "read")).trim();
    const out = path.join(place, "map.html");
    await run(
      process.execPath,
      [`--max-old-space-size=${LIMIT.drawMB}`, CLI, dir, "-o", out, "--no-browser", "--link", `https://github.com/${full}/blob/${head}`],
      LIMIT.drawSeconds,
      "draw",
    );
    const zipped = zlib.gzipSync(await fs.readFile(out), { level: 9 });
    await fs.mkdir(MAPS, { recursive: true });
    await fs.writeFile(mapFile(key) + ".part", zipped);
    await fs.rename(mapFile(key) + ".part", mapFile(key));
    await trim();
  } finally {
    await fs.rm(place, { recursive: true, force: true });
  }
}

/** Keep the maps on disk under the limit, dropping the oldest first. */
async function trim() {
  const names = (await fs.readdir(MAPS)).filter((name) => name.endsWith(".html.gz"));
  const maps = await Promise.all(names.map(async (name) => ({ name, ...(await fs.stat(path.join(MAPS, name))) })));
  maps.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let total = 0;
  for (const map of maps) if ((total += map.size) > LIMIT.cacheMB * 1024 * 1024) await fs.rm(path.join(MAPS, map.name), { force: true });
}

// ------------------------------------------------------------------ visitors
/** When each visitor asked for new maps, for the hourly limit. */
const asked = new Map();
function allowed(visitor) {
  const times = (asked.get(visitor) ?? []).filter((at) => ago(at) < HOUR);
  if (times.length >= LIMIT.perHour) return false;
  asked.set(visitor, [...times, Date.now()]);
  if (asked.size > 20_000) asked.clear();
  return true;
}
// The address the request came from, as the host's proxy reports it. A visitor can put a false one
// first, so this limit is a courtesy; the fixed queue and the single drawer are what hold the cost.
const visitorOf = (req) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "";

/** "github.com/a/b", "https://github.com/a/b.git", "a/b", "git@github.com:a/b" → { owner, name }. */
function readAddress(text) {
  const m = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com[/:]|git@github\.com:)?([^/\s]+)\/([^/\s#?]+)/i.exec(text.trim());
  if (!m) return null;
  const owner = m[1];
  const name = m[2].replace(/\.git$/, "");
  return NAME.test(owner) && NAME.test(name) ? { owner, name } : null;
}

// ------------------------------------------------------------------ pages
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const EXAMPLES = ["react/react", "sveltejs/svelte", "expressjs/express", "icydotdev/codecity"];

function shell(title, body, { refresh } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${refresh ? `<meta http-equiv="refresh" content="${refresh}" />` : ""}
<title>${esc(title)}</title>
<style>
  :root { --paper: #eef0f3; --card: #fbfbfc; --ink: #12161b; --soft: #5b6672; --line: #c9cfd6; --hot: #ff4f2e; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --paper: #15191e; --card: #1d2228; --ink: #e8ecf1; --soft: #97a2ae; --line: #343c45; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: var(--paper); color: var(--ink); font: 16px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  main { width: min(560px, 100%); }
  h1 { margin: 0 0 6px; font: 700 28px/1.1 system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; }
  h1 a { color: inherit; text-decoration: none; }
  p { margin: 0 0 14px; color: var(--soft); }
  p.lead { color: var(--ink); }
  form { display: flex; gap: 8px; margin: 22px 0 12px; }
  input { flex: 1; min-width: 0; font: inherit; font-size: 16px; color: var(--ink); background: var(--card); border: 1px solid var(--ink); border-radius: 2px; padding: 11px 12px; }
  button { font: 600 13px/1 system-ui, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; color: var(--paper); background: var(--ink); border: 1px solid var(--ink); border-radius: 2px; padding: 0 16px; cursor: pointer; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--hot); outline-offset: 2px; }
  .try { font-size: 14px; }
  .try a { color: var(--ink); margin-right: 12px; white-space: nowrap; }
  .error { color: var(--hot); }
  code { color: var(--ink); }
  .bar { height: 3px; margin: 18px 0; background: var(--line); overflow: hidden; }
  .bar i { display: block; width: 30%; height: 100%; background: var(--hot); animation: go 1.4s ease-in-out infinite; }
  @keyframes go { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  @media (prefers-reduced-motion: reduce) { .bar i { animation: none; width: 100%; opacity: 0.5; } }
  footer { margin-top: 34px; font-size: 13px; }
  footer a { color: var(--soft); }
</style>
</head>
<body><main>${body}
<footer><p>Draws public repositories only. Your own code, private or not, stays on your machine with <code>npx codecity</code>. <a href="https://codecity.icy.dev">About codecity</a></p></footer>
</main></body>
</html>`;
}

const form = (value = "") => `<form action="/" method="get">
  <label for="repo" hidden>GitHub repository</label>
  <input id="repo" name="repo" value="${esc(value)}" placeholder="github.com/owner/repository" autocomplete="off" autocapitalize="off" spellcheck="false" required />
  <button type="submit">Draw it</button>
</form>`;

const home = (problem, value) =>
  shell(
    "codecity · any GitHub repository as a city",
    `<h1><a href="/">codecity</a></h1>
<p class="lead">Any public GitHub repository, drawn as a city. One building per file, coloured by what changed lately, with its whole history to play back.</p>
${form(value)}
${problem ? `<p class="error">${esc(problem)}</p>` : ""}
<p class="try">Try ${EXAMPLES.map((full) => `<a href="/${full}">${full}</a>`).join("")}</p>`,
  );

const notice = (title, text, value) => shell(`${title} · codecity`, `<h1><a href="/">codecity</a></h1><p class="lead">${title}</p><p>${text}</p>${form(value)}`);

function waitingPage(full) {
  const place = placeInLine(keyOf(full));
  const where = place === 0 ? "Cloning it and reading its history now." : `${place === 1 ? "One repository is" : `${place} repositories are`} ahead of it.`;
  return shell(
    `Drawing ${full} · codecity`,
    `<h1><a href="/">codecity</a></h1>
<p class="lead">Drawing ${esc(full)}.</p>
<div class="bar" aria-hidden="true"><i></i></div>
<p>${where} Small repositories take seconds, big ones a few minutes. This page opens the map when it is ready, and the link stays the same: <code>/${esc(full)}</code>.</p>`,
    { refresh: 4 },
  );
}

// ------------------------------------------------------------------ the server
const HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
// Maps are pages made from other people's repositories: they may run their own script and nothing
// else, and fetch nothing.
const MAP_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; font-src data:; base-uri 'none'; form-action 'none'";

function send(req, res, status, body, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(status, { ...HEADERS, "content-type": type, "cache-control": "no-store", ...extra });
  res.end(req.method === "HEAD" ? undefined : body);
}
const go = (res, to) => (res.writeHead(302, { ...HEADERS, location: to }), res.end());

function serveMap(req, res, file, size) {
  const zipped = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  res.writeHead(200, {
    ...HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": MAP_POLICY,
    "cache-control": "public, max-age=600",
    vary: "accept-encoding",
    ...(zipped && { "content-encoding": "gzip", "content-length": size }),
  });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file);
  (zipped ? stream : stream.pipe(zlib.createGunzip())).pipe(res);
}

async function map(req, res, owner, name) {
  if (spent())
    return send(req, res, 503, notice("Resting until next month.", `This free service has used its share of bandwidth for the month, and maps open again on ${nextMonth()}. Meanwhile, clone the repository and run <code>npx codecity</code> in it: same map, on your own machine.`));
  const key = keyOf(`${owner}/${name}`);
  const stat = await fs.stat(mapFile(key)).catch(() => null);
  if (stat) {
    // Old enough to draw again: show this one, and draw the new one in the background if there is room.
    if (ago(stat.mtimeMs) > LIMIT.freshHours * HOUR && !inLine(key)) lookUp(owner, name).then((repo) => repo.full && ask(repo));
    return serveMap(req, res, mapFile(key), stat.size);
  }
  if (inLine(key)) return send(req, res, 202, waitingPage(`${owner}/${name}`));
  const failed = failures.get(key);
  if (failed && ago(failed.at) < 10 * 60_000) return send(req, res, 502, notice(`Could not draw ${esc(owner)}/${esc(name)}.`, esc(failed.why)));

  const repo = await lookUp(owner, name);
  if (repo.problem === "missing") return send(req, res, 404, notice("No public repository there.", `There is no public repository at github.com/${esc(owner)}/${esc(name)}.`, `${owner}/${name}`));
  if (repo.problem === "github") return send(req, res, 503, notice("GitHub is not answering just now.", "Try again in a few minutes."), undefined, { "retry-after": "300" });
  // Its proper name, so that every link to one repository is the same link.
  if (repo.full !== `${owner}/${name}`) return go(res, `/${repo.full}`);
  if (repo.mb > LIMIT.repoMB)
    return send(req, res, 413, notice(`${esc(repo.full)} is too big to draw here.`, `It is ${Math.round(repo.mb).toLocaleString()} MB; the limit here is ${LIMIT.repoMB.toLocaleString()} MB. Clone it and run <code>npx codecity</code> in it instead.`));
  if (waiting.length >= LIMIT.queue) return send(req, res, 503, notice("Busy right now.", "Too many repositories are waiting to be drawn. Try again in a few minutes."), undefined, { "retry-after": "120" });
  if (!allowed(visitorOf(req)))
    return send(req, res, 429, notice("That is a lot of new maps.", `This is a small free service, so each visitor can ask for ${LIMIT.perHour} new maps an hour. Maps already drawn open any time.`), undefined, { "retry-after": "3600" });
  ask(repo);
  return send(req, res, 202, waitingPage(repo.full));
}

const server = http.createServer(async (req, res) => {
  // Everything sent is counted, headers included, by what actually went down the connection.
  const before = req.socket.bytesWritten;
  res.on("close", () => spend(req.socket.bytesWritten - before));
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, "Method not allowed", "text/plain");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return send(req, res, 200, "ok", "text/plain");
    if (url.pathname === "/") {
      const value = url.searchParams.get("repo");
      if (value === null) return send(req, res, 200, home());
      const found = readAddress(value);
      return found ? go(res, `/${found.owner}/${found.name}`) : send(req, res, 400, home("That is not the address of a GitHub repository. It looks like github.com/owner/repository.", value));
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // github.com/a/b/tree/main/src and the like: the repository is what is meant.
    if (parts.length > 2 && NAME.test(parts[0]) && NAME.test(parts[1])) return go(res, `/${parts[0]}/${parts[1]}`);
    if (parts.length !== 2 || !parts.every((part) => NAME.test(part))) return send(req, res, 404, notice("Nothing here.", "Paste the address of a public GitHub repository."));
    const [owner, name] = [parts[0], parts[1].replace(/\.git$/, "")];
    return await map(req, res, owner, name);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(req, res, 500, notice("Something went wrong.", "Try again in a moment."));
    else res.destroy();
  }
});

await fs.rm(WORK, { recursive: true, force: true }); // half-made clones from before a restart
await fs.mkdir(MAPS, { recursive: true });
try {
  const saved = JSON.parse(await fs.readFile(USAGE, "utf8"));
  if (saved.month === month()) usage = saved;
} catch {}
console.log(`bandwidth this month: ${(usage.bytes / 1e9).toFixed(3)} of ${LIMIT.monthGB} GB`);
server.listen(PORT, () => console.log(`codecity service on :${PORT}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
