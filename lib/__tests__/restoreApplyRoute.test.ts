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
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { db, from, type Row } from "./helpers/restoreMemoryDb";

vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@x.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});

import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as applySingle } from "@/app/api/admin/restore/apply/route";
import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";
import {
  applyRestoreChunk, ORG_LESS_RESTORE_PARENTS, RESTORE_CONTRACT_TABLES, isSkippedTable, planRestore,
  previewChunkedRestore, runChunkedRestore, RESTORE_ADDITIVE_NOTE, type RestorePost, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";
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
  db.attempts = [];
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

describe("BKP-12 — the id-less tables re-run cleanly, and a refused chunk is reported, never re-sent", () => {
  const KEYS: Record<string, string[][]> = {
    codebook_config: [["org_id"]],
    document_equipment_suggestions: [["org_id", "document_id"]],
    recently_viewed_docs: [["user_id", "document_id"]],
    library_numbering: [["library_id"]],
  };
  const rowsFor: Record<string, Row[]> = {
    codebook_config: [{ org_id: "backup-org", drawing_number: { segments: [] } }],
    document_equipment_suggestions: [{ org_id: "backup-org", document_id: "d1", status: "pending" }],
    recently_viewed_docs: [{ org_id: "backup-org", user_id: "u1", document_id: "d1" }],
    library_numbering: [{ org_id: "backup-org", library_id: "lib-1", pattern: "P-{seq}" }],
  };

  it("restoring the same backup twice: the second run skips what exists — zero failed tables, on both routes", async () => {
    db.keys = { ...KEYS };
    for (const table of Object.keys(KEYS)) {
      const first = await chunk(table, rowsFor[table]);
      expect(first.status, table).toBe(200);
      expect(first.body.inserted, table).toBe(1);
      const again = await chunk(table, rowsFor[table]);
      expect(again.status, `${table} re-run`).toBe(200);
      expect(again.body.inserted, `${table} re-run`).toBe(0);
    }
    // the single-shot route, into a workspace that already has every row
    const { status, body } = await single({ manifest: { orgId: "backup-org" }, tables: rowsFor });
    expect(status).toBe(200);
    expect(body.failedTables).toEqual([]);
    expect(rowsOf("codebook_config")).toHaveLength(1);
  });

  it("an upsert the database rejects is reported with ITS error — no plain-insert retry of the same chunk", async () => {
    db.writeError = (table, op) => (table === "notes" && op === "upsert" ? { code: "23505", message: 'duplicate key value violates unique constraint "notes_slug_key"' } : null);
    const r = await chunk("notes", [{ id: "n1", body: "x" }]);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ error: 'duplicate key value violates unique constraint "notes_slug_key"', code: "23505", inserted: 0 });
    expect(db.attempts.filter((a) => a.table === "notes").map((a) => a.op)).toEqual(["upsert"]);
    expect(rowsOf("notes")).toEqual([]);
  });
});

