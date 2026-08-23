import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Vitest config tuned for the pure-function tests under lib/.
// Tests are explicitly scoped to lib/__tests__ so we don't pull
// React component files (which need a browser-ish environment)
// into the default run. Adding component / integration tests in
// the future can extend `include` here.

export default defineConfig({
  test: {
    // lib/__tests__ holds the original pure-function suites; lib/**/__tests__
    // picks up module-local suites such as the reconstruction maths, which is
    // kept beside the code it verifies.
    include: ["lib/__tests__/**/*.test.ts", "lib/**/__tests__/**/*.test.ts"],
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
