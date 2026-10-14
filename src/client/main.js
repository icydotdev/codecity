import * as THREE from "three";

// The page. It is given a town (the files, their plots, the districts) and draws it. It can be
// given another town later, when the files change under a watcher, and then nothing is thrown
// away that can be kept: the view stays where it was, buildings grow or sink from the height they
// had, and whatever changed glows for a few seconds.
//
// Three things are kept apart throughout:
//   place   where a building stands. Decided by the layout, never by anything on this page.
//   height  what it measures can be switched (length, or how many files import it), and it moves
//           through time in the history. A building grows where it stands.
//   colour  whichever lens is on. The same white light in every land, so a colour means one thing.

const $ = (id) => document.getElementById(id);
const DAY = 86400;

// ------------------------------------------------------------------ the town, and what is known of it
// Everything here is replaced by mount() each time a new town arrives.
let D = null;
let files = [];
let W = 1;
let H = 1;
let reach = 1;
let tallest = 1;
let NOW = 0;
let town = null; // one box per floor of every building
let owner = new Uint32Array(0); // which file each of those boxes belongs to
let plates = null;
let lamps = null;
let sites = []; // files with work not yet committed
let signs = [];
let lots = new Map(); // which buildings stand near a spot, for scenery to keep off them
// What the lenses are worked out from.
let touched = [];
let standing = [];
let byAge = new Float32Array(0);
let mostCommits = 1;
let born = [0, 0]; // when the first and the latest file appeared
let kinds = { top: [], rest: 0, index: new Map() };
let people = { top: [], rest: 0, index: new Map() };
let unread = [];
let moments = []; // every time something happened in the history, oldest first

// ------------------------------------------------------------------ what you have chosen, which survives a new town
let tallBy = "lines";
let windowId = "auto";
let query = "";
let wanted = null; // the files a search matches, or null for no search
let picked = null; // the building whose card is open
let linksOn = true;
let clock = null; // null is today; otherwise a moment in the history, in seconds
let playing = false;
let playhead = 0; // a place in `moments`, with a fraction while playing
let frames = 3; // how many more frames to draw before resting

const wake = () => (frames = 3);

// ------------------------------------------------------------------ land
// The buildings are the data, and they are the same in every land: same shapes, same places, and the
// same white light, so a colour means the same thing wherever the town stands. What it stands on is taste.
const DAYLIGHT = { ui: "light", card: 0xfbfbfc, slab: 0xbcc3cb, old: 0x4a5670, other: 0xaab2bc, accent: 0x1f4bff, hot: 0xff4f2e, fresh: 0x0fa97c, amber: 0xf59a00, bounce: 0xd2d7dd, sun: 2.0, air: 1.5 };
const LANDS = {
  light: { label: "Light", ground: 0xd2d7dd, plates: [0xe2e5e9, 0xeaecef, 0xf1f2f4], park: 0xc2d6c6, dim: 0xd6dadf, base: 0xdde1e6, rim: 0xffffff, halo: 0xc3c9d1 },
  dark: { label: "Dark", ui: "dark", ground: 0x14181e, plates: [0x1b2028, 0x212731, 0x272e39], card: 0x6b7686, slab: 0x2b323b, park: 0x2c4236, dim: 0x1a1f26, base: 0x1c2129, rim: 0x39424f, halo: 0x10141a, old: 0x232a35, other: 0x4a5462, accent: 0x6f95ff, hot: 0xff6a4a, fresh: 0x2fc49a, amber: 0xffb53d, bounce: 0x14181e, sun: 2.1 },
  beach: { label: "Beach", ground: 0x7fc4d0, plates: [0xf1e2bd, 0xf5ead0, 0xf8f1e0], park: 0xf3b89a, dim: 0xe3d3a8 },
};
for (const id in LANDS) LANDS[id] = { ...DAYLIGHT, ...LANDS[id], id };
// What can be chosen. "auto" is light or dark, whichever the machine is set to, and is where everyone starts.
const THEMES = [["auto", "Auto"], ...Object.entries(LANDS).map(([id, t]) => [id, t.label])];
const system = matchMedia("(prefers-color-scheme: dark)");
/** The theme as chosen ("auto" among them), from whatever was asked for or remembered. Names that no longer exist mean auto. */
const themeOf = (name) => (THEMES.some(([id]) => id === name) ? name : "auto");
let chosen = "auto";
// Not "codecity:land": until 0.7.0 every theme shown was saved there, chosen or not.
const THEME_KEY = "codecity:theme";
let T = LANDS.light;
const PALETTE = [0x1f4bff, 0xff4f2e, 0x12a37a, 0xf59a00, 0x9b4dff, 0x00a3c7, 0xe0457b].map((hex) => new THREE.Color(hex));
const C = Object.fromEntries(["card", "slab", "park", "dim", "old", "other", "accent", "hot", "fresh", "amber"].map((key) => [key, new THREE.Color(T[key])]));

// ------------------------------------------------------------------ words
const ago = (seconds) => {
  const s = Math.max(0, NOW - seconds);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < DAY) return `${Math.round(s / 3600)} h ago`;
  if (s < DAY * 60) return `${Math.round(s / DAY)} d ago`;
  if (s < DAY * 730) return `${Math.round(s / DAY / 30.4)} mo ago`;
  return `${(s / DAY / 365.25).toFixed(1)} y ago`;
};
const day = (seconds) => new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const count = (n, one, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const esc = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const split = (p) => {
  const i = p.lastIndexOf("/");
  return [i < 0 ? "" : p.slice(0, i + 1), p.slice(i + 1)];
};
const ext = (p) => {
  const name = split(p)[1];
  const i = name.lastIndexOf(".");
  return i <= 0 ? "(none)" : name.slice(i);
};
/** Where a file opens: on the web when the map was made to be published (`--link`), otherwise in VS Code. */
const source = (f) => (D.link ? `${D.link}/${f.path.split("/").map(encodeURIComponent).join("/")}` : `vscode://file/${encodeURI(D.root + "/" + f.path)}`);
const authorName = (f) => (f.author < 0 ? "(not committed)" : D.authors[f.author]);
const css = (color) => "#" + color.getHexString();

// ------------------------------------------------------------------ scene
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
// Shadows only change when a building does, so they are redrawn when asked and not every frame.
renderer.shadowMap.autoUpdate = false;
const scene = new THREE.Scene();
scene.background = new THREE.Color(T.ground);

// Three measures light physically: a matte white surface shows as white when what falls on it adds up to pi.
const air = new THREE.HemisphereLight(0xffffff, T.bounce, T.air);
const sun = new THREE.DirectionalLight(0xffffff, T.sun);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(air, sun, sun.target);

const matte = (color) => new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), matte(T.ground));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// A box that stands on the ground instead of straddling it.
const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const m4 = new THREE.Matrix4();
const v3 = new THREE.Vector3();
const s3 = new THREE.Vector3();
const q0 = new THREE.Quaternion();
const put = (mesh, i, x, y, z, sx, sy, sz) => mesh.setMatrixAt(i, m4.compose(v3.set(x, y, z), q0, s3.set(sx, sy, sz)));
const townMaterial = matte(0xffffff);
const plateMaterial = matte(0xffffff);
const lampMaterial = new THREE.MeshBasicMaterial({ color: T.amber });

const marker = (opacity) => {
  const mesh = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: T.accent, transparent: opacity < 1, opacity }));
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
};
const hoverPlate = marker(0.35);
const pickPlate = marker(1);
const stand = (plate, f) => {
  plate.visible = !!f;
  if (f) plate.position.set(f.cx + f.dx, f.base, f.cz + f.dz), plate.scale.set(f.fw + 0.7, 0.09, f.fd + 0.7);
  wake();
};

