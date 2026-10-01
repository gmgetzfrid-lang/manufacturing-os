// Freezes the content-aware stamp math: rotated-fit sizing, centered
// placement, footer wrapping, and the ink-driven region choices that keep
// the QR and footer off the drawing's own content.

import { describe, it, expect } from "vitest";
import {
  fitRotatedTextSize, centerRotatedText, wrapToWidth,
  pickQrCorner, pickFooterEdge, placeQr, FALLBACK_INK,
  normalizeRotation, displaySize, displayToUser,
} from "@/lib/stampLayout";

describe("fitRotatedTextSize", () => {
  it("short text on a big page gets the max size", () => {
    const fit = fitRotatedTextSize({ widthAt1pt: 10, pageW: 612, pageH: 792, angleDeg: -30 });
    expect(fit.size).toBe(32);
  });

  it("long text shrinks until the rotated box fits the page width", () => {
    const fit = fitRotatedTextSize({ widthAt1pt: 60, pageW: 612, pageH: 792, angleDeg: -30 });
    expect(fit.size).toBeLessThan(32);
    expect(fit.boxW).toBeLessThanOrEqual(612 * 0.88);
  });

  it("never shrinks below the legibility floor", () => {
    const fit = fitRotatedTextSize({ widthAt1pt: 500, pageW: 200, pageH: 200, angleDeg: -30 });
    expect(fit.size).toBe(8);
  });
});

describe("centerRotatedText", () => {
  it("an unrotated run centers exactly", () => {
    const { x, y } = centerRotatedText({ pageW: 600, pageH: 800, textW: 100, textH: 20, angleDeg: 0 });
    expect(x).toBeCloseTo(250);
    expect(y).toBeCloseTo(390);
  });
  it("a rotated run's midpoint lands on the page center", () => {
    const angle = -30;
    const t = (angle * Math.PI) / 180;
    const { x, y } = centerRotatedText({ pageW: 612, pageH: 792, textW: 400, textH: 24, angleDeg: angle });
    const cx = x + (400 * Math.cos(t) + 24 * -Math.sin(t)) / 2;
    const cy = y + (400 * Math.sin(t) + 24 * Math.cos(t)) / 2;
    expect(cx).toBeCloseTo(306);
    expect(cy).toBeCloseTo(396);
  });
});

