// lib/__tests__/aoRoundGP14Orphans.test.ts
//
// admin-and-org Round G, package P14 (export / restore remainders).
//
//   intelligence ILIFE-1 criterion 3 / admin-and-org ALOG-8 (the orphans site)
//                  the purge's STORAGE_ORPHANS_PURGED row names the keys it
//                  deleted — a bounded list plus the count — through a CHECKED
//                  write: a refused row is in the answer (auditError) and
//                  logged, never a silent success. The answer keeps its shape.
//   intelligence ILIFE-8 (referencedKeys)
//                  the scan's referencedKeys counts only referenced keys
//                  under the caller's orgs/<orgId>/ prefix, never the
//                  deployment's total; the reference SET stays bucket-wide
//                  (DEC-57), so another tenant's reference still protects a key.
//
// Harness: vi.hoisted state + a Proxy chain for the service-role client and a
// mocked R2 (the lib/__tests__/dcRoundFShed.test.ts pattern).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Op = { m: string; args: unknown[] };
const state = vi.hoisted(() => ({
  resolve: ((_table: string, _ops: Array<{ m: string; args: unknown[] }>) => ({ data: [], error: null })) as
    (table: string, ops: Array<{ m: string; args: unknown[] }>) => { data?: unknown; error?: unknown; count?: number },
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  r2Deletes: [] as string[],
  listing: [] as Array<{ Key: string; Size: number; LastModified: Date }>,
}));

const argOf = (ops: Op[], m: string) => ops.find((o) => o.m === m)?.args;

function chain(table: string) {
  const ops: Op[] = [];
  const run = () => {
    const ins = ops.find((o) => o.m === "insert");
    if (ins) state.inserts.push({ table, row: ins.args[0] as Record<string, unknown> });
    return state.resolve(table, ops);
  };
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve().then(run).then(res, rej);
      }
      return (...args: unknown[]) => {
        ops.push({ m: prop, args });
        if (prop === "maybeSingle") return Promise.resolve(run());
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async () => ({ admin: { from: (t: string) => chain(t) }, userId: "admin1", email: "a@x", role: "Admin", roles: ["Admin"] })),
}));
vi.mock("@/lib/r2", () => ({
  r2: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown> }) => {
      const input = cmd.input ?? {};
      if (input.Delete) {
        for (const o of (input.Delete as { Objects: Array<{ Key: string }> }).Objects) state.r2Deletes.push(o.Key);
        return { Errors: [] };
      }
      return { Contents: state.listing, IsTruncated: false };
    }),
  },
  R2_BUCKET: "b",
}));

import { scanOrphans, deleteOrphans, referencedUnder, orphanPurgeAuditDetails, ORPHAN_AUDIT_KEY_CAP } from "@/lib/storageOrphans";
import { GET as ORPHANS_GET, POST as ORPHANS_POST } from "@/app/api/admin/orphans/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const old = new Date(Date.now() - 30 * 86400_000);
const sb = { from: (t: string) => chain(t) } as never;

/** document_versions references one key under each org; every other source is empty. */
function referencing(keys: string[]) {
  state.resolve = (table, ops) => {
    if (argOf(ops, "select")?.[1]) return { data: null, error: null, count: table === "document_versions" ? keys.length : 0 };
    if (table === "document_versions" && !ops.some((o) => o.m === "in")) {
      return { data: keys.map((k, i) => ({ id: `v${i}`, file_url: k, source_file_key: null })), error: null };
    }
    if (table === "audit_logs") return { data: null, error: null };
    return { data: [], error: null };
  };
}

beforeEach(() => {
  state.resolve = () => ({ data: [], error: null });
  state.inserts = [];
  state.r2Deletes = [];
  state.listing = [];
});

