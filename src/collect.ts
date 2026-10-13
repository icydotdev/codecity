import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { readImports, resolveImports, type Spec } from "./imports.js";

// What the map is made from: every file git knows about (and any new ones not
// yet committed), how long it is, the rough shape of its text, what it imports,
// and what git remembers of it: when it first appeared, when it last changed,
// how often, who mostly by, and how long it was at each point along the way.

export type Kind = "code" | "generated" | "asset";

export interface CityFile {
  path: string;
  kind: Kind;
  lines: number;
  /** One [width, depth] pair per floor, each 0 to 100, ground floor first. */
  floors: [number, number][];
  /** Seconds since 1970, as git has them. */
  birth: number;
  modified: number;
  commits: number;
  /** A place in `Repo.authors`, or -1 for a file nobody has committed. */
  author: number;
  dirty: boolean;
  fresh: boolean;
  /** When the file on disk was last written, in milliseconds. Changes on every save. */
  stamp: number;
  /** The files here that this one imports, as paths. */
  uses: string[];
  /** Its length through time, oldest first, flattened: time, lines, time, lines. */
  log: number[];
}

export interface Repo {
  name: string;
  root: string;
  branch: string;
  head: string;
  at: number;
  authors: string[];
  files: CityFile[];
  /** True when the history was too long to measure every commit, so lengths through time are not known. */
  quick: boolean;
  /** The last `git pull` that brought anything in: when, and which files here it changed. */
  pull: { at: number; files: string[] } | null;
}

/** What git remembers of one file. `changes` is time, lines added less lines removed, newest first. */
export interface Past {
  modified: number;
  birth: number;
  commits: number;
  authors: Map<string, number>;
  changes: number[];
}

/** The history is the slow part and only changes when a commit is made, so a watcher keeps it. */
export interface Memory {
  head: string;
  past: Map<string, Past>;
  quick: boolean;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-C", cwd, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });

/** Written by a tool, not a person: shown as a low slab so it cannot tower over the town. */
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.snap$|\.map$|\.tsbuildinfo$/;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|mp4|mov|webm|mp3|wav|ogg|flac|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|7z|rar|jar|wasm|bin|exe|dll|so|dylib|vrm|glb|gltf|fbx|psd|sketch|fig|lockb|sqlite|db)$/i;
const MAX_TEXT_BYTES = 2_000_000;
export const MAX_FLOORS = 10;
const LINES_PER_FLOOR = 60;
/** Past this many commits, measuring every one takes minutes. Then only names are read. */
const MEASURE_UP_TO = 20_000;
/** How many points of a file's length through time are kept. */
const LOG_POINTS = 24;

/**
 * The silhouette of a file: it is cut into floors from the bottom of the file up, and each
 * floor is as wide as its lines are long and as deep as it is dense. Two files written to
 * the same pattern come out as the same building.
 */
export function profile(text: string): { lines: number; floors: [number, number][] } {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const count = lines.length;
  const floors = Math.max(1, Math.min(MAX_FLOORS, Math.ceil(count / LINES_PER_FLOOR)));
  const out: [number, number][] = [];
  for (let f = 0; f < floors; f++) {
    // Floor 0 is the ground: the end of the file. The roof is its first lines.
    const from = Math.floor(((floors - 1 - f) * count) / floors);
    const to = Math.floor(((floors - f) * count) / floors);
    let length = 0;
    let filled = 0;
    for (let i = from; i < to; i++) {
      const line = lines[i]!.replace(/\t/g, "  ").trimEnd();
      if (line.length) filled++;
      length += Math.min(line.length, 120);
    }
    const n = Math.max(1, to - from);
    const wide = Math.max(0.38, Math.min(1, length / n / 62));
    const deep = Math.max(0.55, Math.min(1, 0.35 + (filled / n) * 0.7));
    out.push([Math.round(wide * 100), Math.round(deep * 100)]);
  }
  return { lines: count, floors: out };
}

