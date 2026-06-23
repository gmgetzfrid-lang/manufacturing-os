import { describe, it, expect } from "vitest";
import { selectShedCandidates, isEligible, type ShedCandidateRow } from "@/lib/shed";

const NOW = new Date("2026-06-23T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400 * 1000).toISOString();

// A revision of document `doc`, created `age` days ago. Superseded unless current.
function rev(doc: string, id: string, ageDays: number, opts: Partial<ShedCandidateRow> = {}): ShedCandidateRow {
  return {
    id, record_id: doc, file_url: `orgs/o/${id}.pdf`, size: 1000,
    created_at: daysAgo(ageDays),
    superseded_at: opts.superseded_at === undefined ? daysAgo(ageDays) : opts.superseded_at,
    archived_at: null,
    ...opts,
  };
}

describe("isEligible", () => {
  it("accepts a superseded, sized, non-archived binary (no age floor)", () => {
    expect(isEligible(rev("d", "v", 100), null)).toBe(true);
  });
  it("rejects the current revision (no superseded_at)", () => {
    expect(isEligible(rev("d", "v", 1, { superseded_at: null }), null)).toBe(false);
  });
  it("rejects already-archived, binary-less, or zero-size rows", () => {
    expect(isEligible(rev("d", "v", 100, { archived_at: daysAgo(1) }), null)).toBe(false);
    expect(isEligible(rev("d", "v", 100, { file_url: null }), null)).toBe(false);
    expect(isEligible(rev("d", "v", 100, { size: 0 }), null)).toBe(false);
  });
  it("honors an optional age floor", () => {
    const cutoff = new Date(NOW.getTime() - 90 * 86400 * 1000);
    expect(isEligible(rev("d", "v", 120), cutoff)).toBe(true);
    expect(isEligible(rev("d", "v", 30), cutoff)).toBe(false);
  });
});

describe("selectShedCandidates (keep last N per document)", () => {
  it("keeps the N newest revisions of each document, sheds the rest", () => {
    // Doc A: 4 revisions (v1 newest=current .. v4 oldest). keep 2 → shed v3, v4.
    const rows = [
      rev("A", "a1", 1, { superseded_at: null }), // current
      rev("A", "a2", 30),
      rev("A", "a3", 60),
      rev("A", "a4", 90),
    ];
    const sel = selectShedCandidates(rows, { keepPerDoc: 2, now: NOW });
    expect(sel.selected.map((r) => r.id).sort()).toEqual(["a3", "a4"]);
    expect(sel.totalBytes).toBe(2000);
  });

  it("never sheds when the document has N or fewer revisions", () => {
    const rows = [rev("B", "b1", 1, { superseded_at: null }), rev("B", "b2", 40)];
    expect(selectShedCandidates(rows, { keepPerDoc: 5, now: NOW }).totalCount).toBe(0);
  });

  it("applies the rule per document independently", () => {
    const rows = [
      rev("A", "a1", 1, { superseded_at: null }), rev("A", "a2", 20), rev("A", "a3", 40),
      rev("C", "c1", 2, { superseded_at: null }), rev("C", "c2", 25),
    ];
    // keep 1: A sheds a2,a3; C sheds c2.
    const sel = selectShedCandidates(rows, { keepPerDoc: 1, now: NOW });
    expect(sel.selected.map((r) => r.id).sort()).toEqual(["a2", "a3", "c2"]);
  });

  it("orders shed candidates oldest-superseded first and respects a byte target", () => {
    const rows = [
      rev("A", "a1", 1, { superseded_at: null }),
      rev("A", "a2", 100, { size: 600 }),
      rev("A", "a3", 200, { size: 600 }),
      rev("A", "a4", 300, { size: 600 }),
    ];
    const sel = selectShedCandidates(rows, { keepPerDoc: 1, now: NOW, targetBytes: 1000 });
    expect(sel.selected.map((r) => r.id)).toEqual(["a4", "a3"]); // oldest first, stop at 1200>=1000
    expect(sel.skipped).toBe(1);
  });

  it("can add an age floor on top of the keep-N rule", () => {
    const rows = [
      rev("A", "a1", 1, { superseded_at: null }), rev("A", "a2", 10), rev("A", "a3", 200),
    ];
    // keep 1 → a2,a3 are beyond N, but age floor 90d keeps a2 (only 10d old).
    const sel = selectShedCandidates(rows, { keepPerDoc: 1, olderThanDays: 90, now: NOW });
    expect(sel.selected.map((r) => r.id)).toEqual(["a3"]);
  });
});
