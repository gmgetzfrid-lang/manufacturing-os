// admin-and-org Round G — package P7: ALOG-14's remainder (the explicit
// Partial the integrator assigned at the A&O P9 merge, 2026-10-08). The 23
// permissions-explorer snapshot rows tagged NOT RE-CHECKED were each checked
// against the enforcement point their note now names; 21 are kept and marked
// checked, 2 removed. Each row is pinned here to its marks AND to the source
// text it describes, found in the NEWEST LIVE migration that defines the rule
// (scanned at test time; LIVE as audit-reports/MIGRATION-PASTE-ORDER.md
// marks it), so a later change to the rule fails this test instead of leaving
// the console wrong.
//
// P7 review fix: the first pass pinned the newest FILE, and so drew rules from
// migrations not yet pasted (20261143, 20261170, 20261102, 20261077, 20261070,
// 20261072, 20261149, 20261151, 20261166, 20261185) as today's. The rows now
// say what the live database decides; a pending rule is the row's
// "once <number> is pasted" warning. The census at the foot fails when a
// checked row's `cond` cites a migration that is not LIVE, or its `warn` cites
// one without that clause.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_ROWS, SNAPSHOT_REVIEWED, SURFACE_ROWS, explorerRows } from "@/components/permissions/PermissionsExplorer";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");
const migDir = join(root, "supabase", "migrations");
const migs = readdirSync(migDir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const mig = (f: string) => readFileSync(join(migDir, f), "utf8");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");
/** The newest numbered migration whose code matches `re`. */
const newest = (re: RegExp) => [...migs].reverse().find((f) => re.test(strip(mig(f)))) ?? null;

/** MIGRATION-PASTE-ORDER.md §4: each listed file's tag (LIVE / PASTE / HOLD /
 *  ASK). The guide lists every numbered file from 20261001 on; an older file
 *  is the shipped baseline it does not list (its §4 starts at 20261007 and
 *  §1.4 records 20261019–20261066 live). */
const PASTE_ORDER = src("audit-reports/MIGRATION-PASTE-ORDER.md");
const TAGS = new Map<string, Set<string>>();
for (const line of PASTE_ORDER.split("\n")) {
  const m = /^\| \d+[a-z]? (LIVE|PASTE|HOLD|ASK)\b[^|]*\| [^|]*?(\d{8})/.exec(line);
  if (m) TAGS.set(m[2], new Set([...(TAGS.get(m[2]) ?? []), m[1]]));
}
const isLive = (n: string) => (n < "20261001" ? true : TAGS.get(n)?.size === 1 && TAGS.get(n)!.has("LIVE"));
/** The newest LIVE numbered migration whose code matches `re` — the rule the
 *  database enforces today. */
const newestLive = (re: RegExp) => [...migs].reverse().find((f) => isLive(f.slice(0, 8)) && re.test(strip(mig(f)))) ?? null;
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
    const nv = newestLive(/CREATE OR REPLACE FUNCTION node_visible\(/)!;
    expect(nv).toBe("20261041_rp_phase5_node_visible_additive.sql");
    expect(mig(nv)).toMatch(/IF p_visibility IS NULL OR p_visibility = 'normal' THEN\s+RETURN true;[\s\S]*IF is_org_controller\(p_org\) THEN\s+RETURN true;[\s\S]*user_is_effective_owner\(p_owner, p_collection, p_library, auth\.uid\(\)\)/);
    expect(row("Upload files / create folders").m).toBe("yycccccccccc");
    expect(mig("20260901_db_hard_enforcement.sql")).toMatch(/CREATE POLICY documents_deny_upload_guard ON documents\s+AS RESTRICTIVE FOR INSERT/);
    // folders: 20261011 is ASK (no record says it is live), so today's rule is
    // schema.sql's org-membership policy and the controller-only one is pending
    expect(isLive("20261011")).toBe(false);
    expect(newestLive(/POLICY "?collections_insert/)).toBeNull();
    expect(src("supabase/schema.sql")).toMatch(/CREATE POLICY "collections_org_access" ON collections FOR ALL\s+USING \(org_id IN \(SELECT my_org_ids\(\)\)\)/);
    expect(mig("20261011_collections_guard_and_trash.sql")).toMatch(/collections_insert_controllers[\s\S]*?WITH CHECK \(is_org_controller\(org_id\)\)/);
    expect(newest(/POLICY collections_insert_controllers/)).toBe("20261011_collections_guard_and_trash.sql");
    expect(row("Upload files / create folders").warn).toContain("once 20261011 is confirmed applied, the database refuses anyone but Admin / Document Control a new folder");
  });

  it("download: canServeContent (controller, owner, a chain with no ACL on a normal document, else an ACL read / download grant over the full chain); the hard ack gate", () => {
    expect(row("Download / print (stamped when uncontrolled)").m).toBe("yycccccccccc");
    // KACL-5 / IEDGE-12 (intelligence I-12): canServeContent is the one read
    // predicate (canReadNode) asking read or download over the full chain.
    expect(src("lib/permissions.ts")).toMatch(/if \(isControllerPrincipal\(principal\)\) return true;\s+if \(params\.effectiveOwnerUserId && principal\.uid && params\.effectiveOwnerUserId === principal\.uid\) return true;[\s\S]*?if \(!decision\) return visibility === "normal";\s+return actions\.some\(\(a\) => decision\.can\(a\)\);/);
    expect(src("lib/permissions.ts")).toMatch(/return canReadNode\(\{ \.\.\.params, actions: \["read", "download"\] \}\);/);
    expect(row("Download / print (stamped when uncontrolled)").cond).toContain("over that chain on any visibility");
    expect(src("app/api/storage/download-url/route.ts")).toMatch(/canServeContent\(contentCheck\)/);
    expect(src("lib/downloads.ts")).toContain("export class AcknowledgmentRequiredError extends Error");
  });

  it("equipment links: every active member today (20260609); Admin / DocCtrl / Manager / Supervisor only once 20261170 is pasted", () => {
    const r = row("Edit equipment / asset tags");
    expect(r.m).toBe("yyyyyyyyyyyy");
    expect(newestLive(/POLICY "?document_assets/)).toBe("20260609_phase1_normalization.sql");
    expect(mig("20260609_phase1_normalization.sql")).toMatch(/CREATE POLICY "document_assets_member_all" ON document_assets\s+FOR ALL TO authenticated\s+USING \(EXISTS \(SELECT 1 FROM org_members WHERE org_id = document_assets\.org_id AND uid = auth\.uid\(\) AND status = 'active'\)\)/);
    expect(isLive("20261170")).toBe(false);
    expect(mig("20261170_intel_roundG_document_assets_source.sql")).toMatch(/DROP POLICY IF EXISTS "document_assets_member_all" ON document_assets;[\s\S]*?document_assets_insert[\s\S]*?caller_holds_any_role\(org_id, ARRAY\['Admin','DocCtrl','Manager','Supervisor'\]::text\[\]\)/);
    expect(r.warn).toContain("once 20261170 is pasted: manual links by Admin, Document Control, Manager or Supervisor only");
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
    expect(mig("20260826_legal_hold_delete_guard.sql")).toMatch(/IF OLD\.legal_hold THEN[\s\S]*?CREATE TRIGGER trg_documents_legal_hold_delete\s+BEFORE DELETE ON documents/);
    // the evidence guard is HOLD: said as pending, not as today's rule
    expect(isLive("20261149")).toBe(false);
    expect(strip(mig("20261149_dc_roundF_document_evidence_delete_guard.sql"))).toMatch(/BEFORE DELETE ON documents/);
    expect(row("Delete documents / versions").cond).not.toMatch(/20261149|evidence/);
    expect(row("Delete documents / versions").warn).toContain("once 20261149 is pasted: no one can");
    expect(row("Request deletion (owner path)").m).toBe("--cccccccccc");
    expect(src("components/documents/InspectorPanel.tsx")).toMatch(/\{!isController && isOwner && selectedDoc\.id && selectedDoc\.orgId && \(/);
    expect(src("lib/ownership.ts")).toMatch(/action: "DELETION_REQUESTED"/);
  });

  it("publishing, over a checkout, revert: user_can_publish_doc (controller, library publisher, effective owner)", () => {
    for (const cap of ["Publish / rev-up a revision", "Publish over someone's checkout (reason required)", "Revert to a prior revision"]) {
      expect(row(cap).m, cap).toBe("yycccccccccc");
    }
    expect(newestLive(/CREATE OR REPLACE FUNCTION user_can_publish_doc\(/)).toBe("20261037_rp_phase3b_read_ownership_and_version_integrity.sql");
    expect(mig("20261037_rp_phase3b_read_ownership_and_version_integrity.sql")).toMatch(/SELECT is_org_controller\(p_org\)\s+OR COALESCE\(\s+\(SELECT user_can_publish_on_library\(d\.library_id, auth\.uid\(\)::text, p_org\)\s+OR user_is_effective_owner\(d\.owner_user_id, d\.collection_id, d\.library_id, auth\.uid\(\)\)/);
    // today's publish_revision (20261049) takes the override flag alone: it
    // passes the lock, never a hold; the reason and the record are 20261130's.
    const pr = newestLive(/CREATE OR REPLACE FUNCTION publish_revision\(/)!;
    expect(pr).toBe("20261049_rp_phase7_handback_related_ticket.sql");
    expect(mig(pr)).toMatch(/AND NOT \(p_override_lock OR \(p_force AND v_is_controller\)\) THEN[\s\S]*?'locked_by_other'[\s\S]*?FROM document_holds\s+WHERE document_id = p_doc AND released_at IS NULL\s+\) AND NOT \(p_force AND v_is_controller\) THEN\s+RETURN jsonb_build_object\('status', 'on_hold'\);/);
    expect(mig(pr)).not.toContain("p_override_reason");
    expect(isLive("20261130")).toBe(false);
    expect(mig("20261130_dc_roundF_publish_override_reason.sql")).toContain("REV_LOCK_OVERRIDDEN");
    expect(row("Publish over someone's checkout (reason required)").warn).toContain("once 20261130 is pasted: it requires the reason and records the pass (REV_LOCK_OVERRIDDEN)");
    expect(src("lib/revisions.ts")).toContain("// Same invariants as a rev-up: only an authorized publisher for this library");
    expect(src("components/documents/InspectorPanel.tsx")).toContain("canRevert={canPublishEff}");
  });

  it("forcing past a hold is a controller's today (unrecorded on a direct write); the recorded force only once 20261151 is pasted", () => {
    const r = row("Force past an active hold");
    expect(r.m).toBe("yy----------");
    const g = newestLive(/CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/)!;
    expect(g).toBe("20261060_rp_roundE_archive_publish_authority.sql");
    // a controller returns before the hold check; anyone else is refused over a hold
    const body = strip(mig(g));
    expect(body).toMatch(/IF is_org_controller\(NEW\.org_id\) THEN\s+RETURN NEW;\s+END IF;[\s\S]*?'Document has an active hold; release the hold before publishing a new revision\.'/);
    expect(body).not.toContain("app.publish_hold_override");
    expect(isLive("20261151")).toBe(false);
    expect(strip(mig("20261151_dc_roundF_promote_transaction_and_hold_override.sql"))).toContain("REV_HOLD_OVERRIDDEN");
    expect(r.warn).toContain("once 20261151 is pasted: only the recorded force (REV_HOLD_OVERRIDDEN) passes it");
  });

  it("checkout: any member takes a free lock; only the holder or a checkout.force_release holder moves another's", () => {
    expect(row("Check out / check in documents").m).toBe("yyyyyyyyyyyy");
    const f = newestLive(/CREATE OR REPLACE FUNCTION enforce_checkout_session_guard\(\)/)!;
    expect(f).toBe("20261029_dc_phase3_permissive_rls.sql");
    expect(mig(f)).toMatch(/OLD\.user_id::text <> auth\.uid\(\)::text\s+AND NOT org_capability_allows\(OLD\.org_id, 'checkout\.force_release', auth\.uid\(\)\)/);
    expect(newestLive(/CREATE OR REPLACE FUNCTION enforce_document_lock_guard\(\)/)).toBe("20261029_dc_phase3_permissive_rls.sql");
  });

  it("legal hold: controllers only (the old row's 'if effective owner' was wrong); retention and disposition: controller, owner or library publisher", () => {
    expect(row("Place / release legal hold").m).toBe("yy----------");
    const f = newestLive(/CREATE OR REPLACE FUNCTION enforce_document_retention_guard\(\)/)!;
    expect(f).toBe("20261043_rp_phase6_legal_hold_and_force_release.sql");
    expect(mig(f)).toMatch(/IF v_hold_change AND NOT v_controller THEN\s+RAISE EXCEPTION 'Legal hold can only be placed or released by an Admin or Document Controller\.'/);
    expect(row("Retention, disposition & purge").m).toBe("yycccccccccc");
    expect(mig(f)).toMatch(/IF v_ret_change AND NOT v_controller\s+AND NOT user_is_effective_owner[\s\S]*?AND NOT user_can_publish_on_library/);
    expect(src("lib/retention.ts")).toMatch(/export async function disposeDocument[\s\S]*?await assertRetentionAuthority\(/);
    // the open-hold dispose gate is the app's today; the database's is 20261077's
    expect(mig(f)).not.toContain("HLD-1 (dispose gate)");
    expect(mig("20261077_dc_roundF_records_rails.sql")).toContain("HLD-1 (dispose gate)");
    expect(row("Retention, disposition & purge").warn).toContain("once 20261077 is pasted: the database refuses a non-controller's disposal under it too");
  });

  it("review policies: library and folder are controller / owner / Manage Permissions (live); a document's own is any member not denied write until 20261072", () => {
    const r = row("Configure review policies & rosters");
    expect(r.m).toBe("yycccccccccc");
    const lib = newestLive(/CREATE OR REPLACE FUNCTION enforce_library_sensitive_columns\(\)/)!;
    expect(lib).toBe("20261036_rp_phase3_publish_path.sql");
    expect(mig(lib)).toMatch(/OR NEW\.review_control\s+IS DISTINCT FROM OLD\.review_control\s+OR NEW\.review_policy\s+IS DISTINCT FROM OLD\.review_policy[\s\S]*?IF NOT is_org_controller\(OLD\.org_id\)\s+AND OLD\.owner_user_id::text IS DISTINCT FROM auth\.uid\(\)::text\s+AND NOT can_manage_node\(OLD\.acl_index, OLD\.org_id\) THEN/);
    expect(newestLive(/POLICY collections_update_controllers/)).toBe("20261044_rp_phase6_owner_delegation.sql");
    expect(mig("20261044_rp_phase6_owner_delegation.sql")).toMatch(/CREATE POLICY collections_update_controllers ON collections\s+AS RESTRICTIVE FOR UPDATE\s+USING \(\s+is_org_controller\(org_id\)\s+OR owner_user_id::text = auth\.uid\(\)::text\s+OR can_manage_node\(acl_index, org_id\)/);
    // no live guard reads a document's review_control
    expect(newestLive(/FUNCTION enforce_document_review_control_change\(\)/)).toBeNull();
    expect(src("supabase/migrations/20260901_db_hard_enforcement.sql")).toMatch(/CREATE POLICY documents_deny_write_guard ON documents\s+AS RESTRICTIVE FOR UPDATE[\s\S]*?acl_index_denies\(acl_index, org_id, auth\.uid\(\), 'write'\)\s+OR acl_index_denies\(acl_index, org_id, auth\.uid\(\), 'editMetadata'\)/);
    expect(isLive("20261072")).toBe(false);
    expect(mig("20261072_dc_roundF_review_control_governance.sql")).toMatch(/IF NOT is_org_controller\(OLD\.org_id\)\s+AND NOT user_is_effective_owner\(OLD\.owner_user_id, OLD\.collection_id, OLD\.library_id, auth\.uid\(\)\) THEN/);
    expect(r.warn).toContain("once 20261072 is pasted: a controller or the document's effective owner only");
  });

  it("recertification: offered to a controller or the library's owner, admitted for any member until 20261077 and 20261188 are pasted", () => {
    const r = row("Access recertification reviews");
    expect(r.m).toBe("yyyyyyyyyyyy");
    expect(newestLive(/POLICY "?access_recert/)).toBe("20260821_access_recert.sql");
    expect(mig("20260821_access_recert.sql")).toMatch(/CREATE POLICY "access_recert_events_member" ON access_recertification_events\s+FOR ALL\s+USING \(EXISTS \(SELECT 1 FROM org_members WHERE org_id = access_recertification_events\.org_id AND uid = auth\.uid\(\) AND status = 'active'\)\)/);
    expect(newestLive(/NEW\.last_recertified_at/)).toBeNull();
    expect(isLive("20261077")).toBe(false);
    expect(isLive("20261188")).toBe(false);
    expect(r.warn).toContain("once 20261077 and 20261188 are pasted: a controller or the library's owner only");
  });

  it("signing and acknowledging: only the named person, on their own row", () => {
    for (const cap of ["Sign a review (e-signature)", "Acknowledge read-&-understood", "Confirm “I have this revision”"]) {
      expect(row(cap).m, cap).toBe("cccccccccccc");
    }
    expect(newestLive(/CREATE OR REPLACE FUNCTION enforce_review_signoff_guard\(\)/)).toBe("20261047_rp_phase6_sweep_integrity_rails.sql");
    expect(mig("20261047_rp_phase6_sweep_integrity_rails.sql")).toContain("'Only the named reviewer can sign their own review row.'");
    expect(mig("20261047_rp_phase6_sweep_integrity_rails.sql")).not.toContain("You authored this revision");
    expect(mig("20261060_rp_roundE_archive_publish_authority.sql")).toContain("Reviewer independence: you are on this revision''s review roster");
    expect(isLive("20261070")).toBe(false);
    expect(mig("20261070_dc_roundF_review_gate_slots.sql")).toContain("You authored this revision, so you can''t sign it as its reviewer");
    expect(row("Sign a review (e-signature)").warn).toContain("once 20261070 is pasted: where the library requires an independent reviewer, the author never signs it");
    expect(newestLive(/CREATE OR REPLACE FUNCTION enforce_document_ack_guard\(\)/)).toBe("20261047_rp_phase6_sweep_integrity_rails.sql");
    expect(mig("20261047_rp_phase6_sweep_integrity_rails.sql")).toContain("'Only the named assignee can acknowledge their own read-and-understood row.'");
    expect(newestLive(/CREATE OR REPLACE FUNCTION enforce_distribution_ack_guard\(\)/)).toBe("20261033_dc_phase7b_guard_patches.sql");
    expect(mig("20261033_dc_phase7b_guard_patches.sql")).toContain("'Only the named recipient can acknowledge their own distribution.'");
  });

  it("requests, packages, confirmations, projects: the insert and update policies the rows name", () => {
    expect(row("Create a drafting request").m).toBe("yyyyyyyyyyyy");
    // today: schema.sql's org-membership policy, and the insert trigger stamps the caller (20261166 is HOLD)
    expect(newestLive(/POLICY "?tickets_org_(insert|access)/)).toBeNull();
    expect(src("supabase/schema.sql")).toMatch(/CREATE POLICY "tickets_org_access" ON tickets FOR ALL\s+USING \(org_id IN \(SELECT my_org_ids\(\)\)\)/);
    expect(newestLive(/CREATE OR REPLACE FUNCTION ticket_insert_integrity\(\)/)).toBe("20261038_rp_phase4_ticket_workflow_rails.sql");
    expect(mig("20261038_rp_phase4_ticket_workflow_rails.sql")).toMatch(/RAISE EXCEPTION 'tickets: only active members of the workspace can create requests';[\s\S]*?NEW\.requester_id := auth\.uid\(\);/);
    const wp = row("Create / edit / refresh work packages");
    expect(wp.m).toBe("yyyyyyyyyyyy");
    expect(newestLive(/POLICY work_packages_org_update/)).toBe("20260825_work_packages_acks.sql");
    expect(mig("20260825_work_packages_acks.sql")).toMatch(/CREATE POLICY work_packages_org_update ON work_packages FOR UPDATE USING \(\s+EXISTS \(SELECT 1 FROM org_members WHERE org_members\.org_id = work_packages\.org_id\s+AND org_members\.uid = auth\.uid\(\) AND org_members\.status = 'active'\)\s+\);/);
    expect(mig("20260825_work_packages_acks.sql")).toMatch(/CREATE POLICY work_packages_org_delete ON work_packages FOR DELETE USING \(\s+EXISTS \(SELECT 1 FROM org_members WHERE org_members\.org_id = work_packages\.org_id\s+AND org_members\.uid = auth\.uid\(\) AND org_members\.status = 'active'\)\s+\);/);
    expect(isLive("20261143")).toBe(false);
    expect(mig("20261143_dc_roundF_work_package_close_rail.sql")).toMatch(/work_packages\.owner_user_id = auth\.uid\(\)\s+OR EXISTS \(SELECT 1 FROM org_members m[\s\S]*?m\.role IN \('Admin','DocCtrl'\)/);
    expect(wp.warn).toMatch(/^No role differentiation today\./);
    expect(wp.warn).toContain("once 20261143 is pasted: only its owner or Admin / Document Control edits, refreshes, closes or deletes it");
    expect(row("Request distribution confirmations").m).toBe("yyyyyyyyyyyy");
    expect(newestLive(/POLICY distribution_acks_org_insert/)).toBe("20261032_dc_phase7_ack_and_pin_integrity.sql");
    expect(row("Create / manage projects & schedules").m).toBe("yycccccccccc");
    expect(newestLive(/POLICY projects_update_owner/)).toBe("20260906_projects_hardening.sql");
    expect(mig("20260906_projects_hardening.sql")).toMatch(/CREATE POLICY projects_update_owner ON projects FOR UPDATE USING \(\s+is_org_controller\(org_id\) OR owner_user_id::text = auth\.uid\(\)::text/);
    expect(newestLive(/POLICY projects_insert_member/)).toBe("20260906_projects_hardening.sql");
    expect(newestLive(/POLICY project_members_write/)).toBe("20260913_projects_rls_recursion_fix.sql");
    expect(newestLive(/POLICY milestones_delete_guard/)).toBe("20260818_followups_rls.sql");
  });
});

describe("ALOG-14 (P7 review fix) — a row states the LIVE database's rule; a pending migration's rule is said as pending", () => {
  const cited = (t: string | undefined) => [...new Set((t ?? "").match(/\b2026\d{4}\b/g) ?? [])];
  const pendingClause = (t: string, n: string) =>
    new RegExp(`once (?:\\d{8} and )*${n}(?: and \\d{8})* (?:is|are) (?:pasted|confirmed applied)`).test(t);

  it("the paste-order guide parses: LIVE, PASTE, HOLD and ASK files are all found", () => {
    expect(isLive("20261041")).toBe(true);
    expect(isLive("20261063")).toBe(true);
    for (const n of ["20261143", "20261170", "20261102", "20261077", "20261070", "20261072", "20261149", "20261151", "20261166", "20261185", "20261011"]) {
      expect(isLive(n), n).toBe(false);
    }
    expect(TAGS.size).toBeGreaterThan(100);
  });

  it("every migration a checked row's cond cites is LIVE (or older than the guide), and exists", () => {
    const bad: string[] = [];
    for (const r of SNAPSHOT_ROWS.filter((x) => x.checked)) {
      for (const n of cited(r.cond)) {
        if (!migs.some((f) => f.startsWith(n))) bad.push(`${r.cap}: ${n} has no migration file`);
        else if (!isLive(n)) bad.push(`${r.cap}: cond cites ${n}, which MIGRATION-PASTE-ORDER.md does not mark LIVE — say today's rule in cond and put "once ${n} is pasted: …" in warn`);
      }
    }
    for (const r of SURFACE_ROWS) {
      for (const n of cited(r.cond)) if (!isLive(n)) bad.push(`surface ${r.cap}: cond cites ${n}, not LIVE`);
    }
    expect(bad).toEqual([]);
  });

  it("every pending migration a checked row's warn names carries its 'once <number> is pasted' clause", () => {
    const bad: string[] = [];
    for (const r of SNAPSHOT_ROWS.filter((x) => x.checked)) {
      for (const n of cited(r.warn)) {
        if (!migs.some((f) => f.startsWith(n))) bad.push(`${r.cap}: ${n} has no migration file`);
        else if (!isLive(n) && !pendingClause(r.warn!, n)) bad.push(`${r.cap}: warn names ${n} (not LIVE) without "once ${n} is pasted"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("a pending clause whose file the guide now marks LIVE fails — the row is to be flipped to the new rule (the integrator, at the paste)", () => {
    const stale: string[] = [];
    for (const r of SNAPSHOT_ROWS) {
      for (const m of (r.warn ?? "").matchAll(/once ((?:\d{8} and )*\d{8}) (?:is|are) (?:pasted|confirmed applied)/g)) {
        for (const n of m[1].split(" and ")) if (isLive(n)) stale.push(`${r.cap}: ${n} is LIVE now — set m / cond to its rule and drop the "once ${n}" clause`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("the census bites: a row citing a pending file as today's rule, or naming it without the clause, is caught", () => {
    const n = "20261143";
    expect(isLive(n)).toBe(false);
    expect(pendingClause("only its owner (work_packages_org_update, 20261143)", n)).toBe(false);
    expect(pendingClause("once 20261143 is pasted: only its owner", n)).toBe(true);
    expect(pendingClause("once 20261077 and 20261188 are pasted: a controller", "20261188")).toBe(true);
    expect(pendingClause("once 20261011 is confirmed applied, controllers", "20261011")).toBe(true);
  });

  it("the rows the review named now draw today's live behaviour", () => {
    expect(row("Create / edit / refresh work packages").m).toBe("yyyyyyyyyyyy");
    expect(row("Edit equipment / asset tags").m).toBe("yyyyyyyyyyyy");
    expect(row("Access recertification reviews").m).toBe("yyyyyyyyyyyy");
    for (const r of SNAPSHOT_ROWS) expect(r.cond ?? "", r.cap).not.toMatch(/20261077 §2/);
  });
});