/** JavaScript and TypeScript, whose imports are read here. Other languages are in imports.ts. */
const SCRIPT = /\.(m|c)?[jt]sx?$/;
const IMPORT = /(?:^|[^.\w$])(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|(?:^|[^.\w$])(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
const ENDINGS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs", ".json", ".css"];

/** Everything a script says it imports, as written: "./util", "@/lib/x", "react". */
export function findImports(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(IMPORT)) found.add((match[1] ?? match[2])!);
  return [...found];
}

export interface Alias {
  prefix: string;
  target: string;
}

/**
 * The file in this repository an import means, or null when it is a package or cannot be found.
 * `aliases` are tsconfig paths: { prefix: "@/", target: "" }.
 */
export function resolveImport(spec: string, from: string, has: (candidate: string) => boolean, aliases: Alias[] = []): string | null {
  let base: string;
  if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(from), spec);
  else {
    const alias = aliases.find((a) => spec.startsWith(a.prefix));
    if (!alias) return null;
    base = path.posix.join(alias.target, spec.slice(alias.prefix.length));
  }
  if (base.startsWith("..")) return null; // outside the repository
  const tries = [base, ...ENDINGS.map((end) => base + end), ...ENDINGS.map((end) => `${base}/index${end}`)];
  // "./x.js" is how a TypeScript file is told to import ./x.ts.
  const bare = base.replace(/\.(m|c)?js$/, "");
  if (bare !== base) tries.push(...ENDINGS.map((end) => bare + end));
  return tries.find((candidate) => has(candidate)) ?? null;
}

/**
 * A tsconfig is JSON that allows comments and trailing commas. This takes both out, and leaves
 * alone anything inside a string: "@/*" and "**\/*.ts" look like comments and are not.
 */
export function plainJson(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (text[i] === '"') {
      const from = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(from, i + 1);
    } else if (two === "//") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (two === "/*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += text[i];
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The `paths` of the tsconfig (or jsconfig) at the top of the repository. Only that one is read. */
function aliasesOf(root: string): Alias[] {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    let options: { baseUrl?: string; paths?: Record<string, string[]> };
    try {
      options = JSON.parse(plainJson(readFileSync(path.join(root, name), "utf8"))).compilerOptions ?? {};
    } catch {
      continue;
    }
    const base = path.posix.normalize(options.baseUrl ?? ".");
    const at = (target: string) => path.posix.join(base, target).replace(/^\.\/?/, "");
    const out: Alias[] = [];
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      const first = targets?.[0];
      if (!pattern.endsWith("*") || !first?.endsWith("*")) continue;
      out.push({ prefix: pattern.slice(0, -1), target: at(first.slice(0, -1)) });
    }
    // With a baseUrl, "lib/x" can mean a file under it. Tried last, so real aliases win.
    if (options.baseUrl) out.push({ prefix: "", target: at("") });
    return out.sort((a, b) => b.prefix.length - a.prefix.length);
  }
  return [];
}

/**
 * Read `git log --format=%x01%at%x02%aN` with either --numstat ("12\t3\tpath") or --name-only
 * ("path") into what is remembered of each file. Only the files in `wanted` are kept, when given:
 * a long history is mostly files that no longer exist.
 */
export function readLog(log: string, wanted?: Set<string>): Map<string, Past> {
  const seen = new Map<string, Past>();
  for (const chunk of log.split("\x01")) {
    if (!chunk) continue;
    const lines = chunk.split("\n");
    const [at, author = ""] = lines[0]!.split("\x02");
    const when = Number(at);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line) continue;
      let name = line;
      let delta = 0;
      const tab = line.indexOf("\t");
      const second = tab > 0 ? line.indexOf("\t", tab + 1) : -1;
      if (second > 0) {
        name = line.slice(second + 1);
        // A file that is not text is listed as "-\t-\tpath".
        const added = Number(line.slice(0, tab));
        const removed = Number(line.slice(tab + 1, second));
        if (Number.isFinite(added) && Number.isFinite(removed)) delta = added - removed;
      }
      if (wanted && !wanted.has(name)) continue;
      let row = seen.get(name);
      if (!row) seen.set(name, (row = { modified: when, birth: when, commits: 0, authors: new Map(), changes: [] }));
      row.birth = when; // the log runs newest first, so the last one we meet is the oldest
      row.commits++;
      row.authors.set(author, (row.authors.get(author) ?? 0) + 1);
      row.changes.push(when, delta);
    }
  }
  return seen;
}

