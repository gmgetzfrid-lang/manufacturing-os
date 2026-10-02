// document-control Round F wave 3 — P20 RETIRED-DOCUMENT HOLD LIMBS: migration
// 20261174 (REV-24).
//
//   enforce_document_publish_guard re-created from its NEWEST earlier body
//   (scan — 20261165 today) with EXACTLY the P20 block added:
//   (b) a controller's move of a held retired document's current revision
//       (Superseded / Archived / Void, from a revision to another) is an
//       unforced move — refused over an active hold unless the flag a
//       recorded force sets names the document (v_unforced_move, widened);
//   (a) the exit into an issue status of a retirement whose stamp names
//       ANOTHER revision than its current one, its pointer unmoved, is the
//       new door — refused over an active hold for everyone, no flag passing
//       it (never a recorded controller pass: REV-18).
//   Nothing else is re-created or created; put_back_retired_issue (20261165)
//   still forces only a stamp naming the current revision.
//
// Byte fidelity: lineDiff (nothing removed; every new line is an addition)
// AND an exact cut (the re-created body minus the addition IS the base, byte
// for byte). The script was run on a throwaway PostgreSQL 16 (REV-24's
// record); the behaviour is driven through the real put-backs in
// dcRoundFRetiredHoldLimbs.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261174_dc_roundF_retired_hold_limbs.sql";
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
/** A prosrc LIKE pattern as a RegExp over a body (% any run, _ any one character). */
const likeRe = (pat: string) => new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
const prosrcOf = (body: string) => body.slice(body.indexOf("$$") + 2);

const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
/** The definition this migration re-creates from: the newest one BEFORE it (scanned). */
const defining = files.filter((f) => /CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/.test(stripComments(mig(f))));
const PREV = defining[defining.indexOf(FILE) - 1];
const G = { live: between(mig(PREV), GUARD_HEAD, "\n$$;"), next: between(M, GUARD_HEAD, "\n$$;") };
const STAMP_BLOCK = "  IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN\n";

/** The guard's one addition, as contiguous text. */
const G_LIMB = G.next.slice(
  G.next.indexOf("  -- REV-24 (document-control Round F wave 3, P20): two controller writes on"),
  G.next.indexOf(STAMP_BLOCK),
);
const NEW_DOOR_HOLD = "Document has an active hold; release the hold before issuing it.";
const UNFORCED_HOLD_SQL = "'Document has an active hold; release the hold before issuing it, or publish over it with Document Control''s recorded override.'";
const P19_LIMB_CODE = "  v_new_door := v_new_door\n                OR COALESCE(v_restoring\n                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                            AND is_org_controller(NEW.org_id), false);\n";
const P17_MOVE = "  v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                              AND is_controlled_issue_status(OLD.status)\n                              AND is_controlled_issue_status(NEW.status)\n                              AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                              AND is_org_controller(NEW.org_id), false);\n";

