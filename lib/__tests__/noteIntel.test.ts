// lib/__tests__/noteIntel.test.ts
//
// The note-intelligence engine's pure core: candidate extraction,
// reference normalization, close-miss similarity, the clarification
// gate, and signal derivation. A false positive here means noise on
// every note; a false negative means a missed "the doc you're talking
// about is locked" warning — both are product bugs, so the grammar is
// pinned.

import { describe, it, expect } from "vitest";
import {
  extractCandidates, normalizeRef, refSimilarity, hasReferentialContext,
  buildFootnotes, type ResolvedSnapshot,
} from "@/lib/noteIntel";

describe("normalizeRef", () => {
  it("uppercases, strips spaces, dashes letter→digit boundaries", () => {
    expect(normalizeRef("e204")).toBe("E-204");
    expect(normalizeRef("E-204")).toBe("E-204");
    expect(normalizeRef("p101a")).toBe("P-101A");
    expect(normalizeRef("MOC 2024-051")).toBe("MOC-2024-051");
    expect(normalizeRef("moc2024")).toBe("MOC-2024");
  });
});

describe("extractCandidates", () => {
  it("finds dashed and glued refs, normalized to one form", () => {
    const c = extractCandidates("e-204 weeping, p101a vibrating, check MOC-2024-051");
    const norms = c.filter((x) => x.kind === "ref").map((x) => x.norm);
    expect(norms).toContain("E-204");
    expect(norms).toContain("P-101A");
    expect(norms).toContain("MOC-2024-051");
  });

  it("dedupes the same ref written two ways", () => {
    const c = extractCandidates("E-204 and also e204 again");
    expect(c.filter((x) => x.norm === "E-204")).toHaveLength(1);
  });

  it("ignores bare dates and due tokens", () => {
    const c = extractCandidates("- [ ] thing @2026-06-15 due friday ✓2026-06-12");
    expect(c.filter((x) => x.kind === "ref")).toHaveLength(0);
  });

  it("captures quoted titles and project phrases as name candidates", () => {
    const c = extractCandidates('met about project Falcon Run, see "Overhead Piping Iso"');
    const names = c.filter((x) => x.kind === "name").map((x) => x.norm);
    expect(names).toContain("falcon run");
    expect(names).toContain("overhead piping iso");
  });

  it("caps the candidate list", () => {
    const many = Array.from({ length: 20 }, (_, i) => `E-${100 + i}`).join(" ");
    expect(extractCandidates(many).length).toBeLessThanOrEqual(8);
  });
});

describe("refSimilarity", () => {
  it("treats dashless and dashed as identical", () => {
    expect(refSimilarity("E-204", "E-204")).toBe(1);
    expect(refSimilarity(normalizeRef("e204"), "E-204")).toBe(1);
  });

  it("scores one keystroke off as a close miss", () => {
    expect(refSimilarity("E-205", "E-204")).toBe(0.9);
    expect(refSimilarity("E-2O4", "E-204")).toBe(0.9); // letter O for zero
  });

  it("rejects different refs", () => {
    expect(refSimilarity("E-204", "P-101")).toBe(0);
  });

  it("prefers the true near-match over a distant tag", () => {
    const cand = normalizeRef("E2O4");
    expect(refSimilarity(cand, "E-204")).toBeGreaterThan(refSimilarity(cand, "E-301"));
  });
});

describe("hasReferentialContext", () => {
  it("passes when reference-ish words sit near the candidate", () => {
    expect(hasReferentialContext("need the drawing for X-99 today", "X-99")).toBe(true);
    expect(hasReferentialContext("asset X-99 is acting up", "X-99")).toBe(true);
  });

  it("fails for incidental matches with no context", () => {
    expect(hasReferentialContext("ate at gate B-412 before the flight", "B-412")).toBe(false);
  });
});

describe("buildFootnotes — signals", () => {
  const base: ResolvedSnapshot = {
    todayIso: "2026-06-12",
    assets: [], documents: [], tickets: [], projects: [], milestones: [],
    checkoutsByDoc: new Map(), holdsByDoc: new Map(),
  };

  it("flags a blocked asset as an alert", () => {
    const [f] = buildFootnotes({ ...base, assets: [{ id: "a1", tag: "E-204", state: "blocked" }] });
    expect(f.tone).toBe("alert");
    expect(f.signal).toMatch(/BLOCKED/);
  });

  it("warns when a referenced document is checked out", () => {
    const [f] = buildFootnotes({
      ...base,
      documents: [{ id: "d1", libraryId: "L", title: "Overhead P&ID", number: "PID-1142" }],
      checkoutsByDoc: new Map([["d1", [{ userName: "Alice M.", startedAt: "2026-06-10" }]]]),
    });
    expect(f.tone).toBe("warn");
    expect(f.signal).toContain("Alice M.");
  });

  it("escalates a document hold over a lock", () => {
    const [f] = buildFootnotes({
      ...base,
      documents: [{ id: "d1", libraryId: "L", title: "Spec", number: "SPEC-1" }],
      checkoutsByDoc: new Map([["d1", [{ userName: "Bob" }]]]),
      holdsByDoc: new Map([["d1", [{ reason: "Pending MOC approval" }]]]),
    });
    expect(f.tone).toBe("alert");
    expect(f.signal).toContain("Pending MOC approval");
  });

  it("warns when a schedule task lands within a week — the sooner-than-it-reads signal", () => {
    const [f] = buildFootnotes({
      ...base,
      milestones: [{ id: "m1", projectId: "p1", name: "Hydrotest", plannedAt: "2026-06-15" }],
    });
    expect(f.tone).toBe("warn");
    expect(f.signal).toMatch(/lands in 3d/);
  });

  it("alerts on a slipped schedule task", () => {
    const [f] = buildFootnotes({
      ...base,
      milestones: [{ id: "m1", projectId: "p1", name: "Hydrotest", plannedAt: "2026-06-09" }],
    });
    expect(f.tone).toBe("alert");
    expect(f.signal).toMatch(/slipped/);
  });

  it("keeps a completed task quiet", () => {
    const [f] = buildFootnotes({
      ...base,
      milestones: [{ id: "m1", projectId: "p1", name: "Hydrotest", plannedAt: "2026-06-09", completedAt: "2026-06-10" }],
    });
    expect(f.tone).toBe("info");
    expect(f.signal).toBeUndefined();
  });

  it("surfaces project schedule health", () => {
    const [f] = buildFootnotes({
      ...base,
      projects: [{ id: "p1", name: "Falcon Run", overdueTasks: 3, nextMilestone: { name: "Hydrotest", plannedAt: "2026-06-15" } }],
    });
    expect(f.tone).toBe("warn");
    expect(f.signal).toContain("3 schedule tasks overdue");
    expect(f.metric).toContain("Hydrotest");
  });

  it("sorts signals above quiet info and caps the list", () => {
    const out = buildFootnotes({
      ...base,
      assets: [
        { id: "a1", tag: "E-1", state: "pending" },
        { id: "a2", tag: "E-2", state: "blocked" },
        { id: "a3", tag: "E-3", state: "pending" },
        { id: "a4", tag: "E-4", state: "pending" },
        { id: "a5", tag: "E-5", state: "pending" },
        { id: "a6", tag: "E-6", state: "pending" },
        { id: "a7", tag: "E-7", state: "pending" },
      ],
    });
    expect(out[0].tone).toBe("alert");
    expect(out.length).toBeLessThanOrEqual(6);
  });
});
