import path from "node:path";

// Imports in languages other than JavaScript and TypeScript (those are in collect.ts, with the
// tsconfig aliases they need). Each language is read with a few patterns, not a parser: the aim is
// the links between files in this repository, and a pattern finds nearly all of them for a
// thousandth of the code. What a pattern cannot place is left out; nothing is guessed.
//
// Reading and resolving are separate because resolving needs to know every file there is.

/** What one file says it imports, before it is known which file that means. */
export type Spec =
  | { lang: "py"; level: number; module: string; names: string[] }
  | { lang: "go"; path: string }
  | { lang: "rs"; from: "crate" | "super" | "self" | "mod"; path: string[] }
  | { lang: "jvm"; name: string }
  | { lang: "c"; path: string };

const LANGUAGE: [RegExp, (text: string) => Spec[]][] = [
  [/\.pyi?$/, python],
  [/\.go$/, go],
  [/\.rs$/, rust],
  [/\.(java|kt|kts|scala)$/, jvm],
  [/\.(c|h|cc|hh|cpp|hpp|cxx|hxx|m|mm)$/, c],
];

/** The imports written in a file, or null when it is in a language not read here. */
export function readImports(file: string, text: string): Spec[] | null {
  const reader = LANGUAGE.find(([ext]) => ext.test(file));
  return reader ? reader[1](text) : null;
}

/** `import a.b, c as d` and `from ..a import b, c` (which may run over several lines in brackets). */
function python(text: string): Spec[] {
  const out: Spec[] = [];
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n#;]+)/gm))
    for (const part of m[1]!.split(",")) {
      const module = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (/^[\w.]+$/.test(module)) out.push({ lang: "py", level: 0, module, names: [] });
    }
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]+)/gm)) {
    const names = m[3]!
      .replace(/[()\\]/g, " ")
      .split(",")
      .map((name) => name.replace(/#.*/, "").trim().split(/\s+as\s+/)[0]!.trim())
      .filter((name) => /^\w+$/.test(name));
    out.push({ lang: "py", level: m[1]!.length, module: m[2]!, names });
  }
  return out;
}

/** `import "a/b"`, `import x "a/b"`, and the bracketed list of them. */
function go(text: string): Spec[] {
  const out: Spec[] = [];
  const add = (line: string) => {
    const m = /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(line);
    if (m) out.push({ lang: "go", path: m[1]! });
  };
  for (const m of text.matchAll(/^import\s*\(([^)]*)\)/gm)) m[1]!.split("\n").forEach(add);
  for (const m of text.matchAll(/^import\s+([^(\n]+)$/gm)) add(m[1]!);
  return out;
}

/** `mod a;` (a file of its own, unlike `mod a { }`), and `use crate::a::b`, `use super::a`, `use self::a`. */
function rust(text: string): Spec[] {
  const out: Spec[] = [];
  for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) out.push({ lang: "rs", from: "mod", path: [m[1]!] });
  for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(crate|super|self)::([\w:]+)/gm))
    out.push({ lang: "rs", from: m[1] as "crate" | "super" | "self", path: m[2]!.split("::").filter(Boolean) });
  return out;
}

/** `import a.b.C;`, `import static a.b.C.member;`. A whole package (`a.b.*`) names no file. */
function jvm(text: string): Spec[] {
  const out: Spec[] = [];
  for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*|\._)?\s*;?\s*$/gm)) if (!m[2]) out.push({ lang: "jvm", name: m[1]! });
  return out;
}