// ------------------------------------------------------------------ height
// What height means. Usually a building is as tall as its file is long. It can be asked to show how
// many files import it instead: same town, same places, and the huts everything leans on become towers.
const flat = (f) => (f.kind === "asset" ? 0.22 : f.kind === "generated" ? 0.5 : 0);
// Height grows faster than a square root, which squeezed a 100-line file and a 600-line file into
// much the same building: a town of one height tells nothing. Past TOWER a building keeps growing
// but slowly, so one enormous file cannot make the camera pull back until the rest are specks.
const TOWER = 42;
const capped = (h) => (h <= TOWER ? h : TOWER + (h - TOWER) * 0.3);
const HEIGHTS = {
  lines: { label: "Lines", of: (f, lines = f.lines) => flat(f) || capped(Math.max(0.5, 0.16 * lines ** 0.7)) },
  usedBy: { label: "Imported by", of: (f) => flat(f) || capped(0.4 + 2.4 * f.usedBy.length ** 0.85) },
};
/** How long a file was at a moment in the history. Its log is time, lines, time, lines, oldest first. */
const linesAt = (f, moment) => {
  let lines = f.log.length ? f.log[1] : f.lines;
  for (let i = 0; i < f.log.length && f.log[i] <= moment; i += 2) lines = f.log[i + 1];
  return lines;
};
/** When a file had last been changed, as of a moment in the history. */
const touchedBy = (f, moment) => {
  let at = f.birth;
  for (let i = 0; i < f.log.length && f.log[i] <= moment; i += 2) at = f.log[i];
  return at;
};
/** The height a building should be heading for, given the day it is and what height is showing. */
const heightNow = (f) => (clock === null ? HEIGHTS[tallBy].of(f) : f.birth > clock ? 0 : HEIGHTS.lines.of(f, linesAt(f, clock)));

/** Lay the districts' plates. In the history a district is not there until its first file is. */
function pave() {
  D.dirs.forEach((d, i) => {
    const there = clock === null || d.birth <= clock ? 1 : 0;
    put(plates, i, d.x + d.w / 2 - W / 2, 0, d.y + d.h / 2 - H / 2, d.w * there, 0.05 * d.depth * there, d.h * there);
  });
  plates.instanceMatrix.needsUpdate = true;
  renderer.shadowMap.needsUpdate = true;
}

/** Stand every building at its present height. Its floors share the height out equally, whatever it measures. */
function raise() {
  for (const f of files) {
    const x = f.cx + f.dx;
    const z = f.cz + f.dz;
    const each = f.tall / f.floors.length;
    // Not built yet (in the history), so nothing at all, not even a line on the ground.
    const there = f.tall > 0.03 ? 1 : 0;
    for (let level = 0; level < f.floors.length; level++) put(town, f.first + level, x, f.base + level * each, z, (there * f.fw * f.floors[level][0]) / 100, each, (there * f.fd * f.floors[level][1]) / 100);
  }
  town.instanceMatrix.needsUpdate = true;
  renderer.shadowMap.needsUpdate = true;
}

// ------------------------------------------------------------------ links
// Imports, for one building at a time: every import in the town at once is a ball of wool.
// They go over the roofs and not along the ground, where the buildings would hide them.
const USED_BY = 0x9b4dff;
/** A file that half the town imports would be a solid purple dome. Past this many, the nearest are drawn. */
const MOST_LINKS = 240;
const links = new THREE.Group();
scene.add(links);
function wire(f) {
  for (const old of [...links.children]) links.remove(old), old.geometry !== box && old.geometry.dispose(), old.material.dispose();
  wake();
  if (!f || !linksOn || clock !== null) return;
  const roof = (b) => new THREE.Vector3(b.cx, b.base + b.tall, b.cz);
  const span = (from, to, hex) => {
    const a = roof(from);
    const b = roof(to);
    const top = a.clone().lerp(b, 0.5);
    top.y = Math.max(a.y, b.y) + 1.5 + a.distanceTo(b) * 0.22;
    links.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, top, b), Math.round(Math.min(40, 12 + a.distanceTo(b))), 0.13, 5), new THREE.MeshBasicMaterial({ color: hex })));
  };
  const foot = (b, hex) => {
    const plate = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: hex }));
    plate.position.set(b.cx, b.base, b.cz);
    plate.scale.set(b.fw + 0.6, 0.08, b.fd + 0.6);
    links.add(plate);
  };
  const nearest = (list) => (list.length <= MOST_LINKS ? list : [...list].sort((a, b) => Math.hypot(files[a].cx - f.cx, files[a].cz - f.cz) - Math.hypot(files[b].cx - f.cx, files[b].cz - f.cz)).slice(0, MOST_LINKS));
  for (const i of nearest(f.uses)) span(f, files[i], T.accent), foot(files[i], T.accent);
  for (const i of nearest(f.usedBy)) span(files[i], f, USED_BY), foot(files[i], USED_BY);
}

// ------------------------------------------------------------------ scenery
// Palms, parasols, boats, a ruled grid. Scenery is never data: it cannot be picked, and it stands only where no building does.
let seed = 0;
const chance = (x, z, n) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(n + 1, 1274126177) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const CELL = 6;
const taken = (x, z) => (lots.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []).some((f) => x > f.x - 0.3 && x < f.x + f.w + 0.3 && z > f.y - 0.3 && z < f.y + f.h + 0.3);
/**
 * Places for scenery: a fixed, jittered grid in the map's own coordinates, so a palm stands
 * where it stood yesterday, and goes only when something is built on its spot.
 */
function* spots(cell, margin) {
  for (let ix = Math.floor(-margin / cell); ix * cell < W + margin; ix++)
    for (let iz = Math.floor(-margin / cell); iz * cell < H + margin; iz++) {
      const x = (ix + 0.15 + 0.7 * chance(ix, iz, 0)) * cell;
      const z = (iz + 0.15 + 0.7 * chance(ix, iz, 1)) * cell;
      const out = Math.max(-x, x - W, -z, z - H, 0); // how far outside the town; 0 inside it
      if (out > margin || (out === 0 && taken(x, z))) continue;
      yield { x: x - W / 2, z: z - H / 2, out, r: (n) => chance(ix, iz, n + 2) };
    }
}
const G = {
  trunk: new THREE.CylinderGeometry(0.4, 0.5, 1, 5).translate(0, 0.5, 0),
  cone: new THREE.ConeGeometry(0.5, 1, 6).translate(0, 0.5, 0),
  shade: new THREE.ConeGeometry(0.5, 1, 8).translate(0, 0.5, 0),
  leaf: new THREE.BoxGeometry(1, 0.05, 0.3).translate(0.5, 0, 0),
};
const shared = new Set([box, ...Object.values(G)]);
/** Collects pieces and turns each kind of shape into one instanced mesh. */
function pieces() {
  const group = new THREE.Group();
  const made = new Map();
  const turn = new THREE.Euler();
  return {
    group,
    set(geometry, hex, x, y, z, sx, sy, sz, ry = 0, rz = 0) {
      if (!made.has(geometry)) made.set(geometry, []);
      made.get(geometry).push([new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(turn.set(0, ry, rz, "YXZ")), new THREE.Vector3(sx, sy, sz)), hex]);
    },
    done() {
      for (const [geometry, list] of made) {
        const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), list.length);
        list.forEach(([matrix, hex], i) => (mesh.setMatrixAt(i, matrix), mesh.setColorAt(i, new THREE.Color(hex))));
        mesh.castShadow = mesh.receiveShadow = true;
        group.add(mesh);
      }
      return group;
    },
  };
}
/** How round the corners of a field are. */
const cornerOf = (grow) => Math.min(W, H) * 0.16 + grow;
/** Whether a point (in the scene's coordinates) is on the field that reaches `grow` beyond the town. */
function onField(x, z, grow) {
  const r = cornerOf(grow);
  const dx = Math.max(Math.abs(x) - (W / 2 + grow - r), 0);
  const dz = Math.max(Math.abs(z) - (H / 2 + grow - r), 0);
  return Math.hypot(dx, dz) <= r;
}
/** A rounded piece of ground, the size of the town and `grow` more all round: the island, and the water round it. */
function field(group, grow, y, hex) {
  const w = W / 2 + grow;
  const h = H / 2 + grow;
  const r = cornerOf(grow);
  const shape = new THREE.Shape().moveTo(-w + r, -h).lineTo(w - r, -h).absarc(w - r, -h + r, r, -Math.PI / 2, 0).lineTo(w, h - r).absarc(w - r, h - r, r, 0, Math.PI / 2).lineTo(-w + r, h).absarc(-w + r, h - r, r, Math.PI / 2, Math.PI).lineTo(-w, -h + r).absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5);
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 16).rotateX(-Math.PI / 2), matte(hex));
  mesh.position.y = y;
  mesh.receiveShadow = true;
  group.add(mesh);
}
/**
 * The town stands on a board, as a model does: a soft shadow, a bright edge, then the board itself.
 * It gives the map an end, which bare ground running off in every direction did not.
 */