/**
 * A file's length through time, oldest first, flattened: time, lines, time, lines. Added up from
 * each commit's lines added and removed, then stretched so it ends at the length the file has
 * now (the sums drift when a file was ever renamed or was not text). Thinned to `keep` points.
 */
export function sizeLog(changes: number[], linesNow: number, keep = LOG_POINTS): number[] {
  const points: [number, number][] = [];
  let total = 0;
  for (let i = changes.length - 2; i >= 0; i -= 2) {
    total = Math.max(0, total + changes[i + 1]!);
    points.push([changes[i]!, total]);
  }
  if (!points.length) return [];
  const last = points.at(-1)![1];
  let sized = points.map(([time, lines]): [number, number] => [time, last > 0 ? Math.max(1, Math.round((lines * linesNow) / last)) : linesNow]);
  if (sized.length > keep) sized = Array.from({ length: keep }, (_, k) => sized[Math.round((k * (sized.length - 1)) / (keep - 1))]!);
  return sized.flat();
}

function remember(root: string, wanted: Set<string>, before?: Memory): Memory {
  let head = "";
  try {
    head = git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    return { head: "", past: new Map(), quick: false }; // a repository with no commits yet
  }
  if (before && before.head === head) return before;
  const quick = Number(git(root, ["rev-list", "--count", "HEAD"])) > MEASURE_UP_TO;
  const log = git(root, ["log", "--no-renames", quick ? "--name-only" : "--numstat", "--format=%x01%at%x02%aN"]);
  return { head, past: readLog(log, wanted), quick };
}

/** One line of git's own record of where HEAD has been, newest first. */
export interface Move {
  hash: string;
  /** What moved it, in git's words: "pull: Fast-forward", "commit: fix typo", "checkout: moving from a to b". */
  what: string;
  /** Seconds since 1970. */
  at: number;
}

/**
 * The most recent pull among HEAD's moves: where HEAD was before it and after it.
 *
 * A commit's date says when it was written, not when it arrived here, so "changed lately" cannot
 * answer "what did my last pull bring in". Git's record of HEAD's moves can. A plain pull is one
 * move. A pull that rebases is several in a row (start, a pick for each commit of yours, finish),
 * and the state before it is the one before the oldest of them.
 */
export function lastPull(moves: Move[]): { from: string; to: string; at: number } | null {
  const isPull = (move: Move | undefined) => move !== undefined && /^pull\b/.test(move.what);
  const newest = moves.findIndex(isPull);
  if (newest < 0) return null;
  let oldest = newest;
  while (isPull(moves[oldest + 1])) oldest++;
  const before = moves[oldest + 1];
  if (!before) return null; // the pull is the first thing on record: a clone, with nothing before it
  return { from: before.hash, to: moves[newest]!.hash, at: moves[newest]!.at };
}

function pulled(root: string): Repo["pull"] {
  try {
    const moves = git(root, ["log", "-g", "-n", "500", "--date=unix", "--format=%H%x01%gs%x01%gd", "HEAD"])
      .split("\n")
      .filter(Boolean)
      .map((line): Move => {
        const [hash = "", what = "", selector = ""] = line.split("\x01");
        return { hash, what, at: Number(/\{(\d+)\}/.exec(selector)?.[1] ?? 0) };
      });
    const pull = lastPull(moves);
    if (!pull || pull.from === pull.to) return null;
    const files = git(root, ["diff", "--name-only", "--no-renames", "-z", pull.from, pull.to]).split("\0").filter(Boolean);
    return files.length ? { at: pull.at, files } : null;
  } catch {
    return null; // no commits yet, or the record has been cleared
  }
}

