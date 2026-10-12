import { expect, test } from "vitest";
import { flow, layout, rowWidth, weightOf, type Plotted, type Rect } from "../src/layout.js";

const file = (path: string, lines: number, birth: number): Plotted => ({ path, lines, birth, kind: "code" });
const town = (): Plotted[] => [
  file("README.md", 40, 1),
  file("src/index.ts", 120, 2),
  file("src/app/page.tsx", 300, 3),
  file("src/app/layout.tsx", 60, 4),
  file("src/lib/util.ts", 900, 5),
  file("test/util.test.ts", 200, 6),
  file("src/lib/format.ts", 80, 7),
  ...Array.from({ length: 30 }, (_, i) => file(`src/lib/part${i}.ts`, 20 + i * 13, 10 + i)),
];
const overlap = (a: Rect, b: Rect) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
const where = (files: Plotted[]) => new Map(layout(files).plots.map((p) => [p.file.path, `${p.x.toFixed(6)},${p.y.toFixed(6)}`]));
// test/ was set down after src/, so it is the one district allowed to shift when src/ grows.
const setDownBefore = (paths: string[]) => paths.filter((path) => !path.startsWith("test/"));

test("flow sets things down in order, in rows, without overlap, small ones tucked under", () => {
  const items = [
    { w: 4, h: 4 },
    { w: 2, h: 1.5 },
    { w: 2, h: 1.5 },
    { w: 3, h: 3 },
    { w: 5, h: 2 },
  ];
  const plan = flow(items, 0.5, 10);
  const rects = items.map((item, i) => ({ ...item, ...plan.places[i]! }));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i]!, rects[j]!), `${i} and ${j}`).toBe(false);
  expect(plan.places[0]).toEqual({ x: 0, y: 0 });
  expect(plan.places[1], "the next one starts a column beside the first").toEqual({ x: 4.5, y: 0 });
  expect(plan.places[2], "and a short one goes under it").toEqual({ x: 4.5, y: 2 });
  expect(plan.places[4]!.y, "what does not fit in the row starts the next").toBeGreaterThan(0);
  for (const r of rects) expect(r.x + r.w).toBeLessThanOrEqual(10 + 1e-9);
});

test("no two buildings share ground, and every one stands on the map and on its folder's plate", () => {
  const plan = layout(town());
  expect(plan.plots).toHaveLength(town().length);
  for (const p of plan.plots) expect(p.x >= 0 && p.y >= 0 && p.x + p.w <= plan.w + 1e-6 && p.y + p.h <= plan.h + 1e-6, p.file.path).toBe(true);
  for (let i = 0; i < plan.plots.length; i++) for (let j = i + 1; j < plan.plots.length; j++) expect(overlap(plan.plots[i]!, plan.plots[j]!)).toBe(false);
  const lib = plan.dirs.find((d) => d.path === "src/lib")!;
  for (const p of plan.plots.filter((p) => p.file.path.startsWith("src/lib/"))) expect(p.x >= lib.x && p.y >= lib.y && p.x + p.w <= lib.x + lib.w + 1e-6 && p.y + p.h <= lib.y + lib.h + 1e-6, p.file.path).toBe(true);
});

test("the same repository always gives the same map, whatever order git lists it in", () => {
  expect(layout(town().reverse())).toEqual(layout(town()));
});

test("a new file moves none of its folder's buildings, and nothing set down before its folder", () => {
  const before = where(town());
  const after = where([...town(), file("src/lib/newest.ts", 150, 999)]);
  for (const path of setDownBefore([...before.keys()])) expect(after.get(path), path).toBe(before.get(path));
  expect(after.has("src/lib/newest.ts")).toBe(true);
});

test("a file that grows moves only what was set down after it", () => {
  const before = where(town());
  const grown = where(town().map((f) => (f.path === "src/lib/part20.ts" ? { ...f, lines: f.lines * 3 } : f)));
  const older = town().filter((f) => f.birth < 30).map((f) => f.path);
  for (const path of setDownBefore(older)) expect(grown.get(path), path).toBe(before.get(path));
  expect([...grown], "something after it did move").not.toEqual([...before]);
});

test("row widths go up in steps, so a folder is seldom laid out afresh", () => {
  expect(rowWidth(15)).toBe(rowWidth(10));
  expect(rowWidth(400)).toBeGreaterThan(rowWidth(100));
  const steps = new Set(Array.from({ length: 200 }, (_, i) => rowWidth(20 + i * 20)));
  expect(steps.size, "different widths over a two-hundred-fold growth").toBeLessThanOrEqual(8);
});

test("a folder with nothing in it but one folder is one district", () => {
  const plan = layout([file("a/b/c/x.ts", 10, 1), file("a/b/c/y.ts", 10, 2), file("z.ts", 10, 3)]);
  expect(plan.dirs.map((d) => d.label)).toEqual(["a/b/c"]);
});

test("a long file is a bigger plot, but generated files and pictures stay small", () => {
  expect(weightOf({ kind: "code", lines: 1600 })).toBeGreaterThan(weightOf({ kind: "code", lines: 100 }));
  expect(weightOf({ kind: "generated", lines: 20000 })).toBeLessThanOrEqual(6);
  expect(weightOf({ kind: "asset", lines: 0 })).toBe(1.4);
});
