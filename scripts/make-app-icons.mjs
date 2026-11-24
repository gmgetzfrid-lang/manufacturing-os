// Renders the app logo's PNGs from public/icon.svg (the one source):
// the install icons (public/icon-192.png, icon-512.png) and the iPhone
// home-screen icon (app/apple-icon.png). Run after changing the logo:
//   node scripts/make-app-icons.mjs
import sharp from "sharp";
import { readFileSync } from "node:fs";

const svg = readFileSync(new URL("../public/icon.svg", import.meta.url));
const out = [
  ["../public/icon-192.png", 192],
  ["../public/icon-512.png", 512],
  ["../app/apple-icon.png", 180],
];
for (const [path, size] of out) {
  await sharp(svg, { density: 72 * (size / 1024) * 4 }).resize(size, size).png({ compressionLevel: 9 }).toFile(new URL(path, import.meta.url).pathname);
  console.log(path, size);
}
