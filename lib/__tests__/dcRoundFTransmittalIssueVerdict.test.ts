// document-control Round F wave 3 — P24 TRANSMITTAL ISSUE VERDICT (TRX-17):
// shape pins on 20261199_dc_roundF_transmittal_issue_verdict.sql.
//
//   * transmittals_guard() re-created from its NEWEST definition (20261133 —
//     the folder is scanned at test time): every line of that body kept
//     verbatim (lineDiff), and the 20261199 body is the 20261133 body plus
//     exactly six marked insertions — removing them gives the 20261133 body
//     back byte for byte.
//   * the rule: on draft → issued each item needs a server-recorded verdict
//     for the file issued (stamp_check bound to the draft's updated_at, the
//     verdict bound to the pinned version) — stampable or not_pdf — or the
//     issuer's yes (`stampAccepted`), stamped with who and when; the arming
//     mark is set from the server verdict alone; a member never writes the
//     check, a member INSERT starts it empty, and once issued it is frozen.
//   * DEC-30: counts-only inventory TEMP TABLE before BEGIN, one final
//     SELECT (check, ok, n); no SECURITY DEFINER created (DRLS-16 has
//     nothing to pin); the apply-order guard raises before 20261133.
//
// The SQL was exercised end to end on a throwaway PostgreSQL 16 cluster
// (stub schema; the real 20260717 / 20260910 / 20261133, then this file,
// pasted twice): pre-paste a DocCtrl's direct PATCH issues with no check
// (the defect); post-paste the same PATCH is refused naming the item; a
// recorded check (stampable + not_pdf) issues with the server's mark and a
// forged browser mark dropped; an unloadable / unchecked verdict is refused
// without the yes and issued with it (stampAcceptedBy = the issuer); a check
// recorded before the draft's last save, one naming another version, or a
// malformed one counts as none; a member's write of the check is refused, a
// member INSERT stores it empty, an issued row's check cannot move; an
// Engineer is refused by TRX-1 first; revoke, receipt, void, draft save,
// draft delete and the DEC-45 restore arm behave as before; on a database
// without 20261133 the file raises and changes nothing. These pins keep the
// file from drifting from what was run.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261199_dc_roundF_transmittal_issue_verdict.sql";
const m199 = read(FILE);
const numbered = readdirSync(dir).filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql")).sort();
const H = "CREATE OR REPLACE FUNCTION transmittals_guard()";

