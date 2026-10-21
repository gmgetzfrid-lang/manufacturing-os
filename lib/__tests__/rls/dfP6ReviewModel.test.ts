// drafting-flow Round G, DF-P6 REVIEW-MODEL — the two migrations, asserted at
// RUNTIME on the replayed database (each statement sent as PostgREST sends it:
// role `authenticated` with the member's JWT claims, or `service_role` with
// none, which is how the workflow and create routes write).
//
//   20261250  the declaration, the binding flag, the classes: the declaration
//             is immutable for EVERY caller (the service role included) and
//             all-or-none; engineering_required never goes true → false for
//             anyone; a client writes none of the new columns; a new row is
//             engineered by default; the BACKFILL sets true exactly where the
//             legacy gate is certain to require an engineer and leaves every
//             other pre-paste row false (the app's seed — the legacy gate,
//             live); unrelated writes still land (REGRESSION).
//   20261251  ticket_equipment: no client write; a member reads a row exactly
//             when they can read its ticket; org / asset integrity for every
//             writer; tags never rewritten; an asset's deletion clears the
//             pointer and keeps the typed tag.
//   Both re-paste cleanly (DEC-30 one paste) with every probe true.

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";
import { engineerApprovalRequired } from "@/lib/workflow";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const MIG = (f: string) => join(process.cwd(), "supabase", "migrations", f);
const F250 = "20261250_df_roundG_review_model.sql";
const F251 = "20261251_df_roundG_ticket_equipment.sql";

