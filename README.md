<p align="center">
  <img src="https://raw.githubusercontent.com/icydotdev/codecity/main/assets/logo.svg" width="120" alt="codecity" />
</p>

<h1 align="center">codecity</h1>

<p align="center">
  <strong>A 3D map of your codebase. Every file is a building, and every building keeps its place.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codecity"><img src="https://img.shields.io/npm/v/codecity.svg?style=flat&colorA=18181B&colorB=6366f1" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/codecity"><img src="https://img.shields.io/npm/dm/codecity.svg?style=flat&colorA=18181B&colorB=6366f1" alt="npm downloads" /></a>
  <a href="https://github.com/icydotdev/codecity/blob/main/LICENSE"><img src="https://img.shields.io/github/license/icydotdev/codecity?style=flat&colorA=18181B&colorB=6366f1" alt="license" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> · <a href="#what-it-shows">What It Shows</a> · <a href="#usage">Usage</a> · <a href="#how-it-works">How It Works</a> · <a href="#limitations">Limitations</a>
</p>

---

Codebases now change faster than anyone can read them line by line. **codecity** renders a git repository as a 3D map so that you can keep an accurate picture of the whole: where the established code is, where work is happening, which files everything else depends on, and what has changed since you last looked.

It runs locally with a single command and produces a single HTML file. There is nothing to configure, no account to create, and no data leaves your machine.

<p align="center">
  <img src="https://raw.githubusercontent.com/icydotdev/codecity/main/assets/history.gif" width="800" alt="A 6,000 file repository growing from its first commit to the present day" />
</p>

<p align="center"><sub>History playback of a 6,000 file, 2,500 commit test repository.</sub></p>

## Quick Start

```bash
npx codecity
```

This opens a map of the current repository in your browser and keeps it up to date while you or your coding agents work. Stop it with `Ctrl+C`.

To write the map to a single HTML file instead, to keep or to share:

```bash
npx codecity -o map.html
```

To install globally:

```bash
npm i -g codecity
cd your-project
codecity
```

Requires Node.js 20 or later and git.

## What It Shows

### A stable layout

Each folder is a district and each file is a building. Within a district, buildings are placed in the order their files were first committed, so the oldest code sits where the project began and new work is added at the edges.

The layout is deterministic and stable. A building moves only when something placed before it grows, which means the map you learned last month is still the map today, and everyone on the team sees the same one.

| Property | Meaning |
|---|---|
| Position | The file's folder, and when the file first appeared |
| Footprint and height | File length. The footprint grows with the square root of the line count. Height grows faster, so long files stand well clear of short ones |
| Outline | The shape of the code. Each floor is about sixty lines and is as wide as those lines are long, so files that follow the same pattern look alike |
| Flat grey slab | A generated file, such as a lockfile |
| Flat tile | A binary file, such as an image or font |
| Light on the roof | Uncommitted changes |

### Change activity

<p align="center">
  <img src="https://raw.githubusercontent.com/icydotdev/codecity/main/assets/screenshot-changed.jpg" width="800" alt="Files coloured by how recently they changed" />
</p>

The **Changed** view colours every file by how recently it was modified.

- **Automatic scale.** By default the scale is relative to the project's own history, not to fixed dates, so it is equally useful on a repository that is a week old and one that is ten years old. Recently changed files are warm, files that have not been touched for a long time are dark, and everything in between is neutral.
- **New files.** Files that were created recently, as opposed to edited, are shown in green.
- **Uncommitted work.** Files with uncommitted changes are shown in amber.
- **Fixed windows.** Switch to the last 24 hours, 7, 30 or 90 days, or the last year.
- **Last pull.** Shows exactly the files your most recent `git pull` changed, read from git's own record of where `HEAD` has been. A commit's date says when it was written, not when it reached your machine, so this is the view to use after pulling a colleague's work. When a pull is recent, a notice above the map leads straight to it.
- **Since your last visit.** The map records when you last opened it and can show only what has changed since then.

### Dependencies

<p align="center">
  <img src="https://raw.githubusercontent.com/icydotdev/codecity/main/assets/dependencies.gif" width="800" alt="Selecting a file draws its imports and the files that import it" />
</p>

Select any file to see how it is connected.

- **Blue lines** run to the files it imports.
- **Purple lines** run from the files that import it.
- The detail panel lists both sets with their counts. Select a name in the list to jump to that file.
- Press `L` to hide or show the lines.

Dependencies are drawn for one file at a time. Drawing every import in a repository at once produces a diagram that cannot be read.

<p align="center">
  <img src="https://raw.githubusercontent.com/icydotdev/codecity/main/assets/screenshot-height.jpg" width="800" alt="Building height showing the number of files that import each file" />
</p>

