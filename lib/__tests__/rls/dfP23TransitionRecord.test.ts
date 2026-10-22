// drafting-flow Round G, DF-P23 TRANSITION RECORD AND RECONCILE — 20261265
// asserted at RUNTIME on the replayed PostgreSQL 16 (each statement as
// PostgREST sends it: role `authenticated` with the member's claims, or
// `service_role` with none — how /api/tickets/equipment and the create /
// workflow routes write).
//
//   intelligence GAP-312 follow-up: ticket_equipment's unique (ticket_id,
//   tag key) index refuses a second entry of one tag on one request (the
//   race the route's check cannot close), with the route's own key —
//   "E-22" / "E22" / "e 22" are one tag, two different tags stay two; a
//   respelling replaces its entry in one transaction (service role only);
//   while duplicates exist the paste REFUSES, changing nothing and deleting
//   nothing, and names the count.
//   intelligence WIRE-7 criterion 1: tickets.unit_code is derived from the
//   unit — a Site Codebook unit code or NULL, never a value a client writes —
//   and the paste fills the live requests once.
//   REGRESSION: a member's own permitted write (priority) still lands; a
//   request with no codebook unit keeps its unit and gets NULL.
//   DF-P23 merge-time fix pass: a request restored from the archive (or one
//   whose unit the codebook gained since) gets its unit_code on its next
//   write; the integrity trigger lets a tag be respelled in place within its
//   key (the equipment route's fallback while PostgREST cannot yet see
//   replace_ticket_equipment) and still refuses every other rewrite.

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";
import { tagKey } from "@/lib/codebook";
import { equipmentListingKey } from "@/lib/ticketEquipment";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const F265 = "20261265_df_roundG_transition_record.sql";

