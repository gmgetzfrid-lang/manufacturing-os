// projects Round G — J8 PROJECT-MODEL migrations 20261102 (project rails)
// and 20261103 (closeout rails). Shape pins — the enforcement is in the
// database and cannot run here (DEC-30): one transaction each, the DEC-30
// inventory captured BEFORE it as aggregate counts, the fixed (check, ok, n)
// result shape, every SECURITY DEFINER function pinned, explicit
// REVOKE / GRANT on the RPCs, the purge GUC spelled exactly as the shared
// contract (app.record_purge = 'project:<id>'), and every re-created live
// object byte-faithful to its newest definition except the lines the
// finding changes (lineDiff).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const numbered = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const m02 = read("20261102_prj_roundG_project_rails.sql");
const m03 = read("20261103_prj_roundG_project_closeout_rails.sql");
const m0906 = read("20260906_projects_hardening.sql");
const m0609 = read("20260609_phase1_normalization.sql");
const m1013 = read("20261013_project_controls_program.sql");

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a);
  expect(i, `missing: ${a}`).toBeGreaterThanOrEqual(0);
  const j = s.indexOf(b, i + a.length);
  expect(j, `missing after ${a}: ${b}`).toBeGreaterThan(i);
  return s.slice(i, j);
};
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const finalSelect = (sql: string) => sql.slice(sql.lastIndexOf("COMMIT;"));