To find the files the codebase relies on most, switch **Height** from *Lines* to *Imported by* (or press `H`). Each building is then as tall as the number of files that import it. Buildings change height in place, so a short utility file that half the codebase depends on becomes immediately visible.

Imports are resolved for JavaScript and TypeScript, including `paths` aliases from the root `tsconfig.json` or `jsconfig.json`.

### Live updates

codecity serves the map on `localhost` and applies changes as they happen, without reloading the page.

- Files that have just been saved are highlighted for a few seconds.
- New files rise from the ground in their final position.
- **Pause.** Click the *live* indicator beside the repository name to hold the map still, for example while presenting it. Changes that arrive in the meantime are applied in one step when you resume.
- Commits, checkouts and staging are picked up from the `.git` directory.

This is the mode to use while coding agents are working: you can see where in the codebase they are making changes.

### History

Select **History** (or press `P`) to replay the repository from its first commit to the present. Each district appears when its first file does, and each file appears on the date it was first committed and grows as it grew. Recently added files are shown in green and recently changed files in coral. The timeline can be paused and scrubbed.

Playback advances by event, not by calendar time, so periods of inactivity are skipped.

### Views

| View | Colours each file by |
|---|---|
| None | No colouring. The plain model |
| Changed | How recently it was modified. This is the view the map opens on |
| Age | When it first appeared |
| Churn | How many commits have touched it |
| Type | File extension |
| Who | The author with the most commits to it |

A view only ever changes colour. Position and shape always mean the same thing.

### Themes

Two themes are included: **Plain** and **Beach**. A theme changes the ground the map stands on. It never changes the buildings or the lighting, so colours mean the same thing in every theme.

<p align="center">
  <img src="https://raw.githubusercontent.com/icydotdev/codecity/main/assets/screenshot-plain.jpg" width="400" alt="Plain theme" />
  <img src="https://raw.githubusercontent.com/icydotdev/codecity/main/assets/screenshot-beach.jpg" width="400" alt="Beach theme" />
</p>

## Usage

```
codecity [folder] [options]

  -o <file>         Write the map to one HTML file and stop, to keep or share
  --once            The same, to a temporary folder
  --port <number>   Port to serve the live map on (default: 3737)
  --land <name>     Theme: plain, beach
  --no-browser      Don't open the browser automatically
  -h, --help        Show this help message
```

With `-o` or `--once`, the output is one self-contained HTML file. It works offline and can be opened from disk, attached to a pull request or sent to a colleague.

### Keyboard and mouse

| Input | Action |
|---|---|
| Drag, scroll | Move and zoom |
| `Q` `E` | Rotate by a quarter turn |
| `1` to `6` | Select a view |
| `H` | Switch height between lines and imported by |
| `T` | Switch theme |
| `P` | Play or pause the history |
| `/` | Find a file by path |
| `L` | Hide or show dependency lines |
| `0` | Reset the camera |
| Click | Open a file's detail panel and draw its dependencies |
| Double click | Open the file in VS Code |

## How It Works

codecity reads three things, all locally:

1. **The working tree.** Every file tracked by git, plus untracked files that are not ignored. Line counts and outlines are computed from the file contents.
2. **Git history.** One pass of `git log --numstat` provides, for each file, the date it first appeared, the date it last changed, the number of commits, the main author and its size over time.
3. **Imports.** Import and require statements in JavaScript and TypeScript files, resolved to files in the repository.

The layout is computed from that data and written, together with the viewer, into a single HTML file. The viewer and its 3D library are bundled into the file, so the page makes no network requests.

By default a local server bound to `127.0.0.1` serves the page and pushes updates to it. Git history is cached and only read again when the current commit changes.

## Limitations

- Imports are resolved for JavaScript and TypeScript only. `paths` aliases are read from the root `tsconfig.json` or `jsconfig.json` only.
- The history shows the files that exist today. Files that were deleted along the way do not appear.
- For repositories with more than 20,000 commits, per-commit sizes are not computed. In the history, files then appear at their current size.
- Tested with repositories of up to 6,000 files. Larger repositories may be slow.
- "Last changed" is the most recent commit that touched a file. A single commit that reformats every file will make the whole repository appear recently changed.
- File watching relies on recursive `fs.watch`, which has been tested on macOS only.

## Background

The idea of drawing software as a city comes from CodeCity, the research tool by Richard Wettel and Michele Lanza (University of Lugano, 2007). This package is an independent implementation of that metaphor and is not affiliated with the original project.

Before version 0.2.0 this package was published as `@icydotdev/repocity`.

## Contributing

Issues and pull requests are welcome.

```bash
git clone https://github.com/icydotdev/codecity
cd codecity
npm install
npm run build
npm run dev -- ../some-repo
```

## License

MIT © Sam Kavanagh
