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
  // intelligence I-26 (20261235, GAP-307 acceptance 3) — a knowledge upload's
  // own document↔equipment relation, with document_assets' provenance
  // columns (asserted_by, model, source revision). EXPORTED, by the
  // integrator at the I-26 merge (2026-10-20, DEC-90): GAP-303 acceptance 4
  // holds that provenance survives export and restore. Restored after
  // knowledge_documents and assets (lib/dataRestore.ts). No bearer column.
  "knowledge_document_assets",
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
  // drafting-flow DF-P5 (20261242): a routed ticket's reviewer roster and its
  // append-only event log — exported as evidence; never blind-imported
  // (lib/dataRestore.ts IMMUTABLE_TABLES; the integrator at the DF-P5 merge,
  // 2026-10-21, DEC-90).
  "ticket_review_slots",
  "ticket_review_slot_events",
  // drafting-flow DF-P7 (20261255): the consent-window and not-emailed notice
  // record — append-only, service-role written; exported as evidence, never
  // imported (lib/dataRestore.ts IMMUTABLE_TABLES; the integrator at the DF-P7
  // merge, 2026-10-21, DEC-90). PRIVACY (DEC-90 ruling (6), the DF-P7
  // merge-time fix pass): a 'not_emailed' row's details.reason is a
  // member's own email-preference reason — it is stripped from every such
  // row on the way out (EXPORT_ROW_TRANSFORMS below, applied by dumpTable);
  // every other row of this table, and every other table, is exported
  // byte-for-byte as before.
  "ticket_notice_events",
  // document-control Round G P38 (DIST-19, 20261257): the append-only
  // document notice record (who was reminded / escalated about a review
  // sign-off, an acknowledgment or a distribution ack, and when) — EXPORTED
  // as evidence, a 'not_emailed' row's details.reason stripped exactly as for
  // ticket_notice_events (EXPORT_ROW_TRANSFORMS below); never imported (the
  // integrator at the P38 merge, 2026-10-21, DEC-90).
  "document_notice_events",
  // drafting-flow DF-P6 (20261251): the equipment a request names (the tag as
  // typed and the registry asset it resolved to) — part of the request,
  // exported and restored after tickets and assets (the integrator at the
  // DF-P6 merge, 2026-10-21, DEC-90).
  "ticket_equipment",
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
  // public-surfaces PS-P9 (20261237) — the per-print sheet tokens: org-scoped,
  // a one-way SHA-256 of each printed sheet's 192-bit token plus the print,
  // the document and the version (no scannable code — the token itself is
  // never stored). INCLUDED, by the integrator at the PS-P9 merge
  // (2026-10-20, DEC-90), and restored after document_versions so a pack
  // sheet printed before a restore keeps its verdict; token_hash is not a
  // bearer column (exportCoverage.test.ts BEARER_NAME_EXCEPTIONS).
  "print_sheet_tokens",

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

/** intelligence ILIFE-6 (the export half): the export pages every table in
 *  a STABLE, UNIQUE order, so no row is read twice or skipped between pages.
 *  A table pages by `id` (keyset: `id > last`, so a concurrent delete can
 *  never move a page); the exported tables with no `id` column are listed
 *  here with their PRIMARY KEY / UNIQUE key — a one-column key pages by
 *  keyset too, a composite key pages ordered by every key column.
 *  lib/__tests__/exportCoverage.test.ts fails when an exported table has
 *  neither an `id` column nor an entry here, or an entry is not one of the
 *  table's keys. */
export const EXPORT_ORDER_KEYS: Record<string, readonly string[]> = {
  archive_settings: ["org_id"],
  codebook_config: ["org_id"],
  curated_collection_items: ["collection_id", "document_id"],
  document_equipment_suggestions: ["org_id", "document_id"],
  document_favorites: ["user_id", "document_id"],
  library_numbering: ["library_id"],
  notification_preferences: ["user_id"],
  recently_viewed_docs: ["user_id", "document_id"],
  team_members: ["team_id", "uid"],
  ticket_number_counters: ["org_id", "year"],
};

/** The columns the export orders `table` by (see EXPORT_ORDER_KEYS). */
export function exportOrderKey(table: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(EXPORT_ORDER_KEYS, table) ? EXPORT_ORDER_KEYS[table] : ["id"];
}

