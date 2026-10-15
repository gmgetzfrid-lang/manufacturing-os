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
  // File finder — what people SAY vs what files SAY, and pasted drive
  // listings (paths only). Taught by document control; not re-derivable.
  "finder_aliases",
  "finder_listings",
  // One Estate — derived and declared relationships with provenance
  // (folder→unit, project→unit, also-filed-under). Human decisions live here.
  "estate_edges",
  "estate_run_changes",
  // Skills — the org's authored detectors and answer disciplines. Pure
  // human knowledge (names, patterns, packs, sharing); not re-derivable.
  "link_rules",
  "answer_skills",
  // The plant's flow topology — human-confirmed edges; not re-derivable.
  "process_flows",
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
  "change_orders",

  // Known companies registry (contractor/vendor scorecards + safety log)
  "companies",
  "company_events",

  // Quality program (checklists, turnover packages, punch lists)
  "project_checklists",
  "checklist_items",
  "turnover_items",
  "punch_items",

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
  // The chat: conversations, their turns (answers with citations, tool
  // steps, proposals), and each asker's standing profile. Org knowledge
  // the team reads back — not re-derivable.
  "chat_threads",
  "chat_messages",
  "chat_user_profiles",

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
  signup_attempts:
    "global anti-abuse log keyed on client IP (not org-scoped) — rolling rate-limit window with no customer data; nothing to restore",
  // THOR — a metadata index of the refinery NAS, copied in from the THOR
  // Indexer's own database by scripts/thor_import.py. Nothing in it is
  // authored here; restore by re-running the import against that database.
  ...Object.fromEntries(
    ["thor_roots", "thor_crawls", "thor_directories", "thor_files", "thor_entities", "thor_aliases",
      "thor_alias_entities", "thor_file_entities", "thor_relationships", "thor_doc_families",
      "thor_doc_members", "thor_identifiers", "thor_evidence", "thor_issues", "thor_lexemes"].map((t) => [t,
      "THOR NAS index (paths, sizes, dates, indexer inferences) — copied from the THOR Indexer's database, never authored here; restore by re-running scripts/thor_import.py"]),
  ),
};
