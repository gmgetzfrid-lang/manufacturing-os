import { describe, it, expect } from "vitest";
import { signalScale, signalFromLogo, contrast, toOklch, fromOklch, DEFAULT_SIGNAL, isColorful, accentFor, logoTriplets, paintTriplet, tripletGap, type Triplet } from "@/lib/brandColors";

const ANY = ["#0b1f6b", "#1f5bd6", "#0e7c3a", "#f5b700", "#db2777", "#7c3aed", "#ea580c", "#4fd1c5", "#e11d48", "#ffd400", "#9acd32"];

describe("signal colors", () => {
  it("round-trips through OKLCH", () => {
    const [L, C, H] = toOklch("#1f5bd6");
    expect(fromOklch(L, C, H)).toBe("#1f5bd6");
  });

  it("gives every color a button white text reads on, and links that read on white", () => {
    for (const c of ANY) {
      const s = signalScale(c);
      expect(contrast(s[600], "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(s[700], "#ffffff")).toBeGreaterThanOrEqual(6);
      expect(contrast(s[50], "#ffffff")).toBeLessThan(1.15);
    }
  });

  it("falls back to process blue for grey or black", () => {
    expect(signalScale("#777777")[600]).toBe(signalScale(DEFAULT_SIGNAL)[600]);
    expect(signalScale("#000000")[600]).toBe(signalScale(DEFAULT_SIGNAL)[600]);
    expect(isColorful("#f5f5f5")).toBe(false);
  });

  it("keeps a dark logo navy as a usable blue, not a near-black slab", () => {
    const s = signalScale("#0b1f6b");
    const [L, , H] = toOklch(s[600]);
    expect(L).toBeGreaterThan(0.4);
    expect(H).toBeGreaterThan(240);
    expect(H).toBeLessThan(290);
  });

  it("picks the logo's best brand color and a second hue for charts", () => {
    const r = signalFromLogo(["#f5b700", "#0b1f6b", "#888888", "#14a37f"])!;
    expect(r.signal).toBe("#0b1f6b"); // gold can't carry white text, navy can
    expect(r.second).not.toBeNull();
    expect(signalFromLogo(["#ffffff", "#000000", "#808080"])).toBeNull();
  });
});

describe("the pair and the accent", () => {
  it("uses the logo's second color as the accent when it stands apart", async () => {
    const { accentFor, toOklch } = await import("@/lib/brandColors");
    const a = accentFor("#0b1f6b", "#d4a017");
    const h = toOklch(a.fill)[2];
    expect(h).toBeGreaterThan(60);
    expect(h).toBeLessThan(115);
    expect(a.fg).toBe("#1f2733"); // gold carries graphite text
  });

  it("falls back to the brand's opposite, and its text always reads", async () => {
    const { accentFor, contrast } = await import("@/lib/brandColors");
    for (const c of ["#1f5bd6", "#0f766e", "#b91c1c", "#6d28d9", "#15803d"]) {
      const a = accentFor(c, c);
      expect(contrast(a.fill, a.fg)).toBeGreaterThanOrEqual(3);
      expect(contrast(a.text, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives a deep shade for the side menu that white text reads on", async () => {
    const { deepFor, contrast } = await import("@/lib/brandColors");
    for (const c of ["#0b1f6b", "#1f5bd6", "#0f766e", "#f5b700"]) expect(contrast(deepFor(c), "#ffffff")).toBeGreaterThan(10);
  });
});

describe("three colors from a logo", () => {
  const hue = (hex: string) => toOklch(hex)[2];
  const gap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const readable = (list: Triplet[]) => {
    for (const t of list) {
      const p = paintTriplet(t);
      expect(contrast(p.main, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.deep, "#ffffff")).toBeGreaterThanOrEqual(7);
      expect(gap(hue(p.accent), hue(p.main))).toBeGreaterThanOrEqual(50);
    }
  };
  const distinct = (list: Triplet[]) => {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) expect(tripletGap(list[i], list[j])).toBeGreaterThan(0.05);
  };

  it("offers several ways to use a multi-color logo, the best first", () => {
    const navy = "#000A71", lightBlue = "#60A8E6", green = "#138D77", gold = "#FFBD59";
    const list = logoTriplets([navy, lightBlue, green, gold]);
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(list.length).toBeLessThanOrEqual(8);
    // The navy is the side menu, a blue the header, the gold the button.
    expect(list[0].deep).toBe(navy.toLowerCase());
    expect([navy, lightBlue].map((c) => c.toLowerCase())).toContain(list[0].main);
    expect(list[0].accent).toBe(gold.toLowerCase());
    // Gold never carries the white-text header band in the top picks.
    expect(list.slice(0, 4).every((t) => t.main !== gold.toLowerCase())).toBe(true);
    // The green shows up as an option too.
    expect(list.some((t) => t.main === green.toLowerCase() || t.accent === green.toLowerCase())).toBe(true);
    readable(list);
    distinct(list);
  });

  it("still gives a choice for a one-color logo", () => {
    const list = logoTriplets(["#0f766e"]);
    expect(list.length).toBeGreaterThanOrEqual(4);
    for (const t of list) { expect(t.main).toBe("#0f766e"); expect(t.deep).toBe("#0f766e"); }
    // The first button is the brand's opposite, as the app picks today.
    expect(paintTriplet(list[0]).accent).toBe(accentFor("#0f766e", "#0f766e").fill);
    readable(list);
    distinct(list);
  });

  it("gives nothing for a logo with no color", () => {
    expect(logoTriplets(["#ffffff", "#000000", "#808080", "#f5f5f5"])).toEqual([]);
    expect(logoTriplets([])).toEqual([]);
  });
});
