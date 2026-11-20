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
