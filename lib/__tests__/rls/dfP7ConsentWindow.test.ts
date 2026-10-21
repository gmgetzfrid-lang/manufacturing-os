// drafting-flow Round G, DF-P7 CONSENT — 20261255 asserted at RUNTIME on the
// replayed PostgreSQL 16 (each statement as PostgREST sends it: role
// `authenticated` with the member's claims, or `service_role` with none —
// how the workflow route and the maintenance cron write).
//
//   DEC-38: open_consent_window writes the notification rows, their
//           delivered events and the ticket's stamp in ONE transaction — a
//           failed notification insert, an empty set, a person who is not
//           the slot's own occupant or not an active member leaves NOTHING
//           (no rows, no timestamp, no clock). Service role only.
//   DEC-39: the reminder reaches everyone asked, recorded with its rows;
//           ticket_notice_events is append-only, read as the ticket reads (a
//           not_emailed row only by its person).
//   The ten columns are workflow-owned (a client neither writes nor
//   inserts one); the roster ledger takes a slot satisfied 'consent' and
//   still refuses a satisfied slot with no signature otherwise.
//   The file re-pastes cleanly (DEC-30 one paste) with every probe true.

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const F255 = "20261255_df_roundG_consent_window.sql";

function paste(f: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
  expect(r.ok, `${f}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("DF-P7 — the consent window's columns, its two functions and its record (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const rosterId = () => randomUUID();
  // The review as the workflow route leaves it: the metadata mirror AND the
  // service-written roster ledger (ticket_review_slots) — open_consent_window
  // trusts the ledger (DF-P7 fix pass). `ledger: false` is a forged roster.
  const reviewTicket = (roster: string, primaries: string[], opts: { ledger?: boolean; drafter?: string | null; independentOf?: string[] } = {}) => {
    const id = randomUUID();
    const meta = { review_roster: { v: 1, id: roster, openedAt: "2026-10-19T09:00:00Z", slots: [
      { kind: "accept", mode: "blocking", status: "open", primaries: [m.requester.uid] },
      { kind: "ops", mode: "consent_window", status: "open", primaries },
    ] } };
    const drafter = opts.drafter ? `'${opts.drafter}'` : "NULL";
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, assigned_drafter_id, metadata, history)
               VALUES ('${id}', '${orgId}', 'KE-P7-${id.slice(0, 6)}', 'Gasket', 'Revision', 'PENDING_REVIEW', '${m.requester.uid}', ${drafter}, '${JSON.stringify(meta)}'::jsonb, '[]'::jsonb)`);
    if (opts.ledger !== false) {
      const arr = (xs: string[]) => `ARRAY[${xs.map((x) => `'${x}'`).join(",")}]::uuid[]`;
      const txt = (xs: string[]) => `ARRAY[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
      admin(db, `INSERT INTO ticket_review_slots (org_id, ticket_id, roster_id, slot_kind, mode, primaries, independent_of, status, content_hash)
                 VALUES ('${orgId}', '${id}', '${roster}', 'accept', 'blocking', ${arr([m.requester.uid])}, '{}'::text[], 'open', 'h'),
                        ('${orgId}', '${id}', '${roster}', 'ops', 'consent_window', ${primaries.length ? arr(primaries) : "'{}'::uuid[]"}, ${opts.independentOf?.length ? txt(opts.independentOf) : "'{}'::text[]"}, 'open', 'h')`);
    }
    return id;
  };
  const open = (ticket: string, roster: string, recipients: string[], slot = "ops") => asCaller(db, SERVICE,
    `SELECT open_consent_window('${ticket}', '${roster}', '${slot}', ARRAY[${recipients.map((r) => `'${r}'`).join(",")}]::uuid[], now() + interval '2 days', now() + interval '3 days', 'You may object', 'body', '{"action":"Consent window opened — Operations","user":"system:consent-window","role":"System","details":"Asked"}'::jsonb)`);
  const cols = (ticket: string) => admin(db, `SELECT (consent_window_opened_at IS NOT NULL)::text || '|' || COALESCE(array_to_string(consent_window_recipients, ','), '') || '|' || COALESCE(consent_window_slot, '') FROM tickets WHERE id = '${ticket}'`);
  const count = (sql: string) => Number(admin(db, sql));

  beforeAll(() => {
    const s = seedOrg(db, { requester: { role: "Manager" }, ops1: { role: "Viewer" }, ops2: { role: "Viewer" }, admin: { role: "Admin" }, other: { role: "Viewer" } });
    orgId = s.orgId;
    m = s.m;
  });

  it("re-pastes cleanly (DEC-30 one paste); every probe answers true; the inventory rows carry counts", () => {
    const { probes, inventory } = paste(F255);
    expect(probes.length).toBeGreaterThanOrEqual(10);
    expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(inventory.length).toBe(5);
  });

  it("DEC-38: the rows and the stamp land together — notifications, delivered events naming them, the columns, the mirror, the history line", () => {
    const r = rosterId();
    const t = reviewTicket(r, [m.ops1.uid, m.ops2.uid]);
    expect(open(t, r, [m.ops1.uid, m.ops2.uid])).toEqual({ ok: true, rows: 1 });
    expect(cols(t)).toBe(`true|${m.ops1.uid},${m.ops2.uid}|ops`);
    expect(count(`SELECT COUNT(*) FROM notifications WHERE resource_id = '${t}' AND kind = 'ticket_status' AND metadata->>'action' = 'consent_window_opened'`)).toBe(2);
    expect(count(`SELECT COUNT(*) FROM ticket_notice_events e JOIN notifications n ON n.id = e.notification_id AND n.user_id = e.recipient WHERE e.ticket_id = '${t}' AND e.kind = 'delivered' AND e.roster_id = '${r}'`)).toBe(2);
    expect(admin(db, `SELECT metadata->'review_roster'->'consentWindow'->>'slot' || '|' || jsonb_array_length(history)::text || '|' || (history->0->>'action') FROM tickets WHERE id = '${t}'`)).toBe("ops|1|Consent window opened — Operations");
    // opening it again for the same review is refused (23505), nothing added
    const again = open(t, r, [m.ops1.uid, m.ops2.uid]);
    expect(again.ok).toBe(false);
    expect(count(`SELECT COUNT(*) FROM notifications WHERE resource_id = '${t}'`)).toBe(2);
  });

  it("DEC-38 acceptance: a notification insert that FAILS leaves the ticket un-stamped — no rows, no events, no clock", () => {
    const r = rosterId();
    const t = reviewTicket(r, [m.ops1.uid, m.ops2.uid]);
    admin(db, `CREATE OR REPLACE FUNCTION harness_fail_notice() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.user_id = '${m.ops2.uid}' THEN RAISE EXCEPTION 'harness: the bell is down'; END IF; RETURN NEW; END $f$;
               CREATE TRIGGER harness_fail_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION harness_fail_notice();`);
    try {
      const res = open(t, r, [m.ops1.uid, m.ops2.uid]);
      expect(res.ok).toBe(false);
      expect(cols(t)).toBe("false||");
      expect(count(`SELECT COUNT(*) FROM notifications WHERE resource_id = '${t}'`)).toBe(0);
      expect(count(`SELECT COUNT(*) FROM ticket_notice_events WHERE ticket_id = '${t}'`)).toBe(0);
    } finally {
      admin(db, "DROP TRIGGER IF EXISTS harness_fail_notice ON notifications; DROP FUNCTION IF EXISTS harness_fail_notice();");
    }
  });

  it("DEC-39: an empty set, a person who is not the slot's own occupant, an inactive member, a slot that is not an open consent slot — each refused, nothing written", () => {
    const r = rosterId();
    const t = reviewTicket(r, [m.ops1.uid]);
    const empty = asCaller(db, SERVICE, `SELECT open_consent_window('${t}', '${r}', 'ops', ARRAY[]::uuid[], now() + interval '2 days', now() + interval '3 days', 't', 'b', '{}'::jsonb)`);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toMatch(/nobody to ask/);
    const outsider = open(t, r, [m.other.uid]);
    expect(outsider.ok).toBe(false);
    if (!outsider.ok) expect(outsider.message).toMatch(/only the slot's own occupants/);
    const notConsent = open(t, r, [m.requester.uid], "accept");
    expect(notConsent.ok).toBe(false);
    const wrongRoster = open(t, randomUUID(), [m.ops1.uid]);
    expect(wrongRoster.ok).toBe(false);
    admin(db, `UPDATE org_members SET status = 'suspended' WHERE uid = '${m.ops1.uid}' AND org_id = '${orgId}'`);
    try {
      const gone = open(t, r, [m.ops1.uid]);
      expect(gone.ok).toBe(false);
      if (!gone.ok) expect(gone.message).toMatch(/no longer an active member/);
    } finally {
      admin(db, `UPDATE org_members SET status = 'active' WHERE uid = '${m.ops1.uid}' AND org_id = '${orgId}'`);
    }
    expect(cols(t)).toBe("false||");
    expect(count(`SELECT COUNT(*) FROM notifications WHERE resource_id = '${t}'`)).toBe(0);
  });

  it("DF-P7 fix pass (review major): a FORGED metadata roster — no ledger row behind it — opens nothing; nor a ledger slot that is not an open consent slot", () => {
    const r = rosterId();
    const forged = reviewTicket(r, [m.ops1.uid], { ledger: false });
    const res = open(forged, r, [m.ops1.uid]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/ledger has no open consent slot/);
    expect(cols(forged)).toBe("false||");
    expect(count(`SELECT COUNT(*) FROM notifications WHERE resource_id = '${forged}'`)).toBe(0);
    // the ledger says the slot is already satisfied (the metadata still says open): refused
    const r2 = rosterId();
    const t2 = reviewTicket(r2, [m.ops1.uid]);
    admin(db, `UPDATE ticket_review_slots SET status = 'void', closed_at = now() WHERE roster_id = '${r2}' AND slot_kind = 'ops'`);
    expect(open(t2, r2, [m.ops1.uid]).ok).toBe(false);
    // metadata names an extra person the ledger's slot does not: refused
    const r3 = rosterId();
    const t3 = reviewTicket(r3, [m.ops1.uid]);
    admin(db, `UPDATE tickets SET metadata = jsonb_set(metadata, '{review_roster,slots,1,primaries}', '["${m.ops1.uid}","${m.other.uid}"]'::jsonb) WHERE id = '${t3}'`);
    const extra = open(t3, r3, [m.ops1.uid, m.other.uid]);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.message).toMatch(/only the slot's own occupants/);
    expect(count(`SELECT COUNT(*) FROM notifications WHERE resource_id IN ('${t2}', '${t3}')`)).toBe(0);
  });

  it("DEC-12 / DEC-37 (review blocker): the drafter is never asked, even as the slot's own occupant; nor the requester on a slot independent of the requester", () => {
    const r = rosterId();
    const t = reviewTicket(r, [m.ops1.uid, m.ops2.uid], { drafter: m.ops1.uid });
    const res = open(t, r, [m.ops1.uid, m.ops2.uid]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/the drafter is never asked/);
    expect(cols(t)).toBe("false||");
    // the others may be asked
    expect(open(t, r, [m.ops2.uid]).ok).toBe(true);
    const r2 = rosterId();
    const t2 = reviewTicket(r2, [m.requester.uid, m.ops2.uid], { independentOf: ["requester"] });
    const req = open(t2, r2, [m.requester.uid]);
    expect(req.ok).toBe(false);
    if (!req.ok) expect(req.message).toMatch(/independent of the requester/);
    expect(open(t2, r2, [m.ops2.uid]).ok).toBe(true);
  });

  it("DRLS-16: a signed-in member cannot call either function (42501); the body also refuses a session", () => {
    const r = rosterId();
    const t = reviewTicket(r, [m.ops1.uid]);
    const asMember = asCaller(db, m.admin.caller, `SELECT open_consent_window('${t}', '${r}', 'ops', ARRAY['${m.ops1.uid}']::uuid[], now() + interval '2 days', now() + interval '3 days', 't', 'b', '{}'::jsonb)`);
    expect(asMember.ok).toBe(false);
    if (!asMember.ok) expect(asMember.code).toBe("42501");
    const warnMember = asCaller(db, m.admin.caller, `SELECT record_consent_window_warning('${t}', '${r}', ARRAY['${m.ops1.uid}']::uuid[], 't', 'b', '{}'::jsonb)`);
    expect(warnMember.ok).toBe(false);
    expect(cols(t)).toBe("false||");
  });

  it("DEC-39: the reminder must reach everyone asked; it stamps warned_at with its rows and events, once", () => {
    const r = rosterId();
    const t = reviewTicket(r, [m.ops1.uid, m.ops2.uid]);
    expect(open(t, r, [m.ops1.uid, m.ops2.uid]).ok).toBe(true);
    const short = asCaller(db, SERVICE, `SELECT record_consent_window_warning('${t}', '${r}', ARRAY['${m.ops1.uid}']::uuid[], 'Reminder', 'b', '{"action":"Consent window reminder — Operations","user":"system:consent-window","role":"System"}'::jsonb)`);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.message).toMatch(/reach everyone who was asked/);
    const ok = asCaller(db, SERVICE, `SELECT record_consent_window_warning('${t}', '${r}', ARRAY['${m.ops1.uid}', '${m.ops2.uid}', '${m.admin.uid}']::uuid[], 'Reminder', 'b', '{"action":"Consent window reminder — Operations","user":"system:consent-window","role":"System"}'::jsonb)`);
    expect(ok).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT (consent_window_warned_at IS NOT NULL)::text || '|' || (metadata->'review_roster'->'consentWindow' ? 'warnedAt')::text FROM tickets WHERE id = '${t}'`)).toBe("true|true");
    expect(count(`SELECT COUNT(*) FROM ticket_notice_events WHERE ticket_id = '${t}' AND kind = 'warned'`)).toBe(3);
    const twice = asCaller(db, SERVICE, `SELECT record_consent_window_warning('${t}', '${r}', ARRAY['${m.ops1.uid}', '${m.ops2.uid}']::uuid[], 'Reminder', 'b', '{}'::jsonb)`);
    expect(twice.ok).toBe(false);
  });

  it("the ten columns are workflow-owned: a member neither writes nor inserts one; an unrelated client write still lands (REGRESSION: the urgent mark)", () => {
    const r = rosterId();
    const t = reviewTicket(r, [m.ops1.uid]);
    expect(open(t, r, [m.ops1.uid]).ok).toBe(true);
    for (const set of [`consent_window_objected_at = now(), consent_window_objected_by = '${m.admin.uid}'`, "consent_window_expired_at = now()", "consent_window_warned_at = now()"]) {
      const res = asCaller(db, m.admin.caller, `UPDATE tickets SET ${set} WHERE id = '${t}'`);
      expect(res.ok, set).toBe(false);
      if (!res.ok) expect(res.message).toMatch(/workflow-owned|row-level security/);
    }
    expect(asCaller(db, m.admin.caller, `UPDATE tickets SET priority = 1 WHERE id = '${t}'`).ok).toBe(true);
    // the workflow (service role) records the objection
    expect(asCaller(db, SERVICE, `UPDATE tickets SET consent_window_objected_at = now(), consent_window_objected_by = '${m.ops1.uid}' WHERE id = '${t}'`)).toEqual({ ok: true, rows: 1 });
    // an objector with no time is refused for anyone (CHECK)
    expect(asCaller(db, SERVICE, `UPDATE tickets SET consent_window_objected_at = NULL WHERE id = '${t}'`).ok).toBe(false);
  });

  it("ticket_notice_events is append-only and read as the ticket reads; a not_emailed row only by its person; a ticket's deletion takes its rows", () => {
    const r = rosterId();
    const t = reviewTicket(r, [m.ops1.uid]);
    expect(open(t, r, [m.ops1.uid]).ok).toBe(true);
    admin(db, `INSERT INTO ticket_notice_events (org_id, ticket_id, kind, recipient, details) VALUES ('${orgId}', '${t}', 'not_emailed', '${m.ops2.uid}', '{"reason":"they turned email off"}')`);
    expect(asCaller(db, SERVICE, `UPDATE ticket_notice_events SET details = '{}' WHERE ticket_id = '${t}'`).ok).toBe(false);
    expect(asCaller(db, SERVICE, `DELETE FROM ticket_notice_events WHERE ticket_id = '${t}'`).ok).toBe(false);
    expect(asCaller(db, m.admin.caller, `INSERT INTO ticket_notice_events (org_id, ticket_id, kind) VALUES ('${orgId}', '${t}', 'advanced')`).ok).toBe(false);
    const asAdmin = selectAs(db, m.admin.caller, `SELECT kind FROM ticket_notice_events WHERE ticket_id = '${t}' ORDER BY kind`);
    expect(asAdmin).toEqual(["delivered"]);
    const asOps2 = selectAs(db, m.ops2.caller, `SELECT kind FROM ticket_notice_events WHERE ticket_id = '${t}' ORDER BY kind`);
    expect(asOps2).toEqual(["delivered", "not_emailed"]);
    admin(db, `DELETE FROM tickets WHERE id = '${t}'`);
    expect(count(`SELECT COUNT(*) FROM ticket_notice_events WHERE ticket_id = '${t}'`)).toBe(0);
  });

  it("the roster ledger takes a slot satisfied by a window (no signer, no signature) and still refuses a satisfied slot with no signature otherwise", () => {
    const r = rosterId();
    const t = reviewTicket(r, [m.ops1.uid], { ledger: false });
    const base = `org_id, ticket_id, roster_id, slot_kind, mode, status, content_hash, satisfied_at`;
    expect(asCaller(db, SERVICE, `INSERT INTO ticket_review_slots (${base}, satisfied_via) VALUES ('${orgId}', '${t}', '${r}', 'ops', 'consent_window', 'satisfied', 'h', now(), 'consent')`).ok).toBe(true);
    expect(asCaller(db, SERVICE, `INSERT INTO ticket_review_slots (${base}, satisfied_via, satisfied_by) VALUES ('${orgId}', '${t}', '${r}', 'a', 'blocking', 'satisfied', 'h', now(), 'primary', '${m.ops1.uid}')`).ok).toBe(false);
    expect(asCaller(db, SERVICE, `INSERT INTO ticket_review_slots (${base}, satisfied_via, satisfied_by, signature_id) VALUES ('${orgId}', '${t}', '${r}', 'b', 'consent_window', 'satisfied', 'h', now(), 'consent', '${m.ops1.uid}', '${randomUUID()}')`).ok).toBe(false);
    expect(asCaller(db, SERVICE, `INSERT INTO ticket_review_slots (${base}, satisfied_via, satisfied_by, signature_id) VALUES ('${orgId}', '${t}', '${r}', 'c', 'blocking', 'satisfied', 'h', now(), 'primary', '${m.ops1.uid}', '${randomUUID()}')`).ok).toBe(true);
  });
});
