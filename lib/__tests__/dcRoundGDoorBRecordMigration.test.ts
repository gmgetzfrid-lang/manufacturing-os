// document-control Round G — P35 DOOR B RECORD: migration 20261252
// (document-control DCK-18; assigned by the integrator at the P33 merge,
// 2026-10-21, DEC-31; ruled under DEC-90 — fail-safe, no regression).
//
//   finalize_reviewed_promote re-created from its NEWEST earlier body (scan —
//   20261151 today) with, in the promote's own transaction, the holder's
//   notice (the existing kind revision_published_over_checkout) and a
//   REVIEW_PROMOTED_OVER_CHECKOUT row (via 'database') when someone other
//   than the actor held the checkout — each in its own sub-block, never a
//   refusal — and one DEFAULTed argument, p_report_over_checkout, whose
//   answer tells the app which of the two the database wrote.
//
// Byte fidelity: lineDiff (the one line removed is the base's last parameter,
// which gains a comma) AND an exact cut (the body minus the three P35 blocks
// IS the base, byte for byte). The runtime proof — before and after the
// paste, on PostgreSQL 16 — is lib/__tests__/rls/dcP35DoorBRecord.test.ts
// (`npm run test:db`).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_META } from "@/lib/notificationKinds";
import { auditActionDef } from "@/lib/auditActions";

const root = process.cwd();
const dir = join(root, "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261252_dc_roundG_door_b_record.sql";
const M = mig(FILE);
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
function lineDiff(a: string, b: string) {
  const L = a.split("\n"), R = b.split("\n");
  return { onlyInA: L.filter((l) => !R.includes(l)), onlyInB: R.filter((l) => !L.includes(l)) };
}
const likeRe = (pat: string) => new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");

const HEAD = "CREATE OR REPLACE FUNCTION finalize_reviewed_promote(";
const defining = files.filter((f) => stripComments(mig(f)).includes(HEAD));
const PREV = defining[defining.indexOf(FILE) - 1];
const F = { live: between(mig(PREV), HEAD, "\n$$;"), next: between(M, HEAD, "\n$$;") };
const prosrc = F.next.slice(F.next.indexOf("$$") + 2, F.next.lastIndexOf("$$"));

/** The three P35 blocks, cut out of the body to give the base back. */
const PARAM_NEW = "  p_override_reason text DEFAULT NULL,\n  p_report_over_checkout boolean DEFAULT false\n";
const PARAM_OLD = "  p_override_reason text DEFAULT NULL\n";
const DECLARED = ["  v_lib text;", "  v_holder text;", "  v_holder_name text;", "  v_draft_label text;", "  v_who text;",
  "  v_over boolean := false;", "  v_recorded boolean := false;", "  v_told boolean := false;"];
const READ_FROM = "\n  -- DCK-18 (document-control P35): who holds the checkout, read in the\n";
const READ_TO = "  SELECT v.revision_label INTO v_draft_label FROM document_versions v WHERE v.id = p_pending_id;\n";
const RECORD_FROM = "  -- DCK-18 (document-control P35): a reviewed promote over a checkout held\n";
const RECORD_TO = "  RETURN 'promoted';\n";
function cut(body: string): string {
  let out = body.replace(PARAM_NEW, PARAM_OLD);
  for (const l of DECLARED) out = out.replace(`${l}\n`, "");
  const r = out.indexOf(READ_FROM);
  out = out.slice(0, r) + out.slice(out.indexOf(READ_TO, r) + READ_TO.length);
  const a = out.indexOf(RECORD_FROM);
  return out.slice(0, a) + out.slice(out.indexOf(RECORD_TO, a));
}

describe("20261252 — finalize_reviewed_promote re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261151 — the scan, not this comment, decides), and this file is the newest", () => {
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261151_dc_roundF_promote_transaction_and_hold_override.sql").toBe(true);
    // DCK-18 (P37): 20261254 re-creates this body after this file (its newest body, lineDiff-pinned in
    // dcRoundGDoorBGuardMigration.test.ts); every later re-create must keep this file's record block whole
    const block = F.next.slice(F.next.indexOf(RECORD_FROM), F.next.indexOf(RECORD_TO));
    expect(block.length).toBeGreaterThan(1500);
    for (const later of defining.filter((f) => f > FILE)) expect(between(mig(later), HEAD, "\n$$;"), later).toContain(block);
  });

  it("lineDiff: the only base line not kept is the last parameter (it gains a comma for p_report_over_checkout); every other base line survives", () => {
    const { onlyInA } = lineDiff(F.live, F.next);
    expect(onlyInA).toEqual(["  p_override_reason text DEFAULT NULL"]);
  });

  it("exact cut: the body minus the parameter, the eight declarations, the checkout read and the record block IS the base, byte for byte", () => {
    expect(F.next.split(PARAM_NEW).length).toBe(2);
    for (const l of DECLARED) expect(F.next.split(`${l}\n`).length, l).toBe(2);
    expect(cut(F.next)).toBe(F.live);
  });

  it("the record comes after the bookkeeping and the hold-override record, before the answer; the checkout is read right after the promote matched (before the relabel drops the draft's letter)", () => {
    const promote = F.next.indexOf("  UPDATE documents\n     SET current_version_id = p_pending_id,");
    const noMatch = F.next.indexOf("    RETURN 'no_match';");
    const read = F.next.indexOf("  SELECT d.org_id, d.library_id::text, d.checked_out_by::text,");
    const relabel = F.next.indexOf("  UPDATE document_versions\n     SET review_state = 'approved',");
    const holdRecord = F.next.indexOf("VALUES ('REV_HOLD_OVERRIDDEN'");
    const record = F.next.indexOf(RECORD_FROM);
    const answer = F.next.lastIndexOf("  RETURN 'promoted';");
    expect(promote).toBeGreaterThan(0);
    expect(noMatch).toBeGreaterThan(promote);
    expect(read).toBeGreaterThan(noMatch);
    expect(relabel).toBeGreaterThan(read);
    expect(holdRecord).toBeGreaterThan(relabel);
    expect(record).toBeGreaterThan(holdRecord);
    expect(answer).toBeGreaterThan(record);
  });

  it("still SECURITY INVOKER with search_path pinned (the guard and the row-level policies decide the promote, the notice and the record as the caller's own writes)", () => {
    expect(F.next).toContain("LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(F.next).not.toMatch(/SECURITY DEFINER/);
  });
});

