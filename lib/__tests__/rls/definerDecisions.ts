// The SECURITY DEFINER grant census's decisions (intelligence I-17;
// projects-and-cost INTK-14 done-when 2; the DRLS-16 rule).
//
// One row per SECURITY DEFINER function in public on a fresh replay of the
// whole sequence (supabase/schema.sql + every numbered migration, including
// 20261217). lib/__tests__/rls/definerCensus.test.ts reads the live catalog
// of that replay and fails — in `npm run test:db` only, never in the default
// suite — when a definer function has no row here, when a row names a
// function that no longer exists, or when the EXECUTE grants differ from the
// row. A new SECURITY DEFINER function therefore needs a reasoned row before
// the opt-in run is green again.
//
// The grant state is what Supabase produces: its default privileges grant
// EXECUTE on every function `postgres` creates in public to anon,
// authenticated and service_role, on top of PostgreSQL's PUBLIC grant, so a
// function stays callable with the public anon key unless a migration
// revokes it from anon by name (supabaseStandIn.sql reproduces those default
// privileges).
//
// Decisions:
//   trigger-only          returns trigger: PostgreSQL refuses a direct call
//                         (0A000) and PostgREST does not expose it, so its
//                         EXECUTE grant is irrelevant (listed by signature).
//   policy-helper         called by row-level-security policies written for
//                         every role, so anon and authenticated must execute
//                         it; its body judges the caller (auth.uid(), or a
//                         caller-scoped helper). Kept.
//   policy-helper-oracle  as above, but the body never reads the session: it
//                         judges a person (or maps a project) the caller
//                         passes in, so anyone holding the anon key can ask
//                         about another uid. Kept (the policies need it); the
//                         narrowing is owned by projects-and-cost INTK-19.
//   signed-in-oracle      anon and PUBLIC revoked, authenticated keeps
//                         EXECUTE, and the body judges a uid the caller
//                         passes in without binding it to auth.uid(): any
//                         signed-in account, of any workspace, can ask about
//                         any person. Recorded; the narrowing is INTK-19's.
//   own-scope-unused      reads only the caller's own ids; nothing uses it.
//   signed-in             anon and PUBLIC revoked by its own migration;
//                         authenticated keeps EXECUTE; the body judges the
//                         signed-in caller.
//   anon-refused-by-body  anon keeps EXECUTE (Supabase's default grant; no
//                         migration revokes it), the app calls it only as a
//                         signed-in member, and the body refuses (raises, or
//                         answers NULL to) a caller with no session. Recorded,
//                         not revoked: DEC-90 ruling 4 allows a REVOKE only for
//                         a function the app never calls as anon/authenticated,
//                         and records the decision and its owner (the
//                         integrator) when unsure.
//   revoked-20261217      EXECUTE for service_role only, by 20261217.
//   service-only          EXECUTE for service_role only, by its own migration.
//   role-only             EXECUTE by name to the intake_door role only.
//   internal              no client role at all; called by other definers.
//
// A decision whose claim is about the BODY (BODY_CLAIM_DECISIONS) cites the
// body: `evidence` holds fragments of the live function (pg_proc.prosrc),
// verbatim up to whitespace, and the census finds each one there — for a
// caller-judging decision the clause that judges the signed-in caller, for an
// oracle the clause that reads the person it is told about. So a reason
// cannot be a template, and a body that changes under a row fails the run.
//
// A client-callable function that takes a person (an IN parameter matching
// PERSON_PARAM: p_uid, p_to_user, p_actor, p_member_id, p_new_owner, …)
// either carries an oracle decision with an owner, or says in `person` how the
// body binds that parameter (PersonBinding), with its own evidence; a binding
// that still leaks (caller-supplied-oracle) carries an owner too. The census
// checks this against the catalog, so a templated reason cannot hide a new
// oracle.

export type PersonBinding =
  /** For a signed-in caller the body refuses (or replaces) any value but auth.uid(). */
  | "is-the-caller"
  /** The parameter is a row's attribute (an owner column); the answer is about auth.uid(). */
  | "judged-for-caller"
  /**
   * The answer is judged for auth.uid(), but over RPC the caller supplies the
   * parameter, and the answer still depends on that person (their membership):
   * a narrow oracle. Recorded with an owner (INTK-19), like an oracle decision.
   */
  | "caller-supplied-oracle"
  /** The caller's own authority over that person's workspace is checked first (an Admin acting on a member). */
  | "caller-authority"
  /** The caller must be an active member of the workspace, and a person outside it gets a constant answer. */
  | "same-workspace";

export interface DefinerDecision {
  /** regprocedure text, as pg_proc.oid::regprocedure prints it. */
  signature: string;
  decision:
    | "policy-helper"
    | "policy-helper-oracle"
    | "signed-in-oracle"
    | "own-scope-unused"
    | "signed-in"
    | "anon-refused-by-body"
    | "revoked-20261217"
    | "service-only"
    | "role-only"
    | "internal";
  /** EXECUTE on the replayed database after the whole sequence. */
  execute: { anon: boolean; authenticated: boolean; service_role: boolean };
  reason: string;
  /** Fragments of the live body that carry the decision's claim (required for BODY_CLAIM_DECISIONS). */
  evidence?: readonly string[];
  /** For a function with a PERSON_PARAM parameter that is not an oracle: how the body binds it. */
  person?: { param: string; binding: PersonBinding; evidence: readonly string[] };
  /** Who owns a remaining narrowing, when the decision records one. */
  owner?: string;
}

/** Decisions whose claim is about what the body does; each such row cites the body (`evidence`). */
export const BODY_CLAIM_DECISIONS: readonly DefinerDecision["decision"][] = [
  "policy-helper", "policy-helper-oracle", "signed-in-oracle", "own-scope-unused", "signed-in", "anon-refused-by-body",
];

/** Who owns DEC-90 ruling 4's open question for an "anon-refused-by-body" row. */
export const RULING_4_OWNER =
  "the integrator (DEC-90 ruling 4: the app calls it as authenticated, so a REVOKE of anon alone needs an explicit ruling; recorded, not revoked)";