describe("ILIFE-8 — the scan reports the caller's prefix only", () => {
  it("referencedKeys counts the referenced keys under orgs/<orgId>/, never another tenant's", async () => {
    referencing([`orgs/${ORG}/a.pdf`, `orgs/${OTHER}/b.pdf`, `orgs/${OTHER}/c.pdf`]);
    state.listing = [{ Key: `orgs/${ORG}/a.pdf`, Size: 10, LastModified: old }];
    const scan = await scanOrphans(sb, ORG);
    expect(scan.referencedKeys).toBe(1);
    expect(scan.orphans).toEqual([]);
  });

  it("the reference SET stays bucket-wide (DEC-57): a key under this prefix that another tenant's row names is still protected", async () => {
    referencing([`orgs/${ORG}/shared.pdf`]);
    state.listing = [{ Key: `orgs/${ORG}/shared.pdf`, Size: 10, LastModified: old }, { Key: `orgs/${ORG}/orphan.pdf`, Size: 5, LastModified: old }];
    const scan = await scanOrphans(sb, ORG);
    expect(scan.orphans.map((o) => o.key)).toEqual([`orgs/${ORG}/orphan.pdf`]);
  });

  it("GET answers the prefix-scoped count", async () => {
    referencing([`orgs/${ORG}/a.pdf`, `orgs/${OTHER}/b.pdf`]);
    const res = await ORPHANS_GET(new NextRequest(`https://app/api/admin/orphans?orgId=${ORG}`, { headers: { authorization: "Bearer t" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.referencedKeys).toBe(1);
    expect(body.scope).toBe(`orgs/${ORG}/`);
  });

  it("referencedUnder is a prefix count", () => {
    expect(referencedUnder(new Set(["orgs/x/1", "orgs/x/2", "orgs/y/1", "orgs/xx/1"]), "orgs/x/")).toBe(2);
  });
});

describe("ILIFE-1 criterion 3 / ALOG-8 — the purge's audit row names the deleted keys, checked", () => {
  const purge = () => ORPHANS_POST(new NextRequest("https://app/api/admin/orphans", {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: ORG, confirm: true }),
  }));

  it("deleteOrphans returns every key it deleted", async () => {
    referencing([]);
    state.listing = [{ Key: `orgs/${ORG}/x.pdf`, Size: 7, LastModified: old }, { Key: `orgs/${ORG}/y.pdf`, Size: 9, LastModified: old }];
    const out = await deleteOrphans(sb, ORG);
    expect(out.deletedKeys.sort()).toEqual([`orgs/${ORG}/x.pdf`, `orgs/${ORG}/y.pdf`]);
    expect(out.deleted).toBe(2);
  });

  it("the STORAGE_ORPHANS_PURGED row carries the keys, the count, the scope and the admitted role; the answer keeps its shape", async () => {
    referencing([]);
    state.listing = [{ Key: `orgs/${ORG}/x.pdf`, Size: 7, LastModified: old }];
    const res = await purge();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deleted: 1, freedBytes: 7, errors: [], scope: `orgs/${ORG}/`, kept: 0 });
    const row = state.inserts.find((i) => i.table === "audit_logs")?.row;
    expect(row).toMatchObject({
      action: "STORAGE_ORPHANS_PURGED", org_id: ORG, user_id: "admin1", user_email: "a@x", user_role: "Admin",
      details: { deleted: 1, freedBytes: 7, errors: 0, scope: `orgs/${ORG}/`, kept: 0, deletedKeys: [`orgs/${ORG}/x.pdf`], deletedKeyCount: 1, deletedKeysTruncated: false },
    });
  });

  it("a refused audit row is said in the answer and logged — never a silent success", async () => {
    referencing([]);
    state.listing = [{ Key: `orgs/${ORG}/x.pdf`, Size: 7, LastModified: old }];
    const base = state.resolve;
    state.resolve = (table, ops) => (table === "audit_logs" && ops.some((o) => o.m === "insert")
      ? { data: null, error: { message: "new row violates row-level security policy" } }
      : base(table, ops));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await purge();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(1);
    expect(body.auditError).toMatch(/deleted 1 file\(s\) but its STORAGE_ORPHANS_PURGED audit row was not written: new row violates/);
    expect(spy).toHaveBeenCalledWith("[admin/orphans] the STORAGE_ORPHANS_PURGED audit row was not written", "new row violates row-level security policy");
    spy.mockRestore();
  });

  it("the list is bounded, the count is whole, and the row says it was cut", () => {
    const keys = Array.from({ length: ORPHAN_AUDIT_KEY_CAP + 25 }, (_, i) => `orgs/${ORG}/f${i}.pdf`);
    const d = orphanPurgeAuditDetails({ deleted: keys.length, freedBytes: 1, errors: [], scope: `orgs/${ORG}/`, kept: 0, deletedKeys: keys });
    expect((d.deletedKeys as string[]).length).toBe(ORPHAN_AUDIT_KEY_CAP);
    expect(d.deletedKeyCount).toBe(ORPHAN_AUDIT_KEY_CAP + 25);
    expect(d.deletedKeysTruncated).toBe(true);
    expect((d.deletedKeys as string[])[0]).toBe(keys[0]);
  });

  it("a purge that deleted nothing still records its row (as before), with an empty list", async () => {
    referencing([]);
    const res = await purge();
    expect(res.status).toBe(200);
    expect(state.inserts.find((i) => i.table === "audit_logs")?.row).toMatchObject({ details: { deleted: 0, deletedKeys: [], deletedKeyCount: 0 } });
  });
});
