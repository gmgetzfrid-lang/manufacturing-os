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
//                         it; it judges the caller (auth.uid()) and answers
//                         false / empty with no session. Kept.
//   policy-helper-oracle  as above, but it takes the person to judge as a
//                         parameter, so anyone can ask it about another uid.
//                         Kept (the policies need it); the narrowing is owned
//                         by projects-and-cost INTK-19.
//   own-scope-unused      reads only the caller's own ids; nothing uses it.
//   signed-in             anon and PUBLIC revoked by its own migration;
//                         authenticated keeps EXECUTE.
//   signed-in-rpc         the same state, reached by 20261217.
//   revoked-20261217      EXECUTE for service_role only, by 20261217.
//   service-only          EXECUTE for service_role only, by its own migration.
//   role-only             EXECUTE by name to the intake_door role only.
//   internal              no client role at all; called by other definers.

export interface DefinerDecision {
  /** regprocedure text, as pg_proc.oid::regprocedure prints it. */
  signature: string;
  decision:
    | "policy-helper"
    | "policy-helper-oracle"
    | "own-scope-unused"
    | "signed-in"
    | "signed-in-rpc"
    | "revoked-20261217"
    | "service-only"
    | "role-only"
    | "internal";
  /** EXECUTE on the replayed database after the whole sequence. */
  execute: { anon: boolean; authenticated: boolean; service_role: boolean };
  reason: string;
  /** Who owns a remaining narrowing, when the decision records one. */
  owner?: string;
}

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
  { signature: "acl_index_denies(jsonb,uuid,uuid,text)", decision: "policy-helper-oracle", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 2 row-level-security policies written for every role, so anon and authenticated must be able to execute it (a REVOKE would turn an empty answer into a 42501 error for every such read). It takes p_uid — the person to judge — rather than reading auth.uid(), so anyone holding the public anon key can ask it about another person's authority given the uuids. Also named by the app: lib/orchestrator/tools.ts.", owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)" },
  { signature: "adopt_intake_document(uuid,uuid,uuid,text,jsonb)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261141_prj_roundG_intake_token_hash_and_adoption.sql); the body judges the signed-in caller. Named by the app: lib/transitionIn.ts." },
  { signature: "ai_cap_change(uuid,uuid,uuid,numeric,boolean,boolean)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261173_intel_roundG_ai_cap_change.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: lib/ai/capChange.ts, lib/schemaExpectations.ts." },
  { signature: "append_ticket_redline(uuid,uuid,jsonb,jsonb)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261166_df_roundG_ticket_rails.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts, lib/schemaExpectations.ts." },
  { signature: "apply_milestone_moves(uuid,uuid,jsonb)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261098_prj_roundG_apply_milestone_moves.sql); the body judges the signed-in caller. Named by the app: lib/milestones.ts." },
  { signature: "bump_intake_use(uuid,bigint)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261104_prj_roundG_intake_links.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts." },
  { signature: "bump_share_access(uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261081_dc_roundF_share_access_log.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/share/resolve/route.ts, lib/schemaExpectations.ts." },
  { signature: "bump_transmittal_portal_use(uuid,text)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261133_dc_roundF_transmittal_rails.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/transmittal/route.ts." },
  { signature: "caller_holds_any_role(uuid,text[])", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 31 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "caller_is_active_member(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 2 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "can_edit_project_schedule(uuid,uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261098_prj_roundG_apply_milestone_moves.sql); the body judges the signed-in caller. No app call site names it today." },
  { signature: "can_manage_node(jsonb,uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 1 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "can_manage_project(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 5 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "claim_access_request_burst(uuid,uuid[],text,text)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261197_notif_roundG_burst_claim_digest_rail.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/auth/request-access/route.ts, lib/schemaExpectations.ts." },
  { signature: "clear_project_baseline(uuid,uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261099_prj_roundG_baseline_authority.sql); the body judges the signed-in caller. Named by the app: lib/milestones.ts." },
  { signature: "clear_resolved_branch_alerts(uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261181_notif_roundG_producers_free.sql); the body judges the signed-in caller. Named by the app: lib/branches.ts, lib/schemaExpectations.ts." },
  { signature: "contractor_only_org_ids()", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261166_df_roundG_ticket_rails.sql); the body judges the signed-in caller. Called inside 2 policies." },
  { signature: "delete_project_record(uuid,text)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261103_prj_roundG_project_closeout_rails.sql); the body judges the signed-in caller. Named by the app: lib/projects.ts." },
  { signature: "doc_is_visible(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 2 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It reads no caller-supplied person: visibility is decided for auth.uid() (through the caller-scoped helpers it calls), so with no session it answers false." },
  { signature: "document_has_versions(uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261205_dc_roundF_direct_write_issue_record.sql); the body judges the signed-in caller. Named by the app: lib/schemaExpectations.ts." },
  { signature: "document_share_refusal(uuid,uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261080_dc_roundF_share_minting_and_revocation.sql); the body judges the signed-in caller. Called inside 1 policies." },
  { signature: "documents_total_for_org(uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261138_intel_roundG_unit_identity.sql); the body judges the signed-in caller. Named by the app: lib/orgGraph.ts." },
  { signature: "email_gate(uuid,uuid,text,text,text,text)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261191_notif_roundG_kind_split.sql); the body judges the signed-in caller. Named by the app: lib/notifications.ts." },
  { signature: "entity_mentions_total_for_asset(uuid,uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261120_intel_roundG_knowledge_memory_acl.sql); the body judges the signed-in caller. Named by the app: lib/mentions.ts." },
  { signature: "force_release_document(uuid,text)", decision: "signed-in-rpc", execute: { anon: false, authenticated: true, service_role: true }, reason: "lib/checkoutEpisodes.ts calls it as a signed-in member; the body raises without auth.uid(), and the checkout release guard judges authority. 20261043 revoked PUBLIC but Supabase's default grant left anon; 20261217 revokes anon and grants authenticated and service_role by name." },
  { signature: "intake_door_append_redline(text,uuid,jsonb,jsonb)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261184_prj_roundG_intake_door_identity.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts." },
  { signature: "intake_door_bound()", decision: "internal", execute: { anon: false, authenticated: false, service_role: false }, reason: "Executable by no client role (20261184_prj_roundG_intake_door_identity.sql: REVOKE … FROM PUBLIC, anon, authenticated, service_role): only other SECURITY DEFINER functions call it, as their owner." },
  { signature: "intake_door_may_create(uuid,uuid,uuid,uuid,text)", decision: "role-only", execute: { anon: false, authenticated: false, service_role: false }, reason: "Executable by no client role: EXECUTE is granted by name to the intake_door role only (20261184_prj_roundG_intake_door_identity.sql), whose 2 policies call it (the contractor door, DEC-95). PostgREST callers cannot reach it." },
  { signature: "intake_door_may_quote(uuid,uuid,text,uuid,text,uuid,text,text,text,uuid)", decision: "role-only", execute: { anon: false, authenticated: false, service_role: false }, reason: "Executable by no client role: EXECUTE is granted by name to the intake_door role only (20261184_prj_roundG_intake_door_identity.sql), whose 2 policies call it (the contractor door, DEC-95). PostgREST callers cannot reach it." },
  { signature: "intake_door_point_pending(text,uuid,uuid,uuid,timestamp with time zone)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261184_prj_roundG_intake_door_identity.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts, lib/schemaExpectations.ts." },
  { signature: "intake_door_promote(text,uuid,uuid,jsonb,text)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261184_prj_roundG_intake_door_identity.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts, lib/schemaExpectations.ts." },
  { signature: "intake_door_submit_version(text,jsonb)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261184_prj_roundG_intake_door_identity.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/intake/upload/route.ts." },
  { signature: "intake_review_health_by_org()", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261105_prj_roundG_intake_review_and_attempts.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/cron/maintenance/route.ts." },
  { signature: "is_org_admin(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 8 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It reads no caller-supplied person: it judges auth.uid() through the caller-scoped helpers it calls, so with no session it answers false." },
  { signature: "is_org_admin_or_manager(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 4 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "is_org_assign_drafters(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 3 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "is_org_controller(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 80 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "is_org_controller_for(uuid,uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261125_intel_roundG_skills_authority.sql: REVOKE … FROM PUBLIC, anon, authenticated). No app call site names it today (other definer functions or the SQL editor call it)." },
  { signature: "is_project_member(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 1 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "is_project_owner(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 5 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "issue_document_number(uuid)", decision: "signed-in-rpc", execute: { anon: false, authenticated: true, service_role: true }, reason: "lib/libraryNumbering.ts calls it as a signed-in member; the body returns NULL unless auth.uid() is an active member of the library's org. 20261217 revokes PUBLIC and anon (it had no grant statement at all) and grants authenticated and service_role by name." },
  { signature: "member_is_active(uuid,uuid)", decision: "revoked-20261217", execute: { anon: false, authenticated: false, service_role: true }, reason: "A membership oracle for ANY uid (\"is uid X active in org Y?\"), callable with the public anon key. Its only caller is user_is_effective_owner, a SECURITY DEFINER function owned by postgres that keeps calling it as its owner; no app .rpc( call, no policy, no SECURITY INVOKER function names it. 20261217 leaves EXECUTE to service_role only." },
  { signature: "mfg_dedup_stats()", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20260807_dedup_stats_fn.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/admin/storage-stats/route.ts." },
  { signature: "mfg_storage_estimate()", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261008_storage_estimate_knowledge.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/admin/storage-stats/route.ts." },
  { signature: "mfg_table_stats()", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20260805_storage_stats_fn.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/admin/purge/route.ts, app/api/admin/storage-stats/route.ts, lib/storageUsage.ts." },
  { signature: "my_org_ids()", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 22 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "my_project_ids()", decision: "own-scope-unused", execute: { anon: true, authenticated: true, service_role: true }, reason: "Returns only the caller's own ids (it reads auth.uid()); an anon caller gets an empty set. No live policy, function or app .rpc( call uses it any more, so it can neither leak nor be needed; kept as recorded, not revoked." },
  { signature: "my_team_ids()", decision: "own-scope-unused", execute: { anon: true, authenticated: true, service_role: true }, reason: "Returns only the caller's own ids (it reads auth.uid()); an anon caller gets an empty set. No live policy, function or app .rpc( call uses it any more, so it can neither leak nor be needed; kept as recorded, not revoked." },
  { signature: "next_ticket_number(uuid,integer)", decision: "signed-in-rpc", execute: { anon: false, authenticated: true, service_role: true }, reason: "lib/ticketNumber.ts and app/api/tickets/create/route.ts call it with a signed-in member's JWT; the body refuses a caller with no active membership (auth.uid()), so a signed-out call never worked. 20261217 revokes PUBLIC and anon and grants authenticated and service_role by name." },
  { signature: "node_visible(text,jsonb,uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 5 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It reads no caller-supplied person: visibility is decided for auth.uid() (through the caller-scoped helpers it calls), so with no session it answers false." },
  { signature: "node_visible(text,jsonb,uuid,uuid,uuid,uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 5 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It reads no caller-supplied person: visibility is decided for auth.uid() (through the caller-scoped helpers it calls), so with no session it answers false." },
  { signature: "notifications_i_sent(uuid,text,timestamp with time zone,text,text,jsonb)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261191_notif_roundG_kind_split.sql); the body judges the signed-in caller. Named by the app: lib/schemaExpectations.ts, lib/sentNotices.ts." },
  { signature: "org_capability_allows(uuid,text,uuid)", decision: "policy-helper-oracle", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 4 row-level-security policies written for every role, so anon and authenticated must be able to execute it (a REVOKE would turn an empty answer into a 42501 error for every such read). It takes p_uid — the person to judge — rather than reading auth.uid(), so anyone holding the public anon key can ask it about another person's authority given the uuids.", owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)" },
  { signature: "org_capability_allows_for(uuid,text,uuid,jsonb)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261137_intel_roundG_ai_manage_caps.sql); the body judges the signed-in caller. No app call site names it today." },
  { signature: "post_ticket_comment(uuid,jsonb,uuid[],uuid[])", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261166_df_roundG_ticket_rails.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/tickets/comment/route.ts." },
  { signature: "project_org(uuid)", decision: "policy-helper-oracle", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 6 policies written for every role, so the roles they judge must execute it. It maps any project id to its org id for any caller — a small oracle (a project uuid is unguessable and the org id discloses no row).", owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)" },
  { signature: "project_regulated_record_count(uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261103_prj_roundG_project_closeout_rails.sql: REVOKE … FROM PUBLIC, anon, authenticated). No app call site names it today (other definer functions or the SQL editor call it)." },
  { signature: "project_visible_to_me(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 16 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "prune_removed_member_acl_index(uuid,uuid,uuid[],uuid[],text,uuid,integer)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261204_ao_roundG_revoke_member_acl_prune.sql); the body judges the signed-in caller. Named by the app: lib/memberAclIndexPrune.ts, lib/schemaExpectations.ts." },
  { signature: "publish_revision(uuid,uuid,text,jsonb,uuid,text,boolean,boolean,text,text,boolean,text)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261151_dc_roundF_promote_transaction_and_hold_override.sql); the body judges the signed-in caller. Named by the app: app/api/intake/upload/route.ts, lib/postPublish.ts, lib/revisions.ts." },
  { signature: "quality_other_signers(uuid,uuid,uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261136_prj_roundG_quality_signoff.sql: REVOKE … FROM PUBLIC, anon, authenticated). No app call site names it today (other definer functions or the SQL editor call it)." },
  { signature: "quality_signer_eligible(uuid,uuid,uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261136_prj_roundG_quality_signoff.sql: REVOKE … FROM PUBLIC, anon, authenticated). No app call site names it today (other definer functions or the SQL editor call it)." },
  { signature: "quality_signoff_granted(uuid,uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261136_prj_roundG_quality_signoff.sql); the body judges the signed-in caller. Called inside 4 policies." },
  { signature: "quality_signoff_granted_for(uuid,uuid,uuid)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261136_prj_roundG_quality_signoff.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: app/api/admin/capability-policy/route.ts." },
  { signature: "quality_signoff_status(uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261136_prj_roundG_quality_signoff.sql); the body judges the signed-in caller. Named by the app: components/permissions/PermissionsExplorer.tsx, lib/checklists.ts." },
  { signature: "rename_codebook_code(uuid,text,text,text,boolean,jsonb)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261178_intel_roundG_codebook_lifecycle.sql); the body judges the signed-in caller. Named by the app: app/api/admin/codebook/route.ts, lib/schemaExpectations.ts." },
  { signature: "reopen_project(uuid,text)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261103_prj_roundG_project_closeout_rails.sql); the body judges the signed-in caller. Named by the app: lib/projects.ts." },
  { signature: "return_departed_member_tickets(uuid,uuid,text)", decision: "service-only", execute: { anon: false, authenticated: false, service_role: true }, reason: "EXECUTE for service_role only (20261195_df_roundG_outcome_and_departure.sql: REVOKE … FROM PUBLIC, anon, authenticated). Named by the server code: lib/ticketDepartureBackstop.ts." },
  { signature: "revoke_member(uuid,text)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261204_ao_roundG_revoke_member_acl_prune.sql); the body judges the signed-in caller. Named by the app: app/(protected)/admin/users/page.tsx, lib/members.ts." },
  { signature: "revup_rollback_orphan(uuid,uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261027_dc_phase1_unguarded_doors.sql); the body judges the signed-in caller. No app call site names it today." },
  { signature: "set_project_baseline(uuid,uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261099_prj_roundG_baseline_authority.sql); the body judges the signed-in caller. Named by the app: lib/milestones.ts." },
  { signature: "supersession_writable(uuid,uuid,uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261131_dc_roundF_documents_rails.sql); the body judges the signed-in caller. Called inside 2 policies." },
  { signature: "ticket_mentions_me(uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261166_df_roundG_ticket_rails.sql); the body judges the signed-in caller. Called inside 1 policies." },
  { signature: "transfer_project_ownership(uuid,uuid,text)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261102_prj_roundG_project_rails.sql); the body judges the signed-in caller. Named by the app: lib/projects.ts." },
  { signature: "user_can_publish_doc(uuid,uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 2 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
  { signature: "user_can_publish_on_library(uuid,text,uuid)", decision: "policy-helper-oracle", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 5 row-level-security policies written for every role, so anon and authenticated must be able to execute it (a REVOKE would turn an empty answer into a 42501 error for every such read). It takes p_uid — the person to judge — rather than reading auth.uid(), so anyone holding the public anon key can ask it about another person's authority given the uuids. Also named by the app: app/api/intake/upload/route.ts, app/api/links/invalidate/route.ts, lib/documentShares.ts, lib/shareServe.ts.", owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)" },
  { signature: "user_download_denied(jsonb,uuid,uuid)", decision: "signed-in", execute: { anon: false, authenticated: true, service_role: true }, reason: "anon and PUBLIC revoked, authenticated keeps EXECUTE (20261140_dc_roundF_share_download_deny_rail.sql); the body judges the signed-in caller. Named by the app: lib/documentShares.ts." },
  { signature: "user_is_effective_owner(uuid,uuid,uuid,uuid)", decision: "policy-helper-oracle", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 5 row-level-security policies written for every role, so anon and authenticated must be able to execute it (a REVOKE would turn an empty answer into a 42501 error for every such read). It takes p_uid — the person to judge — rather than reading auth.uid(), so anyone holding the public anon key can ask it about another person's authority given the uuids. Also named by the app: app/api/links/invalidate/route.ts, app/api/storage/download-url/route.ts, lib/docFileServer.ts, lib/ownership.ts, lib/revisions.ts.", owner: "projects-and-cost INTK-19 (the integrator, to route to roles-and-permissions)" },
  { signature: "user_owns_project(uuid)", decision: "policy-helper", execute: { anon: true, authenticated: true, service_role: true }, reason: "Called inside 10 row-level-security policies written for every role, so anon and authenticated must be able to execute it — a REVOKE would turn an empty answer into a 42501 error for every such read. It judges the caller (auth.uid(), directly or through the caller-scoped helpers it calls) and answers false / empty with no session, so the anon key learns nothing from it." },
];
