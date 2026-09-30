// projects Round G — J1 INTAKE-DOOR: the shape of migrations 20261104 and
// 20261105, and the byte-fidelity of the two live functions 20261105
// re-creates (the lineDiff pattern of rpPhase5Migration / sweepRoundD3).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const A = mig("20261104_prj_roundG_intake_links.sql");
const B = mig("20261105_prj_roundG_intake_review_and_attempts.sql");

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
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

describe("paste protocol — one script, inventory first, one final result set", () => {
  for (const [name, text] of [["20261104", A], ["20261105", B]] as const) {
    it(`${name}: the inventory TEMP TABLE is captured BEFORE the transaction, and the final SELECT follows COMMIT`, () => {
      const temp = text.indexOf("CREATE TEMP TABLE");
      const begin = text.indexOf("\nBEGIN;");
      const commit = text.lastIndexOf("\nCOMMIT;");
      expect(temp).toBeGreaterThan(0);
      expect(temp).toBeLessThan(begin);
      expect(commit).toBeGreaterThan(begin);
      const tail = stripComments(text.slice(commit + "\nCOMMIT;".length));
      // exactly one statement after COMMIT: the verification SELECT (string
      // literals removed before counting statement terminators)
      const bare = tail.replace(/'(?:[^']|'')*'/g, "''");
      expect(bare.split(";").filter((s) => s.trim()).length).toBe(1);
      expect(tail).toMatch(/SELECT '[^']+' AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
      // inventory rows carry ok NULL and n text
      expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM prj_g_j1[ab]_inventory;\s*$/);
    });
  }
  it("inventories are aggregate counts only — never customer rows", () => {
    for (const text of [A, B]) {
      const inv = text.slice(text.indexOf("CREATE TEMP TABLE"), text.indexOf("\nBEGIN;"));
      const rows = [...inv.matchAll(/SELECT '(inventory:(?:[^']|'')*)'([\s\S]*?)\bFROM\b/g)];
      expect(rows.length).toBeGreaterThan(3);
      for (const m of rows) expect(m[2], m[1]).toMatch(/COUNT\(/);
    }
  });
});

describe("20261104 — the intake link as a bounded credential", () => {
  it("authored_by_link_id: FK ON DELETE SET NULL, backfilled from each document's FIRST version, org-checked", () => {
    expect(A).toMatch(/ALTER TABLE documents ADD COLUMN IF NOT EXISTS authored_by_link_id UUID\s*\n\s*REFERENCES project_intake_links\(id\) ON DELETE SET NULL;/);
    const backfill = between(A, "UPDATE documents d\n   SET authored_by_link_id", ";");
    expect(backfill).toContain("ORDER BY v.record_id, v.created_at ASC, v.id ASC");
    expect(backfill).toContain("d.authored_by_link_id IS NULL");
    expect(backfill).toContain("l.org_id = d.org_id");
  });
  it("the assignment guard: a TRIGGER (not a second permissive policy), org-scoped, publish-grade, service-role exempt, pinned", () => {
    const fn = between(A, "CREATE OR REPLACE FUNCTION enforce_intake_link_assignment()", "\n$$;");
    expect(fn).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(fn).toMatch(/IF v_actor IS NULL THEN\s*\n\s*RETURN NEW;/);
    expect(fn).toContain("v_doc.found_id IS NULL OR v_doc.org_id IS DISTINCT FROM NEW.org_id");
    expect(fn).toContain("NOT is_org_controller(NEW.org_id)");
    expect(fn).toContain("NOT user_can_publish_on_library(v_doc.library_id, v_actor::text, NEW.org_id)");
    expect(fn).toContain("cardinality(COALESCE(NEW.assigned_doc_ids, '{}'::uuid[])) > 500");
    // only NEW entries are checked — removal is always allowed
    expect(fn).toContain("WHERE NOT (x = ANY (v_before));");
    expect(A).toMatch(/CREATE TRIGGER trg_intake_links_assignment_guard\s*\n\s*BEFORE INSERT OR UPDATE OF assigned_doc_ids ON project_intake_links/);
    expect(stripComments(A)).not.toMatch(/CREATE POLICY/);
  });
  it("bump_intake_use: the one-argument form dropped, the byte-counting form service-role only (INTK-14)", () => {
    expect(A).toContain("DROP FUNCTION IF EXISTS bump_intake_use(uuid);");
    expect(A).toMatch(/CREATE OR REPLACE FUNCTION bump_intake_use\(p_link uuid, p_bytes bigint DEFAULT 0\)\s*\nRETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(A).toContain("REVOKE ALL ON FUNCTION bump_intake_use(uuid, bigint) FROM PUBLIC, anon, authenticated;");
    expect(A).toContain("GRANT EXECUTE ON FUNCTION bump_intake_use(uuid, bigint) TO service_role;");
    // the budget columns exist before the counter body that fills them
    expect(A.indexOf("ADD COLUMN IF NOT EXISTS bytes_received")).toBeLessThan(A.indexOf("CREATE OR REPLACE FUNCTION bump_intake_use"));
  });
  it("PM-2: orphans are REVOKED (never deleted), the FK is added NOT VALID and validated only in the no-orphan world", () => {
    expect(A).toMatch(/UPDATE project_intake_links l\s*\n\s*SET revoked_at = NOW\(\)\s*\n\s*WHERE l\.revoked_at IS NULL\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM projects p WHERE p\.id = l\.project_id\);/);
    expect(A).toContain("FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE NOT VALID;");
    expect(A).toMatch(/IF NOT EXISTS \(SELECT 1 FROM project_intake_links l\s*\n\s*WHERE NOT EXISTS \(SELECT 1 FROM projects p WHERE p\.id = l\.project_id\)\) THEN\s*\n\s*ALTER TABLE project_intake_links VALIDATE CONSTRAINT project_intake_links_project_fk;/);
    expect(stripComments(A)).not.toMatch(/DELETE FROM project_intake_links/);
  });
  it("SEC-5: every link created after apply expires within 91 days; live document links get 14 days; quote links left to 20261096", () => {
    expect(A).toMatch(/SET expires_at = NOW\(\) \+ INTERVAL '14 days'\s*\n\s*WHERE expires_at IS NULL AND revoked_at IS NULL AND COALESCE\(purpose, 'documents'\) <> 'quote';/);
    const ttl = between(A, "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_intake_links_ttl')", "END IF;");
    expect(ttl).toContain("'created_at < %L::timestamptz OR ('");
    expect(ttl).toContain("expires_at IS NOT NULL AND expires_at > created_at AND expires_at <= created_at + INTERVAL ''91 days''");
    expect(ttl).toContain("NOW());");
  });
  it("INTK-8: the per-link budget columns, defaults 500 submissions / 5 GB", () => {
    expect(A).toContain("ADD COLUMN IF NOT EXISTS max_submissions INT NOT NULL DEFAULT 500;");
    expect(A).toContain("ADD COLUMN IF NOT EXISTS max_total_bytes BIGINT NOT NULL DEFAULT 5368709120;");
  });
});

