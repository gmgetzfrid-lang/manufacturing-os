// lib/__tests__/restoreApplyRoute.test.ts
//
// admin-and-org Round G, package P1 — the restore boundary.
//
//   ORG-1 / BKP-3  both restore routes write through ONE shared function
//                  (lib/dataRestore.ts applyRestoreChunk): org_id is forced
//                  to the authorized workspace, only export-contract tables
//                  are written, an org-less row lands only under a parent of
//                  this workspace; the single-shot /apply refuses an
//                  off-contract table with 400 before any write, and its
//                  DATA_RESTORE audit row is a checked write (ALOG-8).
//
// The routes run for real against an in-memory engine that behaves like
// PostgREST where it matters here: a statement is atomic, `upsert` with
// ignoreDuplicates is ON CONFLICT (<target>) DO NOTHING (42P10 when the
// target is not a declared key), any other unique key raises 23505, and
// `count: "exact"` reports the rows actually written.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** Declared unique keys per table (PK first). Default: [["id"]]. */
  keys: {} as Record<string, string[][]>,
  writeError: null as null | ((table: string, op: string, rows: Array<Record<string, unknown>>) => { code: string; message: string } | null),
  readError: {} as Record<string, string>,
  writes: [] as Array<{ table: string; op: string; n: number }>,
  /** Simulate a PostgREST that returns no count. */
  countless: false,
}));

function keysOf(table: string): string[][] { return db.keys[table] ?? [["id"]]; }
const sameKey = (a: Row, b: Row, cols: string[]) => cols.every((c) => a[c] !== undefined && a[c] !== null && String(a[c]) === String(b[c]));

function exec(table: string, op: string, payload: unknown, opts: Record<string, unknown> | undefined, filters: Array<(r: Row) => boolean>, single: boolean) {
  const all = (db.rows[table] ??= []);
  if (op === "select") {
    if (db.readError[table]) return { data: null, error: { code: "XX000", message: db.readError[table] } };
    const out = all.filter((r) => filters.every((f) => f(r)));
    return { data: single ? (out[0] ?? null) : out, error: null, count: out.length };
  }
  if (op === "insert" || op === "upsert") {
    const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
    const injected = db.writeError?.(table, op, rows);
    if (injected) return { data: null, error: injected, count: null };
    const keys = keysOf(table);
    let arbiter: string[] | null = null;
    if (op === "upsert") {
      const target = String(opts?.onConflict ?? "id").split(",").map((s) => s.trim());
      arbiter = keys.find((k) => k.length === target.length && k.every((c) => target.includes(c))) ?? null;
      if (!arbiter) return { data: null, error: { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" }, count: null };
    }
    const staged: Row[] = [];
    for (const row of rows) {
      const pool = [...all, ...staged];
      if (arbiter && pool.some((r) => sameKey(r, row, arbiter!))) continue; // DO NOTHING
      const clash = keys.find((k) => pool.some((r) => sameKey(r, row, k)));
      if (clash) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${table}_${clash.join("_")}_key"` }, count: null };
      staged.push({ ...row });
    }
    all.push(...staged);
    db.writes.push({ table, op, n: staged.length });
    return { data: null, error: null, count: opts?.count && !db.countless ? staged.length : null };
  }
  if (op === "update") {
    const injected = db.writeError?.(table, op, [payload as Row]);
    if (injected) return { data: null, error: injected };
    const hit = all.filter((r) => filters.every((f) => f(r)));
    for (const r of hit) Object.assign(r, payload as Row);
    db.writes.push({ table, op, n: hit.length });
    return { data: hit, error: null };
  }
  return { data: null, error: null };
}

function from(table: string) {
  let op = "select"; let payload: unknown; let opts: Record<string, unknown> | undefined; let single = false;
  const filters: Array<(r: Row) => boolean> = [];
  const b: Record<string, unknown> = {
    select: () => b,
    insert: (rows: unknown, o?: Record<string, unknown>) => { op = "insert"; payload = rows; opts = o; return b; },
    upsert: (rows: unknown, o?: Record<string, unknown>) => { op = "upsert"; payload = rows; opts = o; return b; },
    update: (patch: unknown) => { op = "update"; payload = patch; return b; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; },
    not: (c: string, _o: string, _v: unknown) => { filters.push((r) => r[c] !== null && r[c] !== undefined); return b; },
    is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
    order: () => b, limit: () => b, range: () => b,
    maybeSingle: () => { single = true; return b; },
    single: () => { single = true; return b; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
      try { res(exec(table, op, payload, opts, filters, single)); } catch (e) { rej(e); }
    },
  };
  return b;
}

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
    userId: "admin-1", email: "admin@x.io", orgId, role: "Admin", roles: ["Admin"], admin: { from },
  })),
}));

