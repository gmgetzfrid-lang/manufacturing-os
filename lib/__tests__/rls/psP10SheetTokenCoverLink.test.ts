// public-surfaces PS-P10 SHEET TOKEN PRINT LINK — 20261240 at RUNTIME on the
// replayed database (the I-17 harness; `npm run test:db` only).
//
//   - the file pasted as ONE script, as the SQL editor sends it: on a
//     database with 20261237 but WITHOUT this file (first apply) and on the
//     replay (a re-paste) — every probe true, the counts-only inventory in
//     order, nothing else; on a database WITHOUT 20261237 it stops at its
//     floor and changes nothing;
//   - the link: written once, while the sheet is UNSETTLED (before the
//     download — the route's `link`; or with the settle), to a cover of the
//     same workspace; never on a settled sheet, never changed after (42501,
//     even for the service role); a cover row that is deleted unlinks its
//     tokens (ON DELETE SET NULL passes the guard) and the tokens stay;
//   - a controller's recall: 'recalled' is a known void reason; a void after a
//     settle is allowed and stays one-way; members and anon still can neither
//     read nor write the table.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = join(process.cwd(), "supabase", "migrations", "20261240_ps_roundG_sheet_token_cover_link.sql");
const P9 = join(process.cwd(), "supabase", "migrations", "20261237_ps_roundG_print_sheet_tokens.sql");
const hex = (n: number) => n.toString(16).padStart(64, "0");

