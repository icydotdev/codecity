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
import { writeFile } from "node:fs/promises";
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
  /** Memory for drawing a big repository, and for a small one beside it: together, with git, under 512 MB. */
  drawMB: number("DRAW_MB", 300),
  smallDrawMB: number("SMALL_DRAW_MB", 128),
  /** A repository this size or under (GitHub's figure) is small: it need not wait behind a big one. */
  smallMB: number("SMALL_REPO_MB", 60),
  /** Repositories waiting to be drawn. More than this and people are asked to come back later. */
  queue: number("MAX_QUEUE", 50),
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

// ------------------------------------------------------------------ progress
// The steps of drawing a repository, with the share of the time each takes on the free instance.
// Measured on angular/angular (11,667 files, 140 s): the shares only decide how far the bar moves
// in each step, so that it moves at about the same speed throughout.
const STEPS = [
  { id: "packing", share: 5 }, // GitHub counting and compressing what to send
  { id: "downloading", share: 12 },
  { id: "unpacking", share: 22 }, // git resolving the deltas it was sent
  { id: "checkout", share: 5 }, // writing the files out
  { id: "history", share: 43 }, // one `git log` over the whole history: no progress of its own
  { id: "files", share: 8 }, // reading and measuring every file
  { id: "layout", share: 5 },
];
const SHARES = STEPS.reduce((sum, step) => sum + step.share, 0);
/** What git and the drawing command say, turned into a step and how far through it. */
const GIT_STEPS = [
  [/^remote: (?:Enumerating|Counting|Compressing) objects:\s+(\d+)%/, "packing"],
  [/^Receiving objects:\s+(\d+)%/, "downloading"],
  [/^Resolving deltas:\s+(\d+)%/, "unpacking"],
  [/^Updating files:\s+(\d+)%/, "checkout"],
];
function hear(job, line) {
  for (const [pattern, step] of GIT_STEPS) {
    const m = pattern.exec(line);
    if (m) return move(job, step, Number(m[1]));
  }
  const m = /^progress (\w+) (\d+) (\d+)$/.exec(line);
  if (m) move(job, m[1] === "imports" ? "layout" : m[1], Number(m[3]) ? (100 * Number(m[2])) / Number(m[3]) : 0, m[1] === "files" ? `${Number(m[2]).toLocaleString("en")} of ${Number(m[3]).toLocaleString("en")}` : undefined);
}
function move(job, step, percent, detail) {
  const at = STEPS.findIndex((s) => s.id === step);
  if (at < 0 || at < job.at) return; // never backwards
  if (at > job.at) (job.entered = Date.now()), console.log(`${job.repo.full}: ${step} after ${((Date.now() - job.started) / 1000).toFixed(1)}s`);
  Object.assign(job, { at, step, percent, detail });
}
/** How far along the drawing is, 0 to 100, and the step it is on. */
function along(job) {
  const before = STEPS.slice(0, job.at).reduce((sum, step) => sum + step.share, 0);
  // Reading the history says nothing until it is done, so its share fills on time, ever more slowly.
  const percent = job.step === "history" ? 100 * (1 - Math.exp(-(Date.now() - job.entered) / 30_000)) : job.percent;
  return { step: job.step, stepPercent: Math.round(percent), detail: job.detail, percent: Math.min(99, Math.round(((before + (STEPS[job.at].share * percent) / 100) / SHARES) * 100)) };
}

// ------------------------------------------------------------------ drawing
// Two lanes. The first draws any repository, one at a time. The second draws only small ones, so a
// small repository never waits behind a big one; a big one takes minutes, a small one seconds.
// No more than that at once: on a fraction of a CPU, two big drawings would each take twice as
// long, and together they would not fit in the memory.
const LANES = [
  { fits: () => true, heapMB: LIMIT.drawMB },
  { fits: (repo) => repo.mb <= LIMIT.smallMB, heapMB: LIMIT.smallDrawMB },
];
/** Repositories waiting, in order, and the one each lane is drawing. */
const waiting = [];
const lanes = LANES.map(() => null);
/** Recent failures, so a repository that cannot be drawn is not tried again on every refresh. */
const failures = new Map();

