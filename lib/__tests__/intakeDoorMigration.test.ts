// projects Round G — J1 INTAKE-DOOR: the shape of migrations 20261104 and
// 20261105, and the byte-fidelity of the two live functions 20261105
// re-creates (the lineDiff pattern of rpPhase5Migration / sweepRoundD3).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RESTORE_TABLE_ORDER } from "@/lib/dataRestore";

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
  it("authored_by_link_id: a plain indexed UUID (NO foreign key — org restore order), backfilled from each document's FIRST version, org-checked", () => {
    expect(A).toContain("ALTER TABLE documents ADD COLUMN IF NOT EXISTS authored_by_link_id UUID;");
    expect(A).toContain("ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_authored_by_link_id_fkey;");
    expect(A).toMatch(/CREATE INDEX IF NOT EXISTS documents_authored_by_link_idx\s*\n\s*ON documents \(authored_by_link_id\)/);
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
    // SEC-11: the assigner must be able to OPEN the document (the read gate,
    // not only publish authority) — a controller is exempt, as from node_visible
    expect(fn).toMatch(/IF NOT is_org_controller\(NEW\.org_id\) AND NOT doc_is_visible\(v_doc\.doc_id\) THEN\s*\n\s*RAISE EXCEPTION 'You cannot assign a document you cannot open\.'/);
    expect(A).toContain("AND prosrc LIKE '%NOT doc_is_visible(v_doc.doc_id)%'");
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
  it("PM-2: orphans are REVOKED (never deleted); a deleted project deletes its links by TRIGGER — no FK, so an org restore never refuses a link row", () => {
    expect(A).toMatch(/UPDATE project_intake_links l\s*\n\s*SET revoked_at = NOW\(\)\s*\n\s*WHERE l\.revoked_at IS NULL\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM projects p WHERE p\.id = l\.project_id\);/);
    expect(A).toContain("ALTER TABLE project_intake_links DROP CONSTRAINT IF EXISTS project_intake_links_project_fk;");
    const fn = between(A, "CREATE OR REPLACE FUNCTION close_project_intake_links()", "\n$$;");
    expect(fn).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(fn).toContain("DELETE FROM project_intake_links WHERE project_id = OLD.id;");
    expect(A).toMatch(/CREATE TRIGGER trg_projects_close_intake_links\s*\n\s*AFTER DELETE ON projects\s*\n\s*FOR EACH ROW EXECUTE FUNCTION close_project_intake_links\(\);/);
    expect(A).toContain("REVOKE ALL ON FUNCTION close_project_intake_links() FROM PUBLIC, anon, authenticated;");
    // the only delete of a link is the cascade's, keyed on the deleted project
    const deletes = stripComments(A).replace(/'(?:[^']|'')*'/g, "''").match(/DELETE FROM project_intake_links[^;]*;/g) ?? [];
    expect(deletes).toEqual(["DELETE FROM project_intake_links WHERE project_id = OLD.id;"]);
  });
  it("SEC-5: every link created after apply expires within 92 days (the 90-day policy + an end-of-day local expiry from a UTC date); live document links get 14 days; quote links left to 20261096", () => {
    expect(A).toMatch(/SET expires_at = NOW\(\) \+ INTERVAL '14 days'\s*\n\s*WHERE expires_at IS NULL AND revoked_at IS NULL AND COALESCE\(purpose, 'documents'\) <> 'quote';/);
    const ttl = between(A, "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_intake_links_ttl')", "END IF;");
    expect(ttl).toContain("'created_at < %L::timestamptz OR ('");
    expect(ttl).toContain("expires_at IS NOT NULL AND expires_at > created_at AND expires_at <= created_at + INTERVAL ''92 days''");
    expect(A).toContain("pg_get_constraintdef(oid) LIKE '%92 days%'");
    expect(stripComments(A)).not.toMatch(/91 days/);
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
  it("the in-flight idempotency indexes exist only in the no-duplicate world, named as the route reads them — over LIVE in-review rows only", () => {
    // re-created, never kept from an earlier draft; a withdrawn/displaced row never blocks a resend
    expect(B).toContain("DROP INDEX IF EXISTS document_versions_intake_inflight_uniq;");
    expect(B).toMatch(/CREATE UNIQUE INDEX document_versions_intake_inflight_uniq\s*\n\s*ON document_versions \(intake_link_id, file_hash\)\s*\n\s*WHERE intake_link_id IS NOT NULL AND file_hash IS NOT NULL AND review_state = 'in_review' AND superseded_at IS NULL;/);
    const dupCheck = between(B, "DROP INDEX IF EXISTS document_versions_intake_inflight_uniq;", "CREATE UNIQUE INDEX document_versions_intake_inflight_uniq");
    expect(dupCheck).toContain("AND superseded_at IS NULL");
    // the probe is conditional: an index, OR the duplicates that kept it from being made
    expect(B).toMatch(/AND indexdef LIKE '%superseded_at IS NULL%'\)\s*\n\s*OR EXISTS \(SELECT 1 FROM document_versions/);
    expect(B).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS cost_documents_intake_inflight_uniq/);
    expect(readFileSync(join(process.cwd(), "app/api/intake/upload/route.ts"), "utf8")).toMatch(/intake_inflight/);
  });
  it("the uniqueness_key backfill mirrors lib/uniqueness.ts and SKIPS live collisions", () => {
    const keys = between(B, "CREATE TEMP TABLE prj_g_j1b_keys AS", "d.document_number IS NOT NULL;");
    expect(keys).toContain("THEN ARRAY['documentNumber']::text[] ELSE l.uniqueness_keys END");
    expect(keys).toContain("WHEN 'documentNumber' THEN d.document_number");
    expect(keys).toContain("ELSE d.metadata->>k.key");
    expect(keys).toContain("string_agg(p.v, '::' ORDER BY p.ord)");
    expect(keys).toContain("CASE WHEN bool_or(p.v = '') THEN NULL");
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
  it("intake rows retired the older way are RESOLVED at apply; the health signal counts only rows nothing withdrew", () => {
    const conv = between(B, "UPDATE document_versions v\n   SET review_state = 'superseded'", ";");
    expect(conv).toContain("v.review_state = 'in_review'");
    expect(conv).toContain("v.superseded_at IS NOT NULL");
    expect(conv).toContain("v.intake_link_id IS NOT NULL");
    expect(conv).toContain("NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = v.record_id AND d.pending_version_id = v.id)");
    // after the CHECK admits 'superseded', before the index that it frees
    expect(B.indexOf("UPDATE document_versions v\n   SET review_state = 'superseded'")).toBeGreaterThan(B.indexOf("CHECK (review_state IS NULL OR review_state IN ('in_review', 'approved', 'rejected', 'superseded'));"));
    expect(B.indexOf("UPDATE document_versions v\n   SET review_state = 'superseded'")).toBeLessThan(B.indexOf("CREATE UNIQUE INDEX document_versions_intake_inflight_uniq"));
    expect(B).toMatch(/inventory: intake submissions withdrawn or displaced the older way/);
    const fn = between(B, "CREATE OR REPLACE FUNCTION orphaned_in_review_versions_count()", "\n$$;");
    expect(fn).toContain("WHERE v.review_state = 'in_review' AND v.superseded_at IS NULL");
  });
  it("the orphan health signal is service-role only", () => {
    expect(B).toContain("REVOKE ALL ON FUNCTION orphaned_in_review_versions_count() FROM PUBLIC, anon, authenticated;");
    expect(B).toContain("GRANT EXECUTE ON FUNCTION orphaned_in_review_versions_count() TO service_role;");
  });
  it("INTK-4 (fix pass 3): a pending pointer on a RETIRED draft is a STATE count — service-role only, inventoried before and after, probed", () => {
    const fn = between(B, "CREATE OR REPLACE FUNCTION pending_on_retired_version_count() RETURNS bigint", "\n$$;");
    expect(fn).toContain("LANGUAGE sql STABLE SET search_path = public AS $$");
    expect(fn).toContain("JOIN document_versions v ON v.id = d.pending_version_id");
    expect(fn).toContain("WHERE v.superseded_at IS NOT NULL OR v.review_state = 'superseded';");
    // no time window — it is reported until it reaches 0
    expect(fn).not.toMatch(/NOW\(\)|INTERVAL|created_at|timestamp/i);
    expect(B).toContain("REVOKE ALL ON FUNCTION pending_on_retired_version_count() FROM PUBLIC, anon, authenticated;");
    expect(B).toContain("GRANT EXECUTE ON FUNCTION pending_on_retired_version_count() TO service_role;");
    // the finder the cron's message points at, in the function's comment
    expect(B).toContain("COMMENT ON FUNCTION pending_on_retired_version_count() IS");
    expect(B).toContain("WHERE v.superseded_at IS NOT NULL OR v.review_state = ''superseded''; — then re-open the draft");
    // inside the transaction; inventory rows before (temp table) and after (final SELECT); a probe
    expect(B.indexOf("CREATE OR REPLACE FUNCTION pending_on_retired_version_count()")).toBeGreaterThan(B.indexOf("\nBEGIN;"));
    expect(B.indexOf("CREATE OR REPLACE FUNCTION pending_on_retired_version_count()")).toBeLessThan(B.lastIndexOf("\nCOMMIT;"));
    const inv = between(B, "CREATE TEMP TABLE prj_g_j1b_inventory AS", "\nBEGIN;");
    expect(inv).toContain("'inventory: documents whose pending revision names a RETIRED draft");
    const tail = B.slice(B.lastIndexOf("\nCOMMIT;"));
    expect(tail).toContain("prosrc LIKE '%v.superseded_at IS NOT NULL OR v.review_state = ''superseded''%'");
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'pending_on_retired_version_count()', 'EXECUTE')");
    expect(tail).toContain("pending_on_retired_version_count()::text");
  });
  it("verification fix (item 3): intake_review_health_by_org — the two health predicates VERBATIM, per org; SECURITY DEFINER, search_path pinned, service-role only, probed and inventoried", () => {
    const fn = between(B, "CREATE OR REPLACE FUNCTION intake_review_health_by_org()", "\n$$;");
    expect(fn).toContain("RETURNS TABLE (org_id uuid, orphaned_in_review bigint, pending_on_retired bigint, example_document_id text)");
    expect(fn).toContain("LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$");
    // the same predicates as the two count functions — so a nudge and a count never disagree
    const orphan = between(B, "CREATE OR REPLACE FUNCTION orphaned_in_review_versions_count()", "\n$$;");
    const stuck = between(B, "CREATE OR REPLACE FUNCTION pending_on_retired_version_count() RETURNS bigint", "\n$$;");
    expect(orphan).toContain("WHERE v.review_state = 'in_review' AND v.superseded_at IS NULL\n     AND d.pending_version_id IS DISTINCT FROM v.id;");
    expect(fn).toContain("WHERE v.review_state = 'in_review' AND v.superseded_at IS NULL\n         AND d.pending_version_id IS DISTINCT FROM v.id");
    expect(stuck).toContain("WHERE v.superseded_at IS NOT NULL OR v.review_state = 'superseded';");
    expect(fn).toContain("WHERE v.superseded_at IS NOT NULL OR v.review_state = 'superseded'\n    ) h");
    expect(fn).toContain("GROUP BY h.org_id;");
    expect(fn).not.toMatch(/NOW\(\)|INTERVAL/i); // state, not a time window
    expect(B).toContain("REVOKE ALL ON FUNCTION intake_review_health_by_org() FROM PUBLIC, anon, authenticated;");
    expect(B).toContain("GRANT EXECUTE ON FUNCTION intake_review_health_by_org() TO service_role;");
    expect(B.indexOf("CREATE OR REPLACE FUNCTION intake_review_health_by_org()")).toBeGreaterThan(B.indexOf("\nBEGIN;"));
    expect(B.indexOf("CREATE OR REPLACE FUNCTION intake_review_health_by_org()")).toBeLessThan(B.lastIndexOf("\nCOMMIT;"));
    const tail = B.slice(B.lastIndexOf("\nCOMMIT;"));
    expect(tail).toContain("(SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'");
    expect(tail).toContain("prosrc LIKE '%WHERE v.review_state = ''in_review'' AND v.superseded_at IS NULL%'");
    expect(tail).toContain("FROM pg_proc WHERE proname = 'intake_review_health_by_org')");
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'intake_review_health_by_org()', 'EXECUTE'), NULL");
    expect(tail).toContain("(SELECT COUNT(*)::text FROM intake_review_health_by_org())");
    // the attempt log names the cron's marker
    expect(B).toContain("-- 'attempt' | 'notified' | 'suppressed' | 'suppressed_published' | 'suppressed_displaced' | 'digested'");
  });
  it("probes read prosrc verbatim (doubled quotes for a quote inside the body) and never cast inside a deparsed LIKE", () => {
    expect(B).toContain("prosrc LIKE '%IN (''in_review'', ''rejected'', ''superseded'')%'");
    expect(B).toContain("prosrc LIKE '%NULLIF(p_version->>''related_ticket_id'','''')::uuid%'");
    expect(A).toContain("pg_get_constraintdef(oid) LIKE '%expires_at IS NOT NULL%'");
  });
});

