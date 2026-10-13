// document-control Round F wave 3 — P25 STATUS-SURFACE FOLLOW-UPS:
// migration 20261192 (REV-29, the database half).
//
//   put_back_retired_issue and restore_reversed_source re-created from their
//   NEWEST earlier bodies (scan — 20261165 and 20261164 today) with EXACTLY
//   the P25 lines added:
//   1. put_back_retired_issue: its blank-status refusal wrapped in
//      `IF p_via = 'unarchive' THEN … END IF;` (the three rollback doors take
//      a NULL or blank status — what the document was), and a second
//      recorded-door block that opens for a NULL status on a rollback door on
//      exactly the first door's conditions (btrim(NULL) NOT IN (…) is NULL,
//      so the first one never opened for it).
//   2. restore_reversed_source: its blank-status refusal wrapped in
//      `IF p_reversal_of IS NULL THEN … END IF;` (the reversal's door — every
//      call the app makes names its event — takes a NULL or blank status).
//   Nothing else is created or re-created; the guard is untouched.
//
// Byte fidelity: lineDiff (nothing removed; every new line is one of the P25
// additions) AND an exact cut (each re-created body minus its additions IS
// its base, byte for byte). The script was run on a throwaway PostgreSQL 16
// (REV-29's record); the rollbacks are driven against the doors'
// transcription in dcRoundFStatusIntoForce.test.ts and
// dcRoundFStatusSurface.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261192_dc_roundF_null_prior_status_put_back.sql";
const M = mig(FILE);
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
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

const PB_HEAD = "CREATE OR REPLACE FUNCTION put_back_retired_issue(";
const RR_HEAD = "CREATE OR REPLACE FUNCTION restore_reversed_source(";
const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
/** The definition each function is re-created from: the newest one BEFORE this file (scanned). */
const baseOf = (head: string) => {
  const defining = files.filter((f) => stripComments(mig(f)).includes(head));
  expect(defining).toContain(FILE);
  return defining[defining.indexOf(FILE) - 1];
};
const PB_BASE = baseOf(PB_HEAD);
const RR_BASE = baseOf(RR_HEAD);
const PB = { live: between(mig(PB_BASE), PB_HEAD, "\n$$;"), next: between(M, PB_HEAD, "\n$$;") };
const RR = { live: between(mig(RR_BASE), RR_HEAD, "\n$$;"), next: between(M, RR_HEAD, "\n$$;") };

/** 20261165's blank-status refusal, unchanged inside the P25 wrapper. */
const PB_BLANK = "  IF btrim(COALESCE(p_status, '')) = '' THEN\n    RAISE EXCEPTION 'put_back_retired_issue: name the status to put the document back to.'\n      USING ERRCODE = 'check_violation';\n  END IF;\n";
/** 20261164's blank-status refusal, unchanged inside the P25 wrapper. */
const RR_BLANK = "  IF btrim(COALESCE(p_status, '')) = '' THEN\n    RAISE EXCEPTION 'restore_reversed_source: name the status to restore the document to.'\n      USING ERRCODE = 'check_violation';\n  END IF;\n";
/** 20261165's recorded door — its first block, unchanged; the P25 NULL door follows it. */
const PB_DOOR = "  IF COALESCE(p_force_hold, false)\n     AND v_status = (CASE WHEN p_via = 'unarchive' THEN 'Archived' ELSE 'Superseded' END)\n     AND (p_via = 'unarchive' OR v_retired_by = v_uid)\n     AND v_stamped IS NOT NULL\n     AND v_stamped = v_version\n     AND btrim(p_status) NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')\n     AND is_org_controller(v_org)\n     AND EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN\n    v_forced := true;\n  END IF;\n";

/** The P25 additions, as contiguous text cut from the re-created bodies. */
const PB_WRAP_OPEN = PB.next.slice(PB.next.indexOf("  -- REV-29 (document-control Round F wave 3, P25): a rollback puts back what"), PB.next.indexOf(PB_BLANK));
const PB_NULL_DOOR = PB.next.slice(PB.next.indexOf("  -- REV-29 (P25): the recorded door for a NULL status."), PB.next.indexOf("  -- The put-back: the app's own write for this door, as the caller."));
const RR_WRAP_OPEN = RR.next.slice(RR.next.indexOf("  -- REV-29 (document-control Round F wave 3, P25): the reversal restores the"), RR.next.indexOf(RR_BLANK));
const WRAP_CLOSE = "  END IF;\n";

