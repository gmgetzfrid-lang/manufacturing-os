import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { originOf, workOrderOrigin, importOf, importStampValue, IMPORT_KEY } from "@/lib/origin";

const when = (t: number) => new Date(t).toISOString().slice(5, 16);
const M = (p: Partial<Milestone>): Milestone => ({ id: "x", orgId: "o", name: "Step", weight: 1, status: "planned", source: "msproject", createdBy: "u", createdByName: "Gabe", createdAt: "2026-10-28T21:00:00Z", ...p } as Milestone);
const rec = (o: Record<string, unknown>) => JSON.stringify({ id: "d1", what: "Open and hydroblast line", foundAt: Date.parse("2026-10-30T14:00:00Z"), addedAt: Date.parse("2026-10-30T15:00:00Z"), seq: 1, of: 2, impact: {}, ...o });

describe("origin", () => {
  it("imported: the file when this import made it; who and when", () => {
    const o = originOf(M({ attributes: { [IMPORT_KEY]: importStampValue({ file: "Transmix-1.mpp", at: "2026-10-28T21:00:05Z", by: "Gabe" }) } }), when);
    expect(o).toEqual({ kind: "imported", lines: ["Imported with the MS Project schedule (Transmix-1.mpp) 10-28T21:00 by Gabe"] });
  });
  it("imported earlier, before files were kept, then updated by a later import", () => {
    const o = originOf(M({ attributes: { [IMPORT_KEY]: importStampValue({ file: "rev2.mpp", at: "2026-11-08T20:00:00Z", by: "Sam" }) } }), when);
    expect(o.lines).toEqual(["Imported with the MS Project schedule 10-28T21:00 by Gabe", "Last updated by an import of rev2.mpp 11-08T20:00 by Sam"]);
  });
  it("added scope: what for, found, added, approved", () => {
    const o = originOf(M({ source: "manual", attributes: { discovery: rec({ kind: "added", foundBy: "Gabe", addedBy: "Gabe", approvedBy: "TA Manager" }) } }), when);
    expect(o.kind).toBe("added");
    expect(o.lines).toEqual(["Added scope: Open and hydroblast line", "Raised 10-30T14:00 by Gabe", "Added to the schedule 10-30T15:00 by Gabe", "Approved by TA Manager"]);
  });
  it("no approval is said, not left out", () => {
    expect(originOf(M({ source: "manual", attributes: { discovery: rec({}) } }), when).lines.at(-1)).toBe("No approval recorded");
  });
  it("by hand: says no reason was recorded", () => {
    expect(originOf(M({ source: "manual" }), when).lines).toEqual(["Added by hand 10-28T21:00 by Gabe. No reason recorded."]);
  });
  it("a work order: its own origin, added work once per piece, steps added by hand", () => {
    const owner = M({ id: "wo" });
    const steps = [owner, M({ id: "a" }),
      M({ id: "b", source: "manual", attributes: { discovery: rec({ addedBy: "Gabe" }) } }), M({ id: "c", source: "manual", attributes: { discovery: rec({ addedBy: "Gabe" }) } }),
      M({ id: "d", source: "manual", createdByName: "Sam", createdAt: "2026-10-31T16:00:00Z" })];
    const w = workOrderOrigin(owner, steps, when);
    expect(w.own.kind).toBe("imported");
    expect(w.added).toHaveLength(1);
    expect(w.added[0].steps).toBe(2);
    expect(w.byHand?.lines).toEqual(["1 step added by hand 10-31T16:00 by Sam. No reason recorded."]);
  });
  it("a work order made during the job takes its steps' reason", () => {
    const owner = M({ id: "wo", source: "manual" });
    const w = workOrderOrigin(owner, [M({ id: "b", source: "manual", attributes: { discovery: rec({ kind: "added", addedBy: "Gabe" }) } })], when);
    expect(w.own.kind).toBe("added");
    expect(w.own.lines[0]).toBe("Added scope: Open and hydroblast line");
    expect(w.added).toEqual([]);
  });
  it("reads a stamp kept as text, and nothing from junk", () => {
    expect(importOf({ attributes: { [IMPORT_KEY]: "{bad" } })).toBeNull();
    expect(importOf({ attributes: { [IMPORT_KEY]: importStampValue({ file: null, at: "2026-10-28T21:00:00Z", by: null }) } })?.at).toBe("2026-10-28T21:00:00Z");
  });
});
