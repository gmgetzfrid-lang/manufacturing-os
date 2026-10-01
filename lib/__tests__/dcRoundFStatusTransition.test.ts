// document-control Round F wave 2 — P13 STATUS-TRANSITION: the shape of
// migration 20261144 (REV-18: a status change that makes a document a
// controlled issue is a guarded write — enforce_document_publish_guard
// re-created from its NEWEST earlier body plus the issue-transition rule, and
// is_controlled_issue_status, the SQL twin of the app's predicate).
//
// There is no live database here. Byte fidelity to the newest earlier
// definition (found by scanning the migrations directory, never a hard-coded
// file name) is proven by lineDiff AND by an ordered cut; the probes' LIKE
// patterns are checked against the bodies they read; the SQL notion of a
// "controlled issue" is pinned to lib/issueStatus.ts isControlledIssueStatus —
// the five statuses AND the exact trim — and the transition to
// isIssueTransition. The script was also run on a throwaway PostgreSQL 16
// (recorded in REV-18).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import {
  WORK_IN_PROGRESS_STATUSES, isControlledIssueStatus, isIssueTransition, isIssueRefusal, ISSUE_REFUSAL_SENTENCES,
} from "@/lib/issueStatus";
import * as revisions from "@/lib/revisions";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261144_dc_roundF_status_issue_transition.sql";
const M = mig(FILE);
const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
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

/** The numbered migrations that define the guard, in order — and the one this
 *  migration re-creates from: the newest definition BEFORE it. */
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const defining = files.filter((f) => /CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/.test(stripComments(mig(f))));
const PREV = defining[defining.indexOf(FILE) - 1];
const live = between(mig(PREV), GUARD_HEAD, "\n$$;");
const next = between(M, GUARD_HEAD, "\n$$;");

/** The decoded character list of the E'' literal btrim trims with. */
function decodeTrimLiteral(lit: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch !== "\\") { out.push(ch); continue; }
    const n = lit[i + 1];
    if (n === "t") { out.push("\t"); i += 1; }
    else if (n === "n") { out.push("\n"); i += 1; }
    else if (n === "f") { out.push("\f"); i += 1; }
    else if (n === "r") { out.push("\r"); i += 1; }
    else if (n === "u") { out.push(String.fromCharCode(parseInt(lit.slice(i + 2, i + 6), 16))); i += 5; }
    else throw new Error(`unhandled escape \\${n}`);
  }
  return out;
}
const TRIM_LITERAL_RE = /btrim\(COALESCE\((?:p_status|g\.status|d\.status), ''\), E'((?:[^'\\]|\\.)*)'\)/g;
const STATUS_LIST_RE = /(NOT )?IN \(('Draft', 'In Review'(?:, 'Superseded', 'Void', 'Archived')?)\)/;

/** The SQL predicate, transcribed: btrim of exactly the listed characters,
 *  then NOT IN the five statuses. */
function sqlIsControlledIssueStatus(status: string | null, trimChars: string[], statuses: string[]): boolean {
  let s = status ?? "";
  const set = new Set(trimChars);
  let a = 0, b = s.length;
  while (a < b && set.has(s[a])) a++;
  while (b > a && set.has(s[b - 1])) b--;
  s = s.slice(a, b);
  return !statuses.includes(s);
}

// Every code point String.prototype.trim removes (the BMP; trim knows no
// astral whitespace).
const JS_TRIM_SET = (() => {
  const out: string[] = [];
  for (let cp = 1; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCharCode(cp);
    if (`a${ch}`.trim() === "a") out.push(ch);
  }
  return out;
})();