const NULL_DOOR_CODE = [
  "  IF NOT v_forced",
  "     AND p_status IS NULL",
  "     AND p_via <> 'unarchive'",
  "     AND COALESCE(p_force_hold, false)",
  "     AND v_status = 'Superseded'",
  "     AND v_retired_by = v_uid",
  "     AND v_stamped IS NOT NULL",
  "     AND v_stamped = v_version",
  "     AND is_org_controller(v_org)",
  "     AND EXISTS (SELECT 1 FROM document_holds h",
  "                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN",
  "    v_forced := true;",
  "  END IF;",
];

describe("20261192 — the two doors re-created from their NEWEST earlier bodies (found by scanning)", () => {
  it("the bases are the newest earlier definitions (today 20261165 and 20261164 — the scan, not this comment, decides)", () => {
    expect(PB_BASE < FILE && RR_BASE < FILE).toBe(true);
    expect(PB_BASE >= "20261165_dc_roundF_stamped_put_back.sql").toBe(true);
    expect(RR_BASE >= "20261164_dc_roundF_reversal_restore.sql").toBe(true);
    // the guard is not re-created here
    expect(stripComments(M)).not.toContain(GUARD_HEAD);
  });

  it("put_back_retired_issue: nothing removed, every new line a P25 addition, and the body minus them IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(PB.live, PB.next);
    expect(onlyInA).toEqual([]);
    const added = [...PB_WRAP_OPEN.split("\n"), ...PB_NULL_DOOR.split("\n")];
    for (const l of onlyInB) expect(added, l).toContain(l);
    expect(PB_WRAP_OPEN.length).toBeGreaterThan(400);
    expect(PB_NULL_DOOR.length).toBeGreaterThan(400);
    // the exact cut: the wrapper around the base's refusal, and the NULL door right after the base's door
    expect(PB.next).toContain(PB_WRAP_OPEN + PB_BLANK + WRAP_CLOSE + "\n  -- The document, as the caller sees it.");
    expect(PB.next).toContain(PB_DOOR + "\n" + PB_NULL_DOOR);
    const cut = PB.next.replace(PB_WRAP_OPEN + PB_BLANK + WRAP_CLOSE, PB_BLANK).replace(PB_DOOR + "\n" + PB_NULL_DOOR, PB_DOOR + "\n");
    expect(cut).toBe(PB.live);
  });

  it("restore_reversed_source: nothing removed, every new line a P25 addition, and the body minus them IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(RR.live, RR.next);
    expect(onlyInA).toEqual([]);
    for (const l of onlyInB) expect(RR_WRAP_OPEN.split("\n"), l).toContain(l);
    expect(RR_WRAP_OPEN.length).toBeGreaterThan(400);
    expect(RR.next).toContain(RR_WRAP_OPEN + RR_BLANK + WRAP_CLOSE + "\n  -- The document, as the caller sees it.");
    expect(RR.next.replace(RR_WRAP_OPEN + RR_BLANK + WRAP_CLOSE, RR_BLANK)).toBe(RR.live);
  });

  it("the added code is exactly: the un-archive-only refusal, the NULL door (a rollback door only, the first door's conditions, after it), and the event-less-only refusal", () => {
    expect(code(PB_WRAP_OPEN.split("\n"))).toEqual(["  IF p_via = 'unarchive' THEN"]);
    expect(code(RR_WRAP_OPEN.split("\n"))).toEqual(["  IF p_reversal_of IS NULL THEN"]);
    expect(code(PB_NULL_DOOR.split("\n"))).toEqual(NULL_DOOR_CODE);
    // the NULL door: every condition of the first door's rollback branch but the issue test (which a NULL fails), and nothing else
    const door = code(PB_DOOR.split("\n")).join("\n");
    for (const c of ["AND v_stamped IS NOT NULL", "AND v_stamped = v_version", "AND is_org_controller(v_org)", "AND EXISTS (SELECT 1 FROM document_holds h"]) {
      expect(door, c).toContain(c);
      expect(NULL_DOOR_CODE.join("\n"), c).toContain(c);
    }
    expect(NULL_DOOR_CODE.join("\n")).not.toMatch(/btrim|set_config|current_setting|RAISE/);
    // the flag is set and cleared exactly as before — around the one write, on v_forced
    const n = (s: string, w: RegExp) => (stripComments(s).match(w) ?? []).length;
    for (const [a, b] of [[PB.live, PB.next], [RR.live, RR.next]]) {
      expect(n(b, /set_config\('app\.publish_hold_override'/g)).toBe(n(a, /set_config\('app\.publish_hold_override'/g));
      expect(n(b, /UPDATE documents/g)).toBe(n(a, /UPDATE documents/g));
      expect(n(b, /RAISE EXCEPTION/g)).toBe(n(a, /RAISE EXCEPTION/g));
      expect(b.slice(0, b.indexOf("BEGIN\n"))).toBe(a.slice(0, a.indexOf("BEGIN\n"))); // signature, SECURITY INVOKER, declarations unchanged
    }
    expect(n(PB.next, /v_forced := true;/g)).toBe(n(PB.live, /v_forced := true;/g) + 1);
  });

  it("the blank-status refusals are the sentences the app answers (lib/revisions.ts, lib/documentLifecycle/reverse.ts)", () => {
    expect(src("lib/revisions.ts")).toContain('export const PUT_BACK_BLANK_STATUS_REFUSAL = "put_back_retired_issue: name the status to put the document back to.";');
    expect(src("lib/documentLifecycle/reverse.ts")).toContain('export const RESTORE_BLANK_STATUS_REFUSAL = "restore_reversed_source: name the status to restore the document to.";');
    expect(PB_BLANK).toContain("'put_back_retired_issue: name the status to put the document back to.'");
    expect(RR_BLANK).toContain("'restore_reversed_source: name the status to restore the document to.'");
  });

  it("DRLS-16: each stays SECURITY INVOKER with search_path pinned, authenticated only (PUBLIC, anon and service_role revoked), a session required; nothing dropped, no policy or trigger, no row written by the script", () => {
    for (const b of [PB.next, RR.next]) {
      expect(b).toMatch(/\) RETURNS text\nLANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS \$\$/);
      expect(b).not.toMatch(/SECURITY DEFINER/);
      expect(b).toContain("  IF v_uid IS NULL THEN\n    RAISE EXCEPTION");
    }
    expect(M).toContain("REVOKE ALL ON FUNCTION put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text) FROM PUBLIC, anon, service_role;\nGRANT EXECUTE ON FUNCTION put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text) TO authenticated;");
    expect(M).toContain("REVOKE ALL ON FUNCTION restore_reversed_source(uuid, text, uuid, text) FROM PUBLIC, anon, service_role;\nGRANT EXECUTE ON FUNCTION restore_reversed_source(uuid, text, uuid, text) TO authenticated;");
    const body = stripComments(M);
    expect(body).not.toMatch(/DROP FUNCTION/);
    expect((body.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(2);
    expect(body).not.toMatch(/CREATE (?:POLICY|TRIGGER)|ALTER TABLE/);
    // outside the two function bodies the script writes no row (DEC-77 §2: nothing is moved)
    const outside = body.replace(stripComments(PB.next), "").replace(stripComments(RR.next), "").replace(/'(?:[^']|'')*'/g, "''");
    expect(outside).not.toMatch(/\bUPDATE\s+documents\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b/i);
  });
});

