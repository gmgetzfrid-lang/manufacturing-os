// Review-gate integrity, app half (RG-1 / RG-2).
//
// Signing must be pinned to the signer's OWN roster row with the result
// checked (a zero-row update was previously reported as success while the
// roster stayed pending — or, worse, a publisher could attach their signature
// to another reviewer's row). Completion must count only signature-backed
// rows, so a roster row born 'signed' with no e-signature never satisfies
// the gate.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  roster: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ patch: Record<string, unknown>; filters: Array<unknown[]> }>,
  updateResult: { data: [{ id: "so1" }] as unknown, error: null as unknown },
}));

function chain(table: string) {
  let pendingUpdate: Record<string, unknown> | null = null;
  let filters: Array<unknown[]> = [];
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) =>
          resolve({ data: table === "document_review_signoffs" ? state.roster : [], error: null });
      }
      return (...args: unknown[]) => {
        if (prop === "update") { pendingUpdate = args[0] as Record<string, unknown>; filters = []; }
        if (prop === "eq" || prop === "in") filters.push([prop, ...args]);
        if (prop === "select" && pendingUpdate) {
          state.updates.push({ patch: pendingUpdate, filters: [...filters] });
          pendingUpdate = null;
          return Promise.resolve(state.updateResult);
        }
        if (prop === "maybeSingle") {
          return Promise.resolve({ data: { owner_user_id: null, owner_name: null, collection_id: null }, error: null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async () => ({ id: "sig1" })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/ownership", () => ({
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: null, name: null })),
  resolveEffectiveOwner: vi.fn(() => ({ userId: null, name: null })),
  getOrgControllers: vi.fn(async () => []),
}));

import { recordReviewSignoff, reviewCompletionForDraft } from "@/lib/reviewControl";

beforeEach(() => {
  state.roster = [];
  state.updates = [];
  state.updateResult = { data: [{ id: "so1" }], error: null };
});

const signInput = {
  orgId: "org1", documentId: "doc1", libraryId: "lib1", versionId: "v1",
  revisionLabel: "2A", signoffId: "so1", signerUserId: "reviewer1",
  signerName: "Reviewer One", statement: "Reviewed and approved",
};

describe("recordReviewSignoff (RG-2)", () => {
  it("pins the signed write to the signer's OWN roster row", async () => {
    await recordReviewSignoff(signInput);
    const u = state.updates.find((x) => x.patch.status === "signed");
    expect(u).toBeDefined();
    expect(u!.filters).toContainEqual(["eq", "id", "so1"]);
    expect(u!.filters).toContainEqual(["eq", "reviewer_user_id", "reviewer1"]);
  });

  it("surfaces a zero-row signed update as an error instead of false success", async () => {
    state.updateResult = { data: [], error: null }; // RLS refusal / not their row
    await expect(recordReviewSignoff(signInput)).rejects.toThrow(/not yours to sign|named reviewer/i);
  });

  it("surfaces an update error", async () => {
    state.updateResult = { data: null, error: { message: "permission denied" } };
    await expect(recordReviewSignoff(signInput)).rejects.toThrow(/permission denied/);
  });
});

describe("reviewCompletionForDraft (RG-1)", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "r1", document_version_id: "v1", reviewer_user_id: "u1", slot: "primary",
    status: "pending", signature_id: null, signed_at: null, assigned_at: "2026-08-01",
    ...over,
  });

  it("a signed row WITH a bound signature completes the gate", async () => {
    state.roster = [row({ id: "r1", status: "signed", signature_id: "sig1" })];
    const res = await reviewCompletionForDraft("doc1", "v1");
    expect(res.complete).toBe(true);
  });

  it("a row born 'signed' with NO signature never satisfies the gate", async () => {
    state.roster = [
      row({ id: "r1", status: "pending" }),
      // The RG-1 forgery shape: alternate row inserted pre-signed, no signature.
      row({ id: "r2", slot: "alternate", status: "signed", signature_id: null }),
    ];
    const res = await reviewCompletionForDraft("doc1", "v1");
    expect(res.signed).toBe(0);
    expect(res.complete).toBe(false);
  });
});

describe("Phase 4 review-gate migration shape (RG-1/RG-2 DB rails)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261030_dc_phase4_review_gate.sql"), "utf8");

  it("INSERT policy forbids rows born signed", () => {
    // [^;]* spans newlines on its own — no /s flag (tsc targets pre-es2018).
    expect(sql).toMatch(/doc_review_signoff_insert[^;]*status = 'pending'[^;]*signature_id IS NULL/);
  });

  it("the signing trigger binds the transition to the reviewer's own signature", () => {
    expect(sql).toMatch(/CREATE TRIGGER trg_review_signoff_guard\s+BEFORE UPDATE ON document_review_signoffs/);
    expect(sql).toMatch(/Only the named reviewer can sign/);
    expect(sql).toMatch(/e\.signer_user_id::text = auth\.uid\(\)::text/);
  });

  it("the publish guard counts only signature-backed sign-offs, org-matched", () => {
    expect(sql).toMatch(/e\.signer_user_id = s\.reviewer_user_id/);
    expect(sql).toMatch(/e\.org_id = s\.org_id/);
    // search_path must be restated or CREATE OR REPLACE drops the 20261020 pin.
    expect(sql).toMatch(/enforce_document_publish_guard\(\)\s*\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
  });
});