import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as applySingle } from "@/app/api/admin/restore/apply/route";
import { applyRestoreChunk, ORG_LESS_RESTORE_PARENTS, RESTORE_CONTRACT_TABLES, isSkippedTable, planRestore } from "@/lib/dataRestore";
import { censusSchema } from "./helpers/schemaKeys";

const ORG = "org-1";
const VICTIM = "victim-org";
const post = (path: string, body: unknown) =>
  new NextRequest(`https://app${path}?orgId=${ORG}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
async function chunk(table: string, rows: Row[], idRemap = { orgId: { "backup-org": ORG }, uid: {} }) {
  const res = await applyTable(post("/api/admin/restore/apply-table", { table, rows, idRemap, manifest: { orgId: "backup-org" } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function single(envelope: unknown) {
  const res = await applySingle(post("/api/admin/restore/apply", { envelope, confirm: true }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const rowsOf = (t: string) => db.rows[t] ?? [];
const audits = (action: string) => rowsOf("audit_logs").filter((r) => r.action === action);

beforeEach(() => {
  db.rows = { orgs: [{ id: ORG, name: "Acme" }, { id: VICTIM, name: "Victim" }], org_members: [] };
  db.keys = {};
  db.writeError = null;
  db.readError = {};
  db.writes = [];
  db.countless = false;
});

describe("ORG-1 / BKP-3 — the single-shot /apply forces the org boundary", () => {
  it("rows naming a foreign org_id land in THIS workspace — zero rows land in the foreign org", async () => {
    const { status, body } = await single({
      manifest: { orgId: "throwaway-uuid", orgName: "Acme" },
      tables: {
        documents: [{ id: "d-forged", org_id: VICTIM, title: "P&ID forged" }],
        notifications: [{ id: "n-forged", org_id: VICTIM, title: "hi" }],
        notes: [{ id: "note-1", org_id: "throwaway-uuid", body: "x" }],
        // append-only: never imported on either path (SURF-8)
        audit_logs: [{ id: "a-forged", org_id: VICTIM, action: "DOCUMENT_APPROVED" }],
      },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    for (const t of ["documents", "notifications", "notes", "audit_logs"]) {
      expect(rowsOf(t).filter((r) => r.org_id === VICTIM), t).toEqual([]);
    }
    expect(rowsOf("documents").map((r) => r.org_id)).toEqual([ORG]);
    expect(rowsOf("notifications").map((r) => r.org_id)).toEqual([ORG]);
    expect(rowsOf("notes").map((r) => r.org_id)).toEqual([ORG]);
    expect(rowsOf("audit_logs").find((r) => r.id === "a-forged")).toBeUndefined();
  });

  it("a row that omits org_id cannot land org-less: it is bound to this workspace", async () => {
    await single({ manifest: { orgId: "b" }, tables: { notes: [{ id: "n1", body: "no org" }] } });
    expect(rowsOf("notes")).toEqual([expect.objectContaining({ id: "n1", org_id: ORG })]);
    await chunk("notes", [{ id: "n2", body: "no org either" }]);
    expect(rowsOf("notes").find((r) => r.id === "n2")?.org_id).toBe(ORG);
  });

  it("an envelope carrying a table not on the export contract is refused with 400 before ANY write", async () => {
    const { status, body } = await single({
      manifest: { orgId: "b", orgName: "Renamed" },
      tables: {
        org_members: [{ uid: "u-new", email: "new@x.io", role: "Viewer" }],
        documents: [{ id: "d1", org_id: "b" }],
        pg_authid_please: [{ rolname: "x" }],
      },
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/pg_authid_please/);
    expect(body.offContract).toEqual(["pg_authid_please"]);
    expect(db.writes).toEqual([]); // no placeholder, no org rename, no rows
    expect(rowsOf("documents")).toEqual([]);
  });

  it("the plan marks an off-contract table as never imported, with the reason", () => {
    const plan = planRestore({ manifest: { orgId: "b" }, tables: { made_up: [{}], documents: [{}], users: [{}] } }, { orgId: ORG, orgName: "", members: [] });
    expect(plan.counts.tables.find((t) => t.name === "made_up")).toMatchObject({ willImport: false, offContract: true, reason: expect.stringMatching(/not part of the backup contract/) });
    // a reconciled table the contract no longer carries keeps its own reason and is not "off contract"
    expect(plan.counts.tables.find((t) => t.name === "users")).toMatchObject({ willImport: false });
    expect(plan.counts.tables.find((t) => t.name === "users")?.offContract).toBeUndefined();
    expect(plan.counts.totalRows).toBe(1);
  });

  it("the chunked /apply-table refuses an off-contract table with 400 and touches nothing", async () => {
    const r = await chunk("pg_authid_please", [{ id: "x" }]);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/not part of the backup contract/);
    expect(db.writes).toEqual([]);
  });
});

describe("BKP-3 Done-when 3 — org-less rows are bounded by their parent row", () => {
  it("names exactly the contract tables with no org_id column (census of supabase/)", () => {
    expect(Object.keys(ORG_LESS_RESTORE_PARENTS).sort()).toEqual(["curated_collection_items", "project_members"]);
    const schema = censusSchema();
    expect(schema.get("documents")?.columns.has("org_id")).toBe(true); // sanity
    const restorable = [...RESTORE_CONTRACT_TABLES].filter((t) => !isSkippedTable(t));
    const orgLess = restorable.filter((t) => !schema.get(t)?.columns.has("org_id")).sort();
    expect(orgLess, `restorable tables with no org_id column must be bounded by a parent (ORG_LESS_RESTORE_PARENTS): ${orgLess.join(", ")}`)
      .toEqual(Object.keys(ORG_LESS_RESTORE_PARENTS).sort());
    for (const [table, rule] of Object.entries(ORG_LESS_RESTORE_PARENTS)) {
      expect(schema.get(table)?.columns.has(rule.column), `${table}.${rule.column}`).toBe(true);
      expect(schema.get(rule.parent)?.columns.has("org_id"), `${rule.parent}.org_id`).toBe(true);
    }
  });

  it("a project_members row lands only under a project of THIS workspace; one under a foreign project is refused, never written", async () => {
    db.rows.projects = [{ id: "p-mine", org_id: ORG }, { id: "p-victim", org_id: VICTIM }];
    const r = await chunk("project_members", [
      { id: "pm-1", project_id: "p-mine", user_id: "u1", role: "collaborator" },
      { id: "pm-2", project_id: "p-victim", user_id: "attacker", role: "owner" },
      { id: "pm-3", project_id: "p-missing", user_id: "u3", role: "observer" },
    ]);
    expect(r.status).toBe(200);
    expect(rowsOf("project_members").map((x) => x.id)).toEqual(["pm-1"]);
    expect(r.body.refused).toEqual([
      expect.objectContaining({ id: "pm-2", code: "parent_outside_workspace" }),
      expect.objectContaining({ id: "pm-3", code: "parent_outside_workspace" }),
    ]);
    // org-less: no org_id column is invented on the row
    expect(rowsOf("project_members")[0]).not.toHaveProperty("org_id");
    const trail = audits("RESTORE_CHUNK")[0];
    expect((trail.details as Record<string, unknown>).refused).toHaveLength(2);
  });

  it("curated_collection_items are bounded by their collection the same way, on the single-shot route too", async () => {
    db.keys.curated_collection_items = [["collection_id", "document_id"]];
    db.rows.curated_collections = [{ id: "c-mine", org_id: ORG }, { id: "c-victim", org_id: VICTIM }];
    const { status, body } = await single({
      manifest: { orgId: "b" },
      tables: {
        curated_collection_items: [
          { collection_id: "c-mine", document_id: "d1", sort_order: 1 },
          { collection_id: "c-victim", document_id: "d2", sort_order: 1 },
        ],
      },
    });
    expect(status).toBe(200);
    expect(rowsOf("curated_collection_items").map((x) => x.collection_id)).toEqual(["c-mine"]);
    const t = (body.tables as Array<Record<string, unknown>>).find((x) => x.name === "curated_collection_items")!;
    expect(t.refused).toEqual([expect.objectContaining({ id: "c-victim/d2", code: "parent_outside_workspace" })]);
  });

  it("an unreadable parent fails the chunk closed — nothing is written on a guess", async () => {
    db.readError.projects = "permission denied";
    const r = await chunk("project_members", [{ id: "pm-1", project_id: "p-mine", user_id: "u1" }]);
    expect(r.status).toBe(500);
    expect(rowsOf("project_members")).toEqual([]);
  });
});

describe("BKP-3 Done-when 2 — one shared function, so the two routes cannot diverge", () => {
  it("the same rows land identically through /apply-table and /apply", async () => {
    const rows = [
      { id: "s1", org_id: VICTIM, token: "live-token", revoked_at: null, document_id: "d1" },
      { id: "s2", token: "another", revoked_at: null, document_id: "d1" },
    ];
    await chunk("document_shares", rows);
    const viaChunk = rowsOf("document_shares").map(({ token, revoked_at, ...rest }) => ({ ...rest, token: String(token).slice(0, 9), revoked: !!revoked_at }));
    db.rows.document_shares = [];
    await single({ manifest: { orgId: "backup-org" }, tables: { document_shares: rows } });
    const viaSingle = rowsOf("document_shares").map(({ token, revoked_at, ...rest }) => ({ ...rest, token: String(token).slice(0, 9), revoked: !!revoked_at }));
    expect(viaSingle).toEqual(viaChunk);
    expect(viaChunk).toEqual([
      { id: "s1", org_id: ORG, document_id: "d1", token: "restored-", revoked: true },
      { id: "s2", org_id: ORG, document_id: "d1", token: "restored-", revoked: true },
    ]);
  });

  it("applyRestoreChunk itself refuses a non-contract or append-only table before any read or write", async () => {
    for (const table of ["made_up", "audit_logs", "org_members"]) {
      const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table, rows: [{ id: "x" }], idRemap: { orgId: {}, uid: {} } });
      expect(r, table).toMatchObject({ ok: false, status: 400, inserted: 0 });
    }
    expect(db.writes).toEqual([]);
  });
});

describe("ALOG-8 (restore/apply site) — the DATA_RESTORE audit row is a checked write", () => {
  it("writes DATA_RESTORE naming the backup and per-table counts", async () => {
    const { status } = await single({ manifest: { orgId: "backup-org" }, tables: { notes: [{ id: "n1", org_id: "backup-org" }] } });
    expect(status).toBe(200);
    const row = audits("DATA_RESTORE")[0];
    expect(row).toMatchObject({ org_id: ORG, user_id: "admin-1" });
    expect(row.details).toMatchObject({ backupOrgId: "backup-org", totalInserted: 1, tables: [{ name: "notes", inserted: 1 }] });
  });

  it("a rejected audit insert is surfaced as a 500 naming what was written — never a silent success", async () => {
    db.writeError = (table) => (table === "audit_logs" ? { code: "23502", message: "null value in column \"action\"" } : null);
    const { status, body } = await single({ manifest: { orgId: "backup-org" }, tables: { notes: [{ id: "n1" }] } });
    expect(status).toBe(500);
    expect(String(body.error)).toMatch(/restore audit row failed: null value/);
    expect(body.totalInserted).toBe(1);
  });
});
