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
  "statements",
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
  "unit_models",
  "unit_model_versions",

  // Collaboration + audit + notifications
  "teams",
  "team_members",
  "notes",
  "audit_logs",
  "email_notifications",
  "notifications",

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
] as const;

/** User-scoped tables exported alongside (membership in this org acts as
 *  the join — we only include rows for users who belong to the org). */
export const USER_SCOPED_FOR_ORG_TABLES = ["notification_preferences", "push_subscriptions"] as const;

/** Tables that exist in the schema but are DELIBERATELY not exported.
 *  Each needs a reason — the coverage tripwire enforces the decision. */
export const EXPORT_EXCLUDED_TABLES: Record<string, string> = {
  users: "global auth identity — never copied; members re-link by email on restore",
};