function board(colours) {
  const group = new THREE.Group();
  const edge = 6;
  field(group, edge + 1.6, 0.008, colours.halo);
  field(group, edge + 0.28, 0.016, colours.rim);
  field(group, edge, 0.024, colours.base);
  return group;
}
const SCENERY = {
  light: () => board(LANDS.light),
  dark: () => board(LANDS.dark),
  beach() {
    const s = pieces();
    const shore = 9;
    // The town stands on an island of sand: sand, a line of foam, pale shallows, then the sea (the ground itself).
    field(s.group, shore + 7, 0.01, 0xa6dade);
    field(s.group, shore + 1.1, 0.02, 0xf7fcfa);
    field(s.group, shore, 0.03, 0xecd9aa);
    // On a very big island a palm for every gap would be a forest, so they thin out as the town grows.
    const thin = Math.min(1, 9000 / (W * H));
    for (const p of spots(3.1, shore - 1.5)) {
      // The island's corners are round and the grid of spots is square: a spot out past a corner is
      // in the water. Nothing is planted there, with room left for a palm's fronds.
      if (!onField(p.x, p.z, shore - 1.3)) continue;
      if (p.r(0) > (p.out === 0 ? 0.14 * thin : 0.5)) continue;
      if (p.out > 2 && p.r(1) < 0.3) {
        // A parasol.
        s.set(G.trunk, 0xf4f4f4, p.x, 0, p.z, 0.05, 0.95, 0.05);
        s.set(G.shade, [0xff6b57, 0xffffff, 0x2bb3b1, 0xffd35c][Math.floor(p.r(2) * 4)], p.x, 0.8, p.z, 1.5, 0.38, 1.5, p.r(3) * 6.3);
        continue;
      }
      const tall = 1.5 + p.r(2) * 1.3;
      s.set(G.trunk, 0x9a7b54, p.x, 0, p.z, 0.13, tall, 0.13);
      for (let leaf = 0; leaf < 6; leaf++) s.set(G.leaf, leaf % 2 ? 0x4f9a6a : 0x3f8a5c, p.x, tall, p.z, 0.85 + p.r(3) * 0.4, 1, 1, (leaf / 6 + p.r(4)) * Math.PI * 2, -0.45 - (leaf % 2) * 0.2);
    }
    // A few boats, well out.
    for (const p of spots(11, shore + 40)) {
      if (p.out < shore + 9 || p.r(0) > 0.22) continue;
      const heading = p.r(1) * 6.3;
      s.set(box, p.r(2) < 0.5 ? 0xffffff : 0xff6b57, p.x, 0, p.z, 1.7, 0.28, 0.6, heading);
      s.set(G.cone, 0xffffff, p.x, 0.28, p.z, 0.9, 1.5, 0.08, heading);
    }
    return s.done();
  },
};
const built = new Map();
const retire = (object) => {
  scene.remove(object);
  object.traverse((part) => {
    if (part.geometry && !shared.has(part.geometry)) part.geometry.dispose();
    if (part.material && part.material !== townMaterial && part.material !== plateMaterial && part.material !== lampMaterial) part.material.dispose();
    if (part.isInstancedMesh) part.dispose();
  });
};

/**
 * Change what the town stands on. Nothing about the buildings moves or changes shape. Only a theme
 * picked by hand (`pick`) is remembered: one set by the command line or the machine is not a choice.
 */
function land(id, pick = false) {
  chosen = themeOf(id);
  T = LANDS[chosen === "auto" ? (system.matches ? "dark" : "light") : chosen];
  document.documentElement.classList.toggle("dark", T.ui === "dark");
  scene.background.set(T.ground);
  ground.material.color.set(T.ground);
  air.groundColor.set(T.bounce);
  air.intensity = T.air;
  sun.intensity = T.sun;
  D.dirs.forEach((d, i) => plates.setColorAt(i, new THREE.Color(T.plates[Math.min(d.depth, T.plates.length) - 1])));
  if (plates.instanceColor) plates.instanceColor.needsUpdate = true;
  for (const key in C) C[key].set(T[key]);
  lampMaterial.color.set(T.amber);
  hoverPlate.material.color.set(T.accent);
  pickPlate.material.color.set(T.accent);
  if (!built.has(T.id)) {
    built.set(T.id, SCENERY[T.id]?.() ?? new THREE.Group());
    scene.add(built.get(T.id));
  }
  for (const [key, group] of built) group.visible = key === T.id;
  pave();
  $("lands").value = chosen;
  if (pick)
    try {
      localStorage.setItem(THEME_KEY, chosen);
    } catch {
      /* storage switched off */
    }
  renderer.shadowMap.needsUpdate = true;
  wire(picked);
  paint();
}

// ------------------------------------------------------------------ camera
// A fixed tilt, and four places to stand: you can turn the model, you cannot get lost in it.
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
const TILT = (36 * Math.PI) / 180;
const view = { x: 0, z: 0, turn: Math.PI / 4, span: 1 };
const goal = { ...view };
const fit = () => Math.max(H * 0.62, (W * 0.62) / (innerWidth / innerHeight), 12);
function aim() {
  const aspect = innerWidth / innerHeight;
  Object.assign(camera, { left: -view.span * aspect, right: view.span * aspect, top: view.span, bottom: -view.span });
  const far = reach * 5 + tallest * 2;
  camera.position.set(view.x + Math.sin(view.turn) * Math.cos(TILT) * far, Math.sin(TILT) * far, view.z + Math.cos(view.turn) * Math.cos(TILT) * far);
  camera.lookAt(view.x, 0, view.z);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  wake();
}
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  aim();
}
addEventListener("resize", resize);

const ray = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = (e) => new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
const groundAt = (e) => {
  ray.setFromCamera(ndc(e), camera);
  return ray.ray.intersectPlane(floorPlane, new THREE.Vector3());
};
const fileAt = (e) => {
  ray.setFromCamera(ndc(e), camera);
  const hit = ray.intersectObject(town)[0];
  return hit ? files[owner[hit.instanceId]] : null;
};
const flyTo = (f) => Object.assign(goal, { x: f.cx, z: f.cz, span: Math.min(goal.span, Math.max(14, f.tall * 1.6, Math.max(f.fw, f.fd) * 6)) });

// ------------------------------------------------------------------ the view, in the address
// What you are looking at is kept after the # in the address (#lens=age&file=src/a.ts&view=...),
// so that the address is a link to it. Only what reads the same for anyone: not "since your last visit".
const short = (n) => Math.round(n * 100) / 100;
function viewOf() {
  const p = new URLSearchParams();
  if (lens !== LENSES[1]) p.set("lens", lens.id);
  if (lens === LENSES[1] && windowId !== "auto" && windowId !== "visit") p.set("span", windowId);
  if (tallBy !== "lines") p.set("height", tallBy);
  if (chosen !== "auto") p.set("theme", chosen);
  if (picked) p.set("file", picked.path);
  if (clock !== null) p.set("at", String(clock));
  p.set("view", [goal.x, goal.z, goal.turn, goal.span].map(short).join(","));
  return p.toString();
}
let keeping = null;
/** Write the view into the address, a moment after it stops changing (or at once, `after` 0). */
function keepView(after = 400) {
  clearTimeout(keeping);
  const write = () => {
    try {
      history.replaceState(null, "", `#${viewOf()}`);
    } catch {
      /* a page that cannot change its address */
    }
  };
  if (after) keeping = setTimeout(write, after);
  else write();
}
function openView(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  if (![...p.keys()].length) return;
  lens = LENSES.find((l) => l.id === p.get("lens")) ?? lens;
  if (WINDOWS.some((w) => w.id === p.get("span") && w.id !== "visit")) windowId = p.get("span");
  if (HEIGHTS[p.get("height")]) measure(p.get("height"));
  if (THEMES.some(([id]) => id === p.get("theme"))) land(p.get("theme"));
  const v = (p.get("view") ?? "").split(",").map(Number);
  if (v.length === 4 && v.every(Number.isFinite)) Object.assign(goal, { x: v[0], z: v[1], turn: v[2], span: Math.max(2, v[3]) }), Object.assign(view, goal), aim();
  const f = p.has("file") ? files.find((file) => file.path === p.get("file")) : null;
  if (f) show(f);
  const at = Number(p.get("at"));
  if (p.has("at") && Number.isFinite(at) && moments.length > 1) {
    enterHistory();
    play(false);
    const nearest = moments.reduce((best, m, i) => (Math.abs(m - at) < Math.abs(moments[best] - at) ? i : best), 0);
    setClock(nearest);
  }
  paint();
}