export function collect(dir: string, before?: Memory): { repo: Repo; memory: Memory } {
  const root = git(dir, ["rev-parse", "--show-toplevel"]).trim();
  const list = (args: string[]) => git(root, args).split("\0").filter(Boolean);
  const tracked = list(["ls-files", "-z"]);
  const untracked = new Set(list(["ls-files", "-z", "--others", "--exclude-standard"]));
  const dirty = new Set(untracked);
  for (const args of [["diff", "--name-only", "-z"], ["diff", "--name-only", "-z", "--cached"]]) for (const name of list(args)) dirty.add(name);

  const memory = remember(root, new Set(tracked), before);
  const now = Math.floor(Date.now() / 1000);
  const authors: string[] = [];
  const authorIndex = (name: string) => {
    let i = authors.indexOf(name);
    if (i < 0) i = authors.push(name) - 1;
    return i;
  };

  const files: CityFile[] = [];
  const written = new Map<string, string[]>(); // what each script says it imports, as written
  const foreign = new Map<string, Spec[]>(); // the same for Python, Go, Rust, the JVM languages and C
  for (const name of [...tracked, ...untracked]) {
    const full = path.join(root, name);
    let size: number;
    let stamp: number;
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue; // a submodule, or a link to a directory
      size = stat.size;
      stamp = Math.round(stat.mtimeMs);
    } catch {
      continue; // deleted but not yet committed
    }
    let kind: Kind = BINARY.test(name) || size > MAX_TEXT_BYTES ? "asset" : GENERATED.test(name) ? "generated" : "code";
    let shape: { lines: number; floors: [number, number][] } = { lines: 0, floors: [[100, 100]] };
    if (kind !== "asset") {
      const buffer = readFileSync(full);
      if (buffer.subarray(0, 8000).includes(0)) kind = "asset";
      else {
        const text = buffer.toString("utf8");
        shape = profile(text);
        if (kind === "generated") shape.floors = [[100, 100]];
        else if (SCRIPT.test(name)) written.set(name, findImports(text));
        else {
          const specs = readImports(name, text);
          if (specs?.length) foreign.set(name, specs);
        }
      }
    }
    const row = memory.past.get(name);
    const top = row ? [...row.authors].sort((a, b) => b[1] - a[1])[0]![0] : null;
    files.push({
      path: name,
      kind,
      lines: shape.lines,
      floors: shape.floors,
      birth: row?.birth ?? now,
      modified: dirty.has(name) ? now : (row?.modified ?? now),
      commits: row?.commits ?? 0,
      author: top === null ? -1 : authorIndex(top),
      dirty: dirty.has(name),
      fresh: untracked.has(name),
      stamp,
      uses: [],
      log: row ? sizeLog(row.changes, shape.lines) : [],
    });
  }

  // Which of those imports are files here: the links between buildings.
  const known = new Set(files.map((file) => file.path));
  const aliases = aliasesOf(root);
  for (const file of files) {
    const uses = new Set<string>();
    for (const spec of written.get(file.path) ?? []) {
      const found = resolveImport(spec, file.path, (candidate) => known.has(candidate), aliases);
      if (found && found !== file.path) uses.add(found);
    }
    file.uses = [...uses];
  }
  const read = (name: string) => {
    try {
      return readFileSync(path.join(root, name), "utf8");
    } catch {
      return null;
    }
  };
  const elsewhere = resolveImports(foreign, { files, read });
  for (const file of files) if (elsewhere.has(file.path)) file.uses = elsewhere.get(file.path)!;

  let branch = "";
  try {
    branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    /* no commits yet */
  }
  return { repo: { name: path.basename(root), root, branch, head: memory.head.slice(0, 7), at: now, authors, files, quick: memory.quick, pull: pulled(root) }, memory };
}
