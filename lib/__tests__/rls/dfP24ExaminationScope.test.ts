// drafting-flow Round G, DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE —
// 20261266 asserted at RUNTIME on the replayed PostgreSQL 16 (each statement
// as PostgREST sends it: role `authenticated` with the member's claims, or
// `service_role`):
//   * the file re-pastes cleanly (DEC-30 one paste); 6 probes true; the
//     inventory rows carry counts;
//   * ticket_examination_scopes: the service role writes a row; a member who
//     reads the request reads it; another workspace does not; no client
//     inserts, updates or deletes; one row per request; a row in another
//     workspace than its request's is refused (the guard), as is moving it to
//     another request; the values and waiver are JSON objects (CHECK);
//   * removed with its request and with its workspace (cascade);
//   * (second fix pass) a requirement's `since` in org_configurations
//     'drafting' is the database's time, never the writer's: a member's
//     backdated `since` is replaced on INSERT, UPDATE and PostgREST's upsert;
//     an unchanged requirement keeps its stored time whatever is sent; a new
//     or re-targeted one, or one whose field had nothing to pick from in the
//     stored row, is stamped afresh; another key is never touched; the
//     requirements stored before a first paste are re-stamped with the
//     paste's time.

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
      expect(probes.length).toBe(6);
      expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
      expect(inventory.length).toBe(4);
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

  // ── a requirement's `since` is the database's (second fix pass) ──────────
  const OLD_SINCE = "2026-01-01T00:00:00Z";
  const BACKDATED = "2020-01-01T00:00:00Z";
  const FIELDS = (examOptions: Array<Record<string, string>>) => [
    { key: "gov", label: "Governing code", options: [{ value: "c1", label: "Code one" }] },
    { key: "exam", label: "Examination scope", options: examOptions },
  ];
  const cfgJson = (requirements: Array<Record<string, string>>, examOptions: Array<Record<string, string>> = [{ value: "rt5", label: "5% RT" }]) =>
    JSON.stringify({ requestTypes: { options: [] }, examinationScope: { fields: FIELDS(examOptions), requirements } }).replace(/'/g, "''");
  const sinces = (org: string): string[] =>
    admin(db, `SELECT string_agg(COALESCE(r->>'field', '?') || '/' || COALESCE(r->>'workClass', '') || '=' || COALESCE(r->>'since', 'NONE'), ',' ORDER BY ord)
                 FROM org_configurations c, jsonb_array_elements(c.data->'examinationScope'->'requirements') WITH ORDINALITY AS e(r, ord)
                WHERE c.org_id = '${org}' AND c.key = 'drafting'`).split(",");
  const sinceOf = (org: string, field: string, wc = "code") => (sinces(org).find((x) => x.startsWith(`${field}/${wc}=`)) ?? "").split("=")[1];
  const serverStamp = (v: string) => {
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const at = Date.parse(v);
    const dbNow = Date.parse(admin(db, `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`));
    // the database's clock plus one minute (rounded down to the second first)
    expect(at - dbNow).toBeGreaterThanOrEqual(55_000);
    expect(at - dbNow).toBeLessThanOrEqual(61_000);
  };
  /** Store the row with the stamp trigger off (a superuser seeding the "stored" state). */
  const storeRaw = (org: string, json: string) =>
    admin(db, `SET session_replication_role = replica;
               INSERT INTO org_configurations (org_id, key, data) VALUES ('${org}', 'drafting', '${json}'::jsonb)
               ON CONFLICT (org_id, key) DO UPDATE SET data = EXCLUDED.data;
               SET session_replication_role = origin;`);

  it("a member's backdated since is never stored: INSERT, UPDATE and PostgREST's upsert all get the database's time", () => {
    const s1 = seedOrg(db, { admin: { role: "Admin" } });
    const ins = asCaller(db, s1.m.admin.caller, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${s1.orgId}', 'drafting', '${cfgJson([{ field: "gov", workClass: "code", since: BACKDATED }])}'::jsonb)`);
    expect(ins).toEqual({ ok: true, rows: 1 });
    serverStamp(sinceOf(s1.orgId, "gov"));
    // an unchanged requirement keeps its stored time whatever the writer sends
    storeRaw(s1.orgId, cfgJson([{ field: "gov", workClass: "code", since: OLD_SINCE }]));
    const upd = asCaller(db, s1.m.admin.caller, `UPDATE org_configurations SET data = '${cfgJson([{ field: "gov", workClass: "code", since: BACKDATED }])}'::jsonb WHERE org_id = '${s1.orgId}' AND key = 'drafting'`);
    expect(upd).toEqual({ ok: true, rows: 1 });
    expect(sinceOf(s1.orgId, "gov")).toBe(OLD_SINCE);
    const noSince = asCaller(db, s1.m.admin.caller, `UPDATE org_configurations SET data = '${cfgJson([{ field: "gov", workClass: "code" }])}'::jsonb WHERE org_id = '${s1.orgId}' AND key = 'drafting'`);
    expect(noSince).toEqual({ ok: true, rows: 1 });
    expect(sinceOf(s1.orgId, "gov")).toBe(OLD_SINCE);
    // PostgREST's upsert (INSERT … ON CONFLICT DO UPDATE): the stored time again
    const ups = asCaller(db, s1.m.admin.caller, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${s1.orgId}', 'drafting', '${cfgJson([{ field: "gov", workClass: "code", since: BACKDATED }, { field: "gov", workClass: "other", since: BACKDATED }])}'::jsonb)
      ON CONFLICT (org_id, key) DO UPDATE SET data = EXCLUDED.data`);
    expect(ups).toEqual({ ok: true, rows: 1 });
    expect(sinceOf(s1.orgId, "gov")).toBe(OLD_SINCE);
    serverStamp(sinceOf(s1.orgId, "gov", "other"));
  });

  it("re-targeted, removed-and-re-added, or a field with nothing to pick from in the stored row: stamped afresh; nothing added, dropped or reordered", () => {
    const s1 = seedOrg(db, { admin: { role: "Admin" } });
    // stored: gov/code (fillable) and exam/code — exam had NO options there
    storeRaw(s1.orgId, cfgJson([{ field: "gov", workClass: "code", since: OLD_SINCE }, { field: "exam", workClass: "code", since: OLD_SINCE }], []));
    const w = asCaller(db, s1.m.admin.caller, `UPDATE org_configurations SET data = '${cfgJson([{ field: "gov", workClass: "code", since: OLD_SINCE }, { field: "exam", workClass: "code", since: OLD_SINCE }])}'::jsonb WHERE org_id = '${s1.orgId}' AND key = 'drafting'`);
    expect(w).toEqual({ ok: true, rows: 1 });
    expect(sinceOf(s1.orgId, "gov")).toBe(OLD_SINCE);
    serverStamp(sinceOf(s1.orgId, "exam"));
    expect(sinces(s1.orgId).map((x) => x.split("=")[0])).toEqual(["gov/code", "exam/code"]);
    // re-targeted to another class: a new requirement
    storeRaw(s1.orgId, cfgJson([{ field: "gov", workClass: "code", since: OLD_SINCE }]));
    asCaller(db, s1.m.admin.caller, `UPDATE org_configurations SET data = '${cfgJson([{ field: "gov", workClass: "code2", since: OLD_SINCE }])}'::jsonb WHERE org_id = '${s1.orgId}' AND key = 'drafting'`);
    serverStamp(sinceOf(s1.orgId, "gov", "code2"));
    // the field removed from the stored row: re-adding it re-stamps
    storeRaw(s1.orgId, JSON.stringify({ examinationScope: { fields: [], requirements: [{ field: "gov", workClass: "code", since: OLD_SINCE }] } }));
    asCaller(db, s1.m.admin.caller, `UPDATE org_configurations SET data = '${cfgJson([{ field: "gov", workClass: "code", since: OLD_SINCE }])}'::jsonb WHERE org_id = '${s1.orgId}' AND key = 'drafting'`);
    serverStamp(sinceOf(s1.orgId, "gov"));
    // a restore that deletes then inserts the row: everything stamped afresh
    storeRaw(s1.orgId, cfgJson([{ field: "gov", workClass: "code", since: OLD_SINCE }]));
    admin(db, `DELETE FROM org_configurations WHERE org_id = '${s1.orgId}' AND key = 'drafting';
               INSERT INTO org_configurations (org_id, key, data) VALUES ('${s1.orgId}', 'drafting', '${cfgJson([{ field: "gov", workClass: "code", since: BACKDATED }])}'::jsonb);`);
    serverStamp(sinceOf(s1.orgId, "gov"));
  });

  it("another key is never touched; a drafting row without requirements is stored exactly as written", () => {
    const s1 = seedOrg(db, { admin: { role: "Admin" } });
    const json = cfgJson([{ field: "gov", workClass: "code", since: BACKDATED }]);
    admin(db, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${s1.orgId}', 'timezone', '${json}'::jsonb)`);
    expect(admin(db, `SELECT data->'examinationScope'->'requirements'->0->>'since' FROM org_configurations WHERE org_id = '${s1.orgId}' AND key = 'timezone'`)).toBe(BACKDATED);
    const plain = JSON.stringify({ requestTypes: { options: [{ value: "a", label: "A" }] } });
    expect(asCaller(db, s1.m.admin.caller, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${s1.orgId}', 'drafting', '${plain}'::jsonb)`)).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT data = '${plain}'::jsonb FROM org_configurations WHERE org_id = '${s1.orgId}' AND key = 'drafting'`)).toBe("t");
  });

  it("a first paste re-stamps the requirements stored before it (saved when nothing could be refused) with the paste's time", () => {
    const s1 = seedOrg(db, { admin: { role: "Admin" } });
    admin(db, `DROP TRIGGER IF EXISTS trg_org_config_examination_scope_stamp ON org_configurations;
               INSERT INTO org_configurations (org_id, key, data) VALUES ('${s1.orgId}', 'drafting', '${cfgJson([{ field: "gov", workClass: "code", since: BACKDATED }])}'::jsonb);`);
    expect(sinceOf(s1.orgId, "gov")).toBe(BACKDATED);
    const { probes } = paste(F266);
    expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    serverStamp(sinceOf(s1.orgId, "gov"));
    // a re-paste keeps each stored time (the trigger exists by then)
    storeRaw(s1.orgId, cfgJson([{ field: "gov", workClass: "code", since: OLD_SINCE }]));
    paste(F266);
    expect(sinceOf(s1.orgId, "gov")).toBe(OLD_SINCE);
  });
});