describe("20261252 — DCK-18: the pass recorded and the holder told, in the promote's own transaction, never a refusal", () => {
  const block = F.next.slice(F.next.indexOf(RECORD_FROM), F.next.lastIndexOf("  RETURN 'promoted';"));

  it("only when someone OTHER than the actor (the session, or the service role's p_actor) held the checkout", () => {
    expect(block).toContain("  IF v_holder IS NOT NULL AND v_holder IS DISTINCT FROM COALESCE(auth.uid(), p_actor)::text THEN\n    v_over := true;");
  });

  it("the notice and the record each in their own sub-block: a failure is a WARNING naming what was not written, and the promote stands (no RAISE EXCEPTION in the block)", () => {
    const subs = block.split("    BEGIN\n").slice(1);
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatch(/^ {6}INSERT INTO notifications[\s\S]*\n {4}EXCEPTION WHEN OTHERS THEN\n {6}RAISE WARNING 'finalize_reviewed_promote: [^']*their notice was not written \(the publish stands\): %', v_holder, SQLERRM;\n {4}END;\n/);
    expect(subs[1]).toMatch(/^ {6}INSERT INTO audit_logs[\s\S]*\n {4}EXCEPTION WHEN OTHERS THEN\n {6}RAISE WARNING 'finalize_reviewed_promote: [^']*the record was not written \(the publish stands\): %', v_holder, SQLERRM;\n {4}END;\n/);
    expect(block).not.toMatch(/RAISE EXCEPTION/);
  });

  it("the notice is of the EXISTING kind revision_published_over_checkout (no new kind; notification_kinds() untouched) and passes the insert rails as the app's own does: the actor is the signed-in member, an app-relative link, no server watermark key in the metadata", () => {
    expect(KIND_META).toHaveProperty("revision_published_over_checkout");
    expect(block).toContain("VALUES (v_org, v_holder::uuid, 'revision_published_over_checkout',");
    expect(block).toContain("'/documents/' || v_lib || '?doc=' || p_document_id::text, 'document', p_document_id::text,");
    expect(block).toContain("COALESCE(auth.uid(), p_actor), v_who,");
    expect(block).toContain("jsonb_build_object('newVersionId', p_pending_id, 'newRev', p_base_rev, 'via', 'database'));");
    for (const k of ["staleSessionId", "staleHoldId", "reviewHealthDay", "ackEscalation"]) expect(block).not.toContain(k);
    expect(stripComments(M)).not.toMatch(/FUNCTION\s+(?:public\.)?notification_kinds/);
    // the row the insert rail skips (a recipient no longer an active member) is "not told", read from the row count
    expect(block).toContain("      GET DIAGNOSTICS v_n = ROW_COUNT;\n      v_told := v_n > 0;");
  });

  it("the record is the app's action (a routine revisions event, not destructive), via 'database', naming the holder, the versions and whether the holder was told", () => {
    expect(auditActionDef("REVIEW_PROMOTED_OVER_CHECKOUT")).toMatchObject({ category: "revisions", destructive: false });
    expect(block).toContain("VALUES ('REVIEW_PROMOTED_OVER_CHECKOUT', p_document_id::text, 'document', v_org, COALESCE(auth.uid(), p_actor),");
    for (const k of ["'via', 'database',", "'holderUserId', v_holder,", "'holderName', v_holder_name,", "'holderNotified', v_told,",
      "'versionId', p_pending_id,", "'previousVersionId', p_expected_current,", "'revisionLabel', p_base_rev"]) expect(block).toContain(k);
  });

  it("the answer: exactly 'promoted' unless asked (p_report_over_checkout DEFAULT false) — asked, 'promoted_clear' or 'promoted_over_checkout' + '_recorded' / '_told'", () => {
    expect(F.next).toContain("  p_report_over_checkout boolean DEFAULT false\n) RETURNS text");
    expect(F.next).toContain("  IF p_report_over_checkout THEN\n    RETURN CASE WHEN NOT v_over THEN 'promoted_clear'\n                ELSE 'promoted_over_checkout'\n                     || CASE WHEN v_recorded THEN '_recorded' ELSE '' END\n                     || CASE WHEN v_told THEN '_told' ELSE '' END\n           END;\n  END IF;\n  RETURN 'promoted';\n$$".replace("\n$$", "\nEND;\n$$"));
  });
});

