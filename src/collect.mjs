import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// What the map is made from: every file git knows about (and any new ones not
// yet committed), how long it is, the rough shape of its text, and what git
// remembers of it: when it first appeared, when it last changed, how often,
// and who mostly by.

const git = (cwd, args) => execFileSync("git", ["-C", cwd, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 1 << 30 });

/** Written by a tool, not a person: shown as a low slab so it cannot tower over the town. */
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.snap$|\.map$|\.tsbuildinfo$/;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|mp4|mov|webm|mp3|wav|ogg|flac|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|7z|rar|jar|wasm|bin|exe|dll|so|dylib|vrm|glb|gltf|fbx|psd|sketch|fig|lockb|sqlite|db)$/i;
const MAX_TEXT_BYTES = 2_000_000;
export const MAX_FLOORS = 10;
const LINES_PER_FLOOR = 60;

/**
 * The silhouette of a file: it is cut into floors from the bottom of the file up, and each
 * floor is as wide as its lines are long and as deep as it is dense. Two files written to
 * the same pattern come out as the same building.
 */
export function profile(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const count = lines.length;
  const floors = Math.max(1, Math.min(MAX_FLOORS, Math.ceil(count / LINES_PER_FLOOR)));
  const out = [];
  for (let f = 0; f < floors; f++) {
    // Floor 0 is the ground: the end of the file. The roof is its first lines.
    const from = Math.floor(((floors - 1 - f) * count) / floors);
    const to = Math.floor(((floors - f) * count) / floors);
    let length = 0;
    let filled = 0;
    for (let i = from; i < to; i++) {
      const line = lines[i].replace(/\t/g, "  ").trimEnd();
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

/** Files whose imports we can read. Other languages have none drawn yet. */
const SCRIPT = /\.(m|c)?[jt]sx?$/;
const IMPORT = /(?:^|[^.\w$])(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|(?:^|[^.\w$])(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
const ENDINGS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs", ".json", ".css"];

/** Everything a script says it imports, as written: "./util", "@/lib/x", "react". */
export function findImports(text) {
  const found = new Set();
  for (const match of text.matchAll(IMPORT)) found.add(match[1] ?? match[2]);
  return [...found];
}

/**
 * The file in this repository an import means, or null when it is a package or cannot be found.
 * `aliases` are tsconfig paths: { prefix: "@/", target: "" }.
 */
export function resolveImport(spec, from, has, aliases = []) {
  let base;
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
export function plainJson(text) {
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
function aliasesOf(root) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    let options;
    try {
      options = JSON.parse(plainJson(readFileSync(path.join(root, name), "utf8"))).compilerOptions ?? {};
    } catch {
      continue;
    }
    const base = path.posix.normalize(options.baseUrl ?? ".");
    const at = (target) => path.posix.join(base, target).replace(/^\.\/?/, "");
    const out = [];
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      if (!pattern.endsWith("*") || !targets?.[0]?.endsWith("*")) continue;
      out.push({ prefix: pattern.slice(0, -1), target: at(targets[0].slice(0, -1)) });
    }
    // With a baseUrl, "lib/x" can mean a file under it. Tried last, so real aliases win.
    if (options.baseUrl) out.push({ prefix: "", target: at("") });
    return out.sort((a, b) => b.prefix.length - a.prefix.length);
  }
  return [];
}

function history(root) {
  const seen = new Map();
  let log = "";
  try {
    log = git(root, ["log", "--no-renames", "--name-only", "--format=%x01%at%x02%aN"]);
  } catch {
    return seen; // a repository with no commits yet
  }
  for (const chunk of log.split("\x01")) {
    if (!chunk) continue;
    const [head, ...names] = chunk.split("\n");
    const [at, author] = head.split("\x02");
    const when = Number(at);
    for (const name of names) {
      if (!name) continue;
      let row = seen.get(name);
      if (!row) seen.set(name, (row = { modified: when, birth: when, commits: 0, authors: new Map() }));
      row.birth = when; // the log runs newest first, so the last one we meet is the oldest
      row.commits++;
      row.authors.set(author, (row.authors.get(author) ?? 0) + 1);
    }
  }
  return seen;
}

export function collect(dir) {
  const root = git(dir, ["rev-parse", "--show-toplevel"]).trim();
  const list = (args) => git(root, args).split("\0").filter(Boolean);
  const tracked = list(["ls-files", "-z"]);
  const untracked = new Set(list(["ls-files", "-z", "--others", "--exclude-standard"]));
  const dirty = new Set(untracked);
  for (const args of [["diff", "--name-only", "-z"], ["diff", "--name-only", "-z", "--cached"]]) for (const name of list(args)) dirty.add(name);

  const past = history(root);
  const now = Math.floor(Date.now() / 1000);
  const authors = [];
  const authorIndex = (name) => {
    let i = authors.indexOf(name);
    if (i < 0) i = authors.push(name) - 1;
    return i;
  };

  const files = [];
  const written = new Map(); // what each script says it imports, as written
  for (const name of [...tracked, ...untracked]) {
    const full = path.join(root, name);
    let size;
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue; // a submodule, or a link to a directory
      size = stat.size;
    } catch {
      continue; // deleted but not yet committed
    }
    let kind = BINARY.test(name) || size > MAX_TEXT_BYTES ? "asset" : GENERATED.test(name) ? "generated" : "code";
    let shape = { lines: 0, floors: [[100, 100]] };
    if (kind !== "asset") {
      const buffer = readFileSync(full);
      if (buffer.subarray(0, 8000).includes(0)) kind = "asset";
      else {
        const text = buffer.toString("utf8");
        shape = profile(text);
        if (kind === "generated") shape.floors = [[100, 100]];
        else if (SCRIPT.test(name)) written.set(name, findImports(text));
      }
    }
    const row = past.get(name);
    const top = row ? [...row.authors].sort((a, b) => b[1] - a[1])[0][0] : null;
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
    });
  }

  // Which of those imports are files here: the roads between buildings.
  const known = new Set(files.map((file) => file.path));
  const aliases = aliasesOf(root);
  for (const file of files) {
    const uses = new Set();
    for (const spec of written.get(file.path) ?? []) {
      const found = resolveImport(spec, file.path, (candidate) => known.has(candidate), aliases);
      if (found && found !== file.path) uses.add(found);
    }
    file.uses = [...uses];
  }

  let branch = "";
  let head = "";
  try {
    branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    head = git(root, ["rev-parse", "--short", "HEAD"]).trim();
  } catch {
    /* no commits yet */
  }
  return { name: path.basename(root), root, branch, head, at: now, authors, files };
}
