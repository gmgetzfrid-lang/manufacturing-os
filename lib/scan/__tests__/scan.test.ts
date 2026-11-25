import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { applyH, homography, insetQuad, orderQuad, outputSize, type Pt, type Quad } from "../geometry";
import { findPage } from "../detect";
import { type ImageDataLike, toColor, toDocument, warp } from "../enhance";
import { pagesToPdf } from "../toPdf";

/** An RGBA image painted by a function of (x, y). */
function paint(w: number, h: number, fn: (x: number, y: number) => [number, number, number]): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const p = (y * w + x) * 4;
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** Repeatable noise, so a failure can be rerun. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const near = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

describe("geometry", () => {
  it("homography sends each source corner to its target corner", () => {
    const src: Quad = [{ x: 0, y: 0 }, { x: 1699, y: 0 }, { x: 1699, y: 2199 }, { x: 0, y: 2199 }];
    const dst: Quad = [{ x: 312.5, y: 180.25 }, { x: 2210, y: 240 }, { x: 2390.75, y: 1820 }, { x: 140, y: 1760.5 }];
    const h = homography(src, dst);
    expect(h).toHaveLength(9);
    expect(h[8]).toBe(1);
    for (let i = 0; i < 4; i++) {
      const p = applyH(h, src[i]);
      expect(Math.abs(p.x - dst[i].x)).toBeLessThan(1e-6);
      expect(Math.abs(p.y - dst[i].y)).toBeLessThan(1e-6);
    }
  });

  it("orderQuad puts shuffled corners in TL, TR, BR, BL order", () => {
    const want: Quad = [{ x: 100, y: 80 }, { x: 500, y: 120 }, { x: 470, y: 700 }, { x: 60, y: 650 }];
    for (const order of [[2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]]) {
      expect(orderQuad(order.map((i) => want[i]))).toEqual(want);
    }
    // A diamond (a page turned 45 degrees) still gets four different corners.
    const diamond = orderQuad([{ x: 300, y: 100 }, { x: 500, y: 300 }, { x: 300, y: 500 }, { x: 100, y: 300 }]);
    expect(new Set(diamond.map((p) => `${p.x},${p.y}`)).size).toBe(4);
  });

  it("insetQuad pulls each corner toward the middle", () => {
    const q = insetQuad([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }, { x: 0, y: 200 }], 0.1);
    expect(q[0]).toEqual({ x: 5, y: 10 });
    expect(q[2]).toEqual({ x: 95, y: 190 });
  });

  it("outputSize snaps a near-letter page to letter", () => {
    const q: Quad = [{ x: 0, y: 0 }, { x: 830, y: 0 }, { x: 830, y: 1100 }, { x: 0, y: 1100 }];
    expect(outputSize(q)).toEqual({ w: 1700, h: 2200 });
    const wide: Quad = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 500 }, { x: 0, y: 500 }];
    expect(outputSize(wide, 1000)).toEqual({ w: 1000, h: 500 });
  });
});