/** intelligence ILIFE-11: columns a table is exported WITHOUT. Every other
 *  table is read `select("*")`; a table listed here is read with an explicit
 *  column list (`select`) that leaves the `omit` columns out, so their values
 *  never reach the envelope, the ZIP or a destination. The manifest names
 *  each omitted column with its reason (manifest.omittedColumns and a note).
 *  lib/__tests__/exportCoverage.test.ts fails when `select` is not exactly
 *  the table's columns in the census of supabase/ less `omit` — a column a
 *  later migration adds fails the build until it is listed here, so the
 *  explicit list can never silently drop one.
 *
 *  knowledge_chunks.embedding: one 1024-dimension vector per chunk, written
 *  as text by PostgREST (on the order of 15–20 KB a row), was inlined into
 *  every backup. It is derived, not authored: every restored chunk arrives
 *  with embedding NULL, in the queue embed_claim_batch claims from, and
 *  keyword search works at once. The meaning index does NOT rebuild by
 *  itself: the embed drain (lib/knowledgeEmbedDrain.ts) spends only on a
 *  consent stamped on the library (ai_features.embedBuild), a finished
 *  build's stamp is cleared at 100%, and a stamp whose payer is not an
 *  active member of the restored workspace is released unspent. Meaning
 *  search comes back when someone starts a meaning-index Build on each
 *  library, on their own embedding key (lib/__tests__/
 *  intelRoundGChunkExport.test.ts drives the drain over a restore).
 *
 *  `reset`: columns exported with a fixed value because they described the
 *  omitted one, on a row that carried it. `resetWhenAny` names the columns
 *  that say the row carried it: the reset applies only when one of them is
 *  non-null on the row as read. For knowledge_chunks that is embedding_model
 *  (read on both paths) or embedding (present on the select("*") fallback):
 *  the embed writer sets both together (lib/knowledgeEmbedCore.ts writeBack)
 *  and the Rebuild clears both together (app/api/knowledge/embed/route.ts).
 *  The drain's state on an embedded chunk (embed_attempts, embed_error,
 *  embed_claimed_until, embed_retry_after) is about the vector that is left
 *  out: a chunk that embedded on its last allowed try would otherwise be
 *  restored with embed_attempts one short of the cap, and the next Build's
 *  first transient provider error would refuse it for good. Each is exported
 *  as the column's default (0 / NULL), so a restored chunk starts the queue
 *  fresh. A chunk that never had a vector keeps its state as it is: a
 *  passage the provider refused for good (embed_attempts at the cap, with
 *  its error) stays refused and keeps the reason, instead of coming back as
 *  pending and spending more tries on someone's key. Applied only to a
 *  column the row has (a database without it yet gains nothing). */
export const EXPORT_OMITTED_COLUMNS: Record<string, { omit: readonly string[]; select: readonly string[]; reset: Readonly<Record<string, unknown>>; resetWhenAny: readonly string[]; reason: string }> = {
  knowledge_chunks: {
    omit: ["embedding"],
    select: [
      "id", "org_id", "library_id", "document_id", "page", "seq", "section", "content", "tsv",
      "embedding_model", "embed_attempts", "embed_error", "embed_claimed_until", "embed_retry_after",
      "source", "source_model",
    ],
    reset: { embed_attempts: 0, embed_error: null, embed_claimed_until: null, embed_retry_after: null },
    resetWhenAny: ["embedding_model", "embedding"],
    reason:
      "the semantic-search vector (1024 numbers per passage) is derived from the passage text and is not exported. " +
      "After a restore, keyword search works at once; meaning search stays off for the restored passages until someone starts a " +
      "meaning-index Build on each library, which re-embeds them on that person's own embedding key (their own AI spend). " +
      "Nothing re-embeds them automatically. Each embedded passage's embedding retry state (embed_attempts, embed_error, " +
      "embed_claimed_until, embed_retry_after) is exported reset to its default, since it described the vector left out; " +
      "a passage that never had a vector keeps its state, so one the provider refused stays refused with its reason",
  },
};

/** The PostgREST select list the export reads `table` with: "*", or the
 *  explicit column list of a table that omits columns (ILIFE-11). */
export function exportSelectFor(table: string): string {
  return Object.prototype.hasOwnProperty.call(EXPORT_OMITTED_COLUMNS, table) ? EXPORT_OMITTED_COLUMNS[table].select.join(", ") : "*";
}

/** Drop every omitted column of a `table` row, and, on a row that carried
 *  the omitted value (a `resetWhenAny` column non-null), set each `reset`
 *  column the row has to its declared value (ILIFE-11). Pure; returns a new
 *  object, and leaves a table with no omissions byte-identical. Applied to
 *  every row read, so a row read `select("*")` (the fallback when the
 *  explicit list names a column the database does not have yet) carries no
 *  omitted value and no stale state either. */
export function omitExportColumns(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(EXPORT_OMITTED_COLUMNS, table)) return row;
  const entry = EXPORT_OMITTED_COLUMNS[table];
  const carried = entry.resetWhenAny.some((c) => row[c] !== undefined && row[c] !== null);
  const out: Record<string, unknown> = { ...row };
  for (const c of entry.omit) delete out[c];
  if (carried) for (const [c, v] of Object.entries(entry.reset)) if (Object.prototype.hasOwnProperty.call(out, c)) out[c] = v;
  return out;
}

/** User-scoped tables exported alongside (membership in this org acts as
 *  the join — we only include rows for users who belong to the org). */
export const USER_SCOPED_FOR_ORG_TABLES = ["notification_preferences"] as const;

/** Tables that exist in the schema but are DELIBERATELY not exported.
 *  Each needs a reason — the coverage tripwire enforces the decision. */
