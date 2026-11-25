// Squares up and cleans a photographed page. Pure TypeScript on raw RGBA
// pixels (no DOM), written for a phone: typed arrays, the math inlined in
// the pixel loops, nothing allocated per pixel.

import { type Quad, homography } from "./geometry";

export type ImageDataLike = { data: Uint8ClampedArray; width: number; height: number };

/** The quad's contents stretched onto a flat w x h image. Each output
 *  pixel is mapped back into the photo and read with bilinear sampling. */
export function warp(img: ImageDataLike, quad: Quad, w: number, h: number): ImageDataLike {
  const rect: Quad = [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }];
  const [a, b, c, d, e, f, g, hh, k] = homography(rect, quad);
  const src = img.data;
  const SW = img.width;
  const maxX = img.width - 1;
  const maxY = img.height - 1;
  const out = new Uint8ClampedArray(w * h * 4);
  let o = 0;
  for (let y = 0; y < h; y++) {
    // Along a row the map's top and bottom terms only grow by a constant,
    // so step them instead of multiplying for every pixel.
    let X = b * y + c;
    let Y = e * y + f;
    let Z = hh * y + k;
    for (let x = 0; x < w; x++, X += a, Y += d, Z += g, o += 4) {
      let sx = X / Z;
      let sy = Y / Z;
      if (!(sx >= 0)) sx = 0; else if (sx > maxX) sx = maxX; // !(>=) also catches NaN
      if (!(sy >= 0)) sy = 0; else if (sy > maxY) sy = maxY;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const dx = x0 < maxX ? 4 : 0;
      const dy = y0 < maxY ? SW * 4 : 0;
      const p = (y0 * SW + x0) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      out[o] = src[p] * w00 + src[p + dx] * w10 + src[p + dy] * w01 + src[p + dx + dy] * w11;
      out[o + 1] = src[p + 1] * w00 + src[p + dx + 1] * w10 + src[p + dy + 1] * w01 + src[p + dx + dy + 1] * w11;
      out[o + 2] = src[p + 2] * w00 + src[p + dx + 2] * w10 + src[p + dy + 2] * w01 + src[p + dx + dy + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Black and white for forms: shadows and uneven light flattened out,
 *  paper pure white, ink dark. It stays grayscale (not hard 1-bit) so
 *  light pencil and handwriting keep their shape. */
export function toDocument(img: ImageDataLike): ImageDataLike {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const gray = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;

  const bg = paperLevel(gray, w, h);

  // Gray over the paper's own local brightness: 1.0 is paper, wherever the
  // shadow falls; ink is well under. Kept as ratio x 200 in a byte.
  const RATIO = 200;
  const ratio = new Uint8Array(n);
  const hist = new Uint32Array(256);
  const { grid, gw, gh, f } = bg;
  const gx0 = new Int32Array(w), gx1 = new Int32Array(w), gfx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const gx = Math.min(gw - 1, Math.max(0, (x + 0.5) / f - 0.5));
    gx0[x] = gx | 0;
    gx1[x] = Math.min(gw - 1, gx0[x] + 1);
    gfx[x] = gx - gx0[x];
  }
  for (let y = 0, i = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const r0 = (gy | 0) * gw;
    const r1 = Math.min(gh - 1, (gy | 0) + 1) * gw;
    const fy = gy - (gy | 0);
    for (let x = 0; x < w; x++, i++) {
      const top = grid[r0 + gx0[x]] + (grid[r0 + gx1[x]] - grid[r0 + gx0[x]]) * gfx[x];
      const bot = grid[r1 + gx0[x]] + (grid[r1 + gx1[x]] - grid[r1 + gx0[x]]) * gfx[x];
      const level = top + (bot - top) * fy;
      const q = Math.round((gray[i] / (level > 8 ? level : 8)) * RATIO);
      const v = q > 255 ? 255 : q;
      ratio[i] = v;
      hist[v]++;
    }
  }

  // Black point from the darkest 1% (the ink), kept within sane bounds so
  // a nearly blank page doesn't turn its paper grain into black specks.
  // White point a little under paper: faint grain and JPEG noise go white.
  let black = percentile(hist, n, 0.01) / RATIO;
  black = Math.min(0.55, Math.max(0.15, black));
  const white = 0.9;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const t = (v / RATIO - black) / (white - black);
    const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
    // A gentle curve darkens the middle tones so pen strokes read bolder.
    lut[v] = Math.round(255 * Math.pow(c, 1.35));
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = lut[ratio[i]];
    out[p] = v;
    out[p + 1] = v;
    out[p + 2] = v;
    out[p + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

/** Color kept for photos: gray-world white balance (the page averages to
 *  neutral, which undoes a yellow work light) and a mild contrast stretch. */
export function toColor(img: ImageDataLike): ImageDataLike {
  const { data, width: w, height: h } = img;
  const n = w * h;
  // Every 4th pixel is plenty for averages and percentiles.
  let sr = 0, sg = 0, sb = 0;
  for (let p = 0; p < data.length; p += 16) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const l = (r * 77 + g * 150 + b * 29) >> 8;
    if (l < 24 || l > 250) continue; // ink and blown highlights say nothing about the light
    sr += r; sg += g; sb += b;
  }
  let kr = 1, kg = 1, kb = 1;
  if (sr > 0 && sg > 0 && sb > 0) {
    const m = (sr + sg + sb) / 3;
    // Capped, so a page that really is colored doesn't swing too far.
    kr = Math.min(1.4, Math.max(0.7, m / sr));
    kg = Math.min(1.4, Math.max(0.7, m / sg));
    kb = Math.min(1.4, Math.max(0.7, m / sb));
  }

  const hist = new Uint32Array(256);
  let count = 0;
  for (let p = 0; p < data.length; p += 16) {
    const l = Math.round(0.299 * data[p] * kr + 0.587 * data[p + 1] * kg + 0.114 * data[p + 2] * kb);
    hist[l > 255 ? 255 : l]++;
    count++;
  }
  let lo = Math.min(48, percentile(hist, count, 0.005));
  let hi = Math.max(170, percentile(hist, count, 0.995));
  if (hi - lo < 32) { lo = 0; hi = 255; }
  const span = 255 / (hi - lo);

  const lr = new Uint8ClampedArray(256), lg = new Uint8ClampedArray(256), lb = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lr[v] = (v * kr - lo) * span;
    lg[v] = (v * kg - lo) * span;
    lb[v] = (v * kb - lo) * span;
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < out.length; p += 4) {
    out[p] = lr[data[p]];
    out[p + 1] = lg[data[p + 1]];
    out[p + 2] = lb[data[p + 2]];
    out[p + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

// ── the paper's local brightness ────────────────────────────────────

/** How bright the bare paper is around each spot, on a coarse grid (the
 *  light changes slowly, so ~400 px across is plenty and keeps memory low
 *  on a phone). A box mean over a window about 1/16 of the page wide,
 *  from integral images, taken twice: the second time only over cells
 *  that look like paper, so dense writing doesn't drag the level down
 *  and wash itself out. */
function paperLevel(gray: Uint8Array, w: number, h: number): { grid: Float32Array; gw: number; gh: number; f: number } {
  const f = Math.max(1, Math.floor(Math.min(w, h) / 400));
  const gw = Math.ceil(w / f);
  const gh = Math.ceil(h / f);
  const cells = new Float32Array(gw * gh);
  // The brightest pixel of each cell: thin pen strokes vanish here.
  for (let gy = 0; gy < gh; gy++) {
    const y1 = Math.min(h, (gy + 1) * f);
    for (let gx = 0; gx < gw; gx++) {
      const x1 = Math.min(w, (gx + 1) * f);
      let m = 0;
      for (let y = gy * f; y < y1; y++) {
        for (let x = gx * f, i = y * w + x; x < x1; x++, i++) if (gray[i] > m) m = gray[i];
      }
      cells[gy * gw + gx] = m;
    }
  }

  const r = Math.max(2, Math.round(w / 16 / f / 2));
  const hist = new Uint32Array(256);
  for (let i = 0; i < cells.length; i++) hist[cells[i]]++;
  const global = Math.max(16, percentile(hist, cells.length, 0.9));

  const ones = new Float32Array(cells.length).fill(1);
  const mean1 = windowMean(cells, ones, gw, gh, r);
  const keep = new Float32Array(cells.length);
  for (let i = 0; i < cells.length; i++) keep[i] = cells[i] >= 0.85 * mean1[i] && cells[i] >= 0.4 * global ? 1 : 0;

  const level = windowMean(cells, keep, gw, gh, r);
  // A dark block bigger than the window has no paper in reach: look wider,
  // then fall back to the page's usual paper level.
  let holes = false;
  for (let i = 0; i < level.length; i++) if (Number.isNaN(level[i])) { holes = true; break; }
  if (holes) {
    const wide = windowMean(cells, keep, gw, gh, r * 4);
    for (let i = 0; i < level.length; i++) {
      if (Number.isNaN(level[i])) level[i] = Number.isNaN(wide[i]) ? global : wide[i];
    }
  }
  // Smooth the small steps where the paper mask switches on and off.
  const grid = windowMean(level, ones, gw, gh, Math.max(1, r >> 1));
  return { grid, gw, gh, f };
}

/** Weighted box mean over a (2r+1) square window, clipped at the edges,
 *  from two integral images. NaN where the window has no weight. */
function windowMean(v: Float32Array, wt: Float32Array, w: number, h: number, r: number): Float32Array {
  const W1 = w + 1;
  const sv = new Float64Array(W1 * (h + 1));
  const sw = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rv = 0, rw = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      rv += v[i] * wt[i];
      rw += wt[i];
      const j = (y + 1) * W1 + x + 1;
      sv[j] = sv[j - W1] + rv;
      sw[j] = sw[j - W1] + rw;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r) * W1;
    const y1 = Math.min(h, y + r + 1) * W1;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const tw = sw[y1 + x1] - sw[y0 + x1] - sw[y1 + x0] + sw[y0 + x0];
      const tv = sv[y1 + x1] - sv[y0 + x1] - sv[y1 + x0] + sv[y0 + x0];
      out[y * w + x] = tw > 0.5 ? tv / tw : NaN;
    }
  }
  return out;
}

/** The value below which `share` of the counted values fall. */
function percentile(hist: Uint32Array, total: number, share: number): number {
  const target = total * share;
  let run = 0;
  for (let v = 0; v < hist.length; v++) {
    run += hist[v];
    if (run > target) return v;
  }
  return hist.length - 1;
}
