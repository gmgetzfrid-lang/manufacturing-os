// document-control Round F wave 3 — P19 STAMPED PUT-BACK RECORD: migration
// 20261165 (REV-23).
//
//   enforce_document_publish_guard re-created from its NEWEST earlier body
//   (scan — 20261164 today) with EXACTLY the P19 block added: a controller's
//   stamped put-back (v_restoring — the revision a Superseded / Archived /
//   Void retirement took away, put back into an issue status) without the
//   transaction-local flag naming the document is the new door (refused over
//   an active hold). put_back_retired_issue (new, SECURITY INVOKER) is the
//   app's put-back: the un-archive's write or a rollback's, under the flag
//   only for Document Control's put-back of a held stamped retirement into an
//   issue status, recorded as REV_HOLD_OVERRIDDEN in the same transaction.
//
// Byte fidelity: lineDiff (nothing removed; every new line is an addition)
// AND an exact cut (the re-created body minus the addition IS the base, byte
// for byte). The script was run on a throwaway PostgreSQL 16 (REV-23's
// record); the behaviour is driven through the real put-backs in
// dcRoundFStampedPutBack.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261165_dc_roundF_stamped_put_back.sql";
const M = mig(FILE);
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
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
const PUT_BACK_HEAD = "CREATE OR REPLACE FUNCTION put_back_retired_issue(";
/** The definition this migration re-creates from: the newest one BEFORE it (scanned). */
const defining = files.filter((f) => /CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/.test(stripComments(mig(f))));
const PREV = defining[defining.indexOf(FILE) - 1];
const G = { live: between(mig(PREV), GUARD_HEAD, "\n$$;"), next: between(M, GUARD_HEAD, "\n$$;") };
const P = between(M, PUT_BACK_HEAD, "\n$$;");

/** The guard's one addition, as contiguous text. */
const G_LIMB = G.next.slice(
  G.next.indexOf("  -- REV-23 (document-control Round F wave 3, P19): the STAMPED put-back"),
  G.next.indexOf("  IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN"),
);
const NEW_DOOR_HOLD = "Document has an active hold; release the hold before issuing it.";
const V_RESTORING = "  v_restoring := COALESCE(v_issuing\n                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                 AND OLD.retired_issue_version_id IS NOT NULL\n                 AND NEW.current_version_id = OLD.retired_issue_version_id\n                 AND NEW.current_version_id = OLD.current_version_id, false);\n";

