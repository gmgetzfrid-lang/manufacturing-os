// drafting-flow Round G, DF-P22 CONSENT AND ESCALATION — 20261264 asserted at
// RUNTIME on the replayed PostgreSQL 16 (each statement as PostgREST sends
// it: role `authenticated` with the member's claims, or `service_role`).
//
//   * The file re-pastes cleanly (DEC-30 one paste); every probe is true and
//     the inventory rows carry counts.
//   * ticket_sla_escalations: the (ticket, breach, period) key is the claim
//     (a second insert is a 23505); an UPDATE is refused for every role; a
//     client neither inserts nor deletes; a member reads a row of a ticket
//     they read; the service role releases a claim (DELETE).
//   * ticket_preauthorizations: scoped (CHECK), an expiry required and at
//     most 365 days (CHECK); only ever revoked, once (the guard); never
//     deleted while the workspace exists; no client write; members read.
//   * ticket_review_slots: a slot satisfied 'preauthorization' names its
//     signer and its signature; 'preauthorization' with no signature is
//     still refused; an unknown via is still refused.
//   * DF-P22 fix pass: no client writes org_configurations key
//     'sla_escalation' (an Admin and a DraftingSupervisor are both refused;
//     the DraftingSupervisor still saves the 'drafting' key; the service role
//     writes it); a workspace holding a standing pre-authorization (and an
//     escalation record) can still be deleted — the orgs cascade removes them.

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const F264 = "20261264_df_roundG_consent_escalation.sql";

