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
//   ORG-1 (fix)    every foreign key to an org-scoped table must name a row
//                  of the target workspace (RESTORE_PARENT_RULES): a
//                  team_members row naming another tenant's team, a checkout
//                  episode on another tenant's document never land.
//   BKP-5 (fix)    a key held by ANOTHER workspace is reported as not
//                  restored, never as "already here"; a row the database
//                  refuses (a second unique key, an orphan) is isolated and
//                  reported, and the run goes on.
//   fix pass 2     computed columns are never sent (428C9 would stop the
//                  run); a person with no sign-in account is cleared from a
//                  nullable users column and refuses a team membership; an
//                  owner team / SOW pointer is cleared, not cascaded; a row
//                  already held is counted, never "refused"; bisection has a
//                  statement budget; every check is audited; a storage key
//                  under another workspace's prefix is refused.
//   fix pass 3     the outbound mail queue is never restored (a restored
//                  queued row bypassed SURF-17 and was sent by the drain); a
//                  re-run links the placeholders an earlier run created
//                  (members of every status), so uid-keyed rows never land
//                  twice; a cleared pointer is reported only for a row the
//                  database took.
//   fix pass 4     the member read /begin, /apply, /preview and the page
//                  plan against is checked (an unread list would mint a
//                  placeholder for every person, active members included);
//                  the rename and every placeholder insert are checked, and
//                  /begin and /apply stop before any table when one fails;
//                  acceptable-use agreements and the AI spend ledger are
//                  append-only and the AI caps are skipped (the census of
//                  service-role-only tables lives in dataRestore.test.ts); a
//                  chunk that failed after a count-less accepted statement is
//                  audited.
//   fix pass 5     every backup uid is mapped or its rows are refused: the
//                  other rows of one address (an inactive historical row
//                  beside a re-added one) map to the same person; a member
//                  with no address links by uid or is unmapped, and a row
//                  naming one is refused (person_not_mapped). The single-shot
//                  DATA_RESTORE row carries uncounted / filtered; a numbering
//                  counter held here is advanced past the restored numbers;
//                  the page plans again before it asks; a clear is reported
//                  only for a row the database wrote.
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
import { POST as previewRoute } from "@/app/api/admin/restore/preview/route";
import {
  applyRestoreChunk, ORG_LESS_RESTORE_PARENTS, RESTORE_CONTRACT_TABLES, isSkippedTable, planRestore,
  previewChunkedRestore, runChunkedRestore, RESTORE_ADDITIVE_NOTE, RESTORE_HELD_ELSEWHERE_NOTE, ROW_LEVEL_SQLSTATES,
  RESTORE_BISECT_MAX_STATEMENTS, RESTORE_LINK_MEMBER_STATUSES, restoreTableRefusal, RESTORE_COUNTER_COLUMNS,
  type RestorePost, type RestoreEnvelopeLike, type CurrentMember,
} from "@/lib/dataRestore";
import { censusSchema } from "./helpers/schemaKeys";

