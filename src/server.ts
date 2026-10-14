import { watch } from "node:fs";
import http, { type ServerResponse } from "node:http";
import { buildCity, page, type City, type Land } from "./city.js";
import type { Memory } from "./collect.js";

// Watching: the page stays open and the town changes as the files do. A small
// server on this machine only, which hands out the page and then tells it,
// over one long-lived connection, each time there is a new town to show.

/** Wait this long after the last change before looking, so a save of twenty files is one look. */
const SETTLE_MS = 350;
/** After looking, ignore what our own git commands stirred up inside .git for this long. */
const QUIET_MS = 600;

export interface Watcher {
  url: string;
  close(): void;
}

/** A change to this path is worth another look at the repository. */
export function matters(file: string): boolean {
  const name = file.split("\\").join("/");
  if (name.split("/").includes("node_modules")) return false;
  // Inside .git only the things a commit, a checkout or a `git add` touch.
  if (name === ".git" || name.startsWith(".git/")) return /^\.git\/(HEAD|index|refs\/|ORIG_HEAD)/.test(name) && !name.endsWith(".lock");
  return true;
}

/** What makes two towns the same town: everything but the moment they were looked at. */
const fingerprint = (city: City) => JSON.stringify({ ...city, at: 0, files: city.files.map((file) => ({ ...file, modified: file.dirty ? 0 : file.modified })) });

export function watchCity(dir: string, options: { port: number; land: Land | null; log?: (line: string) => void }): Promise<Watcher> {
  const say = options.log ?? (() => {});
  let memory: Memory | undefined;
  let city: City;
  let print = "";
  const listeners = new Set<ServerResponse>();
  let lookTook = 0;

  const look = (): boolean => {
    const started = Date.now();
    const next = buildCity(dir, { land: options.land, live: true }, memory);
    memory = next.memory;
    const now = fingerprint(next.city);
    const changed = now !== print;
    city = next.city;
    print = now;
    lookTook = Date.now() - started;
    return changed;
  };

  look();

  let timer: NodeJS.Timeout | null = null;
  let quietUntil = 0;
  const lookSoon = () => {
    if (timer) clearTimeout(timer);
    // A big repository takes seconds to read; do not start again the moment we finish.
    timer = setTimeout(() => {
      timer = null;
      let changed = false;
      try {
        changed = look();
      } catch (error) {
        say(`could not read the repository: ${(error as Error).message.split("\n")[0]}`);
      }
      quietUntil = Date.now() + QUIET_MS;
      if (!changed) return;
      const message = `event: city\ndata: ${JSON.stringify(city)}\n\n`;
      for (const listener of listeners) listener.write(message);
    }, Math.max(SETTLE_MS, lookTook * 2));
  };

  const watcher = watch(city!.root, { recursive: true }, (_event, file) => {
    if (!file || !matters(file)) return;
    if (file.startsWith(".git") && Date.now() < quietUntil) return;
    lookSoon();
  });

  const server = http.createServer((request, response) => {
    const url = (request.url ?? "/").split("?")[0];
    if (url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(page(city));
    } else if (url === "/copy") {
      // Save a copy: this town as it is now, as one file that needs nothing running, opening on the view it was saved from.
      const view = new URL(request.url ?? "/", "http://localhost").searchParams.get("view")?.slice(0, 2000) ?? undefined;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="${city!.name.replace(/[^\w.-]+/g, "-")}-codecity.html"`,
        "cache-control": "no-store",
      });
      response.end(page({ ...city!, live: false, view }));
    } else if (url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      response.write("retry: 2000\n\n");
      listeners.add(response);
      request.on("close", () => listeners.delete(response));
    } else {
      response.writeHead(404).end();
    }
  });
  // A connection with nothing on it gets dropped by some browsers; a comment now and then keeps it.
  const heartbeat = setInterval(() => {
    for (const listener of listeners) listener.write(": still here\n\n");
  }, 25_000);

  return new Promise((resolve, reject) => {
    let port = options.port;
    const tries = port + 20;
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && port < tries) server.listen(++port, "127.0.0.1");
      else reject(error);
    });
    server.on("listening", () =>
      resolve({
        url: `http://localhost:${port}`,
        close() {
          clearInterval(heartbeat);
          if (timer) clearTimeout(timer);
          watcher.close();
          for (const listener of listeners) listener.end();
          server.close();
        },
      }),
    );
    server.listen(port, "127.0.0.1");
  });
}
