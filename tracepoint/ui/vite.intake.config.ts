import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Scan Intake's window: one self-contained intake.html embedded in
// ScanIntake.exe. The dev server proxies to intake-dev.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: { target: "es2022", outDir: "dist-intake", emptyOutDir: true, assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 5000, rollupOptions: { input: "intake.html" } },
  server: { port: 5174, open: "/intake.html", proxy: { "/api": "http://127.0.0.1:7979", "/page": "http://127.0.0.1:7979", "/events": "http://127.0.0.1:7979" } },
});