describe("20261252 — grants, one signature, and what it defines", () => {
  const code = stripComments(M);

  it("drops the seven-argument form (and 20261151's own five-argument drop) BEFORE the create, so one signature remains", () => {
    const d7 = M.indexOf("DROP FUNCTION IF EXISTS finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text);");
    const d5 = M.indexOf("DROP FUNCTION IF EXISTS finalize_reviewed_promote(uuid, uuid, uuid, text, uuid);");
    expect(d7).toBeGreaterThan(0);
    expect(d5).toBeGreaterThan(0);
    expect(d7).toBeLessThan(M.indexOf(HEAD));
    expect(d5).toBeLessThan(M.indexOf(HEAD));
  });

  it("EXECUTE revoked from PUBLIC and anon, granted to authenticated and service_role — on the eight-argument signature only", () => {
    expect(M).toContain("REVOKE ALL ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean) FROM PUBLIC, anon;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean) TO authenticated, service_role;");
    expect(code).not.toMatch(/(?:GRANT|REVOKE)[^;]*finalize_reviewed_promote\(uuid, uuid, uuid, text, uuid, boolean, text\)/);
  });

  it("defines finalize_reviewed_promote and nothing else (no other function, no policy, no trigger; the publish guard is NOT re-created — ruling (3))", () => {
    expect(code.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)/g)).toEqual(["CREATE OR REPLACE FUNCTION finalize_reviewed_promote"]);
    expect(code).not.toMatch(/CREATE\s+POLICY|CREATE\s+(?:CONSTRAINT\s+)?TRIGGER|ALTER\s+TABLE|enforce_document_publish_guard\s*\(\)\s*RETURNS/);
  });
});