describe("20261165 — the guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261164 — the scan, not this comment, decides)", () => {
    expect(defining).toContain(FILE);
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261164_dc_roundF_reversal_restore.sql").toBe(true);
  });

  it("nothing removed, every new line is the P19 block, and the body minus it IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    const added = G_LIMB.split("\n");
    for (const l of onlyInB) expect(added, l).toContain(l);
    expect(G_LIMB.length).toBeGreaterThan(200);
    expect(G.next.split(G_LIMB).length).toBe(2);
    expect(G.next.replace(G_LIMB, "")).toBe(G.live);
  });

  it("the added code is exactly the P19 limb — the stamped put-back (v_restoring) without the flag naming the document, bound to a controller — right after v_restoring is computed and before the stamp is rewritten", () => {
    expect(code(G_LIMB.split("\n"))).toEqual([
      "  v_new_door := v_new_door",
      "                OR COALESCE(v_restoring",
      "                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text",
      "                            AND is_org_controller(NEW.org_id), false);",
    ]);
    expect(G.next).toContain(V_RESTORING + G_LIMB + "  IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN\n");
    // it feeds the new door, whose refusal is the existing one (the editors and the un-archive dialog recognise it) — read only inside the issue block, after this limb
    expect(G.next).toContain(`    IF v_new_door AND EXISTS (\n         SELECT 1 FROM document_holds h\n          WHERE h.document_id = NEW.id AND h.released_at IS NULL\n       ) THEN\n      RAISE EXCEPTION\n        '${NEW_DOOR_HOLD}'`);
    expect(G.next.indexOf("    IF v_new_door AND EXISTS (")).toBeGreaterThan(G.next.indexOf(G_LIMB));
    expect((stripComments(G.next).match(/v_new_door/g) ?? []).length).toBe((stripComments(G.live).match(/v_new_door/g) ?? []).length + 2);
    // no new declaration, no new refusal sentence; the require limb still spares a put-back
    expect(G.next.slice(0, G.next.indexOf("BEGIN\n"))).toBe(G.live.slice(0, G.live.indexOf("BEGIN\n")));
    expect(G_LIMB).not.toMatch(/RAISE/);
    expect(G.next).toContain("    IF NOT is_org_controller(NEW.org_id)\n       AND NOT v_restoring\n");
  });

  it("the refusal is said as the app reads it: a hold refusal of the issue rule (isIssueRefusal, newDoorHold)", async () => {
    const { isIssueRefusal, ISSUE_REFUSAL } = await import("@/lib/issueStatus");
    expect(isIssueRefusal(NEW_DOOR_HOLD)).toBe(true);
    expect(NEW_DOOR_HOLD).toContain(ISSUE_REFUSAL.newDoorHold);
  });

  it("the base's rules are all still there, P18's included (the unstamped Superseded exit) — this is a re-create, not a rewrite", () => {
    for (const limb of [
      "                            AND OLD.status = 'Superseded'\n                            AND OLD.retired_issue_status IS NULL\n                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n",
      "                            AND OLD.status IN ('Archived', 'Void')\n                            AND OLD.retired_issue_status IS NULL\n",
      "  v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL\n",
      "  v_unforced_issue := COALESCE(v_issuing\n",
    ]) expect(G.next, limb.slice(0, 60)).toContain(limb);
  });

  it("DRLS-16: the guard is executable by no client role; SECURITY DEFINER with its search_path pinned; nothing dropped", () => {
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(G.next).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(stripComments(M)).not.toMatch(/DROP FUNCTION/);
  });
});

