// lib/schemaExpectations.ts
//
// The contract between the code and the database it assumes. Migrations are
// applied BY HAND in the Supabase SQL editor (no CLI pipeline yet), and much
// of lib/ tolerates missing tables by silently returning empty — which is
// exactly how a feature ships, deploys green, and renders an empty panel in
// production because migration N was never pasted in. This list makes that
// failure VISIBLE: /api/admin/schema-health probes every expectation and
// names the migration file that supplies anything missing.
//
// EXPECTED_TABLES is every table supabase/schema.sql and the numbered
// migrations create (a scan of CREATE TABLE statements, comments stripped —
// admin-and-org BKP-14 removed the phantom `statements` row an earlier scan
// had read out of a header comment, and added the tables it had missed),
// less the RETIRED_TABLES a later migration drops. EXPECTED_COLUMNS and
// EXPECTED_FUNCTIONS are curated probes for feature-critical ALTERs and RPCs.
// lib/__tests__/schemaExpectations.test.ts is the tripwire, both ways: a
// created table with no row here fails the suite (REL-7), and so does a row
// whose named file does not create it (BKP-14).

export interface TableExpectation {
  table: string;
  migration: string;
}

/** Feature-critical columns added by later ALTERs — presence of the table
 *  alone doesn't prove these landed. */
export interface ColumnExpectation {
  table: string;
  column: string;
  migration: string;
  feature: string;
}

/** A database function a route calls through PostgREST (`rpc`). Its table's
 *  presence proves nothing about it — public-surfaces SHR-12: a database
 *  without 20261081 resolves every share link with a counter RPC that does
 *  not exist, and nothing said so. `probeArgs` must make the call unable to
 *  RUN the body: a value the parameter's type refuses (22P02), so PostgREST
 *  resolves the function (PGRST202 when it is missing) and Postgres rejects
 *  the argument before executing anything. */
export interface FunctionExpectation {
  /** The function name and its argument types, as the panel names it. */
  signature: string;
  fn: string;
  probeArgs: Record<string, unknown>;
  migration: string;
  feature: string;
}

/** A table a migration created and a LATER migration dropped on purpose. Not
 *  probed (it must not exist); listed so the tripwire can tell a retirement
 *  from a forgotten row. */
export interface RetiredTable {
  table: string;
  createdBy: string;
  droppedBy: string;
  reason: string;
}

