// lib/__tests__/docControlRegister.test.ts
import { describe, it, expect } from "vitest";
import { computeRegisterKpis, filterRegister, registerToCsv, type RegisterRow } from "@/lib/docControlRegister";

function row(p: Partial<RegisterRow> = {}): RegisterRow {
  return {
    id: "d1", number: "P-101", title: "Flare header", libraryId: "lib1", libraryName: "P&IDs",
    status: "Issued", rev: "2", updatedAt: null,
    ownerName: "Alice", ownerUserId: "u1", owned: true,
    nextReviewDate: null, reviewStatus: "none", reviewDaysLeft: null,
    ack: null, ackStatus: "none",
    review: null,
    effectiveDate: null, effectivePending: false,
    ...p,
  };
}

describe("computeRegisterKpis", () => {
  it("counts unowned / overdue / due-soon / acks / in-review across rows", () => {
    const rows = [
      row({ owned: false }),
      row({ reviewStatus: "overdue" }),
      row({ reviewStatus: "due_soon" }),
      row({ ackStatus: "partial" }),
      row({ ackStatus: "overdue" }),
      row({ review: { inReview: true, requiredPrimaries: 2, signed: 1, ready: false, revisionLabel: "2A" } }),
      row({ review: { inReview: true, requiredPrimaries: 2, signed: 2, ready: true, revisionLabel: "2A" } }),
    ];
    const k = computeRegisterKpis(rows);
    expect(k.totalControlled).toBe(7);
    expect(k.unowned).toBe(1);
    expect(k.reviewsOverdue).toBe(1);
    expect(k.reviewsDueSoon).toBe(1);
    expect(k.acksOutstanding).toBe(2);
    expect(k.inReview).toBe(2);
    expect(k.reviewsReady).toBe(1);
  });
  it("treats a fully-acknowledged / current doc as clean", () => {
    const k = computeRegisterKpis([row({ ackStatus: "complete", reviewStatus: "current" })]);
    expect(k).toMatchObject({ unowned: 0, reviewsOverdue: 0, acksOutstanding: 0, inReview: 0 });
  });
});

describe("filterRegister", () => {
  const rows = [
    row({ id: "a", number: "P-101", owned: true, libraryId: "lib1" }),
    row({ id: "b", number: "P-202", owned: false, libraryId: "lib1", reviewStatus: "overdue" }),
    row({ id: "c", number: "OP-1", owned: true, libraryId: "lib2", ackStatus: "partial" }),
    row({ id: "d", number: "OP-2", owned: true, libraryId: "lib2", review: { inReview: true, requiredPrimaries: 1, signed: 0, ready: false, revisionLabel: "3A" } }),
  ];
  it("filters by status facet", () => {
    expect(filterRegister(rows, "unowned", null, "").map((r) => r.id)).toEqual(["b"]);
    expect(filterRegister(rows, "review_overdue", null, "").map((r) => r.id)).toEqual(["b"]);
    expect(filterRegister(rows, "acks_outstanding", null, "").map((r) => r.id)).toEqual(["c"]);
    expect(filterRegister(rows, "in_review", null, "").map((r) => r.id)).toEqual(["d"]);
  });
  it("filters by library and free-text search", () => {
    expect(filterRegister(rows, "all", "lib2", "").map((r) => r.id)).toEqual(["c", "d"]);
    expect(filterRegister(rows, "all", null, "202").map((r) => r.id)).toEqual(["b"]);
  });
});

describe("registerToCsv", () => {
  it("emits a header + one line per row and escapes commas", () => {
    const csv = registerToCsv([row({ title: "Flare, header", ack: { required: 12, done: 8, pending: 4, waived: 0, hardGate: false, oldestPendingAt: null } })]);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Document");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Flare, header"');
    expect(lines[1]).toContain("8/12");
  });
});