const ORG = "org-1";
const VICTIM = "victim-org";
const post = (path: string, body: unknown) =>
  new NextRequest(`https://app${path}?orgId=${ORG}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
async function chunk(table: string, rows: Row[], idRemap: { orgId: Record<string, string>; uid: Record<string, string> } = { orgId: { "backup-org": ORG }, uid: {} }) {
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
  db.fks = {};
  db.maxRows = 1000;
  db.generated = {};
  db.authUsers = null;
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
    db.rows.documents = [{ id: "d1", org_id: ORG }];
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
    db.rows.documents = [{ id: "d1", org_id: ORG }];
    db.rows.libraries = [{ id: "lib-1", org_id: ORG }];
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
    db.writeError = (table, op) => (table === "notes" && op === "upsert" ? { code: "42703", message: 'column "slug" of relation "notes" does not exist' } : null);
    const r = await chunk("notes", [{ id: "n1", body: "x" }, { id: "n2", body: "y" }]);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ error: 'column "slug" of relation "notes" does not exist', code: "42703", inserted: 0 });
    expect(db.attempts.filter((a) => a.table === "notes").map((a) => a.op)).toEqual(["upsert"]); // not about one row: no bisection either
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
    expect(check.tables.notes).toEqual({ rows: 2, existing: 1, heldElsewhere: 0, wouldInsert: 1 });
    expect(check.tables.codebook_config).toEqual({ rows: 1, existing: 1, heldElsewhere: 0, wouldInsert: 0 }); // keyed on org_id, bound to THIS org
    expect(check).toMatchObject({ existing: 2, heldElsewhere: 0, wouldInsert: 1 });
    // nothing of the backup is written — but every check leaves its audit row (fix pass 2)
    expect(db.attempts.filter((a) => a.table !== "audit_logs")).toEqual([]);
    expect(audits("RESTORE_PREVIEW").map((a) => a.details)).toEqual([
      expect.objectContaining({ table: "codebook_config", rowsReceived: 1, existing: 1, heldElsewhere: 0, wouldInsert: 0, backupOrgId: "backup-org" }),
      expect.objectContaining({ table: "notes", rowsReceived: 2, existing: 1, heldElsewhere: 0, wouldInsert: 1, backupOrgId: "backup-org" }),
    ]);
    expect(rowsOf("notes").find((n) => n.id === "n-damaged")?.body).toBe("CORRUPTED");
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

  it("comments of a ticket archived since the backup are left out AND counted — never silently lost", async () => {
    db.rows.tickets = [{ id: "t-archived", org_id: ORG, archived_at: "2026-09-01T00:00:00Z" }, { id: "t-live", org_id: ORG, archived_at: null }];
    const r = await chunk("ticket_comments", [{ id: "c1", ticket_id: "t-archived" }, { id: "c2", ticket_id: "t-live" }]);
    expect(r.body).toEqual({ ok: true, inserted: 1, filtered: 1 });
    expect(rowsOf("ticket_comments").map((c) => c.id)).toEqual(["c2"]);
    expect(audits("RESTORE_CHUNK")[0].details).toMatchObject({ rowsReceived: 2, rowsAfterFilters: 1, inserted: 1 });
    db.readError.tickets = "timeout";
    const failed = await chunk("ticket_comments", [{ id: "c3", ticket_id: "t-archived" }]);
    expect(failed.status).toBe(500); // an unreadable ticket list never resurrects the comments
    expect(rowsOf("ticket_comments").map((c) => c.id)).toEqual(["c2"]);
  });

  it("a server that reports no count is 'uncounted', never assumed written", async () => {
    db.countless = true;
    const r = await chunk("notes", [{ id: "n1" }, { id: "n2" }]);
    expect(r.body).toEqual({ ok: true, inserted: 0, uncounted: 2 });
  });

  it("the run STOPS at the first failed table and names the tables it did not attempt (FK order)", async () => {
    db.writeError = (table, op) => (table === "documents" && op === "upsert" ? { code: "42501", message: 'permission denied for table documents' } : null);
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
    expect(result.stoppedAt).toEqual({ table: "documents", error: "permission denied for table documents" });
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
    expect(page).toMatch(/const tone = stopped \|\| result\.totalHeldElsewhere > 0\s*\? "border-red-200/);
    expect(page).toMatch(/result\.totalRefused > 0 \|\| result\.totalCleared > 0 \|\| result\.totalUncounted > 0 \|\| nothingNew \? "border-amber-200/);
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

// ─── admin-and-org Round G, P1 fix pass ─────────────────────────────────────

describe("ORG-1 (fix pass) — what a restored row POINTS AT is bounded to this workspace", () => {
  const T_MINE = "team-mine";
  const T_VICTIM = "team-victim";
  beforeEach(() => {
    db.keys.team_members = [["team_id", "uid"]];
    db.rows.users = [{ id: "u1" }, { id: "attacker" }]; // both have sign-in accounts: the TEAM is what is wrong
    db.rows.teams = [{ id: T_MINE, org_id: ORG }, { id: T_VICTIM, org_id: VICTIM }];
    db.rows.documents = [{ id: "d-mine", org_id: ORG }, { id: "d-victim", org_id: VICTIM }];
    db.rows.projects = [{ id: "p-mine", org_id: ORG }, { id: "p-victim", org_id: VICTIM }];
  });

  it("a team_members row naming another tenant's team is refused and never written — the attacker never joins the victim's team (both routes)", async () => {
    const r = await chunk("team_members", [
      { team_id: T_VICTIM, uid: "attacker", org_id: VICTIM },
      { team_id: T_MINE, uid: "u1" },
    ]);
    expect(r.status).toBe(200);
    expect(rowsOf("team_members")).toEqual([expect.objectContaining({ team_id: T_MINE, uid: "u1", org_id: ORG })]);
    expect(r.body.refused).toEqual([{ id: `${T_VICTIM}/attacker`, code: "parent_outside_workspace", message: `team_id ${T_VICTIM} is not a teams row of this workspace` }]);
    db.rows.team_members = [];
    const { status, body } = await single({ manifest: { orgId: "b" }, tables: { team_members: [{ team_id: T_VICTIM, uid: "attacker" }] } });
    expect(status).toBe(200);
    expect(rowsOf("team_members")).toEqual([]);
    expect((body.tables as Array<Record<string, unknown>>)[0].refused).toEqual([expect.objectContaining({ code: "parent_outside_workspace" })]);
  });

  it("a checkout episode on another tenant's document never lands (the deployment-wide one-active index stays the victim's)", async () => {
    const r = await chunk("checkout_episodes", [
      { id: "ep-1", document_id: "d-victim", status: "active" },
      { id: "ep-2", document_id: "d-mine", status: "active" },
    ]);
    expect(rowsOf("checkout_episodes").map((e) => e.id)).toEqual(["ep-2"]);
    expect(r.body.refused).toEqual([expect.objectContaining({ id: "ep-1", code: "parent_outside_workspace" })]);
  });

  it("versions, project links, sessions and intents naming another tenant's rows are refused row by row; a NULL foreign key is no reference", async () => {
    await chunk("document_versions", [{ id: "v-x", record_id: "d-victim" }, { id: "v-ok", record_id: "d-mine", supersedes_version_id: null }]);
    expect(rowsOf("document_versions").map((v) => v.id)).toEqual(["v-ok"]);
    await chunk("project_documents", [
      { id: "pd-1", project_id: "p-victim", document_id: "d-mine" },
      { id: "pd-2", project_id: "p-mine", document_id: "d-victim" },
      { id: "pd-3", project_id: "p-mine", document_id: "d-mine" },
    ]);
    expect(rowsOf("project_documents").map((x) => x.id)).toEqual(["pd-3"]);
    await chunk("checkout_sessions", [{ id: "cs-1", document_id: "d-victim" }, { id: "cs-2", document_id: "d-mine", episode_id: null, linked_ticket_id: null }]);
    await chunk("document_intents", [{ id: "di-1", document_id: "d-victim" }]);
    expect(rowsOf("checkout_sessions").map((x) => x.id)).toEqual(["cs-2"]);
    expect(rowsOf("document_intents")).toEqual([]);
  });

  it("a self-reference may name a NEW row of the same chunk — never a row another workspace holds behind a skipped id", async () => {
    db.rows.document_versions = [{ id: "v-victim", org_id: VICTIM, record_id: "d-victim" }];
    const r = await chunk("document_versions", [
      { id: "v2", record_id: "d-mine", supersedes_version_id: "v1" },  // parent later in the same chunk, new to the deployment
      { id: "v1", record_id: "d-mine", supersedes_version_id: null },
      { id: "v-victim", record_id: "d-mine" },                           // skipped: another workspace holds the id
      { id: "v3", record_id: "d-mine", supersedes_version_id: "v-victim" },
    ]);
    expect(r.status).toBe(200);
    expect(rowsOf("document_versions").filter((v) => v.org_id === ORG).map((v) => v.id).sort()).toEqual(["v1", "v2"]);
    expect(r.body.refused).toEqual([expect.objectContaining({ id: "v3", code: "parent_outside_workspace" })]);
    expect(r.body.heldElsewhere).toBe(1);
  });

  it("a long version chain written newest-first restores whole across chunks — rows go parents-first (both routes)", async () => {
    db.fks.document_versions = [{ column: "supersedes_version_id", parent: "document_versions" }, { column: "record_id", parent: "documents" }];
    const chain = Array.from({ length: 1200 }, (_, i) => ({ id: `v${i}`, org_id: "backup-org", record_id: "d-mine", supersedes_version_id: i === 0 ? null : `v${i - 1}` })).reverse();
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { document_versions: chain } };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toBeNull();
    expect(result).toMatchObject({ totalInserted: 1200, totalRefused: 0 });
    db.rows.document_versions = [];
    const { status, body } = await single(env);
    expect(status).toBe(200);
    expect(body).toMatchObject({ totalInserted: 1200, failedTables: [] });
  });

  it("an unreadable parent table fails the chunk closed — nothing is written on a guess", async () => {
    db.readError.teams = "permission denied";
    const r = await chunk("team_members", [{ team_id: T_MINE, uid: "u1" }]);
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/Could not check the teams rows/);
    expect(rowsOf("team_members")).toEqual([]);
  });
});

describe("BKP-5 (fix pass) — a row the database refuses is isolated and reported; the table and the run go on", () => {
  beforeEach(() => {
    db.rows.assets = [{ id: "a1", org_id: ORG }];
    db.rows.knowledge_documents = [{ id: "k1", org_id: ORG }];
    db.keys.entity_mentions = [["id"], ["asset_id", "knowledge_document_id", "page"]];
    // re-indexed since the backup: the live mention carries a NEW id
    db.rows.entity_mentions = [{ id: "m-live", org_id: ORG, asset_id: "a1", knowledge_document_id: "k1", page: 1 }];
  });

  it("the codes that are about one row", () => {
    expect([...ROW_LEVEL_SQLSTATES].sort()).toEqual(["23502", "23503", "23505", "23514", "23P01"]);
  });

  it("a mention colliding on its second unique key is refused (23505) while the rest of its chunk lands", async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `m-new-${i}`, asset_id: "a1", knowledge_document_id: "k1", page: 10 + i })),
      { id: "m-old", asset_id: "a1", knowledge_document_id: "k1", page: 1 },
    ];
    const r = await chunk("entity_mentions", rows);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, inserted: 6, refused: [expect.objectContaining({ id: "m-old", code: "23505" })] });
    expect(rowsOf("entity_mentions").find((m) => m.id === "m-live")).toBeTruthy(); // the live row is kept
    expect(audits("RESTORE_CHUNK")[0].details).toMatchObject({ inserted: 6, refused: [expect.objectContaining({ id: "m-old", code: "23505" })] });
  });

  it("a same-workspace repair restore no longer stops at a re-indexed mention: tickets and notes after it still land", async () => {
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: {
        entity_mentions: [{ id: "m-old", org_id: "backup-org", asset_id: "a1", knowledge_document_id: "k1", page: 1 }],
        tickets: [{ id: "t1", org_id: "backup-org" }],
        notes: [{ id: "n1", org_id: "backup-org" }],
      },
    };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toBeNull();
    expect(result).toMatchObject({ totalInserted: 2, totalRefused: 1 });
    expect(rowsOf("tickets").map((t) => t.id)).toEqual(["t1"]);
    expect(rowsOf("notes").map((t) => t.id)).toEqual(["n1"]);
  });

  it("the child of a refused row is refused too (23503), never written as an orphan", async () => {
    db.rows.documents = [{ id: "d1", org_id: ORG }];
    db.keys.document_versions = [["id"], ["record_id", "revision_label"]];
    db.fks.document_versions = [{ column: "supersedes_version_id", parent: "document_versions" }];
    db.rows.document_versions = [{ id: "v-live", org_id: ORG, record_id: "d1", revision_label: "A" }];
    const r = await chunk("document_versions", [
      { id: "v1", record_id: "d1", revision_label: "A" },
      { id: "v2", record_id: "d1", revision_label: "B", supersedes_version_id: "v1" },
      { id: "v3", record_id: "d1", revision_label: "C" },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.refused).toEqual([expect.objectContaining({ id: "v1", code: "23505" }), expect.objectContaining({ id: "v2", code: "23503" })]);
    expect(rowsOf("document_versions").map((v) => v.id).sort()).toEqual(["v-live", "v3"]);
  });
});

describe("BKP-5 (fix pass) — a key another workspace holds is 'not restored', never 'already here'", () => {
  it("before and after: the preview, the chunk, the run totals and the audit row separate held-elsewhere from kept-here", async () => {
    db.rows.notes = [{ id: "n-theirs", org_id: VICTIM, body: "another workspace's note" }, { id: "n-mine", org_id: ORG, body: "live" }];
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: { notes: [{ id: "n-theirs", org_id: "backup-org" }, { id: "n-mine", org_id: "backup-org" }, { id: "n-new", org_id: "backup-org" }] },
    };
    const check = await previewChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), post: routePost });
    expect(check.tables.notes).toEqual({ rows: 3, existing: 1, heldElsewhere: 1, wouldInsert: 1 });
    expect(check).toMatchObject({ existing: 1, heldElsewhere: 1, wouldInsert: 1 });
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result.tables[0]).toMatchObject({ name: "notes", inserted: 1, existing: 1, heldElsewhere: 1 });
    expect(result).toMatchObject({ totalInserted: 1, totalExisting: 1, totalHeldElsewhere: 1 });
    expect(audits("RESTORE_CHUNK")[0].details).toMatchObject({ inserted: 1, existing: 1, heldElsewhere: 1 });
    expect(rowsOf("notes").find((n) => n.id === "n-theirs")?.org_id).toBe(VICTIM); // untouched, and not ours
  });

  it("a backup restored beside its still-live source org: every id is held elsewhere — 0 inserted, and the totals say why (single-shot too)", async () => {
    db.rows.notes = [{ id: "n1", org_id: VICTIM }, { id: "n2", org_id: VICTIM }];
    const env: RestoreEnvelopeLike = { manifest: { orgId: VICTIM }, tables: { notes: [{ id: "n1", org_id: VICTIM }, { id: "n2", org_id: VICTIM }] } };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result).toMatchObject({ totalInserted: 0, totalExisting: 0, totalHeldElsewhere: 2, stoppedAt: null });
    const { body } = await single(env);
    expect(body).toMatchObject({ totalInserted: 0, totalExisting: 0, totalHeldElsewhere: 2 });
    expect(String(body.note)).toMatch(/2 record\(s\) were NOT restored: their ids are in use by another workspace/);
  });

  it("an org-less row belongs to the workspace of its bounding parent", async () => {
    db.rows.projects = [{ id: "p-mine", org_id: ORG }, { id: "p-victim", org_id: VICTIM }];
    db.rows.project_members = [{ id: "pm-theirs", project_id: "p-victim", user_id: "x" }, { id: "pm-mine", project_id: "p-mine", user_id: "y" }];
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: { project_members: [{ id: "pm-theirs", project_id: "p-mine", user_id: "x" }, { id: "pm-mine", project_id: "p-mine", user_id: "y" }] },
    };
    const check = await previewChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), post: routePost });
    expect(check.tables.project_members).toEqual({ rows: 2, existing: 1, heldElsewhere: 1, wouldInsert: 0 });
  });

  it("the page never says 'already here' for them and never paints such a run green", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/restore/page.tsx"), "utf8");
    expect(page).toMatch(/record\(s\) will NOT be restored: \$\{RESTORE_HELD_ELSEWHERE_NOTE\}/);
    expect(page).toMatch(/could NOT be restored — their ids are in use elsewhere/);
    expect(page).toMatch(/Nothing new was restored/);
    expect(RESTORE_HELD_ELSEWHERE_NOTE).toMatch(/could NOT be restored here/);
    // "Records restored" is the title only for a run that wrote something, met no held id and stopped nowhere
    const panel = page.slice(page.indexOf("function RestoreResultPanel("));
    expect(panel.indexOf("Records restored</>")).toBeGreaterThan(panel.indexOf("Nothing new was restored"));
  });
});

describe("BKP-5 (fix pass) — the counts hold past the server's row cap (composite keys)", () => {
  it("10,000 matching favorites under a 1,000-row cap: the check filters on every key column and pages — existing is exact", async () => {
    db.maxRows = 1000;
    db.keys.document_favorites = [["user_id", "document_id"]];
    db.rows.document_favorites = [];
    for (let u = 0; u < 100; u++) for (let d = 0; d < 100; d++) db.rows.document_favorites.push({ user_id: `u${u}`, document_id: `d${d}`, org_id: ORG });
    const backup = Array.from({ length: 100 }, (_, i) => ({ user_id: `u${i}`, document_id: `d${i}`, org_id: "backup-org" }))
      .concat(Array.from({ length: 50 }, (_, i) => ({ user_id: `u${i}`, document_id: `new-${i}`, org_id: "backup-org" })));
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { document_favorites: backup } };
    const check = await previewChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), post: routePost });
    expect(check.tables.document_favorites).toEqual({ rows: 150, existing: 100, heldElsewhere: 0, wouldInsert: 50 });
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result).toMatchObject({ totalInserted: 50, totalExisting: 100, totalHeldElsewhere: 0 });
  });
});

describe("runChunkedRestore — a request that never gets an answer stops the run, keeping what was written", () => {
  it("returns the partial outcome, the stop and the org map 'Put the files back' needs", async () => {
    let applyCalls = 0;
    const flaky: RestorePost = async (path, body) => {
      if (path.startsWith("/api/admin/restore/apply-table") && ++applyCalls === 2) throw new TypeError("Failed to fetch");
      return routePost(path, body);
    };
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: { tickets: [{ id: "t1", org_id: "backup-org" }], notes: [{ id: "n1", org_id: "backup-org" }], notifications: [{ id: "x1", org_id: "backup-org" }] },
    };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: flaky });
    expect(result.idRemap.orgId).toEqual({ "backup-org": ORG });
    expect(result.tables.map((t) => t.name)).toEqual(["tickets", "notes"]);
    expect(result.totalInserted).toBe(1);
    expect(result.stoppedAt).toEqual({ table: "notes", error: expect.stringMatching(/^The connection failed while restoring notes \(Failed to fetch\)/) });
    expect(result.notAttempted).toEqual(["notifications"]);
  });

  it("a /begin that cannot be reached still throws — no table was attempted", async () => {
    const down: RestorePost = async () => { throw new TypeError("Failed to fetch"); };
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { notes: [{ id: "n1" }] } };
    await expect(runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: down })).rejects.toThrow(/Failed to fetch/);
    expect(db.attempts).toEqual([]);
  });
});

describe("ORG-1 Done-when 4 — an Object.prototype name is off contract too: 400 before any write", () => {
  it("'constructor' and '__proto__' table keys are refused by the single-shot route", async () => {
    const raw = '{"envelope":{"manifest":{"orgId":"b"},"tables":{"notes":[{"id":"n1"}],"constructor":[{"x":1}],"__proto__":[{"x":1}]}},"confirm":true}';
    const res = await applySingle(new NextRequest(`https://app/api/admin/restore/apply?orgId=${ORG}`, {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: raw,
    }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect([...(body.offContract as string[])].sort()).toEqual(["__proto__", "constructor"]);
    expect(db.writes).toEqual([]);
    const r = await chunk("constructor", [{ id: "x" }]);
    expect(r.status).toBe(400);
  });
});

