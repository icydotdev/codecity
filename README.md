# Repo City

A map of a codebase. Every file is a building, in a place that stays put, so
you can get to know the neighbourhood instead of scrolling a file tree.

```bash
node bin/repocity.mjs ~/some/repo
```

Writes one HTML file and opens it. Nothing leaves your machine (the page loads
three.js from a CDN; that is the only request it makes).

## Reading the map

- **Where** a building stands is decided by when it first appeared. Inside each
  folder the oldest file is set down first and new ones are added at the end.
  A thing moves only when something set down before it gets bigger.
- **How big**: footprint and height both go with the square root of the file's
  length, so a building's volume is its length.
- **Its shape** is the shape of its text: one floor per sixty lines or so, each
  as wide as its lines are long. Files written to the same pattern look alike.
- **Flat slabs** are files a tool wrote (lockfiles). **Green tiles** are
  pictures and other things that are not text.
- **A light on the roof** is work not yet committed.
- **Click a building** and its imports are drawn over the roofs: blue to what
  it imports, purple from what imports it. One building at a time, because all
  of them at once is a ball of wool. JavaScript and TypeScript only so far, with
  the `paths` of the tsconfig at the top of the repository.
- **Height can be asked to mean something else**: how many files import each
  one (the Height switch, or H). Nothing moves; buildings grow or sink where
  they stand, and the six-line file everything leans on becomes a tower.
- **Changed** (key 2) opens on Auto, which has no dates in it: each file is
  placed by where its last change falls among all the others'. Warm is lately,
  dark and cold is long left alone, green is a file that is new and not only
  changed. It reads the same in a project a month old and one ten years old.
  The fixed windows (24 h to a year, and since your last visit) are beside it.
- **Colour** is whichever lens is on: changed lately, age, churn, file type,
  who mostly wrote it. The model itself never changes with the lens.

Drag to move, scroll to zoom, Q and E to turn it a quarter, `/` to find a file,
click for its card, double-click to open it in VS Code.

## Lands

`--land plain | corporate | beach`, or T in the page. A land changes what the
town stands on: the plain white model, navy with a ruled grid and every
district outlined, or a sand island with palms and boats. It never changes a
building: same place, same shape, same white light, so a colour means the same
thing in every land. Scenery stands on a fixed grid of its own and gives way
only when something is built on its spot.

## State

A first cut, made to answer one question: is this worth opening twice?
