// public-surfaces PS-P9 PER-PRINT SHEET TOKEN — 20261237 at RUNTIME on the
// replayed database (the I-17 harness; `npm run test:db` only).
//
//   - the file pasted as ONE script, as the SQL editor sends it, on a
//     database WITHOUT the table (first apply) and on the replay (a re-paste):
//     every probe true, the counts-only inventory in order, nothing else;
//   - service role only: a signed-in member and anon can neither read nor
//     write print_sheet_tokens (42501); the service role inserts, reads and
//     settles;
//   - what a sheet printed never changes (the guard, 42501) — even for the
//     service role; a void is one-way, a settle is final, a void after a
//     settle is allowed (the fail-safe direction); the CHECKs hold;
//   - a deleted version takes its tokens with it (a scan then reads
//     "Unknown code", never green).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = join(process.cwd(), "supabase", "migrations", "20261237_ps_roundG_print_sheet_tokens.sql");
const hex = (n: number) => n.toString(16).padStart(64, "0");

describe.skipIf(skip !== null)("PS-P9: print_sheet_tokens is the service role's alone, and a printed sheet's facts never change", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const lib = randomUUID();
  const doc = randomUUID();
  const ver = randomUUID();
  const ver2 = randomUUID();
  const printId = randomUUID();
  const copies: string[] = [];
  const svc = { role: "service_role" } as const;
  let seq = 1;
  const copy = (tag: string) => {
    const name = `mos_psp9_${tag}_${process.pid}`;
    admin("postgres", `CREATE DATABASE ${name} TEMPLATE ${REPLAY_DB}`);
    copies.push(name);
    return name;
  };
  const paste = (on: string) => runPsql(mosDb().conn!, on, "postgres", { sql: readFileSync(FILE, "utf8") });
  const insertSql = (id: string, print = randomUUID()) =>
    `INSERT INTO print_sheet_tokens (id, token_hash, print_id, org_id, document_id, version_id, minted_by) VALUES ('${id}', '${hex(seq++)}', '${print}', '${orgId}', '${doc}', '${ver}', '${m.viewer.uid}')`;

  beforeAll(() => {
    const s = seedOrg(db, { viewer: { role: "Viewer" }, docctrl: { role: "DocCtrl", roles: ["DocCtrl"] } });
    orgId = s.orgId;
    m = s.m;
    admin(db, `
      INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'P&IDs', 'documents');
      INSERT INTO documents (id, org_id, library_id, name, title, document_number, status, visibility) VALUES
        ('${doc}', '${orgId}', '${lib}', 'p101.pdf', 'Feed pump layout', 'P-${doc.slice(0, 8)}', 'Draft', 'normal');
      INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, created_by) VALUES
        ('${ver}', '${orgId}', '${doc}', 'A', 'psp9/${doc.slice(0, 8)}/a.pdf', '${m.docctrl.uid}'),
        ('${ver2}', '${orgId}', '${doc}', 'B', 'psp9/${doc.slice(0, 8)}/b.pdf', '${m.docctrl.uid}');`);
  });
  afterAll(() => {
    for (const c of copies) { try { admin("postgres", `DROP DATABASE IF EXISTS ${c}`); } catch { /* deleted with the cluster */ } }
  });

  const probesOf = (stdout: string) => stdout.split("\n").filter((l) => l.split("|").length === 3);

  it("first apply (no table yet): ONE result set — ten probes true, then the four counts-only inventory rows in order", () => {
    const fresh = copy("fresh");
    admin(fresh, "DROP TABLE public.print_sheet_tokens; DROP FUNCTION public.print_sheet_tokens_guard();");
    const r = paste(fresh);
    expect(r.error).toBeNull();
    const rows = probesOf(r.stdout);
    expect(rows).toHaveLength(14);
    for (const p of rows.slice(0, 10)) {
      expect(p.split("|")[1], p).toBe("t");
      expect(p.split("|")[2], p).toBe("");
    }
    const inv = rows.slice(10).map((l) => l.split("|"));
    expect(inv.map((c) => c[1])).toEqual(["", "", "", ""]);
    expect(inv[0][0]).toMatch(/^inventory: print_sheet_tokens already existed/);
    expect(inv.map((c) => c[2]).slice(0, 3)).toEqual(["0", "0", "0"]);
    expect(Number(inv[3][2])).toBeGreaterThanOrEqual(0);
  });

  it("a re-paste on the replay is clean: every probe true, the inventory says it was a re-run", () => {
    const again = copy("again");
    const r = paste(again);
    expect(r.error).toBeNull();
    const rows = probesOf(r.stdout);
    expect(rows).toHaveLength(14);
    for (const p of rows.slice(0, 10)) expect(p.split("|")[1], p).toBe("t");
    expect(rows.slice(10).map((l) => l.split("|")[2]).slice(0, 3)).toEqual(["1", "1", "0"]);
  });

  it("never client-writable or client-readable: a member and anon are refused (42501); the service role writes and reads", () => {
    const id = randomUUID();
    for (const who of [m.viewer.caller, m.docctrl.caller, { role: "anon" as const }]) {
      for (const stmt of [`SELECT * FROM print_sheet_tokens`, insertSql(randomUUID()), `UPDATE print_sheet_tokens SET voided_at = now(), void_reason = 'print_aborted'`]) {
        const o = asCaller(db, who, stmt);
        expect(o.ok, `${who.role}: ${stmt}`).toBe(false);
        if (!o.ok) expect(o.code).toBe("42501");
      }
    }
    expect(asCaller(db, svc, insertSql(id))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, svc, `SELECT 1 FROM print_sheet_tokens WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
  });

  it("what a sheet printed never changes — not even for the service role; a void is one-way, a settle final; a void after a settle is allowed", () => {
    const id = randomUUID();
    expect(asCaller(db, svc, insertSql(id))).toEqual({ ok: true, rows: 1 });
    for (const set of [`version_id = '${ver2}'`, `document_id = '${randomUUID()}'`, `token_hash = '${hex(999_999)}'`, `print_id = '${randomUUID()}'`, `minted_by = '${m.docctrl.uid}'`, `minted_at = now() - interval '1 day'`]) {
      const o = asCaller(db, svc, `UPDATE print_sheet_tokens SET ${set} WHERE id = '${id}'`);
      expect(o.ok, set).toBe(false);
      if (!o.ok) expect(o.code, set).toBe("42501");
    }
    // settle, then a void after the settle (the fail-safe direction) is allowed
    expect(asCaller(db, svc, `UPDATE print_sheet_tokens SET settled_at = now() WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    const unsettle = asCaller(db, svc, `UPDATE print_sheet_tokens SET settled_at = NULL WHERE id = '${id}'`);
    expect(unsettle.ok).toBe(false);
    expect(asCaller(db, svc, `UPDATE print_sheet_tokens SET voided_at = now(), void_reason = 'not_printed' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    for (const set of ["voided_at = NULL, void_reason = NULL", "void_reason = 'print_aborted'"]) {
      const o = asCaller(db, svc, `UPDATE print_sheet_tokens SET ${set} WHERE id = '${id}'`);
      expect(o.ok, set).toBe(false);
      if (!o.ok) expect(o.code, set).toBe("42501");
    }
  });

  it("the CHECKs hold: a hex SHA-256 only, a known void reason, a void always with its reason, one sheet per document per print", () => {
    const bad = asCaller(db, svc, `INSERT INTO print_sheet_tokens (token_hash, print_id, org_id, document_id, version_id) VALUES ('the-token-itself', '${randomUUID()}', '${orgId}', '${doc}', '${ver}')`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("23514");
    const id = randomUUID();
    expect(asCaller(db, svc, insertSql(id, printId))).toEqual({ ok: true, rows: 1 });
    // ('recalled' became a known reason at 20261240 — PS-P10's controller
    // recall — and the replay carries it; an unknown reason is still refused.)
    for (const set of ["voided_at = now(), void_reason = 'expired'", "voided_at = now()", "void_reason = 'not_printed'"]) {
      const o = asCaller(db, svc, `UPDATE print_sheet_tokens SET ${set} WHERE id = '${id}'`);
      expect(o.ok, set).toBe(false);
      if (!o.ok) expect(o.code, set).toBe("23514");
    }
    const dup = asCaller(db, svc, `INSERT INTO print_sheet_tokens (token_hash, print_id, org_id, document_id, version_id) VALUES ('${hex(seq++)}', '${printId}', '${orgId}', '${doc}', '${ver}')`);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("23505");
  });

  it("a deleted version takes its tokens with it (the scan then reads Unknown code, never green)", () => {
    const on = copy("cascade");
    const id = randomUUID();
    const p2 = randomUUID();
    admin(on, `INSERT INTO print_sheet_tokens (id, token_hash, print_id, org_id, document_id, version_id) VALUES ('${id}', '${hex(777_777)}', '${p2}', '${orgId}', '${doc}', '${ver2}')`);
    admin(on, `DELETE FROM document_versions WHERE id = '${ver2}'`);
    expect(admin(on, `SELECT count(*) FROM print_sheet_tokens WHERE id = '${id}'`)).toBe("0");
  });
});