// ─── admin-and-org Round G, P1 fix pass 2 ───────────────────────────────────

describe("BKP-5 (fix pass 2) — a column the database computes is never sent, so indexed knowledge restores", () => {
  beforeEach(() => {
    db.generated = { knowledge_chunks: ["tsv"], knowledge_questions: ["search_tsv"] }; // 428C9 on any value, as Postgres
    db.rows.knowledge_libraries = [{ id: "kl-1", org_id: ORG }];
    db.rows.knowledge_documents = [{ id: "kd-1", org_id: ORG, library_id: "kl-1" }];
  });

  it("the review's run: chunks and questions carrying tsv / search_tsv land, and the tables after them are attempted (both routes)", async () => {
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: {
        knowledge_chunks: [{ id: "kc-1", org_id: "backup-org", library_id: "kl-1", document_id: "kd-1", page: 1, content: "pump", tsv: "'pump':1" }],
        knowledge_page_entities: [{ id: "kpe-1", org_id: "backup-org", library_id: "kl-1", document_id: "kd-1", page: 1 }],
        knowledge_questions: [{ id: "kq-1", org_id: "backup-org", library_id: "kl-1", question: "q", answer: "a", search_tsv: "'q':1" }],
        output_templates: [{ id: "ot-1", org_id: "backup-org", name: "T" }],
        output_generations: [{ id: "og-1", org_id: "backup-org", template_id: "ot-1" }],
      },
    };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toBeNull();
    expect(result.notAttempted).toEqual([]);
    expect(result).toMatchObject({ totalInserted: 5, totalRefused: 0 });
    expect(rowsOf("knowledge_chunks")[0]).not.toHaveProperty("tsv");
    expect(rowsOf("knowledge_questions")[0]).not.toHaveProperty("search_tsv");
    for (const t of ["knowledge_chunks", "knowledge_page_entities", "knowledge_questions", "output_templates", "output_generations"]) db.rows[t] = [];
    const { status, body } = await single(env);
    expect(status).toBe(200);
    expect(body).toMatchObject({ totalInserted: 5, failedTables: [] });
  });

  it("intelligence ILIFE-5: a knowledge mirror whose controlled document is not restored is refused per row; its chunks follow it; the run goes on", async () => {
    db.rows.knowledge_documents = [];
    db.rows.documents = [{ id: "doc-here", org_id: ORG }];
    db.fks = { knowledge_documents: [{ column: "source_document_id", parent: "documents" }], knowledge_chunks: [{ column: "document_id", parent: "knowledge_documents" }] };
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: {
        knowledge_documents: [
          { id: "kd-ok", org_id: "backup-org", library_id: "kl-1", source_document_id: "doc-here" },
          { id: "kd-dangling", org_id: "backup-org", library_id: "kl-1", source_document_id: "doc-deleted" },
        ],
        knowledge_chunks: [
          { id: "kc-ok", org_id: "backup-org", library_id: "kl-1", document_id: "kd-ok", page: 1, content: "a", tsv: "'a':1" },
          { id: "kc-dangling", org_id: "backup-org", library_id: "kl-1", document_id: "kd-dangling", page: 1, content: "b", tsv: "'b':1" },
        ],
        knowledge_questions: [{ id: "kq-1", org_id: "backup-org", library_id: "kl-1", question: "q", search_tsv: "'q':1" }],
        output_templates: [{ id: "ot-1", org_id: "backup-org", name: "T" }],
      },
    };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toBeNull();
    expect(result.tables.find((t) => t.name === "knowledge_documents")!.refused).toEqual([expect.objectContaining({ id: "kd-dangling", code: "parent_outside_workspace" })]);
    expect(result.tables.find((t) => t.name === "knowledge_chunks")!.refused).toEqual([expect.objectContaining({ id: "kc-dangling", code: "parent_outside_workspace" })]);
    expect(rowsOf("knowledge_documents").map((d) => d.id)).toEqual(["kd-ok"]);
    expect(rowsOf("knowledge_chunks").map((c) => c.id)).toEqual(["kc-ok"]);
    expect(rowsOf("knowledge_questions")).toHaveLength(1);
    expect(rowsOf("output_templates")).toHaveLength(1);
  });

  it("the engine refuses the value as Postgres does (428C9 stops a table — not a row-level code)", async () => {
    expect(ROW_LEVEL_SQLSTATES.has("428C9")).toBe(false);
    const builder = from("knowledge_chunks") as unknown as { upsert: (rows: Row[], o: Record<string, unknown>) => PromiseLike<{ error: { code: string } }> };
    const raw = await builder.upsert([{ id: "x", tsv: "'a':1" }], { onConflict: "id", ignoreDuplicates: true, count: "exact" });
    expect(raw.error.code).toBe("428C9");
  });
});

describe("BKP-5 / ORG-1 (fix pass 2) — a person with no sign-in account, and a pointer that is cleared rather than cascaded", () => {
  beforeEach(() => {
    db.keys.team_members = [["team_id", "uid"]];
    db.rows.users = [{ id: "u-real" }];
    db.fks = {
      teams: [{ column: "created_by", parent: "users" }],
      team_members: [{ column: "uid", parent: "users" }, { column: "added_by", parent: "users" }, { column: "team_id", parent: "teams" }],
      libraries: [{ column: "owner_team_id", parent: "teams" }],
      documents: [{ column: "library_id", parent: "libraries" }],
      document_versions: [{ column: "record_id", parent: "documents" }],
    };
  });

  it("a team created by a placeholder lands with its creator cleared — and its library, document and version land after it", async () => {
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: {
        teams: [{ id: "team-1", org_id: "backup-org", name: "Ops", created_by: "u-placeholder" }],
        team_members: [
          { team_id: "team-1", uid: "u-real", added_by: "u-placeholder" },
          { team_id: "team-1", uid: "u-placeholder", added_by: "u-real" },
        ],
        libraries: [{ id: "lib-1", org_id: "backup-org", owner_team_id: "team-1" }],
        documents: [{ id: "doc-1", org_id: "backup-org", library_id: "lib-1" }],
        document_versions: [{ id: "v-1", org_id: "backup-org", record_id: "doc-1" }],
      },
    };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toBeNull();
    expect(rowsOf("teams")).toEqual([expect.objectContaining({ id: "team-1", org_id: ORG, created_by: null })]);
    expect(rowsOf("team_members")).toEqual([expect.objectContaining({ uid: "u-real", added_by: null })]);
    for (const t of ["libraries", "documents", "document_versions"]) expect(rowsOf(t), t).toHaveLength(1);
    expect(rowsOf("libraries")[0].owner_team_id).toBe("team-1");
    const members = result.tables.find((t) => t.name === "team_members")!;
    expect(members.refused).toEqual([{ id: "team-1/u-placeholder", code: "person_not_restored", message: expect.stringMatching(/^uid u-placeholder has no sign-in account on this deployment/) }]);
    expect(members.cleared).toEqual([{ id: "team-1/u-real", code: "person_not_restored", message: expect.stringMatching(/^added_by u-placeholder cleared/) }]);
    expect(result.tables.find((t) => t.name === "teams")!.cleared).toEqual([expect.objectContaining({ id: "team-1", code: "person_not_restored" })]);
    expect(result).toMatchObject({ totalRefused: 1, totalCleared: 2 });
    // the trail names them
    const trail = audits("RESTORE_CHUNK").find((a) => (a.details as Record<string, unknown>).table === "team_members")!;
    expect(trail.details).toMatchObject({ inserted: 1, refused: [expect.objectContaining({ code: "person_not_restored" })], cleared: [expect.objectContaining({ code: "person_not_restored" })] });
  });

  it("the users read failing fails the chunk closed — nothing is written on a guess", async () => {
    db.rows.teams = [{ id: "team-1", org_id: ORG }];
    db.readError.users = "permission denied";
    const r = await chunk("team_members", [{ team_id: "team-1", uid: "u-real" }]);
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/Could not check the people these team_members rows name/);
    expect(rowsOf("team_members")).toEqual([]);
  });

  it("/begin no longer swallows the refused profile: it counts the placeholders without one, says so and audits it", async () => {
    db.authUsers = new Set(["admin-1"]);
    const res = await beginRoute(post("/api/admin/restore/begin", {
      manifest: { orgId: "backup-org", orgName: "Acme" },
      orgMembers: [{ uid: "old-bob", email: "bob@acme.com", role: "Engineer" }],
    }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ createdUsers: 1, placeholdersWithoutProfile: 1 });
    expect((body.warnings as string[]).join(" ")).toMatch(/1 restored placeholder\(s\) have no sign-in account yet/);
    expect(audits("RESTORE_BEGIN")[0].details).toMatchObject({ createdUsers: 1, placeholdersWithoutProfile: 1 });
    expect(rowsOf("users")).toEqual([{ id: "u-real" }]);
  });

  it("an owner team or SOW document that is not here is CLEARED (reported), never cascaded; a folder is not — it carries an ACL", async () => {
    db.rows.teams = [{ id: "t-victim", org_id: VICTIM }];
    db.rows.libraries = [{ id: "lib-mine", org_id: ORG }];
    db.rows.collections = [{ id: "col-victim", org_id: VICTIM, library_id: "lib-x" }];
    db.fks = {};
    const lib = await chunk("libraries", [{ id: "lib-2", owner_team_id: "t-victim" }]);
    expect(lib.body).toMatchObject({ inserted: 1, cleared: [{ id: "lib-2", code: "parent_outside_workspace", message: "owner_team_id t-victim cleared: not a teams row of this workspace" }] });
    expect(rowsOf("libraries").find((l) => l.id === "lib-2")).toMatchObject({ org_id: ORG, owner_team_id: null });
    const proj = await chunk("projects", [{ id: "p-1", sow_document_id: "doc-missing" }]);
    expect(proj.body).toMatchObject({ inserted: 1, cleared: [expect.objectContaining({ id: "p-1", code: "parent_outside_workspace" })] });
    expect(rowsOf("projects")[0].sow_document_id).toBeNull();
    // a document under another tenant's folder is refused, not moved to the library root (wider than the backup)
    const doc = await chunk("documents", [{ id: "d-1", library_id: "lib-mine", collection_id: "col-victim" }]);
    expect(doc.body).toMatchObject({ inserted: 0, refused: [expect.objectContaining({ id: "d-1", code: "parent_outside_workspace" })] });
    expect(rowsOf("documents")).toEqual([]);
  });
});

