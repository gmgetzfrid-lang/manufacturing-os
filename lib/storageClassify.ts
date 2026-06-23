// lib/storageClassify.ts
//
// Classifies every table into one of three buckets so the Storage dashboard can
// answer the only two questions that matter for cost: "what can I purge without
// a second thought?" and "what must I keep (and eventually archive off-box)?".
//
//   purge     — disposable byproducts. Deleting old rows frees space, no records lost.
//   archive   — REAL records. Never delete; keep recent hot, move old to cold/local.
//   reference — small config/lookup data. Keep hot; negligible size.
//
// The `reason` strings are shown verbatim as the dashboard's flag tooltips.

export type DataClass = "purge" | "archive" | "reference";

export interface TableClass {
  category: DataClass;
  /** Plain-English why — surfaced as the hover tooltip. */
  reason: string;
  /** True for tables that grow without bound and are the first to bite. */
  grower?: boolean;
}

const TABLE_CLASS: Record<string, TableClass> = {
  // ── Purge worry-free — disposable, not records ───────────────────────────
  notifications: {
    category: "purge", grower: true,
    reason: "In-app bell alerts. Disposable — once read and older than ~90 days they have no value. Safe to purge.",
  },
  email_notifications: {
    category: "purge", grower: true,
    reason: "Outbound email queue. Each row is a send attempt; disposable once sent. Safe to purge old rows.",
  },
  ai_usage_events: {
    category: "purge",
    reason: "AI call meter rows. Useful recent, disposable after a while. Safe to purge old rows.",
  },

  // ── Archive — records: keep, never delete; archive old/cold ──────────────
  audit_logs: {
    category: "archive", grower: true,
    reason: "Compliance audit trail. Grows fastest of all (one row per view/download/action) and is legally retained — keep, but archive the high-volume VIEW/DOWNLOAD noise off the hot DB after 90 days.",
  },
  download_audits: {
    category: "archive", grower: true,
    reason: "Who downloaded what, with which watermark. High volume; a record. Archive old rows, keep a thin index.",
  },
  checkout_messages: {
    category: "archive", grower: true,
    reason: "Per-checkout collaboration threads. Append-only and high volume; archive closed episodes to cold storage.",
  },
  checkout_episodes: {
    category: "archive",
    reason: "Checkout activity history (a record). Archive once the episode is closed and aged.",
  },
  checkout_sessions: {
    category: "archive",
    reason: "Editing-session lock history. The lasting record is in audit_logs; old closed sessions can be archived.",
  },
  documents: {
    category: "archive",
    reason: "Core document records. Keep the row (it's tiny + the search index); archive only the superseded binaries.",
  },
  document_versions: {
    category: "archive", grower: true,
    reason: "Immutable revision history. Keep recent revisions hot; archive old binaries (metadata + checksum always stay).",
  },
  tickets: {
    category: "archive", grower: true,
    reason: "Drafting-request records. The size-per-row is a fixable DESIGN issue: history/comments/attachments live in JSONB inside the row, so the row is rewritten and bloats on every action. Moving them to child rows (ticket_comments already exists) flattens it.",
  },
  ticket_comments: {
    category: "archive",
    reason: "Ticket comment history (a record). Archive with the ticket once closed and aged.",
  },
  transmittals: {
    category: "archive",
    reason: "Formal document-distribution records — contractual/regulatory evidence. Keep.",
  },
  e_signatures: {
    category: "archive",
    reason: "Approval signatures — immutable compliance proof. Keep forever.",
  },
  document_holds: {
    category: "archive",
    reason: "Operational hold history (SLA-relevant). Keep; archive long after release.",
  },
  milestones: {
    category: "archive",
    reason: "Schedule records. Keep; archive with completed projects.",
  },
  milestone_notes: {
    category: "archive",
    reason: "Milestone activity log. Archive with the project.",
  },
  notes: {
    category: "archive",
    reason: "Scratchpad records. Archive resolved notes after a while.",
  },
  assets: {
    category: "archive",
    reason: "Equipment records. Keep.",
  },
  asset_photos: {
    category: "archive", grower: true,
    reason: "Equipment photo gallery. Superseded photos accumulate — the binaries in R2 are the real cost; archive superseded.",
  },
  project_documents: {
    category: "archive",
    reason: "Project↔document traceability (a record). Archive with completed projects.",
  },
  project_activity: {
    category: "archive",
    reason: "Project feed. Not compliance-critical; archive after the project completes.",
  },
  markup_requests: {
    category: "archive",
    reason: "Markup-request threads. Archive once resolved and aged.",
  },
  cost_entries: { category: "archive", reason: "Cost records. Keep." },
  cost_accounts: { category: "archive", reason: "Cost-account records. Keep." },
  cost_documents: { category: "archive", reason: "Cost-document links. Keep." },
  plot_plans: { category: "archive", reason: "P&ID/layout images (a record). Keep; the image binary is the cost." },
};

/** Classify a table. Anything unlisted is small config/lookup — keep hot. */
export function classifyTable(name: string): TableClass {
  return (
    TABLE_CLASS[name] ?? {
      category: "reference",
      reason: "Configuration / reference / lookup data. Small and bounded — keep hot; not a cost concern.",
    }
  );
}

export const CATEGORY_LABEL: Record<DataClass, string> = {
  purge: "Purge worry-free",
  archive: "Keep & archive",
  reference: "Reference (keep hot)",
};
