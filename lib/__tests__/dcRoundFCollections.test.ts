// Document-control Round F (P9) — RET-10: deleting a folder no longer
// silently destroys folder-inherited retention, and the trash restore puts
// the stepped-up documents (and their clock) back.
//
//   · delete previews the re-clock BEFORE anything moves and refuses (409,
//     naming the count and sample deadlines) unless acknowledgeRetentionLoss
//     is passed; the FOLDER_DELETED detail records how many records lost a
//     deadline, which ones, and the stepped-up ids;
//   · restore reads that detail, moves back only the records still where the
//     delete left them, and re-clocks them against the restored folder.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Op = { m: string; args: unknown[] };
const state = vi.hoisted(() => ({
  resolve: ((_t: string, _o: Array<{ m: string; args: unknown[] }>) => ({ data: [], error: null })) as
    (table: string, ops: Array<{ m: string; args: unknown[] }>) => { data?: unknown; error?: unknown },
  audits: [] as Array<Record<string, unknown>>,
}));
const argOf = (ops: Op[], m: string) => ops.find((o) => o.m === m)?.args;
const filter = (ops: Op[], m: string, col: string) => ops.find((o) => o.m === m && o.args[0] === col)?.args[1];

vi.mock("@/lib/supabaseAdmin", () => {
  function chain(table: string) {
    const ops: Op[] = [];
    const run = () => {
      if (table === "audit_logs" && argOf(ops, "insert")) { state.audits.push(argOf(ops, "insert")![0] as Record<string, unknown>); return { data: null, error: null }; }
      return state.resolve(table, ops);
    };
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve().then(run).then(res, rej);
        return (...args: unknown[]) => {
          ops.push({ m: prop, args });
          if (prop === "maybeSingle") return Promise.resolve(run());
          if (prop === "select" && ops.some((o) => o.m === "update")) return Promise.resolve(run());
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabaseAdmin: { from: (t: string) => chain(t), auth: { getUser: async () => ({ data: { user: { id: "u1", email: "u@x" } }, error: null }) } } };
});
vi.mock("@/lib/knowledgeAccess", () => ({ loadPrincipal: vi.fn(async () => ({ isController: true })) }));
vi.mock("@/lib/serverCollections", () => ({ loadCollectionTree: vi.fn(async () => ({})), rebuildSubtreePaths: vi.fn(async () => undefined) }));

import { POST as DELETE_FOLDER } from "@/app/api/collections/delete/route";
import { POST as RESTORE_FOLDER } from "@/app/api/collections/trash/route";

const post = (url: string, body: unknown) => new NextRequest(url, {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify(body),
});
const P = { enabled: true, years: 30, basis: "created" as const };
const doc = (id: string, over: Record<string, unknown> = {}) => ({
  id, retention_policy: null, created_at: "2020-01-01T00:00:00Z", updated_at: null, effective_date: null,
  disposition_state: "active", retention_until: "2050-01-01", ...over,
});

beforeEach(() => { state.resolve = () => ({ data: [], error: null }); state.audits = []; });

/** A folder carrying a 30-year policy under a library with none. */
function deleteResolver(opts: { docs: Array<Record<string, unknown>>; reclocks: Array<Record<string, unknown>>; heirPolicy?: unknown }) {
  return (table: string, ops: Op[]) => {
    if (table === "collections") {
      if (argOf(ops, "update")) return { data: [], error: null };
      if (argOf(ops, "maybeSingle") && filter(ops, "eq", "id") === "heir") return { data: { retention_policy: opts.heirPolicy ?? null }, error: null };
      if (argOf(ops, "maybeSingle")) return { data: { id: "f1", org_id: "o1", library_id: "l1", parent_id: "heir", name: "Radiography", path_names: [], path_ids: [] }, error: null };
    }
    if (table === "libraries") return { data: { retention_policy: null }, error: null };
    if (table === "documents") {
      const upd = argOf(ops, "update")?.[0] as Record<string, unknown> | undefined;
      if (upd && "collection_id" in upd) return { data: opts.docs, error: null };
      if (upd) { opts.reclocks.push({ id: filter(ops, "eq", "id"), ...upd }); return { data: null, error: null }; }
      return { data: opts.docs, error: null };
    }
    return { data: [], error: null };
  };
}

describe("folder delete — RET-10 refuses to null a retention deadline silently", () => {
  it("refuses (409) with the count and sample deadlines when the heir has no policy; nothing moves", async () => {
    const reclocks: Array<Record<string, unknown>> = [];
    state.resolve = deleteResolver({ docs: [doc("d1"), doc("d2", { retention_until: "2056-03-01" }), doc("d3", { retention_until: null })], reclocks });
    const res = await DELETE_FOLDER(post("https://app/api/collections/delete", { orgId: "o1", collectionId: "f1" }));
    const body = (await res.json()) as { error: string; retentionLoss: { count: number; sample: Array<{ id: string; until: string }> } };
    expect(res.status).toBe(409);
    expect(body.retentionLoss.count).toBe(2);
    expect(body.retentionLoss.sample).toEqual([{ id: "d1", until: "2050-01-01" }, { id: "d2", until: "2056-03-01" }]);
    expect(body.error).toMatch(/remove the retention deadline from 2 record\(s\) \(e\.g\. until 2050-01-01, 2056-03-01\)/);
    expect(reclocks).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("proceeds when the heir carries a policy (no deadline is lost) and records zero lost", async () => {
    const reclocks: Array<Record<string, unknown>> = [];
    state.resolve = deleteResolver({ docs: [doc("d1")], reclocks, heirPolicy: { enabled: true, years: 7, basis: "created" } });
    const res = await DELETE_FOLDER(post("https://app/api/collections/delete", { orgId: "o1", collectionId: "f1" }));
    expect(res.status).toBe(200);
    expect(reclocks).toEqual([{ id: "d1", retention_until: "2027-01-01", disposition_state: "active" }]);
    expect(state.audits[0]).toMatchObject({ action: "FOLDER_DELETED", details: { retentionDeadlinesLost: 0, steppedDocIds: ["d1"], retentionLossAcknowledged: false } });
  });

  it("with acknowledgeRetentionLoss the delete proceeds and the audit detail names what was lost", async () => {
    const reclocks: Array<Record<string, unknown>> = [];
    state.resolve = deleteResolver({ docs: [doc("d1"), doc("d2", { retention_until: "2056-03-01" })], reclocks });
    const res = await DELETE_FOLDER(post("https://app/api/collections/delete", { orgId: "o1", collectionId: "f1", acknowledgeRetentionLoss: true }));
    const body = (await res.json()) as { ok: boolean; retentionDeadlinesLost: number };
    expect(res.status).toBe(200);
    expect(body.retentionDeadlinesLost).toBe(2);
    expect(reclocks.map((r) => r.retention_until)).toEqual([null, null]);
    expect(state.audits[0]).toMatchObject({
      action: "FOLDER_DELETED",
      details: {
        contentsMovedTo: "heir", steppedDocIds: ["d1", "d2"], retentionDeadlinesLost: 2, retentionLossAcknowledged: true,
        retentionDeadlinesLostSample: [{ id: "d1", until: "2050-01-01" }, { id: "d2", until: "2056-03-01" }],
      },
    });
  });

  it("fails closed when the preview read errors", async () => {
    state.resolve = (table, ops) => {
      if (table === "collections" && argOf(ops, "maybeSingle")) return { data: { id: "f1", org_id: "o1", library_id: "l1", parent_id: null, name: "x" }, error: null };
      if (table === "documents") return { data: null, error: { message: "timeout" } };
      return { data: [], error: null };
    };
    const res = await DELETE_FOLDER(post("https://app/api/collections/delete", { orgId: "o1", collectionId: "f1" }));
    expect(res.status).toBe(500);
    expect(state.audits).toEqual([]);
  });
});

describe("trash restore — RET-10 returns the stepped-up documents and re-clocks them", () => {
  it("moves back only the records still at the heir, re-clocked against the restored folder's policy", async () => {
    const moves: Array<Record<string, unknown>> = [];
    const reclocks: Array<Record<string, unknown>> = [];
    state.resolve = (table, ops) => {
      if (table === "collections") {
        if (argOf(ops, "update")) return { data: null, error: null };
        if (filter(ops, "eq", "id") === "heir") return { data: { id: "heir", deleted_at: null }, error: null };
        return { data: { id: "f1", org_id: "o1", library_id: "l1", parent_id: "heir", name: "Radiography", deleted_at: "2026-09-01", retention_policy: P }, error: null };
      }
      if (table === "audit_logs") return { data: [{ details: { contentsMovedTo: "heir", steppedDocIds: ["d1", "d2", "moved-on"] } }], error: null };
      if (table === "libraries") return { data: { retention_policy: null }, error: null };
      if (table === "documents") {
        const upd = argOf(ops, "update")?.[0] as Record<string, unknown>;
        if ("collection_id" in upd) {
          moves.push({ ids: filter(ops, "in", "id"), at: filter(ops, "eq", "collection_id"), to: upd.collection_id });
          // "moved-on" was moved elsewhere by a person since the delete → not at the heir → not returned.
          return { data: [doc("d1", { retention_until: null, disposition_state: null }), doc("d2", { retention_until: null, disposition_state: null })], error: null };
        }
        reclocks.push({ id: filter(ops, "eq", "id"), ...upd });
        return { data: null, error: null };
      }
      return { data: [], error: null };
    };
    const res = (await RESTORE_FOLDER(post("https://app/api/collections/trash", { orgId: "o1", collectionId: "f1" }))) as Response;
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(moves).toEqual([{ ids: ["d1", "d2", "moved-on"], at: "heir", to: "f1" }]);
    expect(reclocks).toEqual([
      { id: "d1", retention_until: "2050-01-01", disposition_state: "active" },
      { id: "d2", retention_until: "2050-01-01", disposition_state: "active" },
    ]);
    expect(body).toMatchObject({ ok: true, restoredToParent: "heir", documentsReturned: 2, retentionRecomputed: 2, retentionFailed: 0 });
    expect(state.audits[0]).toMatchObject({ action: "FOLDER_RESTORED", details: { documentsReturned: 2, retentionRecomputed: 2 } });
  });

  it("restores the shell alone, and says so, when no delete record names the documents", async () => {
    state.resolve = (table, ops) => {
      if (table === "collections") {
        if (argOf(ops, "update")) return { data: null, error: null };
        return { data: { id: "f1", org_id: "o1", library_id: "l1", parent_id: null, name: "x", deleted_at: "2026-09-01", retention_policy: null }, error: null };
      }
      return { data: [], error: null };
    };
    const res = (await RESTORE_FOLDER(post("https://app/api/collections/trash", { orgId: "o1", collectionId: "f1" }))) as Response;
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.documentsReturned).toBe(0);
    expect(body.note).toMatch(/No record of which documents the delete stepped up/);
  });
});
