import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained index.html (scripts, styles, fonts inlined) that the
// Windows exe embeds. The dev server proxies /api and /file to tpserve.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: { target: "es2022", assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 5000 },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:7878", "/file": "http://127.0.0.1:7878", "/asset": "http://127.0.0.1:7878", "/events": "http://127.0.0.1:7878" } },
});
