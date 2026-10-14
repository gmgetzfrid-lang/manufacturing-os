// drafting-flow Round G, DF-P12 DELIVERABLE FOLLOW-UPS — the three migrations,
// asserted at RUNTIME on the replayed database (each statement sent as
// PostgREST sends it: role `authenticated` with the member's JWT claims, or
// `service_role` with none, which is how the workflow route writes).
//
//   20261221  ticket_update_guard refuses a client-appended "issued Rev N"
//             history line (SM-5's guard limb) and a client-appended
//             revision-round marker (DEC-44 (DF-P12) item 2's evidence); every legitimate client write
//             still lands; the service role still writes the issue line; the
//             history trust index (history_guarded_from) is stamped once, by
//             the guard, and is never a client's to write; an INSERT clears it.
//   20261222  the LEAK-7 (a) repair: a pre-Round-E reopened row under review
//             with an issued label gets what reopen_ticket does now; (a′),
//             normal and archived rows are untouched; a re-paste changes
//             nothing.
//   20261223  download_audits.ticket_id / attachment_id: a member records
//             their own ticket copy naming the file; the insert-own policy is
//             unchanged (no row in another member's name, no UPDATE / DELETE);
//             a row naming a ticket is read under the caller's ticket scope
//             (a Contractor-only member outside it does not see it).

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type Caller, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };

describe.skipIf(skip !== null)("DF-P12 — issue lines are the workflow's, the trust index, the LEAK-7 (a) repair, the ticket copy record (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let n = 0;

  /** A ticket inserted as the paste owner would (auth.uid() NULL: the insert triggers pass it). */
  const ticket = (over: Record<string, string> = {}): string => {
    const id = randomUUID();
    n += 1;
    const cols: Record<string, string> = {
      id: `'${id}'`, org_id: `'${orgId}'`, ticket_id: `'KE-P12-${n}'`, title: `'Tie-in ${n}'`, request_type: `'New Drawing'`,
      status: `'PENDING_IFC'`, requester_id: `'${m.requester.uid}'`, deliverable_rev: `'1'`, revision_count: "0",
      history: `'[{"action":"Approve (Issue for Construction) — issued Rev 1","user":"eng@harness.test"}]'::jsonb`,
      ...over,
    };
    admin(db, `INSERT INTO tickets (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
    return id;
  };
  const read = (id: string, col: string) => admin(db, `SELECT ${col} FROM tickets WHERE id = '${id}'`);
  const append = (who: Caller, id: string, entry: object) =>
    asCaller(db, who, `UPDATE tickets SET history = COALESCE(history, '[]'::jsonb) || jsonb_build_array('${JSON.stringify(entry).replace(/'/g, "''")}'::jsonb) WHERE id = '${id}'`);

  beforeAll(() => {
    const s = seedOrg(db, { requester: { role: "Requester" }, drafter: { role: "Drafter" }, admin: { role: "Admin" }, contractor: { role: "Contractor" } });
    orgId = s.orgId;
    m = s.m;
  });

  it("each DF-P12 migration re-pastes cleanly (DEC-30 one paste) and every probe answers true; the inventory rows carry counts", () => {
    const { conn } = mosDb();
    for (const f of ["20261221_df_roundG_issue_lines_server_only.sql", "20261222_df_roundG_leak7_reopened_label_repair.sql", "20261223_df_roundG_download_audits_ticket_copy.sql"]) {
      const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
      expect(r.ok, `${f}: ${r.error ?? ""}`).toBe(true);
      const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
      const probes = rows.filter((l) => /\|[tf]\|$/.test(l));
      expect(probes.length, f).toBeGreaterThanOrEqual(2);
      expect(probes.filter((l) => l.endsWith("|f|")), f).toEqual([]);
      expect(rows.filter((l) => /\|\|\d+$/.test(l)).length, f).toBeGreaterThanOrEqual(2);
    }
  });

  // ── 20261221 ────────────────────────────────────────────────────────────────
  it("REGRESSION: a member's own plain history append and the mark-read write still land (they are what clients write today)", () => {
    const id = ticket();
    expect(append(m.requester.caller, id, { action: "Converted to Project", user: m.requester.email, date: "2026-10-14T00:00:00Z" })).toEqual({ ok: true, rows: 1 });
    expect(read(id, "jsonb_array_length(history)")).toBe("2");
    expect(asCaller(db, m.drafter.caller, `UPDATE tickets SET unread_by = '{}' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, m.requester.caller, `UPDATE tickets SET priority = 1, last_modified = now() WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
  });

  it("SM-5 guard limb: a member can no longer append an 'issued Rev N' line in their own name — in any case or JSON shape", () => {
    const id = ticket({ status: "'PENDING_REVIEW'", deliverable_rev: "'3A'", revision_count: "2" });
    for (const action of ["note — issued Rev 2", "ISSUED REV 2", ["context", "issued Rev 2"], { text: "issued Rev 9" }, "reissued Rev 2"]) {
      const r = append(m.requester.caller, id, { action, user: m.requester.email });
      expect(r.ok, JSON.stringify(action)).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/an "issued Rev" history entry is written only by the request workflow/);
    }
    // nothing landed: the history is the one real issue line
    expect(read(id, "jsonb_array_length(history)")).toBe("1");
    // a near miss the readers never read as an issue is not refused
    expect(append(m.requester.caller, id, { action: "Revision issued to the field (see Rev 2A notes)", user: m.requester.email })).toEqual({ ok: true, rows: 1 });
  });

  it("a revision round's marker is the workflow's too: a member's entry carrying revisionRound is refused (any value, any shape); the service role writes one", () => {
    const id = ticket({ status: "'FINAL_DRAFT'" });
    for (const entry of [
      { action: "Reject Final (Re-Open)", user: m.requester.email, revisionRound: 1 },
      { action: "note", user: m.requester.email, revisionRound: "1" },
      { action: "note", user: m.requester.email, revisionRound: null },
    ]) {
      const r = append(m.requester.caller, id, entry);
      expect(r.ok, JSON.stringify(entry)).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/a revision-round history entry is written only by the request workflow/);
    }
    expect(read(id, "jsonb_array_length(history)")).toBe("1");
    expect(append(SERVICE, id, { action: "Reject Final (Re-Open)", user: "r@harness.test", revisionRound: 1 })).toEqual({ ok: true, rows: 1 });
    expect(read(id, "history->-1->>'revisionRound'")).toBe("1");
  });

  it("the workflow (the service role) still appends the issue line; the trust index is stamped once, at the row's history length before that write", () => {
    const id = ticket({ status: "'PENDING_REVIEW'", deliverable_rev: "'2A'", revision_count: "1" });
    expect(read(id, "history_guarded_from")).toBe(""); // NULL: born by INSERT
    expect(append(SERVICE, id, { action: "Approve (Issue for Construction) — issued Rev 2", user: "eng@harness.test" })).toEqual({ ok: true, rows: 1 });
    expect(read(id, "history_guarded_from")).toBe("1"); // the new line sits at index 1: proven
    expect(append(SERVICE, id, { action: "Final package submitted", user: "d@harness.test" })).toEqual({ ok: true, rows: 1 });
    expect(read(id, "history_guarded_from")).toBe("1"); // never re-stamped
  });

  it("a member's first write stamps the index too (their own appends are never issue lines), and the index is never a member's to write", () => {
    const id = ticket();
    expect(asCaller(db, m.requester.caller, `UPDATE tickets SET priority = 2 WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    expect(read(id, "history_guarded_from")).toBe("1");
    const r = asCaller(db, m.admin.caller, `UPDATE tickets SET history_guarded_from = 0 WHERE id = '${id}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/history_guarded_from.*workflow-owned/);
    expect(read(id, "history_guarded_from")).toBe("1");
    const fresh = ticket();
    const r2 = asCaller(db, m.admin.caller, `UPDATE tickets SET history_guarded_from = 0 WHERE id = '${fresh}'`);
    expect(r2.ok).toBe(false);
    expect(read(fresh, "history_guarded_from")).toBe("");
  });

  it("an INSERT proves nothing about its history: the index is cleared whatever the inserter wrote (a restore, any service-role insert)", () => {
    const id = ticket({ history_guarded_from: "0" });
    expect(read(id, "history_guarded_from")).toBe("");
  });

  it("an archived stub stamps nothing while it stays archived; the restore that puts its history back stamps the full restored length", () => {
    const id = ticket({ status: "'CLOSED'", archived_at: "now()", history: "'[]'::jsonb" });
    expect(asCaller(db, SERVICE, `UPDATE tickets SET archive_id = 'arch-1' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    expect(read(id, "history_guarded_from")).toBe("");
    const restored = JSON.stringify([{ action: "Approve — issued Rev 1", user: "e@x" }, { action: "note — issued Rev 4", user: "member@x" }]).replace(/'/g, "''");
    expect(asCaller(db, SERVICE, `UPDATE tickets SET history = '${restored}'::jsonb, archived_at = NULL, archive_id = NULL WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    expect(read(id, "history_guarded_from")).toBe("2"); // both restored lines predate the guard
  });

  it("a shed commit (live → archived) stamps the pre-shed length, so a later restore proves none of the restored lines", () => {
    const id = ticket({ status: "'CLOSED'" });
    expect(asCaller(db, SERVICE, `UPDATE tickets SET history = '[]'::jsonb, archived_at = now(), archive_id = 'arch-2' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    expect(read(id, "history_guarded_from")).toBe("1");
  });

  // ── 20261222 ────────────────────────────────────────────────────────────────
  it("LEAK-7 (a) repair: each (a) row gets reopen_ticket's counters and one history line; (a′), normal and archived rows are untouched; a re-paste changes nothing", () => {
    const issued1 = `'[{"action":"Approve (Issue for Construction) — issued Rev 1","user":"e@x"},{"action":"Reopen Ticket","user":"r@x"}]'::jsonb`;
    const a = ticket({ status: "'PENDING_REVIEW'", deliverable_rev: "'1'", revision_count: "0", history: issued1 });
    const aFinal = ticket({ status: "'PENDING_FINAL_APPROVAL'", deliverable_rev: "'2'", revision_count: "1", history: issued1 });
    const aAhead = ticket({ status: "'PENDING_REVIEW'", deliverable_rev: "'1'", revision_count: "1", history: issued1 }); // reject_final before the old reopen
    const aPrime = ticket({ status: "'PENDING_REVIEW'", deliverable_rev: "'1B'", revision_count: "0", history: issued1 });
    const normal = ticket({ status: "'PENDING_IFC'", deliverable_rev: "'1'", revision_count: "0" });
    const archived = ticket({ status: "'PENDING_REVIEW'", deliverable_rev: "'1'", revision_count: "0", archived_at: "now()" });
    const file = join(process.cwd(), "supabase", "migrations", "20261222_df_roundG_leak7_reopened_label_repair.sql");
    const { conn } = mosDb();
    const first = runPsql(conn!, db, conn!.superuser, { file, stopOnError: true });
    expect(first.ok, first.error ?? "").toBe(true);
    const lines = first.stdout.split("\n");
    expect(lines.filter((l) => /\|f\|$/.test(l))).toEqual([]); // every probe ok
    expect(lines.some((l) => l.startsWith("LEAK-7 (a): no live ticket under review carries an issued label") && l.endsWith("|t|"))).toBe(true);

    for (const [id, rc] of [[a, "1"], [aFinal, "2"], [aAhead, "1"]] as const) {
      expect(read(id, "deliverable_rev")).toBe("");
      expect(read(id, "revision_count"), id).toBe(rc);
      expect(read(id, "draft_iteration")).toBe("0");
      expect(read(id, "history->-1->>'action'")).toBe("Revision cycle restarted (data repair)");
      expect(read(id, "history->-1->>'user'")).toBe("system");
      // the repair line is never read as an issue
      expect(read(id, "history->-1->>'action' ~* 'issued Rev [[:digit:]]'")).toBe("f");
      expect(read(id, "history->0->>'action'")).toContain("issued Rev 1"); // the real issue line is untouched
    }
    expect(read(aPrime, "deliverable_rev")).toBe("1B");
    expect(read(normal, "deliverable_rev")).toBe("1");
    expect(read(archived, "deliverable_rev")).toBe("1");
    expect(read(aPrime, "jsonb_array_length(history)")).toBe("2");

    const second = runPsql(conn!, db, conn!.superuser, { file, stopOnError: true });
    expect(second.ok, second.error ?? "").toBe(true);
    expect(read(a, "jsonb_array_length(history)")).toBe("3"); // still exactly one repair line
    expect(read(a, "revision_count")).toBe("1");
  });

  // ── 20261223 ────────────────────────────────────────────────────────────────
  it("PHYS-17: a member records their own ticket copy naming the ticket and the file; the record stays insert-own and append-only", () => {
    const id = ticket();
    const own = asCaller(db, m.drafter.caller, `INSERT INTO download_audits (org_id, user_id, user_email, source, ticket_id, attachment_id) VALUES ('${orgId}', '${m.drafter.uid}', '${m.drafter.email}', 'drafting_print', '${id}', 'att-1')`);
    expect(own).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT attachment_id || '|' || source FROM download_audits WHERE ticket_id = '${id}'`)).toBe("att-1|drafting_print");
    const forged = asCaller(db, m.drafter.caller, `INSERT INTO download_audits (org_id, user_id, source, ticket_id, attachment_id) VALUES ('${orgId}', '${m.requester.uid}', 'drafting', '${id}', 'att-1')`);
    expect(forged.ok).toBe(false);
    expect(asCaller(db, m.drafter.caller, `UPDATE download_audits SET attachment_id = 'att-2' WHERE ticket_id = '${id}'`)).toEqual({ ok: true, rows: 0 });
    expect(asCaller(db, m.admin.caller, `DELETE FROM download_audits WHERE ticket_id = '${id}'`)).toEqual({ ok: true, rows: 0 });
    expect(admin(db, `SELECT count(*) FROM download_audits WHERE ticket_id = '${id}'`)).toBe("1");
    // not a foreign key: the record outlives the ticket (read by the service role; a member reads it only while they can read the ticket)
    admin(db, `DELETE FROM tickets WHERE id = '${id}'`);
    expect(admin(db, `SELECT count(*) FROM download_audits WHERE ticket_id = '${id}'`)).toBe("1");
    expect(selectAs(db, m.drafter.caller, `SELECT count(*) FROM download_audits WHERE ticket_id = '${id}'`)).toEqual(["0"]);
  });

  it("PHYS-17 review fix: a row naming a ticket is read under the caller's ticket scope — a Contractor-only member outside it does not see it; rows naming no ticket are untouched", () => {
    const theirs = ticket({ assigned_drafter_id: `'${m.contractor.uid}'` });
    const other = ticket();
    for (const [tid, att] of [[theirs, "att-c"], [other, "att-o"]] as const) {
      expect(asCaller(db, m.drafter.caller, `INSERT INTO download_audits (org_id, user_id, user_email, source, ticket_id, attachment_id) VALUES ('${orgId}', '${m.drafter.uid}', '${m.drafter.email}', 'drafting', '${tid}', '${att}')`)).toEqual({ ok: true, rows: 1 });
    }
    const docRow = randomUUID();
    admin(db, `INSERT INTO download_audits (id, org_id, user_id, user_email) VALUES ('${docRow}', '${orgId}', '${m.drafter.uid}', '${m.drafter.email}')`);
    const seen = (who: Caller) => selectAs(db, who, `SELECT COALESCE(attachment_id, 'doc') FROM download_audits WHERE ticket_id IN ('${theirs}', '${other}') OR id = '${docRow}' ORDER BY 1`);
    // the Contractor-only member reads the ticket they work on, and the document copy, but not the other ticket's row
    expect(seen(m.contractor.caller)).toEqual(["att-c", "doc"]);
    // every other member reads the tickets of their org: all three
    expect(seen(m.requester.caller)).toEqual(["att-c", "att-o", "doc"]);
    expect(seen(m.admin.caller)).toEqual(["att-c", "att-o", "doc"]);
  });
});
