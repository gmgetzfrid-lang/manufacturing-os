// Finds the sheet of paper in a photo: the biggest bright, colorless patch,
// reduced to its four corners. Pure TypeScript on raw pixels (no OpenCV,
// no DOM), so it runs the same in tests and on a phone.
//
// Steps, on a copy shrunk to 400 px (fast, and the shrink itself smooths
// out print and paper grain):
//   1. "paperness" per pixel: brightness minus a share of color, so white
//      paper stands out from a tan desk or a yellow hard hat
//   2. 5x5 blur, then Otsu's threshold splits paper from background
//   3. the largest connected bright patch is the page
//   4. its convex hull, then the hull's 4 points that enclose the most area
//   5. straight lines fitted along each side, crossed to place the corners
//      (a dog-eared or rounded corner doesn't pull the corner inward)

import { type Pt, type Quad, dist, isConvex, orderQuad, polygonArea } from "./geometry";
import type { ImageDataLike } from "./enhance";

/** Long side of the working copy, in px. */
const WORK_SIDE = 400;

export function findPage(img: ImageDataLike): { quad: Quad; confident: boolean } {
  const W = img.width;
  const H = img.height;
  const fallback = { quad: insetRect(W, H, 0.06), confident: false };
  if (W < 16 || H < 16) return fallback;

  const s = Math.max(1, Math.max(W, H) / WORK_SIDE);
  const w = Math.max(1, Math.round(W / s));
  const h = Math.max(1, Math.round(H / s));

  const soft = blur5(paperness(img, w, h), w, h);
  const t = otsu(soft);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = soft[i] > t ? 1 : 0;
  // Bridge thin dark rules (a form's table lines) so they can't cut the
  // page into separate patches.
  closeMask(mask, w, h);

  const edge = pageEdge(mask, w, h);
  if (!edge) return fallback;
  const hull = convexHull(edge.sides);
  if (hull.length < 4) return fallback;
  const rough = cornersOf(hull);
  if (!rough) return fallback;
  const small = refineByLines(rough, edge.all) ?? rough;

  // Back to full size: centers of small pixels to centers of full ones.
  const sx = W / w;
  const sy = H / h;
  const quad = orderQuad(small.map((p) => ({
    x: clamp((p.x + 0.5) * sx - 0.5, 0, W - 1),
    y: clamp((p.y + 0.5) * sy - 0.5, 0, H - 1),
  })));
  const share = polygonArea(quad) / (W * H);
  const confident = share >= 0.2 && share <= 0.98 && isConvex(quad);
  return confident ? { quad, confident } : fallback;
}

/** A rectangle `m` (a share of each side) in from the photo's edges. */
export function insetRect(W: number, H: number, m: number): Quad {
  const x0 = (W - 1) * m, x1 = (W - 1) * (1 - m);
  const y0 = (H - 1) * m, y1 = (H - 1) * (1 - m);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

// ── 1. shrink and score each pixel ──────────────────────────────────

/** Box-average shrink to w x h, scoring each pixel as gray minus half its
 *  color spread (max - min channel). Paper is bright and colorless. */
function paperness(img: ImageDataLike, w: number, h: number): Float32Array {
  const { data, width: W, height: H } = img;
  const out = new Float32Array(w * h);
  for (let oy = 0; oy < h; oy++) {
    const y0 = Math.floor((oy * H) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * H) / h));
    for (let ox = 0; ox < w; ox++) {
      const x0 = Math.floor((ox * W) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * W) / w));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        let p = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, p += 4) {
          const r = data[p], g = data[p + 1], b = data[p + 2];
          const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
          const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
          sum += 0.299 * r + 0.587 * g + 0.114 * b - 0.5 * (mx - mn);
        }
      }
      out[oy * w + ox] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** 5x5 box blur (two 5-tap passes), edges repeated. */
function blur5(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += src[row + clamp(x + k, 0, w - 1)];
      tmp[row + x] = s / 5;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += tmp[clamp(y + k, 0, h - 1) * w + x];
      out[y * w + x] = s / 5;
    }
  }
  return out;
}

// ── 2. split paper from background ──────────────────────────────────

/** Otsu's threshold: the cut that best separates two groups of values. */
function otsu(v: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < v.length; i++) hist[clamp(Math.round(v[i]), 0, 255)]++;
  const total = v.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = -1, cut = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; cut = t; }
  }
  return cut;
}

/** Morphological close (grow then shrink by 1 px). Past the image edge
 *  counts as the pixel itself, so a page running off the photo keeps its
 *  edge. */
function closeMask(m: Uint8Array, w: number, h: number) {
  const tmp = new Uint8Array(m.length);
  pass3(m, tmp, w, h, true, true);
  pass3(tmp, m, w, h, false, true);
  pass3(m, tmp, w, h, true, false);
  pass3(tmp, m, w, h, false, false);
}

function pass3(src: Uint8Array, dst: Uint8Array, w: number, h: number, across: boolean, grow: boolean) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const b = src[i];
      const a = across ? (x > 0 ? src[i - 1] : b) : y > 0 ? src[i - w] : b;
      const c = across ? (x < w - 1 ? src[i + 1] : b) : y < h - 1 ? src[i + w] : b;
      dst[i] = grow ? a | b | c : a & b & c;
    }
  }
}

// ── 3. the page patch and its edge ──────────────────────────────────

/** The largest 4-connected bright patch, as its edge points: `sides` (the
 *  leftmost and rightmost pixel of each row, enough for the hull) and
 *  `all` (those plus the top and bottom pixel of each column, for fitting
 *  the top and bottom sides). Null when there is no real patch. */
