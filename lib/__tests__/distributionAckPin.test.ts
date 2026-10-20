// Acknowledging a distribution is the RECIPIENT'S OWN act (DIST-3).
//
// acknowledge() previously filtered by id alone — any member could stamp
// another person's row and the "N of M confirmed" register became a forgery.
// These tests pin the app half of the fix: the update is scoped to the
// recipient's own still-pending row, and a zero-row result throws instead of
// reading as success.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  updates: [] as Array<{ patch: Record<string, unknown>; filters: Array<unknown[]> }>,
  updateResult: { data: [{ id: "ack1" }] as unknown, error: null as unknown },
  readResult: { data: null as unknown, error: null as unknown },
  audits: [] as Array<Record<string, unknown>>,
  auditResult: { ok: true } as { ok: true } | { ok: false; error: string },
}));

vi.mock("@/lib/supabase", () => {
  function chain() {
    let pendingUpdate: Record<string, unknown> | null = null;
    let filters: Array<unknown[]> = [];
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return undefined;
        return (...args: unknown[]) => {
          if (prop === "maybeSingle") return Promise.resolve(state.readResult);
          if (prop === "update") { pendingUpdate = args[0] as Record<string, unknown>; filters = []; }
          if (prop === "eq" || prop === "is") filters.push([prop, ...args]);
          if (prop === "select" && pendingUpdate) {
            state.updates.push({ patch: pendingUpdate, filters: [...filters] });
            pendingUpdate = null;
            return Promise.resolve(state.updateResult);
          }
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: () => chain() } };
});
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn() }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (row: Record<string, unknown>) => { state.audits.push(row); return state.auditResult; }),
}));

import { acknowledge } from "@/lib/distributionAcks";

beforeEach(() => {
  state.updates = [];
  state.updateResult = { data: [{ id: "ack1" }], error: null };
  state.readResult = {
    data: { org_id: "o1", document_id: "d1", version_id: "v1", rev_label: "B", acknowledged_at: "2026-10-20T10:00:00Z" },
    error: null,
  };
  state.audits = [];
  state.auditResult = { ok: true };
});

describe("acknowledge (DIST-3)", () => {
  it("pins the update to the recipient's OWN still-pending row and checks it", async () => {
    await acknowledge("ack1", "user-rec");
    expect(state.updates).toHaveLength(1);
    const u = state.updates[0];
    expect(u.patch.acknowledged_at).toBeTruthy();
    expect(u.filters).toContainEqual(["eq", "id", "ack1"]);
    // THE fix: the row must belong to the caller…
    expect(u.filters).toContainEqual(["eq", "recipient_user_id", "user-rec"]);
    // …and must not already be stamped (re-stamping rewrites history).
    expect(u.filters).toContainEqual(["is", "acknowledged_at", null]);
  });

  it("throws on zero rows — someone else's (or an already-stamped) ack never reads as success", async () => {
    state.updateResult = { data: [], error: null };
    await expect(acknowledge("ack1", "user-imposter")).rejects.toThrow(/isn't yours to sign/);
  });

  it("surfaces a database error instead of swallowing it", async () => {
    state.updateResult = { data: null, error: { message: "permission denied" } };
    await expect(acknowledge("ack1", "user-rec")).rejects.toThrow("permission denied");
  });
});

describe("acknowledge writes its own audit row (drafting-flow EVID-2 done-when 4)", () => {
  it("a confirmation writes ACK_DISTRIBUTION_CONFIRMED naming the person, the document and the revision", async () => {
    const r = await acknowledge("ack1", "user-rec", { email: "rec@x", role: "Engineer" });
    expect(r).toEqual({ auditRecorded: true, auditError: null });
    expect(state.audits).toHaveLength(1);
    const a = state.audits[0];
    expect(a.action).toBe("ACK_DISTRIBUTION_CONFIRMED");
    expect(a.orgId).toBe("o1");
    expect(a.resourceId).toBe("d1");
    expect(a.userId).toBe("user-rec");
    expect(a.userEmail).toBe("rec@x");
    expect(a.details).toEqual({ ackId: "ack1", versionId: "v1", revLabel: "B", acknowledgedAt: "2026-10-20T10:00:00Z" });
  });
  it("a refused audit row is RETURNED, not swallowed — the confirmation itself still stands", async () => {
    state.auditResult = { ok: false, error: "audit insert refused" };
    const r = await acknowledge("ack1", "user-rec");
    expect(r).toEqual({ auditRecorded: false, auditError: "audit insert refused" });
    expect(state.updates).toHaveLength(1);
  });
  it("a row that cannot be re-read says so instead of writing an unattributed audit row", async () => {
    state.readResult = { data: null, error: { message: "timeout" } };
    const r = await acknowledge("ack1", "user-rec");
    expect(r.auditRecorded).toBe(false);
    expect(r.auditError).toMatch(/could not be re-read.*timeout/);
    expect(state.audits).toHaveLength(0);
  });
  it("a refused confirmation writes no audit row", async () => {
    state.updateResult = { data: [], error: null };
    await expect(acknowledge("ack1", "user-imposter")).rejects.toThrow(/isn't yours to sign/);
    expect(state.audits).toHaveLength(0);
  });
});
