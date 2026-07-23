// Freezes the content-aware stamp math: rotated-fit sizing, centered
// placement, footer wrapping, and the ink-driven region choices that keep
// the QR and footer off the drawing's own content.

import { describe, it, expect } from "vitest";
import {
  fitRotatedTextSize, centerRotatedText, wrapToWidth,
  pickQrCorner, pickFooterEdge, placeQr, FALLBACK_INK,
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
