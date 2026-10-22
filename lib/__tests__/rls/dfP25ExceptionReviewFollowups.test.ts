// drafting-flow Round G, DF-P25 — 20261267 asserted at RUNTIME on the
// replayed PostgreSQL 16 (each statement as PostgREST sends it: role
// `authenticated` with the member's claims, or `service_role`):
//   * the file re-pastes cleanly (DEC-30 one paste); 8 probes true; the
//     inventory rows carry counts;
//   * (1) org_members.status_changed_at: NULL on insert (a forged value
//     dropped), stamped by a status change from ANY writer (the service role,
//     revoke_member in an Admin's session, plain SQL), kept on every other
//     write (a forged value dropped); apply_ticket_preauthorizations refuses
//     a record whose grantor's status was flipped straight on the table and
//     flipped back with NO audit row — the gap DF-P22 recorded;
//   * (2) a client's appended history entry may carry no actorId (absent or
//     null) or its own; another uid, a non-string or a forged actor is
//     refused 42501; the same rule holds for an entry rewritten in place
//     with only 20261038's guard live (trg_ticket_update_guard disabled for
//     that case — production's state while 20261166 is a HOLD); the service
//     role and a SECURITY DEFINER path are untouched; entries already in the
//     log and left unchanged are not re-checked;
//   * (3) the claim's recipients column says what it holds;
//   * (4) document_holds.examination is written with the hold (a member's
//     own insert), an object of bounded size or NULL, never changed after —
//     a hold without it, and its release, behave exactly as before; a
//     client may write it only on a hold opened in its own name (a record
//     on a hold naming another uid as opened_by is refused 42501; the
//     service role — a restore — is untouched), and a recorded hold's
//     opener is pinned by this file for every role, even with 20261073's
//     identity guard not live (trg_document_hold_guard disabled for that
//     case — production while 20261073 is a PASTE). REVIEW FIX 4: a large
//     round's record, as holdExaminationRecord bounds it, always lands; the
//     unbounded one is the CHECK's 23514 that openHold falls back on.

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";
import { holdExaminationRecord, jsonbTextBytes } from "@/lib/assuranceExamination";
import { isHoldExaminationShapeRefusal } from "@/lib/holds";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const F267 = "20261267_df_roundG_exception_review_followups.sql";

