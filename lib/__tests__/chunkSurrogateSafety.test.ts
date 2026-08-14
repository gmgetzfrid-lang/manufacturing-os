import { describe, it, expect } from "vitest";
import { chunkPageText, sanitizeStorageText } from "../knowledgeText";

const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};

describe("REPRO: chunker re-creating lone surrogates after sanitize", () => {
  it("astral-dense text with NO sentence boundaries (forced arbitrary slices)", () => {
    const astral = "\u{1D5E3}\u{1D5F2}\u{1D5FF}\u{1D600}\u{1D5FC}"; // 5 astral chars = 10 UTF-16 units
    const raw = (astral + " tag ").repeat(400); // ~6000 units, no ". " anywhere
    const clean = sanitizeStorageText(raw);
    expect(hasLoneSurrogate(clean)).toBe(false);
    const chunks = chunkPageText(clean);
    const poisoned = chunks.filter(hasLoneSurrogate);
    console.log(`RESULT chunks=${chunks.length} poisoned=${poisoned.length}`);
    expect(poisoned.length).toBe(0);
  });

  it("odd-offset astral runs across many alignments", () => {
    let worst = 0;
    for (let pad = 0; pad < 7; pad++) {
      const raw = "x".repeat(pad) + "\u{1D5E3}".repeat(1200); // one long astral run
      const chunks = chunkPageText(sanitizeStorageText(raw));
      worst += chunks.filter(hasLoneSurrogate).length;
    }
    console.log(`RESULT poisoned-across-alignments=${worst}`);
    expect(worst).toBe(0);
  });
});

describe("truncateSafe", () => {
  it("never leaves half a pair at the cut", async () => {
    const { truncateSafe } = await import("../knowledgeText");
    const s = "ab" + "\u{1D5E3}".repeat(100);
    for (let n = 1; n < 30; n++) {
      const t = truncateSafe(s, n);
      expect(hasLone(t)).toBe(false);
      expect(t.length).toBeLessThanOrEqual(n);
    }
  });
});
const hasLone = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};
