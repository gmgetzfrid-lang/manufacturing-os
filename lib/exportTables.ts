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
  "work_package_prints",
  "distribution_acks",

  // Access + cost tracking. access_requests has carried org_id since
  // 20261023 (BKP-4 / DEC-75: it stays exported — a pending request is the
  // org's own record of who asked in).
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
  "turnover_review_events", // QUAL-11: append-only review history (nonconformance events) — evidence, exported
  "punch_items",

  // Projects + schedule
  "projects",
  "project_members",
  "project_documents",
  "project_activity",
  "markup_requests",
  "document_markups", // GAP-7 / DEC-24: viewer markup per (document, version, user) — evidence, exported
  "milestones",
  "milestone_notes",
  "milestone_baseline_history", // projects Round G / SCHED-3: every prior approved-plan snapshot — the record, exported

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

/** BKP-4: the ORG_SCOPED_TABLES entries with NO `org_id` column. Every other
 *  entry is dumped `.eq("org_id", <org>)`; on these that read fails (42703)
 *  and the whole backup was stamped INCOMPLETE with the table empty — project
 *  rosters and curated-collection contents never reached a backup. Each is
 *  read by its own key instead: `orgs` by its id (the workspace row itself),
 *  an org-less child through its parent's ids (the parent is exported first,
 *  by org_id, so only this workspace's children are read). The restore binds
 *  the same two children to a parent in the target workspace
 *  (lib/dataRestore.ts ORG_LESS_RESTORE_PARENTS, DEC-75);
 *  lib/__tests__/exportCoverage.test.ts fails when a table without org_id is
 *  listed above with no entry here, or an entry here has gained org_id. */
export const EXPORT_KEYED_BY: Record<string, { column: string; parent?: string; reason: string }> = {
  orgs: { column: "id", reason: "the workspace row itself — its primary key IS the org id" },
  project_members: { column: "project_id", parent: "projects", reason: "the project roster carries no org_id; read through this workspace's projects" },
  curated_collection_items: { column: "collection_id", parent: "curated_collections", reason: "a curated collection's contents carry no org_id; read through this workspace's curated collections" },
};

/** User-scoped tables exported alongside (membership in this org acts as
 *  the join — we only include rows for users who belong to the org). */
export const USER_SCOPED_FOR_ORG_TABLES = ["notification_preferences"] as const;

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
  intake_attempts:
    "the contractor intake door's rate-limit window (hashed token, client IP; 20261105) — a two-day rolling anti-abuse log, service-role only, no customer data; nothing to restore",
  verify_scans:
    "the public verify endpoints' per-scan record and rate window (endpoint, target UUID, verdict shown, client IP / user agent; 20261134) — a 90-day rolling log keyed on IP, not org-scoped, service-role only; nothing to restore",
  push_subscriptions:
    "per-device Web Push credentials (endpoint, p256dh, auth) — secrets never leave the database, and a push registration is machine-specific and never restored; each device re-subscribes",
  orchestrator_proposals:
    "the assistant's pending write proposals (tool, parameters, fingerprint; 20261147) — confirmable for 15 minutes, service-role only, pruned once a week past expiry (daily cron and each store); the permanent record is audit_logs (AI_ACTION_ATTEMPTED before an action runs, then AI_ACTION_EXECUTED or AI_ACTION_FAILED), which is exported. A restored proposal must never become runnable again",
  document_share_accesses:
    "per-access IP / user-agent trail behind a share link's counter (P1 SHARE, 20261081) — service-role written, controller-readable; the exported distribution record of what LEFT is download_audits; a restored share is revoked (DEC-45) so its access trail has nothing to attach to",
};

/** EGR-7 / XEDGE-10: columns whose VALUE is a live credential. The same rule
 *  that keeps `ai_connections` out of the backup applies per column here —
 *  secrets never leave the database. Every export nulls these columns
 *  (`redactRow`, applied by dumpTable), the manifest and README list them, and
 *  the restore never reinstates them (lib/dataRestore.ts `scrubRestoredRow`):
 *  a share, intake link or portal link in a backup is re-issued, never
 *  revived, and an export destination comes back with its credentials to be
 *  re-entered. lib/__tests__/exportCoverage.test.ts censuses every exported
 *  table for token / secret / api_key / password / *_encrypted columns, so a
 *  future bearer column cannot ship un-redacted. */
export const REDACT_COLUMNS: Record<string, { columns: readonly string[]; reason: string }> = {
  document_shares: {
    columns: ["token"],
    reason: "the sole credential for /share/<token> — an unexpired share in an old backup would otherwise stay live forever; re-issue shares after a restore",
  },
  project_intake_links: {
    // SEC-19 (20261141): the token is stored only as its SHA-256 — the value
    // the door matches a presented token against — and a six-character
    // prefix. Reinstating the hash from a backup would revive the link, so
    // all three columns are the credential (a restored link arrives REVOKED
    // with an unguessable placeholder token, which the database hashes).
    columns: ["token", "token_hash", "token_prefix"],
    reason: "a WRITE credential — it lets the holder submit versions through /api/intake/*; the database matches a presented token by token_hash, so the hash (and its prefix) is redacted with it; re-issue intake links after a restore",
  },
  transmittals: {
    columns: ["portal_token"],
    reason: "the sole credential for the external transmittal portal; a restored issued transmittal arrives VOIDED (the insert rail would otherwise mint a fresh token) and a new transmittal is issued to send again",
  },
  export_destinations: {
    columns: ["access_key_id_encrypted", "secret_access_key_encrypted", "webhook_secret_encrypted"],
    reason: "bucket / webhook credentials encrypted under the deployment-wide key — a restore into another workspace on the same deployment would decrypt them (confused deputy); re-enter credentials after a restore",
  },
};

/** The redacted columns of `table` (empty for a table that declares none). */
export function redactedColumnsFor(table: string): readonly string[] {
  return REDACT_COLUMNS[table]?.columns ?? [];
}

/** Null every redacted column of a `table` row. Pure; returns a new object
 *  and leaves a table with no redaction map byte-identical. */
export function redactRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const cols = redactedColumnsFor(table);
  if (cols.length === 0) return row;
  const out: Record<string, unknown> = { ...row };
  for (const c of cols) if (c in out) out[c] = null;
  return out;
}
