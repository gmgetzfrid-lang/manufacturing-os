import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Vitest config tuned for the pure-function tests under lib/.
// Tests are explicitly scoped to lib/__tests__ so we don't pull
// React component files (which need a browser-ish environment)
// into the default run. Adding component / integration tests in
// the future can extend `include` here.

export default defineConfig({
  test: {
    include: ["lib/__tests__/**/*.test.ts"],
    environment: "node",
    globals: false,
    setupFiles: ["./lib/__tests__/setup.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
});