function paste(f: string): { ok: boolean; error: string; probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { ok: r.ok, error: `${r.error ?? ""} ${r.stderr ?? ""}`, probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("DF-P23 — 20261265: the equipment tag index and tickets.unit_code (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const ticket = (unit: string | null = null, archived = false) => {
    const id = randomUUID();
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, unit, history, last_modified${archived ? ", archived_at" : ""})
               VALUES ('${id}', '${orgId}', 'KE-P23-${id.slice(0, 6)}', 'Isometric', 'Revision', 'DRAFTING', '${m.requester.uid}', ${unit === null ? "NULL" : `'${unit}'`}, '[]'::jsonb, '2026-10-20T10:00:00Z'${archived ? ", now()" : ""})`);
    return id;
  };
  const equip = (t: string, tag: string) =>
    asCaller(db, SERVICE, `INSERT INTO ticket_equipment (org_id, ticket_id, tag, created_by) VALUES ('${orgId}', '${t}', '${tag}', '${m.requester.uid}')`);
  const unitCodeOf = (t: string) => admin(db, `SELECT COALESCE(unit_code, '<null>') FROM tickets WHERE id = '${t}'`);

  beforeAll(() => {
    const s = seedOrg(db, { requester: { role: "Viewer" }, manager: { role: "Manager" } });
    orgId = s.orgId;
    m = s.m;
    admin(db, `INSERT INTO codebook_entries (org_id, kind, code, label) VALUES ('${orgId}', 'unit', '20', 'Crude unit'), ('${orgId}', 'unit', '30', 'Utilities')`);
  });

  it("re-pastes cleanly (DEC-30 one paste); every probe answers true (eight); six inventory rows and one after-row carry counts", () => {
    for (let i = 0; i < 2; i++) {
      const r = paste(F265);
      expect(r.ok, r.error).toBe(true);
      expect(r.probes.length).toBe(8);
      expect(r.probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
      expect(r.inventory.length).toBe(7);
    }
  });

  it("GAP-312: a second entry of one tag on one request is refused (23505), by the route's key; two tags, or one tag on two requests, both land", () => {
    const t = ticket();
    const t2 = ticket();
    expect(equip(t, "E-22")).toEqual({ ok: true, rows: 1 });
    for (const spelling of ["E-22", "E22", "e 22", " e-22 "]) {
      const dup = equip(t, spelling);
      expect(dup.ok, spelling).toBe(false);
      if (!dup.ok) expect(dup.code).toBe("23505");
    }
    expect(equip(t, "E-22A")).toEqual({ ok: true, rows: 1 });
    expect(equip(t, "P-101")).toEqual({ ok: true, rows: 1 });
    expect(equip(t2, "E-22")).toEqual({ ok: true, rows: 1 });
    // two tags with nothing in a-z0-9 stay two (the route falls back to the trimmed lowercase tag)
    expect(equip(t, "Насос")).toEqual({ ok: true, rows: 1 });
    expect(equip(t, "Клапан")).toEqual({ ok: true, rows: 1 });
  });

  it("GAP-312: ticket_equipment_tag_key is the route's key (lib/ticketEquipment.ts equipmentListingKey) on every awkward input — exactly, where the collation lowercases every script; never stricter, where it lowercases only ASCII", () => {
    const inputs = ["E-22", "E22", "e 22", " E-22 ", "E–22", "E\u00a022", "P-101A", "NORTH-FURNACE", "northfurnace", "the north furnace",
      "Насос", " насос ", "Клапан", "Насос-1", "Компрессор-1", "НАСОС-1", "ΟΔΟΣ", "οδος", "οδοσ", "İ1", "I1", "---", "a.b/c", "Tank 7 (east)", "😀1"];
    const js = (t: string) => equipmentListingKey(t);
    // the ASCII key is the registry's grammar (tagKey) as before
    for (const t of inputs.filter((x) => /^[\x00-\x7f]*$/.test(x))) expect(js(t), t).toBe(tagKey(t) || t.trim().toLowerCase());
    const keysUnder = (coll: string | null) => new Map(inputs.map((t) =>
      [t, admin(db, `SELECT ticket_equipment_tag_key($q$${t}$q$${coll ? ` COLLATE "${coll}"` : ""})`)] as const));
    const neverStricter = (sql: Map<string, string>, label: string) => {
      for (const a of inputs) for (const b of inputs) if (sql.get(a) === sql.get(b)) expect(js(a), `${label}: ${a} / ${b}`).toBe(js(b));
    };
    // this scratch cluster's default collation (C: lower() folds ASCII only) — ASCII and the stripped
    // dashes / spaces exactly; "Насос" and "насос" kept apart, which the route's check still catches
    const dflt = keysUnder(null);
    for (const t of inputs.filter((x) => /^[\x00-\x7f–\u00a0]*$/.test(x))) expect(dflt.get(t), t).toBe(js(t));
    neverStricter(dflt, "default");
    // a collation that lowercases every script (libc C.UTF-8, ICU — a Supabase database's kind): exactly the route's key
    const have = admin(db, `SELECT string_agg(collname, ',') FROM pg_collation WHERE collname IN ('C.utf8', 'C.UTF-8', 'und-x-icu', 'en_US.utf8')`).split(",").filter(Boolean);
    for (const coll of have) {
      const sql = keysUnder(coll);
      for (const t of inputs) expect(sql.get(t), `${coll}: ${t}`).toBe(js(t));
      neverStricter(sql, coll);
    }
  });

  it("GAP-312: a respelling replaces its entry in ONE transaction (service role only); an entry not on the request changes nothing", () => {
    const t = ticket();
    expect(equip(t, "e22")).toEqual({ ok: true, rows: 1 });
    const oldId = admin(db, `SELECT id FROM ticket_equipment WHERE ticket_id = '${t}'`);
    const call = `SELECT replace_ticket_equipment('${oldId}', '${t}', '${orgId}', 'E-22', NULL, '${m.requester.uid}')`;
    const member = asCaller(db, m.manager.caller, call);
    expect(member.ok).toBe(false);
    if (!member.ok) expect(member.code).toBe("42501");
    expect(asCaller(db, SERVICE, call).ok).toBe(true);
    expect(admin(db, `SELECT string_agg(tag, ',') FROM ticket_equipment WHERE ticket_id = '${t}'`)).toBe("E-22");
    // DF-P23 fix pass: a case-only correction of a non-Latin tag is a respelling too
    expect(equip(t, "насос")).toEqual({ ok: true, rows: 1 });
    const cyr = admin(db, `SELECT id FROM ticket_equipment WHERE ticket_id = '${t}' AND tag = 'насос'`);
    expect(asCaller(db, SERVICE, `SELECT replace_ticket_equipment('${cyr}', '${t}', '${orgId}', 'Насос', NULL, '${m.requester.uid}')`).ok).toBe(true);
    expect(admin(db, `SELECT string_agg(tag, ',' ORDER BY tag) FROM ticket_equipment WHERE ticket_id = '${t}'`)).toBe("E-22,Насос");
    admin(db, `DELETE FROM ticket_equipment WHERE ticket_id = '${t}' AND tag = 'Насос'`);
    // two non-Latin tags that share their ASCII remainder are two tags (tagKey alone read both as "1")
    expect(equip(t, "Насос-1")).toEqual({ ok: true, rows: 1 });
    expect(equip(t, "Компрессор-1")).toEqual({ ok: true, rows: 1 });
    admin(db, `DELETE FROM ticket_equipment WHERE ticket_id = '${t}' AND tag IN ('Насос-1', 'Компрессор-1')`);
    const missing = asCaller(db, SERVICE, `SELECT replace_ticket_equipment('${randomUUID()}', '${t}', '${orgId}', 'E-23', NULL, NULL)`);
    expect(missing.ok).toBe(false);
    expect(admin(db, `SELECT string_agg(tag, ',') FROM ticket_equipment WHERE ticket_id = '${t}'`)).toBe("E-22");
  });

  it("GAP-312: while a tag is listed twice the paste REFUSES — nothing changed, nothing deleted, the count named; removed by a person, it pastes", () => {
    admin(db, `DROP INDEX IF EXISTS ticket_equipment_ticket_tag_key_uniq`);
    const t = ticket();
    expect(equip(t, "E-22")).toEqual({ ok: true, rows: 1 });
    expect(equip(t, "E22")).toEqual({ ok: true, rows: 1 });
    const before = admin(db, `SELECT COUNT(*) FROM ticket_equipment`);
    const r = paste(F265);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/20261265 REFUSED: 1 tag\(s\) are listed more than once/);
    expect(admin(db, `SELECT COUNT(*) FROM ticket_equipment`)).toBe(before);
    expect(admin(db, `SELECT COUNT(*) FROM pg_class WHERE relname = 'ticket_equipment_ticket_tag_key_uniq'`)).toBe("0");
    admin(db, `DELETE FROM ticket_equipment WHERE ticket_id = '${t}' AND tag = 'E22'`);
    const again = paste(F265);
    expect(again.ok, again.error).toBe(true);
    expect(again.probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
  });

  it("WIRE-7: unit_code is the codebook unit the unit names, else NULL — on insert and on a unit change; a client cannot write another value", () => {
    const coded = ticket("20");
    const free = ticket("Tank farm");
    const none = ticket(null);
    expect(unitCodeOf(coded)).toBe("20");
    expect(unitCodeOf(free)).toBe("<null>");
    expect(unitCodeOf(none)).toBe("<null>");
    // triage sets the unit through the service role
    expect(asCaller(db, SERVICE, `UPDATE tickets SET unit = '30' WHERE id = '${free}'`)).toEqual({ ok: true, rows: 1 });
    expect(unitCodeOf(free)).toBe("30");
    expect(asCaller(db, SERVICE, `UPDATE tickets SET unit = 'Unknown' WHERE id = '${free}'`)).toEqual({ ok: true, rows: 1 });
    expect(unitCodeOf(free)).toBe("<null>");
    // a forged value is replaced by the derived one, for every writer
    expect(asCaller(db, SERVICE, `UPDATE tickets SET unit_code = '99' WHERE id = '${coded}'`)).toEqual({ ok: true, rows: 1 });
    expect(unitCodeOf(coded)).toBe("20");
    asCaller(db, m.manager.caller, `UPDATE tickets SET unit_code = '99' WHERE id = '${coded}'`);
    expect(unitCodeOf(coded)).toBe("20");
    // REGRESSION: a member's permitted write still lands, and leaves unit_code as it was
    expect(asCaller(db, m.manager.caller, `UPDATE tickets SET priority = 1 WHERE id = '${coded}'`).ok).toBe(true);
    expect(unitCodeOf(coded)).toBe("20");
    expect(admin(db, `SELECT unit FROM tickets WHERE id = '${coded}'`)).toBe("20");
  });

  it("GAP-312 (DF-P23 merge-time fix pass): a tag respelled in place within its key passes the integrity trigger (same row, same id); another key, another column, a member — refused", () => {
    const t = ticket();
    expect(equip(t, "e22")).toEqual({ ok: true, rows: 1 });
    const id = admin(db, `SELECT id FROM ticket_equipment WHERE ticket_id = '${t}'`);
    // the equipment route's fallback: one UPDATE by row id, as read, service role
    expect(asCaller(db, SERVICE, `UPDATE ticket_equipment SET tag = 'E-22', asset_id = NULL WHERE id = '${id}' AND ticket_id = '${t}' AND org_id = '${orgId}' AND tag = 'e22'`)).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT id || ':' || tag FROM ticket_equipment WHERE ticket_id = '${t}'`)).toBe(`${id}:E-22`);
    // a Cyrillic case-only respelling: the trigger decides by the index's own key — within it where
    // the column's collation lowercases Cyrillic (a Supabase database); under this scratch cluster's C
    // collation the two keys differ, so it is refused exactly where the index lets both spellings stand
    expect(equip(t, "насос")).toEqual({ ok: true, rows: 1 });
    const sameKey = admin(db, `SELECT (ticket_equipment_tag_key('насос') = ticket_equipment_tag_key('Насос'))::text`) === "true";
    const cyr = asCaller(db, SERVICE, `UPDATE ticket_equipment SET tag = 'Насос' WHERE ticket_id = '${t}' AND tag = 'насос'`);
    expect(cyr.ok).toBe(sameKey);
    if (!sameKey) admin(db, `DELETE FROM ticket_equipment WHERE ticket_id = '${t}' AND tag = 'насос'`);
    if (!sameKey) expect(equip(t, "Насос")).toEqual({ ok: true, rows: 1 });
    // still refused: a tag rewritten to another key, the request or the creator changed
    for (const set of ["tag = 'P-1'", `ticket_id = '${ticket()}'`, "created_by = NULL"]) {
      const r = asCaller(db, SERVICE, `UPDATE ticket_equipment SET ${set} WHERE id = '${id}'`);
      expect(r.ok, set).toBe(false);
      if (!r.ok) expect(r.message, set).toMatch(/a recorded tag is not rewritten/);
    }
    // a member has no write at all
    expect(asCaller(db, m.manager.caller, `UPDATE ticket_equipment SET tag = 'E 22' WHERE id = '${id}'`)).not.toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT string_agg(tag, ',' ORDER BY tag) FROM ticket_equipment WHERE ticket_id = '${t}'`)).toBe("E-22,Насос");
    admin(db, `DELETE FROM ticket_equipment WHERE ticket_id = '${t}'`);
  });

  it("WIRE-7 (DF-P23 merge-time fix pass): a request restored from the archive gets its unit_code; a NULL code with a codebook unit is derived on the next write; REGRESSION: a member's write on a free-text unit still lands", () => {
    const archived = ticket("20", true);
    // archived before the paste: no code on record (the paste fills live requests only)
    admin(db, `ALTER TABLE tickets DISABLE TRIGGER trg_ticket_unit_code`);
    admin(db, `UPDATE tickets SET unit_code = NULL WHERE id = '${archived}'`);
    admin(db, `ALTER TABLE tickets ENABLE TRIGGER trg_ticket_unit_code`);
    expect(unitCodeOf(archived)).toBe("<null>");
    // restored from the archive (the service role clears archived_at)
    expect(asCaller(db, SERVICE, `UPDATE tickets SET archived_at = NULL WHERE id = '${archived}'`)).toEqual({ ok: true, rows: 1 });
    expect(unitCodeOf(archived)).toBe("20");
    expect(admin(db, `SELECT unit FROM tickets WHERE id = '${archived}'`)).toBe("20");
    // a unit the codebook gains after filing: coded on the request's next write, whatever it changes
    const later = ticket("40");
    expect(unitCodeOf(later)).toBe("<null>");
    admin(db, `INSERT INTO codebook_entries (org_id, kind, code, label) VALUES ('${orgId}', 'unit', '40', 'Flare')`);
    expect(asCaller(db, SERVICE, `UPDATE tickets SET priority = 2 WHERE id = '${later}'`)).toEqual({ ok: true, rows: 1 });
    expect(unitCodeOf(later)).toBe("40");
    // REGRESSION: a member's own permitted write on a request whose unit the codebook does not hold
    // (the derive now reads the codebook as that member) still lands, unit_code still NULL
    const free = ticket("Tank farm");
    expect(asCaller(db, m.manager.caller, `UPDATE tickets SET priority = 1 WHERE id = '${free}'`)).toEqual({ ok: true, rows: 1 });
    expect(unitCodeOf(free)).toBe("<null>");
    expect(admin(db, `SELECT priority::text FROM tickets WHERE id = '${free}'`)).toBe("1");
    admin(db, `DELETE FROM codebook_entries WHERE org_id = '${orgId}' AND code = '40'`);
  });

  it("WIRE-7: the paste fills a live request's unit_code once; an archived request is left alone; a re-paste writes nothing new", () => {
    const live = ticket("20");
    const archived = ticket("20", true);
    // as a database before 20261265 had them: no code on record
    admin(db, `ALTER TABLE tickets DISABLE TRIGGER trg_ticket_unit_code`);
    admin(db, `UPDATE tickets SET unit_code = NULL WHERE id IN ('${live}', '${archived}')`);
    admin(db, `ALTER TABLE tickets ENABLE TRIGGER trg_ticket_unit_code`);
    expect(unitCodeOf(live)).toBe("<null>");
    const r = paste(F265);
    expect(r.ok, r.error).toBe(true);
    expect(unitCodeOf(live)).toBe("20");
    expect(unitCodeOf(archived)).toBe("<null>");
    const lm = admin(db, `SELECT last_modified FROM tickets WHERE id = '${live}'`);
    expect(paste(F265).ok).toBe(true);
    expect(admin(db, `SELECT last_modified FROM tickets WHERE id = '${live}'`)).toBe(lm);
  });
});
