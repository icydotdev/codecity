import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect, type CityFile, type Memory } from "./collect.js";
import { layout, type District } from "./layout.js";

// A city is everything the page needs, ready to be written into it: the files
// with their plots, the districts, and a few words about the repository.

export const LANDS = ["auto", "light", "dark", "beach"] as const;
export type Land = (typeof LANDS)[number];

export interface City {
  name: string;
  root: string;
  branch: string;
  head: string;
  at: number;
  authors: string[];
  /** Which land to open on, when the command line asked for one. */
  land: Land | null;
  /** True when the page is being served by a watcher and should listen for changes. */
  live: boolean;
  /** True when the history was too long to measure, so the timelapse cannot show buildings growing. */
  quick: boolean;
  /** The last pull: when it was, and the buildings it changed, as places in `files`. */
  pull: { at: number; files: number[] } | null;
  w: number;
  h: number;
  dirs: District[];
  /** `uses` here is places in this list, not paths. */
  files: (Omit<CityFile, "uses"> & { uses: number[]; depth: number; x: number; y: number; w: number; h: number })[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function buildCity(dir: string, options: { land?: Land | null; live?: boolean } = {}, before?: Memory): { city: City; memory: Memory } {
  const { repo, memory } = collect(dir, before);
  const plan = layout(repo.files);
  const placeOf = new Map(plan.plots.map((plot, i) => [plot.file.path, i]));
  const city: City = {
    name: repo.name,
    root: repo.root,
    branch: repo.branch,
    head: repo.head,
    at: repo.at,
    authors: repo.authors,
    land: options.land ?? null,
    live: options.live ?? false,
    quick: repo.quick,
    pull: repo.pull && {
      at: repo.pull.at,
      // Files the pull deleted have no building to point at.
      files: repo.pull.files.map((name) => placeOf.get(name)).filter((place): place is number => place !== undefined),
    },
    w: round(plan.w),
    h: round(plan.h),
    dirs: plan.dirs.map((d) => ({ ...d, x: round(d.x), y: round(d.y), w: round(d.w), h: round(d.h) })),
    files: plan.plots.map(({ file, depth, x, y, w, h }) => ({
      ...file,
      uses: file.uses.map((used) => placeOf.get(used)).filter((place): place is number => place !== undefined),
      depth,
      x: round(x),
      y: round(y),
      w: round(w),
      h: round(h),
    })),
  };
  return { city, memory };
}

/** The built page: one file with the script and three.js inside it, and two places to write into. */
function template(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Run from dist/ it is beside us. Run from src/ (npm run dev) it is in dist/, once built.
  const built = here.endsWith("src") ? path.join(here, "../dist/client/index.html") : path.join(here, "client/index.html");
  try {
    return readFileSync(built, "utf8");
  } catch {
    throw new Error(`The page has not been built (${built} is missing). Run: npm run build`);
  }
}

/** A complete page for this city. */
export function page(city: City): string {
  return template()
    .replace("__TITLE__", () => city.name.replace(/[<>&]/g, ""))
    .replace("__DATA__", () => JSON.stringify(city).replace(/</g, "\\u003c"));
}
