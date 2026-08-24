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
}));

vi.mock("@/lib/supabase", () => {
  function chain() {
    let pendingUpdate: Record<string, unknown> | null = null;
    let filters: Array<unknown[]> = [];
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        return (...args: unknown[]) => {
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

import { acknowledge } from "@/lib/distributionAcks";

beforeEach(() => {
  state.updates = [];
  state.updateResult = { data: [{ id: "ack1" }], error: null };
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
