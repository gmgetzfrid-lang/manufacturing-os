// document-control Round F wave 3 — P23 DIRECT-WRITE ISSUE RECORD: migration
// 20261205 (REV-19 (a), projects-tab SEC-23).
//
//   §1 a new AFTER UPDATE OF status trigger on documents
//      (record_document_status_issue) — the ONE writer of DOCUMENT_ISSUED for
//      a status-change issue — and the app's probe
//      (document_status_issue_recorded_by_database). Its predicates are the
//      guard's (is_controlled_issue_status, 20261185's REV-21 limb — the
//      NEWEST guard body, found by scanning) and the app's (isEntryIntoForce,
//      putBackFromRetirementStamp, STATUS_ISSUE_CLOCKS_OWED_NOTE — pinned
//      here; P23 fix pass: the database's row records what the issue OWES,
//      never that a clock started, whatever header the write carried).
//   §2 document_versions_insert_integrity re-created from its NEWEST body
//      (scan: 20261037) with ONE change — the first-version sublink on
//      document_versions replaced by document_has_versions(record_id) — so
//      no INSERT policy of document_versions reads document_versions under
//      the caller's row-level security (SEC-23's 42P17).
//
// The script was run on a throwaway PostgreSQL 16 carrying schema.sql and the
// whole numbered sequence (REV-19's and SEC-23's records list the cases).

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
import { STATUS_ISSUE_CLOCKS_NOTE, STATUS_ISSUE_CLOCKS_OWED_NOTE, ISSUE_DOOR_HEADER } from "@/lib/revisions";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261205_dc_roundF_direct_write_issue_record.sql";
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
const sqlString = (s: string) => s.replace(/'/g, "''");

const FN = between(M, "CREATE OR REPLACE FUNCTION record_document_status_issue()", "\n$$;");
const POLICY_HEAD = "CREATE POLICY document_versions_insert_integrity ON document_versions";
const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";

describe("20261205 — DEC-30 one-paste shape", () => {
  it("prerequisite check, then the counts-only inventory BEFORE the transaction, one BEGIN / COMMIT, one final SELECT (check, ok, n) ending with the inventory", () => {
    const code = stripComments(M);
    const iDo = code.indexOf("DO $$"), iTemp = code.indexOf("CREATE TEMP TABLE dc_round_f_205_before"), iBegin = code.indexOf("\nBEGIN;"), iCommit = code.indexOf("\nCOMMIT;");
    expect(iDo).toBeGreaterThanOrEqual(0);
    expect(iDo).toBeLessThan(iTemp);
    expect(iTemp).toBeLessThan(iBegin);
    expect(iBegin).toBeLessThan(iCommit);
    expect(code.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(code.match(/\nCOMMIT;/g)).toHaveLength(1);
    const tail = code.slice(iCommit);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    expect(tail.trim().endsWith("SELECT inventory, NULL::boolean, n FROM dc_round_f_205_before;")).toBe(true);
    // the inventory is aggregate counts only — never a customer row
    const inv = between(code, "CREATE TEMP TABLE dc_round_f_205_before AS", ";\n");
    for (const sel of inv.split(/UNION ALL/)) expect(sel).toMatch(/COUNT\(\*\)::text/);
    expect(M).toMatch(/refuse to run, changing nothing/);
  });

  it("creates exactly three functions (none re-created), one trigger, one policy — the publish guard and every other function untouched", () => {
    const code = stripComments(M);
    const fns = [...code.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((m) => m[1]);
    expect(fns).toEqual(["record_document_status_issue", "document_status_issue_recorded_by_database", "document_has_versions"]);
    for (const f of fns) {
      const elsewhere = files.filter((x) => x !== FILE && stripComments(mig(x)).includes(`FUNCTION ${f}(`));
      expect(elsewhere, `${f} must be new`).toEqual([]);
    }
    expect(code).not.toContain(GUARD_HEAD);
    expect([...code.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1])).toEqual(["trg_document_status_issue_record"]);
    expect([...code.matchAll(/CREATE POLICY (\w+)/g)].map((m) => m[1])).toEqual(["document_versions_insert_integrity"]);
  });

  it("DRLS-16: both SECURITY DEFINER functions pin search_path; EXECUTE is revoked from PUBLIC and anon (the trigger function from authenticated too) and granted narrowly", () => {
    expect(FN).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(M).toContain("REVOKE ALL ON FUNCTION record_document_status_issue() FROM PUBLIC, anon, authenticated;");
    expect(M).not.toMatch(/GRANT EXECUTE ON FUNCTION record_document_status_issue/);
    const helper = between(M, "CREATE OR REPLACE FUNCTION document_has_versions(p_record uuid)", "\n$$;");
    expect(helper).toMatch(/LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(M).toContain("REVOKE ALL ON FUNCTION document_has_versions(uuid) FROM PUBLIC, anon;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION document_has_versions(uuid) TO authenticated, service_role;");
    const probe = between(M, "CREATE OR REPLACE FUNCTION document_status_issue_recorded_by_database()", "\n$$;");
    expect(probe).toMatch(/LANGUAGE sql STABLE SET search_path = public AS \$\$/);
    expect(probe).not.toMatch(/SECURITY DEFINER/);
    expect(M).toContain("REVOKE ALL ON FUNCTION document_status_issue_recorded_by_database() FROM PUBLIC, anon;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION document_status_issue_recorded_by_database() TO authenticated, service_role;");
  });
});

describe("20261205 §1 — REV-19 (a): the database's record of a status-change issue", () => {
  it("fires AFTER UPDATE OF status, per row, only when the status changed; the probe looks for exactly that trigger, bound and enabled", () => {
    expect(M).toContain("CREATE TRIGGER trg_document_status_issue_record\nAFTER UPDATE OF status ON documents\nFOR EACH ROW\nWHEN (OLD.status IS DISTINCT FROM NEW.status)\nEXECUTE FUNCTION record_document_status_issue();");
    expect(M).toMatch(/t\.tgname = 'trg_document_status_issue_record'[\s\S]*AND NOT t\.tgisinternal[\s\S]*AND t\.tgenabled <> 'D'/);
    // the app asks the same function name
    expect(src("lib/revisions.ts")).toContain('supabase.rpc("document_status_issue_recorded_by_database")');
  });

  it("records only what the guard judged a status-only issue: a signed-in caller, the pointer unmoved, v_issuing — the same two limbs as the NEWEST guard body", () => {
    expect(FN).toMatch(/IF v_actor IS NULL THEN\n    RETURN NULL;\n  END IF;/);
    expect(FN).toMatch(/IF NEW\.current_version_id IS NULL\n     OR NEW\.current_version_id IS DISTINCT FROM OLD\.current_version_id THEN\n    RETURN NULL;/);
    const guardFiles = files.filter((f) => f !== FILE && stripComments(mig(f)).includes(GUARD_HEAD));
    const newest = guardFiles[guardFiles.length - 1];
    const guard = between(mig(newest), GUARD_HEAD, "\n$$;");
    // limb 1 (20261144) and the REV-21 limb (20261185), as the guard writes them
    expect(guard).toContain("AND NOT is_controlled_issue_status(OLD.status)\n               AND is_controlled_issue_status(NEW.status);");
    expect(guard).toContain("AND is_controlled_issue_status(OLD.status)\n                           AND COALESCE(OLD.status, '') NOT IN ('Issued', 'Locked')\n                           AND NEW.status IN ('Issued', 'Locked'), false);");
    expect(FN).toContain("(NOT is_controlled_issue_status(OLD.status) AND is_controlled_issue_status(NEW.status))");
    expect(FN).toContain("OR COALESCE(is_controlled_issue_status(OLD.status)\n                   AND COALESCE(OLD.status, '') NOT IN ('Issued', 'Locked')\n                   AND NEW.status IN ('Issued', 'Locked'), false)");
  });

  it("trims the status exactly as is_controlled_issue_status (20261144) trims — the JS trim characters", () => {
    const defs = files.filter((f) => stripComments(mig(f)).includes("CREATE OR REPLACE FUNCTION is_controlled_issue_status("));
    const body = between(mig(defs[defs.length - 1]), "CREATE OR REPLACE FUNCTION is_controlled_issue_status(", "\n$$;");
    const chars = body.match(/btrim\(COALESCE\(p_status, ''\), (E'[^']*')\)/)![1];
    expect(FN).toContain(`v_from := btrim(COALESCE(OLD.status, ''), ${chars});`);
    expect(FN).toContain("v_retired := v_from IN ('Superseded', 'Void', 'Archived');");
  });

  it("entryIntoForce and the three-state putBack transcribe lib/revisions.ts isEntryIntoForce / putBackFromRetirementStamp", () => {
    const rev = src("lib/revisions.ts");
    expect(rev).toContain("return isRetiredStatus(row.status)\n    && (row.retiredIssueVersionId ?? null) === row.currentVersionId\n    && !IN_FORCE_STATUSES.has(row.retiredIssueStatus ?? \"\");");
    expect(FN).toMatch(/v_entry := COALESCE\(NEW\.status IN \('Issued', 'Locked'\), false\)\n\s+AND \(\n\s+\(is_controlled_issue_status\(OLD\.status\) AND COALESCE\(OLD\.status, ''\) NOT IN \('Issued', 'Locked'\)\)\n\s+OR \(v_retired\n\s+AND OLD\.retired_issue_version_id IS NOT NULL\n\s+AND OLD\.retired_issue_version_id = OLD\.current_version_id\n\s+AND COALESCE\(OLD\.retired_issue_status, ''\) NOT IN \('Issued', 'Locked'\)\)/);
    const order = ["IF v_entry THEN\n    v_put_back := false;", "ELSIF v_from IN ('Draft', 'In Review') THEN\n    v_put_back := false;", "ELSIF NOT v_retired THEN\n    v_put_back := NULL;",
      "ELSIF OLD.retired_issue_version_id IS NOT NULL AND OLD.retired_issue_version_id = OLD.current_version_id THEN\n    v_put_back := true;",
      "ELSIF OLD.retired_issue_version_id IS NULL AND OLD.retired_issue_status = 'not-issued' THEN\n    v_put_back := false;", "ELSE\n    v_put_back := NULL;"];
    let at = -1;
    for (const o of order) { const i = FN.indexOf(o); expect(i, o).toBeGreaterThan(at); at = i; }
  });

  it("the record keeps the app doors' shape: DOCUMENT_ISSUED with the door (the app's header — a rollback's door included — else 'direct'), statuses, revision, putBack, entryIntoForce, the policy decision, the headline role and the role collection", () => {
    expect(FN).toContain(`current_setting('request.headers', true), '')::jsonb ->> '${ISSUE_DOOR_HEADER}'`);
    expect(FN).toContain("v_door := CASE WHEN v_header IN ('metadata', 'bulk') THEN v_header\n                 WHEN v_header = 'unarchive' AND v_from = 'Archived' THEN v_header\n                 WHEN v_header IN ('supersede_rollback', 'lifecycle_rollback', 'reversal_rollback') AND v_retired THEN v_header\n                 WHEN v_path = '/rpc/restore_reversed_source' AND v_retired THEN 'reversal_restore'\n                 ELSE 'direct' END;");
    // the rollback doors the header may name are exactly put_back_retired_issue's p_via (the app's type)
    const rev = src("lib/revisions.ts");
    const vias = /export type RetiredIssuePutBackDoor = ([^;]+);/.exec(rev)![1].split("|").map((x) => x.trim().replace(/"/g, "")).filter((x) => x !== "unarchive");
    expect(FN).toContain(`WHEN v_header IN (${vias.map((v) => `'${v}'`).join(", ")}) AND v_retired THEN v_header`);
    for (const k of ["door", "fromStatus", "toStatus", "versionId", "rev", "putBack", "entryIntoForce", "compensation", "reviewPolicyMode", "rosterComplete", "issuedWithoutSignOff",
      "complianceClocksStarted", "reviewClockReset", "acknowledgmentRosterOpened", "complianceClocksOwed", "complianceClocksNote", "complianceClockErrors", "complianceClocksBy",
      "actorRoles", "recordedBy", "requestPath"]) {
      expect(FN, k).toContain(`'${k}'`);
    }
    expect(FN).toContain("VALUES ('DOCUMENT_ISSUED', NEW.id::text, 'document', NEW.org_id, v_actor, v_email, v_role,");
    // P23 second review fix: a rollback's put-back (a compensation of a failed saga) is marked, exactly for the rollback doors, so a count of issues can leave it out
    expect(FN).toContain(`|| CASE WHEN v_door IN (${vias.map((v) => `'${v}'`).join(", ")}) THEN jsonb_build_object('compensation', true) ELSE '{}'::jsonb END`);
    // P23 fix pass: user_role is the headline role, as the app's doors wrote it; the collection rides in details
    expect(FN).toContain("SELECT m.email, m.role, COALESCE(NULLIF(m.roles, '{}'), ARRAY[m.role]) INTO v_email, v_role, v_roles");
    expect(FN).toContain("'actorRoles', to_jsonb(v_roles),");
    expect(FN).not.toMatch(/array_to_string\(/);
    // the roster counted exactly as the guard counts it (bound e-signatures, per slot group)
    expect(FN).toContain("AND e.signer_user_id = s.reviewer_user_id");
    expect(FN).toContain("v_roster := COALESCE(v_reqs, 0) > 0 AND COALESCE(v_signed, 0) >= v_reqs;");
    expect(FN).toContain("v_mode := CASE WHEN v_chain = 'require'\n                   OR review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id) = 'require'\n                 THEN 'require' ELSE v_chain END;");
  });

  it("P23 fix pass: the clock fields record what the issue OWES — never that a clock started — and never read the header; a put-back wins first and is never told to restart a clock", () => {
    const clocks = between(FN, "v_owes_review := ", "\n  END;");
    // header-independent: the owed flags and the sentence read only the put-back state
    for (const v of ["v_door", "v_header", "v_app_door", "v_path"]) expect(clocks, v).not.toContain(v);
    expect(clocks).toContain("v_owes_review := v_put_back IS NOT DISTINCT FROM false AND NOT v_entry;");
    expect(clocks).toContain("v_owes_roster := v_put_back IS DISTINCT FROM true;");
    // the CASE: put-back first, then entry into force, new issue, unknown — the database's own sentences, verbatim
    const order = ["WHEN v_put_back IS NOT DISTINCT FROM true THEN", "WHEN v_entry THEN", "WHEN v_put_back IS NOT DISTINCT FROM false THEN", "ELSE"];
    let at = -1;
    for (const o of order) { const i = clocks.indexOf(o, at + 1); expect(i, o).toBeGreaterThan(at); at = i; }
    for (const [k, note] of Object.entries(STATUS_ISSUE_CLOCKS_OWED_NOTE)) expect(FN, k).toContain(`'${sqlString(note)}'`);
    expect(clocks.indexOf(`'${sqlString(STATUS_ISSUE_CLOCKS_OWED_NOTE.putBack)}'`)).toBeLessThan(clocks.indexOf("WHEN v_entry THEN"));
    // a put-back's sentence owes nothing and advises no start
    expect(STATUS_ISSUE_CLOCKS_OWED_NOTE.putBack).toMatch(/nothing is owed/);
    expect(STATUS_ISSUE_CLOCKS_OWED_NOTE.putBack).not.toMatch(/Document Control then|starts both|opens the roster/);
    // the "unknown" and "entry" sentences never advise resetting the review clock
    for (const k of ["unknown", "entryIntoForce"] as const) expect(STATUS_ISSUE_CLOCKS_OWED_NOTE[k]).toMatch(/the review clock is not to be reset[\s\S]*leaves the review clock as it is$/);
    // no sentence claims anything started: the app's past-tense sentences are NOT in the database's body
    for (const [k, note] of Object.entries(STATUS_ISSUE_CLOCKS_NOTE)) {
      if (k === "putBack") continue; // its words differ too, but share the stamp clause
      expect(FN, k).not.toContain(`'${sqlString(note)}'`);
    }
    expect(FN).not.toMatch(/were started|was opened/);
    // the three outcome fields are NULL on the database's row; complianceClocksOwed carries the owed flags
    expect(FN).toContain("'complianceClocksStarted', NULL::boolean,\n            'reviewClockReset', NULL::boolean,\n            'acknowledgmentRosterOpened', NULL::boolean,");
    expect(FN).toContain("'complianceClocksOwed', jsonb_build_object('reviewClock', v_owes_review, 'acknowledgmentRoster', v_owes_roster),");
    expect(FN).toContain("WHEN NOT v_owes_roster THEN 'none owed (a put-back: the clocks it had keep running)'");
    expect(FN).not.toContain("v_clock");
  });

  it("the app's doors send the header the trigger reads only once the database records (the probe, before the write): changeDocumentStatus, the un-archive (RPC and direct write), and every rollback's put-back (its p_via)", () => {
    const rev = src("lib/revisions.ts");
    expect(ISSUE_DOOR_HEADER).toBe("x-mos-issue-door");
    expect(rev).toContain('    .select("id"), recordedByDatabase ? input.door : null);');
    expect(rev).toContain('  }), nameDoor ? input.door : null);');
    expect(rev).toContain("  const nameDoor = input.nameDoor ?? await isStatusIssueRecordedByDatabase();");
    // the un-archive passes its own probe answer — on its own line, so P19's pinned `forceHold` line stays byte for byte
    expect(rev).toContain("    nameDoor: recordedByDatabase,\n    forceHold: input.forceHold === true,\n  });");
    expect(rev).toContain('      .select("id"), recordedByDatabase ? "unarchive" : null);');
    expect(rev).toContain("  const recordedByDatabase = isControlledIssueStatus(input.toStatus) ? await isStatusIssueRecordedByDatabase() : false;");
  });
});

describe("20261205 §2 — SEC-23: document_versions_insert_integrity without the recursive read", () => {
  const policyFiles = files.filter((f) => stripComments(mig(f)).includes(POLICY_HEAD));
  const base = policyFiles[policyFiles.indexOf(FILE) - 1];
  const live = between(mig(base), "DROP POLICY IF EXISTS document_versions_insert_integrity ON document_versions;", "\n);");
  const next = between(M, "DROP POLICY IF EXISTS document_versions_insert_integrity ON document_versions;", "\n);");

  it("is re-created from its NEWEST earlier body (scanned: 20261037 today) with exactly one change — the sublink replaced by document_has_versions", () => {
    expect(base).toBe("20261037_rp_phase3b_read_ownership_and_version_integrity.sql");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([
      "      OR NOT EXISTS (SELECT 1 FROM document_versions v2",
      "                     WHERE v2.record_id = document_versions.record_id)",
    ]);
    expect(onlyInB).toEqual(["      OR NOT document_has_versions(document_versions.record_id)"]);
    // the preceding comment, verbatim
    expect(M).toContain(between(mig(base), "-- INSERT: publisher-grade for anything", "the exact EGRESS-6 hole."));
  });

  it("no INSERT-capable policy of document_versions, at its newest definition anywhere in the sequence, reads document_versions in a sublink", () => {
    const sources = [{ f: "schema.sql", t: readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8") }, ...files.map((f) => ({ f, t: mig(f) }))];
    const latest = new Map<string, string | null>();
    for (const { t } of sources) {
      const code = stripComments(t);
      const re = /(DROP POLICY IF EXISTS\s+"?(\w+)"?\s+ON\s+(?:public\.)?document_versions\s*;)|(CREATE POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?document_versions\b([\s\S]*?);\s*\n)/g;
      for (const m of code.matchAll(re)) {
        if (m[2]) latest.set(m[2], null);
        else latest.set(m[4], m[5]);
      }
    }
    const insertCapable = [...latest.entries()].filter(([, body]) => body && /FOR\s+(INSERT|ALL)\b|^(?![\s\S]*\bFOR\b)/i.test(body));
    expect(insertCapable.map(([n]) => n).sort()).toEqual(["document_versions_insert_integrity", "document_versions_org_access"]);
    for (const [name, body] of insertCapable) expect(body, name).not.toMatch(/FROM\s+(?:public\.)?document_versions\b/i);
  });

  it("the helper counts every version as the owner, and answers NULL (never true or false) outside the caller's workspaces or for a hidden document", () => {
    const helper = between(M, "CREATE OR REPLACE FUNCTION document_has_versions(p_record uuid)", "\n$$;");
    expect(helper).toContain("SELECT CASE WHEN EXISTS (SELECT 1 FROM documents d\n                            WHERE d.id = p_record AND d.org_id IN (SELECT my_org_ids()))\n                   AND doc_is_visible(p_record)\n              THEN EXISTS (SELECT 1 FROM document_versions v WHERE v.record_id = p_record)\n         END;");
  });
});