export const EXPORT_EXCLUDED_TABLES: Record<string, string> = {
  audit_dead_letters:
    "the audit dead-letter outbox (an audit row whose insert was refused, kept as its writer sent it; admin-and-org P13, 20261219) — service-role only, a transient queue the daily maintenance cron drains into audit_logs as AUDIT_DEAD_LETTER rows, which are exported; a restored outbox would replay another deployment's recovered rows into this deployment's trail",
  users: "global auth identity — never copied; members re-link by email on restore",
  ai_connections:
    "holds live AI provider API keys — secrets never leave the database; reconnect providers after a restore",
  platform_settings:
    "deployment-wide settings (hosting-plan storage ceilings) — not org data; re-set on the storage page after a restore",
  knowledge_line_traces:
    "cached AI line traces over drawing sheets — regenerated on demand from the drawings themselves; no authored data lives here",
  signup_attempts:
    "the two public sign-up doors' per-IP rate-limit window (client IP and the address typed at the door; 20261010) — personal data about people who may never have joined, not org-scoped, kept two days (prune_signup_attempts, run daily by the maintenance cron — ORG-12), service-role only; never exported, nothing to restore",
  intake_attempts:
    "the contractor intake door's rate-limit window (hashed token, client IP; 20261105) — a two-day rolling anti-abuse log, service-role only, no customer data; nothing to restore",
  verify_scans:
    "the public verify endpoints' per-scan record and rate window (endpoint, target UUID, verdict shown, client IP / user agent; 20261134) — a 90-day rolling log keyed on IP, not org-scoped, service-role only; nothing to restore",
  push_subscriptions:
    "per-device Web Push credentials (endpoint, p256dh, auth) — secrets never leave the database, and a push registration is machine-specific and never restored; each device re-subscribes",
  orchestrator_proposals:
    "the assistant's pending write proposals (tool, parameters, fingerprint; 20261147) — confirmable for 15 minutes, service-role only, pruned once a week past expiry (daily cron and each store); the permanent record is audit_logs (AI_ACTION_ATTEMPTED before an action runs, then AI_ACTION_EXECUTED or AI_ACTION_FAILED), which is exported. A restored proposal must never become runnable again",
  mention_index_runs:
    "intelligence I-23 (20261194): the mention index's run state (last build, last failure, a stopped rebuild's place) — operational, re-derived by the next build, and it names knowledge-document ids a restore re-keys; a restore starts with none",
  document_share_accesses:
    "per-access IP / user-agent trail behind a share link's counter (P1 SHARE, 20261081) — service-role written, controller-readable; the exported distribution record of what LEFT is download_audits; a restored share is revoked (DEC-45) so its access trail has nothing to attach to",
  stripe_events:
    "the Stripe webhook's delivery ledger (event id, type, Stripe's created time, subscription / customer ids, outcome; admin-and-org P4, 20261175) — service-role only, a duplicate and ordering guard for Stripe's deliveries to this deployment, not org data; the billing record is the exported STRIPE_* audit_logs rows, and a restored ledger would make another deployment treat Stripe's events as already handled",
  stripe_event_locks:
    "the Stripe webhook's one-event-per-customer lock (customer id, the delivery holding it, when; admin-and-org P4, 20261175) — service-role only, a row lives only while a delivery runs (60-second lease), not org data; nothing to restore",
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

/** DEC-90 ruling (6) (DF-P7 merge-time fix pass): the narrowest per-table
 *  row transform the export applies after redaction — for a field inside a
 *  JSON column that is private on SOME rows, where nulling the whole column
 *  (REDACT_COLUMNS) would lose the evidence the table is exported for. A
 *  table with no entry is never touched (its rows pass through as the same
 *  objects). The restore never imports these tables. Each `reason` is a
 *  manifest note, kept ASCII (the JSON route's byte count is pinned). */
const stripNotEmailedReason = (row: Record<string, unknown>): Record<string, unknown> => {
  if (row.kind !== "not_emailed") return row;
  const d = row.details;
  if (!d || typeof d !== "object" || Array.isArray(d) || !Object.prototype.hasOwnProperty.call(d, "reason")) return row;
  const details = { ...(d as Record<string, unknown>) };
  delete details.reason;
  return { ...row, details };
};

export const EXPORT_ROW_TRANSFORMS: Record<string, { reason: string; apply: (row: Record<string, unknown>) => Record<string, unknown> }> = {
  ticket_notice_events: {
    reason: "a 'not_emailed' row's details.reason is the member's own email-preference reason (why their preference turned the email off), private to them; the row itself (who was not emailed, when, for which request) is exported, its reason left out",
    apply: stripNotEmailedReason,
  },
  document_notice_events: {
    reason: "a 'not_emailed' row's details.reason is the member's own email-preference reason, private to them; the row itself (who was not emailed, when, for which document) is exported, its reason left out",
    apply: stripNotEmailedReason,
  },
};

/** Apply `table`'s export row transform (EXPORT_ROW_TRANSFORMS), or return
 *  the row itself — the same object — for a table that declares none. Pure. */
export function transformExportRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(EXPORT_ROW_TRANSFORMS, table)) return row;
  return EXPORT_ROW_TRANSFORMS[table].apply(row);
}

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
