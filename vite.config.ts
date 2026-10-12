import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The page is one file with everything in it, three.js included, so a map can be
// opened from disk, sent to someone, or looked at on a machine with no network.
export default defineConfig({
  root: "src/client",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
