// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS: shape
// pins on 20261150, DRLS-10 done-when 3's database half — a pin moved by ANY
// door (the app's refresh, a direct PostgREST PATCH by the owner or a
// controller, the service role) writes its own record in the same
// transaction, naming from → to and whether the old pin was stale.
//
//   · one NEW trigger (AFTER UPDATE OF pinned_version_id, only when the pin
//     moves) and its recorder; 20261033's pin guard and 20261032's policies
//     are not re-created;
//   · the recorder is SECURITY DEFINER, search_path pinned, executable by no
//     client role; it reads auth.uid() only to attribute (a NULL — the
//     service role — is recorded as such, never trusted for anything);
//   · the DEC-30 one-paste shape; every probe pattern is in the body it reads.
// The script was run on a throwaway PostgreSQL 16 (cases in DRLS-10's record).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dir = join(root, "supabase", "migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261150_dc_roundF_work_package_repin_record.sql";
const M = read(FILE);
const numbered = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const HEAD = "CREATE OR REPLACE FUNCTION record_work_package_repin()";
const body = M.slice(M.indexOf(HEAD), M.indexOf("\n$$;", M.indexOf(HEAD)));
const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

describe("20261150 — DRLS-10: a moved pin is on the record, whoever moves it", () => {
  it("defines ONE new function and ONE new trigger; re-creates nothing another migration defines (the pin guard and policies stay)", () => {
    const code = stripComments(M);
    expect([...code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/gi)].map((m) => m[1])).toEqual(["record_work_package_repin"]);
    expect([...code.matchAll(/CREATE\s+TRIGGER\s+(\w+)/gi)].map((m) => m[1])).toEqual(["trg_wpd_repin_record"]);
    expect(code).not.toMatch(/enforce_wpd_pin_guard\s*\(\)\s*RETURNS|CREATE\s+TRIGGER\s+trg_wpd_pin_guard|POLICY|ALTER\s+TABLE/i);
    for (const f of numbered.filter((x) => x < FILE)) {
      expect(stripComments(read(f)), f).not.toMatch(/record_work_package_repin|trg_wpd_repin_record/);
    }
  });

  it("fires AFTER UPDATE OF pinned_version_id, per row, ONLY when the pin moves (a same-value rewrite or a label-only write records nothing)", () => {
    expect(stripComments(M)).toContain(
      "CREATE TRIGGER trg_wpd_repin_record\n  AFTER UPDATE OF pinned_version_id ON work_package_documents\n  FOR EACH ROW\n  WHEN (OLD.pinned_version_id IS DISTINCT FROM NEW.pinned_version_id)\n  EXECUTE FUNCTION record_work_package_repin();",
    );
  });

  it("writes one audit row in the same transaction — action, package, org, actor — carrying from → to, the current revision and the stale signal", () => {
    expect(body).toContain("INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)");
    expect(body).toContain("VALUES ('WORK_PACKAGE_PIN_MOVED', NEW.package_id::text, 'work_package', NEW.org_id, v_actor, v_email,");
    for (const k of [
      "'documentId', NEW.document_id",
      "'fromVersionId', OLD.pinned_version_id",
      "'fromRev', OLD.pinned_rev_label",
      "'toVersionId', NEW.pinned_version_id",
      "'toRev', NEW.pinned_rev_label",
      "'currentVersionId', v_current",
      "'wasStale', OLD.pinned_version_id IS DISTINCT FROM v_current",
      "'toCurrent', NEW.pinned_version_id IS NOT DISTINCT FROM v_current",
      "'source', 'database'",
    ]) expect(body, k).toContain(k);
    // No EXCEPTION handler: a record that cannot be written fails the move.
    expect(body).not.toMatch(/\bEXCEPTION\b/);
    expect(body).toContain("RETURN NULL;");
  });

  it("DRLS-16: SECURITY DEFINER, search_path pinned, no client EXECUTE; auth.uid() only attributes (no branch trusts a NULL)", () => {
    expect(body).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(M).toContain("REVOKE ALL ON FUNCTION record_work_package_repin() FROM PUBLIC, anon, authenticated, service_role;");
    expect(M).not.toMatch(/GRANT\s+EXECUTE/i);
    // the only use of the uid: the actor column, and the email lookup when it is known
    expect(body).toContain("v_actor   uuid := auth.uid();");
    expect(body).toMatch(/IF v_actor IS NOT NULL THEN\n\s+SELECT m\.email INTO v_email/);
    expect(body).not.toMatch(/RETURN NEW|IF v_actor IS NULL THEN\s+RETURN/);
  });

  it("one paste: inventory TEMP TABLE (counts only) before BEGIN, one BEGIN/COMMIT, ONE final SELECT (check, ok, n)", () => {
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_150_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    const counts = [...inventory.matchAll(/^\s*(COUNT\(\*\)::text)/gm)].length;
    expect(counts).toBe(3);
    expect(inventory).not.toMatch(/SELECT\s+\*|wpd\.id|pinned_version_id\s*,/);
    const code = stripComments(tail);
    expect((code.match(/^SELECT /gm) ?? []).length).toBe(1);
    expect(code).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(code).toContain("UNION ALL SELECT inventory, NULL::boolean, n FROM dc_round_f_150_before;");
  });

  it("every probe pattern is in the text it reads (prosrc verbatim, the trigger's deparse) and none carries a cast", () => {
    const pats = [...tail.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(pats.length).toBe(5);
    for (const p of pats) {
      expect(p).not.toMatch(/::/);
      expect(body, p).toContain(p.replace(/^%|%$/g, ""));
    }
    const def = [...tail.matchAll(/pg_get_triggerdef\(oid\) LIKE '((?:[^']|'')*)'/g)].map((m) => m[1]);
    // the PostgreSQL 16 deparse of the trigger (verified on the scratch cluster)
    expect(def).toEqual(["%AFTER UPDATE OF pinned_version_id ON public.work_package_documents FOR EACH ROW WHEN ((old.pinned_version_id IS DISTINCT FROM new.pinned_version_id)) EXECUTE FUNCTION record_work_package_repin()%"]);
  });

  it("the header states the paste order against 20261131 / 20261139 / 20261143 / 20261144 and the pin guard's base", () => {
    const head = M.slice(0, M.indexOf("DROP TABLE IF EXISTS"));
    expect(head).toMatch(/after 20261033/);
    expect(head).toMatch(/Independent of 20261131, 20261139, 20261143/);
    expect(head).toMatch(/and 20261144/);
  });
});

describe("DRLS-10 — the app's refresh is unchanged and now meets the trigger", () => {
  it("refreshWorkPackage still writes its summary BEFORE moving pins, and moves them with an UPDATE of pinned_version_id (the trigger's column)", () => {
    const src = readFileSync(join(root, "lib", "workPackages.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function refreshWorkPackage("));
    expect(fn.indexOf('action: "WORK_PACKAGE_REPINNED"')).toBeGreaterThan(0);
    expect(fn.indexOf('action: "WORK_PACKAGE_REPINNED"')).toBeLessThan(fn.indexOf(".update({\n        pinned_version_id:"));
  });
});
