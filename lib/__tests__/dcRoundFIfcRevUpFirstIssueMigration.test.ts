// document-control Round F wave 3 — P25 STATUS-SURFACE FOLLOW-UPS:
// migration 20261193 (REV-28, option (a) — DEC-77, decided by the integrator
// under the user's delegation at the P16 merge, 2026-10-07).
//
//   enforce_document_publish_guard re-created from its NEWEST earlier body
//   (scan — 20261185 today) with EXACTLY one P25 block added, in the review
//   gate's no-roster branch right after REV-17's first-issue rule and before
//   SEC-13: a non-controller's pointer move INTO Issued / Locked out of an
//   issue status no gate reads as in force (IFC, empty, a variant, a
//   library's own, NULL), with no reviewer roster on the new revision, under
//   a policy that requires sign-off (chain OR own), is refused as a first
//   issue in the require limb's sentence. RG-7's Minor / Correction hatch is
//   unchanged for a document in force. Nothing else is re-created or created.
//
// Byte fidelity: lineDiff (nothing removed; every new line is the block) AND
// an exact cut (the body minus the block IS the base, byte for byte). The
// script was run on a throwaway PostgreSQL 16 (REV-28's record: B-13 and
// Q-1..Q-8 refused only with it, S-1..S-16 and the real publish_revision's
// P-2..P-4 unchanged); the app's twin (firstIssueGateForRevUp) is pinned to
// the block in dcRoundFStatusSurface.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { IN_FORCE_STATUSES } from "@/lib/verifyVerdict";
import { ISSUE_REFUSAL } from "@/lib/issueStatus";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261193_dc_roundF_ifc_rev_up_first_issue.sql";
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
const code = (lines: string[]) => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));
const likeRe = (pat: string) => new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
const prosrcOf = (body: string) => body.slice(body.indexOf("$$") + 2);

const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
const defining = files.filter((f) => /CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/.test(stripComments(mig(f))));
const PREV = defining[defining.indexOf(FILE) - 1];
const G = { live: between(mig(PREV), GUARD_HEAD, "\n$$;"), next: between(M, GUARD_HEAD, "\n$$;") };

/** REV-17's rule (20261139), the statement the P25 block follows. */
const REV17_END = "        RAISE EXCEPTION\n          'This library requires reviewer sign-off, so a new document can''t be issued unreviewed; create it as a Draft and submit it for review, or ask Document Control.'\n          USING ERRCODE = 'check_violation';\n      END IF;\n";
/** SEC-13's comment, the text the P25 block precedes. */
const SEC13_HEAD = "      -- SEC-13 (projects Round G): an EXTERNAL submission is no exception to\n";
const BLOCK = G.next.slice(G.next.indexOf("      -- REV-28 (document-control Round F wave 3, P25; DEC-77, option (a),"), G.next.indexOf(SEC13_HEAD));
const BLOCK_CODE = [
  "      IF OLD.current_version_id IS NOT NULL AND v_intake_link IS NULL",
  "         AND COALESCE(is_controlled_issue_status(OLD.status)",
  "                      AND COALESCE(OLD.status, '') NOT IN ('Issued', 'Locked')",
  "                      AND NEW.status IN ('Issued', 'Locked'), false)",
  "         AND NOT is_org_controller(NEW.org_id)",
  "         AND (review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = 'require'",
  "              OR review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id) = 'require') THEN",
  "        RAISE EXCEPTION",
  "          'This library requires reviewer sign-off, so a revision that was not reviewed can''t be made a controlled issue; submit it for review, or ask Document Control.'",
  "          USING ERRCODE = 'check_violation';",
  "      END IF;",
];
/** RG-7's hatch (unchanged): a non-Minor revision under require needs review. */
const RG7 = "      IF OLD.current_version_id IS NOT NULL AND v_intake_link IS NULL\n         AND COALESCE(v_change_type, '') NOT IN ('Minor', 'Correction') THEN\n";
/** The review gate's pointer-move block and its no-roster branch. */
const GATE_HEAD = "  IF NEW.current_version_id IS NOT NULL\n     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN\n";
const NO_ROSTER = "    IF COALESCE(v_primary_reqs, 0) = 0 THEN\n";

