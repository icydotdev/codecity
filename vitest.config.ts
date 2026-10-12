import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is the page: the tests are of everything but the page.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
