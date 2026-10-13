// admin-and-org Round G — package P7: ALOG-14's remainder (the explicit
// Partial the integrator assigned at the A&O P9 merge, 2026-10-08). The 23
// permissions-explorer snapshot rows tagged NOT RE-CHECKED were each checked
// against the enforcement point their note now names; 21 are corrected or
// confirmed and marked checked, 2 removed. Each row is pinned here to its
// marks AND to the source text it describes, found in the NEWEST migration
// that defines the rule (scanned at test time), so a later change to the rule
// fails this test instead of leaving the console wrong.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_ROWS, SNAPSHOT_REVIEWED, explorerRows } from "@/components/permissions/PermissionsExplorer";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");
const migDir = join(root, "supabase", "migrations");
const migs = readdirSync(migDir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const mig = (f: string) => readFileSync(join(migDir, f), "utf8");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");
/** The newest numbered migration (or schema.sql) whose code matches `re`. */
const newest = (re: RegExp) => [...migs].reverse().find((f) => re.test(strip(mig(f)))) ?? null;
const row = (cap: string) => {
  const r = SNAPSHOT_ROWS.find((x) => x.cap === cap);
  if (!r) throw new Error(`no snapshot row ${cap}`);
  return r;
};

/** The 23 rows ALOG-14's Partial named (Scope / residual, "Not re-checked"). */
const TWENTY_THREE = [
  "Browse & read documents", "Upload files / create folders", "Download / print (stamped when uncontrolled)",
  "Edit equipment / asset tags", "Manage sets & binders", "Delete documents / versions", "Request deletion (owner path)",
  "Publish / rev-up a revision", "Publish over someone's checkout (reason required)", "Force past an active hold",
  "Revert to a prior revision", "Check out / check in documents", "Place / release legal hold",
  "Configure review policies & rosters", "Sign a review (e-signature)", "Auto-publish as last review signer",
  "Acknowledge read-&-understood", "Retention, disposition & purge",
  "Create a drafting request", "Create / edit / refresh work packages", "Request distribution confirmations",
  "Confirm “I have this revision”", "Create / manage projects & schedules",
];
const REMOVED = ["Manage sets & binders", "Auto-publish as last review signer"];

describe("ALOG-14 remainder — every snapshot row is checked against its enforcement point", () => {
  it("each of the 23 is either checked (and pinned below) or removed; no row is NOT RE-CHECKED any more", () => {
    for (const cap of TWENTY_THREE) {
      const r = SNAPSHOT_ROWS.find((x) => x.cap === cap);
      if (REMOVED.includes(cap)) expect(r, cap).toBeUndefined();
      else expect(r?.checked, cap).toBe(true);
    }
    expect(SNAPSHOT_ROWS.every((r) => r.checked)).toBe(true);
    expect(explorerRows({}).filter((r) => r.source === "snapshot" && r.unchecked)).toEqual([]);
    expect(SNAPSHOT_REVIEWED).toBe("2026-10-13");
  });

  it("documents: read follows node_visible; upload follows the deny-upload guard, folders are the controllers'", () => {
    expect(row("Browse & read documents").m).toBe("yycccccccccc");
    const nv = newest(/CREATE OR REPLACE FUNCTION node_visible\(/)!;
    expect(nv).toBe("20261041_rp_phase5_node_visible_additive.sql");
    expect(mig(nv)).toMatch(/IF p_visibility IS NULL OR p_visibility = 'normal' THEN\s+RETURN true;[\s\S]*IF is_org_controller\(p_org\) THEN\s+RETURN true;[\s\S]*user_is_effective_owner\(p_owner, p_collection, p_library, auth\.uid\(\)\)/);
    expect(row("Upload files / create folders").m).toBe("yycccccccccc");
    expect(mig("20260901_db_hard_enforcement.sql")).toMatch(/CREATE POLICY documents_deny_upload_guard ON documents\s+AS RESTRICTIVE FOR INSERT/);
    expect(mig("20261011_collections_guard_and_trash.sql")).toMatch(/collections_insert_controllers[\s\S]*?WITH CHECK \(is_org_controller\(org_id\)\)/);
    expect(newest(/POLICY collections_insert_controllers/)).toBe("20261011_collections_guard_and_trash.sql");
  });

  it("download: canServeContent (controller, owner, normal visibility, else an ACL read / download grant); the hard ack gate", () => {
    expect(row("Download / print (stamped when uncontrolled)").m).toBe("yycccccccccc");
    expect(src("lib/permissions.ts")).toMatch(/if \(isControllerPrincipal\(principal\)\) return true;\s+if \(params\.effectiveOwnerUserId && principal\.uid && params\.effectiveOwnerUserId === principal\.uid\) return true;\s+if \(visibility !== "hidden" && visibility !== "private"\) return true;[\s\S]*?return decision\.can\("download"\) \|\| decision\.can\("read"\);/);
    expect(src("app/api/storage/download-url/route.ts")).toMatch(/canServeContent\(contentCheck\)/);
    expect(src("lib/downloads.ts")).toContain("export class AcknowledgmentRequiredError extends Error");
  });

  it("equipment links: document_assets manual writes are Admin / DocCtrl / Manager / Supervisor (by the collection)", () => {
    expect(row("Edit equipment / asset tags").m).toBe("yyyy--------");
    expect(newest(/POLICY document_assets_insert/)).toBe("20261170_intel_roundG_document_assets_source.sql");
    expect(mig("20261170_intel_roundG_document_assets_source.sql")).toMatch(/document_assets_insert[\s\S]*?caller_holds_any_role\(org_id, ARRAY\['Admin','DocCtrl','Manager','Supervisor'\]::text\[\]\)/);
  });

  it("removed: no reachable screen manages sets, and the last review signature no longer publishes", () => {
    // SetManager writes document_sets, but the library page never opens it
    // (its show flag is only ever set false) — no surface to describe.
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(src("components/documents/SetManager.tsx")).toMatch(/from\('document_sets'\)\.insert/);
    expect(page).toContain("const [showSetManager, setShowSetManager] = useState(false);");
    expect(page).not.toMatch(/setShowSetManager\(true\)|setShowSetManager\(\(?[a-z]*\)? =>|setShowSetManager\(!/);
    expect(src("lib/reviewControl.ts")).toContain("it stays a draft until you do.");
    expect(src("lib/reviewControl.ts")).toContain('action: "REVIEW_COMPLETE_AWAITING_PUBLISH"');
  });

  it("delete: controllers only; legal hold and evidence block it for everyone; request deletion is the non-controller owner's", () => {
    expect(row("Delete documents / versions").m).toBe("yy----------");
    expect(mig("20260814_documents_delete_controllers.sql")).toMatch(/documents_delete_controllers[\s\S]*?USING \(is_org_controller\(org_id\)\)/);
    expect(mig("20260815_versions_collections_delete_controllers.sql")).toMatch(/document_versions_delete_controllers/);
    expect(strip(mig("20261149_dc_roundF_document_evidence_delete_guard.sql"))).toMatch(/BEFORE DELETE ON documents/);
    expect(row("Request deletion (owner path)").m).toBe("--cccccccccc");
    expect(src("components/documents/InspectorPanel.tsx")).toMatch(/\{!isController && isOwner && selectedDoc\.id && selectedDoc\.orgId && \(/);
    expect(src("lib/ownership.ts")).toMatch(/action: "DELETION_REQUESTED"/);
  });

  it("publishing, over a checkout, revert: user_can_publish_doc (controller, library publisher, effective owner)", () => {
    for (const cap of ["Publish / rev-up a revision", "Publish over someone's checkout (reason required)", "Revert to a prior revision"]) {
      expect(row(cap).m, cap).toBe("yycccccccccc");
    }
    expect(newest(/CREATE OR REPLACE FUNCTION user_can_publish_doc\(/)).toBe("20261037_rp_phase3b_read_ownership_and_version_integrity.sql");
    expect(mig("20261037_rp_phase3b_read_ownership_and_version_integrity.sql")).toMatch(/SELECT is_org_controller\(p_org\)\s+OR COALESCE\(\s+\(SELECT user_can_publish_on_library\(d\.library_id, auth\.uid\(\)::text, p_org\)\s+OR user_is_effective_owner\(d\.owner_user_id, d\.collection_id, d\.library_id, auth\.uid\(\)\)/);
    expect(newest(/CREATE OR REPLACE FUNCTION publish_revision\(/)).toBe("20261151_dc_roundF_promote_transaction_and_hold_override.sql");
    expect(mig("20261151_dc_roundF_promote_transaction_and_hold_override.sql")).toContain("p_override_lock = a publisher''s checkout-override: passes the lock, never a hold, and only with p_override_reason (>= 5 chars)");
    expect(src("lib/revisions.ts")).toContain("// Same invariants as a rev-up: only an authorized publisher for this library");
    expect(src("components/documents/InspectorPanel.tsx")).toContain("canRevert={canPublishEff}");
  });

  it("forcing past a hold is a controller's recorded override", () => {
    expect(row("Force past an active hold").m).toBe("yy----------");
    const g = newest(/CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/)!;
    expect(g).toBe("20261185_dc_roundF_status_into_force_issue.sql");
    expect(strip(mig(g))).toMatch(/current_setting\('app\.publish_hold_override', true\) IS DISTINCT FROM NEW\.id::text\s+AND is_org_controller\(NEW\.org_id\)/);
  });

  it("checkout: any member takes a free lock; only the holder or a checkout.force_release holder moves another's", () => {
    expect(row("Check out / check in documents").m).toBe("yyyyyyyyyyyy");
    const f = newest(/CREATE OR REPLACE FUNCTION enforce_checkout_session_guard\(\)/)!;
    expect(f).toBe("20261029_dc_phase3_permissive_rls.sql");
    expect(mig(f)).toMatch(/OLD\.user_id::text <> auth\.uid\(\)::text\s+AND NOT org_capability_allows\(OLD\.org_id, 'checkout\.force_release', auth\.uid\(\)\)/);
    expect(newest(/CREATE OR REPLACE FUNCTION enforce_document_lock_guard\(\)/)).toBe("20261029_dc_phase3_permissive_rls.sql");
  });

  it("legal hold: controllers only (the old row's 'if effective owner' was wrong); retention and disposition: controller, owner or library publisher", () => {
    expect(row("Place / release legal hold").m).toBe("yy----------");
    const f = newest(/CREATE OR REPLACE FUNCTION enforce_document_retention_guard\(\)/)!;
    expect(f).toBe("20261077_dc_roundF_records_rails.sql");
    expect(mig(f)).toMatch(/IF v_hold_change AND NOT v_controller THEN\s+RAISE EXCEPTION 'Legal hold can only be placed or released by an Admin or Document Controller\.'/);
    expect(row("Retention, disposition & purge").m).toBe("yycccccccccc");
    expect(mig(f)).toMatch(/IF v_ret_change AND NOT v_controller\s+AND NOT user_is_effective_owner[\s\S]*?AND NOT user_can_publish_on_library/);
    expect(src("lib/retention.ts")).toMatch(/export async function disposeDocument[\s\S]*?await assertRetentionAuthority\(/);
  });

  it("review policies: controller or effective owner (document), controller / owner / Manage Permissions (library)", () => {
    expect(row("Configure review policies & rosters").m).toBe("yycccccccccc");
    expect(newest(/CREATE OR REPLACE FUNCTION enforce_document_review_control_change\(\)/)).toBe("20261072_dc_roundF_review_control_governance.sql");
    expect(mig("20261072_dc_roundF_review_control_governance.sql")).toMatch(/IF NOT is_org_controller\(OLD\.org_id\)\s+AND NOT user_is_effective_owner\(OLD\.owner_user_id, OLD\.collection_id, OLD\.library_id, auth\.uid\(\)\) THEN/);
    expect(mig("20261077_dc_roundF_records_rails.sql")).toMatch(/OR NEW\.review_control\s+IS DISTINCT FROM OLD\.review_control\s+OR NEW\.review_policy\s+IS DISTINCT FROM OLD\.review_policy/);
  });

  it("signing and acknowledging: only the named person, on their own row", () => {
    for (const cap of ["Sign a review (e-signature)", "Acknowledge read-&-understood", "Confirm “I have this revision”"]) {
      expect(row(cap).m, cap).toBe("cccccccccccc");
    }
    expect(newest(/CREATE OR REPLACE FUNCTION enforce_review_signoff_guard\(\)/)).toBe("20261070_dc_roundF_review_gate_slots.sql");
    expect(mig("20261070_dc_roundF_review_gate_slots.sql")).toContain("'Only the named reviewer can sign their own review row.'");
    expect(newest(/CREATE OR REPLACE FUNCTION enforce_document_ack_guard\(\)/)).toBe("20261047_rp_phase6_sweep_integrity_rails.sql");
    expect(mig("20261047_rp_phase6_sweep_integrity_rails.sql")).toContain("'Only the named assignee can acknowledge their own read-and-understood row.'");
    expect(newest(/CREATE OR REPLACE FUNCTION enforce_distribution_ack_guard\(\)/)).toBe("20261033_dc_phase7b_guard_patches.sql");
    expect(mig("20261033_dc_phase7b_guard_patches.sql")).toContain("'Only the named recipient can acknowledge their own distribution.'");
  });

  it("requests, packages, confirmations, projects: the insert and update policies the rows name", () => {
    expect(row("Create a drafting request").m).toBe("yyyyyyyyyyyy");
    expect(newest(/POLICY tickets_org_insert/)).toBe("20261166_df_roundG_ticket_rails.sql");
    expect(mig("20261166_df_roundG_ticket_rails.sql")).toMatch(/CREATE POLICY tickets_org_insert ON tickets FOR INSERT\s+WITH CHECK \(org_id IN \(SELECT my_org_ids\(\)\) AND requester_id = auth\.uid\(\)\)/);
    expect(row("Create / edit / refresh work packages").m).toBe("yycccccccccc");
    expect(newest(/POLICY work_packages_org_update/)).toBe("20261143_dc_roundF_work_package_close_rail.sql");
    expect(mig("20261143_dc_roundF_work_package_close_rail.sql")).toMatch(/work_packages\.owner_user_id = auth\.uid\(\)\s+OR EXISTS \(SELECT 1 FROM org_members m[\s\S]*?m\.role IN \('Admin','DocCtrl'\)/);
    expect(row("Request distribution confirmations").m).toBe("yyyyyyyyyyyy");
    expect(newest(/POLICY distribution_acks_org_insert/)).toBe("20261032_dc_phase7_ack_and_pin_integrity.sql");
    expect(row("Create / manage projects & schedules").m).toBe("yycccccccccc");
    expect(newest(/POLICY projects_update_owner/)).toBe("20261102_prj_roundG_project_rails.sql");
    expect(newest(/POLICY projects_insert_member/)).toBe("20260906_projects_hardening.sql");
    expect(newest(/POLICY project_members_write/)).toBe("20260913_projects_rls_recursion_fix.sql");
    expect(newest(/POLICY milestones_delete_guard/)).toBe("20260818_followups_rls.sql");
  });
});
