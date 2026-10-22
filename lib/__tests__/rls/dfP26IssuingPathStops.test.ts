// drafting-flow Round G, DF-P26 ISSUING-PATH STOPS — 20261268 asserted at
// RUNTIME on the replayed PostgreSQL 16 (each statement as PostgREST sends
// it: role `authenticated` with the member's claims, or `service_role`).
//
//   * The file re-pastes cleanly (DEC-30 one paste) — twice; every probe is
//     true and the inventory rows carry counts. The cluster is shared with
//     suites that re-paste 20261242 / 20261255 / 20261264, so beforeAll
//     re-pastes 20261255 and 20261264 first, as the paste hand-off says an
//     operator must; and the hand-off itself is pinned: re-pasting 20261264
//     after this file drops the rule's value (a rule satisfaction is then
//     refused, and exception_only_review_ready() — which reads the live
//     CHECKs — answers false, so the app applies no rule), and pasting this
//     file again restores both.
//   * ticket_review_slots: a BLOCKING slot satisfied 'rule' (the
//     exception-only rule, GAP-115) names no signer and no signature; a rule
//     satisfaction naming a signer or a signature, or on a slot that is not
//     blocking, is refused; a signer's satisfaction still names its signer
//     and signature; 'consent' keeps its own shape; an unknown via is still
//     refused; a slot re-opened clears back to open.
//   * ticket_review_slot_events: 'reopened' is recorded; an unknown event is
//     still refused; the events stay append-only (an UPDATE and a DELETE are
//     refused for the service role too).
//   * exception_only_review_ready(): answers true for the service role; a
//     signed-in member and anon cannot execute it.

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const F255 = "20261255_df_roundG_consent_window.sql";
const F264 = "20261264_df_roundG_consent_escalation.sql";
const F268 = "20261268_df_roundG_issuing_path_stops.sql";