describe.skipIf(skip !== null)("PS-P10: a pack's sheet tokens link by key to the cover's print, and a controller can recall a settled print", () => {
  let orgId = "";
  let otherOrg = "";
  let m: Record<string, SeededMember> = {};
  const lib = randomUUID();
  const doc = randomUUID();
  const ver = randomUUID();
  const pkg = randomUUID();
  const cover = randomUUID();
  const otherPkg = randomUUID();
  const otherCover = randomUUID();
  const copies: string[] = [];
  const svc = { role: "service_role" } as const;
  let seq = 5_000;
  const copy = (tag: string) => {
    const name = `mos_psp10_${tag}_${process.pid}`;
    admin("postgres", `CREATE DATABASE ${name} TEMPLATE ${REPLAY_DB}`);
    copies.push(name);
    return name;
  };
  const paste = (on: string, file = FILE) => runPsql(mosDb().conn!, on, "postgres", { sql: readFileSync(file, "utf8") });
  const insertSql = (id: string, print = randomUUID()) =>
    `INSERT INTO print_sheet_tokens (id, token_hash, print_id, org_id, document_id, version_id, minted_by) VALUES ('${id}', '${hex(seq++)}', '${print}', '${orgId}', '${doc}', '${ver}', '${m.viewer.uid}')`;
  const probesOf = (stdout: string) => stdout.split("\n").filter((l) => l.split("|").length === 3);

  beforeAll(() => {
    const s = seedOrg(db, { viewer: { role: "Viewer" }, docctrl: { role: "DocCtrl", roles: ["DocCtrl"] } });
    orgId = s.orgId;
    m = s.m;
    otherOrg = seedOrg(db, { other: { role: "Admin" } }).orgId;
    admin(db, `
      INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'P&IDs', 'documents');
      INSERT INTO documents (id, org_id, library_id, name, title, document_number, status, visibility) VALUES
        ('${doc}', '${orgId}', '${lib}', 'p201.pdf', 'Feed pump layout', 'P-${doc.slice(0, 8)}', 'Issued', 'normal');
      INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, created_by) VALUES
        ('${ver}', '${orgId}', '${doc}', 'A', 'psp10/${doc.slice(0, 8)}/a.pdf', '${m.docctrl.uid}');
      INSERT INTO work_packages (id, org_id, name, owner_user_id) VALUES
        ('${pkg}', '${orgId}', 'E-204 bundle swap', '${m.viewer.uid}'),
        ('${otherPkg}', '${otherOrg}', 'Elsewhere', '${m.viewer.uid}');
      INSERT INTO work_package_prints (id, org_id, package_id, printed_by, sheets) VALUES
        ('${cover}', '${orgId}', '${pkg}', '${m.viewer.uid}', '[{"documentId": "${doc}", "versionId": "${ver}", "printed": true}]'::jsonb),
        ('${otherCover}', '${otherOrg}', '${otherPkg}', '${m.viewer.uid}', '[]'::jsonb);`);
  });
  afterAll(() => {
    for (const c of copies) { try { admin("postgres", `DROP DATABASE IF EXISTS ${c}`); } catch { /* deleted with the cluster */ } }
  });

  it("first apply (20261237 live, this file not): ONE result set — eight probes true, then the four counts-only inventory rows in order", () => {
    const fresh = copy("fresh");
    // the database as it stood after 20261237: no link column, the 20261237 guard and CHECK
    admin(fresh, "ALTER TABLE public.print_sheet_tokens DROP COLUMN cover_print_id;");
    admin(fresh, "ALTER TABLE public.print_sheet_tokens DROP CONSTRAINT print_sheet_tokens_void_reason_known;");
    admin(fresh, "ALTER TABLE public.print_sheet_tokens ADD CONSTRAINT print_sheet_tokens_void_reason_known CHECK (void_reason IS NULL OR void_reason IN ('not_printed', 'print_aborted'));");
    const p9 = paste(fresh, P9);
    expect(p9.error).toBeNull();
    expect(admin(fresh, "SELECT prosrc LIKE '%cover_print_id%' FROM pg_proc WHERE proname = 'print_sheet_tokens_guard'")).toBe("f");
    const r = paste(fresh);
    expect(r.error).toBeNull();
    const rows = probesOf(r.stdout);
    expect(rows).toHaveLength(12);
    for (const p of rows.slice(0, 8)) {
      expect(p.split("|")[1], p).toBe("t");
      expect(p.split("|")[2], p).toBe("");
    }
    const inv = rows.slice(8).map((l) => l.split("|"));
    expect(inv.map((c) => c[1])).toEqual(["", "", "", ""]);
    expect(inv[0][0]).toMatch(/^inventory: print_sheet_tokens.cover_print_id already existed/);
    expect(inv[0][2]).toBe("0");
    for (const c of inv.slice(1)) expect(Number(c[2])).toBeGreaterThanOrEqual(0);
  });

  it("a re-paste on the replay is clean: every probe true, the inventory says it was a re-run", () => {
    const again = copy("again");
    const r = paste(again);
    expect(r.error).toBeNull();
    const rows = probesOf(r.stdout);
    expect(rows).toHaveLength(12);
    for (const p of rows.slice(0, 8)) expect(p.split("|")[1], p).toBe("t");
    expect(rows[8].split("|")[2]).toBe("1");
  });

  it("without 20261237 the paste stops at its floor and changes nothing", () => {
    const bare = copy("bare");
    admin(bare, "DROP TABLE public.print_sheet_tokens; DROP FUNCTION public.print_sheet_tokens_guard();");
    const r = paste(bare);
    expect(`${r.error ?? ""}${r.stdout}`).toMatch(/Apply 20261237_ps_roundG_print_sheet_tokens\.sql first/);
    expect(admin(bare, "SELECT to_regclass('public.print_sheet_tokens') IS NULL")).toBe("t");
  });

  it("the link is written once, while the sheet is unsettled (before the download), to a cover of the same workspace — never on a settled sheet, never changed after (42501, even for the service role)", () => {
    const id = randomUUID();
    expect(asCaller(db, svc, insertSql(id))).toEqual({ ok: true, rows: 1 });
    // not to another workspace's cover
    const foreign = asCaller(db, svc, `UPDATE print_sheet_tokens SET cover_print_id = '${otherCover}' WHERE id = '${id}'`);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe("42501");
    // review fix: on its own, before the settle (the route's `link`, awaited before the download): written
    expect(asCaller(db, svc, `UPDATE print_sheet_tokens SET cover_print_id = '${cover}' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    // the later settle keeps it
    expect(asCaller(db, svc, `UPDATE print_sheet_tokens SET settled_at = now() WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT cover_print_id = '${cover}' AND settled_at IS NOT NULL FROM print_sheet_tokens WHERE id = '${id}'`)).toBe("t");
    // with the settle in one update: still allowed (the row was unsettled)
    const both = randomUUID();
    expect(asCaller(db, svc, insertSql(both))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, svc, `UPDATE print_sheet_tokens SET settled_at = now(), cover_print_id = '${cover}' WHERE id = '${both}'`)).toEqual({ ok: true, rows: 1 });
    // never on a sheet already settled unlinked (a settled print is final)
    const late = randomUUID();
    expect(asCaller(db, svc, insertSql(late))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, svc, `UPDATE print_sheet_tokens SET settled_at = now() WHERE id = '${late}'`)).toEqual({ ok: true, rows: 1 });
    const after = asCaller(db, svc, `UPDATE print_sheet_tokens SET cover_print_id = '${cover}' WHERE id = '${late}'`);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe("42501");
    // never changed or cleared while its cover exists
    for (const set of ["cover_print_id = NULL", `cover_print_id = '${otherCover}'`]) {
      const o = asCaller(db, svc, `UPDATE print_sheet_tokens SET ${set} WHERE id = '${id}'`);
      expect(o.ok, set).toBe(false);
      if (!o.ok) expect(o.code, set).toBe("42501");
    }
    // a settle without a link (a pack with no cover) is today's settle
    const plain = randomUUID();
    expect(asCaller(db, svc, insertSql(plain))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, svc, `UPDATE print_sheet_tokens SET settled_at = now() WHERE id = '${plain}'`)).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT cover_print_id IS NULL FROM print_sheet_tokens WHERE id = '${plain}'`)).toBe("t");
  });

  it("a recall: 'recalled' is a known void reason, a void after the settle is allowed, and it is one-way; an unknown reason is still refused (23514)", () => {
    const id = randomUUID();
    expect(asCaller(db, svc, insertSql(id))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, svc, `UPDATE print_sheet_tokens SET settled_at = now(), cover_print_id = '${cover}' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    const unknown = asCaller(db, svc, `UPDATE print_sheet_tokens SET voided_at = now(), void_reason = 'expired' WHERE id = '${id}'`);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("23514");
    expect(asCaller(db, svc, `UPDATE print_sheet_tokens SET voided_at = now(), void_reason = 'recalled' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    for (const set of ["voided_at = NULL, void_reason = NULL", "void_reason = 'not_printed'"]) {
      const o = asCaller(db, svc, `UPDATE print_sheet_tokens SET ${set} WHERE id = '${id}'`);
      expect(o.ok, set).toBe(false);
      if (!o.ok) expect(o.code, set).toBe("42501");
    }
    // an unsettled print recalled: settled and voided in one update
    const live = randomUUID();
    expect(asCaller(db, svc, insertSql(live))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, svc, `UPDATE print_sheet_tokens SET voided_at = now(), void_reason = 'recalled', settled_at = now() WHERE id = '${live}'`)).toEqual({ ok: true, rows: 1 });
  });

  it("still the service role's alone: a member (any role) and anon can neither read nor write it, nor set a link (42501)", () => {
    for (const who of [m.viewer.caller, m.docctrl.caller, { role: "anon" as const }]) {
      for (const stmt of [`SELECT cover_print_id FROM print_sheet_tokens`, `UPDATE print_sheet_tokens SET voided_at = now(), void_reason = 'recalled'`, insertSql(randomUUID())]) {
        const o = asCaller(db, who, stmt);
        expect(o.ok, `${who.role}: ${stmt}`).toBe(false);
        if (!o.ok) expect(o.code).toBe("42501");
      }
    }
  });

  it("a cover row that is deleted unlinks its tokens (ON DELETE SET NULL passes the guard); the tokens stay and keep their verdict", () => {
    const on = copy("unlink");
    const id = randomUUID();
    const c2 = randomUUID();
    admin(on, `INSERT INTO work_package_prints (id, org_id, package_id, printed_by, sheets) VALUES ('${c2}', '${orgId}', '${pkg}', '${m.viewer.uid}', '[]'::jsonb)`);
    admin(on, `INSERT INTO print_sheet_tokens (id, token_hash, print_id, org_id, document_id, version_id) VALUES ('${id}', '${hex(888_888)}', '${randomUUID()}', '${orgId}', '${doc}', '${ver}')`);
    admin(on, `UPDATE print_sheet_tokens SET settled_at = now(), cover_print_id = '${c2}' WHERE id = '${id}'`);
    admin(on, `DELETE FROM work_package_prints WHERE id = '${c2}'`);
    expect(admin(on, `SELECT count(*) || ':' || bool_and(cover_print_id IS NULL) || ':' || bool_and(settled_at IS NOT NULL) FROM print_sheet_tokens WHERE id = '${id}'`)).toBe("1:true:true");
    // and the workspace's own deletion still takes everything (no guard refusal on the way)
    admin(on, `DELETE FROM orgs WHERE id = '${orgId}'`);
    expect(admin(on, `SELECT count(*) FROM print_sheet_tokens WHERE org_id = '${orgId}'`)).toBe("0");
  });
});