describe("BKP-5 (fix pass 2) — a row already held is counted as kept / held elsewhere, never 'refused'", () => {
  it("a same-workspace repair restore: assets naming a type re-created under a new id are present here — counted existing, not refused", async () => {
    db.rows.asset_types = [{ id: "type-new", org_id: ORG, name: "Pump" }];
    db.rows.assets = [{ id: "a-1", org_id: ORG, type_id: null }, { id: "a-theirs", org_id: VICTIM }];
    const r = await chunk("assets", [
      { id: "a-1", type_id: "type-old" },       // present here: kept, whatever it points at
      { id: "a-theirs", type_id: "type-old" },  // another workspace holds the id
      { id: "a-2", type_id: "type-old" },       // new: refused, its type is not here
    ]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ inserted: 0, existing: 1, heldElsewhere: 1, refused: [expect.objectContaining({ id: "a-2", code: "parent_outside_workspace" })] });
    expect((r.body.refused as unknown[]).length).toBe(1);
    expect(rowsOf("assets").find((a) => a.id === "a-1")?.type_id).toBeNull(); // untouched
  });

  it("the same for a row whose pointer would be cleared: present here, it is kept as it is and nothing is reported cleared", async () => {
    db.rows.libraries = [{ id: "lib-1", org_id: ORG, owner_team_id: "t-live" }];
    const r = await chunk("libraries", [{ id: "lib-1", owner_team_id: "t-gone" }]);
    expect(r.body).toEqual({ ok: true, inserted: 0, existing: 1 });
    expect(rowsOf("libraries")[0].owner_team_id).toBe("t-live");
  });
});

describe("BKP-12 (fix pass 2) — isolating refused rows has a statement budget", () => {
  it("a chunk where every row is refused (a NOT NULL the backup lacks) costs at most the budget, and every row is reported", async () => {
    db.writeError = (table, op) => (table === "notes" && op === "upsert" ? { code: "23502", message: 'null value in column "body" violates not-null constraint' } : null);
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `n${i}` }));
    const r = await chunk("notes", rows);
    expect(r.status).toBe(200);
    const statements = db.attempts.filter((a) => a.table === "notes").length;
    expect(statements).toBeLessThanOrEqual(1 + RESTORE_BISECT_MAX_STATEMENTS);
    expect(statements).toBeGreaterThan(1);
    const refused = r.body.refused as Array<{ id: string; code: string; message: string }>;
    expect(refused).toHaveLength(500);
    expect(new Set(refused.map((x) => x.id)).size).toBe(500);
    expect(refused.every((x) => x.code === "23502")).toBe(true);
    expect(refused.some((x) => /stopped isolating rows after 100 statements; run the restore again to retry them/.test(x.message))).toBe(true);
  });

  it("one refused row among many is still isolated exactly", async () => {
    db.writeError = (table, op, rows) => (table === "notes" && op === "upsert" && rows.some((x) => x.id === "n137") ? { code: "23514", message: "check failed" } : null);
    const r = await chunk("notes", Array.from({ length: 500 }, (_, i) => ({ id: `n${i}` })));
    expect(r.body).toMatchObject({ inserted: 499, refused: [{ id: "n137", code: "23514", message: "check failed" }] });
    expect(db.attempts.filter((a) => a.table === "notes").length).toBeLessThan(25);
  });
});

describe("ORG-1 / BKP-5 (fix pass 2) — every existence check is recorded", () => {
  it("a preview call leaves a RESTORE_PREVIEW row; when it cannot, the answer is withheld", async () => {
    db.keys.team_members = [["team_id", "uid"]];
    db.rows.team_members = [{ team_id: "t-other", uid: "u-x", org_id: VICTIM }];
    const res = await applyTable(post("/api/admin/restore/apply-table", { table: "team_members", rows: [{ team_id: "t-other", uid: "u-x" }], idRemap: { orgId: {}, uid: {} }, preview: true }));
    expect(await res.json()).toMatchObject({ heldElsewhere: 1 });
    expect(audits("RESTORE_PREVIEW")).toEqual([expect.objectContaining({ org_id: ORG, user_id: "admin-1", details: expect.objectContaining({ table: "team_members", rowsReceived: 1, heldElsewhere: 1 }) })]);
    db.writeError = (table) => (table === "audit_logs" ? { code: "42501", message: "denied" } : null);
    const again = await applyTable(post("/api/admin/restore/apply-table", { table: "team_members", rows: [{ team_id: "t-other", uid: "u-x" }], idRemap: { orgId: {}, uid: {} }, preview: true }));
    const body = (await again.json()) as Record<string, unknown>;
    expect(again.status).toBe(500);
    expect(body).not.toHaveProperty("heldElsewhere");
    expect(String(body.error)).toMatch(/The check could not be recorded/);
  });
});

describe("ORG-1 (fix pass 2) — a storage key under another workspace's prefix is refused", () => {
  const VICTIM_ID = "33333333-3333-4333-8333-333333333333";
  const BACKUP_ID = "44444444-4444-4444-8444-444444444444";
  it("a version naming another tenant's object is refused; one under the backup's prefix is moved to this workspace's and lands", async () => {
    db.rows.documents = [{ id: "d-mine", org_id: ORG }];
    const r = await chunk("document_versions", [
      { id: "v-evil", record_id: "d-mine", file_url: `orgs/${VICTIM_ID}/libraries/l/x.pdf` },
      { id: "v-ok", record_id: "d-mine", file_url: `orgs/${BACKUP_ID}/libraries/l/y.pdf` },
    ], { orgId: { [BACKUP_ID]: ORG }, uid: {} });
    expect(r.status).toBe(200);
    expect(rowsOf("document_versions").map((v) => [v.id, v.file_url])).toEqual([["v-ok", `orgs/${ORG}/libraries/l/y.pdf`]]);
    expect(r.body.refused).toEqual([{ id: "v-evil", code: "storage_key_outside_workspace", message: expect.stringContaining(`(orgs/${VICTIM_ID}/)`) }]);
  });

  it("deep inside JSONB too (single-shot route); text that merely mentions 'orgs/' is data", async () => {
    const { body } = await single({
      manifest: { orgId: "b" },
      tables: {
        output_generations: [
          { id: "g-evil", org_id: "b", meta: { files: [{ key: `orgs/${VICTIM_ID}/out/a.docx` }] } },
          { id: "g-ok", org_id: "b", meta: { note: "see the orgs/teams/ page" } },
        ],
      },
    });
    const t = (body.tables as Array<Record<string, unknown>>)[0];
    expect(t.refused).toEqual([expect.objectContaining({ id: "g-evil", code: "storage_key_outside_workspace" })]);
    expect(rowsOf("output_generations").map((g) => g.id)).toEqual(["g-ok"]);
  });
});

describe("BKP-5 (fix pass 2) — the result panel never says 'nothing new' over writes the server did not count", () => {
  it("nothingNew needs zero inserted AND zero uncounted; uncounted writes get their own amber title; cleared pointers are listed", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/restore/page.tsx"), "utf8");
    expect(page).toMatch(/const nothingNew = result\.totalInserted === 0 && result\.totalUncounted === 0;/);
    expect(page).toMatch(/Restored — \{fmtNum\(result\.totalUncounted\)\} record\(s\) the server did not count/);
    expect(page).toMatch(/result\.totalRefused > 0 \|\| result\.totalCleared > 0 \|\| result\.totalUncounted > 0 \|\| nothingNew \? "border-amber-200/);
    expect(page).toMatch(/pointer\(s\) cleared/);
    expect(page).toMatch(/result\.placeholdersWithoutProfile > 0/);
  });
});

// ─── admin-and-org Round G, P1 fix pass 3 ───────────────────────────────────

describe("BKP-11 (restore half) / DEC-45 (fix pass 3) — no restored row of the mail queue can be sent", () => {
  // The hostile row the review reproduced: an external address, marked
  // external, queued, with a phishing body — everything the client INSERT
  // rail (SURF-17) refuses and the service-role restore never sees.
  const hostile = (id: string, extra: Row = {}) => ({
    id, org_id: "backup-org", to_email: "victim@external.example", subject: "Action required",
    body_text: "x", body_html: "<a href=https://evil>sign in</a>", status: "queued", attempt_count: 0,
    metadata: { external: "true" }, ...extra,
  });
  /** The drain's candidates (send-queued: status queued/failed AND attempt_count < 5), plus the
   *  rows an Admin's dead-letter re-queue (admin/settings) would make candidates again. */
  const sendable = () => rowsOf("email_notifications").filter((r) => ["queued", "failed"].includes(String(r.status)));

  it("the drain's and the re-queue's definitions are the ones this test assumes", () => {
    const drain = readFileSync(join(process.cwd(), "app/api/notifications/send-queued/route.ts"), "utf8");
    expect(drain).toMatch(/\.in\("status", \["queued", "failed"\]\)\s*\.lt\("attempt_count", MAX_ATTEMPTS\)/);
    // why landing a row terminal ('failed', attempt 5) would not do: an Admin re-queues those, address and body unchanged
    const settings = readFileSync(join(process.cwd(), "app/(protected)/admin/settings/page.tsx"), "utf8");
    expect(settings).toMatch(/\.update\(\{ status: "queued", attempt_count: 0 \}\)\s*\.eq\("org_id", activeOrgId\)\.eq\("status", "failed"\)\.gte\("attempt_count", 5\)/);
  });

  it("the chunked /apply-table refuses the table with 400 and writes nothing — not even a terminal row", async () => {
    const r = await chunk("email_notifications", [hostile("m1"), hostile("m2", { status: "failed", attempt_count: 5 }), hostile("m3", { status: "sent" })]);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/^Table "email_notifications" is never blind-imported \(the outbound mail queue/);
    expect(rowsOf("email_notifications")).toEqual([]);
    expect(db.attempts.filter((a) => a.table === "email_notifications")).toEqual([]);
    expect(sendable()).toEqual([]);
    expect(restoreTableRefusal("email_notifications")).toMatch(/delivery state is never restored/);
  });

  it("the single-shot /apply plans it out and lands the rest; the plan says why; a live queue row of this workspace is untouched", async () => {
    db.rows.email_notifications = [{ id: "live-1", org_id: ORG, to_email: "a@acme.com", status: "sent", attempt_count: 1 }];
    const env = { manifest: { orgId: "backup-org" }, tables: { email_notifications: [hostile("m1")], notes: [{ id: "n1", org_id: "backup-org" }] } };
    const plan = planFor(env as RestoreEnvelopeLike);
    expect(plan.counts.tables.find((t) => t.name === "email_notifications")).toMatchObject({ willImport: false, reason: expect.stringMatching(/outbound mail queue/) });
    expect(plan.counts.tables.find((t) => t.name === "email_notifications")!.offContract).toBeUndefined();
    const { status, body } = await single(env);
    expect(status).toBe(200);
    expect(body.failedTables).toEqual([]);
    expect((body.tables as Array<{ name: string }>).map((t) => t.name)).toEqual(["notes"]);
    expect(rowsOf("email_notifications")).toEqual([{ id: "live-1", org_id: ORG, to_email: "a@acme.com", status: "sent", attempt_count: 1 }]);
    expect(sendable()).toEqual([]);
  });

  it("the page's driver never sends the table at all", async () => {
    const sent: string[] = [];
    const spy: RestorePost = async (path, body) => {
      if (path.startsWith("/api/admin/restore/apply-table")) sent.push(String((body as { table: string }).table));
      return routePost(path, body);
    };
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { email_notifications: [hostile("m1")], notes: [{ id: "n1", org_id: "backup-org" }] } };
    const result = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: spy });
    expect(result.stoppedAt).toBeNull();
    expect(sent).toEqual(["notes"]);
    expect(sendable()).toEqual([]);
  });
});