describe("findPage", () => {
  // A 600 x 800 photo: dark desk (~40), a white page (~235) turned 12
  // degrees, with lines of dark "text" on it.
  const W = 600, H = 800;
  const cx = 300, cy = 410, pw = 400, ph = 520;
  const a = (12 * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const corner = (u: number, v: number): Pt => ({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos });
  const truth: Quad = [corner(-pw / 2, -ph / 2), corner(pw / 2, -ph / 2), corner(pw / 2, ph / 2), corner(-pw / 2, ph / 2)];

  it("finds a turned page's corners on a dark desk", () => {
    const rand = rng(7);
    const img = paint(W, H, (x, y) => {
      // Into the page's own (u, v) by turning back.
      const dx = x - cx, dy = y - cy;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      const n = Math.round((rand() - 0.5) * 10);
      if (Math.abs(u) > pw / 2 || Math.abs(v) > ph / 2) return [40 + n, 40 + n, 42 + n];
      const inText = Math.abs(u) < pw / 2 - 40 && v > -ph / 2 + 40 && v < ph / 2 - 40 && ((v + ph) % 28) < 5;
      const g = inText ? 30 + n : 235 + n;
      return [g, g, g];
    });
    const { quad, confident } = findPage(img);
    expect(confident).toBe(true);
    const diag = Math.hypot(W, H);
    for (let i = 0; i < 4; i++) expect(near(quad[i], truth[i])).toBeLessThan(diag * 0.03);
  });

  it("is not confident on a plain image, and offers an inset rectangle", () => {
    const img = paint(W, H, () => [128, 128, 128]);
    const { quad, confident } = findPage(img);
    expect(confident).toBe(false);
    expect(quad[0].x).toBeCloseTo((W - 1) * 0.06, 5);
    expect(quad[2].y).toBeCloseTo((H - 1) * 0.94, 5);
  });
});

describe("warp", () => {
  it("maps the quad's middle to the output's middle", () => {
    // Red rises with x, green with y: a pixel's color says where it came from.
    const W = 401, H = 301;
    const img = paint(W, H, (x, y) => [Math.round((x * 255) / (W - 1)), Math.round((y * 255) / (H - 1)), 0]);
    const quad: Quad = [{ x: 50, y: 40 }, { x: 350, y: 60 }, { x: 330, y: 260 }, { x: 70, y: 240 }];
    const w = 201, h = 151;
    const out = warp(img, quad, w, h);
    expect(out.width).toBe(w);
    expect(out.height).toBe(h);

    // The middle of a squared-up page is where the quad's diagonals cross.
    const [p0, p1, p2, p3] = quad;
    const d1x = p2.x - p0.x, d1y = p2.y - p0.y, d2x = p3.x - p1.x, d2y = p3.y - p1.y;
    const t = ((p1.x - p0.x) * d2y - (p1.y - p0.y) * d2x) / (d1x * d2y - d1y * d2x);
    const mid = { x: p0.x + t * d1x, y: p0.y + t * d1y };
    const at = (x: number, y: number) => {
      const p = (y * w + x) * 4;
      return [out.data[p], out.data[p + 1]];
    };
    const [r, g] = at((w - 1) / 2, (h - 1) / 2);
    expect(Math.abs(r - (mid.x * 255) / (W - 1))).toBeLessThanOrEqual(2);
    expect(Math.abs(g - (mid.y * 255) / (H - 1))).toBeLessThanOrEqual(2);

    // And the output's corners come from the quad's corners.
    const [r0, g0] = at(0, 0);
    expect(Math.abs(r0 - (50 * 255) / (W - 1))).toBeLessThanOrEqual(2);
    expect(Math.abs(g0 - (40 * 255) / (H - 1))).toBeLessThanOrEqual(2);
  });
});

describe("toDocument", () => {
  it("flattens a shadow to white paper and keeps ink dark", () => {
    // Paper fades from 235 on the left to 135 on the right (a shadow), with
    // 3 px lines of ink every 40 px.
    const W = 400, H = 520;
    const rand = rng(3);
    const isInk = (x: number, y: number) => x >= 40 && x < 360 && y % 40 >= 20 && y % 40 < 23;
    const img = paint(W, H, (x, y) => {
      const paper = 235 - (100 * x) / W - (20 * y) / H;
      const v = (isInk(x, y) ? paper * 0.3 : paper) + (rand() - 0.5) * 6;
      return [v, v, v];
    });
    const out = toDocument(img);
    const paper: number[] = [];
    const ink: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = out.data[(y * W + x) * 4];
        if (isInk(x, y)) { if (y % 40 === 21) ink.push(v); }
        else if (y % 40 < 16 || y % 40 > 27) paper.push(v); // clear of the ink lines
      }
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const m = mean(paper);
    const sd = Math.sqrt(mean(paper.map((v) => (v - m) ** 2)));
    expect(m).toBeGreaterThan(245);
    expect(sd).toBeLessThan(6);
    expect(mean(ink)).toBeLessThan(60);
    expect(Math.max(...ink)).toBeLessThan(110);
  });
});

describe("toColor", () => {
  it("turns a yellow-lit page neutral", () => {
    const img = paint(60, 80, () => [230, 220, 170]);
    const out = toColor(img);
    const [r, g, b] = [out.data[0], out.data[1], out.data[2]];
    expect(Math.abs(r - g)).toBeLessThan(10);
    expect(Math.abs(g - b)).toBeLessThan(10);
    expect(r).toBeGreaterThan(220);
  });
});

describe("pagesToPdf", () => {
  // The smallest JPEG header pdf-lib reads (it copies the bytes through
  // without decoding them).
  const jpegHeader = (w: number, h: number) =>
    new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);

  it("puts each page on letter, turned for a wide page", async () => {
    const pdf = await pagesToPdf([
      { jpeg: jpegHeader(1700, 2200), w: 1700, h: 2200 },
      { jpeg: jpegHeader(2200, 1700), w: 2200, h: 1700 },
    ]);
    const doc = await PDFDocument.load(pdf);
    const sizes = doc.getPages().map((p) => p.getSize());
    expect(sizes).toEqual([{ width: 612, height: 792 }, { width: 792, height: 612 }]);
  });
});