// ------------------------------------------------------------------ lenses
const lastSeenKey = () => `codecity:${D.root}:seen`;
let lastSeen = null;
/** The buildings the last pull changed, as places in `files`. */
let inPull = new Set();
/** A pull is news if it happened since the last visit, or within a week on a first visit. */
const pullIsNews = () => inPull.size > 0 && D.pull.at > (lastSeen ?? NOW - 7 * DAY);

const WINDOWS = [
  { id: "auto", label: "Auto" },
  { id: "pull", label: "Last pull" },
  { id: "visit", label: "Since last visit", since: () => lastSeen },
  { id: "1d", label: "the last 24 hours", fixed: true, since: () => NOW - DAY },
  { id: "7d", label: "the last 7 days", fixed: true, since: () => NOW - 7 * DAY },
  { id: "30d", label: "the last 30 days", fixed: true, since: () => NOW - 30 * DAY },
  { id: "90d", label: "the last 90 days", fixed: true, since: () => NOW - 90 * DAY },
  { id: "1y", label: "the last year", fixed: true, since: () => NOW - 365 * DAY },
];

// "Lately" and "long ago" mean different things in a project a month old and one ten years old. So Auto
// has no dates in it: every file is placed by where its last change falls among all the others' last
// changes. 1 is the most lately touched, 0 the longest left alone, and files changed together share a place.
const firstAtLeast = (value) => {
  let lo = 0;
  let hi = touched.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (touched[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
const touchedAt = (share) => touched[Math.round(share * (touched.length - 1))];
/** How strongly a file is coloured in Auto: nothing in the middle, most at either end. */
const warmth = (i) => Math.max(0, (standing[i] - 0.5) * 2) ** 1.7;
const chill = (i) => Math.max(0, (0.5 - standing[i]) * 2) ** 1.7;
/** A file is new, and not only changed, when it first appeared within the warmest fifth of that scale. */
const isNew = (f, i) => warmth(i) > 0 && f.birth >= touchedAt(0.8);

const tally = (key) => {
  const seen = new Map();
  for (const f of files) seen.set(key(f), (seen.get(key(f)) ?? 0) + 1);
  const top = [...seen].sort((a, b) => b[1] - a[1]);
  return { top: top.slice(0, PALETTE.length), rest: top.slice(PALETTE.length).reduce((sum, [, n]) => sum + n, 0), index: new Map(top.slice(0, PALETTE.length).map(([name], i) => [name, i])) };
};
/** Work out everything the lenses need from the town as it now is. */
function survey() {
  touched = files.map((f) => f.modified).sort((a, b) => a - b);
  standing = files.map((f) => (files.length > 1 ? (firstAtLeast(f.modified) + firstAtLeast(f.modified + 1) - 1) / 2 / (files.length - 1) : 0.5));
  const order = files.map((f, i) => [f.birth, i]).sort((a, b) => a[0] - b[0]);
  byAge = new Float32Array(files.length);
  order.forEach(([, i], place) => (byAge[i] = files.length > 1 ? place / (files.length - 1) : 1));
  mostCommits = files.reduce((top, f) => Math.max(top, f.commits), 1);
  born = files.reduce(([first, latest], f) => [Math.min(first, f.birth), Math.max(latest, f.birth)], [Infinity, -Infinity]);
  kinds = tally((f) => ext(f.path));
  people = tally(authorName);
  unread = lastSeen ? files.filter((f) => f.modified > lastSeen) : [];
  inPull = new Set(D.pull?.files ?? []);
  if (!inPull.size && windowId === "pull") windowId = "auto";
  const times = new Set([NOW]);
  for (const f of files) {
    times.add(f.birth);
    for (let i = 0; i < f.log.length; i += 2) times.add(f.log[i]);
  }
  moments = [...times].sort((a, b) => a - b);
}

const plain = (f) => (f.kind === "asset" ? C.park : f.kind === "generated" ? C.slab : C.card);
const tmp = new THREE.Color();
/** In the Changed lens with a fixed window, how strongly the oldest change in the window is coloured. Anything in it must be plain to see. */
const FAINTEST = 0.58;
const swatches = (title, t) =>
  `<h2>${title}</h2><ul>${t.top.map(([name, n], i) => `<li><i style="background:${css(PALETTE[i])}"></i><span>${esc(name)}</span><em>${n}</em></li>`).join("")}${t.rest ? `<li><i style="background:${css(C.other)}"></i><span>everything else</span><em>${t.rest}</em></li>` : ""}</ul>`;

const LENSES = [
  { id: "plain", label: "None", color: (f) => plain(f), legend: () => "" },
  {
    id: "recent",
    label: "Changed",
    color: (f, i) => {
      if (f.dirty) return C.amber;
      // What the last pull brought in, whenever those commits were written.
      if (windowId === "pull") return inPull.has(i) ? C.hot : plain(f);
      if (windowId === "auto") {
        // Warm for lately, cold and dark for long left alone, the plain model in between.
        if (standing[i] >= 0.5) return tmp.copy(plain(f)).lerp(isNew(f, i) ? C.fresh : C.hot, warmth(i));
        return tmp.copy(plain(f)).lerp(C.old, chill(i) * 0.92);
      }
      const since = WINDOWS.find((w) => w.id === windowId).since();
      if (f.modified < since) return plain(f);
      const fresh = windowId === "visit" ? 1 : 1 - (NOW - f.modified) / (NOW - since);
      return tmp.copy(plain(f)).lerp(C.hot, FAINTEST + (1 - FAINTEST) * fresh ** 0.7);
    },
    legend: () => {
      const loose = sites.length ? `<li><i style="background:${css(C.amber)}"></i><span>not committed</span><em>${sites.length}</em></li>` : "";
      if (windowId === "auto") {
        const born = files.filter((f, i) => !f.dirty && isNew(f, i)).length;
        // In a project a few days old every date is the same date, so say how long ago instead.
        const when = NOW - touched[0] < 14 * DAY ? ago : (at) => new Date(at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(NOW - touched[0] > 300 * DAY ? { year: "numeric" } : {}) });
        return `<h2>Last changed · on this project's own clock</h2>
          <div class="ramp" style="background:linear-gradient(90deg, ${css(C.old)}, ${css(C.card)} 50%, ${css(C.hot)})"></div>
          <div class="ends"><span>${when(touched[0])}</span><span>${when(touchedAt(0.5))}</span><span>now</span></div>
          <ul style="margin-top:8px"><li><i style="background:${css(C.hot)}"></i><span>changed lately</span><em>after ${when(touchedAt(0.8))}</em></li>
          <li><i style="background:${css(C.fresh)}"></i><span>new file</span><em>${born}</em></li>
          <li><i style="background:${css(C.old)}"></i><span>left alone</span><em>since ${when(touchedAt(0.2))}</em></li>${loose}</ul>`;
      }
      if (windowId === "pull")
        return `<h2>Last pull · ${esc(ago(D.pull.at))}</h2><ul><li><i style="background:${css(C.hot)}"></i><span>changed by it</span><em>${inPull.size}</em></li></ul><p>${count(inPull.size, "building")} of ${files.length.toLocaleString()}. Files it deleted are not shown.</p>${loose ? `<ul>${loose}</ul>` : ""}`;
      const w = WINDOWS.find((w) => w.id === windowId);
      const n = files.filter((f) => f.modified >= w.since()).length;
      return `<h2>Changed · ${esc(w.label)}</h2><div class="ramp" style="background:linear-gradient(90deg, ${css(tmp.copy(C.card).lerp(C.hot, FAINTEST))}, ${css(C.hot)})"></div><div class="ends"><span>${day(w.since())}</span><span>now</span></div><p>${count(n, "building")} of ${files.length.toLocaleString()}.</p>${loose ? `<ul>${loose}</ul>` : ""}`;
    },
  },
  {
    id: "age",
    label: "Age",
    color: (f, i) => tmp.copy(C.old).lerp(plain(f), byAge[i] ** 1.4),
    legend: () => `<h2>First appeared</h2><div class="ramp" style="background:linear-gradient(90deg, ${css(C.old)}, ${css(C.card)})"></div><div class="ends"><span>${day(born[0])}</span><span>${day(born[1])}</span></div><p>Dark is the old town.</p>`,
  },
  {
    id: "churn",
    label: "Churn",
    color: (f) => tmp.copy(plain(f)).lerp(C.accent, Math.log1p(f.commits) / Math.log1p(mostCommits)),
    legend: () => `<h2>Times changed</h2><div class="ramp" style="background:linear-gradient(90deg, ${css(C.card)}, ${css(C.accent)})"></div><div class="ends"><span>once</span><span>${count(mostCommits, "commit")}</span></div>`,
  },
  { id: "type", label: "Type", color: (f) => PALETTE[kinds.index.get(ext(f.path))] ?? C.other, legend: () => swatches("File type", kinds) },
  { id: "who", label: "Who", color: (f) => PALETTE[people.index.get(authorName(f))] ?? C.other, legend: () => swatches("Mostly written by", people) },
];
// The map opens coloured by what changed, on the project's own clock: the most useful thing it can say.
let lens = LENSES[1];

/** In the history, a building is warm while it was lately built or changed, as of the day being shown. */
const eraWindow = () => moments[Math.max(0, Math.round(playhead) - Math.max(2, Math.ceil(moments.length * 0.03)))];
const eraColor = (f) => {
  const from = eraWindow();
  const last = touchedBy(f, clock);
  if (last < from || clock === from) return plain(f);
  return tmp.copy(plain(f)).lerp(f.birth >= from ? C.fresh : C.hot, 0.45 + 0.55 * ((last - from) / (clock - from)));
};

const shade = new THREE.Color();
/** Colour every building: by the lens (or by the history), dimmed if a search leaves it out, glowing if it just changed. */
function tint() {
  files.forEach((f, i) => {
    shade.copy(clock === null ? lens.color(f, i) : eraColor(f));
    if (wanted && !wanted.has(f)) shade.lerp(C.dim, 0.88);
    if (f === picked) shade.copy(C.accent);
    if (f.pulse > 0) shade.lerp(C.amber, Math.min(1, f.pulse * 1.3));
    for (let k = 0; k < f.floors.length; k++) town.setColorAt(f.first + k, shade);
  });
  town.instanceColor.needsUpdate = true;
  wake();
}
function paint() {
  keepView();
  tint();
  const found = wanted ? `<h2>Found</h2><p>${count(wanted.size, "file")} matching.</p>` : "";
  const era = clock === null ? "" : `<h2>History</h2><p>${count(files.filter((f) => f.birth <= clock).length, "building")} of ${files.length.toLocaleString()} standing.</p><ul><li><i style="background:${css(C.fresh)}"></i><span>just built</span></li><li><i style="background:${css(C.hot)}"></i><span>just changed</span></li></ul>${D.quick ? "<p>This history is too long to measure, so buildings appear at the size they are today.</p>" : ""}`;
  const note = clock === null && tallBy === "usedBy" ? `<h2>Height</h2><p>How many files import each one. Not its length.</p>` : "";
  $("legend").innerHTML = found + (clock === null ? lens.legend() : era) + note;
  for (const b of $("lenses").querySelectorAll("button")) b.setAttribute("aria-pressed", String(clock === null && b.dataset.id === lens.id));
  $("line-windows").hidden = !(clock === null && lens.id === "recent");
  for (const b of $("windows").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.id === windowId)), (b.hidden = (b.dataset.id === "visit" && !lastSeen) || (b.dataset.id === "pull" && !inPull.size));
  // The dropdown shows its own choice when a length of time is what is showing, and its prompt when not.
  const fixed = WINDOWS.some((w) => w.fixed && w.id === windowId);
  $("span").value = fixed ? windowId : "";
  $("span").classList.toggle("on", fixed);
  for (const b of $("heights").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.id === tallBy));
  $("line-heights").hidden = !(clock === null && files.some((f) => f.usedBy.length));
}
const button = (parent, id, label, act) => {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.id = id;
  b.textContent = label;
  b.onclick = act;
  parent.append(b);
};
for (const l of LENSES) button($("lenses"), l.id, l.label, () => (leaveHistory(), (lens = l), paint()));
const option = (parent, id, label) => parent.append(Object.assign(document.createElement("option"), { value: id, textContent: label }));
for (const w of WINDOWS.filter((w) => !w.fixed)) button($("windows"), w.id, w.label, () => ((windowId = w.id), paint()));
option($("span"), "", "A length of time…");
for (const w of WINDOWS.filter((w) => w.fixed)) option($("span"), w.id, w.label);
$("span").onchange = (e) => ((windowId = e.target.value || "auto"), paint());
for (const [id, label] of THEMES) option($("lands"), id, label);
$("lands").onchange = (e) => land(e.target.value, true);
// On Auto the map follows the machine, at once, if it goes dark or light while the page is open.
system.addEventListener("change", () => chosen === "auto" && land("auto"));
for (const id in HEIGHTS) button($("heights"), id, HEIGHTS[id].label, () => measure(id));
/** Change what height means. Nothing moves; every building grows or sinks where it stands. */
function measure(by) {
  tallBy = by;
  for (const f of files) f.goal = heightNow(f);
  paint();
}

