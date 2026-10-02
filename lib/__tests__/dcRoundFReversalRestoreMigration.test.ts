// document-control Round F wave 3 — P18 RECORDED REVERSAL RESTORE:
// migration 20261164 (REV-22, done-when 2).
//
//   enforce_document_publish_guard re-created from its NEWEST earlier body
//   (scan — 20261159 today) with EXACTLY the P18 block added: a controller's
//   exit of an UNSTAMPED Superseded document into an issue status, its
//   pointer unmoved, without the recorded-restore flag naming the document,
//   is the new door (refused over an active hold). restore_reversed_source
//   (new, SECURITY INVOKER) is the legacy reversal's put-back: the same
//   write restoreStatus made, under the transaction-local flag only for
//   Document Control's put-back of a held source of the recorded split /
//   merge it names, recorded as REV_HOLD_OVERRIDDEN in the same transaction.
//
// Byte fidelity: lineDiff (nothing removed; every new line is an addition)
// AND an exact cut (the re-created body minus the addition IS the base, byte
// for byte). The script was run on a throwaway PostgreSQL 16 (REV-22's
// record); the behaviour is driven through the real reversals in
// dcRoundFReversalRestore.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261164_dc_roundF_reversal_restore.sql";
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

const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
const RESTORE_HEAD = "CREATE OR REPLACE FUNCTION restore_reversed_source(";
/** The definition this migration re-creates from: the newest one BEFORE it (scanned). */
const defining = files.filter((f) => /CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/.test(stripComments(mig(f))));
const PREV = defining[defining.indexOf(FILE) - 1];
const G = { live: between(mig(PREV), GUARD_HEAD, "\n$$;"), next: between(M, GUARD_HEAD, "\n$$;") };
const R = between(M, RESTORE_HEAD, "\n$$;");

/** The guard's one addition, as contiguous text. */
const G_LIMB = G.next.slice(
  G.next.indexOf("  -- REV-22 (document-control Round F wave 3, P18): REV-20 (a) for the"),
  G.next.indexOf("  v_unforced_issue := COALESCE(v_issuing"),
);
const NEW_DOOR_HOLD = "Document has an active hold; release the hold before issuing it.";

describe("20261164 — the guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261159 — the scan, not this comment, decides)", () => {
    expect(defining).toContain(FILE);
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261159_dc_roundF_guard_owner_and_held_pointer.sql").toBe(true);
  });

  it("nothing removed, every new line is the P18 block, and the body minus it IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    const added = G_LIMB.split("\n");
    for (const l of onlyInB) expect(added, l).toContain(l);
    expect(G_LIMB.length).toBeGreaterThan(200);
    expect(G.next.split(G_LIMB).length).toBe(2);
    expect(G.next.replace(G_LIMB, "")).toBe(G.live);
  });

  it("the added code is exactly the P18 limb — an unstamped Superseded exit into an issue, pointer unmoved, without the flag naming the document, bound to a controller — right after REV-20 (a)'s and before REV-20 (b)'s flag test", () => {
    expect(code(G_LIMB.split("\n"))).toEqual([
      "  v_new_door := v_new_door",
      "                OR COALESCE(v_issuing",
      "                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id",
      "                            AND OLD.status = 'Superseded'",
      "                            AND OLD.retired_issue_status IS NULL",
      "                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text",
      "                            AND is_org_controller(NEW.org_id), false);",
    ]);
    const limbA = "                            AND OLD.status IN ('Archived', 'Void')\n                            AND OLD.retired_issue_status IS NULL\n                            AND is_org_controller(NEW.org_id), false);\n";
    expect(G.next).toContain(limbA + G_LIMB + "  v_unforced_issue := COALESCE(v_issuing\n");
    // it feeds the new door, whose refusal is the existing one (the editors and the un-archive dialog recognise it)
    expect(G.next).toContain(`    IF v_new_door AND EXISTS (\n         SELECT 1 FROM document_holds h\n          WHERE h.document_id = NEW.id AND h.released_at IS NULL\n       ) THEN\n      RAISE EXCEPTION\n        '${NEW_DOOR_HOLD}'`);
    // no new declaration, no new refusal sentence
    expect(G.next.slice(0, G.next.indexOf("BEGIN\n"))).toBe(G.live.slice(0, G.live.indexOf("BEGIN\n")));
    expect(G_LIMB).not.toMatch(/RAISE/);
  });

  it("the refusal is said as the app reads it: a hold refusal of the issue rule (isIssueRefusal, newDoorHold)", async () => {
    const { isIssueRefusal, ISSUE_REFUSAL } = await import("@/lib/issueStatus");
    expect(isIssueRefusal(NEW_DOOR_HOLD)).toBe(true);
    expect(NEW_DOOR_HOLD).toContain(ISSUE_REFUSAL.newDoorHold);
  });

  it("DRLS-16: the guard is executable by no client role; SECURITY DEFINER with its search_path pinned", () => {
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(G.next).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(stripComments(M)).not.toMatch(/DROP FUNCTION/);
  });
});