describe("BKP-5 / BKP-12 (fix pass 3) — a re-run links the placeholders the first run created; nothing uid-keyed lands twice", () => {
  const ALICE = "uid-alice-live";
  beforeEach(() => {
    db.rows.org_members = [{ org_id: ORG, uid: ALICE, email: "alice@acme.com", status: "active" }];
    db.keys.recently_viewed_docs = [["user_id", "document_id"]];
    db.keys.document_favorites = [["user_id", "document_id"]];
  });
  const backupMembers = [
    { uid: "old-alice", email: "alice@acme.com", role: "Engineer" },
    { uid: "old-bob", email: "bob@acme.com", role: "Engineer" },
    { uid: "old-cara", email: "Cara@Acme.com", role: "Viewer" },
  ];
  const begin = async () => {
    const res = await beginRoute(post("/api/admin/restore/begin", { manifest: { orgId: "backup-org", orgName: "Acme" }, orgMembers: backupMembers }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const membersWith = (email: string) => rowsOf("org_members").filter((m) => String(m.email).toLowerCase() === email);
  /** What the page reads before it plans (every status, as /begin reads). */
  const pagePlan = (env: RestoreEnvelopeLike) => planRestore(env, {
    orgId: ORG, orgName: "Acme",
    members: rowsOf("org_members").filter((m) => RESTORE_LINK_MEMBER_STATUSES.includes(String(m.status)))
      .map((m) => ({ uid: String(m.uid), email: String(m.email), status: String(m.status) })),
  });

  it("/begin twice: one placeholder per person, and the second answers the SAME uid map with nothing created", async () => {
    const first = await begin();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ createdUsers: 2, linkedUsers: 1 });
    const second = await begin();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ createdUsers: 0, linkedUsers: 3 });
    expect((second.body.idRemap as { uid: Record<string, string> }).uid).toEqual((first.body.idRemap as { uid: Record<string, string> }).uid);
    for (const e of ["alice@acme.com", "bob@acme.com", "cara@acme.com"]) expect(membersWith(e), e).toHaveLength(1);
    expect(membersWith("bob@acme.com")[0].status).toBe("inactive"); // linking changes nothing about the row
    expect(audits("RESTORE_BEGIN").map((a) => (a.details as Record<string, unknown>).createdUsers)).toEqual([2, 0]);
  });

  it("the page's driver run twice (the stop panel's advice): favorites and recents are not duplicated, and the person is one member", async () => {
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org", orgName: "Acme" },
      tables: {
        org_members: backupMembers,
        documents: [{ id: "d1", org_id: "backup-org", title: "P&ID" }],
        recently_viewed_docs: [{ org_id: "backup-org", user_id: "old-bob", document_id: "d1" }, { org_id: "backup-org", user_id: "old-alice", document_id: "d1" }],
        document_favorites: [{ org_id: "backup-org", user_id: "old-bob", document_id: "d1" }],
      },
    };
    const first = await runChunkedRestore({ orgId: ORG, envelope: env, plan: pagePlan(env), orgNameChoice: "current", post: routePost });
    expect(first.stoppedAt).toBeNull();
    expect(first.createdUsers).toBe(2);
    const replan = pagePlan(env);
    expect(replan.counts).toMatchObject({ matchedUsers: 3, newUsers: 0 }); // what the page now shows before the re-run
    expect(replan.users.find((u) => u.email === "bob@acme.com")).toMatchObject({ disposition: "linked", linkedStatus: "inactive" });
    const second = await runChunkedRestore({ orgId: ORG, envelope: env, plan: replan, orgNameChoice: "current", post: routePost });
    expect(second.stoppedAt).toBeNull();
    expect(second).toMatchObject({ createdUsers: 0, linkedUsers: 3, totalInserted: 0 });
    expect(second.idRemap.uid).toEqual(first.idRemap.uid);
    for (const t of ["recently_viewed_docs", "document_favorites"]) {
      expect(second.tables.find((x) => x.name === t), t).toMatchObject({ inserted: 0, existing: t === "recently_viewed_docs" ? 2 : 1 });
    }
    expect(rowsOf("recently_viewed_docs")).toHaveLength(2);
    expect(rowsOf("document_favorites")).toEqual([expect.objectContaining({ user_id: first.idRemap.uid["old-bob"], document_id: "d1" })]);
    expect(membersWith("bob@acme.com")).toHaveLength(1);
  });

  it("the single-shot /apply run twice: the same", async () => {
    const env = {
      manifest: { orgId: "backup-org", orgName: "Acme" },
      tables: { org_members: backupMembers, documents: [{ id: "d1", org_id: "backup-org" }], document_favorites: [{ org_id: "backup-org", user_id: "old-bob", document_id: "d1" }] },
    };
    const first = await single(env);
    expect(first.body).toMatchObject({ ok: true, createdUsers: 2 });
    const second = await single(env);
    expect(second.body).toMatchObject({ ok: true, createdUsers: 0, linkedUsers: 3, totalInserted: 0 });
    expect(rowsOf("document_favorites")).toHaveLength(1);
    expect(membersWith("bob@acme.com")).toHaveLength(1);
  });

  it("one address with several rows links the active one first; a row given no status counts as active", () => {
    const env: RestoreEnvelopeLike = { manifest: { orgId: "b" }, tables: { org_members: [{ uid: "old", email: "dan@acme.com" }] } };
    const linkTo = (members: CurrentMember[]) => planRestore(env, { orgId: ORG, orgName: "", members }).users[0];
    expect(linkTo([{ uid: "p1", email: "dan@acme.com", status: "inactive" }, { uid: "real", email: "DAN@acme.com", status: "active" }]))
      .toMatchObject({ disposition: "linked", newUid: "real", linkedStatus: "active" });
    expect(linkTo([{ uid: "real", email: "dan@acme.com", status: "active" }, { uid: "p1", email: "dan@acme.com", status: "inactive" }]).newUid).toBe("real");
    expect(linkTo([{ uid: "p1", email: "dan@acme.com", status: "inactive" }, { uid: "p2", email: "dan@acme.com", status: "inactive" }]).newUid).toBe("p1");
    expect(linkTo([{ uid: "s", email: "dan@acme.com", status: "suspended" }, { uid: "i", email: "dan@acme.com", status: "invited" }]).newUid).toBe("i");
    expect(linkTo([{ uid: "legacy", email: "dan@acme.com" }])).toMatchObject({ newUid: "legacy", linkedStatus: "active" });
    expect(linkTo([])).toMatchObject({ disposition: "new" });
    expect(linkTo([]).linkedStatus).toBeUndefined();
  });

  it("every status a membership can hold links (types/schema.ts MemberStatus), and both routes and the page read them", () => {
    const schema = readFileSync(join(process.cwd(), "types/schema.ts"), "utf8");
    const declared = /export type MemberStatus = ([^;]+);/.exec(schema)![1].match(/"([a-z_]+)"/g)!.map((x) => x.slice(1, -1));
    expect([...RESTORE_LINK_MEMBER_STATUSES].sort()).toEqual([...declared].sort());
    // Fix pass 4: /preview reconciles the same way, and every reader checks the read.
    for (const f of ["app/api/admin/restore/begin/route.ts", "app/api/admin/restore/apply/route.ts", "app/api/admin/restore/preview/route.ts", "app/(protected)/admin/restore/page.tsx"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).toMatch(/\{ data: memberRows, error: memberReadErr \}[^;]*from\("org_members"\)\.select\("uid, email, status"\)\.eq\("org_id", (orgId|activeOrgId)\)\.in\("status", \[\.\.\.RESTORE_LINK_MEMBER_STATUSES\]\)/);
      expect(src, f).toMatch(/if \(readErr\) (throw|\{)/);
      expect(src, f).not.toMatch(/\.eq\("status", "active"\)/);
    }
  });
});

describe("BKP-5 (fix pass 3) — a cleared pointer is reported only for a row the database took", () => {
  beforeEach(() => {
    db.keys.teams = [["id"], ["org_id", "name"]];
    db.rows.users = [{ id: "u-real" }];
    db.rows.teams = [{ id: "team-live", org_id: ORG, name: "Ops" }];
  });
  const team = (id: string, name: string) => ({ id, org_id: "backup-org", name, created_by: "u-placeholder" });

  it("a cleared row the database then refuses (23505) is in refused only; its neighbour lands and is the one clear reported", async () => {
    const r = await chunk("teams", [team("team-2", "Ops"), team("team-3", "Eng")]);
    expect(r.status).toBe(200);
    expect(r.body.refused).toEqual([expect.objectContaining({ id: "team-2", code: "23505" })]);
    expect(r.body.cleared).toEqual([expect.objectContaining({ id: "team-3", code: "person_not_restored" })]);
    expect(rowsOf("teams").map((t) => t.id)).toEqual(["team-live", "team-3"]);
    expect(audits("RESTORE_CHUNK")[0].details).toMatchObject({ inserted: 1, refused: [expect.objectContaining({ id: "team-2" })], cleared: [expect.objectContaining({ id: "team-3" })] });
    // the run's totals and the single-shot route agree
    db.rows.teams = [{ id: "team-live", org_id: ORG, name: "Ops" }];
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { teams: [team("team-2", "Ops"), team("team-3", "Eng")] } };
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(run).toMatchObject({ totalInserted: 1, totalRefused: 1, totalCleared: 1 });
    db.rows.teams = [{ id: "team-live", org_id: ORG, name: "Ops" }];
    const { body } = await single(env);
    const t = (body.tables as Array<Record<string, unknown>>).find((x) => x.name === "teams")!;
    expect(t).toMatchObject({ inserted: 1, refused: [expect.objectContaining({ id: "team-2" })], cleared: [expect.objectContaining({ id: "team-3" })] });
  });

  it("a cleared row refused alone (one-row chunk) reports no clear, and leaves no 'pointer cleared' audit", async () => {
    const r = await chunk("teams", [team("team-2", "Ops")]);
    expect(r.body).toMatchObject({ inserted: 0, refused: [expect.objectContaining({ id: "team-2", code: "23505" })] });
    expect(r.body.cleared).toBeUndefined();
    expect((audits("RESTORE_CHUNK")[0].details as Record<string, unknown>).cleared).toBeUndefined();
  });

  it("a statement that fails the chunk outright reports no clear for rows it never wrote — and leaves nothing to audit", async () => {
    db.writeError = (table, op) => (table === "teams" && op === "upsert" ? { code: "42703", message: 'column "slug" of relation "teams" does not exist' } : null);
    const r = await chunk("teams", [team("team-3", "Eng")]);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ inserted: 0, code: "42703" });
    expect(r.body.cleared).toBeUndefined();
    expect(audits("RESTORE_CHUNK")).toEqual([]);
    const direct = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "teams", rows: [team("team-3", "Eng")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
    expect(direct).toMatchObject({ ok: false, inserted: 0, cleared: [] });
  });
});