function pageEdge(mask: Uint8Array, w: number, h: number): { sides: Pt[]; all: Pt[] } | null {
  const n = w * h;
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  let next = 0, best = 0, bestArea = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i] || labels[i]) continue;
    next++;
    let sp = 0, area = 0;
    labels[i] = next;
    stack[sp++] = i;
    while (sp > 0) {
      const j = stack[--sp];
      area++;
      const x = j % w;
      if (x > 0 && mask[j - 1] && !labels[j - 1]) { labels[j - 1] = next; stack[sp++] = j - 1; }
      if (x < w - 1 && mask[j + 1] && !labels[j + 1]) { labels[j + 1] = next; stack[sp++] = j + 1; }
      if (j >= w && mask[j - w] && !labels[j - w]) { labels[j - w] = next; stack[sp++] = j - w; }
      if (j < n - w && mask[j + w] && !labels[j + w]) { labels[j + w] = next; stack[sp++] = j + w; }
    }
    if (area > bestArea) { bestArea = area; best = next; }
  }
  // Under 5% of the photo is a reflection or a scrap, not the page.
  if (!best || bestArea < n * 0.05) return null;

  const sides: Pt[] = [];
  for (let y = 0; y < h; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] === best) { if (lo < 0) lo = x; hi = x; }
    }
    if (lo >= 0) { sides.push({ x: lo, y }); if (hi !== lo) sides.push({ x: hi, y }); }
  }
  const all = sides.slice();
  for (let x = 0; x < w; x++) {
    let lo = -1, hi = -1;
    for (let y = 0; y < h; y++) {
      if (labels[y * w + x] === best) { if (lo < 0) lo = y; hi = y; }
    }
    if (lo >= 0) { all.push({ x, y: lo }); if (hi !== lo) all.push({ x, y: hi }); }
  }
  return { sides, all };
}

// ── 4. hull and corners ─────────────────────────────────────────────

/** Convex hull, Andrew's monotone chain. Drops points on a straight run. */
function convexHull(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Four hull points: first the ones furthest toward each corner of the
 *  photo, then each moved, one at a time, to whichever hull point makes
 *  the quad biggest while it stays convex. A page is the biggest
 *  four-sided shape inside its own outline, so bumps (a thumb, a clip)
 *  lose to the real corners. */
function cornersOf(hull: Pt[]): Quad | null {
  let tl = 0, tr = 0, br = 0, bl = 0;
  for (let i = 1; i < hull.length; i++) {
    const p = hull[i];
    if (p.x + p.y < hull[tl].x + hull[tl].y) tl = i;
    if (p.x + p.y > hull[br].x + hull[br].y) br = i;
    if (p.x - p.y > hull[tr].x - hull[tr].y) tr = i;
    if (p.x - p.y < hull[bl].x - hull[bl].y) bl = i;
  }
  let idx = [tl, tr, br, bl];
  const quadOf = (ix: number[]) => ix.map((i) => hull[i]) as Quad;
  let area = polygonArea(quadOf(idx));
  for (let round = 0; round < 10; round++) {
    let grew = false;
    for (let k = 0; k < 4; k++) {
      for (let j = 0; j < hull.length; j++) {
        if (idx.includes(j)) continue;
        const trial = idx.slice();
        trial[k] = j;
        const q = quadOf(trial);
        const a = polygonArea(q);
        if (a > area + 1e-9 && isConvex(q)) { idx = trial; area = a; grew = true; }
      }
    }
    if (!grew) break;
  }
  const q = quadOf(idx);
  return isConvex(q) ? q : null;
}

// ── 5. fit the sides ────────────────────────────────────────────────

type Line = { cx: number; cy: number; dx: number; dy: number };

/** Fits a straight line to the edge points along the middle of each side
 *  and crosses neighbouring lines for the corners. Null (keep the rough
 *  corners) when a side has too few points or a corner would jump. */
function refineByLines(q: Quad, pts: Pt[]): Quad | null {
  const lines: Line[] = [];
  let perimeter = 0;
  for (let k = 0; k < 4; k++) {
    const a = q[k];
    const b = q[(k + 1) % 4];
    const len = dist(a, b);
    if (len < 8) return null;
    perimeter += len;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const tol = Math.max(1.5, len * 0.02);
    const near: Pt[] = [];
    for (const p of pts) {
      const dx = p.x - a.x, dy = p.y - a.y;
      const t = (dx * ux + dy * uy) / len;
      if (t < 0.12 || t > 0.88) continue; // keep clear of the corners
      if (Math.abs(dx * uy - dy * ux) <= tol) near.push(p);
    }
    lines.push(near.length >= 6 ? fitLine(near) : { cx: a.x, cy: a.y, dx: ux, dy: uy });
  }
  const maxShift = Math.max(3, (perimeter / 4) * 0.04);
  const out: Pt[] = [];
  for (let k = 0; k < 4; k++) {
    // Corner k sits where the side coming in (k-1 to k) meets the side going out (k to k+1).
    const p = intersect(lines[(k + 3) % 4], lines[k]);
    if (!p || dist(p, q[k]) > maxShift) return null;
    out.push(p);
  }
  const r = out as Quad;
  return isConvex(r) ? r : null;
}

/** Least-squares line (principal direction through the middle). */
function fitLine(pts: Pt[]): Line {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { cx, cy, dx: Math.cos(angle), dy: Math.sin(angle) };
}

function intersect(a: Line, b: Line): Pt | null {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.cx - a.cx) * b.dy - (b.cy - a.cy) * b.dx) / den;
  return { x: a.cx + t * a.dx, y: a.cy + t * a.dy };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