/** Decisions that record an oracle: the narrowing is owned by projects-and-cost INTK-19. */
export const ORACLE_DECISIONS: readonly DefinerDecision["decision"][] = ["policy-helper-oracle", "signed-in-oracle"];

/** An IN parameter that names a person (p_uid, p_to_user, p_actor, p_member_id, p_new_owner, p_doc_owner, …). */
export const PERSON_PARAM = /^(p_)?([a-z0-9]+_)*(uid|uids|user|users|user_id|actor|member|member_id|owner|recipient|signer|assignee|holder|requester|by)$/;

/** decision "trigger-only": each returns trigger (checked against the catalog). */
export const TRIGGER_FUNCTIONS: readonly string[] = [
  "assets_audit_delete()",
  "assets_backfill_documents()",
  "assets_guard_registry_columns()",
  "audit_library_delete()",
  "audit_logs_stamp_identity()",
  "audit_review_control_change()",
  "capability_policy_write_guard()",
  "checklist_items_decision_rail()",
  "checklist_items_org_matches_parent()",
  "checkouts_resync_project_documents()",
  "close_project_intake_links()",
  "codebook_entries_guard_in_use()",
  "collections_guard_access_change()",
  "documents_guard_access_change()",
  "documents_intake_adoption_guard()",
  "documents_resync_assets()",
  "enforce_change_order_decision_guard()",
  "enforce_checkout_release_guard()",
  "enforce_checkout_session_guard()",
  "enforce_cost_document_award_registry()",
  "enforce_cost_document_company_move()",
  "enforce_cost_entry_update_guard()",
  "enforce_cost_ledger_delete_guard()",
  "enforce_distribution_ack_guard()",
  "enforce_document_ack_guard()",
  "enforce_document_evidence_delete_guard()",
  "enforce_document_hold_guard()",
  "enforce_document_hold_label_guard()",
  "enforce_document_hold_org_guard()",
  "enforce_document_insert_pointer_rail()",
  "enforce_document_lock_guard()",
  "enforce_document_move_guard()",
  "enforce_document_publish_guard()",
  "enforce_document_register_rail()",
  "enforce_document_retention_guard()",
  "enforce_document_review_control_change()",
  "enforce_document_version_key_guard()",
  "enforce_document_versions_pointer_rail()",
  "enforce_email_requeue_columns()",
  "enforce_intake_link_assignment()",
  "enforce_legal_hold_delete_guard()",
  "enforce_legal_hold_version_delete_guard()",
  "enforce_library_insert_sensitive_columns()",
  "enforce_library_sensitive_columns()",
  "enforce_milestone_project_move()",
  "enforce_node_appearance_columns()",
  "enforce_notification_insert()",
  "enforce_project_delete_guard()",
  "enforce_project_document_link_fixed()",
  "enforce_project_lifecycle_guard()",
  "enforce_project_party_delete()",
  "enforce_project_record_guard()",
  "enforce_review_signoff_guard()",
  "enforce_signature_ceremony()",
  "enforce_team_member_org()",
  "enforce_team_org_move()",
  "enforce_team_supervisor_member()",
  "enforce_version_hold_label_guard()",
  "enforce_wpd_pin_guard()",
  "keep_private_project_company_events_private()",
  "org_member_departure_returns_tickets()",
  "prevent_last_admin_removal()",
  "project_checklists_completion_basis_rail()",
  "project_checklists_signoff_rail()",
  "punch_items_void_rail()",
  "quality_records_delete_rail()",
  "quality_row_org_matches_project()",
  "record_document_status_issue()",
  "record_milestone_scope_on_delete()",
  "record_work_package_repin()",
  "review_signoff_owner_stamp()",
  "skills_audit()",
  "stamp_milestone_audit_project()",
  "stamp_project_activity_author()",
  "sync_current_version_label()",
  "teams_guard_supervisor_change()",
  "ticket_insert_integrity()",
  "ticket_update_guard()",
  "touch_project_last_activity()",
  "turnover_items_decision_rail()",
  "turnover_items_record_review_event()",
  "turnover_items_signoff_rail()",
  "units_codebook_code_follow()",
];