/** `#include "a/b.h"`. Angle brackets are the system's headers, not this repository's. */
function c(text: string): Spec[] {
  return [...text.matchAll(/^\s*#\s*(?:include|import)\s+"([^"]+)"/gm)].map((m) => ({ lang: "c", path: m[1]! }));
}

/** What resolving needs to know about the repository. */
export interface Known {
  /** Every file, with its length: where a package is many files, the longest stands for it. */
  files: { path: string; lines: number }[];
  /** The text of a file here, for the few that say where things are (go.mod). */
  read: (file: string) => string | null;
}

const dirOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
const join = (...parts: string[]) => path.posix.join(...parts.filter(Boolean)).replace(/^\.$/, "");

/**
 * Turn what every file says it imports into the files meant. Returns, for each importing file,
 * the files here that it uses.
 */
export function resolveImports(written: Map<string, Spec[]>, known: Known): Map<string, string[]> {
  const has = new Set(known.files.map((file) => file.path));
  const pick = (...tries: string[]) => tries.find((candidate) => has.has(candidate)) ?? null;

  // Go: a module's name is in its go.mod, and an import names a directory, not a file.
  const modules = known.files
    .filter((file) => /(^|\/)go\.mod$/.test(file.path))
    .map((file) => ({ dir: dirOf(file.path), name: /^module\s+(\S+)/m.exec(known.read(file.path) ?? "")?.[1] ?? "" }))
    .filter((module) => module.name)
    .sort((a, b) => b.name.length - a.name.length);
  const goPackages = new Map<string, { path: string; lines: number }[]>();
  for (const file of known.files)
    if (file.path.endsWith(".go") && !file.path.endsWith("_test.go")) {
      const dir = dirOf(file.path);
      goPackages.set(dir, [...(goPackages.get(dir) ?? []), file]);
    }
  // A package is drawn as one link, to the file named after it or else its longest: a line to
  // every file of every package imported would bury the map.
  const goPackage = (dir: string): string | null => {
    const files = goPackages.get(dir);
    if (!files) return null;
    const named = files.find((file) => file.path === join(dir, `${path.posix.basename(dir)}.go`));
    return (named ?? [...files].sort((a, b) => b.lines - a.lines)[0]!).path;
  };

  // Java and friends name a class by its package, and C includes are often written from an include
  // root the repository does not declare. Both are found by the end of the path.
  const byEnding = new Map<string, string>();
  for (const file of known.files) {
    const jvmFile = /\.(java|kt|kts|scala)$/.test(file.path);
    if (!jvmFile && !/\.(h|hh|hpp|hxx)$/.test(file.path)) continue;
    const parts = (jvmFile ? file.path.replace(/\.\w+$/, "") : file.path).split("/");
    for (let i = 0; i < parts.length; i++) {
      const ending = parts.slice(i).join("/");
      if (!byEnding.has(ending)) byEnding.set(ending, file.path);
    }
  }

  const rustCrates = known.files.filter((file) => /(^|\/)Cargo\.toml$/.test(file.path)).map((file) => dirOf(file.path)).sort((a, b) => b.length - a.length);

  const resolve = (from: string, spec: Spec): string[] => {
    const here = dirOf(from);
    if (spec.lang === "py") {
      const asPath = spec.module.split(".").filter(Boolean).join("/");
      const moduleAt = (base: string, mod: string) => pick(join(base, `${mod}.py`), join(base, mod, "__init__.py"), join(base, `${mod}.pyi`));
      // Where to look. A relative import says exactly. An absolute one starts from a root nobody
      // wrote down, so try the folders above the file, nearest first, then the usual src/.
      const bases: string[] = [];
      if (spec.level > 0) {
        let base = here;
        for (let up = 1; up < spec.level; up++) base = dirOf(base);
        bases.push(base);
      } else {
        for (let base = here; ; base = dirOf(base)) {
          bases.push(base);
          if (!base) break;
        }
        bases.push("src");
      }
      for (const base of bases) {
        const found = new Set<string>();
        // `from pkg import a, b`: a and b may be modules of their own.
        for (const name of spec.names) {
          const sub = moduleAt(base, join(asPath, name));
          if (sub) found.add(sub);
        }
        const whole = asPath ? moduleAt(base, asPath) : null;
        // The package itself is what was meant when none of the names is a module in it.
        if (whole && (!found.size || !whole.endsWith("__init__.py"))) found.add(whole);
        if (found.size) return [...found];
      }
      return [];
    }
    if (spec.lang === "go") {
      const module = modules.find((m) => spec.path === m.name || spec.path.startsWith(m.name + "/"));
      const found = module ? goPackage(join(module.dir, spec.path.slice(module.name.length + 1))) : null;
      return found ? [found] : [];
    }
    if (spec.lang === "rs") {
      const stem = path.posix.basename(from, ".rs");
      const owns = ["mod", "lib", "main"].includes(stem); // these files stand for the folder they are in
      const children = owns ? here : join(here, stem);
      const siblings = owns ? dirOf(here) : here;
      const under = (base: string, parts: string[]): string | null => {
        // The longest path that is a file: the rest are names inside it.
        for (let n = parts.length; n > 0; n--) {
          const found = pick(join(base, ...parts.slice(0, n)) + ".rs", join(base, ...parts.slice(0, n), "mod.rs"));
          if (found) return found;
        }
        return null;
      };
      let found: string | null = null;
      if (spec.from === "mod" || spec.from === "self") found = under(children, spec.path);
      else if (spec.from === "super") found = under(siblings, spec.path);
      else {
        const crate = rustCrates.find((dir) => !dir || from.startsWith(dir + "/"));
        if (crate !== undefined) found = under(join(crate, "src"), spec.path);
      }
      return found && found !== from ? [found] : [];
    }
    if (spec.lang === "jvm") {
      const parts = spec.name.split(".");
      // The name may end in a member or a nested class: back off until it is a file.
      for (let n = parts.length; n > 1; n--) {
        const found = byEnding.get(parts.slice(0, n).join("/"));
        if (found) return [found];
      }
      return [];
    }
    const beside = pick(path.posix.normalize(join(here, spec.path)));
    const found = beside ?? byEnding.get(path.posix.normalize(spec.path).replace(/^(\.\.\/)+/, ""));
    return found ? [found] : [];
  };

  const out = new Map<string, string[]>();
  for (const [from, specs] of written) {
    const uses = new Set<string>();
    for (const spec of specs) for (const found of resolve(from, spec)) if (found !== from) uses.add(found);
    if (uses.size) out.set(from, [...uses]);
  }
  return out;
}