describe("20261164 — restore_reversed_source, the reversal's recorded put-back", () => {
  it("SECURITY INVOKER (every read and the write run as the caller, under their policies and the guard), search_path pinned, one 4-argument signature", () => {
    expect(R).toContain("CREATE OR REPLACE FUNCTION restore_reversed_source(\n  p_document_id uuid,\n  p_status text,\n  p_reversal_of uuid,\n  p_reason text DEFAULT NULL\n) RETURNS text\nLANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(R).not.toMatch(/SECURITY DEFINER/);
    expect((stripComments(M).match(/CREATE OR REPLACE FUNCTION restore_reversed_source\(/g) ?? []).length).toBe(1);
    // no other migration defines it
    for (const f of files.filter((x) => x !== FILE)) expect(stripComments(mig(f)), f).not.toMatch(/FUNCTION\s+(?:public\.)?restore_reversed_source\b/);
  });

  it("DRLS-16: refuses a call with no session first; authenticated only (PUBLIC, anon and service_role revoked)", () => {
    const bodyStart = R.indexOf("BEGIN\n");
    expect(R.slice(bodyStart)).toMatch(/^BEGIN\n(?:\s*--[^\n]*\n)*\s*IF v_uid IS NULL THEN\n\s*RAISE EXCEPTION/);
    expect(R).toContain("  v_uid     uuid := auth.uid();");
    expect(R).toContain("      USING ERRCODE = 'insufficient_privilege';");
    expect(M).toContain("REVOKE ALL ON FUNCTION restore_reversed_source(uuid, text, uuid, text) FROM PUBLIC, anon, service_role;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION restore_reversed_source(uuid, text, uuid, text) TO authenticated;");
    expect([...stripComments(M).matchAll(/GRANT [^;]*;/g)].map((m) => m[0])).toEqual([
      "GRANT EXECUTE ON FUNCTION restore_reversed_source(uuid, text, uuid, text) TO authenticated;",
    ]);
  });

  it("its write is restoreStatus's own — status and the four supersession fields cleared, as the caller — and no pointer", () => {
    expect(R).toContain("  UPDATE documents\n     SET status = p_status,\n         superseded_at = NULL,\n         superseded_by_user = NULL,\n         supersession_reason = NULL,\n         supersession_moc = NULL,\n         updated_at = now(),\n         updated_by = v_uid\n   WHERE id = p_document_id;");
    expect(stripComments(R)).not.toMatch(/current_version_id\s*=/);
    expect(stripComments(R)).not.toMatch(/pending_version_id/);
    expect((stripComments(R).match(/UPDATE documents/g) ?? []).length).toBe(1);
    // the reversal's own payload (lib/documentLifecycle/reverse.ts restoreStatus's direct write) is the same set of fields
    const reverse = readFileSync(join(process.cwd(), "lib/documentLifecycle/reverse.ts"), "utf8");
    const direct = between(reverse, 'supabase.from("documents").update({\n    status,', "}).eq(\"id\", docId)");
    for (const col of ["status", "superseded_at", "superseded_by_user", "supersession_reason", "supersession_moc", "updated_at", "updated_by"]) {
      expect(direct, col).toMatch(new RegExp(`\\b${col}\\b`));
      expect(R, col).toMatch(new RegExp(`\\b${col} = `));
    }
  });

  it("the door: Document Control (is_org_controller, the guard's own tier), a Superseded document, the source of the recorded DOC_SPLIT / DOC_MERGED the call names in its own org, an active hold — then, and only then, the flag", () => {
    expect(R).toContain("  SELECT a.action INTO v_action\n    FROM audit_logs a\n   WHERE a.id = p_reversal_of\n     AND a.org_id = v_org\n     AND a.action IN ('DOC_SPLIT', 'DOC_MERGED')\n     AND (a.resource_id = p_document_id::text\n          OR COALESCE(jsonb_typeof(a.details->'mergeSiblings') = 'array'\n                      AND (a.details->'mergeSiblings') ? p_document_id::text, false))\n   LIMIT 1;");
    expect(R).toContain("  IF v_status = 'Superseded'\n     AND v_action IS NOT NULL\n     AND is_org_controller(v_org)\n     AND EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN\n    v_forced := true;\n  END IF;");
    expect((R.match(/v_forced := true;/g) ?? []).length).toBe(1);
    expect(R).toContain("  v_forced  boolean := false;");
  });

  it("the flag names this document immediately before its one UPDATE and is cleared immediately after it, before any return", () => {
    const SET = "  IF v_forced THEN\n    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);\n  END IF;\n";
    const CLEAR = "  IF v_forced THEN\n    PERFORM set_config('app.publish_hold_override', '', true);\n  END IF;\n";
    expect(R).toContain(SET + "  UPDATE documents\n");
    expect(R).toContain("   WHERE id = p_document_id;\n  GET DIAGNOSTICS v_n = ROW_COUNT;\n" + CLEAR + "  IF v_n = 0 THEN\n    RETURN 'no_match';\n  END IF;");
    expect((stripComments(R).match(/set_config\(/g) ?? []).length).toBe(2);
  });

  it("the record: REV_HOLD_OVERRIDDEN in the same transaction, as the caller, after the write landed, naming the holds, the reason, the reversed event and the status", () => {
    const rec = between(R, "  IF v_forced THEN\n    INSERT INTO audit_logs", "            ));\n  END IF;");
    expect(rec).toContain("VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, v_uid,");
    expect(rec).toContain("(SELECT m.email FROM org_members m WHERE m.org_id = v_org AND m.uid = v_uid LIMIT 1)");
    expect(rec).toMatch(/'holds', \(SELECT jsonb_agg\(jsonb_build_object\('id', h\.id, 'reason', h\.reason\) ORDER BY h\.opened_at\)/);
    for (const k of ["'via', 'reversal_restore'", "'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')", "'reversedAuditEventId', p_reversal_of", "'reversedAction', v_action", "'newStatus', p_status", "'priorStatus', v_status", "'branch', false"]) {
      expect(rec, k).toContain(k);
    }
    expect(R.indexOf(rec)).toBeGreaterThan(R.indexOf("  IF v_n = 0 THEN\n    RETURN 'no_match';"));
    expect(R.indexOf("  RETURN 'restored';")).toBeGreaterThan(R.indexOf(rec));
  });

  it("the flag in the whole sequence: SET only by 20261151 (publish_revision, finalize_reviewed_promote) and here, by restore_reversed_source alone; every other mention a read", () => {
    const withoutFlagReads = (sql: string) => sql
      .split("current_setting('app.publish_hold_override', true)").join("")
      .split("current_setting(''app.publish_hold_override'', true)").join("");
    const setters = files.filter((f) => /publish_hold_override/.test(withoutFlagReads(stripComments(mig(f)))));
    expect(setters).toEqual(["20261151_dc_roundF_promote_transaction_and_hold_override.sql", FILE]);
    // in this file: the restore's two set_config calls, the COMMENT ON FUNCTION's description,
    // and the probes that quote them — nothing in the guard but its reads
    const here = stripComments(M);
    expect(withoutFlagReads(stripComments(G.next))).not.toMatch(/publish_hold_override/);
    expect(stripComments(G.next)).not.toMatch(/set_config/);
    const outsideRestore = withoutFlagReads(here.replace(stripComments(R), ""));
    const mentions = outsideRestore.split("\n").filter((l) => /publish_hold_override/.test(l));
    expect(mentions.every((l) => /^\s*'REV-22 \(20261164\): the legacy reversal|prosrc LIKE '%PERFORM set_config\(''app\.publish_hold_override''/.test(l)), mentions.join("\n")).toBe(true);
  });
});

describe("20261164 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'\n                  AND prosrc LIKE '%v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL%') THEN");
    expect(pre).toBeGreaterThan(0);
    expect(M).toContain("RAISE EXCEPTION '20261164 needs 20261159 (the REV-22 publish guard) pasted first; nothing was changed.';");
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_f_164_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_164_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(6);
    expect(inventory).not.toMatch(/SELECT \*|document_number|title|d\.id\s+AS|user_email/);
    // the counts the record names: unstamped Superseded, held, held + recorded source, held + not, recorded sources, the function's presence
    expect(inventory).toContain("     AND d.status = 'Superseded'\n     AND d.retired_issue_status IS NULL");
    for (const w of ["FROM unstamped\n", "FROM unstamped WHERE held\n", "FROM unstamped WHERE held AND recorded_source\n", "FROM unstamped WHERE held AND NOT recorded_source\n", "FROM unstamped WHERE recorded_source\n", "FROM pg_proc WHERE proname = 'restore_reversed_source';"]) {
      expect(inventory, w).toContain(w);
    }
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1); // one statement: the final SELECT
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_f_164_before;");
  });

  it("every prosrc LIKE probe matches the body of the function it names (prosrc verbatim), and none carries a cast", () => {
    /** The newest definition of a function in the sequence up to and including this file. */
    const newest = (name: string, head: string) => {
      const f = files.filter((x) => x <= FILE && stripComments(mig(x)).includes(head)).pop()!;
      return between(mig(f), head, "\n$$;");
    };
    const bodies: Record<string, string> = {
      enforce_document_publish_guard: G.next,
      restore_reversed_source: R,
      publish_revision: newest("publish_revision", "CREATE OR REPLACE FUNCTION publish_revision("),
      finalize_reviewed_promote: newest("finalize_reviewed_promote", "CREATE OR REPLACE FUNCTION finalize_reviewed_promote("),
    };
    let n = 0;
    for (const seg of tail.split(/\nUNION ALL\n/)) {
      for (const sub of seg.split(/\(SELECT (?=prosrc|pronargs|COUNT)/)) {
        const fn = /FROM pg_proc WHERE proname = '(\w+)'/.exec(sub)?.[1];
        for (const m of sub.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
          expect(fn, sub.slice(0, 80)).toBeDefined();
          const pat = m[2].replace(/''/g, "'");
          expect(pat, pat).not.toMatch(/::/);
          const re = new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
          const body = bodies[fn!];
          expect(body, fn).toBeDefined();
          expect(re.test(body.slice(body.indexOf("$$") + 2)), `${fn}: ${pat}`).toBe(m[1] ? false : true);
          n += 1;
        }
      }
    }
    expect(n).toBe(24);
    // and the P18 probe would be FALSE on the base (it pins the new limb, in place)
    const p18Probe = /prosrc LIKE '(%AND OLD\.status IN \(''Archived''[^']*(?:''[^']*)*)'/.exec(tail)![1].replace(/''/g, "'");
    const re = new RegExp("^" + p18Probe.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
    expect(re.test(G.next.slice(G.next.indexOf("$$") + 2))).toBe(true);
    expect(re.test(G.live.slice(G.live.indexOf("$$") + 2))).toBe(false);
  });

  it("the probes cover the grants: authenticated only, PUBLIC (an explicit ACL with no PUBLIC entry), anon and service_role refused, INVOKER, pinned", () => {
    expect(tail).toContain("AND has_function_privilege('authenticated', 'restore_reversed_source(uuid, text, uuid, text)', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'restore_reversed_source(uuid, text, uuid, text)', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('service_role', 'restore_reversed_source(uuid, text, uuid, text)', 'EXECUTE')");
    expect(tail).toContain("AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AND p.proacl IS NOT NULL)");
    expect(tail).toContain("WHERE p.proname = 'restore_reversed_source' AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),");
  });

  it("the header states the decision, the paste order (after 20261159, which is held), the never-re-paste list, the deploy-first rule, and that P16 re-creates from this body", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/DECIDED \(the record's two alternatives\): the recorded door, not a\n-- {11}backfill of the retirement stamp/);
    expect(head).toMatch(/HOW TO APPLY: AFTER 20261159 \(required/);
    expect(head).toMatch(/20261159 is itself\n-- HELD \(paste guide row 119\)/);
    expect(head).toMatch(/INTK-18/);
    expect(head).toMatch(/DEC-63's P17 Landed line/);
    expect(head).toMatch(/Never re-paste 20261159, 20261151, 20261144,\n-- 20261139, 20261105 or any earlier guard migration after this one/);
    expect(head).toMatch(/P16 \(REV-21\) re-creates this guard next, from this body\./);
    expect(head).toMatch(/⚠ DEPLOY FIRST: deploy the app carrying P18/);
    expect(head).toMatch(/NOT a widening/);
  });
});
