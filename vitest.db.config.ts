import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// The database harness (intelligence I-17): `npm run test:db` only.
//
// A real PostgreSQL 16 is started for the run under a scratch directory,
// supabase/schema.sql and every numbered migration are replayed onto a
// Supabase stand-in, and the suites under lib/__tests__/rls/ run against it
// (row-level security per role at runtime, the fresh-install replay, the
// SECURITY DEFINER grant census). The cluster is deleted afterwards. With no
// PostgreSQL on the machine the run prints one line naming the missing binary
// and the suites skip. The default `npx vitest run` (vitest.config.ts) never
// includes these files.

export default defineConfig({
  test: {
    include: ["lib/__tests__/rls/**/*.test.ts"],
    environment: "node",
    globals: false,
    setupFiles: ["./lib/__tests__/setup.ts"],
    globalSetup: ["./lib/__tests__/rls/globalSetup.ts"],
    // One shared cluster: files run one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 600_000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
});
