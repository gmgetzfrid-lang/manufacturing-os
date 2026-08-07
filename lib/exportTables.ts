// lib/exportTables.ts
//
// THE coverage contract for the full-org backup. Every table in supabase/
// (schema.sql + migrations) must appear in exactly one of these lists —
// exported org-scoped, exported user-scoped, or deliberately excluded with a
// written reason. lib/__tests__/exportCoverage.test.ts diffs these lists
// against the actual CREATE TABLE statements on every test run, so adding a
// table without deciding its backup fate FAILS THE BUILD instead of silently
// shipping an incomplete backup.
//
// Kept dependency-free (no supabase/aws imports) so tests and tooling can
// import it without side effects.

/** Org-scoped tables, dumped by `org_id`. If it holds customer data, it's here. */
export const ORG_SCOPED_TABLES = [
  // Site codebook — the org's numbering language + the drawing→equipment
  // bridge's review state. Small, precious, absolutely worth backing up.
  "codebook_entries",
  "codebook_config",
  "document_equipment_suggestions",
  // Intelligence layer — org playbooks, ask memory, curated links, numbering.
  "org_ai_instructions",
  "document_related_resources",
  "recently_viewed_docs",
  "library_numbering",
  // Link discovery — proposals (incl. the dismissal memory) and the
  // equipment nicknames a normalizer can't derive.
  "proposed_links",
  "asset_aliases",
  // Mentions are mostly re-derivable by re-running the indexer, but not all
  // of them: is_explicit rows are human decisions, and a restore that
  // silently dropped them would lose links nobody can reconstruct.
  "entity_mentions",
  // Audit memory. Losing it doesn't lose data, it loses the knowledge that
  // the work was already done — every sheet gets re-audited from scratch.
  "drawing_audit_logs",
  // Document control
  "documents",
  "document_versions",
  "document_supersessions",
  "document_holds",
  "document_assets",
  "document_sets",
  "document_shares",
  "project_intake_links",
  "document_favorites",
  "e_signatures",
  "transmittals",
  "libraries",
  "collections",
  "curated_collections",
  "curated_collection_items",
  "library_views",
  "metadata_templates",
  "watermark_policies",
  "plot_plans",
  "download_audits",

  // Doc-control compliance (ack signatures, review sign-offs, review cycles,
  // retention dispositions, access recertifications)
  "document_acknowledgments",
  "document_review_signoffs",
  "document_review_events",
  "document_disposition_events",
  "access_recertification_events",

  // Workflow / drafting
  "tickets",
  "ticket_comments",
  "ticket_number_counters",
  "checkout_sessions",
  "checkout_episodes",
  "checkout_messages",

  // Checkout redesign (publish contract + ambient signals)
  "document_intents",
  "revision_branches",

  // Field distribution (work packages, acknowledged hand-offs)
  "work_packages",
  "work_package_documents",
  "distribution_acks",

  // Access + cost tracking
  "access_requests",
  "cost_accounts",
  "cost_documents",
  "cost_entries",
  "project_parties",

  // Projects + schedule
  "projects",
  "project_members",
  "project_documents",
  "project_activity",
  "markup_requests",
  "milestones",
  "milestone_notes",

  // Equipment + operational scope
  "assets",
  "asset_types",
  "asset_photos",
  "asset_files",
  "plants",
  "units",
  "systems",

  // Collaboration + audit + notifications
  "teams",
  "team_members",
  "notes",
  "audit_logs",
  "email_notifications",
  "notifications",

  // AI knowledge libraries (searchable reference shelves + Q&A log)
  "knowledge_libraries",
  "knowledge_library_links",
  "knowledge_sources",
  "knowledge_documents",
  "knowledge_chunks",
  "knowledge_page_entities",
  "knowledge_questions",
  // The purpose interview's answers and every later edit to them. Small,
  // and it is the only record of what a human taught the library about
  // itself — the UI reads it for the "you changed this" badges.
  "knowledge_profile_history",
  // Compiled reference vocabularies (symbol keys, line keys, abbreviation
  // lists, schedules). The compile is re-runnable, but the REVIEW is not:
  // every confirmed/corrected entry is a human decision over a legend cell,
  // and gap dismissals are decisions too. Backed up in full.
  "knowledge_vocabularies",
  "knowledge_vocabulary_sources",
  "knowledge_vocabulary_bindings",
  "knowledge_vocabulary_entries",
  "knowledge_vocabulary_gaps",

  // Output templates (document production: template + example + fill spec)
  "output_templates",
  "output_generations",

  // Archives (the offline-zip catalog + where they're kept)
  "archives",
  "archive_settings",

  // Org configuration + billing history
  "orgs",
  "org_members",
  "org_configurations",
  "table_views",
  "sla_defaults",
  "export_destinations",
  "export_runs",
  "subscriptions",
  "ai_usage_events",
  "ai_key_agreements",
  "ai_usage_limits",
] as const;

/** User-scoped tables exported alongside (membership in this org acts as
 *  the join — we only include rows for users who belong to the org). */
export const USER_SCOPED_FOR_ORG_TABLES = ["notification_preferences", "push_subscriptions"] as const;

/** Tables that exist in the schema but are DELIBERATELY not exported.
 *  Each needs a reason — the coverage tripwire enforces the decision. */
export const EXPORT_EXCLUDED_TABLES: Record<string, string> = {
  users: "global auth identity — never copied; members re-link by email on restore",
  ai_connections:
    "holds live AI provider API keys — secrets never leave the database; reconnect providers after a restore",
  platform_settings:
    "deployment-wide settings (hosting-plan storage ceilings) — not org data; re-set on the storage page after a restore",
  knowledge_line_traces:
    "cached AI line traces over drawing sheets — regenerated on demand from the drawings themselves; no authored data lives here",
};
