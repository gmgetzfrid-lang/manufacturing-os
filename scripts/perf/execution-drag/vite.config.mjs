// PERF-5 harness: bundles main.tsx with the app's own code (the `@/` alias)
// and the stubs for lib/supabase and next/*. PERF_APP_ROOT points `@/` at
// another checkout (the board before a change); PERF_OUT names the output.
import { defineConfig } from "vite";
import { resolve } from "node:path";

const here = import.meta.dirname;
const app = resolve(process.env.PERF_APP_ROOT || resolve(here, "../../.."));
const stubs = resolve(here, "stubs");

export default defineConfig({
  root: here,
  logLevel: "warn",
  define: { "process.env": "{}" },
  resolve: {
    alias: [
      { find: /^@\/lib\/supabase$/, replacement: `${stubs}/supabase.ts` },
      { find: /^next\/dynamic$/, replacement: `${stubs}/dynamic.tsx` },
      { find: /^next\/link$/, replacement: `${stubs}/link.tsx` },
      { find: /^next\/navigation$/, replacement: `${stubs}/navigation.ts` },
      { find: /^@\//, replacement: `${app}/` },
    ],
    dedupe: ["react", "react-dom"],
  },
  build: { outDir: resolve(here, process.env.PERF_OUT || "dist"), emptyOutDir: true, minify: true, sourcemap: false },
});