describe("restore tripwire — a J1 migration adds no foreign key an org restore cannot satisfy", () => {
  // lib/dataRestore.ts restores tables in RESTORE_TABLE_ORDER; a child row
  // whose parent table restores LATER is refused (23503) and, outside the
  // row-refusal tables, fails its whole chunk. Every FK these migrations add
  // must point at a table ordered EARLIER than the table carrying it.
  const fks = (sql: string) => {
    const out: Array<{ child: string; parent: string }> = [];
    for (const stmt of stripComments(sql).split(";")) {
      const alter = /ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?(\w+)/i.exec(stmt);
      const create = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)/i.exec(stmt);
      const child = (alter ?? create)?.[1];
      if (!child) continue;
      for (const m of stmt.matchAll(/REFERENCES\s+(?:public\.)?(\w+)/gi)) out.push({ child, parent: m[1] });
    }
    return out;
  };
  it("the parser sees an FK when there is one (not vacuous)", () => {
    expect(fks("ALTER TABLE documents ADD COLUMN x UUID REFERENCES project_intake_links(id);")).toEqual([{ child: "documents", parent: "project_intake_links" }]);
  });
  it("every FK in 20261104 / 20261105 points at a table restored before its own", () => {
    const bad = [...fks(A), ...fks(B)].filter(({ child, parent }) => {
      const c = RESTORE_TABLE_ORDER.indexOf(child), p = RESTORE_TABLE_ORDER.indexOf(parent);
      return c >= 0 && p >= 0 && p >= c;
    });
    expect(bad).toEqual([]);
    // the two this package deliberately does NOT add
    expect(stripComments(A)).not.toMatch(/authored_by_link_id UUID\s*REFERENCES/);
    expect(stripComments(A)).not.toMatch(/FOREIGN KEY \(project_id\) REFERENCES projects/);
    // and the order that made them unsafe is still the order
    expect(RESTORE_TABLE_ORDER.indexOf("documents")).toBeLessThan(RESTORE_TABLE_ORDER.indexOf("project_intake_links"));
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
