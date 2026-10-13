// Where everything stands.
//
// The promise this file makes: **a thing moves only when something set down
// before it gets bigger.** Inside every folder things are set down in the
// order they first appeared, like words in a paragraph: along a row, then onto
// the next. Where a thing lands depends only on what came earlier. So a new
// file takes the next free place at the end of its folder and disturbs none of
// that folder's buildings; if the folder needs more ground for it, the folders
// set down after that one shift along, and nothing before it does. The old
// town is where the project began, and it stays where you learned it.
//
// The exception is a re-plan. A folder's rows have a set width, and when the
// folder outgrows it the width goes up a step and that one folder is laid out
// afresh. The steps are far apart, so this is rare.
//
// Every building's footprint is its own: a square whose area goes with the
// square root of the file's length. (Its height, which the viewer decides,
// grows faster than that.) Nothing is stretched to fill a gap, which is why
// there are yards.

/** What the layout needs to know about a file. */
export interface Plotted {
  path: string;
  kind: "code" | "generated" | "asset";
  lines: number;
  birth: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Plot<F extends Plotted> extends Rect {
  file: F;
  depth: number;
}
export interface District extends Rect {
  path: string;
  label: string;
  depth: number;
}
export interface Plan<F extends Plotted> {
  w: number;
  h: number;
  dirs: District[];
  plots: Plot<F>[];
}

/** Ground area for each unit of weight, in the map's own units. */
export const AREA_PER_WEIGHT = 1.25;
/** Clear ground round every building. */
const YARD = 0.3;
/** Between the districts inside a folder, by that folder's depth. */
const STREET = [2.6, 1.3, 0.8, 0.5];
/** Between a district's edge and what stands in it, by its depth. */
const PAVEMENT = [0, 1.0, 0.65, 0.45];
/** Rows are about this much wider than the block is deep. */
const WIDE = 1.5;
/** Row widths go up in steps of this, from this. */
const STEP = Math.SQRT2;
const SMALLEST_ROW = 5;
const at = (table: number[], depth: number) => table[Math.min(depth, table.length - 1)]!;

/** A file's weight grows with the square root of its length. */
export function weightOf(file: Pick<Plotted, "kind" | "lines">): number {
  if (file.kind === "asset") return 1.4;
  if (file.kind === "generated") return Math.min(6, 1.4 + Math.sqrt(file.lines) * 0.12);
  return Math.max(1.6, Math.sqrt(file.lines));
}

/** The width a block of this much ground is given for its rows: the next step up, so it rarely changes. */
export function rowWidth(ground: number): number {
  const wanted = Math.sqrt(ground * WIDE);
  return SMALLEST_ROW * STEP ** Math.max(0, Math.ceil(Math.log(wanted / SMALLEST_ROW) / Math.log(STEP) - 1e-9));
}

/**
 * Set rectangles down in the order given, in rows no wider than `limit`. A short one goes
 * under the one before it when there is room in the row, so small things fill in beside a
 * big one instead of leaving a hole. Each place depends only on what came earlier.
 */
export function flow(items: { w: number; h: number }[], gap: number, limit: number): { w: number; h: number; places: { x: number; y: number }[] } {
  const places: { x: number; y: number }[] = [];
  let rowY = 0;
  let rowH = 0;
  let colX = 0;
  let colW = 0;
  let colUsed = 0;
  let width = 0;
  for (const item of items) {
    const under = colW > 0 && colUsed + gap + item.h <= rowH + 1e-9 && colX + Math.max(colW, item.w) <= limit + 1e-9;
    if (under) {
      places.push({ x: colX, y: rowY + colUsed + gap });
      colUsed += gap + item.h;
      colW = Math.max(colW, item.w);
    } else {
      let x = colW > 0 ? colX + colW + gap : 0;
      if (x > 0 && x + item.w > limit + 1e-9) {
        rowY += rowH + gap;
        rowH = 0;
        x = 0;
      }
      places.push({ x, y: rowY });
      colX = x;
      colW = item.w;
      colUsed = item.h;
      rowH = Math.max(rowH, item.h);
    }
    width = Math.max(width, colX + colW);
  }
  return { w: width, h: rowY + rowH, places };
}

interface Folder<F> {
  name: string;
  path: string;
  dirs: Map<string, Folder<F>>;
  files: F[];
}

function tree<F extends Plotted>(files: F[]): Folder<F> {
  const root: Folder<F> = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]!);
      if (!next) node.dirs.set(parts[i]!, (next = { name: parts[i]!, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push(file);
  }
  return root;
}

interface Sized<F extends Plotted> {
  key: string;
  birth: number;
  w: number;
  h: number;
  put(x: number, y: number, out: Plan<F>): void;
}

const oldestFirst = (a: { birth: number; key: string }, b: { birth: number; key: string }) => a.birth - b.birth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const ground = (items: { w: number; h: number }[], gap: number) => items.reduce((sum, item) => sum + (item.w + gap) * (item.h + gap), 0);

/** Work out how much ground a folder needs, from the inside out. Returns its size and how to set it down. */
function measure<F extends Plotted>(start: Folder<F>, depth: number): Sized<F> {
  let node = start;
  let label = node.name;
  // src/ holding nothing but components/ is one district called src/components.
  while (depth > 0 && node.files.length === 0 && node.dirs.size === 1) {
    node = [...node.dirs.values()][0]!;
    label += "/" + node.name;
  }
  // The folder's own files first, oldest first, as one block; then its folders, oldest first.
  const lots = node.files
    .map((file) => {
      const side = Math.sqrt(weightOf(file) * AREA_PER_WEIGHT) + YARD * 2;
      return { file, key: file.path, birth: file.birth, w: side, h: side };
    })
    .sort(oldestFirst);
  const block = flow(lots, 0, rowWidth(ground(lots, 0)));
  const kids = [...node.dirs.values()].map((dir) => measure(dir, depth + 1)).sort(oldestFirst);
  const street = at(STREET, depth);
  const parts: { w: number; h: number }[] = [...(lots.length ? [block] : []), ...kids];
  const plan = flow(parts, street, rowWidth(ground(parts, street)));
  const edge = at(PAVEMENT, depth);
  const w = plan.w + edge * 2;
  const h = plan.h + edge * 2;
  const path = node.path;
  return {
    key: path,
    birth: Math.min(...lots.map((lot) => lot.birth), ...kids.map((kid) => kid.birth)),
    w,
    h,
    put(x, y, out) {
      if (depth > 0) out.dirs.push({ path, label, depth, x, y, w, h });
      plan.places.forEach((place, i) => {
        const px = x + edge + place.x;
        const py = y + edge + place.y;
        const part = parts[i]!;
        if (part === block) lots.forEach((lot, j) => out.plots.push({ file: lot.file, depth, x: px + block.places[j]!.x, y: py + block.places[j]!.y, w: lot.w, h: lot.h }));
        else (part as Sized<F>).put(px, py, out);
      });
    },
  };
}

/** Every file's plot and every folder's plate, on a ground `w` by `h`. */
export function layout<F extends Plotted>(files: F[]): Plan<F> {
  const root = measure(tree(files), 0);
  const out: Plan<F> = { w: root.w, h: root.h, dirs: [], plots: [] };
  root.put(0, 0, out);
  return out;
}
