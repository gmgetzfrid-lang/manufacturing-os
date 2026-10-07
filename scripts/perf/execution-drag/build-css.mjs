// PERF-5 harness: the app's stylesheet for the bundle — app/globals.css
// through the app's own PostCSS plugin (@tailwindcss/postcss, as
// postcss.config.mjs), with the checkout as Tailwind's source base, written
// to public/app.css (vite copies it next to index.html). See README.md.
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const here = import.meta.dirname;
const root = path.resolve(here, "../../..");
const from = path.join(root, "app", "globals.css");
const result = await postcss([tailwind({ base: root })]).process(fs.readFileSync(from, "utf8"), { from });
fs.mkdirSync(path.join(here, "public"), { recursive: true });
fs.writeFileSync(path.join(here, "public", "app.css"), result.css);
console.log(`public/app.css: ${result.css.length} bytes`);