export const EXPECTED_TABLES: readonly TableExpectation[] = [
  { table: "access_recertification_events", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "access_requests", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "ai_connections", migration: "20260911_knowledge_ai.sql" },
  { table: "ai_key_agreements", migration: "20260916_ai_governance.sql" },
  { table: "ai_usage_events", migration: "20260806_ai_usage_events.sql" },
  { table: "ai_usage_limits", migration: "20260916_ai_governance.sql" },
  { table: "answer_skills", migration: "20261016_reasoning_skills.sql" },
  { table: "archive_settings", migration: "20260808_archive_foundation.sql" },
  { table: "archives", migration: "20260808_archive_foundation.sql" },
  { table: "asset_aliases", migration: "20260807_link_proposals.sql" },
  { table: "asset_files", migration: "20260626_asset_files.sql" },
  { table: "asset_photos", migration: "20260603_asset_registry.sql" },
  { table: "asset_types", migration: "20260603_asset_registry.sql" },
  { table: "assets", migration: "20260603_asset_registry.sql" },
  { table: "audit_logs", migration: "schema.sql (base schema)" },
  { table: "change_orders", migration: "20261013_project_controls_program.sql" },
  { table: "checklist_items", migration: "20261013_project_controls_program.sql" },
  { table: "checkout_episodes", migration: "20260729_checkout_episodes.sql" },
  { table: "checkout_messages", migration: "20260620_checkout_activity_thread.sql" },
  { table: "checkout_sessions", migration: "schema.sql (base schema)" },
  { table: "codebook_config", migration: "20260928_site_codebook.sql" },
  { table: "codebook_entries", migration: "20260928_site_codebook.sql" },
  { table: "collections", migration: "schema.sql (base schema)" },
  { table: "companies", migration: "20261013_project_controls_program.sql" },
  { table: "company_events", migration: "20261013_project_controls_program.sql" },
  { table: "cost_accounts", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "cost_documents", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "cost_entries", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "curated_collection_items", migration: "20260602_documents_library_super.sql" },
  { table: "curated_collections", migration: "20260602_documents_library_super.sql" },
  { table: "distribution_acks", migration: "20260825_work_packages_acks.sql" },
  { table: "document_acknowledgments", migration: "20260817_read_understood.sql" },
  { table: "document_assets", migration: "20260609_phase1_normalization.sql" },
  { table: "document_disposition_events", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "document_equipment_suggestions", migration: "20260928_site_codebook.sql" },
  { table: "document_favorites", migration: "20260602_documents_library_super.sql" },
  { table: "document_holds", migration: "20260612_phase5_holds.sql" },
  { table: "document_intents", migration: "20260824_document_intents.sql" },
  { table: "document_markups", migration: "20261051_rp_phase7_markup_store.sql" },
  { table: "document_related_resources", migration: "20260806_intelligence_layer.sql" },
  { table: "document_review_events", migration: "20260630_review_cycles.sql" },
  { table: "document_review_signoffs", migration: "20260818_review_before_publish.sql" },
  { table: "document_sets", migration: "schema.sql (base schema)" },
  { table: "document_shares", migration: "20260623_document_shares.sql" },
  { table: "document_share_accesses", migration: "20261081_dc_roundF_share_access_log.sql" },
  { table: "document_supersessions", migration: "20260526_supersede_archive.sql" },
  { table: "document_versions", migration: "schema.sql (base schema)" },
  { table: "documents", migration: "schema.sql (base schema)" },
  { table: "download_audits", migration: "schema.sql (base schema)" },
  { table: "drawing_audit_logs", migration: "20260929_mention_engine.sql" },
  { table: "e_signatures", migration: "20260720_e_signatures.sql" },
  { table: "email_notifications", migration: "20260529_phase_b_notifications.sql" },
  { table: "entity_mentions", migration: "20260929_mention_engine.sql" },
  { table: "export_destinations", migration: "20260530_data_export_schedules.sql" },
  { table: "export_runs", migration: "20260530_data_export_schedules.sql" },
  { table: "intake_attempts", migration: "20261105_prj_roundG_intake_review_and_attempts.sql" },
  { table: "knowledge_chunks", migration: "20260911_knowledge_ai.sql" },
  { table: "knowledge_documents", migration: "20260911_knowledge_ai.sql" },
  { table: "knowledge_libraries", migration: "20260911_knowledge_ai.sql" },
  { table: "knowledge_library_links", migration: "20260915_knowledge_links.sql" },
  { table: "knowledge_page_entities", migration: "20260921_drawing_entities.sql" },
  { table: "knowledge_questions", migration: "20260911_knowledge_ai.sql" },
  { table: "knowledge_sources", migration: "20260917_knowledge_sources.sql" },
  { table: "libraries", migration: "schema.sql (base schema)" },
  { table: "library_numbering", migration: "20260806_intelligence_layer.sql" },
  { table: "library_views", migration: "20260602_documents_library_super.sql" },
  { table: "link_rules", migration: "20261015_connection_skills.sql" },
  { table: "markup_requests", migration: "20260527_projects_and_collaboration.sql" },
  { table: "metadata_templates", migration: "schema.sql (base schema)" },
  { table: "milestone_baseline_history", migration: "20261099_prj_roundG_baseline_authority.sql" },
  { table: "milestone_notes", migration: "20260705_milestones_execution_richdata.sql" },
  { table: "milestones", migration: "20260614_phase7_milestones.sql" },
  { table: "notes", migration: "20260617_phase9_notes.sql" },
  { table: "notification_preferences", migration: "20260529_phase_b_notifications.sql" },
  { table: "notifications", migration: "20260621_in_app_notifications.sql" },
  { table: "orchestrator_proposals", migration: "20261147_intel_roundG_orchestrator_proposals.sql" },
  { table: "org_ai_instructions", migration: "20260806_intelligence_layer.sql" },
  // The capability policy + drafting config live here. schema.sql supplies it
  // (not a migration) — listed so /api/admin/schema-health catches the class
  // of drift that made the whole capability layer inert (WF-1/DB-1).
  { table: "org_configurations", migration: "schema.sql (base schema)" },
  { table: "org_members", migration: "schema.sql (base schema)" },
  { table: "orgs", migration: "schema.sql (base schema)" },
  { table: "output_generations", migration: "20260923_output_templates.sql" },
  { table: "output_templates", migration: "20260923_output_templates.sql" },
  { table: "plants", migration: "20260606_operational_entity_graph.sql" },
  { table: "platform_settings", migration: "20260920_per_user_keys_real_limits.sql" },
  { table: "plot_plans", migration: "20260719_plot_plans_and_whiteboard.sql" },
  { table: "process_flows", migration: "20261017_process_flows.sql" },
  { table: "project_activity", migration: "20260527_projects_and_collaboration.sql" },
  { table: "project_checklists", migration: "20261013_project_controls_program.sql" },
  { table: "project_documents", migration: "20260609_phase1_normalization.sql" },
  { table: "project_intake_links", migration: "20260902_project_intake.sql" },
  { table: "project_members", migration: "20260527_projects_and_collaboration.sql" },
  { table: "project_parties", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "projects", migration: "20260527_projects_and_collaboration.sql" },
  { table: "proposed_links", migration: "20260807_link_proposals.sql" },
  { table: "punch_items", migration: "20261013_project_controls_program.sql" },
  { table: "push_subscriptions", migration: "20260804_push_subscriptions.sql" },
  { table: "recently_viewed_docs", migration: "20260806_intelligence_layer.sql" },
  { table: "revision_branches", migration: "20260823_publish_contract.sql" },
  { table: "signup_attempts", migration: "20261010_signup_rate_limit.sql" },
  { table: "sla_defaults", migration: "20260529_phase_b_notifications.sql" },
  { table: "subscriptions", migration: "20260622_subscriptions.sql" },
  { table: "systems", migration: "20260606_operational_entity_graph.sql" },
  { table: "table_views", migration: "schema.sql (base schema)" },
  { table: "team_members", migration: "20260707_teams.sql" },
  { table: "teams", migration: "20260707_teams.sql" },
  { table: "ticket_comments", migration: "20260726_ticket_comments.sql" },
  { table: "ticket_number_counters", migration: "20260724_ticket_numbering.sql" },
  { table: "tickets", migration: "schema.sql (base schema)" },
  { table: "transmittals", migration: "20260717_transmittals.sql" },
  { table: "turnover_items", migration: "20261013_project_controls_program.sql" },
  { table: "turnover_review_events", migration: "20261091_prj_roundG_quality_rails.sql" },
  { table: "units", migration: "20260606_operational_entity_graph.sql" },
  { table: "users", migration: "schema.sql (base schema)" },
  { table: "verify_scans", migration: "20261134_ps_roundF_verify_scans.sql" },
  { table: "watermark_policies", migration: "schema.sql (base schema)" },
  { table: "work_package_documents", migration: "20260825_work_packages_acks.sql" },
  { table: "work_package_prints", migration: "20261028_work_package_prints.sql" },
  { table: "work_packages", migration: "20260825_work_packages_acks.sql" },
];

