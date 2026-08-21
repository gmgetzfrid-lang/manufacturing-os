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
// Generated from supabase/migrations (CREATE TABLE scan) + curated column
// probes for feature-critical ALTERs. When a new migration creates a table,
// add it here — the health panel is only as honest as this list.

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

export const EXPECTED_TABLES: readonly TableExpectation[] = [
  { table: "access_recertification_events", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "access_requests", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "ai_connections", migration: "20260911_knowledge_ai.sql" },
  { table: "ai_key_agreements", migration: "20260916_ai_governance.sql" },
  { table: "ai_usage_events", migration: "20260806_ai_usage_events.sql" },
  { table: "ai_usage_limits", migration: "20260916_ai_governance.sql" },
  { table: "archive_settings", migration: "20260808_archive_foundation.sql" },
  { table: "archives", migration: "20260808_archive_foundation.sql" },
  { table: "asset_aliases", migration: "20260807_link_proposals.sql" },
  { table: "asset_files", migration: "20260626_asset_files.sql" },
  { table: "asset_photos", migration: "20260603_asset_registry.sql" },
  { table: "asset_types", migration: "20260603_asset_registry.sql" },
  { table: "assets", migration: "20260603_asset_registry.sql" },
  { table: "checkout_episodes", migration: "20260729_checkout_episodes.sql" },
  { table: "checkout_messages", migration: "20260620_checkout_activity_thread.sql" },
  { table: "codebook_config", migration: "20260928_site_codebook.sql" },
  { table: "codebook_entries", migration: "20260928_site_codebook.sql" },
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
  { table: "document_related_resources", migration: "20260806_intelligence_layer.sql" },
  { table: "document_review_events", migration: "20260630_review_cycles.sql" },
  { table: "document_review_signoffs", migration: "20260818_review_before_publish.sql" },
  { table: "document_shares", migration: "20260623_document_shares.sql" },
  { table: "document_supersessions", migration: "20260526_supersede_archive.sql" },
  { table: "drawing_audit_logs", migration: "20260929_mention_engine.sql" },
  { table: "e_signatures", migration: "20260720_e_signatures.sql" },
  { table: "email_notifications", migration: "20260529_phase_b_notifications.sql" },
  { table: "entity_mentions", migration: "20260929_mention_engine.sql" },
  { table: "export_destinations", migration: "20260530_data_export_schedules.sql" },
  { table: "export_runs", migration: "20260530_data_export_schedules.sql" },
  { table: "knowledge_chunks", migration: "20260911_knowledge_ai.sql" },
  { table: "knowledge_documents", migration: "20260911_knowledge_ai.sql" },
  { table: "knowledge_libraries", migration: "20260911_knowledge_ai.sql" },
  { table: "knowledge_library_links", migration: "20260915_knowledge_links.sql" },
  { table: "knowledge_page_entities", migration: "20260921_drawing_entities.sql" },
  { table: "knowledge_questions", migration: "20260911_knowledge_ai.sql" },
  { table: "knowledge_sources", migration: "20260917_knowledge_sources.sql" },
  { table: "library_numbering", migration: "20260806_intelligence_layer.sql" },
  { table: "library_views", migration: "20260602_documents_library_super.sql" },
  { table: "markup_requests", migration: "20260527_projects_and_collaboration.sql" },
  { table: "milestone_notes", migration: "20260705_milestones_execution_richdata.sql" },
  { table: "milestones", migration: "20260614_phase7_milestones.sql" },
  { table: "notes", migration: "20260617_phase9_notes.sql" },
  { table: "notification_preferences", migration: "20260529_phase_b_notifications.sql" },
  { table: "notifications", migration: "20260621_in_app_notifications.sql" },
  { table: "org_ai_instructions", migration: "20260806_intelligence_layer.sql" },
  { table: "output_generations", migration: "20260923_output_templates.sql" },
  { table: "output_templates", migration: "20260923_output_templates.sql" },
  { table: "plants", migration: "20260606_operational_entity_graph.sql" },
  { table: "platform_settings", migration: "20260920_per_user_keys_real_limits.sql" },
  { table: "plot_plans", migration: "20260719_plot_plans_and_whiteboard.sql" },
  { table: "project_activity", migration: "20260527_projects_and_collaboration.sql" },
  { table: "project_documents", migration: "20260609_phase1_normalization.sql" },
  { table: "project_intake_links", migration: "20260902_project_intake.sql" },
  { table: "project_members", migration: "20260527_projects_and_collaboration.sql" },
  { table: "project_parties", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "projects", migration: "20260527_projects_and_collaboration.sql" },
  { table: "proposed_links", migration: "20260807_link_proposals.sql" },
  { table: "push_subscriptions", migration: "20260804_push_subscriptions.sql" },
  { table: "recently_viewed_docs", migration: "20260806_intelligence_layer.sql" },
  { table: "revision_branches", migration: "20260823_publish_contract.sql" },
  { table: "signup_attempts", migration: "20261010_signup_rate_limit.sql" },
  { table: "sla_defaults", migration: "20260529_phase_b_notifications.sql" },
  { table: "statements", migration: "20260819_orphan_tables_backfill.sql" },
  { table: "subscriptions", migration: "20260622_subscriptions.sql" },
  { table: "systems", migration: "20260606_operational_entity_graph.sql" },
  { table: "team_members", migration: "20260707_teams.sql" },
  { table: "teams", migration: "20260707_teams.sql" },
  { table: "ticket_comments", migration: "20260726_ticket_comments.sql" },
  { table: "ticket_number_counters", migration: "20260724_ticket_numbering.sql" },
  { table: "transmittals", migration: "20260717_transmittals.sql" },
  { table: "units", migration: "20260606_operational_entity_graph.sql" },
  { table: "work_package_documents", migration: "20260825_work_packages_acks.sql" },
  { table: "work_packages", migration: "20260825_work_packages_acks.sql" },
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
];