describe("20261165 — put_back_retired_issue, the stamped put-back's recorded door", () => {
  it("SECURITY INVOKER (every read and the write run as the caller, under their policies and the guard), search_path pinned, one 8-argument signature, defined nowhere else", () => {
    expect(P).toContain("CREATE OR REPLACE FUNCTION put_back_retired_issue(\n  p_document_id uuid,\n  p_status text,\n  p_via text,\n  p_reason text DEFAULT NULL,\n  p_superseded_at timestamptz DEFAULT NULL,\n  p_superseded_by_user uuid DEFAULT NULL,\n  p_supersession_reason text DEFAULT NULL,\n  p_supersession_moc text DEFAULT NULL\n) RETURNS text\nLANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(P).not.toMatch(/SECURITY DEFINER/);
    expect((stripComments(M).match(/CREATE OR REPLACE FUNCTION put_back_retired_issue\(/g) ?? []).length).toBe(1);
    for (const f of files.filter((x) => x !== FILE)) expect(stripComments(mig(f)), f).not.toMatch(/FUNCTION\s+(?:public\.)?put_back_retired_issue\b/);
    // P18's door is not re-created here (decided: a sibling, not an extension)
    expect(stripComments(M)).not.toMatch(/FUNCTION\s+(?:public\.)?restore_reversed_source\b/);
  });

  it("DRLS-16: refuses a call with no session first, then an unknown door or a blank status; authenticated only (PUBLIC, anon and service_role revoked)", () => {
    const bodyStart = P.indexOf("BEGIN\n");
    expect(P.slice(bodyStart)).toMatch(/^BEGIN\n(?:\s*--[^\n]*\n)*\s*IF v_uid IS NULL THEN\n\s*RAISE EXCEPTION/);
    expect(P).toContain("  v_uid     uuid := auth.uid();");
    expect(P).toContain("      USING ERRCODE = 'insufficient_privilege';");
    expect(P.indexOf("IF v_uid IS NULL THEN")).toBeLessThan(P.indexOf("IF p_via IS NULL OR p_via NOT IN ('unarchive', 'supersede_rollback', 'lifecycle_rollback', 'reversal_rollback') THEN"));
    expect(P.indexOf("IF p_via IS NULL OR p_via NOT IN")).toBeLessThan(P.indexOf("IF btrim(COALESCE(p_status, '')) = '' THEN"));
    expect(P.indexOf("IF btrim(COALESCE(p_status, '')) = '' THEN")).toBeLessThan(P.indexOf("FROM documents d WHERE d.id = p_document_id;"));
    const SIG = "put_back_retired_issue(uuid, text, text, text, timestamptz, uuid, text, text)";
    expect(M).toContain(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC, anon, service_role;`);
    expect(M).toContain(`GRANT EXECUTE ON FUNCTION ${SIG} TO authenticated;`);
    expect([...stripComments(M).matchAll(/GRANT [^;]*;/g)].map((m) => m[0])).toEqual([`GRANT EXECUTE ON FUNCTION ${SIG} TO authenticated;`]);
  });

  it("its two writes are the app's own — the un-archive's (unarchiveDocument) and the rollbacks' (undoFailedSupersede, restoreSupersededSource, the reversal's putStatusBack) — as the caller, and no pointer", () => {
    const UNARCHIVE = "    UPDATE documents\n       SET status = p_status,\n           archived_at = NULL,\n           archived_by = NULL,\n           archive_reason = NULL,\n           updated_at = now(),\n           updated_by = v_uid\n     WHERE id = p_document_id;";
    const ROLLBACK = "    UPDATE documents\n       SET status = p_status,\n           superseded_at = p_superseded_at,\n           superseded_by_user = p_superseded_by_user,\n           supersession_reason = p_supersession_reason,\n           supersession_moc = p_supersession_moc,\n           updated_at = now(),\n           updated_by = v_uid\n     WHERE id = p_document_id;";
    expect(P).toContain("  IF p_via = 'unarchive' THEN\n" + UNARCHIVE + "\n    GET DIAGNOSTICS v_n = ROW_COUNT;\n  ELSE\n" + ROLLBACK + "\n    GET DIAGNOSTICS v_n = ROW_COUNT;\n  END IF;\n");
    expect((stripComments(P).match(/UPDATE documents/g) ?? []).length).toBe(2);
    expect(stripComments(P)).not.toMatch(/current_version_id\s*=/);
    expect(stripComments(P)).not.toMatch(/pending_version_id/);
    // the app's direct writes (the fallback while the function is absent) carry the same columns
    const direct = (file: string, head: string) => {
      const fn = src(file).slice(src(file).indexOf(head));
      const at = fn.indexOf('.from("documents")');
      return fn.slice(at, fn.indexOf(".eq(", at));
    };
    const cols = (text: string) => [...text.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
    expect(cols(direct("lib/revisions.ts", "export async function unarchiveDocument("))).toEqual(["archive_reason", "archived_at", "archived_by", "status", "updated_at", "updated_by"]);
    const rollbackCols = ["status", "superseded_at", "superseded_by_user", "supersession_moc", "supersession_reason", "updated_at", "updated_by"];
    expect(cols(direct("lib/revisions.ts", "async function undoFailedSupersede("))).toEqual(rollbackCols);
    expect(cols(direct("lib/documentLifecycle/common.ts", "export async function restoreSupersededSource("))).toEqual(rollbackCols);
    const putBack = src("lib/documentLifecycle/reverse.ts").slice(src("lib/documentLifecycle/reverse.ts").indexOf("async function putStatusBack("));
    const putBackDirect = putBack.slice(putBack.indexOf('supabase.from("documents").update({'), putBack.indexOf("}).eq(\"id\", docId)"));
    expect(cols(putBackDirect)).toEqual(rollbackCols);
  });

  it("the door: exactly the write the guard now refuses bare — Document Control, the retirement this door leaves, the stamp naming the current revision (no pointer moves: v_restoring), an issue status asked, an active hold — then, and only then, the flag", () => {
    expect(P).toContain("  IF v_status = (CASE WHEN p_via = 'unarchive' THEN 'Archived' ELSE 'Superseded' END)\n     AND v_stamped IS NOT NULL\n     AND v_stamped = v_version\n     AND btrim(p_status) NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')\n     AND is_org_controller(v_org)\n     AND EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN\n    v_forced := true;\n  END IF;");
    expect((P.match(/v_forced := true;/g) ?? []).length).toBe(1);
    expect(P).toContain("  v_forced  boolean := false;");
    // the issue test is a SUPERSET of is_controlled_issue_status (whose EXECUTE no client role holds): the same five non-issue statuses, trimmed of spaces only
    const predicate = between(mig("20261144_dc_roundF_status_issue_transition.sql"), "CREATE OR REPLACE FUNCTION is_controlled_issue_status(p_status text)", "\n$$;");
    expect(predicate).toContain("NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived');");
    expect(stripComments(P)).not.toMatch(/is_controlled_issue_status\(/);
  });

  it("the flag names this document immediately before its write and is cleared immediately after it, before any return", () => {
    const SET = "  IF v_forced THEN\n    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);\n  END IF;\n";
    const CLEAR = "  IF v_forced THEN\n    PERFORM set_config('app.publish_hold_override', '', true);\n  END IF;\n";
    expect(P).toContain(SET + "  IF p_via = 'unarchive' THEN\n    UPDATE documents\n");
    expect(P).toContain("    GET DIAGNOSTICS v_n = ROW_COUNT;\n  END IF;\n" + CLEAR + "  IF v_n = 0 THEN\n    RETURN 'no_match';\n  END IF;");
    expect((stripComments(P).match(/set_config\(/g) ?? []).length).toBe(2);
    const between_ = P.slice(P.indexOf(SET) + SET.length, P.indexOf(CLEAR));
    expect(between_).not.toMatch(/RETURN/);
  });

  it("the record: REV_HOLD_OVERRIDDEN in the same transaction, as the caller, after the write landed, naming the door, the holds, the reason, the stamp and the statuses", () => {
    const rec = between(P, "  IF v_forced THEN\n    INSERT INTO audit_logs", "            ));\n  END IF;");
    expect(rec).toContain("VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, v_uid,");
    expect(rec).toContain("(SELECT m.email FROM org_members m WHERE m.org_id = v_org AND m.uid = v_uid LIMIT 1)");
    expect(rec).toMatch(/'holds', \(SELECT jsonb_agg\(jsonb_build_object\('id', h\.id, 'reason', h\.reason\) ORDER BY h\.opened_at\)/);
    for (const k of ["'via', p_via", "'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')", "'stampedPutBack', true", "'retiredIssueStatus', v_stamp", "'versionId', v_version", "'revisionLabel', v_rev", "'priorStatus', v_status", "'newStatus', p_status", "'branch', false"]) {
      expect(rec, k).toContain(k);
    }
    expect(P.indexOf(rec)).toBeGreaterThan(P.indexOf("  IF v_n = 0 THEN\n    RETURN 'no_match';"));
    expect(P.indexOf("  RETURN CASE WHEN v_forced THEN 'restored_over_hold' ELSE 'restored' END;")).toBeGreaterThan(P.indexOf(rec));
  });

  it("the answer is P18's vocabulary — restored_over_hold for the recorded pass, restored for the bare write, no_match — and the app reads it so", () => {
    expect((stripComments(P).match(/RETURN /g) ?? []).length).toBe(3);
    expect(stripComments(P)).toContain("  RETURN CASE WHEN v_forced THEN 'restored_over_hold' ELSE 'restored' END;\nEND;");
    const rev = src("lib/revisions.ts");
    expect(rev).toContain('if (data === "restored" || data === "restored_over_hold") return { kind: "landed", recorded: data === "restored_over_hold" };');
    expect(rev).toContain('if (data === "no_match") return { kind: "refused", reason: "the write was refused", noRow: true };');
    // the doors the app names are exactly the function's
    const doors = /export type RetiredIssuePutBackDoor = ([^;]+);/.exec(rev)![1].split("|").map((s) => s.trim().replace(/"/g, ""));
    expect(doors).toEqual(["unarchive", "supersede_rollback", "lifecycle_rollback", "reversal_rollback"]);
  });

  it("the flag in the whole sequence: SET only by 20261151 (publish_revision, finalize_reviewed_promote), 20261164 (restore_reversed_source) and here, by put_back_retired_issue alone; every other mention a read", () => {
    const withoutFlagReads = (sql: string) => sql
      .split("current_setting('app.publish_hold_override', true)").join("")
      .split("current_setting(''app.publish_hold_override'', true)").join("");
    const setters = files.filter((f) => /publish_hold_override/.test(withoutFlagReads(stripComments(mig(f)))));
    expect(setters).toEqual(["20261151_dc_roundF_promote_transaction_and_hold_override.sql", "20261164_dc_roundF_reversal_restore.sql", FILE]);
    expect(withoutFlagReads(stripComments(G.next))).not.toMatch(/publish_hold_override/);
    expect(stripComments(G.next)).not.toMatch(/set_config/);
    const outsidePutBack = withoutFlagReads(stripComments(M).replace(stripComments(P), ""));
    const mentions = outsidePutBack.split("\n").filter((l) => /publish_hold_override/.test(l));
    expect(mentions.every((l) => /^\s*'REV-23 \(20261165\): the app''s put-back|prosrc LIKE '%PERFORM set_config\(''app\.publish_hold_override''|prosrc LIKE '%IF v_status = ''Superseded''%AND v_action IS NOT NULL%AND is_org_controller\(v_org\)%PERFORM set_config\(''app\.publish_hold_override''/.test(l)), mentions.join("\n")).toBe(true);
  });
});

describe("20261165 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'");
    expect(pre).toBeGreaterThan(0);
    expect(M).toContain("RAISE EXCEPTION '20261165 needs 20261164 (the REV-22 reversal restore and its publish guard) pasted first; nothing was changed.';");
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_f_165_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_165_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(6);
    expect(inventory).not.toMatch(/SELECT \*|document_number|title|d\.id\s+AS|user_email/);
    expect(inventory).toContain("   WHERE d.status IN ('Superseded', 'Archived', 'Void')\n     AND d.retired_issue_version_id IS NOT NULL\n     AND d.retired_issue_version_id = d.current_version_id");
    for (const w of ["  FROM stamped\n", "  FROM stamped WHERE held\n", "  FROM stamped WHERE held AND status = 'Archived'\n", "  FROM stamped WHERE held AND status = 'Superseded'\n", "  FROM stamped WHERE held AND status = 'Void'\n", "  FROM pg_proc WHERE proname = 'put_back_retired_issue';"]) {
      expect(inventory, w).toContain(w);
    }
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1); // one statement: the final SELECT
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_f_165_before;");
  });

  it("the prerequisite passes on 20261164's guard (P18's limb, with restore_reversed_source) and refuses on 20261159's", () => {
    const pat = /prosrc LIKE '((?:[^']|'')*)'\)/.exec(M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE")))![1].replace(/''/g, "'");
    expect(pat).not.toMatch(/::/);
    const re = new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
    const guardOf = (f: string) => { const g = between(mig(f), GUARD_HEAD, "\n$$;"); return g.slice(g.indexOf("$$") + 2); };
    expect(re.test(guardOf("20261164_dc_roundF_reversal_restore.sql"))).toBe(true);
    expect(re.test(guardOf("20261159_dc_roundF_guard_owner_and_held_pointer.sql"))).toBe(false);
    expect(M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE"))).toContain("OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restore_reversed_source') THEN");
  });

  it("every prosrc LIKE probe matches the body of the function it names (prosrc verbatim), and none carries a cast", () => {
    /** The newest definition of a function in the sequence up to and including this file. */
    const newest = (head: string) => {
      const f = files.filter((x) => x <= FILE && stripComments(mig(x)).includes(head)).pop()!;
      return between(mig(f), head, "\n$$;");
    };
    const bodies: Record<string, string> = {
      enforce_document_publish_guard: G.next,
      put_back_retired_issue: P,
      publish_revision: newest("CREATE OR REPLACE FUNCTION publish_revision("),
      finalize_reviewed_promote: newest("CREATE OR REPLACE FUNCTION finalize_reviewed_promote("),
      restore_reversed_source: newest("CREATE OR REPLACE FUNCTION restore_reversed_source("),
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
    expect(n).toBe(26);
    // and the P19 probe would be FALSE on the base (it pins the new limb, in place)
    const p19Probe = /prosrc LIKE '(%v_restoring := COALESCE\(v_issuing[^']*(?:''[^']*)*)'/.exec(tail)![1].replace(/''/g, "'");
    const re = new RegExp("^" + p19Probe.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
    expect(re.test(G.next.slice(G.next.indexOf("$$") + 2))).toBe(true);
    expect(re.test(G.live.slice(G.live.indexOf("$$") + 2))).toBe(false);
  });

  it("the probes cover the grants: authenticated only, PUBLIC (an explicit ACL with no PUBLIC entry), anon and service_role refused, INVOKER, pinned, 8 arguments", () => {
    const SIG = "put_back_retired_issue(uuid, text, text, text, timestamptz, uuid, text, text)";
    expect(tail).toContain(`AND has_function_privilege('authenticated', '${SIG}', 'EXECUTE')`);
    expect(tail).toContain(`AND NOT has_function_privilege('anon', '${SIG}', 'EXECUTE')`);
    expect(tail).toContain(`AND NOT has_function_privilege('service_role', '${SIG}', 'EXECUTE')`);
    expect(tail).toContain("WHERE n.nspname = 'public' AND p.proname = 'put_back_retired_issue' AND p.pronargs = 8\n                      AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AND p.proacl IS NOT NULL)");
    expect(tail).toContain("WHERE p.proname = 'put_back_retired_issue' AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),");
  });

  it("the header states the decision, the paste order (after 20261164, which follows the held 20261159), the never-re-paste list, P16's order, the deploy-first rule, and that it is not a widening", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/DECIDED \(the record's alternatives; the evidence on REV-23\): a\n-- {11}SIBLING door, not an extension of restore_reversed_source\./);
    expect(head).toMatch(/HOW TO APPLY: AFTER 20261164 \(required/);
    expect(head).toMatch(/20261164 follows 20261159, which is itself\n-- HELD \(paste guide row 119\)/);
    expect(head).toMatch(/INTK-18/);
    expect(head).toMatch(/DEC-63's P17 Landed line/);
    expect(head).toMatch(/Never re-paste 20261164, 20261159, 20261151,\n-- 20261144, 20261139, 20261105 or any earlier guard migration after this\n-- one/);
    expect(head).toMatch(/P16 \(REV-21\) re-creates this guard after it, from\n-- this body — or, if P16's migration is pasted first, this file is rebased\n-- on P16's body before it is pasted: whichever runs second starts from the\n-- other's/);
    expect(head).toMatch(/⚠ DEPLOY FIRST: deploy the app carrying P19/);
    expect(head).toMatch(/NOT a widening/);
  });
});