function paste(f: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
  expect(r.ok, `${f}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("DF-P22 — the escalation record, standing pre-authorizations and the ledger's new value (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const count = (sql: string) => Number(admin(db, sql));
  const ticket = () => {
    const id = randomUUID();
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, history)
               VALUES ('${id}', '${orgId}', 'KE-P22-${id.slice(0, 6)}', 'Gasket', 'Revision', 'DRAFTING', '${m.requester.uid}', '[]'::jsonb)`);
    return id;
  };
  const escalation = (t: string, period: number) =>
    `INSERT INTO ticket_sla_escalations (org_id, ticket_id, breached_at, period_index, period_days, contact, recipients)
     VALUES ('${orgId}', '${t}', '2026-10-01T03:00:00Z', ${period}, 2, '{"kind":"role","role":"Admin"}'::jsonb, ARRAY['${m.admin.uid}']::uuid[])`;
  const preauth = (id: string, over: { scope?: string; expires?: string } = {}) =>
    `INSERT INTO ticket_preauthorizations (id, org_id, grantor_id, grantor_name, request_type, statement, signature_id, expires_at${over.scope ? "" : ""})
     VALUES ('${id}', '${orgId}', '${m.qa.uid}', 'QA', ${over.scope === "none" ? "NULL" : "'Revision'"}, 'I give my standing pre-authorization', '${randomUUID()}', ${over.expires ?? "now() + interval '30 days'"})`;

  beforeAll(() => {
    const s = seedOrg(db, { requester: { role: "Manager" }, qa: { role: "Viewer" }, admin: { role: "Admin" }, other: { role: "Viewer" }, sup: { role: "DraftingSupervisor" } });
    orgId = s.orgId;
    m = s.m;
  });

  it("re-pastes cleanly (DEC-30 one paste); every probe answers true; the inventory rows carry counts", () => {
    const { probes, inventory } = paste(F264);
    expect(probes.length).toBe(8);
    expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(inventory.length).toBe(6);
  });

  it("ticket_sla_escalations: the claim is unique per breach per period; never rewritten; the service role releases a claim; no client write", () => {
    const t = ticket();
    expect(asCaller(db, SERVICE, escalation(t, 1))).toEqual({ ok: true, rows: 1 });
    const again = asCaller(db, SERVICE, escalation(t, 1));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("23505");
    expect(asCaller(db, SERVICE, escalation(t, 2))).toEqual({ ok: true, rows: 1 });
    const upd = asCaller(db, SERVICE, `UPDATE ticket_sla_escalations SET period_days = 3 WHERE ticket_id = '${t}'`);
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.message).toMatch(/never rewritten/);
    // a client neither inserts nor deletes
    expect(asCaller(db, m.admin.caller, escalation(t, 3)).ok).toBe(false);
    const del = asCaller(db, m.admin.caller, `DELETE FROM ticket_sla_escalations WHERE ticket_id = '${t}'`);
    expect(del.ok === false || (del.ok && del.rows === 0)).toBe(true);
    expect(count(`SELECT COUNT(*) FROM ticket_sla_escalations WHERE ticket_id = '${t}'`)).toBe(2);
    // a member reads them (the ticket's own read)
    expect(selectAs(db, m.other.caller, `SELECT COUNT(*) FROM ticket_sla_escalations WHERE ticket_id = '${t}';`)).toContain("2");
    // the service role releases a claim
    expect(asCaller(db, SERVICE, `DELETE FROM ticket_sla_escalations WHERE ticket_id = '${t}' AND period_index = 2`)).toEqual({ ok: true, rows: 1 });
  });

  it("ticket_preauthorizations: scoped, an expiry required and at most 365 days; only ever revoked, once; never deleted; no client write; members read", () => {
    const id = randomUUID();
    expect(asCaller(db, SERVICE, preauth(id))).toEqual({ ok: true, rows: 1 });
    // no scope at all — refused
    const unscoped = asCaller(db, SERVICE, preauth(randomUUID(), { scope: "none" }));
    expect(unscoped.ok).toBe(false);
    // no expiry — refused (NOT NULL); past 365 days — refused (CHECK)
    expect(asCaller(db, SERVICE, preauth(randomUUID(), { expires: "NULL" })).ok).toBe(false);
    expect(asCaller(db, SERVICE, preauth(randomUUID(), { expires: "now() + interval '366 days'" })).ok).toBe(false);
    // a client never writes one
    expect(asCaller(db, m.qa.caller, preauth(randomUUID())).ok).toBe(false);
    // its scope never changes
    const widen = asCaller(db, SERVICE, `UPDATE ticket_preauthorizations SET request_type = NULL, library_id = NULL, work_class = 'Any' WHERE id = '${id}'`);
    expect(widen.ok).toBe(false);
    const extend = asCaller(db, SERVICE, `UPDATE ticket_preauthorizations SET expires_at = expires_at + interval '1 day' WHERE id = '${id}'`);
    expect(extend.ok).toBe(false);
    // a revocation without a revoker — refused
    expect(asCaller(db, SERVICE, `UPDATE ticket_preauthorizations SET revoked_at = now() WHERE id = '${id}'`).ok).toBe(false);
    // revoked, once
    expect(asCaller(db, SERVICE, `UPDATE ticket_preauthorizations SET revoked_at = now(), revoked_by = '${m.qa.uid}', revoke_reason = 'moved roles' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    const twice = asCaller(db, SERVICE, `UPDATE ticket_preauthorizations SET revoke_reason = 'changed my mind' WHERE id = '${id}'`);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.message).toMatch(/already revoked/);
    // never deleted while its workspace exists
    const del = asCaller(db, SERVICE, `DELETE FROM ticket_preauthorizations WHERE id = '${id}'`);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.message).toMatch(/never deleted/);
    // members read it; a member of another workspace does not
    expect(selectAs(db, m.other.caller, `SELECT COUNT(*) FROM ticket_preauthorizations WHERE id = '${id}';`)).toContain("1");
    const elsewhere = seedOrg(db, { outsider: { role: "Admin" } });
    expect(selectAs(db, elsewhere.m.outsider.caller, `SELECT COUNT(*) FROM ticket_preauthorizations WHERE id = '${id}';`)).toContain("0");
  });

  it("ticket_review_slots: a slot satisfied 'preauthorization' names its signer and signature; without a signature it is refused; an unknown via still refused", () => {
    const t = ticket();
    const roster = randomUUID();
    admin(db, `INSERT INTO ticket_review_slots (org_id, ticket_id, roster_id, slot_kind, mode, primaries, status, content_hash)
               VALUES ('${orgId}', '${t}', '${roster}', 'qa', 'blocking', ARRAY['${m.qa.uid}']::uuid[], 'open', 'h'),
                      ('${orgId}', '${t}', '${roster}', 'qa2', 'blocking', ARRAY['${m.qa.uid}']::uuid[], 'open', 'h'),
                      ('${orgId}', '${t}', '${roster}', 'qa3', 'blocking', ARRAY['${m.qa.uid}']::uuid[], 'open', 'h')`);
    const ok = asCaller(db, SERVICE, `UPDATE ticket_review_slots SET status = 'satisfied', satisfied_by = '${m.qa.uid}', satisfied_at = now(), satisfied_via = 'preauthorization', signature_id = '${randomUUID()}' WHERE roster_id = '${roster}' AND slot_kind = 'qa'`);
    expect(ok).toEqual({ ok: true, rows: 1 });
    const noSig = asCaller(db, SERVICE, `UPDATE ticket_review_slots SET status = 'satisfied', satisfied_by = '${m.qa.uid}', satisfied_at = now(), satisfied_via = 'preauthorization' WHERE roster_id = '${roster}' AND slot_kind = 'qa2'`);
    expect(noSig.ok).toBe(false);
    const unknown = asCaller(db, SERVICE, `UPDATE ticket_review_slots SET status = 'satisfied', satisfied_by = '${m.qa.uid}', satisfied_at = now(), satisfied_via = 'standing', signature_id = '${randomUUID()}' WHERE roster_id = '${roster}' AND slot_kind = 'qa3'`);
    expect(unknown.ok).toBe(false);
  });

  it("DF-P22 fix pass: no client writes the escalation setting — not an Admin, not a drafting supervisor; the supervisor still saves the request forms; the service role writes it", () => {
    const esc = `'{"contact":{"kind":"role","role":"Admin"},"periodDays":2}'::jsonb`;
    const ins = (who: typeof SERVICE | SeededMember["caller"]) => asCaller(db, who, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${orgId}', 'sla_escalation', ${esc})`);
    expect(ins(m.admin.caller).ok).toBe(false);
    expect(ins(m.sup.caller).ok).toBe(false);
    expect(asCaller(db, m.sup.caller, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${orgId}', 'drafting', '{}'::jsonb)
      ON CONFLICT (org_id, key) DO UPDATE SET data = EXCLUDED.data`)).toEqual({ ok: true, rows: 1 });
    expect(ins(SERVICE)).toEqual({ ok: true, rows: 1 });
    for (const who of [m.admin.caller, m.sup.caller]) {
      const upd = asCaller(db, who, `UPDATE org_configurations SET data = 'null'::jsonb WHERE org_id = '${orgId}' AND key = 'sla_escalation'`);
      expect(upd.ok === false || (upd.ok && upd.rows === 0)).toBe(true);
      const del = asCaller(db, who, `DELETE FROM org_configurations WHERE org_id = '${orgId}' AND key = 'sla_escalation'`);
      expect(del.ok === false || (del.ok && del.rows === 0)).toBe(true);
    }
    expect(count(`SELECT COUNT(*) FROM org_configurations WHERE org_id = '${orgId}' AND key = 'sla_escalation' AND data->>'periodDays' = '2'`)).toBe(1);
  });

  it("DF-P22 fix pass: a workspace holding a standing pre-authorization (and an escalation record) can still be deleted; the cascade removes them", () => {
    const s2 = seedOrg(db, { r: { role: "Admin" } });
    const pid = randomUUID();
    const t2 = randomUUID();
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, history)
               VALUES ('${t2}', '${s2.orgId}', 'KE-P22D-${t2.slice(0, 6)}', 'Gasket', 'Revision', 'DRAFTING', '${s2.m.r.uid}', '[]'::jsonb)`);
    expect(asCaller(db, SERVICE, `INSERT INTO ticket_preauthorizations (id, org_id, grantor_id, grantor_name, request_type, statement, signature_id, expires_at)
      VALUES ('${pid}', '${s2.orgId}', '${s2.m.r.uid}', 'R', 'Revision', 'I give my standing pre-authorization', '${randomUUID()}', now() + interval '30 days')`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, `INSERT INTO ticket_sla_escalations (org_id, ticket_id, breached_at, period_index, period_days, contact, recipients)
      VALUES ('${s2.orgId}', '${t2}', '2026-10-01T03:00:00Z', 1, 2, '{"kind":"role","role":"Admin"}'::jsonb, ARRAY['${s2.m.r.uid}']::uuid[])`)).toEqual({ ok: true, rows: 1 });
    const del = admin(db, `SELECT harness.try_sql(${"$q$"}DELETE FROM orgs WHERE id = '${s2.orgId}'${"$q$"})`);
    expect(del).toBe("ok:1");
    expect(count(`SELECT COUNT(*) FROM ticket_preauthorizations WHERE id = '${pid}'`)).toBe(0);
    expect(count(`SELECT COUNT(*) FROM ticket_sla_escalations WHERE ticket_id = '${t2}'`)).toBe(0);
  });
});