function fnBody(text: string, header: string): string {
  const a = text.indexOf(header);
  expect(a, `function not found: ${header}`).toBeGreaterThanOrEqual(0);
  return text.slice(a, text.indexOf("$$;", text.indexOf("AS $$", a) + 5) + 3);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
/** Remove the text from `from` up to (not including) `to`; both must exist once. */
function cut(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(from, a + 1), `marker not unique: ${from}`).toBe(-1);
  const b = text.indexOf(to, a + from.length);
  expect(b, `end marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(0, a) + text.slice(b);
}
const codeOnly = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

describe("20261199 — transmittals_guard re-created from its NEWEST definition (20261133), verbatim", () => {
  const definers = numbered.filter((f) => read(f).includes(H));
  const at = definers.indexOf(FILE);
  const newest = definers[at - 1];
  const base = fnBody(read(newest), H);
  const next = fnBody(m199, H);

  it("the newest definition before this file is 20261133 (the folder is scanned now), and none after it", () => {
    expect(at).toBeGreaterThan(0);
    expect(newest).toBe("20261133_dc_roundF_transmittal_rails.sql");
    expect(definers.slice(at + 1)).toEqual([]);
  });
  it("every line of the 20261133 body survives (lineDiff onlyInA is empty)", () => {
    expect(lineDiff(base, next).onlyInA).toEqual([]);
    // still invoker rights, search_path pinned (the header line is verbatim)
    expect(next).toMatch(/^CREATE OR REPLACE FUNCTION transmittals_guard\(\)\nRETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS \$\$/);
  });
  it("the body is the 20261133 body plus exactly six marked insertions — cut them and it is byte-identical", () => {
    let s = next;
    s = cut(s, "  -- 20261199 (TRX-17):\n", "BEGIN\n  -- ── TRX-2: an issued transmittal never leaves the register");
    s = cut(s, "      NEW.stamp_check := NULL;\n", "    ELSIF NEW.status = 'issued' THEN");
    s = cut(s, "    -- ── TRX-17 (20261199): the stamp check an issue relied on is frozen with it", "    -- ── TRX-6: the receipt is written once, server-side");
    s = cut(s, "\n      -- ── TRX-17 (20261199): the stamp check is the server's record", "\n      -- ── TRX-1: issuing, voiding and revoking are transmit authority");
    s = cut(s, "    -- ── TRX-17 (20261199): the server's stamp check, for the draft as issued", "    FOR it IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP\n      v_doc := NULLIF(it->>'documentId', '')::uuid;\n      IF v_doc IS NULL THEN");
    s = cut(s, "      -- ── TRX-17 (20261199): a server verdict for the file issued, or a yes", "      v_items := v_items || jsonb_build_array(");
    expect(s).toBe(base);
  });
});

describe("20261199 — the verdict rule (TRX-17)", () => {
  const next = fnBody(m199, H);
  const issueGate = next.slice(next.indexOf("  IF v_issue THEN"), next.indexOf("  -- A write that leaves the items as they were"));

  it("the check counts only when recorded on the draft as issued (draftUpdatedAt = OLD.updated_at); a malformed one counts as none", () => {
    expect(issueGate).toContain("IF TG_OP = 'UPDATE' AND jsonb_typeof(NEW.stamp_check) = 'object' AND jsonb_typeof(NEW.stamp_check->'items') = 'array' THEN");
    expect(issueGate).toContain("v_check_ok := COALESCE((NEW.stamp_check->>'draftUpdatedAt')::timestamptz = OLD.updated_at, false);");
    expect(issueGate).toMatch(/EXCEPTION WHEN others THEN\s*\n\s*v_check_ok := false;/);
  });
  it("a verdict counts only for the very version the issue pins (after `v_ver := v_current`), per document", () => {
    const pin = issueGate.indexOf("v_ver := v_current;");
    const lookup = issueGate.indexOf("WHERE c->>'documentId' = v_doc::text AND c->>'versionId' = v_ver::text");
    expect(pin).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(pin);
    // after the stored-file check: a refused item is refused for its own reason first
    expect(lookup).toBeGreaterThan(issueGate.indexOf("IF v_key IS NULL OR v_shed IS NOT NULL THEN"));
  });
  it("stampable / not_pdf need nothing; anything else (oversize, unloadable, unchecked, no verdict) needs the yes, or is refused naming the item", () => {
    expect(issueGate).toContain("v_accepted := COALESCE(it->>'stampAccepted', '') = 'true';");
    expect(issueGate).toContain("IF v_verdict IS DISTINCT FROM 'stampable' AND v_verdict IS DISTINCT FROM 'not_pdf' AND NOT v_accepted THEN");
    expect(issueGate).toContain("RAISE EXCEPTION '% was not issued: no stamp check is recorded for its file as issued (Rev %), and no yes is recorded for it leaving the portal without the UNCONTROLLED marking. Issue it from the register — it checks each file and asks. (TRX-17, 20261199)', COALESCE(it->>'number', v_doc::text), v_label");
    expect(issueGate).toContain("RAISE EXCEPTION '% was not issued: the stamp check answered % for its file, so the portal may release it without the UNCONTROLLED marking, and no yes is recorded for that. Issue it from the register — it asks. (TRX-17, 20261199)', COALESCE(it->>'number', v_doc::text), v_verdict");
    expect((issueGate.match(/\(TRX-17, 20261199\)'[^;]*\n\s*USING ERRCODE = 'check_violation';/g) ?? []).length).toBe(2);
  });
  it("the snapshot records the server's verdict, arms from it alone (a browser mark is dropped) and stamps a yes with who and when", () => {
    expect(issueGate).toContain("it := (it - 'stampable' - 'stampAccepted' - 'stampAcceptedBy' - 'stampAcceptedAt' - 'stampVerdict')");
    expect(issueGate).toContain("|| jsonb_build_object('stampVerdict', COALESCE(v_verdict, 'none'))");
    expect(issueGate).toContain("|| CASE WHEN v_verdict = 'stampable' THEN jsonb_build_object('stampable', true) ELSE '{}'::jsonb END");
    expect(issueGate).toContain("THEN jsonb_build_object('stampAccepted', true, 'stampAcceptedBy', v_uid, 'stampAcceptedAt', now())");
    // the rewritten item is what the 20261133 snapshot merge then extends
    expect(issueGate.indexOf("it := (it - 'stampable'")).toBeLessThan(issueGate.indexOf("v_items := v_items || jsonb_build_array("));
  });
  it("a member session never writes the check (inside the v_uid branch); a member INSERT starts it empty; once issued it is frozen for every caller", () => {
    const member = next.slice(next.indexOf("    IF v_uid IS NOT NULL THEN\n      -- ── TRX-4: the usage trail"), next.indexOf("      -- ── TRX-1: issuing, voiding and revoking are transmit authority"));
    expect(member).toContain("IF NEW.stamp_check IS DISTINCT FROM OLD.stamp_check THEN\n        RAISE EXCEPTION 'The issue-time stamp check is recorded by the server, not by a member session. (TRX-17, 20261199)'");
    const ins = next.slice(next.indexOf("IF TG_OP = 'INSERT' THEN"), next.indexOf("    ELSIF NEW.status = 'issued' THEN"));
    expect(ins).toMatch(/IF v_uid IS NOT NULL THEN[\s\S]*NEW\.portal_download_count := 0;\n      NEW\.stamp_check := NULL;\n/);
    expect(next).toContain("IF OLD.status <> 'draft' AND NEW.stamp_check IS DISTINCT FROM OLD.stamp_check THEN");
  });
});

describe("20261199 — DEC-30 one-paste shape, apply order, DRLS-16", () => {
  const begin = m199.indexOf("\nBEGIN;");
  const commit = m199.indexOf("\nCOMMIT;");
  const tail = m199.slice(commit + "\nCOMMIT;".length);

  it("the inventory is a TEMP TABLE of aggregate counts, captured BEFORE the transaction", () => {
    expect(m199.indexOf("DROP TABLE IF EXISTS dc_round_f_199_before;")).toBeLessThan(m199.indexOf("CREATE TEMP TABLE dc_round_f_199_before AS"));
    expect(m199.indexOf("CREATE TEMP TABLE dc_round_f_199_before AS")).toBeLessThan(begin);
    const inv = m199.slice(m199.indexOf("CREATE TEMP TABLE dc_round_f_199_before AS"), begin);
    expect(inv).not.toMatch(/SELECT \*/);
    expect((inv.match(/COUNT\(\*\)/g) ?? []).length).toBe(5);
    expect((inv.match(/::text/g) ?? []).length).toBe(5);
  });
  it("one transaction: the apply-order guard first (raises without 20261133), then the column, then the guard", () => {
    expect(begin).toBeGreaterThan(0);
    expect(commit).toBeGreaterThan(begin);
    const txn = m199.slice(begin, commit);
    const doAt = txn.indexOf("DO $$");
    expect(doAt).toBeGreaterThan(0);
    expect(doAt).toBeLessThan(txn.indexOf("ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS stamp_check JSONB;"));
    expect(txn.indexOf("ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS stamp_check JSONB;")).toBeLessThan(txn.indexOf(H));
    expect(txn).toContain("AND prosrc LIKE '%''statusAsSent'', v_status%'");
    expect(txn).toContain("RAISE EXCEPTION 'Apply 20261133_dc_roundF_transmittal_rails.sql first:");
    expect((m199.match(/\nBEGIN;/g) ?? []).length).toBe(1);
    expect((m199.match(/\nCOMMIT;/g) ?? []).length).toBe(1);
  });
  it("ONE final SELECT with the fixed (check, ok, n) shape: probes carry ok, the inventory carries n; no customer rows", () => {
    expect((codeOnly(tail).match(/;/g) ?? []).length).toBe(1);
    expect(tail).toMatch(/^\n\n-- ── Verification \+ inventory \(ONE result set\)[^\n]*\nSELECT '[^\n]*' AS check,\n[\s\S]*\) AS ok,\n\s*NULL::text AS n\n/);
    expect(tail).toContain("SELECT inventory, NULL::boolean, n FROM dc_round_f_199_before");
    expect(codeOnly(tail)).not.toMatch(/SELECT \*|SELECT items\b|SELECT stamp_check\b|SELECT t\.\*/);
    // the probes read prosrc verbatim: the apostrophes inside string literals are doubled
    expect(tail).toContain("prosrc LIKE '%v_accepted := COALESCE(it->>''stampAccepted'', '''') = ''true'';%'");
    expect((tail.match(/UNION ALL/g) ?? []).length).toBe(6);
  });
  it("creates no SECURITY DEFINER (DRLS-16 has nothing to pin) and keeps the ONE trigger (not re-created)", () => {
    expect(codeOnly(m199)).not.toMatch(/SECURITY DEFINER/);
    expect(m199).not.toMatch(/CREATE TRIGGER/);
    expect(tail).toContain("WHERE tgrelid = 'transmittals'::regclass AND NOT tgisinternal");
  });
  it("states the deploy order: the app first, then the paste", () => {
    expect(m199).toContain("⚠ DEPLOY ORDER: deploy the app carrying P24 FIRST, then paste this file.");
    expect(m199).toContain("Pasted BEFORE the app deploys");
  });
});