const drawingOf = (key) => lanes.find((job) => job?.key === key);
const inLine = (key) => Boolean(drawingOf(key)) || waiting.some((job) => job.key === key);
/** Roughly how long a repository takes to draw on the free instance, in seconds. */
const guess = (repo) => 20 + 0.12 * Math.min(repo.mb, 1200);
/** Where a waiting repository stands: how many are ahead of it, and about how long until it is drawn. */
function standing(key) {
  const i = waiting.findIndex((job) => job.key === key);
  const job = waiting[i];
  const small = LANES[1].fits(job.repo);
  // A small one waits only for the small ones ahead of it, behind whichever lane frees first.
  const ahead = waiting.slice(0, i).filter((other) => !small || LANES[1].fits(other.repo));
  const left = (j) => (j ? guess(j.repo) * (1 - along(j).percent / 100) : 0);
  const free = small ? Math.min(left(lanes[0]), left(lanes[1])) : left(lanes[0]);
  const seconds = free + ahead.reduce((sum, other) => sum + guess(other.repo), 0) / (small ? 2 : 1) + guess(job.repo);
  return { state: "waiting", ahead: ahead.length + lanes.filter(Boolean).length, minutes: Math.max(1, Math.round(seconds / 60)) };
}
const where = (key) => {
  const job = drawingOf(key);
  return job ? { state: "drawing", stage: job.stage, since: job.started, ...along(job) } : standing(key);
};

/** Add a repository to the queue. False when the queue is full. */
function ask(repo) {
  const key = keyOf(repo.full);
  if (inLine(key)) return true;
  if (waiting.length >= LIMIT.queue) return false;
  waiting.push({ key, repo, asked: Date.now() });
  next();
  return true;
}

/** Start whatever can start: each free lane takes the first waiting repository it fits. */
function next() {
  lanes.forEach((busy, lane) => {
    if (busy) return;
    const i = waiting.findIndex((job) => LANES[lane].fits(job.repo));
    if (i < 0) return;
    const job = Object.assign(waiting.splice(i, 1)[0], { stage: "cloning", started: Date.now(), entered: Date.now(), at: 0, step: "packing", percent: 0 });
    lanes[lane] = job;
    draw(job, LANES[lane].heapMB)
      .then(() => {
        failures.delete(job.key);
        console.log(`drew ${job.repo.full} in ${((Date.now() - job.started) / 1000).toFixed(1)}s (lane ${lane})`);
      })
      .catch((error) => {
        failures.set(job.key, { at: Date.now(), why: error.why ?? "It could not be drawn." });
        console.log(`failed ${job.repo.full}: ${error.message.split("\n")[0].slice(0, 300)}`);
      })
      .finally(() => {
        lanes[lane] = null;
        next();
      });
  });
}

/**
 * Run a command; kill it and everything it started if it takes longer than `seconds`. Each line it
 * writes to stderr goes to `heard` as it comes (git's progress ends its lines with \r, not \n).
 */
function run(command, args, seconds, why, heard = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CODECITY_PROGRESS: "1" } });
    // If memory runs out, Linux is to stop this and not the server (and so everyone's queue).
    writeFile(`/proc/${child.pid}/oom_score_adj`, "1000").catch(() => {});
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => {
      err = (err + chunk).slice(-2000);
      for (const line of String(chunk).split(/[\r\n]+/)) if (line.trim()) heard(line.trim());
    });
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

async function draw(job, heapMB) {
  const { full, branch } = job.repo;
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
      ["-c", "pack.threads=1", "clone", "--progress", "--single-branch", "--no-tags", "--branch", branch, "--depth", String(LIMIT.depth), `https://github.com/${full}.git`, dir],
      LIMIT.cloneSeconds,
      "clone",
      (line) => hear(job, line),
    );
    const head = (await run("git", ["-C", dir, "rev-parse", "HEAD"], 10, "read")).trim();
    job.stage = "drawing";
    move(job, "history", 0);
    const out = path.join(place, "map.html");
    await run(
      process.execPath,
      [`--max-old-space-size=${heapMB}`, CLI, dir, "-o", out, "--no-browser", "--link", `https://github.com/${full}/blob/${head}`],
      LIMIT.drawSeconds,
      "draw",
      (line) => hear(job, line),
    );
    const html = (await fs.readFile(out, "utf8")).replace("</header>", () => BACK + "</header>");
    const zipped = zlib.gzipSync(html, { level: 9 });
    await fs.mkdir(MAPS, { recursive: true });
    await fs.writeFile(mapFile(key) + ".part", zipped);
    await fs.rename(mapFile(key) + ".part", mapFile(key));
    await trim();
  } finally {
    await fs.rm(place, { recursive: true, force: true });
  }
}

/** A way back to the site from a map, under the repository's name. */
const BACK = `<a href="/" style="pointer-events:auto;display:inline-block;margin-top:9px;font:600 11px/1 var(--label);letter-spacing:0.14em;text-transform:uppercase;color:var(--soft);text-decoration:none">&larr; codecity &middot; draw another repository</a>`;

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

// ------------------------------------------------------------------ the server
// Nothing here is a page for people. The site (codecity.icy.dev) is the front door: it forwards
// /<owner>/<repo> and /api/ here, shows the progress, and opens the map when it is ready.
const SITE = process.env.SITE_URL ?? "https://codecity.icy.dev";
const HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
// Maps are pages made from other people's repositories: they may run their own script and nothing
// else, and fetch nothing.
const MAP_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; font-src data:; base-uri 'none'; form-action 'none'";