function paste(f: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
  expect(r.ok, `${f}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("DF-P26 — the exception-only rule's satisfaction, the 'reopened' event and the readiness probe (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const ticket = () => {
    const id = randomUUID();
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, history)
               VALUES ('${id}', '${orgId}', 'KE-P26-${id.slice(0, 6)}', 'Gasket', 'Revision', 'PENDING_REVIEW', '${m.requester.uid}', '[]'::jsonb)`);
    return id;
  };
  const slots = (t: string, roster: string, kinds: Array<[string, string]>) =>
    admin(db, `INSERT INTO ticket_review_slots (org_id, ticket_id, roster_id, slot_kind, mode, primaries, status, content_hash) VALUES ${kinds
      .map(([k, mode]) => `('${orgId}', '${t}', '${roster}', '${k}', '${mode}', ARRAY['${m.qa.uid}']::uuid[], 'open', 'h')`).join(", ")}`);
  const set = (roster: string, kind: string, sql: string) => asCaller(db, SERVICE, `UPDATE ticket_review_slots SET ${sql} WHERE roster_id = '${roster}' AND slot_kind = '${kind}'`);

  beforeAll(() => {
    const s = seedOrg(db, { requester: { role: "Manager" }, qa: { role: "Viewer" }, admin: { role: "Admin" } });
    orgId = s.orgId;
    m = s.m;
    // the chain this file re-creates its CHECKs from, newest last (another
    // suite on this shared cluster may have re-pasted an older one)
    paste(F255);
    paste(F264);
  });

  it("re-pastes cleanly, twice (DEC-30 one paste); every probe answers true; the inventory rows carry counts", () => {
    for (let i = 0; i < 2; i++) {
      const { probes, inventory } = paste(F268);
      expect(probes.length, `paste ${i + 1}`).toBe(4);
      expect(probes.filter((l) => l.endsWith("|f|")), `paste ${i + 1}`).toEqual([]);
      expect(inventory.length, `paste ${i + 1}`).toBe(4);
    }
  });

  it("ticket_review_slots: a blocking slot satisfied by the rule names no signer and no signature; any other rule shape is refused; signer and consent shapes unchanged", () => {
    const t = ticket();
    const roster = randomUUID();
    slots(t, roster, [["doc", "blocking"], ["doc2", "blocking"], ["doc3", "blocking"], ["win", "consent_window"], ["note", "notify_only"], ["lead", "blocking"], ["lead2", "blocking"], ["odd", "blocking"]]);
    expect(set(roster, "doc", "status = 'satisfied', satisfied_at = now(), satisfied_via = 'rule'")).toEqual({ ok: true, rows: 1 });
    // a rule satisfaction never names a signer or a signature
    expect(set(roster, "doc2", `status = 'satisfied', satisfied_at = now(), satisfied_via = 'rule', satisfied_by = '${m.qa.uid}', signature_id = '${randomUUID()}'`).ok).toBe(false);
    expect(set(roster, "doc3", `status = 'satisfied', satisfied_at = now(), satisfied_via = 'rule', satisfied_by = '${m.qa.uid}'`).ok).toBe(false);
    // only a blocking slot
    expect(set(roster, "win", "status = 'satisfied', satisfied_at = now(), satisfied_via = 'rule'").ok).toBe(false);
    expect(set(roster, "note", "status = 'satisfied', satisfied_at = now(), satisfied_via = 'rule'").ok).toBe(false);
    // a consent window still closes by consent, naming nobody
    expect(set(roster, "win", "status = 'satisfied', satisfied_at = now(), satisfied_via = 'consent'")).toEqual({ ok: true, rows: 1 });
    // a signer's satisfaction still names its signer and its signature
    expect(set(roster, "lead", `status = 'satisfied', satisfied_at = now(), satisfied_via = 'primary', satisfied_by = '${m.qa.uid}', signature_id = '${randomUUID()}'`)).toEqual({ ok: true, rows: 1 });
    expect(set(roster, "lead2", "status = 'satisfied', satisfied_at = now(), satisfied_via = 'primary'").ok).toBe(false);
    // an unknown via still refused
    expect(set(roster, "odd", `status = 'satisfied', satisfied_at = now(), satisfied_via = 'magic', satisfied_by = '${m.qa.uid}', signature_id = '${randomUUID()}'`).ok).toBe(false);
    // the rule's slot re-opened for its reviewer
    expect(set(roster, "doc", "status = 'open', satisfied_at = NULL, satisfied_via = NULL, satisfied_by = NULL, signature_id = NULL")).toEqual({ ok: true, rows: 1 });
  });

  it("the paste hand-off: 20261264 re-pasted after this file drops the rule's value (a rule satisfaction refused — fail-safe); this file pasted again restores it", () => {
    const t = ticket();
    const roster = randomUUID();
    slots(t, roster, [["doc", "blocking"]]);
    expect(admin(db, "SELECT exception_only_review_ready()")).toBe("t");
    paste(F264);
    // DF-P26 review fix: the readiness probe reads the live CHECKs — after the regressed paste it answers
    // false, so the app satisfies no slot by the rule the ledger would now refuse
    expect(admin(db, "SELECT exception_only_review_ready()")).toBe("f");
    expect(asCaller(db, SERVICE, "SELECT exception_only_review_ready()")).toMatchObject({ ok: true });
    const refused = set(roster, "doc", "status = 'satisfied', satisfied_at = now(), satisfied_via = 'rule'");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("23514");
    paste(F268);
    expect(admin(db, "SELECT exception_only_review_ready()")).toBe("t");
    expect(set(roster, "doc", "status = 'satisfied', satisfied_at = now(), satisfied_via = 'rule'")).toEqual({ ok: true, rows: 1 });
    // with a rule satisfaction on record, re-pasting 20261264 is refused
    // as a whole (its CHECK cannot be re-added over the row) — nothing changed
    const { conn } = mosDb();
    const again = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", F264), stopOnError: true });
    expect(again.ok).toBe(false);
    expect(admin(db, "SELECT pg_get_constraintdef(oid) LIKE '%''rule''%' FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_via_check'")).toBe("t");
    // leave the shared cluster as found: no rule satisfaction on record
    expect(set(roster, "doc", "status = 'open', satisfied_at = NULL, satisfied_via = NULL")).toEqual({ ok: true, rows: 1 });
  });

  it("ticket_review_slot_events: 'reopened' is recorded; an unknown event refused; the events stay append-only", () => {
    const t = ticket();
    const roster = randomUUID();
    const ev = (event: string) => `INSERT INTO ticket_review_slot_events (org_id, ticket_id, roster_id, slot_kind, event, actor_name, details)
      VALUES ('${orgId}', '${t}', '${roster}', 'doc', '${event}', 'System — exception-only review', '{"via":"rule","exceptions":["a waiver of required examination data is recorded"]}'::jsonb)`;
    expect(asCaller(db, SERVICE, ev("reopened"))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, ev("satisfied"))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, ev("reverted")).ok).toBe(false);
    expect(asCaller(db, SERVICE, `UPDATE ticket_review_slot_events SET event = 'opened' WHERE roster_id = '${roster}'`).ok).toBe(false);
    const del = asCaller(db, SERVICE, `DELETE FROM ticket_review_slot_events WHERE roster_id = '${roster}'`);
    expect(del.ok).toBe(false);
    expect(Number(admin(db, `SELECT COUNT(*) FROM ticket_review_slot_events WHERE roster_id = '${roster}'`))).toBe(2);
  });

  it("exception_only_review_ready(): true for the service role; a member and anon cannot execute it", () => {
    expect(asCaller(db, SERVICE, "SELECT exception_only_review_ready()")).toMatchObject({ ok: true });
    expect(admin(db, "SELECT exception_only_review_ready()")).toBe("t");
    for (const caller of [m.admin.caller, m.qa.caller, { role: "anon" as const }]) {
      const r = asCaller(db, caller, "SELECT exception_only_review_ready()");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("42501");
    }
  });
});