// ------------------------------------------------------------------ history
// The town through time. Every building stays on the plot it has today, appears on the day its file
// did, and is as tall as the file was long. Played by events, not by the calendar: a week in which
// nothing happened takes no time at all.
/** How long the whole history takes to play, in seconds. */
const PLAY_FOR = 26;
function setClock(place) {
  playhead = Math.max(0, Math.min(moments.length - 1, place));
  clock = moments[Math.round(playhead)];
  for (const f of files) f.goal = heightNow(f);
  pave();
  $("when").value = String(Math.round(playhead));
  $("date").textContent = day(clock);
  paint();
}
function enterHistory() {
  if (clock !== null || moments.length < 2) return;
  show(null);
  $("time").hidden = false;
  $("help").style.visibility = "hidden"; // the bar the history is played from takes its place
  $("era").hidden = true; // the bar has its own way out ("Today")
  $("when").max = String(moments.length - 1);
  lamps.visible = false;
  setClock(0);
  play(true);
}
function leaveHistory() {
  if (clock === null) return;
  wrap(0);
  play(false);
  clock = null;
  $("time").hidden = true;
  $("help").style.visibility = "visible";
  $("era").hidden = false;
  lamps.visible = true;
  for (const f of files) f.goal = heightNow(f);
  pave();
  paint();
}
function play(on) {
  playing = on;
  if (on && playhead >= moments.length - 1) setClock(0);
  $("play").textContent = on ? "Pause" : "Play";
  if (!on && film) wrap();
  wake();
}
$("era").onclick = () => (clock === null ? enterHistory() : leaveHistory());
$("play").onclick = () => play(!playing);
$("today").onclick = leaveHistory;
$("when").oninput = () => (play(false), setClock(Number($("when").value)));