describe("20261252 — one paste for the SQL editor (DEC-30)", () => {
  const code = stripComments(M);

  it("header; the prerequisite refuses (changing nothing) without 20261151's function or 20261247's column guard; a counts-only TEMP inventory BEFORE the one BEGIN … COMMIT", () => {
    expect(M.startsWith("-- ─")).toBe(true);
    expect(code.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;/gm)).toHaveLength(1);
    const pre = code.indexOf("DO $$");
    const temp = code.indexOf("CREATE TEMP TABLE dc_round_g_252_before AS");
    expect(pre).toBeGreaterThan(0);
    expect(temp).toBeGreaterThan(pre);
    expect(temp).toBeLessThan(code.indexOf("BEGIN;"));
    expect(M).toContain("RAISE EXCEPTION '20261252 needs 20261151 (finalize_reviewed_promote with p_force_hold) pasted first; nothing was changed.';");
    expect(M).toContain("RAISE EXCEPTION '20261252 needs 20261247 (the version row column guard) pasted first; nothing was changed.';");
  });

  it("the inventory is aggregate counts only — every row a COUNT(*), never a customer column", () => {
    const inv = between(code, "CREATE TEMP TABLE dc_round_g_252_before AS", "\nBEGIN;");
    const selects = inv.split(/\bUNION ALL\b/);
    expect(selects).toHaveLength(6);
    for (const s of selects) expect(s, s.slice(0, 120)).toMatch(/COUNT\(\*\)::text/);
    const outer = inv.slice(inv.indexOf("\nSELECT 'inventory"));
    expect(outer).not.toMatch(/SELECT\s+(?!'inventory|COUNT)\w+\.\w+/);
  });

  it("ends with ONE statement after COMMIT: probes (ok, n NULL) and the inventory rows (ok NULL, n)", () => {
    const tail = code.slice(code.indexOf("COMMIT;") + "COMMIT;".length);
    const statements = tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((s) => s.trim());
    expect(statements).toHaveLength(1);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,\s*NULL::text AS n/);
    expect(tail).toContain("SELECT inventory, NULL::boolean, n FROM dc_round_g_252_before;");
  });

  it("every prosrc probe holds on the body itself (verbatim prosrc; '' in a probe is ' in the body)", () => {
    const tail = M.slice(M.indexOf("COMMIT;"));
    const pats = [...tail.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(pats.length).toBeGreaterThanOrEqual(3);
    const fnProbes = pats.filter((p) => !p.includes("revision_published_over_checkout',"));
    for (const p of fnProbes) expect(prosrc, p.slice(0, 80)).toMatch(likeRe(p));
  });

  it("the header's operator queries (DCK-18 done-when 3) only read — no INSERT / UPDATE / DELETE — and name the intake route's own record and the Intake tab's Reject (the existing retire path)", () => {
    const header = M.slice(0, M.indexOf("-- PASTE ORDER:"));
    const queries = header.slice(header.indexOf("--   1. How many:"), header.indexOf("--   Then, for each"));
    expect(queries).toContain("a.action = 'INTAKE_SUBMISSION' AND a.user_id IS NULL");
    expect(queries).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
    expect(header).toContain("RETIRE it with Reject");
    expect(header).toContain("components/projects/IntakePanel.tsx");
  });

  it("review fix: the Intake tab lists only DOCUMENT links, so the look-over list (query 2, row 5) is only those, and a submission on any other link — or none — is counted (row 6) and listed (query 3) apart, with no claim that the tab retires it", () => {
    const panel = readFileSync(join(root, "components", "projects", "IntakePanel.tsx"), "utf8");
    expect(panel).toContain('.eq("purpose", "documents")');
    const header = M.slice(0, M.indexOf("-- PASTE ORDER:"));
    const q2 = header.slice(header.indexOf("--   2. Which"), header.indexOf("--   3. Which"));
    const q3 = header.slice(header.indexOf("--   3. Which"), header.indexOf("--   Then, for each"));
    expect(q2).toContain("--        JOIN project_intake_links l ON l.id = v.intake_link_id\n--         AND COALESCE(l.purpose, 'documents') = 'documents'");
    expect(q3).toContain("AND (l.id IS NULL OR COALESCE(l.purpose, 'documents') <> 'documents')");
    expect(header).not.toContain("filed through one of the project's links that its document points at");
    expect(header).toContain("For a row of query 3 there is no TARGETED app action");
    expect(header).toContain("void-pending-draft path, lib/revisions.ts voidPendingDraft, retires it only");
    const inv = between(code, "CREATE TEMP TABLE dc_round_g_252_before AS", "\nBEGIN;");
    expect(inv).toContain("AND COALESCE(l.purpose, 'documents') = 'documents') AS on_intake_tab");
    expect(inv).toContain("FROM s WHERE NOT route_recorded AND on_intake_tab\n");
    expect(inv).toContain("FROM s WHERE NOT route_recorded AND NOT on_intake_tab;");
  });

  it("review fix: PostgREST is told to reload its schema cache inside the transaction (delivered at COMMIT), and the stale-cache double is stated in the header", () => {
    const tx = between(code, "\nBEGIN;", "\nCOMMIT;");
    expect(tx).toMatch(/\nNOTIFY pgrst, 'reload schema';\n\s*\nCOMMIT;$/);
    expect(code.match(/NOTIFY pgrst/g)).toHaveLength(1);
    expect(M).toContain("until the reload lands, a promote over a checkout may\n-- be recorded and told twice");
  });
});

describe("the app half (lib/reviewControl.ts) — asks for the report; before the paste calls exactly as before", () => {
  const src = readFileSync(join(root, "lib", "reviewControl.ts"), "utf8");
  it("the first call carries p_report_over_checkout; on PGRST202 / 42883 the same arguments without it", () => {
    expect(src).toContain('let { data, error } = await supabase.rpc("finalize_reviewed_promote", { ...args, p_report_over_checkout: true });');
    expect(src).toContain('if (error && missing(error)) ({ data, error } = await supabase.rpc("finalize_reviewed_promote", args));');
  });
});
