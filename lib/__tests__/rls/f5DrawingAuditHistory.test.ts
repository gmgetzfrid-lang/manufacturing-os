// drafting-flow Round G, F5 DRAWING AUDIT HISTORY — 20261270 asserted at
// RUNTIME on the replayed PostgreSQL 16 (each statement as PostgREST sends
// it: role `service_role` for the two server writers, role `authenticated`
// with the member's claims for a person).
//
//   Reproduced on the base (the replay's snapshot taken just before
//   20261270, CHECKPOINTS): a same-severity re-record of a (library, sheet,
//   revision) replaces the stored findings in place and nothing keeps them;
//   a write naming `source` is refused 42703 and writes nothing — the
//   writers' fallback (lib/drawingAuditLog.ts writeWithSourceFallback) then
//   sends today's write.
//   EVID-14 done-when 1 / 4: every verdict a write replaces (or a delete
//   removes) is kept whole in drawing_audit_log_history — a same-severity
//   re-record keeps the earlier findings; a re-record that changes nothing of
//   substance (audited_at, who recorded, coverage, the run's sheet list —
//   VERDICT_BOOKKEEPING_DETAILS) keeps nothing (the F5 review ruling).
//   EVID-14 done-when 2: source — engine / orchestrator as the server names
//   them, a value outside the three refused, a signed-in session's direct
//   write stamped human whatever it claims.
//   NO REGRESSION (A/B): the same writes on the base snapshot and after the
//   paste read back the same current rows through every reader's own select.
//   The history is read by exactly drawing_audit_logs' readers and written by
//   nobody; a workspace delete takes both with it, in either cascade order.
//   The file pastes once on the base and re-pastes on the replay (DEC-30).
//   Every workspace this suite seeds is deleted at the end; copies dropped.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type Caller, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE: Caller = { role: "service_role" };
const ANON: Caller = { role: "anon" };
const F270 = "20261270_df_roundG_drawing_audit_history.sql";

