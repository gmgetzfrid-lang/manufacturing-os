// document-control Round F wave 3 — P16 STATUS-GUARD FOLLOW-UPS:
// migration 20261185 (REV-21 — the database limb of DEC-77 §4, ratified by
// the integrator under the user's delegation, 2026-10-07: DEC-90 A3, option 1).
//
//   enforce_document_publish_guard re-created from its NEWEST earlier body
//   (scan — 20261182 today) with EXACTLY the two P16 blocks added:
//   1. v_issuing also holds for a status-only move INTO Issued / Locked out
//      of an issue status outside them (IFC, an empty status, a case or
//      spacing variant, a library's own), on a document with a current
//      revision. It is then judged by the rules every status-only issue
//      already meets — the new door's hold (for everyone), the require limb,
//      the publisher tier — none of which changes.
//   2. (review fix) the same move out of a retirement stamped with such a
//      status (IFC -> Archived -> Issued): not v_restoring (the require limb
//      decides it) and the new door (refused over a hold for everyone,
//      whatever flag is set). A put-back to the stamped status is unchanged.
//   Nothing else is re-created or created; no data is moved.
//
// Byte fidelity: lineDiff (nothing removed; every new line is an addition)
// AND an exact cut (the re-created body minus the two additions IS the base,
// byte for byte). The script was run on a throwaway PostgreSQL 16 (REV-21's
// record); the rule is driven against the guard's transcription and the
// real editors in dcRoundFStatusIntoForce.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { IN_FORCE_STATUSES } from "@/lib/verifyVerdict";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261185_dc_roundF_status_into_force_issue.sql";
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

/** 20261144's v_issuing (REV-18), the statement the P16 block follows. */
const ISSUING_BASE = "  v_issuing := NEW.current_version_id IS NOT NULL\n               AND NOT is_controlled_issue_status(OLD.status)\n               AND is_controlled_issue_status(NEW.status);\n";
/** The new door, computed from v_issuing — the statement the P16 block precedes. */
const NEW_DOOR_HEAD = "  v_new_door := v_issuing\n                AND (NOT COALESCE(v_advancing, false)\n";
/** The guard's first addition (the direct move), as contiguous text. */
const G_LIMB = G.next.slice(
  G.next.indexOf("  -- REV-21 (document-control Round F wave 3, P16; DEC-77 §4, ratified by"),
  G.next.indexOf(NEW_DOOR_HEAD),
);
/** 20261144's v_restoring (REV-18), the statement the second P16 block follows. */
const RESTORING_BASE = "  v_restoring := COALESCE(v_issuing\n                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                 AND OLD.retired_issue_version_id IS NOT NULL\n                 AND NEW.current_version_id = OLD.retired_issue_version_id\n                 AND NEW.current_version_id = OLD.current_version_id, false);\n";
/** P19's comment over its v_restoring limb — the text the second P16 block precedes. */
const REV23_HEAD = "  -- REV-23 (document-control Round F wave 3, P19): the STAMPED put-back\n";
/** The guard's second addition (the same move out of a retirement), as contiguous text. */
const G_EXIT = G.next.slice(
  G.next.indexOf("  -- REV-21 (document-control Round F wave 3, P16 review fix): the same move"),
  G.next.indexOf(REV23_HEAD),
);
const EXIT_CODE = [
  "  v_restoring := v_restoring",
  "                 AND NOT COALESCE(NEW.status IN ('Issued', 'Locked')",
  "                                  AND COALESCE(OLD.retired_issue_status, '') NOT IN ('Issued', 'Locked'), false);",
  "  v_new_door := v_new_door",
  "                OR COALESCE(v_issuing",
  "                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id",
  "                            AND OLD.status IN ('Superseded', 'Archived', 'Void')",
  "                            AND OLD.retired_issue_version_id IS NOT NULL",
  "                            AND COALESCE(OLD.retired_issue_status, '') NOT IN ('Issued', 'Locked')",
  "                            AND NEW.status IN ('Issued', 'Locked'), false);",
];
const LIMB_CODE = [
  "  v_issuing := v_issuing",
  "               OR COALESCE(NEW.current_version_id IS NOT NULL",
  "                           AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id",
  "                           AND is_controlled_issue_status(OLD.status)",
  "                           AND COALESCE(OLD.status, '') NOT IN ('Issued', 'Locked')",
  "                           AND NEW.status IN ('Issued', 'Locked'), false);",
];
/** P21's two limbs (20261182), the base's newest. */
const P21_I = "  v_unforced_move := v_unforced_move\n                     OR COALESCE(OLD.current_version_id IS NULL\n                                 AND NEW.current_version_id IS NOT NULL\n                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                                 AND is_org_controller(NEW.org_id), false);\n";
const P21_II = "  v_unforced_move := v_unforced_move\n                     OR COALESCE(OLD.current_version_id IS NOT NULL\n                                 AND NEW.current_version_id IS NULL\n                                 AND is_controlled_issue_status(OLD.status)\n                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                                 AND is_org_controller(NEW.org_id), false);\n";
const P20_A = "  v_new_door := v_new_door\n                OR COALESCE(v_issuing\n                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                            AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                            AND OLD.retired_issue_version_id IS NOT NULL\n                            AND OLD.retired_issue_version_id IS DISTINCT FROM OLD.current_version_id, false);\n";
const P19_LIMB = "  v_new_door := v_new_door\n                OR COALESCE(v_restoring\n                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                            AND is_org_controller(NEW.org_id), false);\n";
const P17_MOVE = "  v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                              AND is_controlled_issue_status(OLD.status)\n                              AND is_controlled_issue_status(NEW.status)\n                              AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                              AND is_org_controller(NEW.org_id), false);\n";
const REV17_BLOCK = "      IF OLD.current_version_id IS NULL AND v_intake_link IS NULL\n         AND COALESCE(NEW.status, '') NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')\n         AND NOT is_org_controller(NEW.org_id)\n";
const NEW_DOOR_HOLD_SQL = "'Document has an active hold; release the hold before issuing it.'";
const REQUIRE_SQL = "'This library requires reviewer sign-off, so a revision that was not reviewed can''t be made a controlled issue; submit it for review, or ask Document Control.'";

