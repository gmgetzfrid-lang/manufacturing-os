// notifications Round G, N18 DELIVERY RECORD — 20261258 asserted at RUNTIME
// on the replayed PostgreSQL 16 (each statement as PostgREST sends it: role
// `authenticated` with the member's claims, or `service_role` with none —
// how the drain, the delivery webhook and the server producers write).
//
//   EVID-9 dw1: record_email_delivery writes the provider's outcome onto the
//               row its message id names — first time of each outcome kept,
//               the strongest outcome wins, a redelivery changes nothing;
//               service role only.
//   EVID-9 dw2: 'not_emailed' is a status the drain's claim, its suppressed
//               recovery and its orphan reclaim never touch; a member may
//               record it only when email_gate() says the recipient's own
//               preferences turn the email off; an Admin re-queue can neither
//               re-queue it nor re-label a row as it; a client never writes
//               a delivery outcome.
//   Regression: a member's queued row, the service role's queued row and the
//               Admin dead-letter re-queue work exactly as before; the
//               60-second repeat check still merges a real repeat, and a
//               not_emailed record is never a repeat.
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
const F258 = "20261258_notif_roundG_delivery_record.sql";

function paste(f: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
  expect(r.ok, `${f}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("N18 — the delivery record on email_notifications (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const doc = randomUUID();
  const q = (s: string) => s.replace(/'/g, "''");
  const row = (o: { to: SeededMember; status?: string; event?: string; subject?: string; body?: string; resource?: string | null; extra?: string }) =>
    `INSERT INTO email_notifications (org_id, to_user_id, to_email, subject, body_text, resource_type, resource_id, event_type, status${o.extra ? `, ${o.extra.split("=")[0]}` : ""})
     VALUES ('${orgId}', '${o.to.uid}', '${o.to.email}', '${q(o.subject ?? "Status change")}', '${q(o.body ?? "body")}', ${o.resource === null ? "NULL" : "'document'"}, ${o.resource === null ? "NULL" : `'${o.resource ?? doc}'`}, '${o.event ?? "ticket_status_changed"}', '${o.status ?? "queued"}'${o.extra ? `, ${o.extra.split("=").slice(1).join("=")}` : ""})`;
  const one = (sql: string) => admin(db, sql).trim();

  beforeAll(() => {
    const s = seedOrg(db, { sender: { role: "Engineer" }, optedOut: { role: "Viewer" }, mutedStatus: { role: "Viewer" }, allOn: { role: "Viewer" }, boss: { role: "Admin" } });
    orgId = s.orgId;
    m = s.m;
    admin(db, `INSERT INTO notification_preferences (user_id, email_enabled) VALUES ('${m.optedOut.uid}', false);
               INSERT INTO notification_preferences (user_id, email_on_status_change) VALUES ('${m.mutedStatus.uid}', false);`);
  });

  it("re-pastes cleanly (DEC-30 one paste); every probe answers true; the inventory rows carry counts", () => {
    const { probes, inventory } = paste(F258);
    expect(probes.length).toBe(8);
    expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(inventory.length).toBe(5);
    for (const l of inventory) expect(l).toMatch(/\|\|\d+$/);
  });

  it("REGRESSION: a member queues an email to a colleague, and the service role queues one, exactly as before", () => {
    expect(asCaller(db, m.sender.caller, row({ to: m.allOn }))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, row({ to: m.allOn, subject: "From the server" }))).toEqual({ ok: true, rows: 1 });
  });

  it("dw2: a member records 'not emailed by their choice' only for a person whose own preference turns that email off", () => {
    // master switch off → accepted
    expect(asCaller(db, m.sender.caller, row({ to: m.optedOut, status: "not_emailed", subject: "Opted out" }))).toEqual({ ok: true, rows: 1 });
    // the event's own switch off → accepted for that event, refused for another
    expect(asCaller(db, m.sender.caller, row({ to: m.mutedStatus, status: "not_emailed", subject: "Muted status" }))).toEqual({ ok: true, rows: 1 });
    const other = asCaller(db, m.sender.caller, row({ to: m.mutedStatus, status: "not_emailed", event: "comment_mention", subject: "Mention" }));
    expect(other).toMatchObject({ ok: false, code: "22023" });
    // a person whose preferences allow it → refused: a member cannot forge "they opted out"
    const forged = asCaller(db, m.sender.caller, row({ to: m.allOn, status: "not_emailed", subject: "Forged" }));
    expect(forged).toMatchObject({ ok: false, code: "22023" });
    expect((forged as { message: string }).message).toMatch(/own preferences turn this email off/);
    // a recall is never "their choice" (no preference stops it)
    expect(asCaller(db, m.sender.caller, row({ to: m.optedOut, status: "not_emailed", event: "safety_recall", subject: "Recall" }))).toMatchObject({ ok: false, code: "22023" });
    // the service role (a server producer) is trusted, as for every row it writes
    expect(asCaller(db, SERVICE, row({ to: m.optedOut, status: "not_emailed", subject: "Server opted out" }))).toEqual({ ok: true, rows: 1 });
  });

  it("dw2: a repeat of a record inside 60 s (same recipient, event, resource, subject and body) is not written again — by a member or the service role; a different message is", () => {
    const res = randomUUID();
    const count = () => one(`SELECT COUNT(*) FROM email_notifications WHERE org_id = '${orgId}' AND status = 'not_emailed' AND resource_id = '${res}'`);
    const rec = (subject: string, body = "Same body") => row({ to: m.optedOut, status: "not_emailed", subject, body, resource: res });
    expect(asCaller(db, m.sender.caller, rec("Burst"))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, m.sender.caller, rec("Burst"))).toEqual({ ok: true, rows: 0 });
    expect(asCaller(db, SERVICE, rec("Burst"))).toEqual({ ok: true, rows: 0 });
    expect(count()).toBe("1");
    // a different body (or subject) is a different message: recorded
    expect(asCaller(db, SERVICE, rec("Burst", "Other body"))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, m.sender.caller, rec("Other subject", "Other body"))).toEqual({ ok: true, rows: 1 });
    expect(count()).toBe("3");
    // outside the 60 s window the same words are recorded again
    admin(db, `UPDATE email_notifications SET created_at = now() - interval '2 minutes' WHERE org_id = '${orgId}' AND resource_id = '${res}'`);
    expect(asCaller(db, m.sender.caller, rec("Burst"))).toEqual({ ok: true, rows: 1 });
    expect(count()).toBe("4");
  });

  it("dw2: the drain never re-queues or claims a not_emailed row — its claim, its suppressed recovery and its orphan reclaim all pass it by", () => {
    const before = one(`SELECT COUNT(*) FROM email_notifications WHERE org_id = '${orgId}' AND status = 'not_emailed'`);
    expect(Number(before)).toBeGreaterThanOrEqual(3);
    // the drain's three writes, as app/api/notifications/send-queued/route.ts sends them (service role)
    expect(asCaller(db, SERVICE, `UPDATE email_notifications SET status = 'queued', attempt_count = 0, error_message = NULL WHERE status = 'suppressed' AND created_at >= now() - interval '7 days' AND org_id = '${orgId}'`)).toEqual({ ok: true, rows: 0 });
    expect(asCaller(db, SERVICE, `UPDATE email_notifications SET status = 'queued' WHERE status = 'sending' AND last_attempted_at < now() - interval '15 minutes' AND org_id = '${orgId}'`)).toEqual({ ok: true, rows: 0 });
    const claimed = asCaller(db, SERVICE, `UPDATE email_notifications SET status = 'sending', last_attempted_at = now() WHERE status IN ('queued', 'failed') AND attempt_count < 5 AND org_id = '${orgId}'`);
    expect(claimed).toEqual({ ok: true, rows: 2 });
    expect(one(`SELECT COUNT(*) FROM email_notifications WHERE org_id = '${orgId}' AND status = 'not_emailed'`)).toBe(before);
  });

  it("an Admin's re-queue still works for a dead letter; it can neither re-queue a not_emailed row nor re-label a row as one", () => {
    const failed = randomUUID();
    admin(db, `INSERT INTO email_notifications (id, org_id, to_user_id, to_email, subject, body_text, event_type, status, attempt_count)
               VALUES ('${failed}', '${orgId}', '${m.allOn.uid}', '${m.allOn.email}', 'Dead letter', 'b', 'assignment', 'failed', 5)`);
    expect(asCaller(db, m.boss.caller, `UPDATE email_notifications SET status = 'queued', attempt_count = 0 WHERE id = '${failed}'`)).toEqual({ ok: true, rows: 1 });
    const ne = one(`SELECT id FROM email_notifications WHERE org_id = '${orgId}' AND status = 'not_emailed' LIMIT 1`);
    expect(asCaller(db, m.boss.caller, `UPDATE email_notifications SET status = 'queued', attempt_count = 0 WHERE id = '${ne}'`)).toMatchObject({ ok: false, code: "22023" });
    expect(asCaller(db, m.boss.caller, `UPDATE email_notifications SET status = 'not_emailed' WHERE id = '${failed}'`)).toMatchObject({ ok: false, code: "22023" });
    expect(one(`SELECT status FROM email_notifications WHERE id = '${ne}'`)).toBe("not_emailed");
  });

  it("a client never writes a delivery outcome: an insert carrying one is refused, an update of one is refused (20261047's column rail)", () => {
    const ins = asCaller(db, m.sender.caller, row({ to: m.allOn, subject: "Forged delivery", extra: "delivery_status='delivered'" }));
    expect(ins).toMatchObject({ ok: false, code: "42501" });
    const id = one(`SELECT id FROM email_notifications WHERE org_id = '${orgId}' AND subject = 'Dead letter'`);
    expect(asCaller(db, m.boss.caller, `UPDATE email_notifications SET delivered_at = now() WHERE id = '${id}'`)).toMatchObject({ ok: false, code: "23514" });
  });

  it("dw1: record_email_delivery — service role only; first time of each outcome kept; strongest outcome wins; unknown id answers no_row", () => {
    const id = randomUUID();
    const msg = `re_${id.slice(0, 8)}`;
    admin(db, `INSERT INTO email_notifications (id, org_id, to_user_id, to_email, subject, body_text, event_type, status, sent_at, provider_message_id)
               VALUES ('${id}', '${orgId}', '${m.allOn.uid}', '${m.allOn.email}', 'Final approval needed', 'b', 'assignment', 'sent', now(), '${msg}')`);
    const call = (outcome: string, at: string, detail = "NULL") => `SELECT record_email_delivery('${msg}', '${outcome}', '${at}'::timestamptz, ${detail})`;
    // a signed-in member may not call it at all
    expect(asCaller(db, m.boss.caller, call("delivered", "2026-10-21T10:00:00Z"))).toMatchObject({ ok: false, code: "42501" });
    expect(asCaller(db, SERVICE, `SELECT record_email_delivery('re_nobody', 'delivered', now(), NULL)`)).toEqual({ ok: true, rows: 1 });
    expect(one(`SELECT record_email_delivery('re_nobody', 'delivered', now(), NULL)`)).toBe("no_row");
    expect(asCaller(db, SERVICE, call("delayed", "2026-10-21T09:59:00Z", "'mailbox busy'"))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, call("delivered", "2026-10-21T10:00:00Z"))).toEqual({ ok: true, rows: 1 });
    const read = () => one(`SELECT status || '|' || delivery_status || '|' || COALESCE(to_char(delivered_at AT TIME ZONE 'UTC', 'HH24:MI'), '-') || '|' || COALESCE(to_char(bounced_at AT TIME ZONE 'UTC', 'HH24:MI'), '-') || '|' || COALESCE(delivery_detail, '-') FROM email_notifications WHERE id = '${id}'`);
    expect(read()).toBe("sent|delivered|10:00|-|-");
    // a redelivered report changes nothing; a later delay never weakens it
    expect(asCaller(db, SERVICE, call("delivered", "2026-10-21T10:05:00Z"))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, call("delayed", "2026-10-21T10:06:00Z", "'late'"))).toEqual({ ok: true, rows: 1 });
    expect(read()).toBe("sent|delivered|10:00|-|-");
    // a bounce is stronger: it wins, and the delivery time is kept beside it
    expect(asCaller(db, SERVICE, call("bounced", "2026-10-21T10:10:00Z", "'mailbox full'"))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, call("bounced", "2026-10-21T10:20:00Z", "'again'"))).toEqual({ ok: true, rows: 1 });
    expect(read()).toBe("sent|bounced|10:00|10:10|mailbox full");
    // an unknown outcome is refused
    expect(asCaller(db, SERVICE, `SELECT record_email_delivery('${msg}', 'opened', now(), NULL)`)).toMatchObject({ ok: false, code: "22023" });
  });

  it("email_gate: a real repeat within 60 s is still merged; a not_emailed record is never a repeat (the person who turns email back on gets the next one)", () => {
    const res = randomUUID();
    // asked as the service role (the server producers' caller), as queueEmail asks it there
    const gate = (who: SeededMember) => selectAs(db, SERVICE, `SELECT email_gate('${orgId}', '${who.uid}', 'ticket_status_changed', '${res}', 'Same subject', 'Same body')`).at(-1);
    // a not_emailed record for the person, then they turn email back on
    admin(db, `UPDATE notification_preferences SET email_enabled = true WHERE user_id = '${m.optedOut.uid}'`);
    admin(db, row({ to: m.optedOut, status: "not_emailed", subject: "Same subject", body: "Same body", resource: res }));
    expect(gate(m.optedOut)).toBe("t");
    // a queued email with the same words IS a repeat (unchanged)
    admin(db, row({ to: m.allOn, subject: "Same subject", body: "Same body", resource: res }));
    expect(gate(m.allOn)).toBe("f");
    admin(db, `UPDATE notification_preferences SET email_enabled = false WHERE user_id = '${m.optedOut.uid}'`);
    expect(gate(m.optedOut)).toBe("f");
  });
});
