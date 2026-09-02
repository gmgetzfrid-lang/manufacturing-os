// Roles-and-permissions Phase 6 — shape pins on the four migrations
// (20261042 revocation + succession, 20261043 legal hold + atomic force-
// release, 20261044 owner delegation, 20261045 admin gates + team FK +
// reviewer independence). Re-created bodies are proven byte-faithful to
// their live predecessors except the named substitution.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const m42 = read("20261042_rp_phase6_revocation_and_succession.sql");
const m43 = read("20261043_rp_phase6_legal_hold_and_force_release.sql");
const m44 = read("20261044_rp_phase6_owner_delegation.sql");
const m45 = read("20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql");
const m36 = read("20261036_rp_phase3_publish_path.sql");
const m40 = read("20261040_rp_phase5_additive_publish_path.sql");

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

describe("20261042 — revocation (SURF-1/DEC-20) with succession (GAP-5/OWN-12)", () => {
  it("org_members gains a DELETE policy: Admin by collection, never yourself", () => {
    const pol = between(m42, "CREATE POLICY org_members_delete ON org_members", ";");
    expect(pol).toMatch(/FOR DELETE/);
    expect(pol).toMatch(/me\.role = 'Admin' OR me\.roles && ARRAY\['Admin'\]::text\[\]/);
    expect(pol).toMatch(/org_members\.uid <> auth\.uid\(\)/);
  });

  it("my_team_ids only counts ACTIVE memberships (a suspended member's team grants stop)", () => {
    const fn = between(m42, "CREATE OR REPLACE FUNCTION my_team_ids()", "$$;");
    expect(fn).toMatch(/JOIN org_members m ON m\.uid = tm\.uid AND m\.org_id = tm\.org_id AND m\.status = 'active'/);
    expect(fn).toMatch(/SET search_path = public/);
  });

  it("user_is_effective_owner requires an active membership at EVERY level and falls through", () => {
    const fn = between(m42, "CREATE OR REPLACE FUNCTION user_is_effective_owner", "$$;");
    expect((fn.match(/member_is_active\(/g) ?? []).length).toBe(4);
    // Fall-through, not short-circuit: an inactive doc owner does not RETURN.
    expect(fn).toMatch(/IF p_doc_owner IS NOT NULL AND member_is_active\(v_org, p_doc_owner\) THEN\s*\n\s*RETURN p_doc_owner = p_uid;/);
    expect(fn).not.toMatch(/IF p_doc_owner IS NOT NULL THEN\s*\n\s*RETURN p_doc_owner = p_uid;/);
    // The team rung survives and is membership-aware too.
    expect(fn).toMatch(/SELECT supervisor_user_id INTO v_owner FROM teams WHERE id = v_team;/);
  });

  it("verification proves every column the sweep late-binds exists (63 pairs, same lesson as 20261038)", () => {
    const v = between(m42, "── Verification", "── Inventory");
    expect(v).toMatch(/expect true × 7/);
    const probe = between(v, "JOIN (VALUES", ") v(t, col)");
    const pairs = [...probe.matchAll(/\('(\w+)','(\w+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(pairs.length).toBe(63);
    expect(new Set(pairs).size).toBe(63);
    expect(v).toMatch(/COUNT\(\*\) = 63 FROM information_schema\.columns/);
    // Every column the function bodies reference by name is in the probe.
    for (const c of ["checkout_sessions.released_reason", "documents.active_collaborators", "documents.current_lock_id",
                     "org_configurations.data", "teams.supervisor_user_id", "libraries.owner_team_id", "org_members.roles"]) {
      expect(pairs).toContain(c);
    }
  });

  it("revoke_member: three modes, authority by collection, self-guard, last-admin trigger left live", () => {
    const fn = between(m42, "CREATE OR REPLACE FUNCTION revoke_member", "REVOKE ALL ON FUNCTION revoke_member");
    expect(fn).toMatch(/IF p_mode NOT IN \('suspend', 'remove', 'restore'\)/);
    expect(fn).toMatch(/You can''t suspend or remove yourself\./);
    expect(fn).toMatch(/Only an Admin can remove a member from the workspace\./);
    expect(fn).toMatch(/Only an Admin can suspend or restore an Admin\./);
    // Status writes go through UPDATE/DELETE so trg_prevent_last_admin_* fires (auth.uid() set).
    expect(fn).toMatch(/UPDATE org_members SET status = 'suspended' WHERE id = p_member_id;/);
    expect(fn).toMatch(/DELETE FROM org_members WHERE id = p_member_id;/);
    expect(fn).not.toMatch(/ALTER TABLE org_members DISABLE TRIGGER/);
  });

  it("remove SWEEPS: owners cleared (never reassigned) with one audit row per scope, supervision, checkouts, grants, rosters, subscriptions", () => {
    const fn = between(m42, "CREATE OR REPLACE FUNCTION revoke_member", "REVOKE ALL ON FUNCTION revoke_member");
    for (const t of ["libraries", "collections", "documents"]) {
      expect(fn, t).toMatch(new RegExp(`UPDATE ${t} SET owner_user_id = NULL, owner_name = NULL WHERE id = r\\.id;`));
    }
    expect((fn.match(/'OWNER_CLEARED'/g) ?? []).length).toBe(3);
    expect(fn).toMatch(/UPDATE teams SET supervisor_user_id = NULL WHERE id = r\.id;/);
    expect(fn).toMatch(/'TEAM_SUPERVISOR_CLEARED'/);
    expect(fn).toMatch(/UPDATE checkout_sessions[\s\S]*status = 'checked_in'/);
    expect(fn).toMatch(/UPDATE documents[\s\S]*checked_out_by = NULL[\s\S]*WHERE org_id = v_member\.org_id AND checked_out_by = v_member\.uid;/);
    expect(fn).toMatch(/key = 'capability_policy'/);
    expect(fn).toMatch(/DELETE FROM subscriptions WHERE org_id = v_member\.org_id AND user_id = v_member\.uid;/);
    expect(fn).toMatch(/DELETE FROM team_members WHERE org_id = v_member\.org_id AND uid = v_member\.uid;/);
    expect(fn).toMatch(/DELETE FROM project_members pm USING projects p/);
    // Never a silent reassignment.
    expect(fn).not.toMatch(/SET owner_user_id = v_actor/);
    expect(fn).not.toMatch(/SET owner_user_id = \(SELECT/);
    // Sweep runs BEFORE the delete (the trigger needs the row to evaluate).
    expect(fn.indexOf("'OWNER_CLEARED'")).toBeLessThan(fn.indexOf("DELETE FROM org_members WHERE id = p_member_id;"));
    expect(fn).toMatch(/'MEMBER_REMOVED'/);
    expect(m42).toMatch(/REVOKE ALL ON FUNCTION revoke_member\(uuid, text\) FROM PUBLIC;/);
    expect(m42).toMatch(/GRANT EXECUTE ON FUNCTION revoke_member\(uuid, text\) TO authenticated;/);
  });

  it("suspend does NOT sweep ownership (non-destructive; the resolver already ignores inactive owners)", () => {
    const fn = between(m42, "CREATE OR REPLACE FUNCTION revoke_member", "REVOKE ALL ON FUNCTION revoke_member");
    const suspendBlock = between(fn, "IF p_mode = 'suspend' THEN", "END IF;");
    expect(suspendBlock).not.toMatch(/OWNER_CLEARED/);
    expect(suspendBlock).toMatch(/'MEMBER_SUSPENDED'/);
  });
});

describe("20261043 — legal hold at the database (SURF-3) + atomic force-release (SURF-4)", () => {
  const guard = between(m43, "CREATE OR REPLACE FUNCTION enforce_document_retention_guard", "DROP TRIGGER IF EXISTS trg_document_retention_guard");

  it("hold columns are controller-only; retention columns controller/owner/publisher; service passes", () => {
    for (const c of ["legal_hold", "legal_hold_matter", "legal_hold_reason", "legal_hold_by", "legal_hold_at"]) {
      expect(guard, c).toMatch(new RegExp(`NEW\\.${c}\\s+IS DISTINCT FROM OLD\\.${c}`));
    }
    for (const c of ["retention_policy", "retention_until", "disposition_state", "disposed_at"]) {
      expect(guard, c).toMatch(new RegExp(`NEW\\.${c}\\s+IS DISTINCT FROM OLD\\.${c}`));
    }
    expect(guard).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(guard).toMatch(/IF v_hold_change AND NOT v_controller THEN/);
    expect(guard).toMatch(/AND NOT user_is_effective_owner\(OLD\.owner_user_id, OLD\.collection_id, OLD\.library_id, auth\.uid\(\)\)\s*\n\s*AND NOT user_can_publish_on_library\(OLD\.library_id, auth\.uid\(\)::text, OLD\.org_id\)/);
  });

  it("under a hold nothing is destroyed by any verb: no disposition, no archive (the UPDATE-shaped destructions)", () => {
    expect(guard).toMatch(/IF NEW\.disposition_state = 'disposed' AND OLD\.disposition_state IS DISTINCT FROM 'disposed' THEN/);
    expect(guard).toMatch(/cannot be disposed/);
    expect(guard).toMatch(/IF NEW\.status = 'Archived' AND OLD\.status IS DISTINCT FROM 'Archived' THEN/);
    expect(guard).toMatch(/cannot be archived/);
    // A release IN THE SAME write is allowed (the controller clearing the hold).
    expect(guard).toMatch(/IF OLD\.legal_hold AND NOT \(NEW\.legal_hold IS DISTINCT FROM OLD\.legal_hold AND NOT NEW\.legal_hold\) THEN/);
    const trg = between(m43, "CREATE TRIGGER trg_document_retention_guard", ";");
    expect(trg).toMatch(/BEFORE UPDATE ON documents/);
  });

  it("the disposition event log is append-only and authority-gated", () => {
    expect(between(m43, "CREATE POLICY doc_disposition_events_insert_authority", ";")).toMatch(/AS RESTRICTIVE FOR INSERT/);
    expect(between(m43, "CREATE POLICY doc_disposition_events_no_update", ";")).toMatch(/FOR UPDATE USING \(false\)/);
    expect(between(m43, "CREATE POLICY doc_disposition_events_no_delete", ";")).toMatch(/is_org_controller\(org_id\)/);
  });

  it("force_release_document does both writes in ONE transaction and relies on the existing triggers for authority", () => {
    const fn = between(m43, "CREATE OR REPLACE FUNCTION force_release_document", "REVOKE ALL ON FUNCTION force_release_document");
    expect(fn).toMatch(/UPDATE checkout_sessions[\s\S]*status = 'checked_in'[\s\S]*WHERE document_id = p_doc AND status = 'active'/);
    expect(fn).toMatch(/UPDATE documents[\s\S]*checked_out_by = NULL[\s\S]*current_lock_id = NULL[\s\S]*WHERE id = p_doc;/);
    expect(fn).toMatch(/SELECT \* INTO v_doc FROM documents WHERE id = p_doc FOR UPDATE;/);
    // No authority bypass: it does not disable triggers or check nothing.
    expect(fn).not.toMatch(/DISABLE TRIGGER/);
    expect(m43).toMatch(/REVOKE ALL ON FUNCTION force_release_document\(uuid, text\) FROM PUBLIC;/);
  });

  it("verification proves every guarded column exists (late-bound plpgsql safety)", () => {
    const v = between(m43, "── Verification", "── Inventory");
    expect(v).toMatch(/COUNT\(\*\) = 10 FROM information_schema\.columns/);
    expect(v).toMatch(/'legal_hold','legal_hold_matter','legal_hold_reason','legal_hold_by','legal_hold_at'/);
  });
});

describe("20261044 — owner delegation (DEL-1/GAP-3), bounded", () => {
  const live = between(m36, "CREATE OR REPLACE FUNCTION documents_guard_access_change()", "-- (Trigger documents_guard_access keeps");
  const next = between(m44, "CREATE OR REPLACE FUNCTION documents_guard_access_change()", "-- ── 2. folders");

  it("the ACL arm gains the effective-owner clause and the non-controller admin-grant bound; the OWN-2 arm is untouched", () => {
    expect(next).toMatch(/AND NOT user_is_effective_owner\(OLD\.owner_user_id, OLD\.collection_id, OLD\.library_id, auth\.uid\(\)\)/);
    expect(next).toMatch(/acl_index_grants_admin_beyond\(OLD\.acl_index, NEW\.acl_index\)/);
    const { onlyInA } = lineDiff(live, next);
    // Nothing removed from the live body — only lines added.
    expect(onlyInA.filter((l) => l.trim() !== "")).toEqual([]);
    expect(next).toMatch(/Not permitted to change this document''s owner\./);
  });

  it("the bound helper compares admin/managePermissions allows per subject bucket", () => {
    const h = between(m44, "CREATE OR REPLACE FUNCTION acl_index_grants_admin_beyond", "$$;");
    expect(h).toMatch(/\(VALUES \('users'\), \('roles'\), \('teams'\), \('orgs'\)\)/);
    expect(h).toMatch(/\(VALUES \('admin'\), \('managePermissions'\)\)/);
    expect(h).toMatch(/WHERE NOT \(COALESCE\(p_old->'allow'->b\.bucket->a\.action, '\[\]'::jsonb\) \? subj\)/);
  });

  it("folder-level delegation is possible at the database: controller OR owner OR manage-grant", () => {
    const pol = between(m44, "CREATE POLICY collections_update_controllers ON collections", ";");
    expect(pol).toMatch(/AS RESTRICTIVE FOR UPDATE/);
    expect(pol).toMatch(/owner_user_id::text = auth\.uid\(\)::text/);
    expect(pol).toMatch(/can_manage_node\(acl_index, org_id\)/);
  });
});

describe("20261045 — admin gates (DEC-17), team FK (DEC-9), reviewer independence (DEC-21)", () => {
  it("audit_logs: the org-level authority trail is admin-class only, document-level history stays", () => {
    const pol = between(m45, "CREATE POLICY audit_logs_admin_trail ON audit_logs", ";");
    expect(pol).toMatch(/AS RESTRICTIVE FOR SELECT/);
    expect(pol).toMatch(/ARRAY\['Admin','Manager','Supervisor','DocCtrl','Auditor'\]::text\[\]/);
    expect(pol).toMatch(/action LIKE 'CAPABILITY_%'/);
    expect(pol).toMatch(/action LIKE 'MEMBER_%'/);
    // The overlay is an OR-with-NOT: ordinary rows remain readable.
    expect(pol).toMatch(/OR NOT \(/);
  });

  it("asset registry: RESTRICTIVE write overlays per command, existing tables only, reads untouched", () => {
    const blk = between(m45, "-- ── 2. asset registry writes", "-- ── 3. team ownership");
    expect(blk).toMatch(/ARRAY\['assets','asset_types','asset_photos','asset_files','plot_plans'\]/);
    expect(blk).toMatch(/to_regclass\('public\.' \|\| t\) IS NULL THEN CONTINUE/);
    expect(blk).toMatch(/AS RESTRICTIVE FOR INSERT/);
    expect(blk).toMatch(/AS RESTRICTIVE FOR UPDATE/);
    expect(blk).toMatch(/AS RESTRICTIVE FOR DELETE/);
    expect(blk).not.toMatch(/RESTRICTIVE FOR SELECT|RESTRICTIVE FOR ALL/);
  });

  it("libraries.owner_team_id gets an FK ON DELETE SET NULL after dangling pointers are nulled and audited", () => {
    const blk = between(m45, "-- ── 3. team ownership cannot dangle", "-- ── 4. reviewer independence");
    expect(blk.indexOf("INSERT INTO audit_logs")).toBeLessThan(blk.indexOf("UPDATE libraries l SET owner_team_id = NULL"));
    expect(blk.indexOf("UPDATE libraries l SET owner_team_id = NULL")).toBeLessThan(blk.indexOf("ADD CONSTRAINT libraries_owner_team_id_fkey"));
    expect(blk).toMatch(/REFERENCES teams\(id\) ON DELETE SET NULL/);
    expect(blk).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'libraries_owner_team_id_fkey'\)/);
  });

  it("the publish guard is the 20261040 body plus ONLY the independence clause (DEC-2 and RG-1 intact)", () => {
    const live = between(m40, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "-- ── 2. per-library publish authority");
    const next = between(m45, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "COMMIT;");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA.filter((l) => l.trim() !== "")).toEqual([]);
    for (const l of onlyInB.filter((x) => x.trim() !== "")) {
      expect(
        l.trim().startsWith("--") || /v_independent|v_on_roster|v_require_ind|requireIndependentReviewer|Reviewer independence|document_review_signoffs s|s\.reviewer_user_id|s\.slot = 'primary'|s\.document_version_id|INTO v_on_roster|INTO v_require_ind|IF v_on_roster THEN|IF COALESCE\(v_require_ind, true\) THEN|IF COALESCE\(v_independent, 0\) = 0 THEN|IF COALESCE\(v_primary_reqs, 0\) > 0 THEN|FROM libraries l WHERE l\.id = NEW\.library_id|USING ERRCODE|RAISE EXCEPTION|END IF;|^\s*$/.test(l),
        `unexpected new line: ${l}`,
      ).toBe(true);
    }
    expect(next).toMatch(/IF is_org_controller\(NEW\.org_id\) THEN/);
    expect(next).toMatch(/e\.signer_user_id = s\.reviewer_user_id/);
    // The independence clause sits INSIDE the completion block (above the role short-circuit, deliberately).
    expect(next.indexOf("Reviewer independence")).toBeLessThan(next.indexOf("IF is_org_controller(NEW.org_id) THEN"));
    expect(next).toMatch(/COALESCE\(\(l\.review_control->>'requireIndependentReviewer'\)::boolean, true\)/);
    expect(next).toMatch(/AND s\.reviewer_user_id <> v_actor;/);
  });
});