describe("BKP-5 / BKP-12 (fix pass 4) — the reconciliation fails closed: an unread member list, a refused rename or placeholder writes no table", () => {
  const ALICE = "uid-alice-live";
  beforeEach(() => {
    db.rows.org_members = [{ org_id: ORG, uid: ALICE, email: "alice@acme.com", status: "active" }];
  });
  const backupMembers = [
    { uid: "old-alice", email: "alice@acme.com", role: "Engineer" },
    { uid: "old-bob", email: "bob@acme.com", role: "Engineer" },
    { uid: "old-cara", email: "cara@acme.com", role: "Viewer" },
  ];
  const begin = async (extra: Record<string, unknown> = {}) => {
    const res = await beginRoute(post("/api/admin/restore/begin", { manifest: { orgId: "backup-org", orgName: "Acme" }, orgMembers: backupMembers, ...extra }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const env = (extra: Record<string, unknown[]> = {}) => ({
    manifest: { orgId: "backup-org", orgName: "Acme" },
    tables: { org_members: backupMembers, documents: [{ id: "d1", org_id: "backup-org", owner_user_id: "old-alice" }], document_favorites: [{ org_id: "backup-org", user_id: "old-bob", document_id: "d1" }], ...extra },
  });
  const memberInserts = () => db.attempts.filter((a) => a.table === "org_members");

  it("/begin: the member read failing answers 500 before the rename, any placeholder or any audit row", async () => {
    db.readError.org_members = "canceling statement due to statement timeout";
    const r = await begin({ manifest: { orgId: "backup-org", orgName: "Acme Inc." }, orgNameChoice: "backup" });
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/^Could not read this workspace's members \(canceling statement due to statement timeout\) — nothing was written\.$/);
    expect(r.body.idRemap).toBeUndefined();
    expect(memberInserts()).toEqual([]);
    expect(rowsOf("org_members")).toHaveLength(1);
    expect(rowsOf("orgs").find((o) => o.id === ORG)!.name).toBe("Acme");
    expect(audits("RESTORE_BEGIN")).toEqual([]);
  });

  it("/apply: the same — no placeholder, no table, no audit; and the page's driver stops at /begin with that message", async () => {
    db.readError.org_members = "permission denied";
    const r = await single(env());
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/^Could not read this workspace's members \(permission denied\)/);
    expect(db.attempts).toEqual([]);
    expect(rowsOf("documents")).toEqual([]);
    expect(audits("DATA_RESTORE")).toEqual([]);
    const e = env() as RestoreEnvelopeLike;
    await expect(runChunkedRestore({ orgId: ORG, envelope: e, plan: planFor(e), orgNameChoice: "current", post: routePost }))
      .rejects.toThrow(/Could not read this workspace's members/);
    expect(db.attempts).toEqual([]);
  });

  it("the workspace-name read failing is refused the same way (it decides the rename)", async () => {
    db.readError.orgs = "permission denied for table orgs";
    const r = await begin({ orgNameChoice: "backup" });
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/^Could not read this workspace's name/);
    expect(db.attempts).toEqual([]);
  });

  it("/preview reads members of every status (a re-run's placeholders are linked, as /begin links them) and refuses an unread list", async () => {
    const first = await begin();
    expect(first.body).toMatchObject({ createdUsers: 2 });
    const res = await previewRoute(post("/api/admin/restore/preview", env()));
    const { plan } = (await res.json()) as { plan: { counts: { matchedUsers: number; newUsers: number }; idRemap: { uid: Record<string, string> } } };
    expect(res.status).toBe(200);
    expect(plan.counts).toMatchObject({ matchedUsers: 3, newUsers: 0 });
    expect(plan.idRemap.uid).toEqual((first.body.idRemap as { uid: Record<string, string> }).uid);
    db.readError.org_members = "timeout";
    const failed = await previewRoute(post("/api/admin/restore/preview", env()));
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toMatch(/^Could not read this workspace's members \(timeout\) — no plan was made\.$/);
  });

  it("/begin: a placeholder that cannot be made answers 500 naming the address — the run never reaches a table; a re-run links what was made", async () => {
    db.writeError = (table, op, rows) => (table === "org_members" && op === "insert" && rows[0].email === "cara@acme.com" ? { code: "P0001", message: "refused by trigger" } : null);
    const r = await begin();
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/^Could not create the restored placeholder for cara@acme\.com \(refused by trigger\)\. No table was written\. 1 placeholder\(s\) made before it are kept/);
    expect(r.body.idRemap).toBeUndefined(); // no map to write rows with — old-cara can never land unmapped
    expect(audits("RESTORE_BEGIN")[0].details).toMatchObject({ createdUsers: 1, failed: "placeholder for cara@acme.com: refused by trigger" });
    const bobUid = rowsOf("org_members").find((m) => m.email === "bob@acme.com")!.uid;
    db.writeError = null;
    const again = await begin();
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ createdUsers: 1, linkedUsers: 2 });
    expect((again.body.idRemap as { uid: Record<string, string> }).uid).toMatchObject({ "old-alice": ALICE, "old-bob": bobUid });
    expect(rowsOf("org_members").filter((m) => m.email === "bob@acme.com")).toHaveLength(1);
  });

  it("through the page's driver: the run stops at /begin — no table is attempted, nothing lands naming the raw backup uid", async () => {
    db.writeError = (table, op, rows) => (table === "org_members" && op === "insert" && rows[0].email === "bob@acme.com" ? { code: "23514", message: "check violated" } : null);
    const e = env() as RestoreEnvelopeLike;
    await expect(runChunkedRestore({ orgId: ORG, envelope: e, plan: planFor(e), orgNameChoice: "current", post: routePost }))
      .rejects.toThrow(/Could not create the restored placeholder for bob@acme\.com/);
    expect(db.attempts.filter((a) => a.table !== "org_members" && a.table !== "audit_logs")).toEqual([]);
    expect(rowsOf("document_favorites")).toEqual([]);
  });

  it("/apply: a placeholder that cannot be made stops before any table, and the DATA_RESTORE row records what was made and why it stopped", async () => {
    db.writeError = (table, op, rows) => (table === "org_members" && op === "insert" && rows[0].email === "cara@acme.com" ? { code: "P0001", message: "refused by trigger" } : null);
    const r = await single(env());
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ createdUsers: 1, totalInserted: 0, tables: [] });
    expect(String(r.body.error)).toMatch(/placeholder for cara@acme\.com/);
    expect(rowsOf("documents")).toEqual([]);
    expect(rowsOf("document_favorites")).toEqual([]);
    expect(audits("DATA_RESTORE")[0].details).toMatchObject({ createdUsers: 1, totalInserted: 0, tables: [], failed: "placeholder for cara@acme.com: refused by trigger", orgNameApplied: false });
  });

  it("a refused rename answers 500 before any placeholder (both routes); an applied one is recorded as applied", async () => {
    db.writeError = (table, op) => (table === "orgs" && op === "update" ? { code: "23505", message: "duplicate org name" } : null);
    const renamed = { manifest: { orgId: "backup-org", orgName: "Acme Inc." }, orgNameChoice: "backup" };
    const r = await begin(renamed);
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/^Could not apply the backup's workspace name \(duplicate org name\) — nothing was written\.$/);
    expect(memberInserts()).toEqual([]);
    expect(audits("RESTORE_BEGIN")).toEqual([]);
    const s1 = await applySingle(post("/api/admin/restore/apply", { envelope: { ...env(), manifest: { orgId: "backup-org", orgName: "Acme Inc." } }, orgNameChoice: "backup", confirm: true }));
    expect(s1.status).toBe(500);
    expect(memberInserts()).toEqual([]);
    expect(rowsOf("documents")).toEqual([]);
    db.writeError = null;
    const ok = await begin(renamed);
    expect(ok.status).toBe(200);
    expect(rowsOf("orgs").find((o) => o.id === ORG)!.name).toBe("Acme Inc.");
    expect(audits("RESTORE_BEGIN")[0].details).toMatchObject({ orgNameChoice: "backup", orgNameApplied: true });
  });
});

describe("ORG-1 (fix pass 4) — an acceptable-use agreement, the spend ledger and the caps are never restored", () => {
  // The review's rows: an agreement for each member under the current version, a cap far over the route's 10,000 ceiling, a negative spend.
  const agreement = (id: string, user: string) => ({ id, org_id: "backup-org", user_id: user, user_name: "x", scope: "use", provider: "anthropic", agreement_version: "v3", ip: "203.0.113.9", accepted_at: "2026-01-02" });
  const cap = { id: "cap-1", org_id: "backup-org", user_id: null, monthly_cap_usd: 1e9 };
  const spend = { id: "ev-1", org_id: "backup-org", op: "knowledgeAsk", user_id: "u-1", est_cost_usd: -5000, ok: true };

  it("/apply-table refuses each table with 400 before any read or write", async () => {
    for (const [table, rows, why] of [
      ["ai_key_agreements", [agreement("k1", "u-1"), agreement("k2", "u-2")], /append-only \(acceptable-use agreements are the signer's own act/],
      ["ai_usage_events", [spend], /append-only \(the AI spend ledger/],
      ["ai_usage_limits", [cap], /never blind-imported \(monthly AI spend caps are set only through the controller route/],
    ] as const) {
      const r = await chunk(table, [...rows]);
      expect(r.status, table).toBe(400);
      expect(String(r.body.error), table).toMatch(why);
      expect(rowsOf(table), table).toEqual([]);
    }
    expect(db.attempts).toEqual([]);
  });

  it("the single-shot /apply and the page's driver plan them out and land the rest", async () => {
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: { ai_key_agreements: [agreement("k1", "u-1")], ai_usage_limits: [cap], ai_usage_events: [spend], notes: [{ id: "n1", org_id: "backup-org" }] },
    };
    const { status, body } = await single(env);
    expect(status).toBe(200);
    expect((body.tables as Array<{ name: string }>).map((t) => t.name)).toEqual(["notes"]);
    const sent: string[] = [];
    const spy: RestorePost = async (path, b) => {
      if (path.startsWith("/api/admin/restore/apply-table")) sent.push(String((b as { table: string }).table));
      return routePost(path, b);
    };
    db.rows.notes = [];
    await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: spy });
    expect(sent).toEqual(["notes"]);
    for (const t of ["ai_key_agreements", "ai_usage_limits", "ai_usage_events"]) expect(rowsOf(t), t).toEqual([]);
  });
});

describe("ALOG-8 (fix pass 4) — a chunk that failed after a count-less accepted statement is audited", () => {
  it("statement 1 accepted without a count, statement 2 refused: 500 with uncounted, and a RESTORE_CHUNK row records both", async () => {
    db.countless = true;
    db.writeError = (table, op, rows) => (table === "plants" && op === "upsert" && rows[0].id === "p500" ? { code: "42703", message: 'column "zone" of relation "plants" does not exist' } : null);
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: `p${i}`, org_id: "backup-org", name: `Plant ${i}` }));
    const r = await chunk("plants", rows);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ inserted: 0, uncounted: 500, code: "42703" });
    const trail = audits("RESTORE_CHUNK");
    expect(trail).toHaveLength(1);
    expect(trail[0].details).toMatchObject({ table: "plants", rowsReceived: 600, inserted: 0, uncounted: 500, failed: 'column "zone" of relation "plants" does not exist' });
  });

  it("a chunk whose only statement failed still leaves nothing to record", async () => {
    db.writeError = (table, op) => (table === "plants" && op === "upsert" ? { code: "42703", message: "no column" } : null);
    const r = await chunk("plants", [{ id: "p1", org_id: "backup-org" }]);
    expect(r.status).toBe(500);
    expect(audits("RESTORE_CHUNK")).toEqual([]);
  });
});


