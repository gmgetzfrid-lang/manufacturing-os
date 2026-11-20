import { describe, it, expect } from "vitest";
import { signalScale, signalFromLogo, contrast, toOklch, fromOklch, DEFAULT_SIGNAL, isColorful } from "@/lib/brandColors";

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