describe("wrapToWidth", () => {
  const measure = (s: string) => s.length * 6; // 6pt per char stand-in
  it("keeps short text on one line", () => {
    expect(wrapToWidth("hello world", 200, measure)).toEqual(["hello world"]);
  });
  it("wraps at word boundaries and never overflows", () => {
    const lines = wrapToWidth("alpha beta gamma delta epsilon", 80, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(80);
  });
  it("hard-breaks a single over-long word", () => {
    const lines = wrapToWidth("Supercalifragilistic", 60, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(60);
    expect(lines.join("")).toBe("Supercalifragilistic");
  });
  it("empty text → no lines", () => {
    expect(wrapToWidth("   ", 100, measure)).toEqual([]);
  });
});

describe("pickQrCorner — the QR goes where the drawing isn't", () => {
  it("prefers bottom-right when everything is equally empty", () => {
    expect(pickQrCorner({ br: 0, bl: 0, tr: 0, tl: 0 })).toBe("br");
  });
  it("an inky title block in the bottom-right pushes the QR elsewhere", () => {
    expect(pickQrCorner({ br: 0.6, bl: 0.05, tr: 0.3, tl: 0.4 })).toBe("bl");
  });
  it("all bottom busy → goes top", () => {
    expect(pickQrCorner({ br: 0.5, bl: 0.55, tr: 0.02, tl: 0.4 })).toBe("tr");
  });
  it("small differences don't beat the convention bias", () => {
    expect(pickQrCorner({ br: 0.03, bl: 0.01, tr: 0.02, tl: 0.0 })).toBe("br");
  });
});

describe("pickFooterEdge", () => {
  it("bottom by convention", () => {
    expect(pickFooterEdge(0.1, 0.1)).toBe("bottom");
  });
  it("busy bottom band (title block) pushes the footer to the top", () => {
    expect(pickFooterEdge(0.05, 0.5)).toBe("top");
  });
});

describe("placeQr — the plate can never leave the page", () => {
  const pages = [
    { w: 612, h: 792 },   // letter portrait
    { w: 1224, h: 792 },  // ANSI D-ish landscape
    { w: 200, h: 150 },   // absurdly small
  ];
  const corners = ["br", "bl", "tr", "tl"] as const;
  it("plate stays fully on-page for every corner and page size", () => {
    for (const { w, h } of pages) {
      for (const c of corners) {
        const q = placeQr({ pageW: w, pageH: h, corner: c });
        expect(q.plate.x).toBeGreaterThanOrEqual(0);
        expect(q.plate.y).toBeGreaterThanOrEqual(0);
        expect(q.plate.x + q.plate.w).toBeLessThanOrEqual(w);
        expect(q.plate.y + q.plate.h).toBeLessThanOrEqual(h);
        // QR itself sits inside the plate.
        expect(q.qrX).toBeGreaterThanOrEqual(q.plate.x);
        expect(q.qrY + q.qrSize).toBeLessThanOrEqual(q.plate.y + q.plate.h + 0.001);
      }
    }
  });
});

describe("FALLBACK_INK", () => {
  it("reproduces the historical bottom-right / bottom-footer placement", () => {
    expect(pickQrCorner(FALLBACK_INK.corners)).toBe("br");
    expect(pickFooterEdge(FALLBACK_INK.topBand, FALLBACK_INK.bottomBand)).toBe("bottom");
  });
});

// PHYS-12 / PKG-13: the page as displayed vs the page pdf-lib draws on.
describe("page rotation — display space ↔ user space", () => {
  it("normalizes any multiple of 90 (negative, > 360, float noise) to 0/90/180/270", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-180)).toBe(180);
    expect(normalizeRotation(269.9999)).toBe(270);
    expect(normalizeRotation(Number.NaN)).toBe(0);
  });
  it("a quarter turn swaps the displayed sides; a half turn does not", () => {
    expect(displaySize(612, 792, 0)).toEqual({ width: 612, height: 792 });
    expect(displaySize(612, 792, 90)).toEqual({ width: 792, height: 612 });
    expect(displaySize(612, 792, 180)).toEqual({ width: 612, height: 792 });
    expect(displaySize(612, 792, 270)).toEqual({ width: 792, height: 612 });
  });
  it("maps each displayed corner to the user-space corner a clockwise /Rotate puts there", () => {
    const W = 612, H = 792;
    // /Rotate 90 (clockwise): the user bottom-right shows at the display bottom-left,
    // the user bottom-left at the display top-left.
    expect(displayToUser(0, 0, W, H, 90)).toEqual({ x: W, y: 0 });
    expect(displayToUser(0, W, W, H, 90)).toEqual({ x: 0, y: 0 });
    expect(displayToUser(H, W, W, H, 90)).toEqual({ x: 0, y: H });
    // /Rotate 180: everything mirrors through the centre.
    expect(displayToUser(0, 0, W, H, 180)).toEqual({ x: W, y: H });
    // /Rotate 270: the user top-left shows at the display bottom-left.
    expect(displayToUser(0, 0, W, H, 270)).toEqual({ x: 0, y: H });
    expect(displayToUser(H, 0, W, H, 270)).toEqual({ x: 0, y: 0 });
    // unrotated: identity
    expect(displayToUser(10, 20, W, H, 0)).toEqual({ x: 10, y: 20 });
  });
  it("every point of the displayed page maps inside the MediaBox", () => {
    const W = 612, H = 792;
    for (const r of [0, 90, 180, 270] as const) {
      const d = displaySize(W, H, r);
      for (const [x, y] of [[0, 0], [d.width, 0], [0, d.height], [d.width, d.height], [d.width / 3, d.height / 5]]) {
        const u = displayToUser(x, y, W, H, r);
        expect(u.x).toBeGreaterThanOrEqual(0); expect(u.x).toBeLessThanOrEqual(W);
        expect(u.y).toBeGreaterThanOrEqual(0); expect(u.y).toBeLessThanOrEqual(H);
      }
    }
  });
});
