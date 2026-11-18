// drafting-flow EVID-11 done-when 2 — F4 SIGNATURE TRANSACTION, the two
// roster ceremonies: recordAcknowledgment and recordReviewSignoff name their
// roster row to the signing route; when the route wrote it in the signature's
// transaction (20261269 pasted: `pairedRosterIds`) they do not write it again,
// and everything after the write (the completion notice, the publisher's
// notice) runs as before; when it did not (before the paste) their own write
// is today's, filter for filter and patch for patch.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  sig: { id: "sig1" } as Record<string, unknown>,
  sigCalls: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; patch: Row; filters: unknown[][] }>,
  reads: [] as string[],
  updateResult: { data: [{ id: "row1" }] as unknown, error: null as unknown },
}));
function chain(table: string) {
  let pending: Row | null = null;
  let filters: unknown[][] = [];
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => { state.reads.push(table); resolve({ data: [], error: null, count: 0 }); };
      }
      return (...args: unknown[]) => {
        if (prop === "update") { pending = args[0] as Row; filters = []; }
        if (prop === "eq" || prop === "in") filters.push([prop, ...args]);
        if (prop === "select" && pending) {
          state.updates.push({ table, patch: pending, filters: [...filters] });
          pending = null;
          return Promise.resolve(state.updateResult);
        }
        if (prop === "maybeSingle") {
          state.reads.push(table);
          return Promise.resolve({ data: { owner_user_id: null, owner_name: null, collection_id: null, library_id: "lib1", created_by: "author1" }, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async (input: Record<string, unknown>) => { state.sigCalls.push(input); return state.sig; }) }));
vi.mock("@/lib/complianceNotify", () => ({ notifyCompliance: vi.fn(async () => true), loadScanRetryPlan: vi.fn() }));
vi.mock("@/lib/notify/dispatch", () => ({ pushAfterBellRows: vi.fn(), emit: vi.fn() }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/ownership", () => ({
  resolveEffectiveOwner: vi.fn(() => ({ userId: null, name: null })), effectiveOwnerForDocument: vi.fn(async () => ({ userId: null })),
  getOrgControllers: vi.fn(async () => []), teamSupervisorMap: vi.fn(),
}));

import { recordAcknowledgment } from "@/lib/acknowledgments";
import { recordReviewSignoff } from "@/lib/reviewControl";

beforeEach(() => {
  state.sig = { id: "sig1" }; state.sigCalls = []; state.updates = []; state.reads = [];
  state.updateResult = { data: [{ id: "row1" }], error: null };
});

const ackInput = { orgId: "o1", documentId: "d1", documentVersionId: "v1", rosterId: "a1", signerUserId: "u1", signerName: "Ann", statement: "Read and understood" };
const reviewInput = { orgId: "o1", documentId: "d1", libraryId: "lib1", versionId: "v1", revisionLabel: "1A", signoffId: "so1", signerUserId: "rev1", signerName: "Rex", statement: "Reviewed" };

describe("recordAcknowledgment", () => {
  it("names its roster row to the route (the row id when it has one)", async () => {
    await recordAcknowledgment(ackInput);
    expect(state.sigCalls[0].pair).toEqual({ kind: "acknowledgment", rosterId: "a1" });
    await recordAcknowledgment({ ...ackInput, rosterId: undefined } as unknown as typeof ackInput);
    expect(state.sigCalls[1].pair).toEqual({ kind: "acknowledgment", rosterId: null });
  });
  it("before the paste: today's write — the signer's own pending row, today's patch", async () => {
    await recordAcknowledgment(ackInput);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].table).toBe("document_acknowledgments");
    expect(state.updates[0].patch).toMatchObject({ status: "acknowledged", signature_id: "sig1" });
    expect(Object.keys(state.updates[0].patch).sort()).toEqual(["acknowledged_at", "signature_id", "status", "updated_at"]);
    expect(state.updates[0].filters).toEqual([["eq", "assignee_user_id", "u1"], ["eq", "status", "pending"], ["eq", "id", "a1"]]);
  });
  it("after the paste: the route wrote it in the signature's transaction — no second write; the completion check still runs", async () => {
    state.sig = { id: "sig1", pairedRosterIds: ["a1"] };
    await recordAcknowledgment(ackInput);
    expect(state.updates).toEqual([]);
    expect(state.reads).toContain("document_acknowledgments"); // maybeNotifyComplete's count
  });
  it("an empty answer is never 'Signed'", async () => {
    state.sig = { id: "sig1", pairedRosterIds: [] };
    await expect(recordAcknowledgment(ackInput)).rejects.toThrow(/no pending acknowledgment of yours/);
  });
});

describe("recordReviewSignoff", () => {
  it("names its roster row to the route", async () => {
    await recordReviewSignoff(reviewInput);
    expect(state.sigCalls[0].pair).toEqual({ kind: "review_signoff", signoffId: "so1" });
  });
  it("before the paste: today's write — the signer's own row, today's patch; a zero-row write is still an error", async () => {
    await recordReviewSignoff(reviewInput);
    const u = state.updates.filter((x) => x.table === "document_review_signoffs");
    expect(u).toHaveLength(1);
    expect(Object.keys(u[0].patch).sort()).toEqual(["signature_id", "signed_at", "status", "updated_at"]);
    expect(u[0].filters).toEqual([["eq", "id", "so1"], ["eq", "reviewer_user_id", "rev1"]]);
    state.updateResult = { data: [], error: null };
    await expect(recordReviewSignoff(reviewInput)).rejects.toThrow(/not yours to sign/);
  });
  it("after the paste: no second write; the completion read that follows still runs", async () => {
    state.sig = { id: "sig1", pairedRosterIds: ["so1"] };
    state.reads = [];
    await recordReviewSignoff(reviewInput);
    expect(state.updates.filter((x) => x.table === "document_review_signoffs")).toEqual([]);
    expect(state.reads).toContain("document_review_signoffs"); // reviewCompletionForDraft
    state.sig = { id: "sig1", pairedRosterIds: [] };
    await expect(recordReviewSignoff(reviewInput)).rejects.toThrow(/not yours to sign/);
  });
});
