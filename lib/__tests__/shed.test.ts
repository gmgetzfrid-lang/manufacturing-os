import { describe, it, expect } from "vitest";
import { selectShedCandidates, isEligible, type ShedCandidateRow } from "@/lib/shed";

const NOW = new Date("2026-06-23T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400 * 1000).toISOString();

function row(over: Partial<ShedCandidateRow>): ShedCandidateRow {
  return { id: over.id || "v", file_url: "orgs/o/x.pdf", size: 1000, superseded_at: daysAgo(120), archived_at: null, ...over };
}

describe("isEligible", () => {
  const cutoff = new Date(NOW.getTime() - 90 * 86400 * 1000);
  it("accepts a superseded, aged, sized, non-archived binary", () => {
    expect(isEligible(row({}), cutoff)).toBe(true);
  });
  it("rejects the current revision (not superseded)", () => {
    expect(isEligible(row({ superseded_at: null }), cutoff)).toBe(false);
  });
  it("rejects an already-archived row", () => {
    expect(isEligible(row({ archived_at: daysAgo(1) }), cutoff)).toBe(false);
  });
  it("rejects a recently-superseded row (inside the grace window)", () => {
    expect(isEligible(row({ superseded_at: daysAgo(10) }), cutoff)).toBe(false);
  });
  it("rejects rows with no binary or no size", () => {
    expect(isEligible(row({ file_url: null }), cutoff)).toBe(false);
    expect(isEligible(row({ size: 0 }), cutoff)).toBe(false);
  });
});

describe("selectShedCandidates", () => {
  it("takes all eligible when no target is set, sorted oldest-superseded first", () => {
    const rows = [
      row({ id: "a", superseded_at: daysAgo(100), size: 500 }),
      row({ id: "b", superseded_at: daysAgo(200), size: 500 }),
      row({ id: "c", superseded_at: daysAgo(5) }), // too recent
    ];
    const sel = selectShedCandidates(rows, { olderThanDays: 90, now: NOW });
    expect(sel.totalCount).toBe(2);
    expect(sel.selected.map((r) => r.id)).toEqual(["b", "a"]); // oldest first
    expect(sel.totalBytes).toBe(1000);
  });

  it("stops once the target is met (least-necessary first)", () => {
    const rows = [
      row({ id: "old", superseded_at: daysAgo(300), size: 600 }),
      row({ id: "mid", superseded_at: daysAgo(200), size: 600 }),
      row({ id: "new", superseded_at: daysAgo(100), size: 600 }),
    ];
    const sel = selectShedCandidates(rows, { olderThanDays: 90, now: NOW, targetBytes: 1000 });
    expect(sel.selected.map((r) => r.id)).toEqual(["old", "mid"]); // 1200 >= 1000, stop
    expect(sel.totalBytes).toBe(1200);
    expect(sel.skipped).toBe(1);
  });

  it("returns nothing when nothing is eligible", () => {
    const sel = selectShedCandidates([row({ superseded_at: null })], { olderThanDays: 90, now: NOW });
    expect(sel.totalCount).toBe(0);
    expect(sel.totalBytes).toBe(0);
  });
});
