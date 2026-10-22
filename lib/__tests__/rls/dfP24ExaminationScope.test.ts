// drafting-flow Round G, DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE —
// 20261266 asserted at RUNTIME on the replayed PostgreSQL 16 (each statement
// as PostgREST sends it: role `authenticated` with the member's claims, or
// `service_role`):
//   * the file re-pastes cleanly (DEC-30 one paste); 4 probes true; the
//     inventory rows carry counts;
//   * ticket_examination_scopes: the service role writes a row; a member who
//     reads the request reads it; another workspace does not; no client
//     inserts, updates or deletes; one row per request; a row in another
//     workspace than its request's is refused (the guard), as is moving it to
//     another request; the values and waiver are JSON objects (CHECK);
//   * removed with its request and with its workspace (cascade).

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const F266 = "20261266_df_roundG_examination_scope.sql";

function paste(f: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
  expect(r.ok, `${f}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("DF-P24 — ticket_examination_scopes (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const count = (sql: string) => Number(admin(db, sql));
  const ticket = (org = orgId, requester = m.requester.uid) => {
    const id = randomUUID();
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, history)
               VALUES ('${id}', '${org}', 'KE-P24-${id.slice(0, 6)}', 'Spool', 'Revision', 'PENDING_REVIEW', '${requester}', '[]'::jsonb)`);
    return id;
  };
  const row = (t: string, org = orgId) =>
    `INSERT INTO ticket_examination_scopes (ticket_id, org_id, field_values, updated_by)
     VALUES ('${t}', '${org}', '{"exam":{"value":"rt5","by":"${m.drafter.uid}","at":"2026-10-22T00:00:00Z"}}'::jsonb, '${m.drafter.uid}')`;

  beforeAll(() => {
    const s = seedOrg(db, { requester: { role: "Requester" }, drafter: { role: "Drafter" }, admin: { role: "Admin" }, viewer: { role: "Viewer" } });
    orgId = s.orgId;
    m = s.m;
  });

  it("pastes cleanly twice (DEC-30 one paste, re-runnable); every probe answers true; the inventory rows carry counts", () => {
    for (let i = 0; i < 2; i++) {
      const { probes, inventory } = paste(F266);
      expect(probes.length).toBe(4);
      expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
      expect(inventory.length).toBe(3);
    }
  });

  it("the service role writes; a member who reads the request reads it; another workspace does not; no client writes", () => {
    const t = ticket();
    expect(asCaller(db, SERVICE, row(t))).toEqual({ ok: true, rows: 1 });
    expect(selectAs(db, m.viewer.caller, `SELECT field_values->'exam'->>'value' FROM ticket_examination_scopes WHERE ticket_id = '${t}';`)).toContain("rt5");
    const elsewhere = seedOrg(db, { outsider: { role: "Admin" } });
    expect(selectAs(db, elsewhere.m.outsider.caller, `SELECT COUNT(*) FROM ticket_examination_scopes WHERE ticket_id = '${t}';`)).toContain("0");
    for (const who of [m.drafter.caller, m.admin.caller]) {
      expect(asCaller(db, who, row(ticket())).ok).toBe(false);
      const upd = asCaller(db, who, `UPDATE ticket_examination_scopes SET field_values = '{}'::jsonb WHERE ticket_id = '${t}'`);
      expect(upd.ok === false || (upd.ok && upd.rows === 0)).toBe(true);
      const del = asCaller(db, who, `DELETE FROM ticket_examination_scopes WHERE ticket_id = '${t}'`);
      expect(del.ok === false || (del.ok && del.rows === 0)).toBe(true);
    }
    expect(count(`SELECT COUNT(*) FROM ticket_examination_scopes WHERE ticket_id = '${t}' AND field_values ? 'exam'`)).toBe(1);
    // a waiver is recorded by the service role (the fill route, after its checks)
    expect(asCaller(db, SERVICE, `UPDATE ticket_examination_scopes SET waiver = '{"reason":"vendor data","fields":["gov"],"rev":"1A"}'::jsonb, updated_at = now() WHERE ticket_id = '${t}'`)).toEqual({ ok: true, rows: 1 });
  });

  it("one row per request; the guard keeps it in its request's workspace and on its request; values and waiver are objects", () => {
    const t = ticket();
    expect(asCaller(db, SERVICE, row(t))).toEqual({ ok: true, rows: 1 });
    const dup = asCaller(db, SERVICE, row(t));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("23505");
    const other = seedOrg(db, { r: { role: "Admin" } });
    const wrongOrg = asCaller(db, SERVICE, row(ticket(), other.orgId));
    expect(wrongOrg.ok).toBe(false);
    if (!wrongOrg.ok) expect(wrongOrg.message).toMatch(/belongs to its request's workspace/);
    const move = asCaller(db, SERVICE, `UPDATE ticket_examination_scopes SET ticket_id = '${ticket()}' WHERE ticket_id = '${t}'`);
    expect(move.ok).toBe(false);
    if (!move.ok) expect(move.message).toMatch(/stays with its request/);
    expect(asCaller(db, SERVICE, `UPDATE ticket_examination_scopes SET field_values = '[]'::jsonb WHERE ticket_id = '${t}'`).ok).toBe(false);
    expect(asCaller(db, SERVICE, `UPDATE ticket_examination_scopes SET waiver = '"x"'::jsonb WHERE ticket_id = '${t}'`).ok).toBe(false);
  });

  it("removed with its request, and with its workspace", () => {
    const t = ticket();
    expect(asCaller(db, SERVICE, row(t))).toEqual({ ok: true, rows: 1 });
    admin(db, `DELETE FROM tickets WHERE id = '${t}'`);
    expect(count(`SELECT COUNT(*) FROM ticket_examination_scopes WHERE ticket_id = '${t}'`)).toBe(0);
    const s2 = seedOrg(db, { r: { role: "Admin" } });
    const t2 = ticket(s2.orgId, s2.m.r.uid);
    expect(asCaller(db, SERVICE, row(t2, s2.orgId))).toEqual({ ok: true, rows: 1 });
    const del = admin(db, `SELECT harness.try_sql(${"$q$"}DELETE FROM orgs WHERE id = '${s2.orgId}'${"$q$"})`);
    expect(del).toBe("ok:1");
    expect(count(`SELECT COUNT(*) FROM ticket_examination_scopes WHERE ticket_id = '${t2}'`)).toBe(0);
  });
});