/** BKP-14 / intelligence IRLS-12: dropped on purpose — never probed. */
export const RETIRED_TABLES: readonly RetiredTable[] = [
  {
    table: "knowledge_line_traces",
    createdBy: "20261007_line_traces.sql",
    droppedBy: "20261007_retire_line_traces.sql",
    reason: "cached AI line traces, retired with the feature — the table must NOT exist",
  },
];

export const EXPECTED_COLUMNS: readonly ColumnExpectation[] = [
  { table: "transmittals", column: "portal_token", migration: "20260910_transmittal_portal.sql", feature: "Transmittal recipient portal + issue emails" },
  { table: "ai_connections", column: "embedding_api_key", migration: "20260930_semantic_layer.sql", feature: "Meaning-based (semantic) search" },
  { table: "knowledge_chunks", column: "embedding", migration: "20260930_semantic_layer.sql", feature: "pgvector semantic index" },
  { table: "documents", column: "ai_excluded", migration: "20260807_link_proposals.sql", feature: "Per-document AI exclusion (Pillar A)" },
  { table: "checkout_sessions", column: "auto_expires_at", migration: "20260527_projects_and_collaboration.sql", feature: "24h ad-hoc checkout cap" },
  { table: "checkout_sessions", column: "outcome", migration: "20261012_doc_class_and_checkin_outcomes.sql", feature: "Check-in outcome register (field verification, MOC trail)" },
  { table: "documents", column: "doc_class", migration: "20261012_doc_class_and_checkin_outcomes.sql", feature: "Document classes — PSM MOC gate + drafting routing for drawings" },
  { table: "libraries", column: "doc_class", migration: "20261012_doc_class_and_checkin_outcomes.sql", feature: "Library-level document class declaration" },
  { table: "access_requests", column: "org_id", migration: "20261023_access_requests_scope_and_limit.sql", feature: "Org-scoped access requests (admin pending list, per-org isolation)" },
  // Found absent in the live DB on 2026-09-01 by 20261038's late-binding probe
  // (the archive migrations were never hand-applied); repaired by 20261039.
  // The ticket triggers reference these, so their absence breaks every client
  // ticket write — schema-health must shout, not the trigger.
  { table: "tickets", column: "closed_at", migration: "20260811_ticket_closed_at.sql (repair: 20261039)", feature: "Ticket close clock — archive eligibility; workflow close writes it" },
  { table: "tickets", column: "archived_at", migration: "20260809_ticket_archive.sql (repair: 20261039)", feature: "Closed-ticket archival (ticket-shed)" },
  { table: "tickets", column: "archive_id", migration: "20260809_ticket_archive.sql (repair: 20261039)", feature: "Closed-ticket archival (ticket-shed)" },
  { table: "tickets", column: "deliverable_rev", migration: "20260827_ticket_deliverable_rev.sql (repair: 20261039)", feature: "Autonomous deliverable revision labels" },
  { table: "tickets", column: "draft_iteration", migration: "20260827_ticket_deliverable_rev.sql (repair: 20261039)", feature: "Autonomous deliverable revision labels" },
  { table: "tickets", column: "engineer_review_reason", migration: "20260528_engineer_review_routing.sql (repair: 20261039)", feature: "Engineer routing (scoped review, final approval)" },
  // REL-7: the project-controls program. Without these rows a database that
  // never received 20261013 reported healthy while the Costs and Quality
  // tabs rendered empty, cheerful screens.
  { table: "cost_documents", column: "rfq_group", migration: "20261013_project_controls_program.sql", feature: "Bid tabulation — quotes grouped per RFQ" },
  { table: "cost_documents", column: "intake_link_id", migration: "20261013_project_controls_program.sql", feature: "Quotes submitted through a vendor intake link" },
  { table: "project_intake_links", column: "purpose", migration: "20261013_project_controls_program.sql", feature: "Quote intake links (purpose = quote)" },
  { table: "project_intake_links", column: "rfq_group", migration: "20261013_project_controls_program.sql", feature: "Quote intake links tied to an RFQ group" },
  { table: "cost_entries", column: "created_by_name", migration: "20261013_project_controls_program.sql", feature: "Cost ledger — who posted each entry" },
  // admin-and-org ALOG-1 Done-when 4: the column the capability policy is
  // read from and written to (lib/capabilityPolicy.ts `.select("data")`).
  // The policy layer once read a `value` column that never existed and ran
  // every org on shipped defaults; this names the column the code reads.
  { table: "org_configurations", column: "data", migration: "schema.sql (base schema)", feature: "Capability policy, per-person grants, branding and drafting config (the column lib/capabilityPolicy.ts reads)" },
  // intelligence GOV-4 Done-when 3: the AI spend ledger's read
  // (lib/ai/usageServer.ts USAGE_COLUMNS) needs these four 20260916 columns;
  // without them the ledger read fails and EVERY AI call is refused.
  { table: "ai_usage_events", column: "est_cost_usd", migration: "20260916_ai_governance.sql", feature: "AI spend ledger — the cap gate's cost (every AI call is refused without it)" },
  { table: "ai_usage_events", column: "input_tokens", migration: "20260916_ai_governance.sql", feature: "AI spend ledger — prompt tokens" },
  { table: "ai_usage_events", column: "output_tokens", migration: "20260916_ai_governance.sql", feature: "AI spend ledger — reply tokens" },
  { table: "ai_usage_events", column: "model", migration: "20260916_ai_governance.sql", feature: "AI spend ledger — the model each call was priced at" },
  // intelligence I-19 (ORCH-9 criterion 3): until it is pasted the assistant
  // stores proposals without the flag and its cards carry no note.
  { table: "orchestrator_proposals", column: "tainted", migration: "20261158_intel_roundG_orchestrator_taint.sql", feature: "Assistant proposals flagged when suggested after reading document text" },
  { table: "knowledge_questions", column: "context", migration: "20261153_intel_roundG_ask_answer_context.sql", feature: "Library answers record what reached the model (a teammate sees a stored answer only when they may read every document in it)" },
  // intelligence I-09 (IEDGE-8): until it is pasted every dismissal is settled.
  { table: "process_flows", column: "source_version_id", migration: "20261155_intel_roundG_process_flows_authority.sql", feature: "Process flows — the revision a PFD proposal was read from (a dismissal binds that reading; IEDGE-8)" },
];

export const EXPECTED_FUNCTIONS: readonly FunctionExpectation[] = [
  // public-surfaces SHR-12 Done-when 4. "schema-health-probe" is not a uuid:
  // the call resolves the function and stops at 22P02 — no counter moves.
  {
    signature: "bump_share_access(uuid)",
    fn: "bump_share_access",
    probeArgs: { p_share: "schema-health-probe" },
    migration: "20261081_dc_roundF_share_access_log.sql",
    feature: "Share-link access counter (/api/share/resolve)",
  },
];