describe("20261174 — the guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261165 — the scan, not this comment, decides)", () => {
    expect(defining).toContain(FILE);
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261165_dc_roundF_stamped_put_back.sql").toBe(true);
    // the base carries P19's limb (the prerequisite this file checks for)
    expect(G.live).toContain(P19_LIMB_CODE);
  });

  it("nothing removed, every new line is the P20 block, and the body minus it IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    const added = G_LIMB.split("\n");
    for (const l of onlyInB) expect(added, l).toContain(l);
    expect(G_LIMB.length).toBeGreaterThan(400);
    expect(G.next.split(G_LIMB).length).toBe(2);
    expect(G.next.replace(G_LIMB, "")).toBe(G.live);
  });

  it("the added code is exactly the two P20 limbs — (b) the pointer move on a held retired document as an unforced move, (a) the exit of a stamp naming another revision as the new door — right after P19's limb and before the stamp is rewritten", () => {
    expect(code(G_LIMB.split("\n"))).toEqual([
      "  v_unforced_move := v_unforced_move",
      "                     OR COALESCE(OLD.current_version_id IS NOT NULL",
      "                                 AND NEW.current_version_id IS NOT NULL",
      "                                 AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id",
      "                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')",
      "                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text",
      "                                 AND is_org_controller(NEW.org_id), false);",
      "  v_new_door := v_new_door",
      "                OR COALESCE(v_issuing",
      "                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id",
      "                            AND OLD.status IN ('Superseded', 'Archived', 'Void')",
      "                            AND OLD.retired_issue_version_id IS NOT NULL",
      "                            AND OLD.retired_issue_version_id IS DISTINCT FROM OLD.current_version_id, false);",
    ]);
    expect(G.next).toContain(P19_LIMB_CODE + G_LIMB + STAMP_BLOCK);
    // (b) widens P17's limb (kept byte for byte above it), and is read only by P17's refusal, after it
    expect(G.next.indexOf(P17_MOVE)).toBeGreaterThan(0);
    expect(G.next.indexOf(P17_MOVE)).toBeLessThan(G.next.indexOf(G_LIMB));
    expect(G.next).toContain(`  IF v_unforced_move AND EXISTS (\n       SELECT 1 FROM document_holds h\n        WHERE h.document_id = NEW.id AND h.released_at IS NULL\n     ) THEN\n    RAISE EXCEPTION\n      ${UNFORCED_HOLD_SQL}`);
    expect(G.next.indexOf("  IF v_unforced_move AND EXISTS (")).toBeGreaterThan(G.next.indexOf(G_LIMB));
    // (a) feeds the new door, whose refusal is the existing one — read only inside the issue block, after this limb
    expect(G.next).toContain(`    IF v_new_door AND EXISTS (\n         SELECT 1 FROM document_holds h\n          WHERE h.document_id = NEW.id AND h.released_at IS NULL\n       ) THEN\n      RAISE EXCEPTION\n        '${NEW_DOOR_HOLD}'`);
    expect(G.next.indexOf("    IF v_new_door AND EXISTS (")).toBeGreaterThan(G.next.indexOf(G_LIMB));
    const count = (s: string, w: RegExp) => (stripComments(s).match(w) ?? []).length;
    expect(count(G.next, /v_new_door/g)).toBe(count(G.live, /v_new_door/g) + 2);
    expect(count(G.next, /v_unforced_move/g)).toBe(count(G.live, /v_unforced_move/g) + 2);
    // no new declaration, no new refusal sentence; the require limb still spares only a put-back
    expect(G.next.slice(0, G.next.indexOf("BEGIN\n"))).toBe(G.live.slice(0, G.live.indexOf("BEGIN\n")));
    expect(G_LIMB).not.toMatch(/RAISE/);
    expect(G.next).toContain("    IF NOT is_org_controller(NEW.org_id)\n       AND NOT v_restoring\n");
  });

  it("(a) passes no flag and binds everyone — it never names the flag or the controller tier (REV-18: never a recorded controller pass); (b) honours the flag and binds a controller only, as P17's limb does", () => {
    const [b, a] = code(G_LIMB.split("\n")).join("\n").split("  v_new_door := v_new_door");
    expect(a).not.toMatch(/publish_hold_override|is_org_controller/);
    expect(b).toContain("AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text");
    expect(b).toContain("AND is_org_controller(NEW.org_id), false);");
    // (b) binds a move FROM a revision TO another (a first pointer write, or a pointer cleared, is not this — REV-17's, as in P17's limb)
    expect(b).toContain("OLD.current_version_id IS NOT NULL");
    expect(b).toContain("AND NEW.current_version_id IS NOT NULL");
    // (a) is the exit with its pointer unmoved, out of a retirement stamped with a revision that is not the current one
    expect(a).toContain("AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id");
    expect(a).toContain("AND OLD.retired_issue_version_id IS NOT NULL");
    expect(a).toContain("AND OLD.retired_issue_version_id IS DISTINCT FROM OLD.current_version_id, false);");
  });

  it("the refusals are said as the app reads them: both sentences are hold refusals of the issue rule (isIssueRefusal)", async () => {
    const { isIssueRefusal, ISSUE_REFUSAL } = await import("@/lib/issueStatus");
    expect(isIssueRefusal(NEW_DOOR_HOLD)).toBe(true);
    expect(NEW_DOOR_HOLD).toContain(ISSUE_REFUSAL.newDoorHold);
    const unforced = UNFORCED_HOLD_SQL.slice(1, -1).replace(/''/g, "'");
    expect(isIssueRefusal(unforced)).toBe(true);
  });

  it("the base's rules are all still there — P19's stamped put-back, P18's unstamped Superseded exit, P17's issued pointer move, REV-20's limbs — this is a re-create, not a rewrite", () => {
    for (const limb of [
      P19_LIMB_CODE,
      P17_MOVE,
      "                            AND OLD.status = 'Superseded'\n                            AND OLD.retired_issue_status IS NULL\n                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n",
      "                            AND OLD.status IN ('Archived', 'Void')\n                            AND OLD.retired_issue_status IS NULL\n",
      "  v_unforced_issue := COALESCE(v_issuing\n",
      "  v_restoring := COALESCE(v_issuing\n",
    ]) expect(G.next, limb.slice(0, 60)).toContain(limb);
  });

  it("DRLS-16: the guard is executable by no client role; SECURITY DEFINER with its search_path pinned; nothing dropped, nothing else created", () => {
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(G.next).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    const body = stripComments(M);
    expect(body).not.toMatch(/DROP FUNCTION/);
    expect((body.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/CREATE (?:POLICY|TRIGGER)|GRANT /);
    // put_back_retired_issue (20261165) is not re-created: its door already forces only a stamp naming the current revision
    expect(body).not.toMatch(/FUNCTION\s+(?:public\.)?(?:put_back_retired_issue|restore_reversed_source)\b/);
    const putBack = between(mig("20261165_dc_roundF_stamped_put_back.sql"), "CREATE OR REPLACE FUNCTION put_back_retired_issue(", "\n$$;");
    expect(putBack).toContain("     AND v_stamped IS NOT NULL\n     AND v_stamped = v_version\n");
    expect(files.filter((f) => f > "20261165_dc_roundF_stamped_put_back.sql" && /FUNCTION\s+(?:public\.)?put_back_retired_issue\b/.test(stripComments(mig(f))))).toEqual([]);
  });

  it("the flag in the whole sequence is still SET only by 20261151, 20261164 and 20261165 — this file only reads it (with those reads stripped, it never names the flag, so the earlier packages' setter scans need no exception for it)", () => {
    const withoutFlagReads = (sql: string) => sql
      .split("current_setting('app.publish_hold_override', true)").join("")
      .split("current_setting(''app.publish_hold_override'', true)").join("");
    const setters = files.filter((f) => /publish_hold_override/.test(withoutFlagReads(stripComments(mig(f)))));
    expect(setters).toEqual([
      "20261151_dc_roundF_promote_transaction_and_hold_override.sql",
      "20261164_dc_roundF_reversal_restore.sql",
      "20261165_dc_roundF_stamped_put_back.sql",
    ]);
    expect(stripComments(M)).toContain("current_setting('app.publish_hold_override', true)");
    expect(stripComments(M)).not.toMatch(/set_config|SET LOCAL/);
  });
});