describe("BKP-5 / ORG-1 (fix pass 5) — every backup uid is mapped to a person, or every row naming it is refused", () => {
  const LIVE_BOB = "live-bob";
  // The review's backup: one address, two membership rows (an inactive historical row beside a re-added one, 20261018).
  const bobRows = [
    { uid: "old-bob-inactive", email: "bob@acme.com", status: "inactive", role: "Engineer" },
    { uid: "old-bob-active", email: "Bob@acme.com", status: "active", role: "Engineer", display_name: "Bob" },
  ];
  const pagePlan = (env: RestoreEnvelopeLike) => planRestore(env, {
    orgId: ORG, orgName: "Acme",
    members: rowsOf("org_members").filter((m) => RESTORE_LINK_MEMBER_STATUSES.includes(String(m.status)))
      .map((m) => ({ uid: String(m.uid), email: (m.email as string | null) ?? null, status: String(m.status) })),
  });
  /** The workspace's records — the audit trail names a refused uid on purpose. */
  const records = () => JSON.stringify(Object.entries(db.rows).filter(([t]) => t !== "audit_logs"));
  beforeEach(() => {
    db.keys.team_members = [["team_id", "uid"]];
    db.keys.document_favorites = [["user_id", "document_id"]];
    db.fks = { team_members: [{ column: "uid", parent: "users" }, { column: "team_id", parent: "teams" }], document_versions: [{ column: "record_id", parent: "documents" }] };
  });

  it("the plan maps both rows of one address to the same person; the active row speaks for them", () => {
    const plan = planRestore({ manifest: { orgId: "backup-org" }, tables: { org_members: bobRows } }, { orgId: ORG, orgName: "", members: [{ uid: LIVE_BOB, email: "bob@acme.com", status: "active" }] });
    expect(plan.users).toEqual([expect.objectContaining({ oldUid: "old-bob-active", aliasUids: ["old-bob-inactive"], disposition: "linked", newUid: LIVE_BOB, displayName: "Bob" })]);
    expect(plan.idRemap.uid).toEqual({ "old-bob-active": LIVE_BOB, "old-bob-inactive": LIVE_BOB });
    expect(plan.counts).toMatchObject({ matchedUsers: 1, newUsers: 0, unmappedUsers: 0 });
    expect(plan.idRemap.unmappedUids).toBeUndefined();
  });

  it("the review's run (page driver): a document owned by the second uid lands owned by live-bob, and Bob's team membership lands", async () => {
    db.rows.org_members = [{ org_id: ORG, uid: LIVE_BOB, email: "bob@acme.com", status: "active" }];
    db.rows.users = [{ id: LIVE_BOB }];
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org", orgName: "Acme" },
      tables: {
        org_members: bobRows,
        teams: [{ id: "team-1", org_id: "backup-org", name: "Ops" }],
        team_members: [{ team_id: "team-1", uid: "old-bob-active" }],
        documents: [
          { id: "d-active", org_id: "backup-org", owner_user_id: "old-bob-active" },
          { id: "d-old", org_id: "backup-org", owner_user_id: "old-bob-inactive", attributes: { reviewers: ["old-bob-inactive"] } },
        ],
      },
    };
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: pagePlan(env), orgNameChoice: "current", post: routePost });
    expect(run.stoppedAt).toBeNull();
    expect(run).toMatchObject({ createdUsers: 0, linkedUsers: 1, totalRefused: 0, unmappedMembers: 0 });
    expect(run.idRemap.uid).toEqual({ "old-bob-active": LIVE_BOB, "old-bob-inactive": LIVE_BOB });
    expect(rowsOf("documents").map((d) => [d.id, d.owner_user_id])).toEqual([["d-active", LIVE_BOB], ["d-old", LIVE_BOB]]);
    expect(rowsOf("documents")[1].attributes).toEqual({ reviewers: [LIVE_BOB] });
    expect(rowsOf("team_members")).toEqual([expect.objectContaining({ team_id: "team-1", uid: LIVE_BOB })]);
    expect(records()).not.toMatch(/old-bob/);
  });

  it("a new person with two rows: ONE placeholder, both uids map to it (/begin and /apply), and a re-run links it", async () => {
    const begin = async () => {
      const res = await beginRoute(post("/api/admin/restore/begin", { manifest: { orgId: "backup-org" }, orgMembers: bobRows }));
      return (await res.json()) as { createdUsers: number; idRemap: { uid: Record<string, string> } };
    };
    const first = await begin();
    expect(first.createdUsers).toBe(1);
    const placeholder = rowsOf("org_members").filter((m) => m.email === "Bob@acme.com" || m.email === "bob@acme.com");
    expect(placeholder).toHaveLength(1);
    expect(first.idRemap.uid).toEqual({ "old-bob-active": placeholder[0].uid, "old-bob-inactive": placeholder[0].uid });
    const again = await begin();
    expect(again).toMatchObject({ createdUsers: 0 });
    expect(again.idRemap.uid).toEqual(first.idRemap.uid);
    // the single-shot route, into a fresh workspace
    db.rows.org_members = [];
    const env = {
      manifest: { orgId: "backup-org" },
      tables: { org_members: bobRows, documents: [{ id: "d1", org_id: "backup-org" }], document_favorites: [{ org_id: "backup-org", user_id: "old-bob-inactive", document_id: "d1" }, { org_id: "backup-org", user_id: "old-bob-active", document_id: "d1" }] },
    };
    const { status, body } = await single(env);
    expect(status).toBe(200);
    expect(body).toMatchObject({ createdUsers: 1 });
    const uid = rowsOf("org_members")[0].uid;
    // both favorites name the one placeholder: the second is the same key, kept as existing — never a raw backup uid
    expect(rowsOf("document_favorites")).toEqual([expect.objectContaining({ user_id: uid, document_id: "d1" })]);
  });

  it("a backup member with no email address and no member here is unmapped: the plan says so and every row naming them is refused (both routes)", async () => {
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: {
        org_members: [{ uid: "old-ghost", email: null, display_name: "Ghost" }, { uid: "old-ann", email: "ann@acme.com" }],
        documents: [
          { id: "d-ghost", org_id: "backup-org", owner_user_id: "old-ghost" },
          { id: "d-ann", org_id: "backup-org", owner_user_id: "old-ann" },
        ],
        document_versions: [{ id: "v-ghost", org_id: "backup-org", record_id: "d-ghost" }, { id: "v-ann", org_id: "backup-org", record_id: "d-ann" }],
        notes: [{ id: "n-1", org_id: "backup-org", body: "x", meta: { unread_by: ["old-ann", "old-ghost"] } }],
      },
    };
    const plan = pagePlan(env);
    expect(plan.counts).toMatchObject({ newUsers: 1, unmappedUsers: 1 });
    expect(plan.idRemap.unmappedUids).toEqual(["old-ghost"]);
    expect(plan.warnings.join(" ")).toMatch(/1 backup member\(s\) have no email address and no membership here under the same id \(Ghost\)/);
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan, orgNameChoice: "current", post: routePost });
    expect(run.stoppedAt).toBeNull();
    expect(run.unmappedMembers).toBe(1);
    expect(run.idRemap.unmappedUids).toEqual(["old-ghost"]);
    const refusedOf = (t: string) => run.tables.find((x) => x.name === t)!.refused.map((r) => [r.id, r.code]);
    expect(refusedOf("documents")).toEqual([["d-ghost", "person_not_mapped"]]);
    expect(refusedOf("document_versions")).toEqual([["v-ghost", "parent_outside_workspace"]]);
    expect(refusedOf("notes")).toEqual([["n-1", "person_not_mapped"]]); // deep inside JSONB too
    expect(rowsOf("documents").map((d) => d.id)).toEqual(["d-ann"]);
    expect(records()).not.toMatch(/old-ghost/);
    expect(audits("RESTORE_BEGIN")[0].details).toMatchObject({ unmappedMembers: 1 });
    // the single-shot route refuses them the same way, and its trail says so
    db.rows = { orgs: [{ id: ORG, name: "Acme" }], org_members: [], audit_logs: [] };
    const { status, body } = await single(env);
    expect(status).toBe(200);
    expect(body).toMatchObject({ unmappedMembers: 1 });
    expect(String(body.note)).toMatch(/1 backup member\(s\) with no email address could not be mapped to anyone here/);
    expect(rowsOf("documents").map((d) => d.id)).toEqual(["d-ann"]);
    expect(audits("DATA_RESTORE")[0].details).toMatchObject({ unmappedMembers: 1 });
    expect(records()).not.toMatch(/old-ghost/);
  });

  it("restored into the workspace that still holds them, a member with no address is linked by uid — nothing is refused", async () => {
    db.rows.org_members = [{ org_id: ORG, uid: "old-ghost", email: null, status: "active" }];
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: { org_members: [{ uid: "old-ghost", email: null }], documents: [{ id: "d-ghost", org_id: "backup-org", owner_user_id: "old-ghost" }] },
    };
    const plan = pagePlan(env);
    expect(plan.counts).toMatchObject({ matchedUsers: 1, newUsers: 0, unmappedUsers: 0 });
    expect(plan.users[0]).toMatchObject({ email: "", disposition: "linked", newUid: "old-ghost" });
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan, orgNameChoice: "current", post: routePost });
    expect(run).toMatchObject({ totalInserted: 1, totalRefused: 0, createdUsers: 0, linkedUsers: 1 });
    expect(rowsOf("documents")).toEqual([expect.objectContaining({ id: "d-ghost", owner_user_id: "old-ghost" })]);
  });

  it("every route and the page pass members with no address to the planner (they link by uid)", () => {
    for (const f of ["app/api/admin/restore/begin/route.ts", "app/api/admin/restore/apply/route.ts", "app/api/admin/restore/preview/route.ts", "app/(protected)/admin/restore/page.tsx"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/\.filter\(\(m\) => m\.email\)/);
      expect(src, f).toMatch(/\.map\(\(m\) => \(\{ uid: m\.uid, email: m\.email, status: m\.status \}\)\)/);
    }
    for (const f of ["app/api/admin/restore/begin/route.ts", "app/api/admin/restore/apply/route.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).toMatch(/for \(const alias of u\.aliasUids \?\? \[\]\) created\[alias\] = newUid;/);
    }
  });
});