describe("20261192 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'put_back_retired_issue' AND pronargs = 9");
    expect(pre).toBeGreaterThan(0);
    expect(M).toContain("RAISE EXCEPTION '20261192 needs 20261165 (put_back_retired_issue) and 20261164 (restore_reversed_source) pasted first; nothing was changed.';");
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_f_192_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_192_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(4);
    expect((inventory.match(/\)::text;/g) ?? []).length).toBe(1); // the fifth row: the two re-paste counts, summed
    expect(inventory).not.toMatch(/SELECT \*|document_number|title|d\.id\s+AS|user_email/);
    const labels = [...inventory.matchAll(/^SELECT '(inventory \(before apply\): (?:[^']|'')*)'/gm)].map((m) => m[1]);
    expect(labels).toHaveLength(5);
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1); // one statement: the final SELECT
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_f_192_before;");
  });

  it("the prerequisite passes on the bases (20261165, 20261164) and on this file (idempotent), and refuses without them", () => {
    const pre = M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE"));
    const pats = [...pre.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(pats).toHaveLength(3);
    const [pbBlank, pbDoor, rrBlank] = pats;
    for (const p of pats) expect(p).not.toMatch(/::/);
    for (const b of [PB.live, PB.next]) {
      expect(likeRe(pbBlank).test(prosrcOf(b))).toBe(true);
      expect(likeRe(pbDoor).test(prosrcOf(b))).toBe(true);
    }
    for (const b of [RR.live, RR.next]) expect(likeRe(rrBlank).test(prosrcOf(b))).toBe(true);
    // with either function missing (a database before 20261165 / 20261164) the NOT EXISTS raises before anything runs
    expect(pre).toContain("OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restore_reversed_source' AND pronargs = 4");
  });

  it("every prosrc LIKE / NOT LIKE probe matches the body of the function it names (prosrc verbatim), and none carries a cast; the P25 probes are FALSE on the bases", () => {
    const newest = (head: string) => {
      const f = files.filter((x) => x <= FILE && stripComments(mig(x)).includes(head)).pop()!;
      return between(mig(f), head, "\n$$;");
    };
    const bodies: Record<string, string> = {
      put_back_retired_issue: PB.next,
      restore_reversed_source: RR.next,
      enforce_document_publish_guard: newest(GUARD_HEAD),
    };
    const bases: Record<string, string> = { put_back_retired_issue: PB.live, restore_reversed_source: RR.live };
    let n = 0;
    const p25: Array<[string, string]> = [];
    for (const seg of tail.split(/\nUNION ALL\n/)) {
      const isP25 = /(?:^|\n)SELECT 'REV-29 \(P25\)/.test(seg);
      for (const sub of seg.split(/\(SELECT (?=prosrc)/)) {
        const fn = /FROM pg_proc WHERE proname = '(\w+)'/.exec(sub)?.[1];
        for (const m of sub.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
          expect(fn, sub.slice(0, 80)).toBeDefined();
          const pat = m[2].replace(/''/g, "'");
          expect(pat, pat).not.toMatch(/::/);
          const body = bodies[fn!];
          expect(body, fn).toBeDefined();
          expect(likeRe(pat).test(prosrcOf(body)), `${fn}: ${pat}`).toBe(m[1] ? false : true);
          if (isP25 && !m[1] && /IF p_via = 'unarchive' THEN|IF NOT v_forced|IF p_reversal_of IS NULL THEN/.test(pat)) p25.push([fn!, pat]);
          n += 1;
        }
      }
    }
    expect(n).toBe(14); // 1 + 1 + 6 (REV-23 survives) + 4 (restore_reversed_source) + 2 (the guard)
    // the P25 probes read false on the bases, so a paste that did not land reads false
    expect(p25.map(([fn]) => fn)).toEqual(["put_back_retired_issue", "put_back_retired_issue", "restore_reversed_source"]);
    for (const [fn, pat] of p25) expect(likeRe(pat).test(prosrcOf(bases[fn])), pat).toBe(false);
  });

  it("the probes cover each function's grants, its pinned search_path and SECURITY INVOKER, and the guard left untouched", () => {
    expect(tail).toContain("AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AND p.proacl IS NOT NULL)");
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text)', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('service_role', 'restore_reversed_source(uuid, text, uuid, text)', 'EXECUTE')");
    expect(tail).toContain("AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'"); // PUBLIC holds no EXECUTE on either
    expect(tail).toContain("-- Probes: ok = true × 6. Inventory rows: n = the aggregate count.");
    expect(tail.split(/\nUNION ALL\n/).filter((s) => /AS ok,|^SELECT '/.test(s) && !/FROM dc_round_f_192_before/.test(s))).toHaveLength(6);
  });

  it("the header states the finding, the decision, the paste order (app deployed → this file → 20261185 → 20261193), its prerequisites, the app before and after, that it is a narrow widening, and the never-re-paste of its bases", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/REV-29 {2}A rollback is meant to put back the status a document held before/);
    expect(head).toMatch(/HOW TO APPLY: the app carrying P25 is deployed FIRST/);
    expect(head).toMatch(/Then paste THIS file, BEFORE 20261185/);
    expect(head).toMatch(/It\n-- needs 20261165 and 20261164 \(the two functions it re-creates\)/);
    expect(head).toMatch(/⚠ Never re-paste 20261165 or 20261164 after this file/);
    expect(head).toMatch(/A NARROW WIDENING \(DEC-30: inventory before apply\)/);
    expect(head).toMatch(/THE APP BEFORE AND AFTER THIS PASTE/);
    expect(head).toMatch(/RE-CREATED FROM THE NEWEST BODIES/);
    // the paste order 20261193 names agrees
    expect(mig("20261193_dc_roundF_ifc_rev_up_first_issue.sql")).toMatch(/the\n-- app carrying P25 deployed, then 20261192, then 20261185 \(after 20261182\),\n-- then THIS file\./);
  });
});