// ------------------------------------------------------------------ a film of the history
// The history, saved as a video to post or keep. The map is drawn by WebGL and its names by the
// page, so each frame is put together on a sheet of its own: the map, the district names, the date
// and the repository's name. The sheet is what is recorded. Nothing leaves the machine.
/** The video being made, if one is. */
let film = null;
/** MP4 where the browser can write it, since that is what everything accepts; WebM where not. */
const FILM_TYPE = window.MediaRecorder && ["video/mp4;codecs=avc1.640028", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
/** How long the finished town is held at the end, in milliseconds: the last buildings are still rising when the history stops. */
const FILM_HOLD = 1800;
$("film").hidden = !FILM_TYPE;
function record() {
  if (film) return wrap(0);
  if (!FILM_TYPE || moments.length < 2) return;
  enterHistory();
  play(false);
  setClock(0);
  const sheet = document.createElement("canvas");
  sheet.width = canvas.width & ~1; // H.264 will not take an odd size
  sheet.height = canvas.height & ~1;
  const recorder = new MediaRecorder(sheet.captureStream(30), { mimeType: FILM_TYPE, videoBitsPerSecond: 12_000_000 });
  const parts = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  recorder.onstop = () => {
    film = null;
    $("film").textContent = "Save video";
    if (!parts.length) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(parts, { type: FILM_TYPE }));
    link.download = `${D.name.replace(/[^\w.-]+/g, "-")}-history.${FILM_TYPE.includes("mp4") ? "mp4" : "webm"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  };
  film = { sheet, pen: sheet.getContext("2d"), recorder, ending: 0 };
  $("film").textContent = "Stop";
  frame(); // the first frame is the empty ground, not whatever was showing
  recorder.start();
  play(true);
}
/** End the video, after a pause so that it does not stop on a town half built. */
function wrap(after = FILM_HOLD) {
  if (!film || film.ending) return;
  const { recorder } = film;
  film.ending = setTimeout(() => recorder.state !== "inactive" && recorder.stop(), after);
}
/** Draw one frame of the video: what is on the screen, without the controls. */
function frame() {
  const { sheet, pen } = film;
  const k = sheet.width / innerWidth; // the sheet is in device pixels, the page is not
  const look = getComputedStyle(document.body);
  const [ink, soft, paper] = ["--ink", "--soft", "--paper"].map((name) => look.getPropertyValue(name).trim());
  const labelFace = look.getPropertyValue("--label").trim();
  pen.drawImage(canvas, 0, 0, sheet.width, sheet.height);
  pen.textBaseline = "alphabetic";
  pen.lineJoin = "round";
  const write = (text, x, y, color) => {
    pen.strokeStyle = paper;
    pen.lineWidth = 4 * k;
    pen.strokeText(text, x, y);
    pen.fillStyle = color;
    pen.fillText(text, x, y);
  };
  pen.textAlign = "center";
  for (const { d, el } of signs) {
    if (el.style.display !== "block") continue;
    const minor = d.depth > 1;
    const x = parseFloat(el.style.left) * k;
    const y = parseFloat(el.style.top) * k;
    const color = minor ? soft : ink;
    pen.font = `${minor ? 500 : 600} ${(minor ? 10 : 11) * k}px ${labelFace}`;
    pen.letterSpacing = `${0.16 * (minor ? 10 : 11) * k}px`;
    const text = d.label.toUpperCase();
    const wide = pen.measureText(text).width;
    write(text, x, y - 8 * k, color);
    pen.fillStyle = color;
    pen.fillRect(x - wide / 2, y - 1 * k, wide, k);
    pen.fillRect(x - k / 2, y, k, (minor ? 9 : 14) * k);
  }
  pen.letterSpacing = "0px";
  pen.textAlign = "left";
  const edge = 28 * k;
  pen.font = `700 ${30 * k}px ${labelFace}`;
  write(D.name, edge, edge + 26 * k, ink);
  pen.font = `500 ${17 * k}px ${look.fontFamily}`;
  write(`${day(clock ?? moments[moments.length - 1])} · ${count(files.filter((f) => clock === null || f.birth <= clock).length, "file")}`, edge, edge + 52 * k, ink);
  pen.textAlign = "right";
  pen.font = `500 ${13 * k}px ${look.fontFamily}`;
  write("npx codecity", sheet.width - edge, sheet.height - edge, soft);
}
$("film").onclick = record;

// ------------------------------------------------------------------ labels
const lift = () => signs.forEach((sign) => (sign.at.y = sign.inside.reduce((max, f) => Math.max(max, f.tall), 0) + 0.05 * sign.d.depth));
function label() {
  const pxPerUnit = innerHeight / (2 * view.span);
  for (const { d, el, at } of signs) {
    const wide = Math.max(d.w, d.h) * pxPerUnit;
    const showing = wide > (d.depth === 1 ? 70 : 190) && (clock === null || d.birth <= clock);
    el.style.display = showing ? "block" : "none";
    if (!showing) continue;
    v3.copy(at).project(camera);
    el.style.left = `${((v3.x + 1) / 2) * innerWidth}px`;
    el.style.top = `${((1 - v3.y) / 2) * innerHeight - 16}px`;
  }
}

// ------------------------------------------------------------------ a new town
/**
 * Show this town. The first time, as it is. After that (`animate`), every building starts from the
 * height and place it had a moment ago, new ones rise from the ground, and whatever was saved since
 * glows for a few seconds.
 */
function mount(data, animate) {
  const before = new Map(files.map((f) => [f.path, f]));
  const pickedPath = picked?.path;
  D = data;
  NOW = D.at;
  files = D.files;
  W = D.w;
  H = D.h;
  reach = Math.hypot(W, H) / 2;
  seed = [...D.name].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);
  // Imports: `uses` is what a file imports, `usedBy` is who imports it. Both are places in `files`.
  for (const f of files) (f.uses = (f.uses ?? []).filter((i) => files[i])), (f.usedBy = []), (f.log ??= []);
  files.forEach((f, i) => f.uses.forEach((j) => files[j].usedBy.push(i)));
  tallest = files.reduce((top, f) => Math.max(top, HEIGHTS.lines.of(f), HEIGHTS.usedBy.of(f)), 1);
  if (!animate) {
    try {
      lastSeen = Number(localStorage.getItem(lastSeenKey())) || null;
      localStorage.setItem(lastSeenKey(), String(NOW));
    } catch {
      /* storage switched off: every visit is a first visit */
    }
  }
  survey();
  if (clock !== null) clock = moments[Math.min(moments.length - 1, Math.round(playhead))];
  // When each district's first file appeared.
  const began = new Map();
  for (const f of files) for (let at = f.path.lastIndexOf("/"); at > 0; at = f.path.lastIndexOf("/", at - 1)) if (f.birth < (began.get(f.path.slice(0, at)) ?? Infinity)) began.set(f.path.slice(0, at), f.birth);
  for (const d of D.dirs) d.birth = began.get(d.path) ?? 0;

  // Light, ground and lens, to the size of this town.
  sun.position.set(-reach * 0.7, reach * 1.2 + tallest, reach * 0.45);
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: reach * 4 + tallest });
  sun.shadow.camera.updateProjectionMatrix();
  ground.scale.setScalar(reach * 8);
  camera.far = reach * 12 + tallest * 4;

  // Every building's footprint, and where it is coming from.
  lots = new Map();
  let next = 0;
  files.forEach((f) => {
    const gap = Math.min(0.3, Math.min(f.w, f.h) * 0.12);
    // A plot can come out long and thin. The building on it does not: no side more than twice the other.
    f.fw = Math.min(f.w - gap * 2, (f.h - gap * 2) * 2);
    f.fd = Math.min(f.h - gap * 2, (f.w - gap * 2) * 2);
    f.cx = f.x + f.w / 2 - W / 2;
    f.cz = f.y + f.h / 2 - H / 2;
    f.base = 0.05 * f.depth;
    f.first = next;
    next += f.floors.length;
    f.goal = heightNow(f);
    const was = animate ? before.get(f.path) : null;
    f.tall = animate ? (was?.tall ?? 0) : f.goal;
    // The town is drawn about its middle, so when it grows every building shifts a little. Slide; do not jump.
    f.dx = was ? was.cx + was.dx - f.cx : 0;
    f.dz = was ? was.cz + was.dz - f.cz : 0;
    // A building that changed glows; one still glowing from an earlier change keeps glowing, so that
    // when saves come quickly (an agent at work) each one is seen and not cut short by the next.
    f.pulse = animate && (!was || was.stamp !== f.stamp || was.dirty !== f.dirty) ? 1 : (was?.pulse ?? 0);
    for (let ix = Math.floor((f.x - 0.5) / CELL); ix <= Math.floor((f.x + f.w + 0.5) / CELL); ix++)
      for (let iz = Math.floor((f.y - 0.5) / CELL); iz <= Math.floor((f.y + f.h + 0.5) / CELL); iz++) {
        const key = `${ix},${iz}`;
        if (!lots.has(key)) lots.set(key, []);
        lots.get(key).push(f);
      }
  });

  for (const old of [town, plates, lamps, ...built.values()]) if (old) retire(old);
  built.clear();
  town = new THREE.InstancedMesh(box, townMaterial, Math.max(1, next));
  town.count = next;
  town.castShadow = town.receiveShadow = true;
  // The mesh is told where its buildings are, so it is not skipped when the camera looks at one corner.
  town.frustumCulled = false;
  owner = new Uint32Array(next);
  files.forEach((f, index) => owner.fill(index, f.first, f.first + f.floors.length));
  // Districts: a plate for every folder, each a step lighter and a hair higher than the one it sits on.
  plates = new THREE.InstancedMesh(box, plateMaterial, Math.max(1, D.dirs.length));
  plates.count = D.dirs.length;
  plates.frustumCulled = false;
  plates.receiveShadow = true;
  // Work not yet committed: a light on the roof.
  sites = files.filter((f) => f.dirty);
  lamps = new THREE.InstancedMesh(box, lampMaterial, Math.max(1, sites.length));
  lamps.count = sites.length;
  lamps.frustumCulled = false;
  lamps.visible = clock === null;
  scene.add(plates, town, lamps);

  // District names, the largest first, and not so many that the page crawls.
  for (const sign of signs) sign.el.remove();
  signs = D.dirs
    .filter((d) => d.depth <= 2)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, 140)
    .map((d) => {
      const el = document.createElement("div");
      el.className = "district" + (d.depth > 1 ? " minor" : "");
      el.textContent = d.label;
      $("labels").append(el);
      return { d, el, inside: files.filter((f) => f.path.startsWith(d.path + "/")), at: new THREE.Vector3(d.x + d.w / 2 - W / 2, 0, d.y + d.h / 2 - H / 2) };
    });

  $("name").textContent = D.name;
  $("sub").textContent = [D.branch && `${D.branch} @ ${D.head}`, count(files.length, "file"), count(files.reduce((sum, f) => sum + (f.kind === "code" ? f.lines : 0), 0), "line"), `since ${new Date(born[0] * 1000).getFullYear()}`].filter(Boolean).join("  ·  ");
  // One piece of news at a time, and a pull outranks the rest: it is what just landed on this machine.
  $("news").style.display = pullIsNews() || unread.length ? "block" : "none";
  if (pullIsNews()) $("news").innerHTML = `<b>${inPull.size}</b> changed in your last pull, ${esc(ago(D.pull.at))}`;
  else if (unread.length) $("news").innerHTML = `<b>${unread.length}</b> changed since you last looked, ${esc(ago(lastSeen))}`;
  $("era").style.display = moments.length > 2 ? "" : "none";
  $("when").max = String(moments.length - 1);

  pave();
  wanted = search();
  picked = pickedPath ? (files.find((f) => f.path === pickedPath) ?? null) : null;
  raise();
  lift();
  if (!animate) {
    view.span = goal.span = fit();
    aim();
  }
  land(animate ? chosen : (D.land ?? stored() ?? "auto"));
  show(picked);
}
const stored = () => {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null; // storage switched off
  }
};
$("news").onclick = () => (leaveHistory(), (lens = LENSES[1]), (windowId = pullIsNews() ? "pull" : "visit"), paint());

// ------------------------------------------------------------------ pointer
const tip = $("tip");
const card = $("card");
let drag = null;
/** A short list of linked files in the card, each a button that goes there. */
const hops = (title, list, color) => {
  if (!list.length) return "";
  const byName = [...list].sort((a, b) => split(files[a].path)[1].localeCompare(split(files[b].path)[1]));
  const shown = byName.slice(0, 8).map((i) => `<button type="button" class="hop" data-i="${i}" title="${esc(files[i].path)}">${esc(split(files[i].path)[1])}</button>`).join("");
  return `<div class="hops"><h3><i style="background:${color}"></i>${title} · ${list.length}</h3>${shown}${list.length > 8 ? `<span>+${list.length - 8} more</span>` : ""}</div>`;
};
function show(f) {
  picked = f;
  stand(pickPlate, f);
  wire(f);
  paint();
  card.style.display = f ? "block" : "none";
  if (clock === null) $("help").style.visibility = f ? "hidden" : "visible"; // the card needs the room
  if (!f) return;
  const [dir, name] = split(f.path);
  const what = f.kind === "asset" ? "Not text" : f.kind === "generated" ? `${count(f.lines, "line")}, written by a tool` : count(f.lines, "line");
  card.innerHTML = `<div class="dir">${esc(dir)}</div><div class="file">${esc(name)}</div>
    <dl><dt>Size</dt><dd>${what}</dd>
    <dt>First appeared</dt><dd>${f.commits ? `${day(f.birth)} · ${ago(f.birth)}` : "not committed yet"}</dd>
    <dt>Last changed</dt><dd>${f.dirty ? `<span style="color:var(--amber)">being worked on now</span>` : `${day(f.modified)} · ${ago(f.modified)}`}</dd>
    <dt>Changed</dt><dd>${count(f.commits, "time")}</dd>
    <dt>Mostly by</dt><dd>${esc(authorName(f))}</dd></dl>
    ${hops("Imports", f.uses, "var(--accent)")}${hops("Imported by", f.usedBy, "#9b4dff")}
    <div class="acts"><a href="${esc(source(f))}"${D.link ? ' target="_blank" rel="noopener"' : ""}>${D.link ? "View source" : "Open in VS Code"}</a><button type="button" id="copy">Copy path</button></div>`;
  $("copy").onclick = () => navigator.clipboard?.writeText(f.path).then(() => ($("copy").textContent = "Copied"));
  for (const hop of card.querySelectorAll(".hop")) hop.onclick = () => (show(files[Number(hop.dataset.i)]), flyTo(picked));
}
// Two fingers on the map: pinch to zoom, about the point between them.
const fingers = new Map();
let pinch = null;
const between = () => {
  const [a, b] = [...fingers.values()];
  return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2, apart: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
};
const letGo = (e) => {
  fingers.delete(e.pointerId);
  if (fingers.size < 2) pinch = null;
};
canvas.addEventListener("pointercancel", letGo);
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (e.pointerType === "touch") fingers.set(e.pointerId, e);
  if (fingers.size === 2) {
    pinch = { apart: between().apart, span: view.span };
    drag = null;
    return;
  }
  drag = { x: e.clientX, y: e.clientY, from: groundAt(e), moved: false };
});
canvas.addEventListener("pointermove", (e) => {
  if (fingers.has(e.pointerId)) fingers.set(e.pointerId, e);
  if (pinch && fingers.size === 2) {
    const mid = between();
    const before = groundAt(mid);
    view.span = goal.span = Math.max(4, Math.min(fit() * 2.5, (pinch.span * pinch.apart) / Math.max(1, mid.apart)));
    aim();
    const after = groundAt(mid);
    view.x = goal.x = view.x + before.x - after.x;
    view.z = goal.z = view.z + before.z - after.z;
    aim();
    return;
  }
  if (drag) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
    if (drag.moved) {
      canvas.classList.add("dragging");
      tip.style.display = "none";
      // Keep the piece of ground that was picked up under the pointer.
      const now = groundAt(e);
      view.x = goal.x = view.x + drag.from.x - now.x;
      view.z = goal.z = view.z + drag.from.z - now.z;
      aim();
    }
    return;
  }
  const f = fileAt(e);
  stand(hoverPlate, f && f !== picked ? f : null);
  canvas.classList.toggle("over", !!f);
  tip.style.display = f ? "block" : "none";
  if (f) {
    const [dir, name] = split(f.path);
    const size = f.kind === "asset" ? "not text" : count(clock === null ? f.lines : linesAt(f, clock), "line");
    tip.innerHTML = `${esc(dir)}<b>${esc(name)}</b><small>${size}${f.usedBy.length ? " · imported by " + f.usedBy.length : ""} · ${f.dirty ? "being worked on now" : "changed " + ago(f.modified)}</small>`;
    tip.style.left = `${Math.max(8, Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.max(8, e.clientY - tip.offsetHeight - 12)}px`;
  }
});
canvas.addEventListener("pointerup", (e) => {
  const pinching = pinch !== null;
  letGo(e);
  canvas.classList.remove("dragging");
  if (!pinching && drag && !drag.moved && clock === null) show(fileAt(e));
  drag = null;
});
// On a phone the settings open from a button and close when the map is touched.
$("gear").onclick = () => $("gear").setAttribute("aria-expanded", String(document.body.classList.toggle("open")));
canvas.addEventListener("pointerdown", () => (document.body.classList.remove("open"), $("gear").setAttribute("aria-expanded", "false")));
canvas.addEventListener("dblclick", (e) => {
  const f = fileAt(e);
  if (f && D.link) open(source(f), "_blank", "noopener");
  else if (f) location.href = source(f);
});
canvas.addEventListener("pointerleave", () => ((tip.style.display = "none"), stand(hoverPlate, null)));
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const before = groundAt(e);
    view.span = goal.span = Math.max(4, Math.min(fit() * 2.5, view.span * Math.exp(e.deltaY * 0.0015)));
    aim();
    const after = groundAt(e);
    view.x = goal.x = view.x + before.x - after.x;
    view.z = goal.z = view.z + before.z - after.z;
    aim();
  },
  { passive: false },
);

// ------------------------------------------------------------------ keys and search
const searchBox = $("search");
function search() {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? new Set(files.filter((f) => words.every((w) => f.path.toLowerCase().includes(w)))) : null;
}
searchBox.addEventListener("input", () => {
  query = searchBox.value;
  wanted = search();
  paint();
});
searchBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && wanted?.size) {
    // The shortest path that matches is usually the one that was meant.
    const best = [...wanted].sort((a, b) => a.path.length - b.path.length)[0];
    leaveHistory();
    show(best);
    flyTo(best);
  }
  if (e.key === "Escape") (searchBox.value = ""), searchBox.dispatchEvent(new Event("input")), searchBox.blur();
});
addEventListener("keydown", (e) => {
  if (e.target === searchBox || e.target === $("when") || e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "/") e.preventDefault(), searchBox.focus();
  if (key === "q") goal.turn -= Math.PI / 2;
  if (key === "e") goal.turn += Math.PI / 2;
  if (key === "escape") picked ? show(null) : leaveHistory();
  if (key === "0") Object.assign(goal, { x: 0, z: 0, span: fit() });
  if (key === "l") (linksOn = !linksOn), wire(picked);
  if (key === "h" && clock === null && files.some((f) => f.usedBy.length)) measure(tallBy === "lines" ? "usedBy" : "lines");
  if (key === "t") land(THEMES[(THEMES.findIndex(([id]) => id === chosen) + 1) % THEMES.length][0], true);
  if (key === "p" || key === " ") e.preventDefault(), clock === null ? enterHistory() : play(!playing);
  const n = Number(e.key);
  if (n >= 1 && n <= LENSES.length) leaveHistory(), (lens = LENSES[n - 1]), paint();
  wake();
});

// ------------------------------------------------------------------ go
mount(JSON.parse($("data").textContent), false);
// A link to a view opens that view; a saved copy opens on the view it was saved from.
openView(location.hash.length > 1 ? location.hash : D.view ? `#${D.view}` : "");

// ------------------------------------------------------------------ sharing
// Share, where the page has an address someone else can open: it copies a link to exactly this view
// (or, on a phone, opens the phone's own share sheet). Save a copy, while live: this map as one file.
// (?share in the address shows it anyway, to try it out on a map served from this machine.)
const shareable = (/^https?:$/.test(location.protocol) && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) || new URLSearchParams(location.search).has("share");
$("share").hidden = !shareable;
$("acts").hidden = !D.live;
$("share").setAttribute("aria-label", "Share a link to this view");
$("share").onclick = async () => {
  keepView(0);
  const button = $("share");
  const label = button.querySelector("span");
  const done = (text) => {
    clearTimeout(button.undo);
    button.classList.remove("done");
    void button.offsetWidth; // so that a second copy plays the ring again
    button.classList.add("done");
    label.textContent = text;
    button.undo = setTimeout(() => (button.classList.remove("done"), (label.textContent = "Share")), 2200);
  };
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try {
      await navigator.share({ title: `${D.name} · codecity`, url: location.href });
    } catch {
      /* the sheet was closed */
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(location.href);
  } catch {
    // No clipboard here (a page served over plain http): the old way still works.
    const field = Object.assign(document.createElement("textarea"), { value: location.href });
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) return void (label.textContent = "Copy the address bar");
  }
  done("URL copied to clipboard");
};
// The copy is made by the codecity command, from the town as it is now, without the live feed.
$("keep").onclick = () => ($("keep").href = `copy?view=${encodeURIComponent(viewOf())}`);
resize();

// Under a watcher: listen for the next town.
if (D.live) {
  $("line-live").hidden = false;
  const toggle = $("live");
  const note = $("live-note");
  // A switch. Off, the map holds still while files change (for reading it, or for showing it to
  // someone), and the newest town waits; on again, it catches up in one step.
  let paused = false;
  let connected = false;
  let waiting = null;
  const say = () => {
    toggle.setAttribute("aria-checked", String(connected && !paused));
    toggle.disabled = !connected;
    toggle.title = !connected ? "The codecity command is no longer running" : paused ? "Follow changes again" : "Hold the map still";
    note.textContent = !connected ? "stopped" : !paused ? "on" : waiting ? "paused · changes waiting" : "paused";
    note.classList.toggle("waiting", connected && paused && waiting !== null);
  };
  toggle.onclick = () => {
    paused = !paused;
    if (!paused && waiting) mount(waiting, true), (waiting = null);
    say();
  };
  const feed = new EventSource("events");
  feed.onopen = () => ((connected = true), say());
  feed.onerror = () => ((connected = false), say());
  feed.addEventListener("city", (e) => {
    const next = JSON.parse(e.data);
    if (paused) waiting = next;
    else mount(next, true);
    say();
  });
}

let last = performance.now();
let wasGrowing = false;
let wasMoving = false;
renderer.setAnimationLoop((t) => {
  const seconds = Math.min(0.1, (t - last) / 1000);
  const ease = 1 - Math.exp(-(seconds * 1000) / 110);
  last = t;
  let moving = false;
  for (const key of ["x", "z", "turn", "span"]) {
    const gap = goal[key] - view[key];
    if (Math.abs(gap) > 1e-4) (view[key] += gap * ease), (moving = true);
  }
  if (moving) aim();
  else if (wasMoving) keepView(); // the camera has come to rest
  wasMoving = moving;

  if (playing) {
    const place = playhead + (seconds * moments.length) / PLAY_FOR;
    if (place >= moments.length - 1) setClock(moments.length - 1), play(false);
    else if (Math.round(place) !== Math.round(playhead)) setClock(place);
    else playhead = place;
  }

  let growing = false;
  let glowing = false;
  for (const f of files) {
    const gap = f.goal - f.tall;
    if (Math.abs(gap) > 0.01) (f.tall += gap * ease * 0.6), (growing = true);
    else if (gap) (f.tall = f.goal), (growing = true);
    if (f.dx || f.dz) {
      f.dx = Math.abs(f.dx) > 0.01 ? f.dx * (1 - ease * 0.6) : 0;
      f.dz = Math.abs(f.dz) > 0.01 ? f.dz * (1 - ease * 0.6) : 0;
      growing = true;
    }
    if (f.pulse > 0) (f.pulse = Math.max(0, f.pulse - seconds / 6)), (glowing = true);
  }
  if (growing) raise(), lift(), stand(pickPlate, picked);
  else if (wasGrowing) wire(picked); // the links go to the roofs, so draw them again once the roofs have stopped
  wasGrowing = growing;
  if (glowing) tint();

  const lit = lamps.visible && sites.length > 0;
  if (lit) {
    const beat = 0.5 + 0.5 * Math.sin(t / 380);
    sites.forEach((f, i) => put(lamps, i, f.cx + f.dx, f.base + f.tall + 0.25 + beat * 0.35, f.cz + f.dz, 0.55, 0.55, 0.55));
    lamps.instanceMatrix.needsUpdate = true;
  }
  // Nothing moving, nothing to draw: a map left open all day should cost nothing.
  if (!(moving || growing || glowing || playing || lit || film || frames > 0)) return;
  frames = Math.max(0, frames - 1);
  label();
  renderer.render(scene, camera);
  // In the same turn as the drawing: a moment later the browser has cleared what WebGL drew.
  if (film) frame();
});