const go = (res, to) => (res.writeHead(302, { ...HEADERS, location: to, "cache-control": "no-store" }), res.end());
function json(req, res, status, body, extra = {}) {
  res.writeHead(status, { ...HEADERS, "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
}

function serveMap(req, res, file, size) {
  const zipped = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  res.writeHead(200, {
    ...HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": MAP_POLICY,
    // A day at the site's edge (maps are redrawn daily anyway), so a link that is going round is
    // served by the site, not from here: this box's bandwidth has a monthly budget.
    "cache-control": "public, max-age=600, s-maxage=86400, stale-while-revalidate=3600",
    vary: "accept-encoding",
    ...(zipped && { "content-encoding": "gzip", "content-length": size }),
  });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file);
  (zipped ? stream : stream.pipe(zlib.createGunzip())).pipe(res);
}

/**
 * Where a repository's map stands, and the work to draw it asked for if it is not drawn yet.
 * `{ state: "ready" | "waiting" | "drawing" | "moved" | "error", ... }`.
 */
async function status(req, owner, name) {
  if (spent()) return { state: "error", reason: "resting", message: `This free service has used its share of bandwidth for the month. Maps open again on ${nextMonth()}.` };
  const key = keyOf(`${owner}/${name}`);
  const stat = await fs.stat(mapFile(key)).catch(() => null);
  if (stat) {
    // Old enough to draw again: the old one is shown, and the new one drawn if there is room.
    if (ago(stat.mtimeMs) > LIMIT.freshHours * HOUR && !inLine(key)) lookUp(owner, name).then((repo) => repo.full && ask(repo));
    return { state: "ready" };
  }
  if (inLine(key)) return where(key);
  const failed = failures.get(key);
  if (failed && ago(failed.at) < 10 * 60_000) return { state: "error", reason: "failed", message: failed.why };

  const repo = await lookUp(owner, name);
  if (repo.problem === "missing") return { state: "error", reason: "missing", message: `There is no public repository at github.com/${owner}/${name}.` };
  if (repo.problem === "github") return { state: "error", reason: "github", message: "GitHub is not answering just now. Try again in a few minutes." };
  // Its proper name, so that every link to one repository is the same link.
  if (repo.full !== `${owner}/${name}`) return { state: "moved", full: repo.full };
  if (repo.mb > LIMIT.repoMB)
    return { state: "error", reason: "big", message: `${repo.full} is ${Math.round(repo.mb).toLocaleString("en")} MB, and the limit here is ${LIMIT.repoMB.toLocaleString("en")} MB. Clone it and run npx codecity in it instead.` };
  if (waiting.length >= LIMIT.queue) return { state: "error", reason: "busy", message: "Too many repositories are waiting to be drawn. Try again in a few minutes." };
  if (!allowed(visitorOf(req))) return { state: "error", reason: "limit", message: `Each visitor can ask for ${LIMIT.perHour} new maps an hour. Maps already drawn open any time.` };
  ask(repo);
  return where(key);
}

const server = http.createServer(async (req, res) => {
  // Everything sent is counted, headers included, by what actually went down the connection.
  const before = req.socket.bytesWritten;
  res.on("close", () => spend(req.socket.bytesWritten - before));
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return json(req, res, 405, { error: "GET only" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return json(req, res, 200, { ok: true, drawing: lanes.map((job) => job?.repo.full ?? null), waiting: waiting.length, bandwidthGB: +(usage.bytes / 1e9).toFixed(3) });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const api = parts[0] === "api" && parts[1] === "maps";
    const [owner, rawName, ...rest] = api ? parts.slice(2) : parts;
    const name = rawName?.replace(/\.git$/, "");
    if (!owner || !name || !NAME.test(owner) || !NAME.test(name)) return api ? json(req, res, 404, { state: "error", reason: "address", message: "That is not a GitHub repository." }) : go(res, SITE);
    if (api) return json(req, res, 200, await status(req, owner, name));
    // github.com/a/b/tree/main/src and the like: the repository is what is meant.
    if (rest.length) return go(res, `/${owner}/${name}`);
    const file = mapFile(keyOf(`${owner}/${name}`));
    const stat = await fs.stat(file).catch(() => null);
    if (stat && !spent()) return serveMap(req, res, file, stat.size);
    // Not drawn yet: the site's page draws it, and comes back here when it is ready.
    return go(res, `/?repo=${encodeURIComponent(`${owner}/${name}`)}`);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(req, res, 500, { state: "error", reason: "server", message: "Something went wrong. Try again in a moment." });
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
