import { configDefaults, defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Vitest config tuned for the pure-function tests under lib/.
// Tests are explicitly scoped to lib/__tests__ so we don't pull
// React component files (which need a browser-ish environment)
// into the default run. Adding component / integration tests in
// the future can extend `include` here.

export default defineConfig({
  test: {
    include: ["lib/__tests__/**/*.test.ts"],
    // lib/__tests__/rls/ needs a real PostgreSQL: it runs only under
    // `npm run test:db` (vitest.db.config.ts), never in the default suite.
    exclude: [...configDefaults.exclude, "lib/__tests__/rls/**"],
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
