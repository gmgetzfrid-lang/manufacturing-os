import { describe, it, expect } from "vitest";
import {
  refKey, orderPair, proposeOpcContinuity, proposeSharedEquipment,
  mergeDrafts, filterDrafts, splitByAutoApply,
  type ProposalDraft,
} from "@/lib/linkProposalLogic";

describe("refKey / orderPair", () => {
  it("is punctuation and case blind", () => {
    expect(refKey("44-PID-012")).toBe(refKey("44 pid 012"));
    expect(refKey("44-PID-012")).toBe("44pid012");
  });

  it("orders endpoints deterministically so A→B and B→A are one pair", () => {
    expect(orderPair("b", "a")).toEqual(["a", "b"]);
    expect(orderPair("a", "b")).toEqual(["a", "b"]);
  });
});

describe("proposeOpcContinuity", () => {
  const index = (m: Record<string, string[]>) =>
    new Map(Object.entries(m).map(([k, v]) => [refKey(k), v]));

  it("marks an unambiguous continuation provable", () => {
    const out = proposeOpcContinuity(
      [{ documentId: "sheet12", refs: ["44-PID-013"], box: "44-098", page: 1 }],
      index({ "44-PID-013": ["sheet13"] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("provable");
    expect(out[0].confidence).toBe(1);
    expect(out[0].proposer).toBe("opc");
    expect([out[0].documentId, out[0].targetDocumentId].sort()).toEqual(["sheet12", "sheet13"]);
    expect(out[0].evidence.summary).toContain("44-098");
    expect(out[0].evidence.summary).toContain("44-PID-013");
  });

  it("downgrades to strong when two documents claim the referenced number", () => {
    const out = proposeOpcContinuity(
      [{ documentId: "sheet12", refs: ["44-PID-013"] }],
      index({ "44-PID-013": ["sheet13a", "sheet13b"] }),
    );
    expect(out).toHaveLength(2);
    expect(out.every((d) => d.tier === "strong")).toBe(true);
    expect(out[0].evidence.detail).toContain("2 documents");
  });

  it("stays silent when a number is claimed by a crowd", () => {
    const out = proposeOpcContinuity(
      [{ documentId: "sheet12", refs: ["44-PID-013"] }],
      index({ "44-PID-013": ["a", "b", "c", "d"] }),
    );
    expect(out).toHaveLength(0);
  });

  it("ignores unresolvable refs and self-references", () => {
    const out = proposeOpcContinuity(
      [{ documentId: "sheet12", refs: ["NOT-A-SHEET", "44-PID-012"] }],
      index({ "44-PID-012": ["sheet12"] }),
    );
    expect(out).toHaveLength(0);
  });

  it("keeps the strongest evidence when a pair connects more than once", () => {
    const out = proposeOpcContinuity(
      [
        { documentId: "s12", refs: ["P-13"] },
        { documentId: "s12", refs: ["P-13"], box: "44-099" },
      ],
      index({ "P-13": ["s13"] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("provable");
  });

  it("carries the source revision for staleness keying", () => {
    const out = proposeOpcContinuity(
      [{ documentId: "s12", refs: ["P-13"], sourceRev: "3" }],
      index({ "P-13": ["s13"] }),
    );
    expect(out[0].sourceRev).toBe("3");
  });
});

describe("proposeSharedEquipment", () => {
  it("proposes nothing when no tag is shared", () => {
    const out = proposeSharedEquipment([
      { documentId: "a", tag: "e101" },
      { documentId: "b", tag: "p202" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("treats a single shared tag as inferred, several as strong", () => {
    const one = proposeSharedEquipment([
      { documentId: "a", tag: "e101" }, { documentId: "b", tag: "e101" },
    ]);
    expect(one[0].tier).toBe("inferred");

    const many = proposeSharedEquipment(
      ["e101", "p202", "v303"].flatMap((tag) => [
        { documentId: "a", tag }, { documentId: "b", tag },
      ]),
    );
    expect(many[0].tier).toBe("strong");
    expect(many[0].evidence.tags).toHaveLength(3);
  });

  it("never marks shared equipment provable — relating is a human call", () => {
    const out = proposeSharedEquipment(
      Array.from({ length: 10 }, (_, i) => `t${i}`).flatMap((tag) => [
        { documentId: "a", tag }, { documentId: "b", tag },
      ]),
    );
    expect(out[0].tier).toBe("strong");
    expect(out[0].confidence).toBeLessThanOrEqual(0.9);
  });

  it("skips filing-category tags that appear on everything", () => {
    const occ = Array.from({ length: 60 }, (_, i) => ({ documentId: `d${i}`, tag: "general" }));
    expect(proposeSharedEquipment(occ)).toHaveLength(0);
  });

  it("labels alias-only matches as the alias proposer and names the alias", () => {
    const out = proposeSharedEquipment([
      { documentId: "a", tag: "e101", viaAlias: "Exchanger 101" },
      { documentId: "b", tag: "e101", viaAlias: "Exchanger 101" },
    ]);
    expect(out[0].proposer).toBe("alias");
    expect(out[0].evidence.detail).toContain("Exchanger 101");
  });

  it("credits the alias when it is load-bearing for either side", () => {
    // Without the alias, document b never joins the e101 group and the pair
    // never forms — so the alias is the reason, and review should see it.
    const out = proposeSharedEquipment([
      { documentId: "a", tag: "e101" },
      { documentId: "b", tag: "e101", viaAlias: "Exchanger 101" },
    ]);
    expect(out[0].proposer).toBe("alias");
    expect(out[0].evidence.detail).toContain("Exchanger 101");
  });

  it("uses the canonical proposer when no alias was involved at all", () => {
    const out = proposeSharedEquipment([
      { documentId: "a", tag: "e101" },
      { documentId: "b", tag: "e101" },
    ]);
    expect(out[0].proposer).toBe("tag");
  });

  it("generates candidates through shared keys, not pairwise", () => {
    // 200 documents, each with its own tag: zero pairs should be considered.
    const occ = Array.from({ length: 200 }, (_, i) => ({ documentId: `d${i}`, tag: `t${i}` }));
    expect(proposeSharedEquipment(occ)).toHaveLength(0);
  });
});

describe("mergeDrafts / filterDrafts / splitByAutoApply", () => {
  const draft = (over: Partial<ProposalDraft>): ProposalDraft => ({
    documentId: "a", targetDocumentId: "b", proposer: "tag",
    tier: "inferred", confidence: 0.4, evidence: { summary: "x" }, ...over,
  });

  it("lets a provable draft win over a higher-confidence inferred one", () => {
    const out = mergeDrafts([
      draft({ tier: "inferred", confidence: 0.9 }),
      draft({ tier: "provable", confidence: 0.5, proposer: "opc" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("provable");
  });

  it("breaks tier ties on confidence", () => {
    const out = mergeDrafts([
      draft({ tier: "strong", confidence: 0.5 }),
      draft({ tier: "strong", confidence: 0.8 }),
    ]);
    expect(out[0].confidence).toBe(0.8);
  });

  it("drops pairs already linked or already decided", () => {
    const drafts = [draft({}), draft({ documentId: "c", targetDocumentId: "d" })];
    const out = filterDrafts(drafts, { linked: new Set(["a|b"]), decided: new Set() });
    expect(out).toHaveLength(1);
    expect(out[0].documentId).toBe("c");
  });

  it("never re-proposes a dismissed pair", () => {
    const out = filterDrafts([draft({})], { linked: new Set(), decided: new Set(["a|b"]) });
    expect(out).toHaveLength(0);
  });

  it("auto-applies only provable drafts", () => {
    const { autoApply, queue } = splitByAutoApply([
      draft({ tier: "provable" }),
      draft({ tier: "strong" }),
      draft({ tier: "inferred" }),
    ]);
    expect(autoApply).toHaveLength(1);
    expect(queue).toHaveLength(2);
  });
});