describe("20261144 — the guard is re-created from the NEWEST earlier definition (found by scanning, not named)", () => {
  it("this migration defines the guard, and an earlier one exists to re-create from", () => {
    expect(defining).toContain(FILE);
    expect(PREV).toBeDefined();
    expect(PREV < FILE).toBe(true);
    // (today that is P12's 20261139 — the scan, not this comment, decides)
  });

  /** The three contiguous additions (the declarations, the v_issuing + retirement-stamp block, the issue block). */
  const DECL = "  v_issuing      boolean;\n  v_new_door     boolean;\n  v_issue_reqs   integer;\n  v_issue_signed integer;\n  v_restoring    boolean;\n";
  const advStart = next.indexOf("  -- REV-18 (document-control Round F wave 2, P13): a status change that");
  const advEnd = next.indexOf("  IF NOT v_advancing THEN\n    RETURN NEW;\n  END IF;");
  const blockStart = next.indexOf("  -- REV-18 (P13): the issue itself.");
  const blockEnd = next.indexOf("  -- OWN-3/DEC-2: controllers are a property of the role COLLECTION.");
  const added = DECL + next.slice(advStart, advEnd) + next.slice(blockStart, blockEnd);

  it("is byte-faithful to that body: nothing removed, and every line the lineDiff finds new is one of the additions", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    const addedLines = added.split("\n");
    for (const l of onlyInB) expect(addedLines, l).toContain(l);
    expect(code(onlyInB).length).toBeGreaterThan(30);
  });

  it("the added code is exactly the REV-18 declarations and blocks", () => {
    expect(code(added.split("\n"))).toEqual([
      "  v_issuing      boolean;",
      "  v_new_door     boolean;",
      "  v_issue_reqs   integer;",
      "  v_issue_signed integer;",
      "  v_restoring    boolean;",
      "  v_issuing := NEW.current_version_id IS NOT NULL",
      "               AND NOT is_controlled_issue_status(OLD.status)",
      "               AND is_controlled_issue_status(NEW.status);",
      "  v_new_door := v_issuing",
      "                AND (NOT COALESCE(v_advancing, false)",
      "                     OR COALESCE(NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id",
      "                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')",
      "                                 AND OLD.retired_issue_status = 'not-issued'",
      "                                 AND OLD.retired_issue_version_id IS NULL, false));",
      "  v_advancing := v_advancing OR v_issuing;",
      "  v_restoring := COALESCE(v_issuing",
      "                 AND OLD.status IN ('Superseded', 'Archived', 'Void')",
      "                 AND OLD.retired_issue_version_id IS NOT NULL",
      "                 AND NEW.current_version_id = OLD.retired_issue_version_id",
      "                 AND NEW.current_version_id = OLD.current_version_id, false);",
      "  IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN",
      "    IF COALESCE(OLD.status IN ('Superseded', 'Archived', 'Void'), false) THEN",
      "      NEW.retired_issue_status := OLD.retired_issue_status;",
      "      NEW.retired_issue_version_id := OLD.retired_issue_version_id;",
      "    ELSIF OLD.current_version_id IS NOT NULL AND is_controlled_issue_status(OLD.status) THEN",
      "      NEW.retired_issue_status := OLD.status;",
      "      NEW.retired_issue_version_id := OLD.current_version_id;",
      "    ELSE",
      "      NEW.retired_issue_status := 'not-issued';",
      "      NEW.retired_issue_version_id := NULL;",
      "    END IF;",
      "  ELSE",
      "    NEW.retired_issue_status := NULL;",
      "    NEW.retired_issue_version_id := NULL;",
      "  END IF;",
      "  IF v_issuing THEN",
      "    IF v_new_door AND EXISTS (",
      "         SELECT 1 FROM document_holds h",
      "          WHERE h.document_id = NEW.id AND h.released_at IS NULL",
      "       ) THEN",
      "      RAISE EXCEPTION",
      "        'Document has an active hold; release the hold before issuing it.'",
      "        USING ERRCODE = 'check_violation';",
      "    END IF;",
      "    IF NOT is_org_controller(NEW.org_id)",
      "       AND NOT v_restoring",
      "       AND (review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = 'require'",
      "            OR review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id) = 'require') THEN",
      "      SELECT COALESCE(sum(g.reqs), 0), COALESCE(sum(LEAST(g.reqs, g.filled)), 0)",
      "        INTO v_issue_reqs, v_issue_signed",
      "        FROM (",
      "          SELECT COALESCE(s.slot_group, '') AS grp,",
      "                 count(*) FILTER (WHERE s.slot = 'primary') AS reqs,",
      "                 count(*) FILTER (WHERE (s.slot = 'primary' OR s.activated)",
      "                                    AND s.status = 'signed'",
      "                                    AND s.signature_id IS NOT NULL",
      "                                    AND EXISTS (",
      "                                      SELECT 1 FROM e_signatures e",
      "                                      WHERE e.id = s.signature_id",
      "                                        AND e.signer_user_id = s.reviewer_user_id",
      "                                        AND e.org_id = s.org_id",
      "                                        AND (e.document_version_id = s.document_version_id",
      "                                             OR e.document_version_id IS NULL)",
      "                                    )) AS filled",
      "            FROM document_review_signoffs s",
      "           WHERE s.document_version_id = NEW.current_version_id",
      "           GROUP BY COALESCE(s.slot_group, '')",
      "        ) g;",
      "      IF COALESCE(v_issue_reqs, 0) = 0 OR COALESCE(v_issue_signed, 0) < v_issue_reqs THEN",
      "        RAISE EXCEPTION",
      "          'This library requires reviewer sign-off, so a revision that was not reviewed can''t be made a controlled issue; submit it for review, or ask Document Control.'",
      "          USING ERRCODE = 'check_violation';",
      "      END IF;",
      "    END IF;",
      "  END IF;",
    ]);
  });

  it("ordered and byte-exact: cutting the three contiguous additions out of the new body gives the earlier body exactly", () => {
    for (const n of [advStart, advEnd, blockStart, blockEnd]) expect(n).toBeGreaterThan(0);
    expect(next.split(DECL)).toHaveLength(2);
    let cut = next.replace(DECL, "");
    cut = cut.replace(next.slice(advStart, advEnd), "");
    cut = cut.replace(next.slice(blockStart, blockEnd), "");
    expect(cut).toBe(live);
  });

  it("the additions sit where the rule needs them: the service-role return still comes first; v_issuing is set after v_advancing and before the not-advancing return; the issue block runs after the pointer-move gate and BEFORE the controller short-circuit (so the hold binds a controller on the new door), the publisher tier and the hold after it", () => {
    const at = (s: string) => { const i = next.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    const nullUid = at("IF v_actor IS NULL THEN\n    RETURN NEW;\n  END IF;");
    const adv = at("  v_advancing :=\n");
    const issuing = at("  v_issuing := NEW.current_version_id IS NOT NULL");
    const stamp = at("  IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN");
    const notAdv = at("  IF NOT v_advancing THEN\n    RETURN NEW;\n  END IF;");
    const sec14 = at("-- SEC-14 (projects Round G)");
    const block = at("  IF v_issuing THEN\n");
    const controller = at("  IF is_org_controller(NEW.org_id) THEN\n    RETURN NEW;");
    const tier = at("You do not have authority to publish revisions in this library.");
    const hold = at("Document has an active hold; release the hold before publishing a new revision.");
    expect(nullUid).toBeLessThan(adv);
    expect(adv).toBeLessThan(issuing);
    expect(issuing).toBeLessThan(stamp);
    // the stamp is kept / written / cleared on EVERY signed-in write (before the not-advancing return), so no caller's value survives
    expect(stamp).toBeLessThan(notAdv);
    expect(sec14).toBeLessThan(block);
    expect(block).toBeLessThan(controller);
    expect(controller).toBeLessThan(tier);
    expect(tier).toBeLessThan(hold);
    // the NULL-uid return is the FIRST statement after BEGIN: the service role keeps today's treatment
    const body = next.slice(next.indexOf("\nBEGIN\n") + "\nBEGIN\n".length);
    expect(body.startsWith("  IF v_actor IS NULL THEN\n    RETURN NEW;\n  END IF;")).toBe(true);
  });

  it("the issue block counts a complete roster exactly as the review gate does (the same per-slot query, re-indented)", () => {
    const norm = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
    const gate = between(next, "    SELECT COALESCE(sum(g.reqs), 0), COALESCE(sum(LEAST(g.reqs, g.filled)), 0)\n      INTO v_primary_reqs, v_signed", "      ) g;");
    const mine = between(next, "      SELECT COALESCE(sum(g.reqs), 0), COALESCE(sum(LEAST(g.reqs, g.filled)), 0)\n        INTO v_issue_reqs, v_issue_signed", "        ) g;");
    expect(norm(mine).replace("INTO v_issue_reqs, v_issue_signed", "INTO v_primary_reqs, v_signed")).toBe(norm(gate));
  });

  it("the require-mode limb reads the governing policy as REV-17's first-issue rule does: the folder / library chain OR the document's own (a document-level 'none' is no exemption — DEC-44 (P13))", () => {
    const rev17 = between(next, "      IF OLD.current_version_id IS NULL AND v_intake_link IS NULL", "THEN\n");
    const mine = between(next, "    IF NOT is_org_controller(NEW.org_id)\n       AND NOT v_restoring\n       AND (review_control_mode_for(NULL", "THEN\n");
    for (const arm of [
      "review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = 'require'",
      "OR review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id) = 'require')",
    ]) {
      expect(rev17).toContain(arm);
      expect(mine).toContain(arm);
    }
  });

  it("SECURITY DEFINER with search_path pinned; EXECUTE revoked from every client role (DRLS-16); the guard's trigger binding is untouched — the one trigger created is the stamp's BEFORE INSERT", () => {
    expect(next).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(M).toMatch(/REVOKE ALL ON FUNCTION enforce_document_publish_guard\(\) FROM PUBLIC, anon, authenticated, service_role;/);
    const code = stripComments(M);
    // the one GRANT is the predicate to the guard's OWN owner (P13 second review fix) — never a client role
    expect(code.match(/GRANT /g)).toHaveLength(1);
    expect(code).toContain("EXECUTE format('GRANT EXECUTE ON FUNCTION is_controlled_issue_status(text) TO %s', v_owner);");
    expect(code).not.toMatch(/GRANT [^\n]*TO (?:PUBLIC|anon|authenticated|service_role)\b/);
    expect(code).not.toMatch(/(?:CREATE|DROP) TRIGGER (?:IF EXISTS )?trg_document_publish_guard/);
    expect(code.match(/CREATE TRIGGER/g)).toHaveLength(1);
    expect(code.match(/DROP TRIGGER/g)).toHaveLength(1);
    expect(code).toContain("DROP TRIGGER IF EXISTS trg_document_retired_issue_stamp_insert ON documents;\nCREATE TRIGGER trg_document_retired_issue_stamp_insert\n  BEFORE INSERT ON documents\n  FOR EACH ROW EXECUTE FUNCTION document_retired_issue_stamp_on_insert();");
  });
});

