// document-control F6-column-widths (REV-38 / REV-39) — 20261271 asserted at
// RUNTIME on the replayed PostgreSQL 16, in a COPY of the replay database
// (dropped afterwards: no row is left behind). Each statement runs as
// PostgREST sends it: role `authenticated` with the member's claims, `anon`,
// or `service_role` with none.
//
//   * save_library_column_widths merges PER COLUMN in one statement and
//     answers the committed map and its version; two controllers saving
//     different columns both stand (the whole-map window, closed);
//   * column_widths_rev is the server's: +1 only when column_widths changes,
//     never what a write sends, 0 on insert;
//   * refused: a member who is not a controller, a suspended controller, a
//     controller of another workspace, no session, anon, the service role, a
//     library that does not exist (the same refusal), and every bad input;
//   * the layout rail: a non-controller's direct UPDATE of column_widths,
//     custom_columns, column_label_overrides, uniqueness_keys or home_config
//     is refused; their other writes, a controller's, the service role's and
//     a write that leaves those columns as they were are decided as before;
//   * the file pastes on a database without it, and re-pastes cleanly.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type Caller, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const F = "20261271_dc_rev38_column_widths_merge.sql";
const COPY = "mos_f6_widths";
const BEFORE = "mos_f6_widths_before";
const SERVICE: Caller = { role: "service_role" };
const ANON: Caller = { role: "anon" };

