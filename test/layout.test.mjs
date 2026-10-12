import assert from "node:assert/strict";
import { test } from "node:test";
import { findImports, plainJson, profile, resolveImport } from "../src/collect.mjs";
import { flow, layout, rowWidth, weightOf } from "../src/layout.mjs";

const file = (path, lines, birth) => ({ path, lines, birth, kind: "code" });
const town = () => [
  file("README.md", 40, 1),
  file("src/index.ts", 120, 2),
  file("src/app/page.tsx", 300, 3),
  file("src/app/layout.tsx", 60, 4),
  file("src/lib/util.ts", 900, 5),
  file("test/util.test.ts", 200, 6),
  file("src/lib/format.ts", 80, 7),
  ...Array.from({ length: 30 }, (_, i) => file(`src/lib/part${i}.ts`, 20 + i * 13, 10 + i)),
];
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
const where = (plan) => new Map(plan.plots.map((p) => [p.file.path, `${p.x.toFixed(6)},${p.y.toFixed(6)}`]));

test("flow sets things down in order, in rows, without overlap, small ones tucked under", () => {
  const items = [
    { w: 4, h: 4 },
    { w: 2, h: 1.5 },
    { w: 2, h: 1.5 },
    { w: 3, h: 3 },
    { w: 5, h: 2 },
  ];
  const plan = flow(items, 0.5, 10);
  const rects = items.map((item, i) => ({ ...item, ...plan.places[i] }));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!overlap(rects[i], rects[j]), `${i} and ${j} overlap`);
  assert.deepEqual(plan.places[0], { x: 0, y: 0 });
  assert.deepEqual(plan.places[1], { x: 4.5, y: 0 }, "the next one starts a column beside the first");
  assert.deepEqual(plan.places[2], { x: 4.5, y: 2 }, "and a short one goes under it");
  assert.ok(plan.places[4].y > 0, "what does not fit in the row starts the next");
  for (const r of rects) assert.ok(r.x + r.w <= 10 + 1e-9);
});

test("no two buildings share ground, and every one stands on the map and on its folder's plate", () => {
  const plan = layout(town());
  assert.equal(plan.plots.length, town().length);
  for (const p of plan.plots) assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= plan.w + 1e-6 && p.y + p.h <= plan.h + 1e-6, p.file.path);
  for (let i = 0; i < plan.plots.length; i++) for (let j = i + 1; j < plan.plots.length; j++) assert.ok(!overlap(plan.plots[i], plan.plots[j]));
  const lib = plan.dirs.find((d) => d.path === "src/lib");
  for (const p of plan.plots.filter((p) => p.file.path.startsWith("src/lib/"))) assert.ok(p.x >= lib.x && p.y >= lib.y && p.x + p.w <= lib.x + lib.w + 1e-6 && p.y + p.h <= lib.y + lib.h + 1e-6, p.file.path);
});

test("the same repository always gives the same map, whatever order git lists it in", () => {
  assert.deepEqual(layout(town()), layout(town().reverse()));
});

// test/ was set down after src/, so it is the one district allowed to shift when src/ grows.
const setDownBefore = (paths) => paths.filter((path) => !path.startsWith("test/"));

test("a new file moves none of its folder's buildings, and nothing set down before its folder", () => {
  const before = where(layout(town()));
  const after = where(layout([...town(), file("src/lib/newest.ts", 150, 999)]));
  for (const path of setDownBefore([...before.keys()])) assert.equal(after.get(path), before.get(path), `${path} moved`);
  assert.ok(after.has("src/lib/newest.ts"));
});

test("a file that grows moves only what was set down after it", () => {
  const before = where(layout(town()));
  const grown = where(layout(town().map((f) => (f.path === "src/lib/part20.ts" ? { ...f, lines: f.lines * 3 } : f))));
  const older = town().filter((f) => f.birth < 30).map((f) => f.path);
  for (const path of setDownBefore(older)) assert.equal(grown.get(path), before.get(path), `${path} was set down earlier and moved`);
  assert.notDeepEqual([...grown], [...before], "something after it did move");
});

test("row widths go up in steps, so a folder is seldom laid out afresh", () => {
  assert.equal(rowWidth(10), rowWidth(15));
  assert.ok(rowWidth(400) > rowWidth(100));
  const steps = new Set(Array.from({ length: 200 }, (_, i) => rowWidth(20 + i * 20)));
  assert.ok(steps.size <= 8, `${steps.size} different widths over a two-hundred-fold growth`);
});

test("a folder with nothing in it but one folder is one district", () => {
  const plan = layout([file("a/b/c/x.ts", 10, 1), file("a/b/c/y.ts", 10, 2), file("z.ts", 10, 3)]);
  assert.deepEqual(plan.dirs.map((d) => d.label), ["a/b/c"]);
});

test("a long file is a bigger plot, but generated files and pictures stay small", () => {
  assert.ok(weightOf(file("a", 1600, 0)) > weightOf(file("b", 100, 0)));
  assert.ok(weightOf({ kind: "generated", lines: 20000 }) <= 6);
  assert.equal(weightOf({ kind: "asset", lines: 0 }), 1.4);
});

test("a file's silhouette: its floors run from the end of the file up to its first lines", () => {
  const wide = "x".repeat(70);
  const text = [...Array(60).fill("ab"), ...Array(60).fill(wide)].join("\n") + "\n";
  const shape = profile(text);
  assert.equal(shape.lines, 120);
  assert.equal(shape.floors.length, 2);
  assert.ok(shape.floors[0][0] > shape.floors[1][0], "the long lines at the end of the file are the wide ground floor");
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
  assert.deepEqual(findImports(text).sort(), ["../lib/b.js", "./a", "./again", "./d", "./e", "./side-effect.css", "@/types", "react"].sort());
});

test("an import is found as a file here, and a package is not", () => {
  const here = new Set(["src/a.ts", "src/lib/b.ts", "src/ui/index.tsx", "types.ts", "src/x.json"]);
  const has = (path) => here.has(path);
  const aliases = [{ prefix: "@/", target: "" }];
  assert.equal(resolveImport("./lib/b", "src/a.ts", has, aliases), "src/lib/b.ts");
  assert.equal(resolveImport("../a", "src/lib/b.ts", has, aliases), "src/a.ts");
  assert.equal(resolveImport("./lib/b.js", "src/a.ts", has, aliases), "src/lib/b.ts", "a .js ending that means the .ts file");
  assert.equal(resolveImport("./ui", "src/a.ts", has, aliases), "src/ui/index.tsx", "a folder means its index");
  assert.equal(resolveImport("@/types", "src/a.ts", has, aliases), "types.ts");
  assert.equal(resolveImport("./x.json", "src/a.ts", has, aliases), "src/x.json");
  assert.equal(resolveImport("react", "src/a.ts", has, aliases), null);
  assert.equal(resolveImport("../../outside", "src/a.ts", has, aliases), null);
});

test("a tsconfig's comments and trailing commas go, and its strings are left alone", () => {
  const text = `{
  // where things are
  "compilerOptions": {
    "paths": { "@/*": ["./*"], }, /* the alias */
  },
  "include": ["**/*.ts", ".next/types/**/*.ts",],
}`;
  assert.deepEqual(JSON.parse(plainJson(text)), { compilerOptions: { paths: { "@/*": ["./*"] } }, include: ["**/*.ts", ".next/types/**/*.ts"] });
});