function paste(f: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: MIG(f), stopOnError: true });
  expect(r.ok, `${f}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("DF-P6 — the review model's columns, the ratchet, the backfill, ticket_equipment (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const ticket = (id: string, requester: string, extra: Record<string, string> = {}) => {
    const cols: Record<string, string> = {
      id: `'${id}'`, org_id: `'${orgId}'`, ticket_id: `'KE-P6-${id.slice(0, 6)}'`, title: `'Tie-in'`,
      request_type: `'New Drawing'`, status: `'PENDING_REVIEW'`, requester_id: `'${requester}'`, ...extra,
    };
    admin(db, `INSERT INTO tickets (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
  };

  beforeAll(() => {
    const s = seedOrg(db, {
      admin: { role: "Admin" }, manager: { role: "Manager" }, planner: { role: "Maintenance" },
      eng: { role: "Engineer-2" }, contractor: { role: "Contractor" }, drafter: { role: "Drafter" },
    });
    orgId = s.orgId;
    m = s.m;
  });

  it("each DF-P6 migration re-pastes cleanly (DEC-30 one paste) and every probe answers true; the inventory rows carry counts", () => {
    for (const f of [F250, F251]) {
      const { probes, inventory } = paste(f);
      expect(probes.length, f).toBeGreaterThanOrEqual(3);
      expect(probes.filter((l) => l.endsWith("|f|")), f).toEqual([]);
      expect(inventory.length, f).toBeGreaterThanOrEqual(2);
    }
  });

  // ── 20261250 ────────────────────────────────────────────────────────────────
  it("a request filed from the paste on is engineered by default (engineering_required true, no declaration)", () => {
    const id = randomUUID();
    ticket(id, m.manager.uid, { requester_role: `'Manager'` });
    expect(admin(db, `SELECT engineering_required::text || '|' || (like_in_kind_statement IS NULL)::text FROM tickets WHERE id = '${id}'`)).toBe("true|true");
    // DF-P6 fix pass 2 (review, issue 1): and filed under the review model
    expect(admin(db, `SELECT review_model_filed::text FROM tickets WHERE id = '${id}'`)).toBe("true");
  });

  it("DF-P6 fix pass 2 (review, issue 1): review_model_filed never changes — refused for EVERY caller, the service role and the paste owner included", () => {
    const id = randomUUID();
    ticket(id, m.manager.uid, { requester_role: `'Manager'` });
    const r = asCaller(db, SERVICE, `UPDATE tickets SET review_model_filed = false WHERE id = '${id}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/review_model_filed is set when the request is filed/);
    expect(asCaller(db, m.manager.caller, `UPDATE tickets SET review_model_filed = false WHERE id = '${id}'`).ok).toBe(false);
    expect(() => admin(db, `UPDATE tickets SET review_model_filed = false WHERE id = '${id}'`)).toThrow(/review_model_filed/);
    expect(admin(db, `SELECT review_model_filed::text FROM tickets WHERE id = '${id}'`)).toBe("true");
  });

  it("the declaration is all-or-none and at least 20 characters (CHECK, for every writer)", () => {
    const partial = asCaller(db, SERVICE, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, like_in_kind_statement) VALUES ('${randomUUID()}', '${orgId}', 'KE-P6-x1', 'T', 'New Drawing', 'PENDING_ASSIGNMENT', '${m.planner.uid}', 'Replacing the gasket with an identical one')`);
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.message).toMatch(/tickets_like_in_kind_all_or_none/);
    const short = asCaller(db, SERVICE, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, like_in_kind_statement, like_in_kind_declared_by, like_in_kind_declared_at, like_in_kind_signature_id, engineering_required) VALUES ('${randomUUID()}', '${orgId}', 'KE-P6-x2', 'T', 'New Drawing', 'PENDING_ASSIGNMENT', '${m.planner.uid}', 'same as before', '${m.planner.uid}', now(), '${randomUUID()}', false)`);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.message).toMatch(/tickets_like_in_kind_statement_length/);
  });

  it("a declared request (service role, at INSERT) is not engineered; its declaration cannot be changed or cleared by ANYONE afterwards — the service role included", () => {
    const id = randomUUID();
    const sig = randomUUID();
    const ins = asCaller(db, SERVICE, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, like_in_kind_statement, like_in_kind_declared_by, like_in_kind_declared_at, like_in_kind_signature_id, engineering_required) VALUES ('${id}', '${orgId}', 'KE-P6-${id.slice(0, 6)}', 'Gasket', 'Revision', 'PENDING_ASSIGNMENT', '${m.planner.uid}', 'Replacing the 6 inch gasket with an identical spiral-wound gasket', '${m.planner.uid}', now(), '${sig}', false)`);
    expect(ins.ok).toBe(true);
    for (const set of [
      "like_in_kind_statement = 'Replacing it with something entirely different now'",
      "like_in_kind_statement = NULL, like_in_kind_declared_by = NULL, like_in_kind_declared_at = NULL, like_in_kind_signature_id = NULL",
      `like_in_kind_signature_id = '${randomUUID()}'`,
    ]) {
      const r = asCaller(db, SERVICE, `UPDATE tickets SET ${set} WHERE id = '${id}'`);
      expect(r.ok, set).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/like-in-kind declaration is set when the request is filed/);
    }
    // …and the paste owner (the SQL editor) too
    expect(() => admin(db, `UPDATE tickets SET like_in_kind_statement = 'Replacing it with something entirely different now' WHERE id = '${id}'`)).toThrow(/like-in-kind declaration/);
    expect(admin(db, `SELECT like_in_kind_signature_id::text FROM tickets WHERE id = '${id}'`)).toBe(sig);
  });

  it("engineering_required only ratchets up: false → true lands for the workflow (service role); true → false is refused for EVERY caller", () => {
    const id = randomUUID();
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, like_in_kind_statement, like_in_kind_declared_by, like_in_kind_declared_at, like_in_kind_signature_id, engineering_required) VALUES ('${id}', '${orgId}', 'KE-P6-${id.slice(0, 6)}', 'Valve', 'Revision', 'PENDING_ASSIGNMENT', '${m.planner.uid}', 'Putting back the same globe valve, same trim, same rating', '${m.planner.uid}', now(), '${randomUUID()}', false)`);
    expect(asCaller(db, SERVICE, `UPDATE tickets SET engineering_required = true WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    const back = asCaller(db, SERVICE, `UPDATE tickets SET engineering_required = false WHERE id = '${id}'`);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.message).toMatch(/only ratchets up/);
    expect(() => admin(db, `UPDATE tickets SET engineering_required = false WHERE id = '${id}'`)).toThrow(/only ratchets up/);
    expect(admin(db, `SELECT engineering_required::text FROM tickets WHERE id = '${id}'`)).toBe("true");
  });

  it("a member writes none of the new columns (workflow-owned); an unrelated client write still lands (REGRESSION: the urgent mark)", () => {
    const id = randomUUID();
    ticket(id, m.manager.uid, { requester_role: `'Manager'`, status: `'PENDING_ASSIGNMENT'` });
    for (const set of ["engineering_required = false", "work_class = 'like-for-like'", "code_class = 'piping'"]) {
      const r = asCaller(db, m.manager.caller, `UPDATE tickets SET ${set} WHERE id = '${id}'`);
      expect(r.ok, set).toBe(false);
    }
    const wc = asCaller(db, m.manager.caller, `UPDATE tickets SET work_class = 'like-for-like' WHERE id = '${id}'`);
    if (!wc.ok) expect(wc.message).toMatch(/workflow-owned/);
    expect(asCaller(db, m.manager.caller, `UPDATE tickets SET priority = 1 WHERE id = '${id}'`).ok).toBe(true);
    // the workflow (service role) sets the classes
    expect(asCaller(db, SERVICE, `UPDATE tickets SET work_class = 'like-for-like', code_class = 'piping' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
  });

  it("no ticket is inserted by a signed-in client (20261208's rule kept); the insert guard would reset a client row anyway", () => {
    const r = asCaller(db, m.manager.caller, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, engineering_required) VALUES ('${randomUUID()}', '${orgId}', 'KE-P6-cl', 'T', 'New Drawing', 'PENDING_ASSIGNMENT', '${m.manager.uid}', false)`);
    expect(r.ok).toBe(false);
    expect(admin(db, `SELECT prosrc LIKE '%NEW.engineering_required := true;%' FROM pg_proc WHERE proname = 'ticket_review_model_insert_guard'`)).toBe("t");
  });

  it("THE BACKFILL: pre-paste rows are set true exactly where the legacy gate is certain; every other pre-paste row stays false (the seed decides, live) — pinned against engineerApprovalRequired", () => {
    // Simulate the database before the paste: the columns and the insert
    // trigger gone; rows filed then; the paste run.
    admin(db, [
      "DROP TRIGGER IF EXISTS trg_ticket_review_model_insert_guard ON tickets",
      "ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_like_in_kind_all_or_none",
      "ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_like_in_kind_statement_length",
      "ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_review_class_length",
      "ALTER TABLE tickets DROP COLUMN IF EXISTS like_in_kind_statement, DROP COLUMN IF EXISTS like_in_kind_declared_by, DROP COLUMN IF EXISTS like_in_kind_declared_at, DROP COLUMN IF EXISTS like_in_kind_signature_id, DROP COLUMN IF EXISTS engineering_required, DROP COLUMN IF EXISTS work_class, DROP COLUMN IF EXISTS code_class, DROP COLUMN IF EXISTS review_model_filed",
    ].join(";\n"));
    // a second workspace stores its own exempt list: its rows are left to the seed
    const s2 = seedOrg(db, { planner: { role: "Maintenance" } });
    admin(db, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${s2.orgId}', 'capability_policy', '{"caps":{"ticket.engineer_gate_exempt":["Admin"]}}'::jsonb)`);
    const gone = seedOrg(db, { left: { role: "Manager" } });
    admin(db, `UPDATE org_members SET status = 'suspended' WHERE uid = '${gone.m.left.uid}'`);
    const mixed = seedOrg(db, { mixed: { role: "Requester", roles: ["Manager"] } });
    const cases: Array<{ key: string; org: string; requester: string; role: string | null; current: string[] | null; expect: boolean; seed?: boolean }> = [
      { key: "manager", org: orgId, requester: m.manager.uid, role: "Manager", current: ["Manager"], expect: false },
      { key: "planner", org: orgId, requester: m.planner.uid, role: "Maintenance", current: ["Maintenance"], expect: true },
      { key: "engineer", org: orgId, requester: m.eng.uid, role: "Engineer-2", current: ["Engineer-2"], expect: false },
      { key: "no role stamped", org: orgId, requester: m.manager.uid, role: null, current: ["Manager"], expect: true },
      { key: "requester left", org: gone.orgId, requester: gone.m.left.uid, role: "Manager", current: [], expect: true },
      { key: "snapshot not exempt, current exempt", org: mixed.orgId, requester: mixed.m.mixed.uid, role: "Requester", current: ["Requester", "Manager"], expect: true },
      { key: "stored exempt list", org: s2.orgId, requester: s2.m.planner.uid, role: "Maintenance", current: ["Maintenance"], expect: false, seed: true },
    ];
    const ids = cases.map(() => randomUUID());
    cases.forEach((c, i) => {
      admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, requester_role) VALUES ('${ids[i]}', '${c.org}', 'KE-P6-b${i}', 'T', 'New Drawing', 'PENDING_REVIEW', '${c.requester}', ${c.role ? `'${c.role}'` : "NULL"})`);
    });
    const { probes, inventory } = paste(F250);
    expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(inventory.some((l) => l.includes("legacy gate is CERTAIN"))).toBe(true);
    cases.forEach((c, i) => {
      const got = admin(db, `SELECT engineering_required::text FROM tickets WHERE id = '${ids[i]}'`) === "true";
      expect(got, c.key).toBe(c.expect);
      // parity with the app's legacy gate (the shipped default policy): a row
      // set true is one the legacy gate requires an engineer for; a row left
      // false is either exempt under it or decided by a stored policy (seed).
      const legacy = engineerApprovalRequired(c.role, c.current, null, c.requester, { requestType: "New Drawing" });
      if (got) expect(legacy, c.key).toBe(true);
      else if (!c.seed) expect(legacy, c.key).toBe(false);
      // DF-P6 fix pass 2 (review, issue 1): every pre-paste row — the ones
      // the backfill set true included — was filed before the review model.
      expect(admin(db, `SELECT review_model_filed::text FROM tickets WHERE id = '${ids[i]}'`), c.key).toBe("false");
    });
    // …and a row filed after the paste was filed under it
    const after = randomUUID();
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, requester_role) VALUES ('${after}', '${orgId}', 'KE-P6-after', 'T', 'New Drawing', 'PENDING_REVIEW', '${m.manager.uid}', 'Manager')`);
    expect(admin(db, `SELECT review_model_filed::text || '|' || engineering_required::text FROM tickets WHERE id = '${after}'`)).toBe("true|true");
    // a re-paste changes nothing more
    paste(F250);
    cases.forEach((c, i) => expect(admin(db, `SELECT engineering_required::text FROM tickets WHERE id = '${ids[i]}'`) === "true", c.key).toBe(c.expect));
  });

  // ── 20261251 ────────────────────────────────────────────────────────────────
  it("ticket_equipment: the workflow writes it; a member reads a row exactly when they can read its ticket; no client writes", () => {
    const id = randomUUID();
    ticket(id, m.planner.uid, { requester_role: `'Maintenance'` });
    const asset = randomUUID();
    admin(db, `INSERT INTO assets (id, org_id, tag, tag_normalized, created_by) VALUES ('${asset}', '${orgId}', 'P-101', 'p101', '${m.admin.uid}')`);
    expect(asCaller(db, SERVICE, `INSERT INTO ticket_equipment (org_id, ticket_id, asset_id, tag, created_by) VALUES ('${orgId}', '${id}', '${asset}', 'P-101', '${m.planner.uid}'), ('${orgId}', '${id}', NULL, 'XV-9', '${m.planner.uid}')`)).toEqual({ ok: true, rows: 2 });
    expect(selectAs(db, m.planner.caller, `SELECT tag FROM ticket_equipment WHERE ticket_id = '${id}' ORDER BY tag`)).toEqual(["P-101", "XV-9"]);
    expect(selectAs(db, m.contractor.caller, `SELECT tag FROM ticket_equipment WHERE ticket_id = '${id}'`)).toEqual([]);
    for (const stmt of [
      `INSERT INTO ticket_equipment (org_id, ticket_id, tag) VALUES ('${orgId}', '${id}', 'FORGED')`,
      `UPDATE ticket_equipment SET tag = 'X' WHERE ticket_id = '${id}'`,
      `DELETE FROM ticket_equipment WHERE ticket_id = '${id}'`,
    ]) {
      const r = asCaller(db, m.planner.caller, stmt);
      expect(r.ok === false || r.rows === 0, stmt).toBe(true);
    }
    expect(admin(db, `SELECT count(*) FROM ticket_equipment WHERE ticket_id = '${id}'`)).toBe("2");
  });

  it("ticket_equipment integrity: the org is the ticket's, the asset is that org's, a tag is never rewritten; deleting the asset keeps the typed tag, unresolved", () => {
    const id = randomUUID();
    ticket(id, m.planner.uid, { requester_role: `'Maintenance'` });
    const other = seedOrg(db, { a: { role: "Admin" } });
    const foreign = randomUUID();
    admin(db, `INSERT INTO assets (id, org_id, tag, tag_normalized, created_by) VALUES ('${foreign}', '${other.orgId}', 'E-22', 'e22', '${other.m.a.uid}')`);
    const cross = asCaller(db, SERVICE, `INSERT INTO ticket_equipment (org_id, ticket_id, asset_id, tag) VALUES ('${orgId}', '${id}', '${foreign}', 'E-22')`);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.message).toMatch(/asset is not in this workspace/);
    const wrongOrg = asCaller(db, SERVICE, `INSERT INTO ticket_equipment (org_id, ticket_id, tag) VALUES ('${other.orgId}', '${id}', 'E-22')`);
    expect(wrongOrg.ok).toBe(false);
    const mine = randomUUID();
    admin(db, `INSERT INTO assets (id, org_id, tag, tag_normalized, created_by) VALUES ('${mine}', '${orgId}', 'FV-2201', 'fv2201', '${m.admin.uid}')`);
    expect(asCaller(db, SERVICE, `INSERT INTO ticket_equipment (org_id, ticket_id, asset_id, tag) VALUES ('${orgId}', '${id}', '${mine}', 'FV-2201')`).ok).toBe(true);
    const rewrite = asCaller(db, SERVICE, `UPDATE ticket_equipment SET tag = 'FV-9999' WHERE ticket_id = '${id}'`);
    expect(rewrite.ok).toBe(false);
    admin(db, `DELETE FROM assets WHERE id = '${mine}'`);
    expect(admin(db, `SELECT tag || '|' || COALESCE(asset_id::text, 'none') FROM ticket_equipment WHERE ticket_id = '${id}'`)).toBe("FV-2201|none");
    // the ticket's deletion takes its rows (the shed's delete)
    admin(db, `DELETE FROM tickets WHERE id = '${id}'`);
    expect(admin(db, `SELECT count(*) FROM ticket_equipment WHERE ticket_id = '${id}'`)).toBe("0");
  });
});