describe("20261185 — the guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261182 — the scan, not this comment, decides), and every earlier limb survives", () => {
    expect(defining).toContain(FILE);
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261182_dc_roundF_first_pointer_hold_limb.sql").toBe(true);
    // the base carries P21's two limbs (the prerequisite this file checks for)
    expect(G.live).toContain(P21_I);
    expect(G.live).toContain(P21_II);
    for (const limb of [P21_I, P21_II, P20_A, P19_LIMB, P17_MOVE, REV17_BLOCK, ISSUING_BASE, NEW_DOOR_HEAD,
      "  v_unforced_issue := COALESCE(v_issuing\n", "  v_restoring := COALESCE(v_issuing\n", "  v_advancing := v_advancing OR v_issuing;\n"]) {
      expect(G.next, limb.slice(0, 60)).toContain(limb);
    }
  });

  it("nothing removed, every new line is one of the two P16 blocks, and the body minus them IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    const added = [...G_LIMB.split("\n"), ...G_EXIT.split("\n")];
    for (const l of onlyInB) expect(added, l).toContain(l);
    expect(G_LIMB.length).toBeGreaterThan(400);
    expect(G_EXIT.length).toBeGreaterThan(400);
    expect(G.next.split(G_LIMB).length).toBe(2);
    expect(G.next.split(G_EXIT).length).toBe(2);
    expect(G.next.replace(G_LIMB, "").replace(G_EXIT, "")).toBe(G.live);
  });

  it("the added code is exactly the REV-21 limb of v_issuing — right after 20261144's v_issuing and before the new door is computed from it", () => {
    expect(code(G_LIMB.split("\n"))).toEqual(LIMB_CODE);
    expect(G.next).toContain(ISSUING_BASE + G_LIMB + NEW_DOOR_HEAD);
    // no declaration, no refusal of its own, no other variable touched
    expect(G.next.slice(0, G.next.indexOf("BEGIN\n"))).toBe(G.live.slice(0, G.live.indexOf("BEGIN\n")));
    expect(G_LIMB).not.toMatch(/RAISE/);
    const count = (s: string, w: RegExp) => (stripComments(s).match(w) ?? []).length;
    // block 1 adds two v_issuing; block 2 one more, two v_restoring and two v_new_door
    expect(count(G.next, /v_issuing/g)).toBe(count(G.live, /v_issuing/g) + 3);
    expect(count(G.next, /v_restoring/g)).toBe(count(G.live, /v_restoring/g) + 2);
    expect(count(G.next, /v_new_door/g)).toBe(count(G.live, /v_new_door/g) + 2);
    for (const v of [/v_advancing/g, /v_unforced_move/g, /v_unforced_issue/g, /RAISE EXCEPTION/g]) {
      expect(count(G.next, v), String(v)).toBe(count(G.live, v));
    }
  });

  it("the second block is exactly the retirement exit — right after 20261144's v_restoring, before P19's limb reads it: v_restoring narrowed, the new door widened, nothing else", () => {
    expect(code(G_EXIT.split("\n"))).toEqual(EXIT_CODE);
    expect(G.next).toContain(RESTORING_BASE + G_EXIT + REV23_HEAD);
    expect(G_EXIT).not.toMatch(/RAISE|current_setting|is_org_controller/);
    const exit = code(G_EXIT.split("\n")).join("\n");
    // the in-force pair, read from the SQL, is lib/verifyVerdict.ts IN_FORCE_STATUSES — four times (target and stamp, in each statement)
    const lists = [...exit.matchAll(/IN \('(?:Issued|Superseded)[^)]*\)/g)].map((m) => m[0]);
    const pairs = lists.filter((l) => !l.includes("Superseded")).map((l) => l.slice(4, -1).split(",").map((x) => x.trim().replace(/^'|'$/g, "")));
    expect(pairs).toHaveLength(4);
    for (const p of pairs) expect(p).toEqual([...IN_FORCE_STATUSES]);
    // v_restoring only ever narrows (AND NOT …, COALESCEd), and only for a put-back INTO the pair of a stamp outside it (a NULL stamp is outside it)
    expect(exit).toContain("  v_restoring := v_restoring\n                 AND NOT COALESCE(NEW.status IN ('Issued', 'Locked')\n                                  AND COALESCE(OLD.retired_issue_status, '') NOT IN ('Issued', 'Locked'), false);");
    // the new door only ever widens (OR …, COALESCEd), status-only, out of a retirement whose stamp names a revision, with no flag and no tier read: it binds everyone
    expect(exit).toContain("  v_new_door := v_new_door\n                OR COALESCE(v_issuing\n                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                            AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                            AND OLD.retired_issue_version_id IS NOT NULL\n");
    // an unstamped retirement (no revision in the stamp) keeps REV-20's / REV-22's limbs — the base's, unchanged
    expect(G.live).toContain("                            AND OLD.status IN ('Archived', 'Void')\n                            AND OLD.retired_issue_status IS NULL\n                            AND is_org_controller(NEW.org_id), false);");
    // and the require limb still reads v_restoring (now narrowed) — unchanged text
    expect(G.next).toContain("    IF NOT is_org_controller(NEW.org_id)\n       AND NOT v_restoring\n");
    expect(G.next.indexOf(G_EXIT)).toBeLessThan(G.next.indexOf("  v_new_door := v_new_door\n                OR COALESCE(v_restoring\n"));
  });

  it("the limb is status-only, needs a current revision, and moves an issue status outside the in-force pair INTO it — the pair read from the SQL is lib/verifyVerdict.ts IN_FORCE_STATUSES", () => {
    const limb = code(G_LIMB.split("\n")).join("\n");
    const lists = [...limb.matchAll(/IN \(([^)]*)\)/g)].map((m) => m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")));
    expect(lists).toHaveLength(2);
    for (const l of lists) expect(l).toEqual([...IN_FORCE_STATUSES]);
    // status-only: the pointer unmoved, and there is one (a register row has nothing to put in force)
    expect(limb).toContain("NEW.current_version_id IS NOT NULL\n                           AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id");
    // out of an issue status (Draft / In Review / a retirement is v_issuing already) other than the pair; a NULL OLD status is outside the pair
    expect(limb).toContain("AND is_controlled_issue_status(OLD.status)\n                           AND COALESCE(OLD.status, '') NOT IN ('Issued', 'Locked')");
    // INTO the pair, compared exactly as the gates compare (no trim: " Issued" is not in force there); a NULL NEW status is not
    expect(limb).toContain("AND NEW.status IN ('Issued', 'Locked'), false);");
    expect(limb).not.toMatch(/btrim|lower\(|upper\(|ILIKE/);
    // it widens v_issuing only (never narrows it): OR, COALESCEd to false
    expect(limb.startsWith("  v_issuing := v_issuing\n               OR COALESCE(")).toBe(true);
  });

  it("the move is judged as every status-only issue already is (unchanged text): the new door from v_issuing, the issue block's hold / require limb, the controller return, the publisher tier", () => {
    const at = (s: string) => G.next.indexOf(s);
    const order = [
      ISSUING_BASE + G_LIMB + NEW_DOOR_HEAD,
      "  v_advancing := v_advancing OR v_issuing;\n",
      "  IF NOT v_advancing THEN\n    RETURN NEW;\n  END IF;",
      "  IF v_issuing THEN\n    IF v_new_door AND EXISTS (",
      NEW_DOOR_HOLD_SQL,
      "    IF NOT is_org_controller(NEW.org_id)\n       AND NOT v_restoring\n",
      REQUIRE_SQL,
      "  IF is_org_controller(NEW.org_id) THEN\n    RETURN NEW;\n  END IF;",
      "'You do not have authority to publish revisions in this library.'",
      "'Document has an active hold; release the hold before publishing a new revision.'",
    ];
    let prev = -1;
    for (const s of order) {
      const i = at(s);
      expect(i, s.slice(0, 60)).toBeGreaterThan(prev);
      prev = i;
    }
    // a status-only write never meets the review gate (it needs a pointer move) — unchanged
    expect(G.next).toContain("  IF NEW.current_version_id IS NOT NULL\n     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN\n    -- The version match tolerates");
  });

  it("DRLS-16: the guard is executable by no client role; SECURITY DEFINER with its search_path pinned; nothing dropped, nothing else created", () => {
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(G.next).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    const body = stripComments(M);
    expect(body).not.toMatch(/DROP FUNCTION/);
    expect((body.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/CREATE (?:POLICY|TRIGGER)|GRANT |ALTER TABLE/);
    // no data is moved (DEC-77 §2): the script UPDATEs / INSERTs / DELETEs no row
    expect(body.replace(/'(?:[^']|'')*'/g, "''")).not.toMatch(/\bUPDATE\s+documents\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b/i);
  });

  it("the flag in the whole sequence is still SET only by 20261151, 20261164 and 20261165 — this file only reads it", () => {
    const withoutFlagReads = (sql: string) => sql
      .split("current_setting('app.publish_hold_override', true)").join("")
      .split("current_setting(''app.publish_hold_override'', true)").join("");
    const setters = files.filter((f) => /publish_hold_override/.test(withoutFlagReads(stripComments(mig(f)))));
    expect(setters).toEqual([
      "20261151_dc_roundF_promote_transaction_and_hold_override.sql",
      "20261164_dc_roundF_reversal_restore.sql",
      "20261165_dc_roundF_stamped_put_back.sql",
    ]);
    expect(stripComments(M).replace(/'(?:[^']|'')*'/g, "''")).not.toMatch(/set_config|SET LOCAL/);
  });
});

describe("20261185 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'");
    expect(pre).toBeGreaterThan(0);
    expect(M).toContain("RAISE EXCEPTION '20261185 needs 20261182 (the REV-25 first-pointer-write hold limb in the publish guard) pasted first; nothing was changed.';");
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_f_185_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_185_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(5);
    expect(inventory).not.toMatch(/SELECT \*|document_number|title|d\.id\s+AS|user_email/);
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1); // one statement: the final SELECT
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_f_185_before;");
  });

  it("the inventory's population is the limb's (a current revision, an issue status outside the in-force pair), IFC is counted exactly as 20261134 / VFY-20 count it, and the roster count is 20261144's, byte for byte", () => {
    const inv = M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;"));
    expect(inv).toContain("   WHERE d.current_version_id IS NOT NULL\n     AND is_controlled_issue_status(d.status)\n     AND COALESCE(d.status, '') NOT IN ('Issued', 'Locked')\n");
    expect(inv).toContain("  SELECT d.status = 'IFC' AS is_ifc,");
    expect(mig("20261134_ps_roundF_verify_scans.sql")).toContain("WHERE current_version_id IS NOT NULL AND status = 'IFC'");
    for (const w of ["  FROM outside\n", "  FROM outside WHERE is_ifc\n", "  FROM outside WHERE held\n", "  FROM outside WHERE under_require AND NOT roster_complete\n"]) {
      expect(inv, w).toContain(w);
    }
    // row 5 (review fix): the retirements whose put-back into the pair the second block judges — the block's own population
    expect(inv).toContain("  FROM documents d\n WHERE d.status IN ('Superseded', 'Archived', 'Void')\n   AND d.retired_issue_version_id IS NOT NULL\n   AND COALESCE(d.retired_issue_status, '') NOT IN ('Issued', 'Locked');");
    // the require read is the guard's own (the chain OR the document's own policy — DEC-71)
    expect(inv).toContain("(review_control_mode_for(NULL, d.collection_id, d.library_id) = 'require'\n          OR review_control_mode_for(d.review_control, d.collection_id, d.library_id) = 'require') AS under_require");
    const rosterOf = (sql: string) => stripComments(between(sql, "WITH slot_fill AS (", "HAVING sum(reqs) > 0 AND sum(LEAST(reqs, filled)) >= sum(reqs)"))
      .split("\n").filter((l) => l.trim() !== "").join("\n");
    expect(rosterOf(inv)).toBe(rosterOf(mig("20261144_dc_roundF_status_issue_transition.sql")));
  });

  it("the prerequisite passes on 20261182's guard (P21's limbs, with put_back_retired_issue) and on this one (idempotent), and refuses on 20261174's, 20261165's and 20261164's", () => {
    const pat = /prosrc LIKE '((?:[^']|'')*)'\)/.exec(M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE")))![1].replace(/''/g, "'");
    expect(pat).not.toMatch(/::/);
    const re = likeRe(pat);
    const guardOf = (f: string) => prosrcOf(between(mig(f), GUARD_HEAD, "\n$$;"));
    expect(re.test(guardOf("20261182_dc_roundF_first_pointer_hold_limb.sql"))).toBe(true);
    expect(re.test(prosrcOf(G.next))).toBe(true);
    for (const f of ["20261174_dc_roundF_retired_hold_limbs.sql", "20261165_dc_roundF_stamped_put_back.sql", "20261164_dc_roundF_reversal_restore.sql"]) {
      expect(re.test(guardOf(f)), f).toBe(false);
    }
    expect(M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE"))).toContain("OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'put_back_retired_issue') THEN");
  });

  it("every prosrc LIKE / NOT LIKE probe matches the body of the function it names (prosrc verbatim), and none carries a cast; the P16 limb's probe is FALSE on the base", () => {
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
    const p16: string[] = [];
    const p16Exit: string[] = [];
    for (const seg of tail.split(/\nUNION ALL\n/)) {
      const isP16 = /(?:^|\n)SELECT 'REV-21 \(P16\)/.test(seg);
      const isP16Exit = /(?:^|\n)SELECT 'REV-21 \(P16 review fix\)/.test(seg);
      for (const sub of seg.split(/\(SELECT (?=prosrc)/)) {
        const fn = /FROM pg_proc WHERE proname = '(\w+)'/.exec(sub)?.[1];
        for (const m of sub.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
          expect(fn, sub.slice(0, 80)).toBeDefined();
          const pat = m[2].replace(/''/g, "'");
          expect(pat, pat).not.toMatch(/::/);
          const body = bodies[fn!];
          expect(body, fn).toBeDefined();
          expect(likeRe(pat).test(prosrcOf(body)), `${fn}: ${pat}`).toBe(m[1] ? false : true);
          if (isP16 && /^%v_issuing := v_issuing%/.test(pat)) p16.push(pat);
          if (isP16Exit) p16Exit.push(pat);
          n += 1;
        }
      }
    }
    expect(n).toBe(23);
    // the limbs' probes are false on the base (20261182), so a paste that did not land reads false
    expect(p16).toHaveLength(1);
    expect(p16Exit).toHaveLength(1);
    for (const pat of [...p16, ...p16Exit]) expect(likeRe(pat).test(prosrcOf(G.live)), pat).toBe(false);
    // …and the second places its block after v_restoring is computed and before P19's limb reads it
    expect(p16Exit[0]).toMatch(/^%v_restoring := COALESCE\(v_issuing%v_restoring := v_restoring%/);
    expect(p16Exit[0]).toMatch(/%v_new_door := v_new_door%OR COALESCE\(v_restoring%$/);
    // …and it places the limb before the new door is computed (the order the probe checks is the order in the body)
    expect(p16[0]).toMatch(/AND NEW\.status IN \('Issued', 'Locked'\), false\);%v_new_door := v_issuing%$/);
  });

  it("the probes cover the guard's grants, its pinned search_path, its owner's EXECUTE on is_controlled_issue_status and its trigger — BEFORE UPDATE only", () => {
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('authenticated', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])");
    expect(tail).toContain("'is_controlled_issue_status(text)', 'EXECUTE'), false)");
    expect(tail).toContain("AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 4) = 0),");
    expect(tail).toContain("-- Probes: ok = true × 9. Inventory rows: n = the aggregate count.");
    expect(tail.split(/\nUNION ALL\n/).filter((s) => /AS ok,|^SELECT '/.test(s) && !/FROM dc_round_f_185_before/.test(s))).toHaveLength(9);
  });

  it("the header states the finding, the retirement exit, the decision (status-only) and its remainder, the paste order (after 20261182, behind the held 20261159), the never-re-paste list, the deploy order and the one app result that changes, and that it is not a widening", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/REV-21 {2}20261144's v_issuing decides a status-only issue/);
    expect(head).toMatch(/DEC-77 §4, ratified by the integrator under the user's delegation,\n-- 2026-10-07: DEC-90 A3, option 1; no IFC row is moved/);
    expect(head).toMatch(/DECIDED — status-only, as ratified: a write that ALSO moves the\n-- {11}pointer is not this limb\./);
    expect(head).toMatch(/THE SAME MOVE OUT OF A RETIREMENT \(P16 review fix\)/);
    expect(head).toMatch(/REV-28, for the\n-- {11}integrator \(or the user\) to decide\./);
    expect(head).toMatch(/HOW TO APPLY: AFTER 20261182 \(required/);
    expect(head).toMatch(/20261182 follows 20261174 \/ 20261165 \/ 20261164 \/\n-- 20261159, the last HELD \(paste guide row 119\)/);
    expect(head).toMatch(/INTK-18/);
    expect(head).toMatch(/Never\n-- re-paste 20261182, 20261174, 20261165, 20261164, 20261159, 20261151,\n-- 20261144, 20261139, 20261105 or any earlier guard migration after this\n-- one/);
    expect(head).toMatch(/DEPLOY ORDER: none — no app deploy is needed before or after this paste\./);
    expect(head).toMatch(/ONE APP RESULT\n-- CHANGES, from the retirement exit/);
    expect(head).toMatch(/document-control REV-27/);
    expect(head).toMatch(/NOT a widening/);
    expect(head).toMatch(/RE-CREATED FROM THE NEWEST BODY/);
  });
});