/** The page's transport, pointed at the real route handlers. */
const routePost: RestorePost = async (path, body) => {
  const req = new NextRequest(`https://app${path}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const handler = path.startsWith("/api/admin/restore/begin") ? beginRoute : applyTable;
  const res = await handler(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const planFor = (envelope: RestoreEnvelopeLike) => planRestore(envelope, { orgId: ORG, orgName: "Acme", members: [] });

describe("BKP-5 — a restore says what it added and what it kept, before and after", () => {
  const envelope = (): RestoreEnvelopeLike => ({
    manifest: { orgId: "backup-org", orgName: "Acme" },
    tables: {
      org_members: [],
      notes: [{ id: "n-damaged", org_id: "backup-org", body: "good copy" }, { id: "n-new", org_id: "backup-org", body: "new" }],
      codebook_config: [{ org_id: "backup-org", drawing_number: {} }],
    },
  });

  it("the read-only check counts rows that already exist (by the table's key) apart from new ones — and writes nothing", async () => {
    db.keys.codebook_config = [["org_id"]];
    db.rows.notes = [{ id: "n-damaged", org_id: ORG, body: "CORRUPTED" }];
    db.rows.codebook_config = [{ org_id: ORG, drawing_number: { live: true } }];
    const env = envelope();
    const check = await previewChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), post: routePost });
    expect(check.tables.notes).toEqual({ rows: 2, existing: 1, wouldInsert: 1 });
    expect(check.tables.codebook_config).toEqual({ rows: 1, existing: 1, wouldInsert: 0 }); // keyed on org_id, bound to THIS org
    expect(check).toMatchObject({ existing: 2, wouldInsert: 1 });
    expect(db.attempts).toEqual([]); // nothing written, no audit row
  });

  it("after applying: inserted and existing are both reported; the damaged row is NOT repaired, and the panel's sentence says so", async () => {
    db.keys.codebook_config = [["org_id"]];
    db.rows.notes = [{ id: "n-damaged", org_id: ORG, body: "CORRUPTED" }];
    const env = envelope();
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toBeNull();
    expect(result.tables.find((t) => t.name === "notes")).toMatchObject({ inserted: 1, existing: 1 });
    expect(result).toMatchObject({ totalInserted: 2, totalExisting: 1, totalRefused: 0 });
    expect(rowsOf("notes").find((r) => r.id === "n-damaged")?.body).toBe("CORRUPTED"); // additive only (DEC-44 A&O P1)
    expect(RESTORE_ADDITIVE_NOTE).toMatch(/cannot overwrite, repair or roll back/);
    const chunkAudit = audits("RESTORE_CHUNK").find((r) => (r.details as Record<string, unknown>).table === "notes");
    expect(chunkAudit?.details).toMatchObject({ inserted: 1, existing: 1 });
  });

  it("a server that reports no count is 'uncounted', never assumed written", async () => {
    db.countless = true;
    const r = await chunk("notes", [{ id: "n1" }, { id: "n2" }]);
    expect(r.body).toEqual({ ok: true, inserted: 0, uncounted: 2 });
  });

  it("the run STOPS at the first failed table and names the tables it did not attempt (FK order)", async () => {
    db.writeError = (table, op) => (table === "documents" && op === "upsert" ? { code: "23505", message: 'duplicate key value violates unique constraint "documents_library_uniqueness_uniq"' } : null);
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: {
        libraries: [{ id: "lib-1", org_id: "backup-org" }],
        documents: [{ id: "d1", org_id: "backup-org", library_id: "lib-1" }],
        document_versions: [{ id: "v1", org_id: "backup-org", record_id: "d1" }],
        notes: [{ id: "n1", org_id: "backup-org" }],
      },
    };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toEqual({ table: "documents", error: 'duplicate key value violates unique constraint "documents_library_uniqueness_uniq"' });
    expect(result.notAttempted).toEqual(["document_versions", "notes"]);
    expect(result.tables.map((t) => t.name)).toEqual(["libraries", "documents"]);
    expect(rowsOf("document_versions")).toEqual([]); // no child of a parent that never landed
    expect(rowsOf("notes")).toEqual([]);
    expect(rowsOf("libraries")).toHaveLength(1);
  });

  it("a chunk that fails part-way reports what it wrote, and its audit row records the failure", async () => {
    let calls = 0;
    db.writeError = (table, op) => (table === "notes" && op === "upsert" && ++calls === 2 ? { code: "XX000", message: "connection reset" } : null);
    const rows = Array.from({ length: 700 }, (_, i) => ({ id: `n${i}`, org_id: "backup-org" }));
    const r = await chunk("notes", rows);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ error: "connection reset", inserted: 500 });
    expect(audits("RESTORE_CHUNK")[0].details).toMatchObject({ table: "notes", inserted: 500, failed: "connection reset" });
  });

  it("the page runs the check before it asks, uses the shared driver, and never paints a stopped run green", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/restore/page.tsx"), "utf8");
    expect(page.indexOf("await previewChunkedRestore(")).toBeGreaterThan(0);
    expect(page.indexOf("await previewChunkedRestore(")).toBeLessThan(page.indexOf("await appConfirm("));
    expect(page.indexOf("await appConfirm(")).toBeLessThan(page.indexOf("await runChunkedRestore("));
    expect(page).toMatch(/KEPT EXACTLY AS THEY ARE — not overwritten, not repaired/);
    expect(page).toMatch(/Restore stopped at <span className="font-mono">\{stopped\.table\}<\/span> — \{result\.notAttempted\.length\} table\(s\) not attempted/);
    expect(page).toMatch(/const tone = stopped\s*\? "border-red-200/);
    expect(page).not.toMatch(/it&apos;s additive and safe/);
  });
});

describe("BKP-11 / BKP-1 (restore halves) — nothing restored can fire or be presented", () => {
  it("an export destination lands disabled, with no next run and no credentials — even when the row omits the credential keys", async () => {
    const past = "2026-01-01T00:00:00.000Z";
    const dest = (id: string, extra: Row = {}) => ({
      id, org_id: "backup-org", name: "Nightly", destination_type: "webhook", webhook_url: "https://hooks.example.com/x",
      enabled: true, schedule_kind: "daily", next_run_at: past, ...extra,
    });
    // a hand-made row with NO credential keys (scrubRestoredRow alone would not see it)
    const r = await chunk("export_destinations", [dest("e1"), dest("e2", { webhook_secret_encrypted: "v1:ciphertext", access_key_id_encrypted: "v1:x" })]);
    expect(r.status).toBe(200);
    for (const row of rowsOf("export_destinations")) {
      expect(row).toMatchObject({ org_id: ORG, enabled: false, next_run_at: null, webhook_secret_encrypted: null, access_key_id_encrypted: null, secret_access_key_encrypted: null });
    }
    // the single-shot route lands it the same way
    db.rows.export_destinations = [];
    await single({ manifest: { orgId: "backup-org" }, tables: { export_destinations: [dest("e3")] } });
    expect(rowsOf("export_destinations")[0]).toMatchObject({ enabled: false, next_run_at: null, webhook_secret_encrypted: null });
  });

  it("the single-shot route scrubs every bearer column like the chunked one: shares and intake links revoked behind a placeholder, an issued transmittal voided", async () => {
    await single({
      manifest: { orgId: "backup-org" },
      tables: {
        document_shares: [{ id: "s1", org_id: "backup-org", token: "live-share", revoked_at: null }],
        project_intake_links: [{ id: "l1", org_id: "backup-org", token: "live-intake", revoked_at: null }],
        transmittals: [{ id: "t1", org_id: "backup-org", portal_token: "live-portal", status: "issued", notes: null }],
      },
    });
    for (const t of ["document_shares", "project_intake_links"]) {
      const row = rowsOf(t)[0];
      expect(String(row.token), t).toMatch(/^restored-/);
      expect(row.revoked_at, t).toBeTruthy();
    }
    expect(rowsOf("transmittals")[0]).toMatchObject({ portal_token: null, status: "voided" });
  });
});