function paste(db: string): { ok: boolean; error: string | null; probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", F), stopOnError: true });
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { ok: r.ok, error: r.error ?? (r.ok ? null : r.stderr), probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("20261271 — the per-column width merge, the server-owned version and the layout rail (runtime)", () => {
  let orgId = "";
  let otherOrg = "";
  let m: Record<string, SeededMember> = {};
  let stranger: SeededMember;
  const lib = randomUUID();
  const one = (sql: string) => admin(COPY, sql).trim();
  const row = () => {
    const [w, rev] = one(`SELECT column_widths::text || '|' || column_widths_rev FROM libraries WHERE id = '${lib}'`).split("|");
    return { widths: JSON.parse(w) as Record<string, number>, rev: Number(rev) };
  };
  const call = (who: Caller, set: string, reset = "ARRAY[]::text[]", id = lib) =>
    asCaller(COPY, who, `SELECT * FROM save_library_column_widths('${id}', '${set}'::jsonb, ${reset})`);
  const save = (who: SeededMember, set: string, reset = "ARRAY[]::text[]") => {
    const [w, rev] = selectAs(COPY, who.caller, `SELECT column_widths::text || '|' || column_widths_rev FROM save_library_column_widths('${lib}', '${set}'::jsonb, ${reset});`)[0].split("|");
    return { widths: JSON.parse(w) as Record<string, number>, rev: Number(rev) };
  };

  beforeAll(() => {
    admin("postgres", `DROP DATABASE IF EXISTS ${COPY}`);
    admin("postgres", `CREATE DATABASE ${COPY} TEMPLATE ${REPLAY_DB}`);
    const s = seedOrg(COPY, {
      ctrl: { role: "DocCtrl" },
      adminByCollection: { role: "Manager", roles: ["Admin"] },
      member: { role: "Engineer" },
      suspended: { role: "DocCtrl" },
    });
    orgId = s.orgId;
    m = s.m;
    const o = seedOrg(COPY, { x: { role: "Admin" } });
    otherOrg = o.orgId;
    stranger = o.m.x;
    admin(COPY, [
      `UPDATE org_members SET status = 'suspended' WHERE org_id = '${orgId}' AND uid = '${m.suspended.uid}';`,
      `INSERT INTO libraries (id, org_id, name, type, column_widths, custom_columns) VALUES ('${lib}', '${orgId}', 'Widths', 'documents', '{"title": 150, "keep": 90}'::jsonb, '[]'::jsonb);`,
    ].join("\n"));
  });
  afterAll(() => {
    for (const d of [COPY, BEFORE]) { try { admin("postgres", `DROP DATABASE IF EXISTS ${d}`); } catch { /* deleted with the cluster */ } }
  });

  it("re-pastes cleanly (DEC-30 one paste): every probe true, the inventory rows carry counts", () => {
    const r = paste(COPY);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.probes.length).toBe(7);
    expect(r.probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(r.inventory, r.inventory.join("\n")).toHaveLength(8); // seven BEFORE counts + one AFTER
    for (const l of r.inventory) expect(l).toMatch(/\|\|\d+$/);
    expect(r.inventory.some((l) => /already present .*\|\|1$/.test(l))).toBe(true);
  });

  it("pastes on a database without it (the column, functions and triggers dropped): every probe true; existing widths unchanged", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`);
    admin("postgres", `CREATE DATABASE ${BEFORE} TEMPLATE ${COPY}`);
    admin(BEFORE, `DROP TRIGGER trg_library_layout_columns ON libraries; DROP TRIGGER trg_library_column_widths_rev ON libraries;
      DROP FUNCTION save_library_column_widths(uuid, jsonb, text[]); DROP FUNCTION enforce_library_layout_columns(); DROP FUNCTION bump_library_column_widths_rev();
      ALTER TABLE libraries DROP COLUMN column_widths_rev;`);
    const r = paste(BEFORE);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(r.inventory.some((l) => /already present .*\|\|0$/.test(l))).toBe(true);
    expect(admin(BEFORE, `SELECT column_widths::text || '|' || column_widths_rev FROM libraries WHERE id = '${lib}'`).trim()).toBe('{"keep": 90, "title": 150}|0');
  });

  it("refuses to run without its base, changing nothing", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`);
    admin("postgres", `CREATE DATABASE ${BEFORE} TEMPLATE ${COPY}`);
    admin(BEFORE, "ALTER TABLE libraries DROP COLUMN home_config CASCADE;");
    const r = paste(BEFORE);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/20261271 needs libraries with column_widths/);
  });

  it("a controller's save merges PER COLUMN and answers the committed map and its version; a reset removes the key", () => {
    expect(row()).toEqual({ widths: { title: 150, keep: 90 }, rev: 0 });
    expect(save(m.ctrl, '{"title": 220}')).toEqual({ widths: { title: 220, keep: 90 }, rev: 1 });
    expect(save(m.adminByCollection, '{"rev": 80}')).toEqual({ widths: { title: 220, keep: 90, rev: 80 }, rev: 2 });
    expect(save(m.ctrl, "{}", "ARRAY['keep']")).toEqual({ widths: { title: 220, rev: 80 }, rev: 3 });
    expect(row()).toEqual({ widths: { title: 220, rev: 80 }, rev: 3 });
    expect(one(`SELECT updated_by FROM libraries WHERE id = '${lib}'`)).toBe(m.ctrl.uid);
  });

  it("two controllers saving different columns both stand — neither save carries the other column (the whole-map window is closed)", () => {
    const a = save(m.ctrl, '{"a": 111}');
    const b = save(m.adminByCollection, '{"b": 222}');
    expect(b.widths).toMatchObject({ a: 111, b: 222 });
    expect(b.rev).toBe(a.rev + 1);
  });

  it("the version is the server's: +1 only when column_widths changes; a write of another column or of the version itself leaves it; 0 on insert", () => {
    const before = row();
    expect(asCaller(COPY, SERVICE, `UPDATE libraries SET description = 'x' WHERE id = '${lib}'`)).toEqual({ ok: true, rows: 1 });
    expect(row().rev).toBe(before.rev);
    expect(asCaller(COPY, SERVICE, `UPDATE libraries SET column_widths_rev = 999 WHERE id = '${lib}'`)).toEqual({ ok: true, rows: 1 });
    expect(row().rev).toBe(before.rev);
    expect(save(m.ctrl, `{"title": ${before.widths.title}}`).rev).toBe(before.rev); // the same value: no change, no bump
    expect(asCaller(COPY, SERVICE, `UPDATE libraries SET column_widths = column_widths || '{"z": 60}'::jsonb WHERE id = '${lib}'`)).toEqual({ ok: true, rows: 1 });
    expect(row().rev).toBe(before.rev + 1);
    const fresh = randomUUID();
    admin(COPY, `INSERT INTO libraries (id, org_id, name, type, column_widths_rev) VALUES ('${fresh}', '${orgId}', 'Fresh', 'documents', 77)`);
    expect(one(`SELECT column_widths_rev FROM libraries WHERE id = '${fresh}'`)).toBe("0");
  });

  it("refused (42501), changing nothing: a member who is not a controller, a suspended controller, another workspace's controller, a library that does not exist (the same words), no session, anon, the service role", () => {
    const before = row();
    for (const who of [m.member.caller, m.suspended.caller, stranger.caller]) {
      const r = call(who, '{"title": 300}');
      expect(r).toMatchObject({ ok: false, code: "42501" });
      expect((r as { message: string }).message).toMatch(/Only an Admin or a Document Controller of this workspace can save the column widths of this library/);
    }
    expect(call(m.ctrl.caller, '{"title": 300}', "ARRAY[]::text[]", randomUUID())).toMatchObject({ ok: false, code: "42501", message: expect.stringMatching(/Only an Admin or a Document Controller/) });
    expect(() => admin(COPY, `SELECT * FROM save_library_column_widths('${lib}', '{"title": 300}'::jsonb, ARRAY[]::text[])`)).toThrow(/Sign in to save the column widths/);
    expect(call(ANON, '{"title": 300}')).toMatchObject({ ok: false, code: "42501", message: expect.stringMatching(/permission denied for function/) });
    expect(call(SERVICE, '{"title": 300}')).toMatchObject({ ok: false, code: "42501", message: expect.stringMatching(/permission denied for function/) });
    expect(row()).toEqual(before);
    expect(otherOrg).not.toBe(orgId);
  });

  it("bad input is refused in plain words (22023), changing nothing", () => {
    const before = row();
    const cases: Array<[string, string, RegExp]> = [
      ['[1, 2]', "ARRAY[]::text[]", /must be sent as column names, each with a width/],
      ['{"title": 49}', "ARRAY[]::text[]", /from 50 to 5000 pixels/],
      ['{"title": 5001}', "ARRAY[]::text[]", /from 50 to 5000 pixels/],
      ['{"title": "200"}', "ARRAY[]::text[]", /must be a number of pixels/],
      ['{"title": null}', "ARRAY[]::text[]", /must be a number of pixels/],
      ['{"": 100}', "ARRAY[]::text[]", /1 to 200 characters/],
      ["{}", "ARRAY['']", /1 to 200 characters/],
      ["{}", "ARRAY[]::text[]", /Nothing to save/],
      [`{${Array.from({ length: 501 }, (_, i) => `"c${i}": 100`).join(",")}}`, "ARRAY[]::text[]", /at most 500/],
    ];
    for (const [set, reset, words] of cases) {
      const r = call(m.ctrl.caller, set, reset);
      expect(r, set.slice(0, 40)).toMatchObject({ ok: false, code: "22023" });
      expect((r as { message: string }).message).toMatch(words);
    }
    expect(row()).toEqual(before);
  });

  it("the layout rail: a non-controller's direct UPDATE of any of the five layout columns is refused (23514)", () => {
    const sets = [
      `column_widths = '{"title": 60}'::jsonb`,
      `custom_columns = '[{"key": "x"}]'::jsonb`,
      `column_label_overrides = '{"title": "Name"}'::jsonb`,
      `uniqueness_keys = ARRAY['sheet']::text[]`,
      `home_config = '{"widgets": []}'::jsonb`,
    ];
    for (const set of sets) {
      const r = asCaller(COPY, m.member.caller, `UPDATE libraries SET ${set} WHERE id = '${lib}'`);
      expect(r, set).toMatchObject({ ok: false, code: "23514" });
      expect((r as { message: string }).message).toMatch(/Only an Admin or a Document Controller can change the columns, column labels, uniqueness rule, home layout or column widths of this library/);
    }
  });

  it("…decided as before: the member's other columns, a write leaving the layout as it was, a controller's direct write, the service role", () => {
    expect(asCaller(COPY, m.member.caller, `UPDATE libraries SET description = 'by a member' WHERE id = '${lib}'`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(COPY, m.member.caller, `UPDATE libraries SET custom_columns = custom_columns, column_widths = column_widths WHERE id = '${lib}'`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(COPY, m.ctrl.caller, `UPDATE libraries SET custom_columns = '[{"key": "sheet"}]'::jsonb, uniqueness_keys = ARRAY['sheet']::text[] WHERE id = '${lib}'`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(COPY, SERVICE, `UPDATE libraries SET home_config = '{"widgets": []}'::jsonb WHERE id = '${lib}'`)).toEqual({ ok: true, rows: 1 });
    expect(one(`SELECT custom_columns::text || '|' || array_to_string(uniqueness_keys, ',') || '|' || home_config::text FROM libraries WHERE id = '${lib}'`)).toBe('[{"key": "sheet"}]|sheet|{"widgets": []}');
  });
});