describe("20261144 — P13 review fixes: a NULL status meets the hold; the put-back of a retired issue is spared the require limb (the retirement stamp)", () => {
  it("minor 3: v_new_door COALESCEs v_advancing — the carried v_advancing expression is byte-identical (a NULL NEW.status makes it NULL, and the app calls NULL an issue)", () => {
    expect(next).toContain("  v_new_door := v_issuing\n                AND (NOT COALESCE(v_advancing, false)\n");
    expect(next).not.toContain("v_new_door := v_issuing AND NOT v_advancing;");
    const carried = between(live, "  v_advancing :=\n", "<> 'Archived');\n");
    expect(next).toContain(carried);
    expect(isControlledIssueStatus(null)).toBe(true);
  });

  it("the stamp columns are added in the transaction, before the guard that writes them; nullable, never backfilled", () => {
    const begin = M.indexOf("\nBEGIN;");
    for (const col of ["retired_issue_status text", "retired_issue_version_id uuid"]) {
      const at = M.indexOf(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS ${col};`);
      expect(at, col).toBeGreaterThan(begin);
      expect(at, col).toBeLessThan(M.indexOf(GUARD_HEAD));
    }
    expect(stripComments(M)).not.toMatch(/UPDATE documents SET retired_issue/);
    expect(stripComments(M)).not.toMatch(/ADD COLUMN IF NOT EXISTS retired_issue_\w+ \w+ (?:NOT NULL|DEFAULT)/);
  });

  it("the INSERT side: a signed-in INSERT clears the stamp (not SECURITY DEFINER, search_path pinned, EXECUTE revoked from every client role; the service role untouched); the paste-time probe reads its body", () => {
    const fn = between(M, "CREATE OR REPLACE FUNCTION document_retired_issue_stamp_on_insert()", "\n$$;");
    expect(fn).toMatch(/RETURNS trigger LANGUAGE plpgsql SET search_path = public AS \$\$/);
    expect(fn).not.toMatch(/SECURITY DEFINER/);
    expect(code(fn.split("\n")).slice(2)).toEqual([
      "BEGIN",
      "  IF auth.uid() IS NOT NULL THEN",
      "    IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN",
      "      NEW.retired_issue_status := 'not-issued';",
      "    ELSE",
      "      NEW.retired_issue_status := NULL;",
      "    END IF;",
      "    NEW.retired_issue_version_id := NULL;",
      "  END IF;",
      "  RETURN NEW;",
      "END;",
      "$$;",
    ]);
    expect(M).toMatch(/REVOKE ALL ON FUNCTION document_retired_issue_stamp_on_insert\(\) FROM PUBLIC, anon, authenticated, service_role;/);
    const tail = M.slice(M.lastIndexOf("\nCOMMIT;"));
    const seg = tail.split(/\nUNION ALL\n/).find((x) => x.includes("trg_document_retired_issue_stamp_insert"))!;
    for (const m of seg.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)) {
      for (const f of m[1].replace(/''/g, "'").split("%").filter(Boolean)) expect(fn).toContain(f);
    }
  });

  it("the put-back test is exact: an issue transition, out of a retired status, of the SAME revision the stamp recorded, with no pointer move — and it spares only the require limb (the new-door hold, the publisher tier and the hold after it are untouched)", () => {
    const restoring = between(next, "  v_restoring := COALESCE(v_issuing", ", false);");
    expect(restoring).toContain("AND OLD.status IN ('Superseded', 'Archived', 'Void')");
    expect(restoring).toContain("AND NEW.current_version_id = OLD.retired_issue_version_id");
    expect(restoring).toContain("AND NEW.current_version_id = OLD.current_version_id");
    expect(stripComments(next).match(/v_restoring/g)).toHaveLength(3); // declared, set, read once
    expect(between(next, "    IF NOT is_org_controller(NEW.org_id)\n       AND NOT v_restoring", "THEN\n")).toBeTruthy();
    // the stamp is written only on entry FROM an issue status with a current revision
    expect(next).toContain("    ELSIF OLD.current_version_id IS NOT NULL AND is_controlled_issue_status(OLD.status) THEN\n      NEW.retired_issue_status := OLD.status;\n      NEW.retired_issue_version_id := OLD.current_version_id;");
  });

  it("second review fix (major): a retirement that took away NO issue is stamped 'not-issued' with no revision, and its status-only exit into an issue is the new door — refused over an active hold for everyone, a controller included", () => {
    // entry from a status that is not an issue (or an issue with no revision): the marker, never a revision
    expect(next).toContain("    ELSE\n      NEW.retired_issue_status := 'not-issued';\n      NEW.retired_issue_version_id := NULL;\n    END IF;\n  ELSE\n    NEW.retired_issue_status := NULL;");
    // the marker cannot be mistaken for an issue stamp: an issue stamp always carries its revision, and the test asks for NULL
    const door = between(next, "  v_new_door := v_issuing\n", "false));\n");
    expect(door).toContain("AND OLD.retired_issue_status = 'not-issued'");
    expect(door).toContain("AND OLD.retired_issue_version_id IS NULL");
    // status-only: a pointer move keeps the pointer gate's hold rule (publish_revision's recorded force for a controller)
    expect(door).toContain("NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id");
    expect(door).toContain("AND OLD.status IN ('Superseded', 'Archived', 'Void')");
    // v_new_door is read once, before the controller short-circuit — the hold binds a controller there
    expect(stripComments(next).match(/v_new_door/g)).toHaveLength(3); // declared, set, read
    expect(next.indexOf("    IF v_new_door AND EXISTS (")).toBeLessThan(next.indexOf("  IF is_org_controller(NEW.org_id) THEN\n    RETURN NEW;"));
    // v_restoring never reads the marker (it needs a stamped revision), so the put-back stays the issue's only
    expect(between(next, "  v_restoring := COALESCE(v_issuing", ", false);")).toContain("AND OLD.retired_issue_version_id IS NOT NULL");
    // the paste-time probe pins the widened door and the marker
    const tail = M.slice(M.lastIndexOf("\nCOMMIT;"));
    expect(tail).toContain("OLD.retired_issue_status = ''not-issued''");
    expect(tail).toContain("NEW.retired_issue_status := ''not-issued'';");
  });

  it("second review fix (minor): the guard's owner may run the predicate — granted to it (never to a client role) when it cannot already, and probed after COMMIT", () => {
    const begin = M.indexOf("\nBEGIN;"), commit = M.lastIndexOf("\nCOMMIT;");
    const doAt = M.indexOf("DO $$\nDECLARE\n  v_owner regrole;");
    expect(doAt).toBeGreaterThan(M.indexOf("REVOKE ALL ON FUNCTION enforce_document_publish_guard()"));
    expect(doAt).toBeGreaterThan(begin);
    expect(doAt).toBeLessThan(commit);
    const block = between(M, "DO $$\nDECLARE\n  v_owner regrole;", "\n$$;");
    expect(block).toContain("SELECT p.proowner::regrole INTO v_owner");
    expect(block).toContain("WHERE n.nspname = 'public' AND p.proname = 'enforce_document_publish_guard';");
    expect(block).toContain("AND NOT has_function_privilege(v_owner::oid, 'is_controlled_issue_status(text)', 'EXECUTE') THEN");
    const tail = M.slice(commit);
    const probe = tail.split(/\nUNION ALL\n/).find((x) => x.includes("the guard''s owner"))!;
    expect(probe).toBeTruthy();
    expect(probe).toContain("COALESCE(has_function_privilege((SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace");
    expect(probe).toContain("'is_controlled_issue_status(text)', 'EXECUTE'), false)");
    // the client-role probes still stand: the grant never reaches anon / authenticated
    expect(tail).toContain("AND NOT has_function_privilege('authenticated', 'is_controlled_issue_status(text)', 'EXECUTE')");
  });

  it("no app code writes the stamp (only the guard does); the one app read is the un-archive dialog's default (unarchiveRestoreDefault, a select — P13 second review fix)", () => {
    const roots = ["lib", "components", "app"];
    const walk = (d: string): string[] => readdirSync(join(process.cwd(), d), { withFileTypes: true }).flatMap((e) => {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : walk(p);
      return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
    // code lines only (a comment may name the column)
    const codeLines = (t: string) => t.split("\n").filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l));
    const hits = roots.flatMap(walk).filter((f) => codeLines(readFileSync(join(process.cwd(), f), "utf8")).some((l) => /retired_issue_(status|version_id)/.test(l)));
    expect(hits).toEqual(["lib/revisions.ts"]);
    const rev = readFileSync(join(process.cwd(), "lib/revisions.ts"), "utf8");
    const lines = rev.split("\n").filter((l) => /retired_issue_(status|version_id)/.test(l) && !l.trim().startsWith("*") && !l.trim().startsWith("//"));
    expect(lines.map((l) => l.trim())).toEqual([
      '.select("current_version_id, retired_issue_status, retired_issue_version_id").eq("id", documentId).maybeSingle();',
      "const stampedVersion = (data.retired_issue_version_id as string | null) ?? null;",
      "if (current && !stampedVersion && data.retired_issue_status === RETIRED_NOT_ISSUED_STAMP) return { status: \"Draft\", basis: \"not-issued\" };",
    ]);
  });
});

describe("20261144 — is_controlled_issue_status is isControlledIssueStatus (lib/issueStatus.ts), exactly", () => {
  const fn = between(M, "CREATE OR REPLACE FUNCTION is_controlled_issue_status(p_status text)", "\n$$;");
  const lit = [...fn.matchAll(TRIM_LITERAL_RE)][0][1];
  const trimChars = decodeTrimLiteral(lit);
  const list = fn.match(STATUS_LIST_RE)!;
  const statuses = list[2].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));

  it("an IMMUTABLE sql function, not SECURITY DEFINER, search_path pinned, executable by no client role (only its owner's guard calls it)", () => {
    expect(fn).toMatch(/RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS \$\$/);
    expect(fn).not.toMatch(/SECURITY DEFINER/);
    expect(M).toMatch(/REVOKE ALL ON FUNCTION is_controlled_issue_status\(text\) FROM PUBLIC, anon, authenticated, service_role;/);
    // created before the guard that calls it, inside the one transaction
    expect(M.indexOf("CREATE OR REPLACE FUNCTION is_controlled_issue_status")).toBeGreaterThan(M.indexOf("\nBEGIN;"));
    expect(M.indexOf("CREATE OR REPLACE FUNCTION is_controlled_issue_status")).toBeLessThan(M.indexOf(GUARD_HEAD));
  });

  it("its five statuses are WORK_IN_PROGRESS_STATUSES + NOT_CURRENT_STATUSES, as NOT IN", () => {
    expect(list[1]).toBe("NOT ");
    expect([...statuses].sort()).toEqual([...WORK_IN_PROGRESS_STATUSES, ...NOT_CURRENT_STATUSES].sort());
  });

  it("its trim removes exactly the characters JavaScript's String.prototype.trim removes — no more, no fewer", () => {
    expect([...trimChars].sort()).toEqual([...JS_TRIM_SET].sort());
    expect(new Set(trimChars).size).toBe(trimChars.length);
  });

  it("the SQL predicate (transcribed) and the app's agree on every status the app offers, a library's own, padded and case variants, every single whitespace pad, empty and NULL", () => {
    const offered = [
      // the status editors and the creation / restore lists
      "Draft", "In Review", "Issued", "IFC", "Superseded", "Archived", "Void", "Locked",
      ...revisions.CREATION_STATUSES, ...revisions.UNARCHIVE_RESTORE_STATUSES,
      // a library's own statuses, case variants, look-alikes
      "Approved for Construction", "For Construction", "As-Built", "draft", "DRAFT", "In  Review", "InReview", "Drafts", "Void ", " Archived",
      "", "   ",
    ];
    const cases: Array<string | null> = [null, ...offered];
    for (const ws of JS_TRIM_SET) {
      cases.push(`${ws}Draft`, `In Review${ws}`, `${ws}Issued${ws}`, `${ws}Superseded`);
    }
    // characters trim does NOT remove keep a padded status an issue on both sides
    for (const notWs of ["​", "᠎", "_", "."]) cases.push(`${notWs}Draft`);
    for (const c of cases) {
      expect(sqlIsControlledIssueStatus(c, trimChars, statuses), JSON.stringify(c)).toBe(isControlledIssueStatus(c));
    }
  });

  it("revisions.ts re-exports the same predicates (every creation door's import keeps working)", () => {
    expect(revisions.isControlledIssueStatus).toBe(isControlledIssueStatus);
    expect(revisions.isIssueTransition).toBe(isIssueTransition);
    expect(revisions.WORK_IN_PROGRESS_STATUSES).toBe(WORK_IN_PROGRESS_STATUSES);
  });

  it("the paste-time behaviour probe's expectations are the app's answers", () => {
    const tail = M.slice(M.lastIndexOf("\nCOMMIT;"));
    const values = between(tail, "FROM (VALUES ", ") AS v(s, e)");
    const pairs = [...values.matchAll(/\((NULL|E?'(?:[^'\\]|\\.)*'), (true|false)\)/g)];
    expect(pairs.length).toBeGreaterThanOrEqual(12);
    for (const [, raw, expected] of pairs) {
      const v = raw === "NULL" ? null
        : raw.startsWith("E'") ? decodeTrimLiteral(raw.slice(2, -1)).join("")
        : raw.slice(1, -1).replace(/''/g, "'");
      expect(isControlledIssueStatus(v), JSON.stringify(v)).toBe(expected === "true");
    }
  });

  it("the guard's transition is isIssueTransition: a current revision, out of a not-issue status, into an issue", () => {
    expect(next).toContain("v_issuing := NEW.current_version_id IS NOT NULL\n               AND NOT is_controlled_issue_status(OLD.status)\n               AND is_controlled_issue_status(NEW.status);");
    const sqlTransition = (from: string | null, to: string | null, hasCurrent: boolean) =>
      hasCurrent && !sqlIsControlledIssueStatus(from, trimChars, statuses) && sqlIsControlledIssueStatus(to, trimChars, statuses);
    const sts: Array<string | null> = [null, "", "Draft", "In Review", "Issued", "IFC", "Superseded", "Void", "Archived", "Locked", " Draft ", "draft"];
    for (const from of sts) for (const to of sts) for (const hasCurrent of [true, false]) {
      expect(sqlTransition(from, to, hasCurrent), `${from} -> ${to} (${hasCurrent})`)
        .toBe(isIssueTransition({ fromStatus: from, toStatus: to, hasCurrentRevision: hasCurrent }));
    }
    // the cases the finding names
    expect(isIssueTransition({ fromStatus: "Draft", toStatus: "Issued", hasCurrentRevision: true })).toBe(true);
    expect(isIssueTransition({ fromStatus: "In Review", toStatus: "IFC", hasCurrentRevision: true })).toBe(true);
    expect(isIssueTransition({ fromStatus: "Void", toStatus: "Issued", hasCurrentRevision: true })).toBe(true);
    expect(isIssueTransition({ fromStatus: "Draft", toStatus: "Issued", hasCurrentRevision: false })).toBe(false); // nothing to issue
    expect(isIssueTransition({ fromStatus: "Issued", toStatus: "IFC", hasCurrentRevision: true })).toBe(false); // already an issue
    expect(isIssueTransition({ fromStatus: "Draft", toStatus: "In Review", hasCurrentRevision: true })).toBe(false);
  });

  it("the inventory's status tests use the same trim and the same five statuses", () => {
    const inv = between(M, "CREATE TEMP TABLE dc_round_f_144_before", "\nBEGIN;");
    const lits = [...inv.matchAll(TRIM_LITERAL_RE)].map((m) => m[1]);
    expect(lits).toHaveLength(4);
    for (const l of lits) expect(l).toBe(lit);
    const lists = [...inv.matchAll(/'\) (NOT )?IN \(((?:'[A-Za-z ]+'(?:, )?)+)\)/g)].map((m) => [m[1] ?? "", m[2]]);
    expect(lists).toEqual([
      ["NOT ", "'Draft', 'In Review', 'Superseded', 'Void', 'Archived'"], // in an issue status
      ["", "'Draft', 'In Review'"],                                       // work in progress: its next issue needs a controller
      ["", "'Superseded', 'Void', 'Archived'"],                           // retired before the stamp: its restore needs a controller
      ["", "'Draft', 'In Review'"],                                       // work in progress (the hold row)
    ]);
    // the two not-an-issue rows together are exactly the five statuses (WORK_IN_PROGRESS_STATUSES + NOT_CURRENT_STATUSES)
    expect(["Draft", "In Review", "Superseded", "Void", "Archived"].sort())
      .toEqual([...WORK_IN_PROGRESS_STATUSES, ...NOT_CURRENT_STATUSES].sort());
  });
});

describe("20261144 — the refusals the app recognises are the guard's own sentences", () => {
  it("every sentence isIssueRefusal looks for is in the new guard body", () => {
    for (const s of ISSUE_REFUSAL_SENTENCES) expect(next.replace(/''/g, "'"), s).toContain(s);
    expect(isIssueRefusal("Save refused — nothing was saved: Document has an active hold; release the hold before issuing it.")).toBe(true);
    expect(isIssueRefusal("permission denied for table documents")).toBe(false);
    expect(isIssueRefusal(null)).toBe(false);
  });
});

describe("20261144 — one script, inventory first, one final result set (the one-paste protocol)", () => {
  const TEMP = "dc_round_f_144_before";
  it("the inventory TEMP TABLE is captured BEFORE the one transaction; exactly one statement follows COMMIT", () => {
    const temp = M.indexOf(`CREATE TEMP TABLE ${TEMP}`);
    const begin = M.indexOf("\nBEGIN;");
    const commit = M.lastIndexOf("\nCOMMIT;");
    expect(M.indexOf(`DROP TABLE IF EXISTS ${TEMP};`)).toBeLessThan(temp);
    expect(temp).toBeGreaterThan(0);
    expect(temp).toBeLessThan(begin);
    expect(commit).toBeGreaterThan(begin);
    expect(M.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(M.match(/\nCOMMIT;/g)).toHaveLength(1);
    const tail = stripComments(M.slice(commit + "\nCOMMIT;".length)).replace(/E?'(?:[^'\\]|''|\\.)*'/g, "''");
    expect((tail.match(/;/g) ?? []).length).toBe(1);
    expect(tail.trim().startsWith("SELECT")).toBe(true);
  });
  it("the final SELECT has the fixed (check text, ok boolean, n text) shape and ends with the inventory rows", () => {
    const tail = M.slice(M.lastIndexOf("\nCOMMIT;"));
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail).toMatch(new RegExp(`SELECT inventory, NULL, n FROM ${TEMP};\\s*$`));
  });
  it("the inventory is aggregate counts only — four COUNT(*) rows, never a row, a number or a title", () => {
    const inv = between(M, `CREATE TEMP TABLE ${TEMP}`, "\nBEGIN;");
    const rows = inv.slice(inv.indexOf("\nSELECT 'inventory"));
    expect((rows.match(/^SELECT 'inventory/gm) ?? []).length).toBe(4);
    expect((rows.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(4);
    expect(inv).not.toMatch(/document_number|title|SELECT \*|array_agg|string_agg/);
    // the CTEs aggregate too (count(*) FILTER, sum) — no row escapes into the result
    expect(inv).toMatch(/WITH slot_fill AS \(/);
  });
  it("no LIKE pattern over a deparsed policy (there is none: it probes prosrc, which is verbatim)", () => {
    const tail = M.slice(M.lastIndexOf("\nCOMMIT;"));
    expect(tail).not.toMatch(/(?:qual|with_check) (?:NOT )?LIKE/);
  });
  it("every prosrc probe fragment occurs in the body it reads (apostrophes quadrupled, as prosrc keeps them)", () => {
    const tail = M.slice(M.lastIndexOf("\nCOMMIT;"));
    const body = next.slice(next.indexOf("AS $$") + "AS $$".length, next.length - "$$;".length);
    let checked = 0;
    for (const seg of tail.split(/\nUNION ALL\n/)) {
      if (!/FROM pg_proc WHERE proname = 'enforce_document_publish_guard'/.test(seg)) continue;
      for (const m of seg.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)) {
        for (const f of m[1].replace(/''/g, "'").split("%").filter(Boolean)) {
          expect(body.includes(f), `probe fragment not in the guard: ${f}`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(23);
  });
  it("the header states the paste order: after the guard's base (never re-paste an earlier guard), independent of 20261131", () => {
    const head = M.slice(0, M.indexOf("DROP TABLE IF EXISTS"));
    expect(head).toMatch(/HOW TO APPLY: after 20261139/);
    expect(head).toMatch(/never re-paste 20261139,\n-- 20261105 or any earlier guard migration after this one/);
    expect(head).toMatch(/Independent of 20261131/);
    expect(head).toMatch(/NOT a widening/);
  });
});

// ── The regression census: EVERY app write of documents.status ─────────────
// The user's top rule is "do not break legitimate flows". This census finds
// every write to the documents table in the app (lib/, components/, app/,
// tests excluded) and every publish_revision call, and pins which of them can
// carry a status — so a new status writer cannot appear without being
// classified against 20261144's rule here (and in REV-18's record).
describe("REV-18 — the census of every app write of documents.status (each classified against the issue rule)", () => {
  const roots = ["lib", "components", "app"];
  const walk = (d: string): string[] => readdirSync(join(process.cwd(), d), { withFileTypes: true }).flatMap((e) => {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
  const sources = roots.flatMap(walk).map((f) => ({ f, t: readFileSync(join(process.cwd(), f), "utf8") }));
  /** The balanced argument text of the call whose "(" is at `open`. */
  const argAt = (t: string, open: number) => {
    let depth = 0;
    for (let i = open; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")" && --depth === 0) return t.slice(open + 1, i);
    }
    return "";
  };
  const writes = sources.flatMap(({ f, t }) => [...t.matchAll(/\.from\(\s*["']documents["']\s*\)\s*\.(update|insert|upsert)\(/g)].map((m) => {
    const arg = argAt(t, m.index! + m[0].length - 1);
    return { f, op: m[1], arg: arg.replace(/\s+/g, " ").trim() };
  }));
  const carriesStatus = (arg: string) => /(?:^|[{,\s])status\s*[:,}]/.test(arg);
  const literal = writes.filter((w) => w.arg.startsWith("{") && carriesStatus(w.arg)).map((w) => `${w.f} ${w.op}`);
  const variable = writes.filter((w) => /^[A-Za-z_]\w*$/.test(w.arg)).map((w) => `${w.f} ${w.op}(${w.arg})`);

  it("the literal status writes are exactly these — each one classified", () => {
    // INSERTs are not decided by the publish guard (BEFORE UPDATE); a signed-in
    // INSERT is born pointerless (20261131), and its first pointer write is
    // REV-17's. Entries into Superseded / Archived are OWN-19's (unchanged) and
    // stamp what was issued; a write OUT of Superseded / Archived / Void that
    // puts that same revision back is spared the require-mode limb (P13 review
    // fix); any other exit into an issue status takes it (a controller, or the
    // throw is reported — dcRoundFRevUpFirstIssue.test.ts drives them).
    expect(literal.sort()).toEqual([
      "app/(protected)/documents/[libraryId]/page.tsx insert",  // uploadOne: INSERT (pointerless); its first pointer write is REV-17's
      "app/(protected)/documents/[libraryId]/page.tsx update",  // archive: entry into Archived (OWN-19) — not an issue
      "components/documents/CsvImportModal.tsx insert",          // INSERT, no file: a register row (nothing to issue)
      "lib/documentLifecycle/common.ts insert",                  // createNewDocWithFirstVersion: INSERT; its first pointer write is REV-17's
      "lib/documentLifecycle/common.ts update",                  // archiveRolledBackDoc: entry into Archived — not an issue
      "lib/documentLifecycle/common.ts update",                  // restoreSupersededSource: Superseded -> prior: the put-back of the stamped issue (publisher tier); unstamped (retired before 20261144): controller / complete roster / non-require library, else thrown
      "lib/documentLifecycle/common.ts update",                  // markSupersededAndLink: entry into Superseded — not an issue
      "lib/documentLifecycle/reverse.ts update",                 // put-back of a reversal (controller-only flow): passes
      "lib/documentLifecycle/reverse.ts update",                 // park: entry into Superseded — not an issue
      "lib/documentLifecycle/reverse.ts update",                 // restoreStatus (controller-only flow): passes
      "lib/retention.ts update",                                 // disposition: entry into Archived — not an issue
      "lib/reviewControl.ts update",                             // finalizeReviewedRevision: pointer + Issued — a complete roster, a controller, or a non-require library (intake: SEC-13 already)
      "lib/revisions.ts insert",                                 // createDocumentWithFile: INSERT; first pointer REV-17's
      "lib/revisions.ts update",                                 // archiveDocument: entry into Archived — not an issue
      "lib/revisions.ts update",                                 // unarchiveDocument: Archived -> the status the dialog asks (P13 second review fix; was always Issued). Default Issued, as before, unless 20261144's stamp says the archive took away no issue of the current revision (then Draft — P13 third review fix: never Draft on no evidence). To an issue: publisher tier (as before) + the require-mode limb unless it puts back the stamped issue; checked write (.select("id"), zero rows refused)
      "lib/revisions.ts update",                                 // undoFailedSupersede: Superseded -> prior: the put-back of the stamped issue (publisher tier); a refused restore is thrown with "ask Doc Control"
      "lib/revisions.ts update",                                 // supersedeDocument: entry into Superseded — not an issue
    ].sort());
  });

  it("the variable-payload writes are exactly these, and only the two status editors put a status on theirs", () => {
    expect(variable.sort()).toEqual([
      "app/(protected)/documents/[libraryId]/page.tsx update(payload)", // saveMetadata — the MetadataEditor's status (controller-only UI); throws the refusal, the editor shows it
      "app/api/intake/upload/route.ts insert(docRow)",                   // the external door: INSERT (status Draft) as the service role
      "app/api/intake/upload/route.ts insert(docRow)",                   // (its retry after a key collision) — the same row
      "components/documents/BulkEditModal.tsx update(updates)",         // the bulk editor (controller-only UI): per-row, refused rows named
      "lib/retention.ts update(patch)",                                 // legal hold fields only
      "lib/retention.ts update(patch)",                                 // legal hold release only
      "lib/transitionIn.ts update(patch)",                              // adoption: library / collection / key / number — no status
    ].sort());
    const page = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
    expect(page.match(/payload\.status\s*=/g)).toHaveLength(1);
    expect(readFileSync(join(process.cwd(), "components/documents/BulkEditModal.tsx"), "utf8").match(/updates\.status\s*=/g)).toHaveLength(1);
    for (const f of ["lib/retention.ts", "lib/transitionIn.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(/patch\.status\s*=|patch\s*=\s*\{[^}]*\bstatus\b/);
    }
  });

  it("publish_revision is called with a new status only by revUpDocument and revertToVersion (both 'Issued'); the first-issue rev-up is asked up front", () => {
    const calls = sources.flatMap(({ f, t }) => [...t.matchAll(/p_new_status:\s*([^,\n]+)/g)].map((m) => `${f} ${m[1].trim()}`));
    expect(calls).toEqual(["lib/revisions.ts \"Issued\"", "lib/revisions.ts \"Issued\""]);
  });
});