for (const [name, sql, temp] of [
  ["20261102", m02, "prj_g_j8_rails_inventory"],
  ["20261103", m03, "prj_g_j8_closeout_inventory"],
] as const) {
  describe(`${name} — the paste-once shape`, () => {
    it("one transaction; the inventory is captured BEFORE it, in a re-runnable temp table, as counts only", () => {
      const body = stripComments(sql);
      expect((body.match(/\bBEGIN;/g) ?? []).length).toBe(1);
      expect((body.match(/\bCOMMIT;/g) ?? []).length).toBe(1);
      const before = sql.slice(0, sql.indexOf("\nBEGIN;"));
      expect(before).toContain(`DROP TABLE IF EXISTS pg_temp.${temp};\nCREATE TEMP TABLE ${temp} AS`);
      const rows = stripComments(before).match(/SELECT 'inventory[^']*(?:''[^']*)*'/g) ?? [];
      expect(rows.length).toBeGreaterThanOrEqual(5);
      expect(stripComments(before)).toMatch(/COUNT\(/);
      // No customer row leaves the database: the inventory and the result set select counts, never rows.
      expect(stripComments(before)).not.toMatch(/SELECT \*/);
      expect(stripComments(finalSelect(sql))).not.toMatch(/SELECT \*/);
    });

    it("ends in ONE SELECT of (check, ok, n): probes carry ok, the inventory carries n", () => {
      const tail = stripComments(finalSelect(sql));
      expect(tail).toMatch(/AS check,[\s\S]*AS ok, NULL::text AS n/);
      expect(tail).toContain(`UNION ALL SELECT inventory, NULL::boolean, n FROM ${temp};`);
      expect((tail.match(/;/g) ?? []).length).toBe(2); // COMMIT; + the one SELECT's terminator
    });

    it("every SECURITY DEFINER function pins search_path = public", () => {
      const fns = stripComments(sql).match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) ?? [];
      expect(fns.length).toBeGreaterThan(0);
      for (const f of fns) {
        if (/SECURITY DEFINER/.test(f)) expect(f, f.split("\n")[0]).toMatch(/SECURITY DEFINER SET search_path = public/);
      }
    });
  });
}

describe("20261102 — SEC-2: the nine read policies", () => {
  it("drops and re-creates each member read on project_visible_to_me; writes are untouched", () => {
    const tx = m02.slice(m02.indexOf("\nBEGIN;"), m02.indexOf("COMMIT;"));
    for (const [t, pol] of [["change_orders", "change_orders_member_read"], ["project_checklists", "project_checklists_member_read"],
      ["turnover_items", "turnover_items_member_read"], ["punch_items", "punch_items_member_read"],
      ["project_parties", "project_parties_select"], ["cost_accounts", "cost_accounts_select"],
      ["cost_documents", "cost_documents_select"], ["cost_entries", "cost_entries_select"]]) {
      expect(tx).toContain(`DROP POLICY IF EXISTS ${pol} ON ${t};\nCREATE POLICY ${pol} ON ${t} FOR SELECT\n  USING (project_visible_to_me(project_id));`);
    }
    expect(tx).toMatch(/CREATE POLICY checklist_items_member_read ON checklist_items FOR SELECT\s+USING \(EXISTS \(SELECT 1 FROM project_checklists c\s+WHERE c\.id = checklist_items\.checklist_id AND project_visible_to_me\(c\.project_id\)\)\);/);
    expect(stripComments(tx)).not.toMatch(/_write ON|_owner_write ON/);
  });

  it("company_events_member_read (the company profile's event read) is 20261013's line, closed one parenthesis early, plus ONE line gating a project-tied event on project_visible_to_me", () => {
    // Whole statements, up to (not including) their terminating ";".
    const live = between(m1013, "CREATE POLICY company_events_member_read ON company_events FOR SELECT", ";");
    const next = between(m02, "CREATE POLICY company_events_member_read ON company_events FOR SELECT", ";");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    const ORG_READ = "    USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = company_events.org_id AND m.uid = auth.uid() AND m.status = 'active')";
    // The live line closes the USING on itself; ours drops that one ")" and closes it on the added line.
    expect(onlyInA).toEqual([`${ORG_READ})`]);
    expect(onlyInB).toEqual([ORG_READ, "      AND ((company_events.project_id IS NULL AND NOT company_events.deleted_private_project) OR project_visible_to_me(company_events.project_id)))"]);
    const tx = m02.slice(m02.indexOf("\nBEGIN;"), m02.indexOf("COMMIT;"));
    expect(tx).toContain("DROP POLICY IF EXISTS company_events_member_read ON company_events;\nCREATE POLICY company_events_member_read ON company_events FOR SELECT");
    // The controller write policy (FOR ALL, is_org_controller) is untouched.
    expect(stripComments(tx)).not.toMatch(/company_events_controller_write/);
    expect(finalSelect(m02)).toContain("'SEC-2: company events logged against a project read through project_visible_to_me (the company profile)'");
    expect(m02.slice(0, m02.indexOf("\nBEGIN;"))).toContain("company events logged against a private project, readable org-wide today");
  });

  it("deleting a private project keeps its company events private: a BEFORE DELETE trigger on projects marks them before the FK's ON DELETE SET NULL unlinks them", () => {
    const tx = m02.slice(m02.indexOf("\nBEGIN;"), m02.indexOf("COMMIT;"));
    const col = tx.indexOf("ALTER TABLE company_events ADD COLUMN IF NOT EXISTS deleted_private_project BOOLEAN NOT NULL DEFAULT false;");
    expect(col).toBeGreaterThan(0);
    // the column exists before the policy that reads it
    expect(col).toBeLessThan(tx.indexOf("CREATE POLICY company_events_member_read"));
    const f = between(m02, "CREATE OR REPLACE FUNCTION keep_private_project_company_events_private()", "$$;");
    expect(f).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(f).toContain("  IF OLD.visibility = 'private' THEN\n    UPDATE company_events SET deleted_private_project = true\n     WHERE project_id = OLD.id AND NOT deleted_private_project;\n  END IF;\n  RETURN OLD;");
    expect(tx).toContain("DROP TRIGGER IF EXISTS trg_projects_private_company_events ON projects;\nCREATE TRIGGER trg_projects_private_company_events\n  BEFORE DELETE ON projects\n  FOR EACH ROW\n  EXECUTE FUNCTION keep_private_project_company_events_private();");
    const tail = finalSelect(m02);
    expect(tail).toContain("'SEC-2: deleting a private project keeps its company events private — marked before the FK unlinks them, and the member read honours the mark'");
    // the probe's prosrc patterns are verbatim substrings of the function source
    for (const pat of ["IF OLD.visibility = 'private' THEN", "UPDATE company_events SET deleted_private_project = true", "WHERE project_id = OLD.id"]) expect(f).toContain(pat);
    expect(tail).toContain("prosrc LIKE '%IF OLD.visibility = ''private'' THEN%'");
    expect(tail).toContain("'keep_private_project_company_events_private', 'enforce_project_document_link_fixed')");
    expect(tail).toContain("(SELECT COUNT(*) = 6 FROM pg_proc");
  });
});

describe("20261102 — SEC-2 after merge: projects Round G J2's turnover review history (20261091) follows project visibility", () => {
  // 20261091 (J2, on the integration branch, not in this package's base)
  // creates this read — verbatim from 20261091:451-453:
  const J2_READ = [
    "DROP POLICY IF EXISTS turnover_review_events_member_read ON turnover_review_events;",
    "CREATE POLICY turnover_review_events_member_read ON turnover_review_events FOR SELECT",
    "  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = turnover_review_events.org_id AND m.uid = auth.uid() AND m.status = 'active'));",
  ].join("\n");
  const block = between(m02, "DO $$\nBEGIN\n  IF to_regclass('public.turnover_review_events') IS NOT NULL THEN", "END $$;");

  it("where the table exists, its member read is re-created in 20261091's statement shape on project_visible_to_me — inside the transaction", () => {
    const tx = m02.slice(m02.indexOf("\nBEGIN;"), m02.indexOf("COMMIT;"));
    expect(tx).toContain(block);
    expect(block).toContain("    DROP POLICY IF EXISTS turnover_review_events_member_read ON turnover_review_events;\n    CREATE POLICY turnover_review_events_member_read ON turnover_review_events FOR SELECT\n      USING (project_visible_to_me(project_id));");
    // Same statements as J2's, re-indented, with only the predicate changed.
    const ours = block.split("\n").map((l) => l.trim());
    const theirs = J2_READ.split("\n").map((l) => l.trim());
    const { onlyInA, onlyInB } = lineDiff(theirs.join("\n"), ours.join("\n"));
    expect(onlyInA).toEqual([theirs[2]]);
    expect(onlyInB.filter((l) => /USING/.test(l))).toEqual(["USING (project_visible_to_me(project_id));"]);
    // No write policy: the database writes the history (20261091 revokes client writes).
    expect(block).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it("the inventory counts the exposed rows only where the table exists (no failure where it does not), and a probe checks the read", () => {
    const before = m02.slice(0, m02.indexOf("\nBEGIN;"));
    expect(before).toMatch(/IF to_regclass\('public\.turnover_review_events'\) IS NOT NULL THEN\n\s+EXECUTE 'SELECT COUNT\(\*\) FROM turnover_review_events e JOIN projects p ON p\.id = e\.project_id WHERE p\.visibility = ''private'''/);
    expect(before).toContain("INSERT INTO prj_g_j8_rails_inventory (inventory, n)");
    const tail = finalSelect(m02);
    expect(tail).toContain("'SEC-2: turnover review events (20261091, where present) read through project_visible_to_me — if this is false after re-running 20261091, re-run this file'");
    expect(tail).toMatch(/to_regclass\('public\.turnover_review_events'\) IS NULL\n\s+OR \(\(SELECT COUNT\(\*\) = 1 FROM pg_policies/);
  });
});

describe("20261102 — SEC-9: projects UPDATE / DELETE are byte-faithful to 20260906 plus one active-membership line", () => {
  const ACTIVE = "  AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = projects.org_id AND m.uid = auth.uid() AND m.status = 'active')";
  it("projects_update_owner", () => {
    const live = between(m0906, "CREATE POLICY projects_update_owner ON projects", ");\n");
    const next = between(m02, "CREATE POLICY projects_update_owner ON projects", ");\n");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect([...new Set(onlyInB)]).toEqual([ACTIVE]);
    expect(next.split("\n").filter((l) => l === ACTIVE)).toHaveLength(2); // USING and WITH CHECK
  });
  it("projects_delete_owner", () => {
    const live = between(m0906, "CREATE POLICY projects_delete_owner ON projects", ");\n");
    const next = between(m02, "CREATE POLICY projects_delete_owner ON projects", ");\n");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual([ACTIVE]);
  });
});

describe("20261102 — PM-7 / PM-9 / PM-11: the feed", () => {
  it("the insert policy binds author, org, visibility; comments need a manager; register rows need the register's authority", () => {
    const p = between(m02, "CREATE POLICY project_activity_insert ON project_activity FOR INSERT WITH CHECK (", ");\n");
    expect(p).toContain("  user_id = auth.uid()");
    expect(p).toContain("  AND org_id = project_org(project_id)");
    expect(p).toContain("  AND project_visible_to_me(project_id)");
    expect(p).toContain("  AND (type <> 'comment' OR is_org_controller(org_id) OR can_manage_project(project_id))");
    expect(p).toContain("  AND (type NOT IN ('doc_added', 'doc_removed') OR is_org_controller(org_id) OR is_project_owner(project_id))");
    expect(stripComments(m02)).not.toMatch(/CREATE POLICY \w+ ON project_activity FOR (UPDATE|ALL)/);
  });
  it("the stamp trigger takes identity and time from the session; the service role names its own", () => {
    const f = between(m02, "CREATE OR REPLACE FUNCTION stamp_project_activity_author()", "$$;");
    expect(f).toMatch(/IF v_uid IS NULL THEN\s+RETURN NEW;/);
    expect(f).toContain("NEW.user_id := v_uid;");
    expect(f).toContain("NEW.created_at := NOW();");
    expect(f).toMatch(/NEW\.user_name := COALESCE\(NULLIF\(v_email, ''\),/);
    expect(m02).toMatch(/CREATE TRIGGER trg_project_activity_stamp\s+BEFORE INSERT ON project_activity/);
  });
  it("last_activity_at is advanced by an AFTER INSERT trigger for every author, and backfilled", () => {
    const f = between(m02, "CREATE OR REPLACE FUNCTION touch_project_last_activity()", "$$;");
    expect(f).toMatch(/UPDATE projects\s+SET last_activity_at = COALESCE\(NEW\.created_at, NOW\(\)\)/);
    expect(m02).toMatch(/CREATE TRIGGER trg_project_activity_touch_project\s+AFTER INSERT ON project_activity/);
    expect(m02).toMatch(/UPDATE projects p\s+SET last_activity_at = a\.newest\s+FROM \(SELECT project_id, MAX\(created_at\) AS newest FROM project_activity GROUP BY project_id\) a/);
  });
});

describe("20261102 — PM-8 / SEC-17: the register", () => {
  it("DROPS the FOR ALL policy and creates one policy per verb", () => {
    const tx = m02.slice(m02.indexOf("\nBEGIN;"), m02.indexOf("COMMIT;"));
    expect(tx).toContain('DROP POLICY IF EXISTS "project_documents_member_all" ON project_documents;');
    expect(stripComments(tx)).not.toMatch(/CREATE POLICY "?project_documents_member_all/);
    for (const v of ["select", "insert", "update", "delete"]) expect(tx).toContain(`CREATE POLICY project_documents_${v} ON project_documents`);
  });
  it("an attach and an upsert's update follow the fleet plan (controller OR can_manage_project — so a collaborator's adoption and a manager's split / merge carry-over land, over an existing row too) in a project the caller can see; a link never moves; a detach stays owner-or-controller (SAF-17)", () => {
    const ins = between(m02, "CREATE POLICY project_documents_insert ON project_documents", ";");
    expect(ins).toContain("WITH CHECK ((is_org_controller(org_id) OR can_manage_project(project_id))\n              AND org_id = project_org(project_id)\n              AND project_visible_to_me(project_id))");
    const upd = between(m02, "CREATE POLICY project_documents_update ON project_documents", ";");
    expect(upd).toContain("USING (is_org_controller(org_id) OR can_manage_project(project_id))");
    expect(upd).toContain("WITH CHECK ((is_org_controller(org_id) OR can_manage_project(project_id))\n              AND org_id = project_org(project_id)\n              AND project_visible_to_me(project_id))");
    expect(ins + upd).not.toContain("is_project_owner");
    const del = between(m02, "CREATE POLICY project_documents_delete ON project_documents", ";");
    expect(del).toContain("USING (is_org_controller(org_id) OR is_project_owner(project_id))");
    expect(del).not.toContain("can_manage_project");
    // SAF-17's "a moved link is a detach" is kept by a trigger, so UPDATE can be the plan's predicate.
    const g = between(m02, "CREATE OR REPLACE FUNCTION enforce_project_document_link_fixed()", "$$;");
    expect(g).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(g).toContain("  IF auth.uid() IS NOT NULL\n     AND (NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.document_id IS DISTINCT FROM OLD.document_id) THEN\n    RAISE EXCEPTION");
    const tx = m02.slice(m02.indexOf("\nBEGIN;"), m02.indexOf("COMMIT;"));
    expect(tx).toContain("CREATE TRIGGER trg_project_documents_link_fixed\n  BEFORE UPDATE ON project_documents\n  FOR EACH ROW\n  EXECUTE FUNCTION enforce_project_document_link_fixed();");
    const tail = finalSelect(m02);
    expect(tail).toContain("'PM-8: an attach, and an upsert''s update, need a project manager or a controller, in the project''s own org and a project the caller can see'");
    expect(tail).toContain("'SAF-17 / PM-8: a link never moves (BEFORE UPDATE trigger), and a detach needs the owner or a controller'");
    expect(g).toContain("NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.document_id IS DISTINCT FROM OLD.document_id");
    // The feed's register rows keep the register card's authority (PM-7 / SAF-17).
    expect(m02).toContain("  AND (type NOT IN ('doc_added', 'doc_removed') OR is_org_controller(org_id) OR is_project_owner(project_id))");
  });
  it("checkouts_resync_project_documents is 20260609's body, now SECURITY DEFINER, plus the org-consistency guard and the caller guard", () => {
    const live = between(m0609, "CREATE OR REPLACE FUNCTION checkouts_resync_project_documents()", "END$$;");
    const next = between(m02, "CREATE OR REPLACE FUNCTION checkouts_resync_project_documents()", "END$$;");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual(["RETURNS trigger LANGUAGE plpgsql AS $$"]);
    expect(onlyInB).toEqual([
      "RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$",
      "  IF project_org(NEW.project_id) IS DISTINCT FROM NEW.org_id THEN",
      "  IF auth.uid() IS NOT NULL",
      "     AND (NEW.user_id IS DISTINCT FROM auth.uid() OR NOT project_visible_to_me(NEW.project_id)) THEN",
    ]);
    // each added guard closes with the file's existing `RETURN NEW; END IF;` lines, BEFORE the insert
    expect(next).toMatch(/IF project_org\(NEW\.project_id\) IS DISTINCT FROM NEW\.org_id THEN\n    RETURN NEW;\n  END IF;\n  IF auth\.uid\(\) IS NOT NULL\n     AND \(NEW\.user_id IS DISTINCT FROM auth\.uid\(\) OR NOT project_visible_to_me\(NEW\.project_id\)\) THEN\n    RETURN NEW;\n  END IF;\n  INSERT INTO project_documents/);
  });
  it("SEC-17: a signed-in caller cannot plant a register row through the definer — the guard is probed by the paste-back", () => {
    const tail = finalSelect(m02);
    expect(tail).toContain("'SEC-17 / PM-8: a signed-in caller''s checkout links only their own session, into a project they can see'");
    expect(tail).toContain("prosrc LIKE '%NEW.user_id IS DISTINCT FROM auth.uid() OR NOT project_visible_to_me(NEW.project_id)%'");
    // the probe's pattern is a verbatim substring of the function source (prosrc is not deparsed)
    const fn = between(m02, "CREATE OR REPLACE FUNCTION checkouts_resync_project_documents()", "END$$;");
    expect(fn).toContain("NEW.user_id IS DISTINCT FROM auth.uid() OR NOT project_visible_to_me(NEW.project_id)");
  });
});

describe("20261102 — SEC-15: transfer_project_ownership", () => {
  const f = between(m02, "CREATE OR REPLACE FUNCTION transfer_project_ownership(", "$$;");
  it("checks the caller (active owner or controller) and the recipient (active member), then moves every piece in one call", () => {
    expect(f).toMatch(/IF NOT \(is_org_controller\(v_proj\.org_id\) OR user_owns_project\(p_project\)\) THEN/);
    expect(f).toMatch(/IF NOT EXISTS \(SELECT 1 FROM org_members WHERE org_id = v_proj\.org_id AND uid = p_new_owner AND status = 'active'\) THEN\s+RAISE EXCEPTION 'The new owner must be an active member of this workspace\.'/);
    expect(f).toMatch(/SELECT \* INTO v_proj FROM projects WHERE id = p_project FOR UPDATE;/);
    expect(f).toMatch(/UPDATE projects\s+SET owner_user_id = p_new_owner/);
    expect(f).toMatch(/ON CONFLICT \(project_id, user_id\) DO UPDATE SET role = 'owner';/);
    expect(f).toMatch(/UPDATE project_members SET role = 'collaborator'\s+WHERE project_id = p_project AND user_id = v_proj\.owner_user_id AND role = 'owner';/);
    expect(f).toContain("'ownership_transferred'");
    expect(f).toContain("'PROJECT_OWNERSHIP_TRANSFERRED'");
  });
  it("is revoked from PUBLIC and anon, granted to authenticated", () => {
    expect(m02).toContain("REVOKE ALL ON FUNCTION transfer_project_ownership(uuid, uuid, text) FROM PUBLIC;");
    expect(m02).toContain("REVOKE ALL ON FUNCTION transfer_project_ownership(uuid, uuid, text) FROM anon;");
    expect(m02).toContain("GRANT EXECUTE ON FUNCTION transfer_project_ownership(uuid, uuid, text) TO authenticated;");
  });
});

describe("20261103 — PM-1: the freeze and the reopen", () => {
  it("guards the nine regulated tables BEFORE INSERT / UPDATE / DELETE", () => {
    const loop = between(m03, "FOREACH t IN ARRAY ARRAY['cost_entries'", "END LOOP;");
    for (const t of ["cost_entries", "change_orders", "cost_documents", "cost_accounts", "project_checklists", "checklist_items", "turnover_items", "punch_items", "milestones"]) {
      expect(loop).toContain(`'${t}'`);
    }
    expect(loop).toContain("BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_project_record_guard()");
  });
  it("the guard refuses a signed-in write on a closed project, reads a checklist item's project through its checklist, and passes the purge and the cascade", () => {
    const g = between(m03, "CREATE OR REPLACE FUNCTION enforce_project_record_guard()", "$$;");
    expect(g).toMatch(/IF v_status IN \('completed', 'cancelled', 'archived'\) AND auth\.uid\(\) IS NOT NULL THEN/);
    expect(g).toMatch(/SELECT project_id INTO v_old_pid FROM project_checklists WHERE id = NULLIF\(v_old->>'checklist_id', ''\)::uuid;/);
    expect(g).toContain("CONTINUE WHEN v_purge = 'project:' || v_pid::text;");
    expect(g).toContain("CONTINUE WHEN NOT FOUND;");
    expect(g).toMatch(/IF TG_OP = 'DELETE' AND COALESCE\(v_hold, false\) THEN/);
  });
  it("deleting what a frozen row cites still works: an FK ON DELETE SET NULL (an UPDATE one trigger level down that only nulls SET NULL references) passes the freeze; a direct UPDATE does not", () => {
    const g = between(m03, "CREATE OR REPLACE FUNCTION enforce_project_record_guard()", "$$;");
    const pass = between(g, "  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1", "    RETURN NEW;\n  END IF;");
    // every changed column must be NULL now and an ON DELETE SET NULL
    // reference of THIS table — read from the catalog, so a reference a
    // later migration adds is covered without editing the guard
    expect(pass).toContain("SELECT 1 FROM jsonb_each(v_new) n");
    expect(pass).toContain("WHERE n.value IS DISTINCT FROM (v_old -> n.key)");
    expect(pass).toContain("AND (n.value <> 'null'::jsonb");
    expect(pass).toContain("WHERE k.conrelid = TG_RELID AND k.contype = 'f' AND k.confdeltype = 'n'");
    expect(pass).toContain("AND a.attname = n.key)))");
    // …and it is decided before any project is looked at, after OLD / NEW are read
    expect(g.indexOf("pg_trigger_depth() > 1")).toBeGreaterThan(g.indexOf("IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;"));
    expect(g.indexOf("pg_trigger_depth() > 1")).toBeLessThan(g.indexOf("FOREACH v_pid IN ARRAY"));
    // The references the review names are ON DELETE SET NULL in the sequence
    // (so the catalog lookup finds them): a drawing a milestone or turnover
    // item cites, a checklist's source document, a party, a company, an
    // intake link, a budget line, a ticket, a parent milestone.
    const all = numbered.map(read).join("\n");
    for (const [table, col, target] of [
      ["milestones", "document_id", "documents"], ["milestones", "linked_ticket_id", "tickets"], ["milestones", "parent_id", "milestones"],
      ["turnover_items", "document_id", "documents"], ["turnover_items", "party_id", "project_parties"],
      ["project_checklists", "source_document_id", "documents"], ["punch_items", "party_id", "project_parties"],
      ["cost_documents", "party_id", "project_parties"], ["cost_documents", "intake_link_id", "project_intake_links"], ["cost_documents", "company_id", "companies"],
      ["cost_accounts", "party_id", "project_parties"], ["cost_accounts", "wbs_milestone_id", "milestones"],
      ["cost_entries", "party_id", "project_parties"], ["change_orders", "cost_account_id", "cost_accounts"], ["change_orders", "party_id", "project_parties"],
    ] as const) {
      expect(all, `${table}.${col}`).toMatch(new RegExp(`${col}\\s+(?:UUID|uuid)\\s+REFERENCES ${target}\\(id\\) ON DELETE SET NULL`));
    }
    expect(all).toMatch(/cost_entries ADD CONSTRAINT cost_entries_source_document_fk\s+FOREIGN KEY \(source_document_id\) REFERENCES cost_documents\(id\) ON DELETE SET NULL/);
    // the freeze below still refuses a signed-in caller's own UPDATE (depth 1)
    expect(g).toMatch(/IF v_status IN \('completed', 'cancelled', 'archived'\) AND auth\.uid\(\) IS NOT NULL THEN/);
    const tail = finalSelect(m03);
    expect(tail).toContain("'PM-1: deleting what a frozen row cites still works — an FK ON DELETE SET NULL (one trigger level down, only SET NULL references nulled) passes the freeze'");
    // the probe's prosrc patterns are verbatim substrings of the function source
    for (const pat of ["TG_OP = 'UPDATE' AND pg_trigger_depth() > 1", "k.confdeltype = 'n'", "n.value <> 'null'::jsonb", "FOREACH v_pid IN ARRAY"]) expect(g).toContain(pat);
    expect(tail).toContain("prosrc LIKE '%TG_OP = ''UPDATE'' AND pg_trigger_depth() > 1%'");
    expect(tail).toContain("prosrc LIKE '%k.confdeltype = ''n''%'");
  });

  it("only reopen_project leaves a closed status; it is controller-only, needs a reason, and clears the closure fields", () => {
    const lg = between(m03, "CREATE OR REPLACE FUNCTION enforce_project_lifecycle_guard()", "$$;");
    expect(lg).toContain("AND COALESCE(current_setting('app.project_reopen', true), '') <> 'project:' || OLD.id::text THEN");
    expect(lg).toMatch(/IF NEW\.legal_hold IS DISTINCT FROM OLD\.legal_hold AND NOT is_org_controller\(OLD\.org_id\) THEN/);
    const r = between(m03, "CREATE OR REPLACE FUNCTION reopen_project(", "$$;");
    expect(r).toMatch(/IF NOT is_org_controller\(v_proj\.org_id\) THEN/);
    expect(r).toContain("RAISE EXCEPTION 'A reason is required to reopen a closed project.'");
    expect(r).toContain("PERFORM set_config('app.project_reopen', 'project:' || p_project::text, true);");
    expect(r).toContain("SET status = 'active', completed_at = NULL, cancelled_at = NULL, cancelled_reason = NULL,");
    expect(r).toContain("'PROJECT_REOPENED'");
    expect(m03).toContain("REVOKE ALL ON FUNCTION reopen_project(uuid, text) FROM anon;");
    expect(m03).toContain("GRANT EXECUTE ON FUNCTION reopen_project(uuid, text) TO authenticated;");
  });
});

describe("20261103 — PM-6 / QUAL-3: delete counts, audits, and only then deletes", () => {
  const d = between(m03, "CREATE OR REPLACE FUNCTION delete_project_record(", "$$;");
  it("the purge GUC is the shared contract, spelled exactly, and set only around the deletes", () => {
    expect(d).toContain("PERFORM set_config('app.record_purge', 'project:' || p_project::text, true);");
    expect(d).toContain("PERFORM set_config('app.record_purge', '', true);");
    const g = between(m03, "CREATE OR REPLACE FUNCTION enforce_project_delete_guard()", "$$;");
    expect(g).toContain("IF COALESCE(current_setting('app.record_purge', true), '') = 'project:' || OLD.id::text THEN");
  });
  it("refuses a held project; a project with records needs a controller AND a reason", () => {
    expect(d).toMatch(/IF v_proj\.legal_hold THEN/);
    expect(d).toMatch(/IF v_regulated > 0 AND NOT v_controller THEN[\s\S]*archive it instead/);
    expect(d).toMatch(/IF v_regulated > 0 AND v_reason IS NULL THEN/);
  });
  it("audits counts, the snapshot and the storage keys, revokes the intake links, BEFORE the first delete", () => {
    const auditAt = d.indexOf("INSERT INTO audit_logs");
    const firstDelete = d.indexOf("DELETE FROM");
    expect(auditAt).toBeGreaterThan(0);
    expect(auditAt).toBeLessThan(firstDelete);
    expect(d.lastIndexOf("INSERT INTO audit_logs")).toBeLessThan(firstDelete);
    expect(d.indexOf("UPDATE project_intake_links SET revoked_at = NOW()")).toBeLessThan(firstDelete);
    for (const k of ["'counts', v_counts", "'snapshot', v_snapshot", "'orphanedStorageKeys', v_keys", "'reason', v_reason", "'revokedIntakeLinks', v_links"]) expect(d).toContain(k);
    expect(d).toContain("jsonb_agg(to_jsonb(x) - 'parsed')");
  });

  it("SEC-2: the company events the delete unlinks are counted and snapshotted (audit viewers), never deleted", () => {
    expect(d).toContain("'companyEvents',  (SELECT COUNT(*) FROM company_events WHERE project_id = p_project)");
    expect(d).toContain("'companyEvents',  COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM company_events x WHERE x.project_id = p_project), '[]'::jsonb)");
    // the events ride in the snapshot (the PURGE_ row), before any delete
    expect(d.indexOf("FROM company_events x")).toBeLessThan(d.indexOf("VALUES ('PURGE_PROJECT_SNAPSHOT'"));
    expect(stripComments(d)).not.toMatch(/DELETE FROM company_events/);
    const tail = finalSelect(m03);
    expect(tail).toContain("'SEC-2 / PM-6: the deleted project''s company events are counted and snapshotted, never deleted — and 20261102 keeps a private project''s events controller-only once unlinked'");
    for (const pat of ["'companyEvents',  (SELECT COUNT(*) FROM company_events WHERE project_id = p_project)", "'companyEvents',  COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM company_events x"]) expect(d).toContain(pat);
  });

  it("SEC-2: the org-readable PROJECT_DELETED row carries no row content; the snapshot rides in a PURGE_ row the audit overlay limits to the org's audit viewers", () => {
    const deleted = between(d, "VALUES ('PROJECT_DELETED'", ");");
    const purge = between(d, "VALUES ('PURGE_PROJECT_SNAPSHOT'", ");");
    expect(deleted).not.toContain("v_snapshot");
    for (const k of ["'counts', v_counts", "'orphanedStorageKeys', v_keys", "'reason', v_reason", "'revokedIntakeLinks', v_links", "'snapshotAction', 'PURGE_PROJECT_SNAPSHOT'"]) expect(deleted).toContain(k);
    expect(purge).toContain("'snapshot', v_snapshot");
    expect(d.split("v_snapshot").length - 1).toBe(3); // declared, built, written once (the PURGE_ row)
    // The overlay: the NEWEST audit_logs_admin_trail in the sequence is a
    // RESTRICTIVE SELECT that hides PURGE_% rows from anyone without
    // admin.audit_view — so the snapshot needs no new policy.
    const defs = numbered.filter((f) => /CREATE POLICY audit_logs_admin_trail ON audit_logs/.test(read(f)));
    expect(defs.length).toBeGreaterThan(0);
    const overlay = between(read(defs[defs.length - 1]), "CREATE POLICY audit_logs_admin_trail ON audit_logs", ");\n");
    expect(overlay).toMatch(/AS RESTRICTIVE FOR SELECT/);
    expect(overlay).toContain("org_capability_allows(org_id, 'admin.audit_view', auth.uid())");
    expect(overlay).toContain("action LIKE 'PURGE_%'");
    expect("PURGE_PROJECT_SNAPSHOT".startsWith("PURGE_")).toBe(true);
    const tail = finalSelect(m03);
    expect(tail).toContain("'SEC-2 / PM-6: the snapshot rides only in PURGE_PROJECT_SNAPSHOT (audit viewers) — the org-readable PROJECT_DELETED row carries none'");
    // the probe's prosrc patterns are verbatim substrings of the function source
    for (const pat of ["VALUES ('PROJECT_DELETED'", "VALUES ('PURGE_PROJECT_SNAPSHOT'", "'snapshot', v_snapshot"]) expect(d).toContain(pat);
  });

  it("deletes children before the rows their ON DELETE SET NULL keys point at, then the schedule, then the project", () => {
    const order = ["DELETE FROM project_checklists", "DELETE FROM turnover_items", "DELETE FROM punch_items",
      "DELETE FROM cost_entries", "DELETE FROM change_orders", "DELETE FROM cost_documents", "DELETE FROM cost_accounts",
      "DELETE FROM project_parties", "DELETE FROM milestones", "DELETE FROM projects"];
    const at = order.map((s) => d.indexOf(s));
    for (const i of at) expect(i).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("QUAL-3 after merge: a checklist item is never deleted directly — it cascades with its checklist, the one delete projects Round G J2's quality rail admits", () => {
    // J2's checklist_items_decision_rail (20261091:841-843, integration
    // branch) refuses a signed-in caller's DELETE of an item at trigger
    // depth 1 and passes a cascade (depth 2). delete_project_record runs as
    // the caller (auth.uid() is theirs), so a direct item DELETE would fail
    // the whole purge for any project with a checklist item.
    expect(stripComments(d)).not.toMatch(/DELETE\s+FROM\s+checklist_items/i);
    expect(stripComments(d)).toContain("DELETE FROM project_checklists WHERE project_id = p_project;");
    // …and the cascade exists: the item's checklist key is ON DELETE CASCADE.
    expect(m1013).toMatch(/checklist_id UUID NOT NULL REFERENCES project_checklists\(id\) ON DELETE CASCADE/);
    // No later migration drops that cascade.
    for (const f of numbered.filter((x) => x > "20261013")) {
      expect(stripComments(read(f)), f).not.toMatch(/checklist_items\s+DROP\s+CONSTRAINT[^;]*checklist_id/i);
    }
    // J8's own record guard lets the cascaded item through: its checklist is
    // already gone (no project found) and the purge GUC is set.
    const g = between(m03, "CREATE OR REPLACE FUNCTION enforce_project_record_guard()", "$$;");
    expect(g).toContain("CONTINUE WHEN v_purge = 'project:' || v_pid::text;");
    const tail = finalSelect(m03);
    expect(tail).toContain("'PM-6 / QUAL-3: the purge never deletes checklist items directly — they cascade with their checklist (the 20261091 quality rail admits only that)'");
    expect(tail).toContain("prosrc NOT LIKE '%DELETE FROM checklist_items%'");
    expect(tail).toContain("k.confdeltype = 'c'");
  });
  it("the projects delete guard refuses a project carrying records without the purge, and the legal hold always", () => {
    const g = between(m03, "CREATE OR REPLACE FUNCTION enforce_project_delete_guard()", "$$;");
    expect(g.indexOf("IF OLD.legal_hold THEN")).toBeLessThan(g.indexOf("app.record_purge"));
    expect(g).toContain("v_n := project_regulated_record_count(OLD.id);");
    expect(m03).toMatch(/ALTER TABLE projects ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;/);
    expect(m03).toContain("REVOKE ALL ON FUNCTION project_regulated_record_count(uuid) FROM authenticated;");
  });
  it("the regulated count the guard and the RPC share is the same eight tables the app's confirm calls regulated", async () => {
    const f = between(m03, "CREATE OR REPLACE FUNCTION project_regulated_record_count(", "$$;");
    const sqlTables = [...f.matchAll(/FROM (\w+)/g)].map((m) => m[1]);
    const { REGULATED_RECORD_KEYS } = await import("@/lib/projects");
    const byKey: Record<string, string> = {
      costAccounts: "cost_accounts", costEntries: "cost_entries", costDocuments: "cost_documents", changeOrders: "change_orders",
      checklists: "project_checklists", checklistItems: "checklist_items", turnoverItems: "turnover_items", punchItems: "punch_items",
    };
    expect(new Set(REGULATED_RECORD_KEYS.map((k) => byKey[k]))).toEqual(new Set(sqlTables));
  });
});
