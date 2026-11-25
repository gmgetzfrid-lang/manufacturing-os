// Geometry for the document scanner: a page's four corners and the
// perspective map (homography) that squares it up. Pure math, no DOM, so
// it runs in tests and anywhere in the browser.

export type Pt = { x: number; y: number };
/** Top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

/** US letter, short side over long side. */
export const LETTER_RATIO = 8.5 / 11;

/** The 3x3 map (row-major, h[8] = 1) that sends each src corner to the
 *  matching dst corner. Throws when the corners can't make a map (three in
 *  a line, two on top of each other). */
export function homography(src: Quad, dst: Quad): number[] {
  // Pixel coordinates run into the thousands, which makes the raw 8x8
  // system badly conditioned. Centering and scaling both sides first
  // (Hartley) keeps the answer accurate to well under a millionth.
  const ts = normalizer(src);
  const td = normalizer(dst);
  const s = src.map((p) => applyH(ts, p));
  const d = dst.map((p) => applyH(td, p));

  // Two equations per corner pair; unknowns h0..h7 with h8 = 1.
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = s[i];
    const { x: u, y: v } = d[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  const hn = [...solve(A), 1];

  // Undo the normalizing: H = Td^-1 * Hn * Ts, then scale so h8 = 1.
  const h = mul3(invertSimilarity(td), mul3(hn, ts));
  const k = h[8];
  if (Math.abs(k) < 1e-15) throw new Error("Degenerate corners");
  return h.map((v) => v / k);
}

/** Where the map sends a point. */
export function applyH(h: number[], p: Pt): Pt {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

/** Four points in any order, as top-left, top-right, bottom-right,
 *  bottom-left. Sorting by angle around the middle keeps the order right
 *  even for a page turned near 45 degrees, where the plain sum and
 *  difference picks can land on the same point twice; the smallest x + y
 *  then says which one is top-left. */
export function orderQuad(pts: Pt[]): Quad {
  if (pts.length !== 4) throw new Error("orderQuad needs 4 points");
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  // Screen y points down, so a rising angle walks clockwise on screen:
  // top-left, top-right, bottom-right, bottom-left.
  const byAngle = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  for (let i = 1; i < 4; i++) {
    if (byAngle[i].x + byAngle[i].y < byAngle[first].x + byAngle[first].y) first = i;
  }
  const out: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const p = byAngle[(first + i) % 4];
    out.push({ x: p.x, y: p.y });
  }
  return out as Quad;
}

/** The squared-up page size: the quad's average side lengths, scaled so
 *  the long side is `longSide` px. Within 6% of US letter it snaps to
 *  letter, since most site forms are letter and a photo's slant skews the
 *  measured shape a little. */
export function outputSize(q: Quad, longSide = 2200): { w: number; h: number } {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  if (!(w > 0 && h > 0)) return { w: Math.round(longSide * LETTER_RATIO), h: longSide };
  let ratio = Math.min(w, h) / Math.max(w, h);
  if (Math.abs(ratio - LETTER_RATIO) / LETTER_RATIO <= 0.06) ratio = LETTER_RATIO;
  const short = Math.max(1, Math.round(longSide * ratio));
  return w > h ? { w: longSide, h: short } : { w: short, h: longSide };
}

/** The quad pulled in toward its middle by `share` of each corner's
 *  distance. A scan trims a hair off the edge this way, so a corner placed
 *  a pixel outside the paper doesn't leave a dark line of desk. */
export function insetQuad(q: Quad, share: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => ({ x: p.x + (cx - p.x) * share, y: p.y + (cy - p.y) * share })) as Quad;
}

/** Area of a polygon (shoelace), always positive. */
export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** True when the four corners make a proper convex shape (no crossed or
 *  dented sides), which a photographed page always is. */
export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── helpers ──────────────────────────────────────────────────────────

/** Gaussian elimination with partial pivoting on an n x (n+1) system. */
function solve(A: number[][]): number[] {
  const n = A.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) throw new Error("Degenerate corners");
    if (p !== c) [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r][n];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** A shift and scale that puts the points' middle at 0 and their average
 *  distance from it at sqrt(2). */
function normalizer(pts: Pt[]): number[] {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - cx, p.y - cy);
  d /= pts.length;
  const s = d > 0 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

function invertSimilarity(t: number[]): number[] {
  const s = t[0];
  return [1 / s, 0, -t[2] / s, 0, 1 / s, -t[5] / s, 0, 0, 1];
}

function mul3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}
