// The matching rules here decide what every link in the graph MEANS, so a
// mistake doesn't produce a bug report — it produces a plant map that quietly
// says the wrong thing. False positives are the dangerous direction: an
// inspection report wrongly attached to a vessel is worse than one missing.

import { describe, it, expect } from "vitest";
import {
  findMentions, summarizeByAsset, aliasPattern, snippetAround,
  type AliasEntry,
} from "@/lib/mentionIndex";

const tag = (assetId: string, alias: string): AliasEntry => ({ assetId, alias, origin: "tag" });

describe("aliasPattern", () => {
  it("matches a tag however the draftsman punctuated it", () => {
    const re = () => aliasPattern("E-101")!;
    for (const text of ["E-101", "E101", "e 101", "E_101", "E.101"]) {
      expect(re().test(text)).toBe(true);
    }
  });

  it("never matches inside a longer tag", () => {
    // The failure that silently rewires a plant: E-101 found in E-1015.
    expect(aliasPattern("E-101")!.test("E-1015")).toBe(false);
    expect(aliasPattern("E-101")!.test("E-10")).toBe(false);
    expect(aliasPattern("E-101")!.test("XE-101")).toBe(false);
    expect(aliasPattern("E-101")!.test("E-101A")).toBe(false);
  });

  it("matches multi-word human aliases across flexible whitespace", () => {
    const re = aliasPattern("Crude Preheat Exchanger")!;
    expect(re.test("the Crude   Preheat\nExchanger runs hot")).toBe(true);
  });

  it("refuses aliases too short or too generic to be safe", () => {
    expect(aliasPattern("E1")).toBeNull();     // two chars
    expect(aliasPattern("REV")).toBeNull();    // title-block boilerplate
    expect(aliasPattern("SHT")).toBeNull();
    expect(aliasPattern("  ")).toBeNull();
  });

  it("handles a three-part refinery tag", () => {
    const re = aliasPattern("21-D-1105")!;
    expect(re.test("see 21 D 1105 sheet 2")).toBe(true);
    expect(aliasPattern("21-D-1105")!.test("21-D-11050")).toBe(false);
  });
});

describe("findMentions", () => {
  it("finds the tag and keeps the sentence around it as evidence", () => {
    const text = "Scope of work. The shell side of E-101 shows wall loss at the inlet. Next item.";
    const [m] = findMentions(text, [tag("a1", "E-101")]);
    expect(m.assetId).toBe("a1");
    expect(m.matchedText).toBe("E-101");
    expect(m.snippet).toContain("shell side of E-101 shows wall loss");
    // The evidence must not swallow the neighbouring sentences whole.
    expect(m.snippet).not.toContain("Scope of work");
  });

  it("finds every occurrence, not just the first", () => {
    const text = "E-101 feeds E-102. Later, E-101 is isolated.";
    const ms = findMentions(text, [tag("a1", "E-101")]);
    expect(ms).toHaveLength(2);
    expect(ms[0].offset).toBeLessThan(ms[1].offset);
  });

  it("counts one mention when several aliases hit the same characters", () => {
    // E-101 is also aliased "E101" — the same five characters are one link.
    const text = "Replace E-101 gaskets.";
    const ms = findMentions(text, [tag("a1", "E-101"), { assetId: "a1", alias: "E101", origin: "human" }]);
    expect(ms).toHaveLength(1);
  });

  it("keeps the most trustworthy alias when two disagree", () => {
    const text = "Replace E-101 gaskets.";
    const ms = findMentions(text, [
      { assetId: "a1", alias: "E-101", origin: "vision" },
      { assetId: "a1", alias: "E101", origin: "tag" },
    ]);
    expect(ms).toHaveLength(1);
    expect(ms[0].origin).toBe("tag");                 // not the vision guess
    expect(ms[0].confidence).toBeGreaterThan(0.9);
  });

  it("scores a machine-read alias below a human one", () => {
    const text = "The crude preheat exchanger was opened.";
    const [vision] = findMentions(text, [{ assetId: "a1", alias: "Crude Preheat Exchanger", origin: "vision" }]);
    const [human] = findMentions(text, [{ assetId: "a1", alias: "Crude Preheat Exchanger", origin: "human" }]);
    expect(vision.confidence).toBeLessThan(human.confidence);
  });

  it("distinguishes two assets in one sentence", () => {
    const text = "Line runs from E-101 to P-202 via the header.";
    const ms = findMentions(text, [tag("a1", "E-101"), tag("a2", "P-202")]);
    expect(ms.map((m) => m.assetId)).toEqual(["a1", "a2"]);
  });

  it("returns nothing for empty text or an empty dictionary", () => {
    expect(findMentions("", [tag("a1", "E-101")])).toEqual([]);
    expect(findMentions("E-101 everywhere", [])).toEqual([]);
  });

  it("terminates on pathological input instead of spinning", () => {
    const text = "E-101 ".repeat(500);
    const ms = findMentions(text, [tag("a1", "E-101")]);
    expect(ms).toHaveLength(500);
  });
});

describe("snippetAround", () => {
  it("bounds evidence at line breaks, which is all a title block has", () => {
    const text = "DWG NO 21-D-1105\nE-101 CRUDE PREHEAT EXCHANGER\nREV A";
    const at = text.indexOf("E-101");
    const s = snippetAround(text, at, 5);
    expect(s).toContain("E-101 CRUDE PREHEAT EXCHANGER");
    expect(s).not.toContain("REV A");
    expect(s).not.toContain("DWG NO");
  });

  it("clips a runaway line instead of returning a page", () => {
    const text = `${"x".repeat(2000)} E-101 ${"y".repeat(2000)}`;
    const s = snippetAround(text, text.indexOf("E-101"), 5);
    expect(s.length).toBeLessThanOrEqual(262);
    expect(s).toContain("E-101");
  });

  it("collapses the whitespace that PDF extraction sprays everywhere", () => {
    const s = snippetAround("The    valve\t\ton   E-101   is shut", 17, 5);
    expect(s).not.toMatch(/\s{2,}/);
  });
});

describe("summarizeByAsset", () => {
  it("collapses forty mentions into one link with a strength of forty", () => {
    const text = `${"E-101 listed. ".repeat(40)}`;
    const summary = summarizeByAsset(findMentions(text, [tag("a1", "E-101")]));
    expect(summary).toHaveLength(1);
    expect(summary[0].count).toBe(40);
  });

  it("prefers a real sentence over a bare table cell as the evidence shown", () => {
    const text = "E-101\nThe E-101 exchanger was retubed during the 2024 turnaround.";
    const summary = summarizeByAsset(findMentions(text, [tag("a1", "E-101")]));
    expect(summary[0].snippet).toContain("retubed during the 2024 turnaround");
  });

  it("orders by mention count so hubs read as hubs", () => {
    const text = "E-101 E-101 E-101 P-202";
    const summary = summarizeByAsset(findMentions(text, [tag("a1", "E-101"), tag("a2", "P-202")]));
    expect(summary.map((s) => s.assetId)).toEqual(["a1", "a2"]);
    expect(summary[0].count).toBe(3);
    expect(summary[1].count).toBe(1);
  });

  it("is empty for no mentions", () => {
    expect(summarizeByAsset([])).toEqual([]);
  });
});
