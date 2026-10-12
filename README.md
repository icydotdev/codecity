<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@icydotdev/repocity/assets/logo.svg" width="120" alt="repocity" />
</p>

<h1 align="center">repocity</h1>

<p align="center">
  <strong>Your codebase as a town. Every file a building, in a place that stays put.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@icydotdev/repocity"><img src="https://img.shields.io/npm/v/@icydotdev/repocity.svg?style=flat&colorA=18181B&colorB=6366f1" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@icydotdev/repocity"><img src="https://img.shields.io/npm/dm/@icydotdev/repocity.svg?style=flat&colorA=18181B&colorB=6366f1" alt="npm downloads" /></a>
  <a href="https://github.com/icydotdev/repocity/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@icydotdev/repocity.svg?style=flat&colorA=18181B&colorB=6366f1" alt="license" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> · <a href="#features">Features</a> · <a href="#reading-the-map">Reading the map</a> · <a href="#usage">Usage</a> · <a href="#limits">Limits</a>
</p>

---

Code changes faster than anyone can read it. **repocity** draws a git repository as a small town you can get to know: where the old code is, where the work is happening, what everything leans on, and what changed since you last looked.

One command, one HTML file. No config, no account, nothing leaves your machine.

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@icydotdev/repocity/assets/screenshot-beach.jpg" width="800" alt="A repository drawn as a town on a sand island, recently changed files in coral" />
</p>

## Quick Start

```bash
npx @icydotdev/repocity
```

That's it. Opens your browser with a map of the repository you are in.

Keep it open while you (or your agents) work:

```bash
npx @icydotdev/repocity --watch
```

Or install globally:

```bash
npm i -g @icydotdev/repocity
cd your-project
repocity
```

## Features

- **A place for every file** — Buildings are set down in the order files first appeared, so the old town is where the project began and new work is added at the edges. A building moves only when something set down before it grows
- **Shape from the code** — One floor per sixty lines, each as wide as its lines are long. Files written to the same pattern look alike; the odd one out stands out
- **Watch mode** — `--watch` keeps the map open and updates it as files are saved or committed. What just changed glows, new files rise from the ground
- **History** — Play the repository from its first commit. Buildings appear on the day their file did and grow as it grew
- **What changed, on the project's own clock** — Warm for lately, dark for long left alone, green for brand new, amber for not yet committed. No dates to pick: it reads the same in a project a week old and one ten years old
- **Since you last looked** — Remembers your last visit and shows only what moved since
- **Imports on click** — Click a building: blue lines to what it imports, purple from what imports it. JavaScript and TypeScript, with tsconfig `paths`
- **Height can mean weight** — Switch height from lines of code to "how many files import this" and the six-line helper everything leans on becomes a tower
- **Six lenses** — Model, Changed, Age, Churn, Type, Who
- **Three lands** — Plain, Corporate, Beach. The ground changes, the buildings never do
- **One file, offline** — The map is a single HTML file with everything inside it. Open it from disk, send it to someone
- **Zero config** — Reads git and the files. Nothing to set up

## Screenshots

<details>
<summary>Corporate, with a building's imports</summary>
<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@icydotdev/repocity/assets/screenshot-corporate.jpg" width="800" alt="Navy map with import lines from one selected building" />
</p>
</details>

<details>
<summary>Plain</summary>
<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@icydotdev/repocity/assets/screenshot-plain.jpg" width="800" alt="White architect's model of a repository" />
</p>
</details>

## Reading the map

| | |
|---|---|
| **Where it stands** | Its folder is its district. Inside a district, oldest first. |
| **Footprint and height** | Both go with the square root of the file's length, so a building's volume is its length. |
| **Its outline** | The shape of its text: long lines make wide floors. |
| **Flat grey slab** | Written by a tool (lockfiles). |
| **Flat tile** | Not text (images, fonts). |
| **Light on the roof** | Work not yet committed. |
| **Colour** | Whichever lens is on. Never the building itself. |

## Usage

```
repocity [folder] [options]

  -w, --watch       Keep the map open and update it as files change
  --port <number>   Port for --watch (default: 3737)
  -o <file>         Where to write the map (default: a temporary folder)
  --land <name>     What the town stands on: plain, corporate, beach
  --no-browser      Don't open the browser automatically
  -h, --help        Show this help message
```

In the page:

| Key | |
|---|---|
| drag, scroll | Move, zoom |
| `Q` `E` | Turn a quarter |
| `1`–`6` | Lens |
| `H` | Height: lines, or imported by |
| `T` | Land |
| `P` | Play the history |
| `/` | Find a file |
| `L` | Hide or show import lines |
| click | A building's card and imports |
| double-click | Open it in VS Code |

## Limits

- Imports are read for JavaScript and TypeScript only, and `paths` only from the tsconfig at the top of the repository.
- The history shows the files that exist today. Files deleted along the way do not appear.
- Past 20,000 commits the history is not measured commit by commit, so buildings appear in the history at the size they are now.
- Tested up to 6,000 files. Beyond that, expect it to slow down.
- "Last changed" is the last commit that touched a file. One commit that reformats everything makes the whole town look fresh.

## Contributing

Issues and pull requests are welcome.

```bash
git clone https://github.com/icydotdev/repocity
cd repocity
npm install
npm run build
npm run dev -- ../some-repo --watch
```

## License

MIT © Sam Kavanagh
