// OWN-14 — a refused write must fail LOUDLY, and the audit trail must never
// record an action that did not happen.
//
// PostgREST returns 200 with zero rows when RLS/a trigger refuses an update,
// so the old unchecked `.update()` sites reported success, wrote
// OWNER_ASSIGNED / hold_placed audit rows for writes that never landed, and
// congratulated owners who were never assigned. These tests pin the checked
// shape at the highest-consequence funnels.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  // Each entry consumed by one UPDATE...select() in call order.
  updateResults: [] as Array<{ data: unknown; error: unknown }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  audits: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<{ table: string; rows: unknown }>,
  notifies: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    let pendingUpdate = false;
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: state.tables[table] ?? [], error: null });
        }
        return (...args: unknown[]) => {
          if (prop === "update") pendingUpdate = true;
          if (prop === "insert") {
            state.inserts.push({ table, rows: args[0] });
            return Promise.resolve({ data: null, error: null });
          }
          if (prop === "select" && pendingUpdate) {
            pendingUpdate = false;
            return Promise.resolve(state.updateResults.shift() ?? { data: [], error: null });
          }
          if (prop === "maybeSingle") {
            return Promise.resolve({ data: (state.tables[table] ?? [])[0] ?? null, error: null });
          }
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (p: Record<string, unknown>) => { state.audits.push(p); }),
}));
vi.mock("@/lib/inAppNotifications", () => ({
  notify: vi.fn(async (p: Record<string, unknown>) => { state.notifies.push(p); }),
}));

import { setOwner, setLibraryOwnerTeam } from "@/lib/ownership";
import { placeLegalHold } from "@/lib/retention";

beforeEach(() => {
  state.updateResults = [];
  state.tables = {};
  state.audits = [];
  state.inserts = [];
  state.notifies = [];
});

describe("setOwner (OWN-14 — the single ownership funnel)", () => {
  it("a refused write throws and writes NO audit row and NO owner notification", async () => {
    state.updateResults = [{ data: [], error: null }];
    await expect(setOwner({
      level: "document", id: "d1", orgId: "org1",
      userId: "new-owner", name: "New Owner", actorId: "grabber",
    })).rejects.toThrow(/NOT changed/);
    expect(state.audits).toHaveLength(0);
    expect(state.notifies).toHaveLength(0);
  });

  it("a database error surfaces instead of a phantom success", async () => {
    state.updateResults = [{ data: null, error: { message: "not permitted" } }];
    await expect(setOwner({
      level: "library", id: "l1", orgId: "org1",
      userId: "u1", name: "U", actorId: "actor",
    })).rejects.toThrow("not permitted");
    expect(state.audits).toHaveLength(0);
  });

  it("a landed write audits and notifies the new owner", async () => {
    state.updateResults = [{ data: [{ id: "d1" }], error: null }];
    await setOwner({
      level: "document", id: "d1", orgId: "org1",
      userId: "new-owner", name: "New Owner", actorId: "ctrl",
    });
    expect(state.audits.map((a) => a.action)).toEqual(["OWNER_ASSIGNED"]);
    expect(state.notifies).toHaveLength(1);
  });
});

describe("setLibraryOwnerTeam (OWN-14)", () => {
  it("zero rows throws before the audit row", async () => {
    state.updateResults = [{ data: [], error: null }];
    await expect(setLibraryOwnerTeam({
      libraryId: "l1", orgId: "org1", teamId: "t1", actorId: "actor",
    })).rejects.toThrow(/NOT changed/);
    expect(state.audits).toHaveLength(0);
  });
});

describe("placeLegalHold (OWN-14 — the count is real)", () => {
  it("a partially refused hold throws with the true count and logs nothing", async () => {
    // Library scope with 60 documents → two batches of 50 + 10.
    state.tables.documents = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}` }));
    state.updateResults = [
      { data: Array.from({ length: 50 }, (_, i) => ({ id: `d${i}` })), error: null },
      { data: [], error: null }, // second batch refused
    ];
    await expect(placeLegalHold({
      scope: "library", id: "lib1", orgId: "org1", matter: "M-1", actorId: "ctrl",
    })).rejects.toThrow(/50 of 60/);
    // No hold_placed event, no notifications — the log must not assert a hold
    // that only partially exists.
    expect(state.inserts.filter((i) => i.table !== "documents")).toHaveLength(0);
    expect(state.notifies).toHaveLength(0);
  });

  it("a fully landed hold returns the real count", async () => {
    state.tables.documents = [{ id: "d1" }];
    state.updateResults = [{ data: [{ id: "d1" }], error: null }];
    const n = await placeLegalHold({
      scope: "library", id: "lib1", orgId: "org1", matter: "M-1", actorId: "ctrl",
    });
    expect(n).toBe(1);
  });
});