describe("20261193 — the guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261185 — the scan, not this comment, decides), and it carries REV-21's two blocks", () => {
    expect(defining).toContain(FILE);
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261185_dc_roundF_status_into_force_issue.sql").toBe(true);
    expect(G.live).toContain("  v_issuing := v_issuing\n               OR COALESCE(NEW.current_version_id IS NOT NULL\n");
    expect(G.live).toContain("  v_restoring := v_restoring\n                 AND NOT COALESCE(NEW.status IN ('Issued', 'Locked')\n");
    for (const limb of [REV17_END, RG7, GATE_HEAD, NO_ROSTER, SEC13_HEAD]) expect(G.next, limb.slice(0, 60)).toContain(limb);
  });

  it("nothing removed, every new line is the P25 block, and the body minus it IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    for (const l of onlyInB) expect(BLOCK.split("\n"), l).toContain(l);
    expect(BLOCK.length).toBeGreaterThan(1000);
    expect(G.next.split(BLOCK).length).toBe(2);
    expect(G.next.replace(BLOCK, "")).toBe(G.live);
  });

  it("the block's code is exactly the decided rule — right after REV-17's rule, before SEC-13, inside the review gate's no-roster branch and after RG-7's hatch", () => {
    expect(code(BLOCK.split("\n"))).toEqual(BLOCK_CODE);
    expect(G.next).toContain(REV17_END + BLOCK + SEC13_HEAD);
    const at = (s: string) => G.next.indexOf(s);
    expect(at(GATE_HEAD)).toBeLessThan(at(NO_ROSTER));
    expect(at(NO_ROSTER)).toBeLessThan(at(RG7));
    expect(at(RG7)).toBeLessThan(at(BLOCK));
    // no declaration, nothing else touched: the same variables, one more refusal
    expect(G.next.slice(0, G.next.indexOf("BEGIN\n"))).toBe(G.live.slice(0, G.live.indexOf("BEGIN\n")));
    const count = (s: string, w: RegExp) => (stripComments(s).match(w) ?? []).length;
    expect(count(G.next, /RAISE EXCEPTION/g)).toBe(count(G.live, /RAISE EXCEPTION/g) + 1);
    for (const v of [/v_issuing/g, /v_restoring/g, /v_new_door/g, /v_advancing/g, /v_unforced_move/g, /v_unforced_issue/g, /current_setting/g, /set_config/g]) {
      expect(count(G.next, v), String(v)).toBe(count(G.live, v));
    }
    expect(BLOCK).not.toMatch(/:=/);
  });

  it("its in-force pair, read from the SQL, is lib/verifyVerdict.ts IN_FORCE_STATUSES (OLD outside it, NEW inside it — compared exactly, as the gates compare); its sentence is the require limb's, which the app recognises", () => {
    const lists = [...code(BLOCK.split("\n")).join("\n").matchAll(/IN \(([^)]*)\)/g)].map((m) => m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")));
    expect(lists).toHaveLength(2);
    for (const l of lists) expect(l).toEqual([...IN_FORCE_STATUSES]);
    expect(BLOCK).not.toMatch(/btrim|lower\(|upper\(|ILIKE/);
    expect(BLOCK).toContain(ISSUE_REFUSAL.unreviewed.replace(/'/g, "''"));
    // the same sentence the require limb raises for a status-only issue (one sentence, two places)
    expect(G.live).toContain("          'This library requires reviewer sign-off, so a revision that was not reviewed can''t be made a controlled issue; submit it for review, or ask Document Control.'\n");
    // the require read is REV-17's: the chain OR the document's own (DEC-71)
    expect(BLOCK).toContain("(review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = 'require'\n              OR review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id) = 'require')");
  });

  it("DRLS-16: the guard is executable by no client role; SECURITY DEFINER with its search_path pinned; nothing dropped, nothing else created, no row moved", () => {
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(G.next).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    const body = stripComments(M);
    expect(body).not.toMatch(/DROP FUNCTION/);
    expect((body.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/CREATE (?:POLICY|TRIGGER)|GRANT |ALTER TABLE/);
    expect(body.replace(/'(?:[^']|'')*'/g, "''")).not.toMatch(/\bUPDATE\s+documents\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b/i);
  });

  it("the flag is still SET only by its setters — this file only reads it (with those reads stripped, it never names the flag)", () => {
    const withoutFlagReads = (sql: string) => sql
      .split("current_setting('app.publish_hold_override', true)").join("")
      .split("current_setting(''app.publish_hold_override'', true)").join("");
    expect(withoutFlagReads(stripComments(M).replace(/'(?:[^']|'')*'/g, "''"))).not.toMatch(/set_config|SET LOCAL/);
    expect(withoutFlagReads(stripComments(G.next))).not.toMatch(/publish_hold_override/);
  });
});

describe("20261193 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'");
    expect(pre).toBeGreaterThan(0);
    expect(M).toContain("RAISE EXCEPTION '20261193 needs 20261185 (the REV-21 status-into-force limb in the publish guard) pasted first; nothing was changed.';");
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_f_193_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_193_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(4);
    expect(inventory).not.toMatch(/SELECT \*|document_number|title|d\.id\s+AS|user_email/);
    // the population is 20261185's REV-21 population, and the require read is the guard's own
    expect(inventory).toContain("   WHERE d.current_version_id IS NOT NULL\n     AND is_controlled_issue_status(d.status)\n     AND COALESCE(d.status, '') NOT IN ('Issued', 'Locked')\n");
    expect(inventory).toContain("(review_control_mode_for(NULL, d.collection_id, d.library_id) = 'require'\n          OR review_control_mode_for(d.review_control, d.collection_id, d.library_id) = 'require') AS under_require");
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1);
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_f_193_before;");
  });

  it("the prerequisite passes on 20261185's guard and on this one (idempotent), and refuses on 20261182's (no REV-21 limb)", () => {
    const pre = M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE"));
    const pats = [...pre.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(pats).toHaveLength(2);
    const ok = (body: string) => pats.every((p) => likeRe(p).test(prosrcOf(body)));
    const guardOf = (f: string) => between(mig(f), GUARD_HEAD, "\n$$;");
    expect(ok(guardOf("20261185_dc_roundF_status_into_force_issue.sql"))).toBe(true);
    expect(ok(G.next)).toBe(true);
    expect(ok(guardOf("20261182_dc_roundF_first_pointer_hold_limb.sql"))).toBe(false);
  });

  it("every prosrc LIKE / NOT LIKE probe matches the body of the function it names (prosrc verbatim), and none carries a cast; the P25 probes are FALSE on the base", () => {
    const newest = (head: string) => {
      const f = files.filter((x) => x <= FILE && stripComments(mig(x)).includes(head)).pop()!;
      return between(mig(f), head, "\n$$;");
    };
    const bodies: Record<string, string> = {
      enforce_document_publish_guard: G.next,
      put_back_retired_issue: newest("CREATE OR REPLACE FUNCTION put_back_retired_issue("),
      publish_revision: newest("CREATE OR REPLACE FUNCTION publish_revision("),
      finalize_reviewed_promote: newest("CREATE OR REPLACE FUNCTION finalize_reviewed_promote("),
      restore_reversed_source: newest("CREATE OR REPLACE FUNCTION restore_reversed_source("),
    };
    let n = 0;
    const p25: string[] = [];
    for (const seg of tail.split(/\nUNION ALL\n/)) {
      const isP25 = /(?:^|\n)SELECT 'REV-28 \(P25\)/.test(seg);
      for (const sub of seg.split(/\(SELECT (?=prosrc)/)) {
        const fn = /FROM pg_proc WHERE proname = '(\w+)'/.exec(sub)?.[1];
        for (const m of sub.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
          expect(fn, sub.slice(0, 80)).toBeDefined();
          const pat = m[2].replace(/''/g, "'");
          expect(pat, pat).not.toMatch(/::/);
          const body = bodies[fn!];
          expect(body, fn).toBeDefined();
          expect(likeRe(pat).test(prosrcOf(body)), `${fn}: ${pat}`).toBe(m[1] ? false : true);
          if (isP25) p25.push(pat);
          n += 1;
        }
      }
    }
    expect(n).toBe(25); // P25 2 + REV-21 3 + REV-25 3 + REV-24 2 + REV-23/22/RG-14 5 + REV-20/17/20261144 6 + the recorded forces 4
    expect(p25).toHaveLength(2);
    for (const pat of p25) expect(likeRe(pat).test(prosrcOf(G.live)), pat).toBe(false);
  });

  it("the probes cover the guard's grants, its pinned search_path, its owner's EXECUTE on is_controlled_issue_status and its trigger — BEFORE UPDATE only", () => {
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('authenticated', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])");
    expect(tail).toContain("'is_controlled_issue_status(text)', 'EXECUTE'), false)");
    expect(tail).toContain("AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 4) = 0),");
    expect(tail).toContain("-- Probes: ok = true × 11. Inventory rows: n = the aggregate count.");
    expect(tail.split(/\nUNION ALL\n/).filter((s) => /AS ok,|^SELECT '/.test(s) && !/FROM dc_round_f_193_before/.test(s))).toHaveLength(11);
  });

  it("the header states the finding, the decision (option (a)), the paste order (the app deployed → 20261192 → 20261185 → this file), the never-re-paste list, the deploy order, the one app result that changes, and that it is not a widening", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/REV-28 {2}DEC-77 \/ DEC-90 ratified REV-21 status-only/);
    expect(head).toMatch(/DECIDED by the integrator under the user's delegation at the P16\n-- {11}merge, 2026-10-07 \(DEC-77, option \(a\)\): such a rev-up is a first\n-- {11}issue\./);
    expect(head).toMatch(/HOW TO APPLY: AFTER 20261185 \(required/);
    expect(head).toMatch(/the\n-- app carrying P25 deployed, then 20261192, then 20261185 \(after 20261182\),\n-- then THIS file\./);
    expect(head).toMatch(/⚠ Never re-paste 20261185, 20261182, 20261174, 20261165, 20261164,\n-- 20261159, 20261151, 20261144, 20261139, 20261105 or any earlier guard\n-- migration after this one/);
    expect(head).toMatch(/DEPLOY ORDER: the app carrying P25 is deployed BEFORE this paste/);
    expect(head).toMatch(/ONE APP RESULT CHANGES, and only as decided/);
    expect(head).toMatch(/a revert is refused up front by\n-- revertToVersion \(firstIssueGateForRevUp\), naming the revert's route,\n-- nothing written — this block refuses the same write at the database\n-- should the app's gate be bypassed/);
    expect(head).not.toMatch(/a revert has no up-front check/);
    expect(head).toMatch(/NOT a widening/);
    expect(head).toMatch(/RE-CREATED FROM THE NEWEST BODY/);
  });
});
