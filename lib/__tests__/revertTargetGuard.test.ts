// REV-2: the revert TARGET must be a previously-ISSUED revision. An
// in-review or rejected draft never passed the review gate, and an
// unreconciled branch was explicitly parked — reverting one promotes
// unreviewed bytes to the controlled copy through the one path the DB
// review-completion guard cannot see (the fresh revert row has no roster).

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/holds", () => ({ listActiveHoldsForDocument: vi.fn() }));

import { assertRevertableTarget } from "@/lib/documentGuards";

describe("assertRevertableTarget (REV-2)", () => {
  it("refuses an in-review draft, naming the state", () => {
    expect(() => assertRevertableTarget({ revisionLabel: "3A", reviewState: "in_review" }))
      .toThrow(/unreviewed draft \(in review\)/);
  });

  it("refuses a rejected draft — and any future non-approved state", () => {
    expect(() => assertRevertableTarget({ revisionLabel: "3A", reviewState: "rejected" }))
      .toThrow(/unreviewed draft/);
    expect(() => assertRevertableTarget({ revisionLabel: "3A", reviewState: "pending_signoff" }))
      .toThrow(/unreviewed draft/);
  });

  it("refuses an unreconciled branch, even an approved one", () => {
    expect(() => assertRevertableTarget({ revisionLabel: "4B", isBranch: true }))
      .toThrow(/unreconciled branch/);
    expect(() => assertRevertableTarget({ revisionLabel: "4B", isBranch: true, reviewState: "approved" }))
      .toThrow(/unreconciled branch/);
  });

  it("passes a previously-issued revision (null review state) and an approved one", () => {
    expect(() => assertRevertableTarget({ revisionLabel: "2" })).not.toThrow();
    expect(() => assertRevertableTarget({ revisionLabel: "2", reviewState: null })).not.toThrow();
    expect(() => assertRevertableTarget({ revisionLabel: "2", reviewState: "approved", isBranch: false }))
      .not.toThrow();
  });
});