function paste(f: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
  expect(r.ok, `${f}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("DF-P25 — 20261267 (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const one = (sql: string) => admin(db, sql).trim();
  const memberRow = (uid: string) => one(`SELECT id FROM org_members WHERE org_id = '${orgId}' AND uid = '${uid}'`);
  const stamp = (uid: string) => one(`SELECT COALESCE(status_changed_at::text, 'NULL') FROM org_members WHERE org_id = '${orgId}' AND uid = '${uid}'`);

  beforeAll(() => {
    const s = seedOrg(db, { requester: { role: "Manager" }, qa: { role: "Viewer" }, q2: { role: "Viewer" }, admin: { role: "Admin" }, drafter: { role: "Drafter" } });
    orgId = s.orgId;
    m = s.m;
  });

  it("re-pastes cleanly twice (DEC-30 one paste); 8 probes true; 6 inventory rows and 2 after-rows carry counts", () => {
    for (let i = 0; i < 2; i++) {
      const { probes, inventory } = paste(F267);
      expect(probes.length).toBe(8);
      expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
      expect(inventory.length).toBe(8);
    }
  });

  describe("(1) a membership status change is a stored fact, whoever writes it", () => {
    it("an insert lands NULL (a forged stamp dropped); a write that does not change status keeps the stored value (a forged one dropped)", () => {
      const s = seedOrg(db, { x: { role: "Viewer" } });
      expect(one(`SELECT COALESCE(status_changed_at::text, 'NULL') FROM org_members WHERE uid = '${s.m.x.uid}'`)).toBe("NULL");
      const uid = randomUUID();
      admin(db, `INSERT INTO auth.users (id, email, aud, role) VALUES ('${uid}', 'f-${uid.slice(0, 6)}@harness.test', 'authenticated', 'authenticated');
                 INSERT INTO org_members (org_id, uid, email, role, roles, status, status_changed_at) VALUES ('${s.orgId}', '${uid}', 'f-${uid.slice(0, 6)}@harness.test', 'Viewer', ARRAY[]::text[], 'active', '2000-01-01');`);
      expect(one(`SELECT COALESCE(status_changed_at::text, 'NULL') FROM org_members WHERE uid = '${uid}'`)).toBe("NULL");
      admin(db, `UPDATE org_members SET display_name = 'Renamed', status_changed_at = '2000-01-01' WHERE uid = '${uid}'`);
      expect(one(`SELECT COALESCE(status_changed_at::text, 'NULL') FROM org_members WHERE uid = '${uid}'`)).toBe("NULL");
    });

    it("a status change is stamped by the service role, by revoke_member in an Admin's session and by plain SQL — and a later write keeps it", () => {
      expect(stamp(m.q2.uid)).toBe("NULL");
      expect(asCaller(db, SERVICE, `UPDATE org_members SET status = 'suspended' WHERE org_id = '${orgId}' AND uid = '${m.q2.uid}'`)).toEqual({ ok: true, rows: 1 });
      const first = stamp(m.q2.uid);
      expect(first).not.toBe("NULL");
      expect(asCaller(db, m.admin.caller, `SELECT revoke_member('${memberRow(m.q2.uid)}', 'restore')`).ok).toBe(true);
      const second = stamp(m.q2.uid);
      expect(second > first).toBe(true);
      admin(db, `UPDATE org_members SET status = 'suspended' WHERE org_id = '${orgId}' AND uid = '${m.q2.uid}'; UPDATE org_members SET status = 'active' WHERE org_id = '${orgId}' AND uid = '${m.q2.uid}';`);
      const third = stamp(m.q2.uid);
      expect(third > second).toBe(true);
      admin(db, `UPDATE org_members SET display_name = 'Q2 again' WHERE org_id = '${orgId}' AND uid = '${m.q2.uid}'`);
      expect(stamp(m.q2.uid)).toBe(third);
    });

    it("apply_ticket_preauthorizations: a grantor flipped straight on the table and back, with NO audit row, is not in force; a continuously active grantor's record applies (unchanged)", () => {
      const ticket = () => {
        const id = randomUUID();
        admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, history, metadata)
                   VALUES ('${id}', '${orgId}', 'KE-P25-${id.slice(0, 6)}', 'Gasket', 'Revision', 'PENDING_REVIEW', '${m.requester.uid}', '[]'::jsonb, '{}'::jsonb)`);
        return id;
      };
      const record = (grantor: string) => {
        const id = randomUUID();
        admin(db, `INSERT INTO ticket_preauthorizations (id, org_id, grantor_id, grantor_name, request_type, statement, signature_id, expires_at)
                   VALUES ('${id}', '${orgId}', '${grantor}', 'G', 'Revision', 'I give my standing pre-authorization', '${randomUUID()}', now() + interval '30 days')`);
        return id;
      };
      const apply = (t: string, p: string) => selectAs(db, SERVICE,
        `SELECT apply_ticket_preauthorizations('${t}', '${orgId}', (SELECT last_modified FROM tickets WHERE id = '${t}'), ARRAY['${p}']::uuid[], '{"applied":true}'::jsonb, '[{"action":"Standing pre-authorization applied"}]'::jsonb, now(), NULL)->>'result';`).join("");
      const pFlipped = record(m.qa.uid);
      admin(db, `UPDATE org_members SET status = 'suspended' WHERE org_id = '${orgId}' AND uid = '${m.qa.uid}'; UPDATE org_members SET status = 'active' WHERE org_id = '${orgId}' AND uid = '${m.qa.uid}';`);
      expect(Number(one(`SELECT COUNT(*) FROM audit_logs WHERE org_id = '${orgId}' AND resource_id = '${m.qa.uid}'`))).toBe(0);
      const t1 = ticket();
      expect(apply(t1, pFlipped)).toBe("not_in_force");
      expect(Number(one(`SELECT COUNT(*) FROM tickets WHERE id = '${t1}' AND metadata ? 'applied'`))).toBe(0);
      // REGRESSION: a record made after the flip, by a continuously active grantor since, applies
      const pAfter = record(m.qa.uid);
      const t2 = ticket();
      expect(apply(t2, pAfter)).toBe("applied");
    });
  });

  describe("(2) EVID-1: a client's own history append names only the client as its actor", () => {
    const newTicket = () => {
      const id = randomUUID();
      admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, history)
                 VALUES ('${id}', '${orgId}', 'KE-P25H-${id.slice(0, 6)}', 'Valve', 'Revision', 'DRAFTING', '${m.requester.uid}', '[{"action":"Created","user":"seed"}]'::jsonb)`);
      return id;
    };
    const append = (t: string, entry: Record<string, unknown>) =>
      `UPDATE tickets SET history = history || jsonb_build_array('${JSON.stringify(entry).replace(/'/g, "''")}'::jsonb) WHERE id = '${t}'`;
    const len = (t: string) => Number(one(`SELECT jsonb_array_length(history) FROM tickets WHERE id = '${t}'`));

    it("an own-name append with no actorId, a null actorId, or the caller's own uid lands", () => {
      const t = newTicket();
      for (const e of [
        { action: "Note", user: m.requester.email },
        { action: "Note", user: m.requester.email, actorId: null },
        { action: "Note", user: m.requester.email, actorId: m.requester.uid },
        { action: "Note", user: m.requester.email, actorId: m.requester.uid.toUpperCase() },
      ]) expect(asCaller(db, m.requester.caller, append(t, e))).toEqual({ ok: true, rows: 1 });
      expect(len(t)).toBe(5);
    });

    it("an append naming another uid, a non-string or junk as its actorId is refused 42501, nothing written", () => {
      const t = newTicket();
      for (const actorId of [m.admin.uid, 42, { id: m.requester.uid }, "not-a-uuid"]) {
        const r = asCaller(db, m.requester.caller, append(t, { action: "Note", user: m.requester.email, actorId }));
        expect(r).toMatchObject({ ok: false, code: "42501" });
      }
      expect(len(t)).toBe(1);
    });

    it("with ticket_update_guard not stopping in-place edits (production's live 20261038 guard only refuses shrinking), an entry rewritten in place with another uid's actorId is refused 42501 by THIS guard; an unchanged prefix plus an own append lands", () => {
      const t = newTicket();
      expect(asCaller(db, SERVICE, append(t, { action: "Approved", user: "eng@plant.test", actorId: m.admin.uid }))).toEqual({ ok: true, rows: 1 });
      admin(db, "ALTER TABLE tickets DISABLE TRIGGER trg_ticket_update_guard;");
      try {
        // the stored first entry rewritten to name the admin, plus a harmless own append (length grows, so no shrink rule applies)
        const forged = `UPDATE tickets SET history = jsonb_build_array(
            jsonb_build_object('action','Created','user','seed','actorId','${m.admin.uid}'),
            history -> 1,
            jsonb_build_object('action','Note','user','${m.requester.email}')) WHERE id = '${t}'`;
        const r = asCaller(db, m.requester.caller, forged);
        expect(r).toMatchObject({ ok: false, code: "42501" });
        expect((r as { message: string }).message).toMatch(/may name only you as its actor/);
        // the same move keeping someone else's existing actorId on a rewritten line is refused too
        const kept = `UPDATE tickets SET history = jsonb_build_array(history -> 0,
            jsonb_set(history -> 1, '{action}', '"Approved with changes"'),
            jsonb_build_object('action','Note','user','${m.requester.email}')) WHERE id = '${t}'`;
        expect(asCaller(db, m.requester.caller, kept)).toMatchObject({ ok: false, code: "42501" });
        expect(len(t)).toBe(2);
        expect(one(`SELECT COALESCE(history -> 0 ->> 'actorId', 'NULL') FROM tickets WHERE id = '${t}'`)).toBe("NULL");
        // REGRESSION: the stored entries unchanged (one naming the admin) plus an own append lands
        expect(asCaller(db, m.requester.caller, append(t, { action: "Note", user: m.requester.email, actorId: m.requester.uid }))).toEqual({ ok: true, rows: 1 });
        expect(len(t)).toBe(3);
      } finally {
        admin(db, "ALTER TABLE tickets ENABLE TRIGGER trg_ticket_update_guard;");
      }
    });

    it("the service role and a SECURITY DEFINER path are untouched; entries already in the log are never re-checked", () => {
      const t = newTicket();
      expect(asCaller(db, SERVICE, append(t, { action: "Approved", user: "eng@plant.test", actorId: m.admin.uid }))).toEqual({ ok: true, rows: 1 });
      // (the line names the caller as `user`, so 20261250's own-name rule — a
      // separate guard — is satisfied; only its actorId is foreign)
      admin(db, `CREATE OR REPLACE FUNCTION harness_p25_definer_append(p_ticket uuid, p_user text, p_actor text) RETURNS void
                 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
                 BEGIN UPDATE tickets SET history = history || jsonb_build_array(jsonb_build_object('action','System line','user',p_user,'actorId',p_actor)) WHERE id = p_ticket; END $f$;
                 GRANT EXECUTE ON FUNCTION harness_p25_definer_append(uuid, text, text) TO authenticated;`);
      expect(asCaller(db, m.requester.caller, `SELECT harness_p25_definer_append('${t}', '${m.requester.email}', '${m.admin.uid}')`)).toMatchObject({ ok: true });
      // the same line written directly by the client is refused by THIS guard
      expect(asCaller(db, m.requester.caller, append(t, { action: "System line", user: m.requester.email, actorId: m.admin.uid }))).toMatchObject({ ok: false, code: "42501" });
      // a later own append is checked on ITS entry only — the foreign actors above stay
      expect(asCaller(db, m.requester.caller, append(t, { action: "Note", user: m.requester.email }))).toEqual({ ok: true, rows: 1 });
      expect(len(t)).toBe(4);
      admin(db, "DROP FUNCTION harness_p25_definer_append(uuid, text, text);");
    });
  });

  it("(3) the escalation claim's recipients column says it is the audience asked", () => {
    expect(one(`SELECT col_description('public.ticket_sla_escalations'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.ticket_sla_escalations'::regclass AND attname = 'recipients'))`)).toMatch(/audience asked/);
  });

  describe("(4) a hold carries what its opener examined, written with it, never changed", () => {
    let doc = "";
    beforeAll(() => {
      const lib = randomUUID();
      doc = randomUUID();
      admin(db, [
        `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'P25', 'documents')`,
        `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${doc}', '${orgId}', '${lib}', 'p.pdf', 'P&ID', 'P-${doc.slice(0, 8)}', 'B', 'Issued')`,
      ].join(";\n") + ";");
    });
    const place = (who: SeededMember, examination: string | null, note: string) =>
      asCaller(db, who.caller, `INSERT INTO document_holds (org_id, document_id, reason, notes, opened_by${examination === null ? "" : ", examination"})
                                VALUES ('${orgId}', '${doc}', 'Other', '${note}', '${who.uid}'${examination === null ? "" : `, ${examination}`})`);

    it("a member's own hold with a record lands; the record is the one written", () => {
      expect(place(m.qa, `'{"ticketId":"t-1","files":[{"name":"a.pdf","sha256":"ab"}],"note":"sheet 3"}'::jsonb`, "p25 exam")).toEqual({ ok: true, rows: 1 });
      expect(one(`SELECT examination->>'note' FROM document_holds WHERE notes = 'p25 exam'`)).toBe("sheet 3");
    });
    it("a record that is not an object, or is oversized, is refused (CHECK); nothing written", () => {
      expect(place(m.qa, `'[1,2]'::jsonb`, "p25 bad")).toMatchObject({ ok: false, code: "23514" });
      expect(place(m.qa, `jsonb_build_object('note', repeat('x', 40000))`, "p25 big")).toMatchObject({ ok: false, code: "23514" });
      expect(Number(one(`SELECT COUNT(*) FROM document_holds WHERE notes IN ('p25 bad', 'p25 big')`))).toBe(0);
    });
    it("REVIEW FIX 4: a 320-file round's record, as holdExaminationRecord builds it, always lands (sized as Postgres counts it); the untrimmed record is the CHECK's refusal openHold falls back on", () => {
      const files = Array.from({ length: 320 }, (_, i) => ({ id: `att-${i}`, name: `PROJ-2026-UNIT-400-ISO-${String(i).padStart(4, "0")}-sheet-${i % 7}-of-7_rev1A_é.pdf`, url: `k/${i}`, sha256: (i % 16).toString(16).repeat(64) }));
      const roster = { id: "r-big", contentHash: "c".repeat(64), cycle: "1A", files } as unknown as Parameters<typeof holdExaminationRecord>[0];
      const note = "Nozzle N3 orientation differs from the vendor datasheet — ".repeat(40).slice(0, 2000).trim();
      const built = holdExaminationRecord(roster, "t-big", { kind: "qa", label: "Quality" }, { files: files.map((f) => f.id), note });
      expect(built.ok).toBe(true);
      const rec = (built as unknown as { ok: true; record: Record<string, unknown> }).record;
      expect(rec).toMatchObject({ filesTruncated: true, examinedFiles: 320 });
      const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
      expect(place(m.qa, lit(rec), "p25 big roster")).toEqual({ ok: true, rows: 1 });
      // the measure the record is kept within is the very one the CHECK counts
      expect(Number(one(`SELECT octet_length(examination::text) FROM document_holds WHERE notes = 'p25 big roster'`))).toBe(jsonbTextBytes(rec));
      // the same record naming every file is over the bound: refused 23514 naming the CHECK — what openHold places the hold without
      const full = { ...rec, files: files.map((f) => ({ id: f.id, name: f.name, sha256: f.sha256 })) };
      const refused = place(m.qa, lit(full), "p25 big untrimmed");
      expect(refused).toMatchObject({ ok: false, code: "23514" });
      expect(isHoldExaminationShapeRefusal(refused as { code: string; message: string })).toBe(true);
      expect(Number(one(`SELECT COUNT(*) FROM document_holds WHERE notes = 'p25 big untrimmed'`))).toBe(0);
    });
    it("the record is never changed — by the opener, an Admin, or the service role; releasing the hold still works (REGRESSION)", () => {
      const id = one(`SELECT id FROM document_holds WHERE notes = 'p25 exam'`);
      for (const who of [m.qa.caller, m.admin.caller]) {
        const r = asCaller(db, who, `UPDATE document_holds SET examination = '{"note":"rewritten"}'::jsonb WHERE id = '${id}'`);
        expect(r.ok === false || (r.ok && r.rows === 0)).toBe(true);
      }
      expect(asCaller(db, SERVICE, `UPDATE document_holds SET examination = NULL WHERE id = '${id}'`)).toMatchObject({ ok: false, code: "42501" });
      expect(one(`SELECT examination->>'note' FROM document_holds WHERE id = '${id}'`)).toBe("sheet 3");
      expect(asCaller(db, SERVICE, `UPDATE document_holds SET released_at = now(), released_by = '${m.qa.uid}', released_reason = 'examined and cleared' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
      expect(one(`SELECT examination->>'note' FROM document_holds WHERE id = '${id}'`)).toBe("sheet 3");
    });
    it("a record on a hold opened in ANOTHER uid's name is refused 42501, nothing written; the same record in the caller's own name lands", () => {
      const forged = `'{"stop":"hold","ticketId":"t-2","slotKind":"qa","slotLabel":"Quality","note":"Examined, found nothing"}'::jsonb`;
      const r = asCaller(db, m.drafter.caller, `INSERT INTO document_holds (org_id, document_id, reason, notes, opened_by, opened_by_name, examination)
                                                VALUES ('${orgId}', '${doc}', 'Other', 'p25 forged', '${m.qa.uid}', 'QA Lead', ${forged})`);
      expect(r).toMatchObject({ ok: false, code: "42501" });
      expect((r as { message: string }).message).toMatch(/a record of what was examined goes only on a hold you place in your own name/);
      expect(Number(one(`SELECT COUNT(*) FROM document_holds WHERE notes = 'p25 forged'`))).toBe(0);
      expect(place(m.drafter, forged, "p25 own")).toEqual({ ok: true, rows: 1 });
      expect(one(`SELECT opened_by::text FROM document_holds WHERE notes = 'p25 own'`)).toBe(m.drafter.uid);
    });
    it("REVIEW FIX 3: with 20261073's identity guard NOT live (trg_document_hold_guard disabled — production while 20261073 is a PASTE), a recorded hold's opener cannot be moved to another person, by a client or the service role; its notes still move; a hold without a record is not looked at", () => {
      const rec = `'{"stop":"hold","ticketId":"t-3","rosterId":"r-1","slotKind":"qa","note":"Examined, found nothing"}'::jsonb`;
      expect(place(m.admin, rec, "p25 reattr")).toEqual({ ok: true, rows: 1 });
      expect(place(m.admin, null, "p25 reattr-plain")).toEqual({ ok: true, rows: 1 });
      const id = one(`SELECT id FROM document_holds WHERE notes = 'p25 reattr'`);
      const plain = one(`SELECT id FROM document_holds WHERE notes = 'p25 reattr-plain'`);
      admin(db, "ALTER TABLE document_holds DISABLE TRIGGER trg_document_hold_guard;");
      try {
        // the forgery the review named: re-point the opener (and its name) at a slot's person after the insert
        const moved = asCaller(db, m.admin.caller, `UPDATE document_holds SET opened_by = '${m.qa.uid}', opened_by_name = 'QA Lead' WHERE id = '${id}'`);
        expect(moved).toMatchObject({ ok: false, code: "42501" });
        expect((moved as { message: string }).message).toMatch(/keeps the person who placed it/);
        expect(asCaller(db, m.admin.caller, `UPDATE document_holds SET opened_by_name = 'QA Lead' WHERE id = '${id}'`)).toMatchObject({ ok: false, code: "42501" });
        expect(asCaller(db, SERVICE, `UPDATE document_holds SET opened_by = '${m.qa.uid}' WHERE id = '${id}'`)).toMatchObject({ ok: false, code: "42501" });
        expect(one(`SELECT opened_by::text FROM document_holds WHERE id = '${id}'`)).toBe(m.admin.uid);
        // REGRESSION: the same columns written unchanged, and the notes, still move on a recorded hold
        expect(asCaller(db, m.admin.caller, `UPDATE document_holds SET opened_by = opened_by, opened_by_name = opened_by_name, notes = 'p25 reattr' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
        // REGRESSION: a hold without a record is not looked at by this guard (20261073's own guard decides, as before)
        expect(asCaller(db, SERVICE, `UPDATE document_holds SET opened_by_name = 'Renamed' WHERE id = '${plain}'`)).toEqual({ ok: true, rows: 1 });
      } finally {
        admin(db, "ALTER TABLE document_holds ENABLE TRIGGER trg_document_hold_guard;");
      }
      // with 20261073 live the move is refused too (this guard fires first)
      expect(asCaller(db, m.admin.caller, `UPDATE document_holds SET opened_by = '${m.qa.uid}' WHERE id = '${id}'`)).toMatchObject({ ok: false });
    });
    it("the service role (a restore) may write a hold with a record in any opener's name — untouched", () => {
      expect(asCaller(db, SERVICE, `INSERT INTO document_holds (org_id, document_id, reason, notes, opened_by, examination)
                                    VALUES ('${orgId}', '${doc}', 'Other', 'p25 restored', '${m.qa.uid}', '{"note":"restored"}'::jsonb)`)).toEqual({ ok: true, rows: 1 });
    });
    it("REGRESSION: a hold placed in another uid's name WITHOUT a record is not looked at by this guard", () => {
      const r = asCaller(db, m.drafter.caller, `INSERT INTO document_holds (org_id, document_id, reason, notes, opened_by)
                                                VALUES ('${orgId}', '${doc}', 'Other', 'p25 plain-other', '${m.qa.uid}')`);
      // whatever 20261073's own guards and policy say about it is unchanged — never this guard's message
      expect(r.ok ? "" : r.message).not.toMatch(/record of what was examined/);
    });
    it("REGRESSION: a hold placed without a record lands exactly as before (examination NULL)", () => {
      expect(place(m.drafter, null, "p25 plain")).toEqual({ ok: true, rows: 1 });
      expect(one(`SELECT COALESCE(examination::text, 'NULL') FROM document_holds WHERE notes = 'p25 plain'`)).toBe("NULL");
    });
  });
});