/** Every SECURITY DEFINER function a client could name over PostgREST, with its decision. */
export const CALLABLE_DEFINERS: readonly DefinerDecision[] = [
  {
    signature: "acl_index_denies(jsonb,uuid,uuid,text)",
    decision: "policy-helper-oracle",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 2 policies written for PUBLIC, so anon and authenticated keep EXECUTE (a REVOKE would turn a policy's empty answer into a 42501 error). Its body never reads auth.uid(): it judges the p_uid it is given — that uid's own deny entry, then its active roles and its teams — so anyone holding the public anon key can ask whether another person is denied an action, given the uuids. Also named by the app: lib/orchestrator/tools.ts.",
    evidence: ["IF p_idx->'deny'->'users'->p_action ? p_uid::text THEN RETURN TRUE; END IF;", "FROM org_members WHERE org_id = p_org AND uid = p_uid AND status = 'active' LIMIT 1;"],
    owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)",
  },
  {
    signature: "adopt_intake_document(uuid,uuid,uuid,text,jsonb)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261141_prj_roundG_intake_token_hash_and_adoption.sql; authenticated keeps EXECUTE. A caller with no session is refused (42501), and the caller must then be a controller of the document's own workspace (is_org_controller) before it moves; the destination library and folder must be in that workspace. No person parameter. Named by the app: lib/transitionIn.ts.",
    evidence: ["IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in to adopt a document into the controlled register.'", "IF NOT is_org_controller(v_doc.org_id) THEN"],
  },
  { signature: "ai_cap_change(uuid,uuid,uuid,numeric,boolean,boolean)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261173_intel_roundG_ai_cap_change.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: lib/ai/capChange.ts, lib/schemaExpectations.ts." },
  { signature: "append_ticket_redline(uuid,uuid,jsonb,jsonb)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261166_df_roundG_ticket_rails.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts, lib/schemaExpectations.ts." },
  {
    signature: "apply_milestone_moves(uuid,uuid,jsonb)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261098_prj_roundG_apply_milestone_moves.sql; authenticated keeps EXECUTE. A signed-in caller must pass caller_is_active_member(p_org) and can_edit_project_schedule(p_org, p_project) (Admin, DocCtrl, Manager or Supervisor, or the project's owner); with no uid only the service role passes. Every UPDATE is pinned to org_id = p_org AND project_id = p_project. Named by the app: lib/milestones.ts.",
    evidence: ["IF NOT caller_is_active_member(p_org) THEN RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';", "IF NOT can_edit_project_schedule(p_org, p_project) THEN"],
  },
  { signature: "bump_intake_use(uuid,bigint)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261104_prj_roundG_intake_links.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts." },
  { signature: "bump_share_access(uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261081_dc_roundF_share_access_log.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/share/resolve/route.ts, lib/schemaExpectations.ts." },
  { signature: "bump_transmittal_portal_use(uuid,text)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261133_dc_roundF_transmittal_rails.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/transmittal/route.ts." },
  {
    signature: "caller_holds_any_role(uuid,text[])",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 31 row-level-security policies, most written for every role (PUBLIC), so anon and authenticated must keep EXECUTE: a REVOKE would turn a policy's empty answer into a 42501 error. It is one EXISTS over the caller's own active membership holding one of p_roles in role or roles[] (uid = auth.uid()), so it answers only about the caller, and with no session it is false. No person parameter.",
    evidence: ["WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' AND (role = ANY(p_roles) OR roles && p_roles)"],
  },
  {
    signature: "caller_is_active_member(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 2 policies (PUBLIC and authenticated) and by the three schedule RPCs, so anon and authenticated keep EXECUTE. One EXISTS over the caller's own active membership of p_org (uid = auth.uid()); with no session it is false.",
    evidence: ["SELECT EXISTS (SELECT 1 FROM org_members WHERE uid = auth.uid() AND org_id = p_org AND status = 'active');"],
  },
  {
    signature: "can_edit_project_schedule(uuid,uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261098_prj_roundG_apply_milestone_moves.sql; authenticated keeps EXECUTE. A predicate on the caller only: caller_holds_any_role(p_org, Admin / DocCtrl / Manager / Supervisor), or the project's owner_user_id is auth.uid(). No app call site names it; apply_milestone_moves, set_project_baseline and clear_project_baseline call it.",
    evidence: ["SELECT caller_holds_any_role(p_org, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[]) OR EXISTS (SELECT 1 FROM projects p WHERE p.id = p_project AND p.org_id = p_org AND p.owner_user_id = auth.uid());"],
  },
  {
    signature: "can_manage_node(jsonb,uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 1 policy written for PUBLIC, so anon and authenticated keep EXECUTE. A controller of p_org (is_org_controller, the caller's) gets true; otherwise it reads only the caller's own membership and teams (uid = auth.uid()) against the admin / managePermissions grants of the acl_index it is passed — the row's own index, not a person. Not an active member: false.",
    evidence: ["IF is_org_controller(p_org) THEN RETURN true; END IF;", "WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' LIMIT 1;"],
  },
  {
    signature: "can_manage_project(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 5 policies (PUBLIC and authenticated). True only when the caller is the project's active owner (owner_user_id = auth.uid()), holds Admin or Manager in its workspace (caller_holds_any_role) or is an owner / collaborator project member (pm.user_id = auth.uid()); with no session, false.",
    evidence: ["(p.owner_user_id = auth.uid()", "OR caller_holds_any_role(p.org_id, ARRAY['Admin','Manager']::text[])", "WHERE pm.project_id = p.id AND pm.user_id = auth.uid()"],
  },
  { signature: "claim_access_request_burst(uuid,uuid[],text,text)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261197_notif_roundG_burst_claim_digest_rail.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/auth/request-access/route.ts, lib/schemaExpectations.ts." },
  {
    signature: "clear_project_baseline(uuid,uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261099_prj_roundG_baseline_authority.sql; authenticated keeps EXECUTE. Gated as apply_milestone_moves is (caller_is_active_member and can_edit_project_schedule for the project, else only the service role) before it snapshots the baseline into its history and clears it. Named by the app: lib/milestones.ts.",
    evidence: ["IF NOT caller_is_active_member(p_org) THEN RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';", "IF NOT can_edit_project_schedule(p_org, p_project) THEN"],
  },
  {
    signature: "clear_resolved_branch_alerts(uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261181_notif_roundG_producers_free.sql; authenticated keeps EXECUTE. With no session it returns 0. Otherwise it acts only on a RESOLVED branch in a workspace where auth.uid() is an active member, marking that branch's open branch_open notices read for every recipient (a resolved branch's alert is stale for all of them). Named by the app: lib/branches.ts.",
    evidence: ["v_uid uuid := auth.uid();", "IF v_uid IS NULL OR p_branch IS NULL THEN RETURN 0;", "AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = b.org_id AND m.uid = v_uid AND m.status = 'active');"],
  },
  {
    signature: "contractor_only_org_ids()",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261166_df_roundG_ticket_rails.sql; authenticated keeps EXECUTE, which the 2 policies that call it need (the tickets and ticket_comments read scopes, written for authenticated, DEC-89). It returns only the caller's own workspaces in which every role they hold is Contractor (m.uid = auth.uid()); with no session, the empty set.",
    evidence: ["WHERE auth.uid() IS NOT NULL AND m.uid = auth.uid() AND m.status = 'active'"],
  },
  {
    signature: "delete_project_record(uuid,text)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261103_prj_roundG_project_closeout_rails.sql; authenticated keeps EXECUTE. A caller with no session is refused; the caller must be a controller of the project's workspace or its owner (is_org_controller / user_owns_project, both for auth.uid()), and only a controller, with a reason, deletes a project that carries cost or quality records. Named by the app: lib/projects.ts.",
    evidence: ["IF v_actor IS NULL THEN RAISE EXCEPTION 'Sign in to delete a project.';", "v_controller := is_org_controller(v_proj.org_id);", "IF NOT (v_controller OR user_owns_project(p_project)) THEN"],
  },
  {
    signature: "doc_is_visible(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 2 policies written for PUBLIC. It reads the document's own visibility, acl_index, owner and containers and hands them to node_visible, which judges auth.uid(); a document that does not exist is false. The owner it passes is the row's column, not a person the caller names.",
    evidence: ["(SELECT node_visible(d.visibility, d.acl_index, d.org_id, d.owner_user_id, d.collection_id, d.library_id) FROM documents d WHERE d.id = p_doc)"],
  },
  {
    signature: "document_has_versions(uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261205_dc_roundF_direct_write_issue_record.sql; authenticated keeps EXECUTE. It answers NULL unless the document is in one of the caller's workspaces (my_org_ids) and doc_is_visible for the caller; only then does it say whether any version exists. Named by lib/schemaExpectations.ts (a presence probe).",
    evidence: ["WHERE d.id = p_record AND d.org_id IN (SELECT my_org_ids())) AND doc_is_visible(p_record)"],
  },
  {
    signature: "document_share_refusal(uuid,uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261080_dc_roundF_share_minting_and_revocation.sql; authenticated keeps EXECUTE, which document_shares_insert's WITH CHECK needs (written for PUBLIC; an anon insert is refused either way). For a signed-in caller the document is read only when p_org is one of my_org_ids() and node_visible passes for the caller, otherwise the answer is 'not_found'; with no uid (the service role) it reads any document.",
    evidence: ["AND (auth.uid() IS NULL OR p_org IN (SELECT my_org_ids()))", "AND (auth.uid() IS NULL OR node_visible(d.visibility, d.acl_index, d.org_id,"],
  },
  {
    signature: "documents_total_for_org(uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261138_intel_roundG_unit_identity.sql; authenticated keeps EXECUTE. It counts the workspace's documents only when auth.uid() is an active member of p_org_id, and answers 0 otherwise. Named by the app: lib/orgGraph.ts.",
    evidence: ["WHEN EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org_id AND uid = auth.uid() AND status = 'active') THEN (SELECT COUNT(*) FROM documents WHERE org_id = p_org_id)"],
  },
  {
    signature: "email_gate(uuid,uuid,text,text,text,text)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261191_notif_roundG_kind_split.sql; authenticated keeps EXECUTE. A signed-in caller must be an active member of p_org (42501 otherwise); with no uid only the service role passes. It then answers for the RECIPIENT p_to_user — whether their email preferences and the 60-second dedupe let this event's email through — which is DEC-74's design (the one email rule runs where the recipient's row is visible). A recipient outside p_org gets a constant true, so nothing is disclosed across workspaces. Named by the app: lib/notifications.ts.",
    evidence: ["v_uid uuid := auth.uid();", "IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org AND uid = v_uid AND status = 'active') THEN RAISE EXCEPTION 'email_gate: not an active member of this workspace'"],
    person: { param: "p_to_user", binding: "same-workspace", evidence: ["IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org AND uid = p_to_user) THEN RETURN true;"] },
  },
  {
    signature: "entity_mentions_total_for_asset(uuid,uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261120_intel_roundG_knowledge_memory_acl.sql; authenticated keeps EXECUTE. It counts an asset's entity mentions only when auth.uid() is an active member of p_org_id, and answers 0 otherwise. Named by the app: lib/mentions.ts.",
    evidence: ["WHEN EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org_id AND uid = auth.uid() AND status = 'active') THEN (SELECT COUNT(*) FROM entity_mentions WHERE org_id = p_org_id AND asset_id = p_asset_id)"],
  },
  {
    signature: "force_release_document(uuid,text)",
    decision: "anon-refused-by-body",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "lib/checkoutEpisodes.ts:709 calls it as a signed-in member. 20261043 revoked PUBLIC and granted authenticated, but Supabase's default grant left anon, so the anon key reaches it: the body then raises (P0001) because auth.uid() is NULL, and a signed-in caller who is not an active member of the document's workspace is refused the same way. Force authority itself is judged by the checkout release guard on the rows it writes. Not revoked from anon (DEC-90 ruling 4: the app calls it as authenticated).",
    owner: RULING_4_OWNER,
    evidence: ["v_actor uuid := auth.uid();", "IF v_actor IS NULL THEN RAISE EXCEPTION 'force_release_document: must be called by a signed-in member';", "IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = v_doc.org_id AND uid = v_actor AND status = 'active') THEN"],
  },
  { signature: "intake_door_append_redline(text,uuid,jsonb,jsonb)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261184_prj_roundG_intake_door_identity.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts." },
  { signature: "intake_door_bound()", decision: "internal", execute: { anon: false, authenticated: false, service_role: false }, reason: "Executable by no client role (20261184_prj_roundG_intake_door_identity.sql: REVOKE … FROM PUBLIC, anon, authenticated, service_role): only other SECURITY DEFINER functions call it, as their owner." },
  { signature: "intake_door_may_create(uuid,uuid,uuid,uuid,text)", decision: "role-only", execute: { anon: false, authenticated: false, service_role: false }, reason: "Executable by no client role: EXECUTE is granted by name to the intake_door role only (20261184_prj_roundG_intake_door_identity.sql), whose 2 policies call it (the contractor door, DEC-95). PostgREST callers cannot reach it." },
  { signature: "intake_door_may_quote(uuid,uuid,text,uuid,text,uuid,text,text,text,uuid)", decision: "role-only", execute: { anon: false, authenticated: false, service_role: false }, reason: "Executable by no client role: EXECUTE is granted by name to the intake_door role only (20261184_prj_roundG_intake_door_identity.sql), whose 2 policies call it (the contractor door, DEC-95). PostgREST callers cannot reach it." },
  { signature: "intake_door_point_pending(text,uuid,uuid,uuid,timestamp with time zone)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261184_prj_roundG_intake_door_identity.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts, lib/schemaExpectations.ts." },
  { signature: "intake_door_promote(text,uuid,uuid,jsonb,text)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261184_prj_roundG_intake_door_identity.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts, lib/schemaExpectations.ts." },
  { signature: "intake_door_submit_version(text,jsonb)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261184_prj_roundG_intake_door_identity.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts." },
  { signature: "intake_review_health_by_org()", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261105_prj_roundG_intake_review_and_attempts.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/cron/maintenance/route.ts." },
  {
    signature: "is_org_admin(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 8 policies written for PUBLIC. A one-line wrapper over caller_holds_any_role(p_org, Admin), so it answers only about the caller; with no session, false.",
    evidence: ["SELECT caller_holds_any_role(p_org, ARRAY['Admin']::text[]);"],
  },
  {
    signature: "is_org_admin_or_manager(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 4 policies written for PUBLIC, and by revoke_member. One EXISTS over the caller's own active membership holding Admin or Manager in role or roles[]; with no session, false.",
    evidence: ["WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' AND (role IN ('Admin', 'Manager') OR roles && ARRAY['Admin', 'Manager']::text[])"],
  },
  {
    signature: "is_org_assign_drafters(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 3 policies written for PUBLIC. One EXISTS over the caller's own active membership holding Admin, Manager, Supervisor or DraftingSupervisor; with no session, false.",
    evidence: ["SELECT 1 FROM org_members WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' AND (role IN ('Admin','Manager','Supervisor','DraftingSupervisor')"],
  },
  {
    signature: "is_org_controller(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 80 policies (PUBLIC and authenticated) and by most controller-gated definer functions. One EXISTS over the caller's own active membership holding Admin or DocCtrl by the role collection (DEC-2); with no session, false.",
    evidence: ["WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])"],
  },
  { signature: "is_org_controller_for(uuid,uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261125_intel_roundG_skills_authority.sql: REVOKE … FROM PUBLIC, anon, authenticated). No app call site names it today (other definer functions or the SQL editor call it)." },
  {
    signature: "is_project_member(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 1 policy written for PUBLIC. True only when the caller is a member of the project (pm.user_id = auth.uid()) and still an active member of its workspace; with no session, false.",
    evidence: ["WHERE pm.project_id = p_project AND pm.user_id::text = auth.uid()::text"],
  },
  {
    signature: "is_project_owner(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 5 policies (PUBLIC and authenticated). True only when the caller is the project's owner (owner_user_id = auth.uid()) and an active member of its workspace; with no session, false.",
    evidence: ["WHERE p.id = p_project AND p.owner_user_id::text = auth.uid()::text"],
  },
  {
    signature: "issue_document_number(uuid)",
    decision: "anon-refused-by-body",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "lib/libraryNumbering.ts:46 calls it as a signed-in member. 20260806 has no grant statement at all, so PUBLIC and Supabase's default grants leave it callable with the anon key; the body then answers NULL without advancing the counter, because a NULL auth.uid() is no active member of the library's workspace. Not revoked from anon (DEC-90 ruling 4: the app calls it as authenticated).",
    owner: RULING_4_OWNER,
    evidence: ["IF NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = cfg.org_id AND m.uid = auth.uid() AND m.status = 'active') THEN RETURN NULL;"],
  },
  { signature: "member_is_active(uuid,uuid)", decision: "revoked-20261217", execute: { anon: false, authenticated: false, service_role: true }, reason: "A membership oracle for ANY uid (\"is uid X active in org Y?\"), callable with the public anon key. Its only caller is user_is_effective_owner, a SECURITY DEFINER function owned by postgres that keeps calling it as its owner; no app .rpc( call, no policy, no SECURITY INVOKER function names it. 20261217 leaves EXECUTE to service_role only. That removes the direct door, not the answer: user_is_effective_owner(X, NULL, <library>, X) still returns it to the anon key, and node_visible's caller-supplied p_owner to a signed-in library owner, until INTK-19 lands.", owner: "projects-and-cost INTK-19 (the same membership answer through user_is_effective_owner and node_visible)" },
  { signature: "mfg_dedup_stats()", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20260807_dedup_stats_fn.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/admin/storage-stats/route.ts." },
  { signature: "mfg_storage_estimate()", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261008_storage_estimate_knowledge.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/admin/storage-stats/route.ts." },
  { signature: "mfg_table_stats()", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20260805_storage_stats_fn.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/admin/purge/route.ts, app/api/admin/storage-stats/route.ts, lib/storageUsage.ts." },
  {
    signature: "my_org_ids()",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 22 policies (PUBLIC and authenticated), as `org_id IN (SELECT my_org_ids())`. Returns the caller's own active workspace ids only (uid = auth.uid()); with no session, the empty set.",
    evidence: ["SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active';"],
  },
  {
    signature: "my_project_ids()",
    decision: "own-scope-unused",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Returns the caller's own project ids (user_id = auth.uid()); an anon caller gets the empty set. No policy on the replay, no function and no app .rpc( call names it any more, so it can neither leak nor be needed; kept as recorded, not revoked.",
    evidence: ["SELECT project_id FROM project_members WHERE user_id = auth.uid();"],
  },
  {
    signature: "my_team_ids()",
    decision: "own-scope-unused",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Returns the caller's own team ids in workspaces where they are active (tm.uid = auth.uid()); an anon caller gets the empty set. Nothing on the replay names it (no policy, no function, no app call), so it is kept as recorded, not revoked.",
    evidence: ["WHERE tm.uid = auth.uid();"],
  },
  {
    signature: "next_ticket_number(uuid,integer)",
    decision: "anon-refused-by-body",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "app/api/tickets/create/route.ts:673 (with the caller's JWT) and lib/ticketNumber.ts:84 call it as a signed-in member. schema.sql / 20260724 grant authenticated and never revoke PUBLIC or anon, so the anon key reaches it; the body then raises 'not an active member of this org' (P0001) before any counter moves, because a NULL auth.uid() has no active membership of p_org. Not revoked from anon (DEC-90 ruling 4: the app calls it as authenticated).",
    owner: RULING_4_OWNER,
    evidence: ["WHERE org_id = p_org AND uid = auth.uid() AND status = 'active' ) THEN RAISE EXCEPTION 'not an active member of this org';"],
  },
  {
    signature: "node_visible(text,jsonb,uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "The 3-argument form of the node_visible policies (5 policies written for PUBLIC). It forwards to the 6-argument form with no owner and no containers, so its answer is that form's, judged for auth.uid().",
    evidence: ["SELECT node_visible(p_visibility, p_acl_index, p_org, NULL::uuid, NULL::uuid, NULL::uuid);"],
  },
  {
    signature: "node_visible(text,jsonb,uuid,uuid,uuid,uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 5 policies written for PUBLIC, and by doc_is_visible and document_share_refusal. Normal visibility answers true (the policies add the membership test); otherwise a controller of p_org sees the row, then its effective owner, then the acl_index grants — each judged for auth.uid(). A policy passes the row's owner column as p_owner, but over PostgREST the caller supplies it, and the ownership walk skips a p_owner who is not active: a signed-in library owner who passes ('restricted', '{}', org, X, NULL, <their library>) gets true exactly when X is not an active member. That narrow membership oracle is recorded with INTK-19 as owner.",
    evidence: ["IF is_org_controller(p_org) THEN RETURN true;", "WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' LIMIT 1;"],
    person: { param: "p_owner", binding: "caller-supplied-oracle", evidence: ["IF user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()) THEN RETURN true;"] },
    owner: "projects-and-cost INTK-19 (p_owner's membership leaks through the ownership walk)",
  },
  {
    signature: "notifications_i_sent(uuid,text,timestamp with time zone,text,text,jsonb)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261191_notif_roundG_kind_split.sql; authenticated keeps EXECUTE. It returns only notifications the caller sent (n.actor_user_id = auth.uid()), of two kinds, from a workspace where the caller is active, at most 30 days back; with no session, nothing. Named by the app: lib/sentNotices.ts.",
    evidence: ["AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p_org AND m.uid = auth.uid() AND m.status = 'active')", "AND n.actor_user_id = auth.uid()"],
  },
  {
    signature: "org_capability_allows(uuid,text,uuid)",
    decision: "policy-helper-oracle",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 4 policies written for PUBLIC, so anon and authenticated keep EXECUTE. Its body is one line, org_capability_allows_for(p_org, p_cap, p_uid, '{}'), and never reads auth.uid(), so anyone holding the public anon key can ask whether another person holds a capability in a workspace, given the uuids.",
    evidence: ["RETURN org_capability_allows_for(p_org, p_cap, p_uid, '{}'::jsonb);"],
    owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)",
  },
  {
    signature: "org_capability_allows_for(uuid,text,uuid,jsonb)",
    decision: "signed-in-oracle",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261137_intel_roundG_ai_manage_caps.sql; authenticated keeps EXECUTE. The body never reads auth.uid(): it loads the role collection of the p_uid it is given and answers whether THAT person holds p_cap under the workspace's capability policy, standing grants included. Any signed-in account, of any workspace, can therefore ask about any person in any other workspace, given the uuids, and nothing is audited. No policy and no app .rpc( call names it; the definers org_capability_allows and quality_signoff_granted_for call it, and so does the SECURITY INVOKER trigger function transmittals_guard, as the signed-in member — so a plain REVOKE from authenticated would break issuing, voiding or revoking a transmittal.",
    evidence: ["SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles FROM org_members WHERE org_id = p_org AND uid = p_uid AND status = 'active'"],
    owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)",
  },
  { signature: "post_ticket_comment(uuid,jsonb,uuid[],uuid[])", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261166_df_roundG_ticket_rails.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/tickets/comment/route.ts." },
  {
    signature: "project_org(uuid)",
    decision: "policy-helper-oracle",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 6 policies (PUBLIC and authenticated), so the roles they judge must execute it. Its body is one SELECT of the project's org_id for any caller: a small oracle mapping any project id to its workspace id (a project uuid is unguessable, and the workspace id discloses no row).",
    evidence: ["SELECT org_id FROM projects WHERE id = p_project;"],
    owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)",
  },
  { signature: "project_regulated_record_count(uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261103_prj_roundG_project_closeout_rails.sql: REVOKE … FROM PUBLIC, anon, authenticated). No app call site names it today (other definer functions or the SQL editor call it)." },
  {
    signature: "project_visible_to_me(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 16 policies (PUBLIC and authenticated). The caller must be an active member of the project's workspace (om.uid = auth.uid()), and a private project is visible only to its owner, a controller or a project member — each judged for auth.uid(); with no session, false.",
    evidence: ["JOIN org_members om ON om.org_id = p.org_id AND om.uid = auth.uid() AND om.status = 'active'"],
  },
  {
    signature: "prune_removed_member_acl_index(uuid,uuid,uuid[],uuid[],text,uuid,integer)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261204_ao_roundG_revoke_member_acl_prune.sql; authenticated keeps EXECUTE. A signed-in caller must be an active Admin of p_org_id by the role collection; with no uid only the service role passes. p_uid is the REMOVED member: the call is refused while that person is still in the workspace, and it only strips that uid from allow lists on the carriers named inside p_org_id. Named by the app: lib/memberAclIndexPrune.ts.",
    evidence: ["v_actor uuid := auth.uid();", "ELSIF NOT EXISTS (SELECT 1 FROM org_members me WHERE me.uid = v_actor AND me.org_id = p_org_id AND me.status = 'active' AND (me.role = 'Admin' OR me.roles && ARRAY['Admin']::text[])) THEN"],
    person: { param: "p_uid", binding: "caller-authority", evidence: ["IF EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p_org_id AND m.uid = p_uid) THEN RAISE EXCEPTION 'prune_removed_member_acl_index: this person is still a member of the workspace — nothing was changed.'"] },
  },
  {
    signature: "publish_revision(uuid,uuid,text,jsonb,uuid,text,boolean,boolean,text,text,boolean,text)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261151_dc_roundF_promote_transaction_and_hold_override.sql; authenticated keeps EXECUTE. A signed-in caller's p_actor must be auth.uid() (left NULL it becomes auth.uid(); any other value is refused), so attribution, membership, controller status, the lock override and publish authority are all judged for the caller; only the service role (no uid) names its actor. Named by the app: app/api/intake/upload/route.ts, lib/postPublish.ts, lib/revisions.ts.",
    evidence: ["IF auth.uid() IS NOT NULL THEN IF p_actor IS NULL THEN p_actor := auth.uid();", "WHERE org_id = v_doc.org_id AND uid = p_actor AND status = 'active' ) INTO v_is_member;"],
    person: { param: "p_actor", binding: "is-the-caller", evidence: ["ELSIF p_actor IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'publish_revision: p_actor does not match the calling session.'"] },
  },
  { signature: "quality_other_signers(uuid,uuid,uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261136_prj_roundG_quality_signoff.sql: REVOKE … FROM PUBLIC, anon, authenticated). No app call site names it; quality_signoff_status calls it, as its owner, for otherSigners with auth.uid()." },
  { signature: "quality_signer_eligible(uuid,uuid,uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261136_prj_roundG_quality_signoff.sql: REVOKE … FROM PUBLIC, anon, authenticated). No app call site names it; quality_signoff_status calls it, as its owner, for maySign with auth.uid(), and quality_other_signers per member." },
  {
    signature: "quality_signoff_granted(uuid,uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261136_prj_roundG_quality_signoff.sql; authenticated keeps EXECUTE, which its 4 policies (written for authenticated) need. Its body is quality_signoff_granted_for(p_org, p_project, auth.uid()): the service-only uid-taking form, asked only about the caller.",
    evidence: ["SELECT quality_signoff_granted_for(p_org, p_project, auth.uid());"],
  },
  { signature: "quality_signoff_granted_for(uuid,uuid,uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261136_prj_roundG_quality_signoff.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/admin/capability-policy/route.ts." },
  {
    signature: "quality_signoff_status(uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261136_prj_roundG_quality_signoff.sql; authenticated keeps EXECUTE. It answers maySign and otherSigners for auth.uid() only (the service-only quality_signer_eligible / quality_other_signers, called with the caller's uid), and only for a project_visible_to_me. Named by the app: components/permissions/PermissionsExplorer.tsx, lib/checklists.ts.",
    evidence: ["'maySign', quality_signer_eligible(p.org_id, p.id, auth.uid()),", "WHERE p.id = p_project AND project_visible_to_me(p.id);"],
  },
  {
    signature: "rename_codebook_code(uuid,text,text,text,boolean,jsonb)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261178_intel_roundG_codebook_lifecycle.sql; authenticated keeps EXECUTE. Before anything is read it refuses a caller with no session, a caller who is not a controller of p_org_id (is_org_controller) and a controller who also holds Viewer or Auditor (caller_holds_any_role), all judged for auth.uid(). Named by the app: app/api/admin/codebook/route.ts.",
    evidence: ["IF p_org_id IS NULL OR NOT is_org_controller(p_org_id) THEN", "IF caller_holds_any_role(p_org_id, ARRAY['Viewer','Auditor']::text[]) THEN"],
  },
  {
    signature: "reopen_project(uuid,text)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261103_prj_roundG_project_closeout_rails.sql; authenticated keeps EXECUTE. A caller with no session is refused, and only a controller of the project's workspace (is_org_controller, for auth.uid()) reopens a closed project, with a reason. Named by the app: lib/projects.ts.",
    evidence: ["IF v_actor IS NULL THEN RAISE EXCEPTION 'Sign in to reopen a project.';", "IF NOT is_org_controller(v_proj.org_id) THEN RAISE EXCEPTION 'Only Admin / Document Control can reopen a closed project.'"],
  },
  { signature: "return_departed_member_tickets(uuid,uuid,text)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261195_df_roundG_outcome_and_departure.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: lib/ticketDepartureBackstop.ts." },
  {
    signature: "revoke_member(uuid,text)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261204_ao_roundG_revoke_member_acl_prune.sql; authenticated keeps EXECUTE. A caller with no session, or acting on themself, is refused. p_member_id names an org_members row, and the caller's authority is judged in THAT row's workspace: remove needs an active Admin there, suspend and restore an Admin or Manager (is_org_admin_or_manager), and only an Admin touches an Admin. Named by the app: app/(protected)/admin/users/page.tsx, lib/members.ts.",
    evidence: ["v_actor uuid := auth.uid();", "IF v_member.uid = v_actor THEN RAISE EXCEPTION 'You can''t suspend or remove yourself.';"],
    person: { param: "p_member_id", binding: "caller-authority", evidence: ["SELECT * INTO v_member FROM org_members WHERE id = p_member_id;", "IF NOT EXISTS (SELECT 1 FROM org_members me WHERE me.uid = v_actor AND me.org_id = v_member.org_id AND me.status = 'active' AND (me.role = 'Admin' OR me.roles && ARRAY['Admin']::text[])) THEN RAISE EXCEPTION 'Only an Admin can remove a member from the workspace.';", "IF NOT is_org_admin_or_manager(v_member.org_id) THEN"] },
  },
  {
    signature: "revup_rollback_orphan(uuid,uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261027_dc_phase1_unguarded_doors.sql; authenticated keeps EXECUTE. Only the version's own creator (created_by = auth.uid()), still an active member of its workspace, may delete it and un-supersede its sibling; an unknown version changes nothing. No app call site names it today.",
    evidence: ["IF v_created_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'revup_rollback_orphan: not your version to roll back';", "WHERE org_id = v_org AND uid = auth.uid() AND status = 'active' ) THEN RAISE EXCEPTION 'revup_rollback_orphan: not an active member of this org';"],
  },
  {
    signature: "set_project_baseline(uuid,uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261099_prj_roundG_baseline_authority.sql; authenticated keeps EXECUTE. Gated as apply_milestone_moves is (caller_is_active_member and can_edit_project_schedule for the project, else only the service role) before it records the prior baseline and re-baselines the project's milestones. Named by the app: lib/milestones.ts.",
    evidence: ["IF NOT caller_is_active_member(p_org) THEN RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';", "IF NOT can_edit_project_schedule(p_org, p_project) THEN RAISE EXCEPTION 'You do not have schedule-editing rights on this project'"],
  },
  {
    signature: "supersession_writable(uuid,uuid,uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261131_dc_roundF_documents_rails.sql; authenticated keeps EXECUTE, which its 2 policies (document_supersessions INSERT and UPDATE, written for authenticated) need. True only when auth.uid() is an active member of p_org and a controller, a publisher on the superseded document's library or its effective owner (the uid-taking helpers are called with auth.uid()), and both documents are in p_org.",
    evidence: ["SELECT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p_org AND m.uid = auth.uid() AND m.status = 'active')", "OR user_can_publish_on_library(s.library_id, auth.uid()::text, s.org_id)"],
  },
  {
    signature: "ticket_mentions_me(uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261166_df_roundG_ticket_rails.sql; authenticated keeps EXECUTE, which the read-scope policy that calls it (written for authenticated) needs. True only when auth.uid() is among a live comment's mentioned_uids on that ticket — a fact about the caller alone.",
    evidence: ["SELECT auth.uid() IS NOT NULL AND EXISTS (", "AND auth.uid() = ANY (COALESCE(c.mentioned_uids, '{}'::uuid[]))"],
  },
  {
    signature: "transfer_project_ownership(uuid,uuid,text)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261102_prj_roundG_project_rails.sql; authenticated keeps EXECUTE. A caller with no session is refused; only a controller of the project's workspace or its owner (is_org_controller / user_owns_project, for auth.uid()) may transfer, and the new owner p_new_owner must be an active member of that same workspace. Named by the app: lib/projects.ts.",
    evidence: ["IF v_actor IS NULL THEN RAISE EXCEPTION 'Sign in to transfer project ownership.';", "IF NOT (is_org_controller(v_proj.org_id) OR user_owns_project(p_project)) THEN"],
    person: { param: "p_new_owner", binding: "caller-authority", evidence: ["IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = v_proj.org_id AND uid = p_new_owner AND status = 'active') THEN"] },
  },
  {
    signature: "user_can_publish_doc(uuid,uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 2 policies written for PUBLIC. A controller of p_org, or for the document's library user_can_publish_on_library / user_is_effective_owner asked about auth.uid() — the uid-taking forms are called here only with the caller's own uid; with no session, false.",
    evidence: ["SELECT is_org_controller(p_org) OR COALESCE( (SELECT user_can_publish_on_library(d.library_id, auth.uid()::text, p_org) OR user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())"],
  },
  {
    signature: "user_can_publish_on_library(uuid,text,uuid)",
    decision: "policy-helper-oracle",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 5 policies written for PUBLIC (and by publish_revision, supersession_writable and user_can_publish_doc with the caller's own uid). Its body never reads auth.uid(): it loads the roles and teams of the p_uid it is given (a text parameter) and reads the library's publish grants and denies, so anyone holding the public anon key can ask whether another person may publish into a library, given the uuids. Also named by the app: app/api/intake/upload/route.ts, app/api/links/invalidate/route.ts, lib/documentShares.ts, lib/shareServe.ts.",
    evidence: ["WHERE org_id = p_org AND uid::text = p_uid AND status = 'active'"],
    owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)",
  },
  {
    signature: "user_download_denied(jsonb,uuid,uuid)",
    decision: "signed-in",
    execute: { anon: false, authenticated: true, service_role: true },
    reason: "anon and PUBLIC revoked by 20261140_dc_roundF_share_download_deny_rail.sql; authenticated keeps EXECUTE. A signed-in caller may ask only about themself: a p_uid other than auth.uid() is refused (42501) before any member's roles or teams are read; only the service role (no uid) asks about anyone. Named by the app: lib/documentShares.ts.",
    evidence: ["IF auth.uid() IS NOT NULL AND p_uid IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'user_download_denied answers only for the signed-in caller.'"],
    person: { param: "p_uid", binding: "is-the-caller", evidence: ["IF auth.uid() IS NOT NULL AND p_uid IS DISTINCT FROM auth.uid() THEN"] },
  },
  {
    signature: "user_is_effective_owner(uuid,uuid,uuid,uuid)",
    decision: "policy-helper-oracle",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 5 policies written for PUBLIC (and by node_visible, user_can_publish_doc and supersession_writable with auth.uid()). Its body never reads auth.uid(): it walks document owner, folder owner, library owner and the owning team's supervisor, keeps the first that member_is_active confirms, and compares it with the p_uid it is given, so anyone holding the public anon key can ask whether another person is a document's effective owner, given the uuids. Also named by the app: app/api/links/invalidate/route.ts, app/api/storage/download-url/route.ts, lib/docFileServer.ts, lib/ownership.ts, lib/revisions.ts.",
    evidence: ["IF p_doc_owner IS NOT NULL AND member_is_active(v_org, p_doc_owner) THEN RETURN p_doc_owner = p_uid;"],
    owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)",
  },
  {
    signature: "user_owns_project(uuid)",
    decision: "policy-helper",
    execute: { anon: true, authenticated: true, service_role: true },
    reason: "Called inside 10 policies (PUBLIC and authenticated) and by the project RPCs. True only when the caller is the project's owner (owner_user_id = auth.uid()) and an active member of its workspace; with no session, false.",
    evidence: ["ON m.org_id = p.org_id AND m.uid = auth.uid() AND m.status = 'active' WHERE p.id = p_project AND p.owner_user_id = auth.uid()"],
  },
];