describe("20261105 — the review side of the door", () => {
  it("intake_attempts: RLS on, no policies, a pruner for the service role only", () => {
    expect(B).toMatch(/CREATE TABLE IF NOT EXISTS intake_attempts \(/);
    expect(B).toContain("token_hash TEXT NOT NULL");
    expect(B).toContain("ALTER TABLE intake_attempts ENABLE ROW LEVEL SECURITY;");
    expect(stripComments(B)).not.toMatch(/CREATE POLICY[^;]*intake_attempts/);
    expect(B).toContain("REVOKE ALL ON FUNCTION prune_intake_attempts() FROM PUBLIC, anon, authenticated;");
    expect(B).toContain("GRANT EXECUTE ON FUNCTION prune_intake_attempts() TO service_role;");
  });
  it("review_state admits 'superseded'; review_note carries a rejection reason", () => {
    expect(B).toContain("CHECK (review_state IS NULL OR review_state IN ('in_review', 'approved', 'rejected', 'superseded'));");
    expect(B).toContain("ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS review_note TEXT;");
  });
  it("the in-flight idempotency indexes exist only in the no-duplicate world, named as the route reads them", () => {
    expect(B).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS document_versions_intake_inflight_uniq\s*\n\s*ON document_versions \(intake_link_id, file_hash\)\s*\n\s*WHERE intake_link_id IS NOT NULL AND file_hash IS NOT NULL AND review_state = 'in_review';/);
    expect(B).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS cost_documents_intake_inflight_uniq/);
    expect(readFileSync(join(process.cwd(), "app/api/intake/upload/route.ts"), "utf8")).toMatch(/intake_inflight/);
  });
  it("the uniqueness_key backfill mirrors lib/uniqueness.ts and SKIPS live collisions", () => {
    const keys = between(B, "CREATE TEMP TABLE prj_g_j1b_keys AS", "d.document_number IS NOT NULL;");
    expect(keys).toContain("THEN ARRAY['documentNumber']::text[] ELSE l.uniqueness_keys END");
    expect(keys).toContain("WHEN 'documentNumber' THEN d.document_number");
    expect(keys).toContain("ELSE d.metadata->>k.key");
    expect(keys).toContain("string_agg(p.v, '::' ORDER BY p.ord)");
    expect(keys).toContain("CASE WHEN bool_and(p.v = '') THEN NULL");
    const upd = between(B, "UPDATE documents d\n   SET uniqueness_key = c.key", ";");
    expect(upd).toContain("AND NOT (c.live AND (");
  });

  const guard70 = between(mig("20261070_dc_roundF_review_gate_slots.sql"), "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "\n$$;");
  const guard105 = between(B, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "\n$$;");
  it("the publish guard is 20261070's body plus the two intake blocks — nothing removed", () => {
    const { onlyInA, onlyInB } = lineDiff(guard70, guard105);
    expect(onlyInA).toEqual([]);
    const added = onlyInB.filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));
    expect(added).toEqual([
      "  v_moc          text;",
      "  v_doc_class    text;",
      "      IF v_intake_link IS NOT NULL THEN",
      "            'This library requires reviewer sign-off; send the external submission to its reviewers before publishing it.'",
      "    SELECT v.intake_link_id, v.moc_reference INTO v_intake_link, v_moc",
      "      FROM document_versions v WHERE v.id = NEW.current_version_id;",
      "    IF v_intake_link IS NOT NULL THEN",
      "      BEGIN",
      "        v_doc_class := COALESCE(",
      "                         NULLIF(NEW.doc_class, ''),",
      "                         (SELECT NULLIF(c.doc_class, '') FROM collections c WHERE c.id = NEW.collection_id),",
      "                         (SELECT NULLIF(l.doc_class, '') FROM libraries l WHERE l.id = NEW.library_id)",
      "                       );",
      "      EXCEPTION WHEN undefined_column THEN",
      "        v_doc_class := NULL;",
      "      END;",
      "      IF v_doc_class = 'drawing' AND length(btrim(COALESCE(v_moc, ''))) < 3 THEN",
      "          'PSM requires an MOC reference to publish an external submission of a drawing-class document (OSHA 1910.119(l)); add it to the submission before approving.'",
    ]);
  });
  it("the intake blocks sit BEFORE the controller short-circuit, so an approving controller is bound by them", () => {
    const ctl = guard105.indexOf("IF is_org_controller(NEW.org_id) THEN");
    expect(guard105.indexOf("send the external submission to its reviewers")).toBeLessThan(ctl);
    expect(guard105.indexOf("publish an external submission of a drawing-class document")).toBeLessThan(ctl);
    // the service-role early return is unchanged (the auto path's gate is publish_revision's)
    expect(guard105).toMatch(/IF v_actor IS NULL THEN\s*\n\s*RETURN NEW;/);
  });

  const pub49 = between(mig("20261049_rp_phase7_handback_related_ticket.sql"), "CREATE OR REPLACE FUNCTION publish_revision(", "\n$$;");
  const pub105 = between(B, "CREATE OR REPLACE FUNCTION publish_revision(", "\n$$;");
  it("publish_revision is 20261049's body with ONE word added to the revert-target gate", () => {
    const { onlyInA, onlyInB } = lineDiff(pub49, pub105);
    expect(onlyInA).toEqual(["          AND (COALESCE(t.review_state, '') IN ('in_review', 'rejected')"]);
    expect(onlyInB).toEqual(["          AND (COALESCE(t.review_state, '') IN ('in_review', 'rejected', 'superseded')"]);
    expect(B).toContain("REVOKE ALL ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean) FROM PUBLIC;");
    expect(B).toContain("GRANT EXECUTE ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean) TO authenticated, service_role;");
  });
  it("20261105 is now the newest definition of both functions (a later re-creation must start from it)", () => {
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const newest = (fn: RegExp) => files.filter((f) => fn.test(stripComments(mig(f)))).pop();
    expect(newest(/CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/)).toBe("20261105_prj_roundG_intake_review_and_attempts.sql");
    expect(newest(/CREATE OR REPLACE FUNCTION publish_revision\(/)).toBe("20261105_prj_roundG_intake_review_and_attempts.sql");
  });
  it("the orphan health signal is service-role only", () => {
    expect(B).toContain("REVOKE ALL ON FUNCTION orphaned_in_review_versions_count() FROM PUBLIC, anon, authenticated;");
    expect(B).toContain("GRANT EXECUTE ON FUNCTION orphaned_in_review_versions_count() TO service_role;");
  });
  it("probes read prosrc verbatim (doubled quotes for a quote inside the body) and never cast inside a deparsed LIKE", () => {
    expect(B).toContain("prosrc LIKE '%IN (''in_review'', ''rejected'', ''superseded'')%'");
    expect(B).toContain("prosrc LIKE '%NULLIF(p_version->>''related_ticket_id'','''')::uuid%'");
    expect(A).toContain("pg_get_constraintdef(oid) LIKE '%expires_at IS NOT NULL%'");
  });
});

describe("policy census — no later migration widens who may write a contractor link", () => {
  it("project_intake_links_write is defined only where it always was (20260902, then 20260913's controller/owner form)", () => {
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const definers = files.filter((f) => /CREATE POLICY\s+"?project_intake_links_write"?/i.test(stripComments(mig(f))));
    expect(definers.every((f) => f <= "20260913_projects_rls_recursion_fix.sql")).toBe(true);
    // and nothing adds a second permissive write policy on the table
    const extra = files.filter((f) => f > "20260913_projects_rls_recursion_fix.sql")
      .filter((f) => /CREATE POLICY\s+"?\w+"?\s+ON\s+(?:public\.)?project_intake_links\b(?![^;]*AS RESTRICTIVE)[^;]*FOR (?:ALL|INSERT|UPDATE)/i.test(stripComments(mig(f))));
    expect(extra).toEqual([]);
  });
});
