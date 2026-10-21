// DIST-4: a pending distribution ack binds only while its version IS the
// document's current version and the document is alive. A Rev-4 row after
// Rev 5 issues used to be IMMORTAL — in the inbox forever, cron-nagged every
// 3 days, counted by the register — while the (version-scoped) confirm bar
// could never render to clear it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Array<unknown[]> }>,
  updateResult: { data: [{ id: "a1" }, { id: "a2" }] as unknown, error: null as unknown },
}));

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    let pendingUpdate: Record<string, unknown> | null = null;
    let filters: Array<unknown[]> = [];
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: state.tables[table] ?? [], error: null });
        }
        return (...args: unknown[]) => {
          if (prop === "update") { pendingUpdate = args[0] as Record<string, unknown>; filters = []; }
          if (prop === "eq" || prop === "is" || prop === "neq") filters.push([prop, ...args]);
          if (prop === "select" && pendingUpdate) {
            state.updates.push({ table, patch: pendingUpdate, filters: [...filters] });
            pendingUpdate = null;
            return Promise.resolve(state.updateResult);
          }
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn() }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn() }));

import { listMyPendingDistributionAcks, closeStaleAcksForDocument, closeStaleAcksForDocumentChecked } from "@/lib/distributionAcks";

beforeEach(() => {
  state.tables = {};
  state.updates = [];
  state.updateResult = { data: [{ id: "a1" }, { id: "a2" }], error: null };
});

const ack = (id: string, docId: string, versionId: string) => ({
  id, document_id: docId, version_id: versionId, rev_label: "4",
  requested_at: "2026-08-01T00:00:00Z", requested_by_name: "DocCtrl",
});

describe("listMyPendingDistributionAcks currency scope (DIST-4)", () => {
  it("drops an ack on a NON-CURRENT version and keeps the current-version one", async () => {
    state.tables.distribution_acks = [ack("a1", "d1", "v4"), ack("a2", "d2", "v9")];
    state.tables.documents = [
      { id: "d1", document_number: "P-101", current_version_id: "v5", status: "Issued" },
      { id: "d2", document_number: "P-102", current_version_id: "v9", status: "Issued" },
    ];
    const out = await listMyPendingDistributionAcks("org1", "u1");
    expect(out.map((o) => o.ackId)).toEqual(["a2"]);
  });

  it("drops an ack on a retired document, even at its final version", async () => {
    state.tables.distribution_acks = [ack("a1", "d1", "v5")];
    state.tables.documents = [
      { id: "d1", document_number: "P-101", current_version_id: "v5", status: "Superseded" },
    ];
    expect(await listMyPendingDistributionAcks("org1", "u1")).toEqual([]);
  });
});

describe("closeStaleAcksForDocument (DIST-4)", () => {
  it("closes only PENDING, un-closed rows of other versions on publish", async () => {
    const n = await closeStaleAcksForDocument("d1", "v5");
    expect(n).toBe(2);
    const u = state.updates[0];
    expect(u.table).toBe("distribution_acks");
    expect(u.patch.superseded_at).toBeTruthy();
    expect(u.filters).toContainEqual(["eq", "document_id", "d1"]);
    expect(u.filters).toContainEqual(["is", "acknowledged_at", null]);
    expect(u.filters).toContainEqual(["is", "superseded_at", null]);
    expect(u.filters).toContainEqual(["neq", "version_id", "v5"]);
  });

  it("closes EVERY pending row on retirement (no version survives)", async () => {
    await closeStaleAcksForDocument("d1", null);
    const u = state.updates[0];
    expect(u.filters.some((f) => f[0] === "neq")).toBe(false);
    expect(u.filters).toContainEqual(["is", "acknowledged_at", null]);
  });

  it("no-ops quietly on a pre-20261035 database", async () => {
    state.updateResult = { data: null, error: { code: "42703", message: "superseded_at does not exist" } };
    expect(await closeStaleAcksForDocument("d1", "v5")).toBe(0);
  });
});

describe("closeStaleAcksForDocumentChecked (REV-34 (c), document-control P34 final fix pass)", () => {
  it("runs closeStaleAcksForDocument's one statement and answers its outcome: the count closed, or the refusal / throw", async () => {
    expect(await closeStaleAcksForDocumentChecked("d1", null)).toEqual({ closed: 2, error: null });
    expect(state.updates[0].filters.some((f) => f[0] === "neq")).toBe(false);
    expect(await closeStaleAcksForDocumentChecked("d1", "v5")).toEqual({ closed: 2, error: null });
    expect(state.updates[1].filters).toContainEqual(["neq", "version_id", "v5"]);
    state.updateResult = { data: null, error: { code: "42501", message: "permission denied for table distribution_acks" } };
    expect(await closeStaleAcksForDocumentChecked("d1", null)).toEqual({ closed: 0, error: { code: "42501", message: "permission denied for table distribution_acks" } });
    state.updateResult = { data: null, error: { code: "42703", message: "superseded_at does not exist" } };
    expect(await closeStaleAcksForDocumentChecked("d1", null)).toEqual({ closed: 0, error: { code: "42703", message: "superseded_at does not exist" } });
    state.updateResult = Promise.reject(new Error("network down")) as unknown as typeof state.updateResult;
    (state.updateResult as unknown as Promise<unknown>).catch(() => {});
    expect(await closeStaleAcksForDocumentChecked("d1", null)).toEqual({ closed: 0, error: { code: null, message: "network down" } });
  });

  it("PIN: closeStaleAcksForDocument's answer to every caller is what it was — the count on success, 0 on a refusal, a missing column or a throw; never throws", async () => {
    expect(await closeStaleAcksForDocument("d1", "v5")).toBe(2);
    state.updateResult = { data: [], error: null };
    expect(await closeStaleAcksForDocument("d1", null)).toBe(0);
    state.updateResult = { data: null, error: { code: "42501", message: "denied" } };
    expect(await closeStaleAcksForDocument("d1", null)).toBe(0);
    state.updateResult = { data: null, error: { code: "42703", message: "superseded_at does not exist" } };
    expect(await closeStaleAcksForDocument("d1", "v5")).toBe(0);
    state.updateResult = Promise.reject(new Error("network down")) as unknown as typeof state.updateResult;
    (state.updateResult as unknown as Promise<unknown>).catch(() => {});
    await expect(closeStaleAcksForDocument("d1", "v5")).resolves.toBe(0);
    // the same statement, filters and patch as before
    for (const u of state.updates) {
      expect(u.table).toBe("distribution_acks");
      expect(Object.keys(u.patch)).toEqual(["superseded_at"]);
      expect(u.filters.slice(0, 3)).toEqual([["eq", "document_id", "d1"], ["is", "acknowledged_at", null], ["is", "superseded_at", null]]);
    }
  });
});