describe("BKP-5 / ALOG-8 (fix pass 5) — the single-shot DATA_RESTORE row carries what was not counted and what was filtered", () => {
  it("a count-less server: the per-table entry and the totals say uncounted, never 'inserted 0' alone", async () => {
    db.countless = true;
    const plants = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, org_id: "backup-org", name: `Plant ${i}` }));
    const { status, body } = await single({ manifest: { orgId: "backup-org" }, tables: { plants } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ totalInserted: 0, totalUncounted: 500 });
    expect(String(body.note)).toMatch(/500 record\(s\) were sent but the server did not report whether they were written/);
    const details = audits("DATA_RESTORE")[0].details as Record<string, unknown>;
    expect(details).toMatchObject({ totalInserted: 0, totalUncounted: 500, totalFiltered: 0 });
    expect(details.tables).toEqual([expect.objectContaining({ name: "plants", inserted: 0, uncounted: 500 })]);
  });

  it("comments of an archived ticket left out by the filter are counted in the trail too", async () => {
    db.rows.tickets = [{ id: "t-archived", org_id: ORG, archived_at: "2026-09-01T00:00:00Z" }, { id: "t-live", org_id: ORG, archived_at: null }];
    const { body } = await single({ manifest: { orgId: "backup-org" }, tables: { ticket_comments: [{ id: "c1", ticket_id: "t-archived" }, { id: "c2", ticket_id: "t-live" }] } });
    expect(body).toMatchObject({ totalInserted: 1, totalFiltered: 1 });
    const details = audits("DATA_RESTORE")[0].details as Record<string, unknown>;
    expect(details).toMatchObject({ totalFiltered: 1 });
    expect(details.tables).toEqual([expect.objectContaining({ name: "ticket_comments", inserted: 1, filtered: 1 })]);
  });
});

describe("BKP-5 (fix pass 5) — a numbering counter held here is advanced past the restored numbers, never lowered", () => {
  beforeEach(() => {
    db.keys.ticket_number_counters = [["org_id", "year"]];
    db.keys.library_numbering = [["library_id"]];
    db.rows.libraries = [{ id: "lib-1", org_id: ORG }, { id: "lib-2", org_id: ORG }];
  });

  it("the review's run: five requests filed here, then 150 restored — the next number is 151, not 6 (all three paths)", async () => {
    const counters = [{ org_id: "backup-org", year: 2026, next_seq: 150 }, { org_id: "backup-org", year: 2025, next_seq: 40 }];
    db.rows.ticket_number_counters = [{ org_id: ORG, year: 2026, next_seq: 5 }, { org_id: ORG, year: 2025, next_seq: 90 }];
    const r = await chunk("ticket_number_counters", counters);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ inserted: 0, existing: 2, advanced: 1 });
    expect(rowsOf("ticket_number_counters")).toEqual([{ org_id: ORG, year: 2026, next_seq: 150 }, { org_id: ORG, year: 2025, next_seq: 90 }]); // 2025 is higher here: untouched
    expect(audits("RESTORE_CHUNK")[0].details).toMatchObject({ table: "ticket_number_counters", existing: 2, advanced: 1 });
    // a counter new to this workspace is inserted with the backup's value and needs no advance
    db.rows.ticket_number_counters = [];
    const fresh = await chunk("ticket_number_counters", counters);
    expect(fresh.body).toEqual({ ok: true, inserted: 2 });
    // the driver and the single-shot route report it too
    db.rows.ticket_number_counters = [{ org_id: ORG, year: 2026, next_seq: 5 }];
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { ticket_number_counters: [counters[0]] } };
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(run).toMatchObject({ totalAdvanced: 1, totalExisting: 1 });
    expect(rowsOf("ticket_number_counters")[0].next_seq).toBe(150);
    db.rows.ticket_number_counters = [{ org_id: ORG, year: 2026, next_seq: 5 }];
    const { body } = await single(env);
    expect(body).toMatchObject({ totalAdvanced: 1 });
    expect((audits("DATA_RESTORE")[0].details as { tables: unknown[] }).tables).toEqual([expect.objectContaining({ name: "ticket_number_counters", advanced: 1 })]);
  });

  it("a library's document counter the same way; nothing but the counter changes", async () => {
    db.rows.library_numbering = [{ library_id: "lib-1", org_id: ORG, enabled: true, prefix: "PROC-", pad: 4, next_number: 3 }];
    const r = await chunk("library_numbering", [
      { library_id: "lib-1", org_id: "backup-org", enabled: false, prefix: "OLD-", pad: 6, next_number: 42 },
      { library_id: "lib-2", org_id: "backup-org", enabled: true, prefix: "RFI-", pad: 4, next_number: 7 },
    ]);
    expect(r.body).toMatchObject({ inserted: 1, existing: 1, advanced: 1 });
    expect(rowsOf("library_numbering")).toEqual([
      { library_id: "lib-1", org_id: ORG, enabled: true, prefix: "PROC-", pad: 4, next_number: 42 },
      expect.objectContaining({ library_id: "lib-2", next_number: 7 }),
    ]);
  });

  it("a counter that cannot be advanced stops the run before the records numbered from it", async () => {
    db.rows.ticket_number_counters = [{ org_id: ORG, year: 2026, next_seq: 5 }];
    db.writeError = (table, op) => (table === "ticket_number_counters" && op === "update" ? { code: "42501", message: "permission denied" } : null);
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org" },
      tables: { ticket_number_counters: [{ org_id: "backup-org", year: 2026, next_seq: 150 }], tickets: [{ id: "t1", org_id: "backup-org", ticket_id: "KE-DDRT-26-0006" }] },
    };
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(run.stoppedAt).toMatchObject({ table: "ticket_number_counters", error: expect.stringMatching(/Could not advance the ticket_number_counters numbering counter past the restored numbers: permission denied/) });
    expect(run.notAttempted).toEqual(["tickets"]);
    expect(rowsOf("tickets")).toEqual([]);
    expect(rowsOf("ticket_number_counters")[0].next_seq).toBe(5);
  });

  it("the counter tables and columns are the ones the numbering functions write", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260724_ticket_numbering.sql"), "utf8");
    expect(sql).toMatch(/DO UPDATE SET next_seq = ticket_number_counters\.next_seq \+ 1/);
    const intel = readFileSync(join(process.cwd(), "supabase/migrations/20260806_intelligence_layer.sql"), "utf8");
    expect(intel).toMatch(/SET next_number = next_number \+ 1/);
    expect(RESTORE_COUNTER_COLUMNS).toEqual({ ticket_number_counters: "next_seq", library_numbering: "next_number" });
  });
});

describe("BKP-5 (fix pass 5) — the page plans again before it asks, so the confirm's count is what /begin then does", () => {
  it("a /begin stopped after one placeholder: the fresh plan counts one new person, and /begin then creates exactly one", async () => {
    db.rows.org_members = [{ org_id: ORG, uid: "uid-alice", email: "alice@acme.com", status: "active" }];
    const env: RestoreEnvelopeLike = {
      manifest: { orgId: "backup-org", orgName: "Acme" },
      tables: { org_members: [{ uid: "old-alice", email: "alice@acme.com" }, { uid: "old-bob", email: "bob@acme.com" }, { uid: "old-cara", email: "cara@acme.com" }], notes: [{ id: "n1", org_id: "backup-org" }] },
    };
    const pagePlan = () => planRestore(env, {
      orgId: ORG, orgName: "Acme",
      members: rowsOf("org_members").filter((m) => RESTORE_LINK_MEMBER_STATUSES.includes(String(m.status)))
        .map((m) => ({ uid: String(m.uid), email: (m.email as string | null) ?? null, status: String(m.status) })),
    });
    const atDrop = pagePlan();
    expect(atDrop.counts.newUsers).toBe(2);
    db.writeError = (table, op, rows) => (table === "org_members" && op === "insert" && rows[0].email === "cara@acme.com" ? { code: "P0001", message: "refused" } : null);
    await expect(runChunkedRestore({ orgId: ORG, envelope: env, plan: atDrop, orgNameChoice: "current", post: routePost })).rejects.toThrow(/cara@acme\.com/);
    db.writeError = null;
    const fresh = pagePlan(); // what the page now reads before the check and the confirm
    expect(fresh.counts).toMatchObject({ matchedUsers: 2, newUsers: 1 });
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: fresh, orgNameChoice: "current", post: routePost });
    expect(run.createdUsers).toBe(fresh.counts.newUsers);
    expect(run.linkedUsers).toBe(fresh.counts.matchedUsers);
  });

  it("the page's apply re-plans from a checked read before the check, the confirm and the run, and uses that plan for all three", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/restore/page.tsx"), "utf8");
    const apply = page.slice(page.indexOf("const applyRestore = async () => {"), page.indexOf("// ── 4. Put files back"));
    const replan = apply.indexOf("fresh = await readAndPlan(envelope, activeOrgId);");
    expect(replan).toBeGreaterThan(0);
    expect(replan).toBeLessThan(apply.indexOf("await previewChunkedRestore("));
    expect(apply).toMatch(/previewChunkedRestore\(\{ orgId: activeOrgId, envelope, plan: fresh,/);
    expect(apply).toMatch(/`\$\{fresh\.counts\.newUsers\} restored placeholder user\(s\) will be created/);
    expect(apply).toMatch(/runChunkedRestore\(\{ orgId: activeOrgId, envelope, plan: fresh,/);
    expect(apply).not.toMatch(/plan\.counts\.newUsers/);
    // the drop-time plan uses the same checked read
    expect(page).toMatch(/const p = await readAndPlan\(envelope, activeOrgId\);/);
  });
});

describe("BKP-5 (fix pass 5) — a clear is reported only for a row the database wrote", () => {
  beforeEach(() => {
    db.rows.teams = [{ id: "t-victim", org_id: VICTIM }];
  });
  const lib = { id: "lib-2", org_id: "backup-org", owner_team_id: "t-victim" };

  it("the same row twice in a chunk: one lands, DO NOTHING skips the copy — one clear, and the copy counted existing", async () => {
    const r = await chunk("libraries", [{ ...lib }, { ...lib }]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ inserted: 1, existing: 1 });
    expect(r.body.cleared).toEqual([{ id: "lib-2", code: "parent_outside_workspace", message: "owner_team_id t-victim cleared: not a teams row of this workspace" }]);
    expect(rowsOf("libraries")).toEqual([expect.objectContaining({ id: "lib-2", owner_team_id: null })]);
    expect((audits("RESTORE_CHUNK")[0].details as { cleared: unknown[] }).cleared).toHaveLength(1);
  });

  it("a server that gives no count: the rows are uncounted, and no clear is claimed for them", async () => {
    db.countless = true;
    const r = await chunk("libraries", [{ ...lib }, { ...lib, id: "lib-3" }]);
    expect(r.body).toMatchObject({ inserted: 0, uncounted: 2 });
    expect(r.body.cleared).toBeUndefined();
  });

  it("a clear for a row in a statement that wrote every row is still reported (one per row)", async () => {
    const r = await chunk("libraries", [{ ...lib }, { ...lib, id: "lib-3" }]);
    expect(r.body).toMatchObject({ inserted: 2 });
    expect((r.body.cleared as Array<{ id: string }>).map((c) => c.id)).toEqual(["lib-2", "lib-3"]);
  });
});