describe("20261174 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'");
    expect(pre).toBeGreaterThan(0);
    expect(M).toContain("RAISE EXCEPTION '20261174 needs 20261165 (the REV-23 stamped put-back and its publish guard) pasted first; nothing was changed.';");
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_f_174_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_174_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(3);
    expect(inventory).not.toMatch(/SELECT \*|document_number|title|d\.id\s+AS|user_email/);
    expect(inventory).toContain("  SELECT d.retired_issue_version_id IS NOT NULL\n         AND d.retired_issue_version_id IS DISTINCT FROM d.current_version_id AS stamp_elsewhere,");
    expect(inventory).toContain("   WHERE d.status IN ('Superseded', 'Archived', 'Void')\n)");
    for (const w of ["  FROM retired WHERE stamp_elsewhere\n", "  FROM retired WHERE stamp_elsewhere AND held\n", "  FROM retired WHERE held;"]) {
      expect(inventory, w).toContain(w);
    }
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1); // one statement: the final SELECT
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_f_174_before;");
  });

  it("the prerequisite passes on 20261165's guard (P19's limb, with put_back_retired_issue) and on this one (idempotent), and refuses on 20261164's", () => {
    const pat = /prosrc LIKE '((?:[^']|'')*)'\)/.exec(M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE")))![1].replace(/''/g, "'");
    expect(pat).not.toMatch(/::/);
    const re = likeRe(pat);
    const guardOf = (f: string) => prosrcOf(between(mig(f), GUARD_HEAD, "\n$$;"));
    expect(re.test(guardOf("20261165_dc_roundF_stamped_put_back.sql"))).toBe(true);
    expect(re.test(prosrcOf(G.next))).toBe(true);
    expect(re.test(guardOf("20261164_dc_roundF_reversal_restore.sql"))).toBe(false);
    expect(re.test(guardOf("20261159_dc_roundF_guard_owner_and_held_pointer.sql"))).toBe(false);
    expect(M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE"))).toContain("OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'put_back_retired_issue') THEN");
  });

  it("every prosrc LIKE probe matches the body of the function it names (prosrc verbatim), and none carries a cast; the two P20 probes are FALSE on the base", () => {
    /** The newest definition of a function in the sequence up to and including this file. */
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
    const p20: string[] = [];
    for (const seg of tail.split(/\nUNION ALL\n/)) {
      for (const sub of seg.split(/\(SELECT (?=prosrc|pronargs|COUNT)/)) {
        const fn = /FROM pg_proc WHERE proname = '(\w+)'/.exec(sub)?.[1];
        for (const m of sub.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
          expect(fn, sub.slice(0, 80)).toBeDefined();
          const pat = m[2].replace(/''/g, "'");
          expect(pat, pat).not.toMatch(/::/);
          const body = bodies[fn!];
          expect(body, fn).toBeDefined();
          expect(likeRe(pat).test(prosrcOf(body)), `${fn}: ${pat}`).toBe(m[1] ? false : true);
          if (pat.startsWith("%v_unforced_move := v_unforced_move")) p20.push(pat);
          n += 1;
        }
      }
    }
    expect(n).toBe(24);
    expect(p20).toHaveLength(2);
    for (const pat of p20) expect(likeRe(pat).test(prosrcOf(G.live)), pat).toBe(false);
  });

  it("the probes cover the guard's grants, its pinned search_path, its owner's EXECUTE on is_controlled_issue_status and its trigger", () => {
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('authenticated', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])");
    expect(tail).toContain("'is_controlled_issue_status(text)', 'EXECUTE'), false)");
    expect(tail).toContain("WHERE t.tgname = 'trg_document_publish_guard' AND NOT t.tgisinternal");
  });

  it("the header states the decision, the paste order (after 20261165, which follows 20261164 / the held 20261159), the never-re-paste list, P16's order, the deploy order, and that it is not a widening", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/DECIDED \(the record's own direction/);
    expect(head).toMatch(/the exit\n-- {11}is NOT made a recorded controller pass/);
    expect(head).toMatch(/HOW TO APPLY: AFTER 20261165 \(required/);
    expect(head).toMatch(/20261165 follows 20261164, which\n-- follows 20261159, itself HELD \(paste guide row 119\)/);
    expect(head).toMatch(/INTK-18/);
    expect(head).toMatch(/DEC-63's P17 Landed line/);
    expect(head).toMatch(/Never re-paste\n-- 20261165, 20261164, 20261159, 20261151, 20261144, 20261139, 20261105 or\n-- any earlier guard migration after this one/);
    expect(head).toMatch(/P16 \(REV-21\) re-creates this guard too: whichever of P16's migration and\n-- this one is pasted second starts from the other's body/);
    expect(head).toMatch(/DEPLOY ORDER: no app deploy is needed before or after this paste/);
    expect(head).toMatch(/The app carrying P19 must already be deployed, as\n-- 20261165 requires/);
    expect(head).toMatch(/NOT a widening/);
  });
});