function paste(on: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, on, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", F270), stopOnError: true });
  expect(r.ok, `${F270}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

interface Verdict {
  org: string;
  lib: string | null;
  sheet: string;
  rev: string;
  status: string;
  findings: string[];
  at: string;
  source?: string | null;
  doc?: string | null;
  /** More audit_details keys, as the writers send them. */
  extra?: Record<string, unknown>;
}

/** The upsert as PostgREST sends the drawing route's / the tool's write:
 *  ON CONFLICT on the 20261124 key, every column of the payload set. */
function upsert(v: Verdict): string {
  const details = JSON.stringify({ brokenConnectors: v.findings, by: "harness", ...v.extra });
  const cols = ["org_id", "library_id", "document_id", "sheet_number", "revision_code", "status", "audited_at", "audit_details", ...(v.source !== undefined ? ["source"] : [])];
  const lit = (x: string | null | undefined) => (x == null ? "NULL" : `'${x}'`);
  const vals = [lit(v.org), lit(v.lib), lit(v.doc ?? null), lit(v.sheet), lit(v.rev), lit(v.status), `'${v.at}'`, `$j$${details}$j$::jsonb`, ...(v.source !== undefined ? [lit(v.source)] : [])];
  return `INSERT INTO drawing_audit_logs (${cols.join(", ")}) VALUES (${vals.join(", ")})
          ON CONFLICT (org_id, library_id, sheet_number, revision_code)
          DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`;
}

describe.skipIf(skip !== null)("F5 / EVID-14 — every replaced drawing audit verdict is kept, and each says who produced it (runtime)", () => {
  const copies: string[] = [];
  const orgs: Array<{ on: string; id: string }> = [];
  const people: Array<{ on: string; uid: string }> = [];
  const copyOf = (template: string, tag: string) => {
    const name = `mos_f5_${tag}_${process.pid}`;
    admin("postgres", `DROP DATABASE IF EXISTS ${name}`);
    admin("postgres", `CREATE DATABASE ${name} TEMPLATE ${template}`);
    copies.push(name);
    return name;
  };
  const seed = (on: string, members: Parameters<typeof seedOrg>[1]) => {
    const s = seedOrg(on, members);
    orgs.push({ on, id: s.orgId });
    for (const p of Object.values(s.m)) people.push({ on, uid: p.uid });
    return s;
  };
  const one = (on: string, sql: string) => admin(on, sql).trim();
  let base = "";
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const lib = randomUUID();

  beforeAll(() => {
    base = copyOf(mosDb().report!.checkpoints["20261270"], "base");
    const s = seed(db, { controller: { role: "Admin", roles: ["Admin"] }, viewer: { role: "Viewer" } });
    orgId = s.orgId;
    m = s.m;
  });

  afterAll(() => {
    for (const o of orgs) { try { admin(o.on, `DELETE FROM orgs WHERE id = '${o.id}'`); } catch { /* the copy is dropped below */ } }
    for (const p of people) {
      try { admin(p.on, `DELETE FROM users WHERE id = '${p.uid}'; DELETE FROM auth.users WHERE id = '${p.uid}';`); } catch { /* the copy is dropped below */ }
    }
    for (const c of copies) { try { admin("postgres", `DROP DATABASE IF EXISTS ${c}`); } catch { /* deleted with the cluster */ } }
  });

  it("reproduced on the base: a same-severity re-record replaces the stored findings and nothing keeps them; a write naming source is refused 42703 and writes nothing", () => {
    const o = seed(base, { a: { role: "Admin" } }).orgId;
    const k = { org: o, lib, sheet: "P-101-02", rev: "C" };
    expect(asCaller(base, SERVICE, upsert({ ...k, status: "broken_connectors", findings: ["OPC-7 leads nowhere"], at: "2026-11-01T00:00:00Z" }))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(base, SERVICE, upsert({ ...k, status: "broken_connectors", findings: ["OPC-9 one-way"], at: "2026-11-02T00:00:00Z" }))).toEqual({ ok: true, rows: 1 });
    expect(one(base, `SELECT audit_details ->> 'brokenConnectors' FROM drawing_audit_logs WHERE org_id = '${o}'`)).toBe('["OPC-9 one-way"]');
    expect(one(base, `SELECT count(*) FROM drawing_audit_logs WHERE org_id = '${o}'`)).toBe("1");
    expect(one(base, `SELECT to_regclass('public.drawing_audit_log_history') IS NULL`)).toBe("t");
    // the writers' first try names source: refused, nothing written
    const r = asCaller(base, SERVICE, upsert({ ...k, status: "flagged", findings: ["x"], at: "2026-11-03T00:00:00Z", source: "engine" }));
    expect(r).toMatchObject({ ok: false, code: "42703" });
    expect(one(base, `SELECT status || '|' || (audit_details ->> 'brokenConnectors') FROM drawing_audit_logs WHERE org_id = '${o}'`)).toBe('broken_connectors|["OPC-9 one-way"]');
  });

  it("the file pastes once on the base and re-pastes on the replay (DEC-30); every probe true; the inventory rows carry counts", () => {
    const first = paste(copyOf(mosDb().report!.checkpoints["20261270"], "first"));
    const again = paste(db);
    for (const p of [first, again]) {
      expect(p.probes.length).toBe(8);
      expect(p.probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
      expect(p.inventory.length).toBe(6); // five BEFORE counts + one AFTER count
      for (const l of p.inventory) expect(l).toMatch(/\|\|\d+$/);
    }
  });

  it("done-when 4: a same-severity re-record keeps the earlier verdict and its findings (history row, whole); the current row is the new one", () => {
    const k = { org: orgId, lib, sheet: "P-101-02", rev: "C" };
    expect(asCaller(db, SERVICE, upsert({ ...k, status: "broken_connectors", findings: ["OPC-7 leads nowhere"], at: "2026-11-01T00:00:00Z", source: "engine" }))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, upsert({ ...k, status: "broken_connectors", findings: ["OPC-9 one-way"], at: "2026-11-02T00:00:00Z", source: "engine" }))).toEqual({ ok: true, rows: 1 });
    expect(one(db, `SELECT count(*) || '|' || string_agg(status || '|' || (audit_details ->> 'brokenConnectors') || '|' || source, ',') FROM drawing_audit_logs WHERE org_id = '${orgId}' AND sheet_number = 'P-101-02'`))
      .toBe('1|broken_connectors|["OPC-9 one-way"]|engine');
    const h = one(db, `SELECT count(*) || '|' || string_agg(concat_ws('|', change, status, audit_details ->> 'brokenConnectors', source, to_char(audited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), replaced_by_status, replaced_by_source, (library_id = '${lib}')::text, coalesce(changed_by::text, 'null')), ',')
                        FROM drawing_audit_log_history WHERE org_id = '${orgId}' AND sheet_number = 'P-101-02'`);
    expect(h).toBe('1|replaced|broken_connectors|["OPC-7 leads nowhere"]|engine|2026-11-01|broken_connectors|engine|true|null');
    // a raise (flagged → broken_connectors) keeps the flagged verdict too
    const k2 = { org: orgId, lib, sheet: "P-101-03", rev: "A" };
    asCaller(db, SERVICE, upsert({ ...k2, status: "flagged", findings: ["unread page 2"], at: "2026-11-01T00:00:00Z", source: "engine" }));
    asCaller(db, SERVICE, upsert({ ...k2, status: "broken_connectors", findings: ["OPC-1"], at: "2026-11-02T00:00:00Z", source: "orchestrator" }));
    expect(one(db, `SELECT status || '|' || (audit_details ->> 'brokenConnectors') || '|' || replaced_by_source FROM drawing_audit_log_history WHERE org_id = '${orgId}' AND sheet_number = 'P-101-03'`))
      .toBe('flagged|["unread page 2"]|orchestrator');
  });

  // The F5 review ruling: a history row only for a change of substance.
  describe("what counts as a change: only the verdict, never its timestamp or bookkeeping", () => {
    const sheetN = (() => { let n = 0; return () => `P-400-${String(++n).padStart(2, "0")}`; })();
    const kept = (sheet: string) => one(db, `SELECT count(*) FROM drawing_audit_log_history WHERE org_id = '${orgId}' AND sheet_number = '${sheet}'`);
    // a row as the route writes it: findings, scope, coverage, the run's sheet list on its first row
    const routeRow = (sheet: string, over: Partial<Verdict> = {}): Verdict => ({
      org: orgId, lib, sheet, rev: "C", status: "flagged", findings: ["OPC-3 unpaired"], at: "2026-11-01T00:00:00Z", source: "engine",
      extra: {
        missingReferences: [], knowledgeDocumentId: "k-1", libraryId: lib,
        set: { count: 3, digest: "61fc8843", truncated: false, seriesNotJudged: ["030-PID"], sheets: ["A", "B", "C"] },
        coverage: { "k-1": "7de1b6c1+a141618a" },
      },
      ...over,
    });

    it("an identical re-record — new audited_at, another recorder, a new coverage fingerprint, no sheet list on this run — keeps no history row; the current row takes the new audited_at", () => {
      const sheet = sheetN();
      const first = routeRow(sheet);
      expect(asCaller(db, SERVICE, upsert(first))).toEqual({ ok: true, rows: 1 });
      const again = routeRow(sheet, {
        at: "2026-11-09T00:00:00Z",
        extra: { ...first.extra, by: "someone-else", byName: "Someone Else", coverage: { "k-1": "0000aaaa+a141618a" }, set: { count: 3, digest: "61fc8843", truncated: false, seriesNotJudged: ["030-PID"] } },
      });
      expect(asCaller(db, SERVICE, upsert(again))).toEqual({ ok: true, rows: 1 });
      expect(asCaller(db, SERVICE, upsert(again))).toEqual({ ok: true, rows: 1 }); // and byte-identical
      expect(kept(sheet)).toBe("0");
      expect(one(db, `SELECT to_char(audited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM drawing_audit_logs WHERE org_id = '${orgId}' AND sheet_number = '${sheet}'`)).toBe("2026-11-09");
    });

    it("a provisional row written again with nothing new (the route's still-waiting rewrite) keeps none", () => {
      const sheet = sheetN();
      const waiting = { provisional: { waitingOn: ["030-PID-0201.pdf (page(s) 2 never read)"], settledStatus: "passed" }, waitingFindings: { brokenConnectors: [0] } };
      const v = routeRow(sheet, { extra: { ...routeRow(sheet).extra, ...waiting } });
      asCaller(db, SERVICE, upsert(v));
      for (const at of ["2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z"]) asCaller(db, SERVICE, upsert({ ...v, at }));
      expect(kept(sheet)).toBe("0");
      // …and once it settles (marker dropped), the provisional verdict is kept
      asCaller(db, SERVICE, upsert({ ...v, at: "2026-11-04T00:00:00Z", extra: routeRow(sheet).extra }));
      expect(one(db, `SELECT count(*) || '|' || string_agg(audit_details #>> '{provisional,settledStatus}', ',') FROM drawing_audit_log_history WHERE org_id = '${orgId}' AND sheet_number = '${sheet}'`)).toBe("1|passed");
    });

    it("changed findings → one row; a status change → one row; a source change → one row; a note → one row; a changed scope (seriesNotJudged) → one row", () => {
      const sheet = sheetN();
      const base = routeRow(sheet);
      asCaller(db, SERVICE, upsert(base));
      const steps: Array<[string, Verdict]> = [
        ["findings", { ...base, findings: ["OPC-3 unpaired", "OPC-4 one-way"], at: "2026-11-02T00:00:00Z" }],
        ["status", { ...base, findings: ["OPC-3 unpaired", "OPC-4 one-way"], status: "broken_connectors", at: "2026-11-03T00:00:00Z" }],
        ["source", { ...base, findings: ["OPC-3 unpaired", "OPC-4 one-way"], status: "broken_connectors", source: "orchestrator", at: "2026-11-04T00:00:00Z" }],
        ["note", { ...base, findings: ["OPC-3 unpaired", "OPC-4 one-way"], status: "broken_connectors", source: "orchestrator", at: "2026-11-05T00:00:00Z", extra: { ...base.extra, note: "confirmed on the walkdown" } }],
        ["scope", { ...base, findings: ["OPC-3 unpaired", "OPC-4 one-way"], status: "broken_connectors", source: "orchestrator", at: "2026-11-06T00:00:00Z", extra: { ...base.extra, note: "confirmed on the walkdown", set: { count: 3, digest: "61fc8843", truncated: false, seriesNotJudged: [], sheets: ["A", "B", "C"] } } }],
      ];
      steps.forEach(([what, v], i) => {
        expect(asCaller(db, SERVICE, upsert(v)), what).toEqual({ ok: true, rows: 1 });
        expect(kept(sheet), what).toBe(String(i + 1));
      });
      expect(one(db, `SELECT string_agg(status || ':' || source, ',' ORDER BY audited_at) FROM drawing_audit_log_history WHERE org_id = '${orgId}' AND sheet_number = '${sheet}'`))
        .toBe("flagged:engine,flagged:engine,broken_connectors:engine,broken_connectors:orchestrator,broken_connectors:orchestrator");
    });
  });

  it("done-when 2: source — the server names engine or orchestrator; a value outside the three is refused (23514); a signed-in controller's direct write is stamped human whatever it claims", () => {
    const k = { org: orgId, lib: null, sheet: "P-200-01", rev: "D" };
    expect(asCaller(db, SERVICE, upsert({ ...k, status: "passed", findings: [], at: "2026-11-06T00:00:00Z", source: "robot" }))).toMatchObject({ ok: false, code: "23514" });
    expect(asCaller(db, SERVICE, upsert({ ...k, status: "passed", findings: [], at: "2026-11-06T00:00:00Z", source: "orchestrator" }))).toEqual({ ok: true, rows: 1 });
    expect(one(db, `SELECT source FROM drawing_audit_logs WHERE org_id = '${orgId}' AND sheet_number = 'P-200-01'`)).toBe("orchestrator");
    // the SURF-7 controller path (20261048): a person writing the row directly
    const c = m.controller;
    expect(asCaller(db, c.caller, upsert({ ...k, status: "broken_connectors", findings: ["OPC-2"], at: "2026-11-07T00:00:00Z", source: "engine" }))).toEqual({ ok: true, rows: 1 });
    expect(one(db, `SELECT status || '|' || source FROM drawing_audit_logs WHERE org_id = '${orgId}' AND sheet_number = 'P-200-01'`)).toBe("broken_connectors|human");
    expect(one(db, `SELECT status || '|' || source || '|' || replaced_by_source || '|' || changed_by FROM drawing_audit_log_history WHERE org_id = '${orgId}' AND sheet_number = 'P-200-01'`))
      .toBe(`passed|orchestrator|human|${c.uid}`);
    const ins = { org: orgId, lib: null, sheet: "P-200-02", rev: "A", status: "flagged", findings: [], at: "2026-11-07T00:00:00Z" };
    expect(asCaller(db, c.caller, upsert({ ...ins, source: "orchestrator" }))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, c.caller, `UPDATE drawing_audit_logs SET source = 'engine' WHERE org_id = '${orgId}' AND sheet_number = 'P-200-02'`)).toEqual({ ok: true, rows: 1 });
    expect(one(db, `SELECT source FROM drawing_audit_logs WHERE org_id = '${orgId}' AND sheet_number = 'P-200-02'`)).toBe("human");
    // a viewer still writes nothing (20261048 unchanged)
    expect(asCaller(db, m.viewer.caller, upsert({ ...ins, sheet: "P-200-03" })).ok).toBe(false);
  });

  it("NO REGRESSION (A/B): the same writes on the base snapshot (without source, as today) and after the paste (with source) read back the same current rows through every reader's own select", () => {
    const fixed = randomUUID();
    const seq = (withSource: boolean): Verdict[] => [
      { org: fixed, lib, sheet: "AB-1", rev: "A", status: "flagged", findings: ["p2"], at: "2026-11-01T00:00:00Z" },
      { org: fixed, lib, sheet: "AB-1", rev: "A", status: "flagged", findings: ["p3"], at: "2026-11-02T00:00:00Z" },
      { org: fixed, lib, sheet: "AB-1", rev: "A", status: "broken_connectors", findings: ["OPC-4"], at: "2026-11-03T00:00:00Z" },
      { org: fixed, lib, sheet: "AB-2", rev: "", status: "skipped", findings: [], at: "2026-11-01T00:00:00Z" },
      { org: fixed, lib, sheet: "AB-2", rev: "", status: "passed", findings: [], at: "2026-11-04T00:00:00Z" },
      { org: fixed, lib: null, sheet: "AB-1", rev: "A", status: "passed", findings: [], at: "2026-11-05T00:00:00Z" },
      { org: fixed, lib: null, sheet: "AB-1", rev: "A", status: "passed", findings: ["note"], at: "2026-11-06T00:00:00Z" },
    ].map((v) => (withSource ? { ...v, source: v.lib ? "engine" : "orchestrator" } : v));
    const readers = [
      // app/api/knowledge/drawing/route.ts readPrior (scoped, then the legacy columns)
      `SELECT sheet_number, revision_code, status, audit_details, library_id FROM drawing_audit_logs WHERE org_id = '${fixed}' AND library_id = '${lib}' ORDER BY sheet_number, revision_code`,
      `SELECT sheet_number, revision_code, status, audit_details FROM drawing_audit_logs WHERE org_id = '${fixed}' ORDER BY sheet_number, revision_code, status`,
      // lib/orchestrator/tools.ts check_audit_history and storedOrgWideVerdict
      `SELECT sheet_number, revision_code, status, audited_at, audit_details, library_id FROM drawing_audit_logs WHERE org_id = '${fixed}' AND sheet_number = 'AB-1' ORDER BY audited_at DESC LIMIT 10`,
      `SELECT status, revision_code, audit_details, library_id FROM drawing_audit_logs WHERE org_id = '${fixed}' AND sheet_number = 'AB-1' AND revision_code = 'A' AND library_id IS NULL`,
      `SELECT count(*) FROM drawing_audit_logs WHERE org_id = '${fixed}'`,
    ];
    const run = (on: string, withSource: boolean) => {
      admin(on, `INSERT INTO orgs (id, name, type) VALUES ('${fixed}', 'Harness AB', 'business')`);
      orgs.push({ on, id: fixed });
      for (const v of seq(withSource)) expect(asCaller(on, SERVICE, upsert(v))).toEqual({ ok: true, rows: 1 });
      return readers.map((q) => selectAs(on, SERVICE, q));
    };
    const before = run(base, false);
    const after = run(db, true);
    expect(after).toEqual(before);
    expect(before[4]).toEqual(["3"]);
    // …and what the paste added: the four replaced verdicts, kept
    expect(one(db, `SELECT count(*) FROM drawing_audit_log_history WHERE org_id = '${fixed}'`)).toBe("4");
  });

  it("the history is read by exactly drawing_audit_logs' readers: an active member reads both; another workspace's Admin, a suspended member and anon read neither", () => {
    const outsider = seed(db, { admin: { role: "Admin", roles: ["Admin"] } }).m.admin;
    const both = (who: Caller) => [
      selectAs(db, who, `SELECT count(*) FROM drawing_audit_logs WHERE org_id = '${orgId}'`)[0],
      selectAs(db, who, `SELECT count(*) FROM drawing_audit_log_history WHERE org_id = '${orgId}'`)[0],
    ];
    const total = one(db, `SELECT count(*) FROM drawing_audit_log_history WHERE org_id = '${orgId}'`);
    expect(Number(total)).toBeGreaterThan(0);
    expect(both(m.viewer.caller)[1]).toBe(total);
    expect(Number(both(m.viewer.caller)[0])).toBeGreaterThan(0);
    expect(both(outsider.caller)).toEqual(["0", "0"]);
    expect(both(ANON)).toEqual(["0", "0"]);
    admin(db, `UPDATE org_members SET status = 'suspended' WHERE org_id = '${orgId}' AND uid = '${m.viewer.uid}'`);
    try {
      expect(both(m.viewer.caller)).toEqual(["0", "0"]);
    } finally {
      admin(db, `UPDATE org_members SET status = 'active' WHERE org_id = '${orgId}' AND uid = '${m.viewer.uid}'`);
    }
  });

  it("nobody writes the history: a member, a controller and the service role are refused INSERT, UPDATE and DELETE", () => {
    const hid = one(db, `SELECT id FROM drawing_audit_log_history WHERE org_id = '${orgId}' LIMIT 1`);
    const ins = `INSERT INTO drawing_audit_log_history (log_id, org_id, sheet_number, revision_code, status, audited_at, change) VALUES ('${randomUUID()}', '${orgId}', 'X', 'A', 'passed', now(), 'replaced')`;
    for (const who of [m.viewer.caller, m.controller.caller, SERVICE]) {
      expect(asCaller(db, who, ins)).toMatchObject({ ok: false, code: "42501" });
      expect(asCaller(db, who, `UPDATE drawing_audit_log_history SET status = 'passed' WHERE id = '${hid}'`)).toMatchObject({ ok: false, code: "42501" });
      expect(asCaller(db, who, `DELETE FROM drawing_audit_log_history WHERE id = '${hid}'`)).toMatchObject({ ok: false, code: "42501" });
    }
    expect(one(db, `SELECT count(*) FROM drawing_audit_log_history WHERE id = '${hid}'`)).toBe("1");
  });

  it("a document delete removes its verdict (the FK cascade); the history keeps it (change deleted), naming the document", () => {
    const l = randomUUID();
    const doc = randomUUID();
    admin(db, [
      `INSERT INTO libraries (id, org_id, name, type, owner_user_id) VALUES ('${l}', '${orgId}', 'Harness P&IDs', 'documents', '${m.controller.uid}');`,
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${doc}', '${orgId}', '${l}', 'p.pdf', 'P', 'P-${doc.slice(0, 8)}', '0', 'Draft');`,
    ].join("\n"));
    expect(asCaller(db, SERVICE, upsert({ org: orgId, lib: l, doc, sheet: "P-300-01", rev: "0", status: "broken_connectors", findings: ["OPC-5"], at: "2026-11-08T00:00:00Z", source: "engine" }))).toEqual({ ok: true, rows: 1 });
    admin(db, `DELETE FROM documents WHERE id = '${doc}'`);
    expect(one(db, `SELECT count(*) FROM drawing_audit_logs WHERE org_id = '${orgId}' AND sheet_number = 'P-300-01'`)).toBe("0");
    expect(one(db, `SELECT concat_ws('|', change, status, audit_details ->> 'brokenConnectors', source, (document_id::text = '${doc}')::text, coalesce(replaced_by_status, 'null')) FROM drawing_audit_log_history WHERE org_id = '${orgId}' AND sheet_number = 'P-300-01'`))
      .toBe('deleted|broken_connectors|["OPC-5"]|engine|true|null');
  });

  it("deleting a workspace deletes its verdicts and their history with no error — and in the other cascade order (the org row already gone) the verdict delete writes no history", () => {
    const s = seed(db, { a: { role: "Admin" } }).orgId;
    for (const at of ["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"]) {
      asCaller(db, SERVICE, upsert({ org: s, lib, sheet: "W-1", rev: "A", status: "flagged", findings: [at], at, source: "engine" }));
    }
    expect(one(db, `SELECT count(*) FROM drawing_audit_log_history WHERE org_id = '${s}'`)).toBe("1");
    expect(admin(db, `SELECT harness.try_sql(${"$q$"}DELETE FROM orgs WHERE id = '${s}'${"$q$"})`)).toBe("ok:1");
    expect(one(db, `SELECT (SELECT count(*) FROM drawing_audit_logs WHERE org_id = '${s}') + (SELECT count(*) FROM drawing_audit_log_history WHERE org_id = '${s}')`)).toBe("0");
    // the order forced: the org row removed with the RI cascades off, then the
    // verdict delete runs — no history row (it would name a workspace that is gone)
    const s2 = seed(db, { a: { role: "Admin" } }).orgId;
    asCaller(db, SERVICE, upsert({ org: s2, lib, sheet: "W-2", rev: "A", status: "passed", findings: [], at: "2026-11-01T00:00:00Z", source: "engine" }));
    const sim = admin(db, `SELECT harness.try_sql(${"$q$"}DO $do$ DECLARE h int; BEGIN
      PERFORM set_config('session_replication_role', 'replica', true);
      DELETE FROM orgs WHERE id = '${s2}';
      PERFORM set_config('session_replication_role', 'origin', true);
      DELETE FROM drawing_audit_logs WHERE org_id = '${s2}';
      SELECT COUNT(*) INTO h FROM drawing_audit_log_history WHERE org_id = '${s2}';
      RAISE EXCEPTION 'simulated: history=%', h;
    END $do$${"$q$"})`);
    expect(sim).toBe("err:P0001:simulated: history=0");
  });
});
