// lib/dataRestore.ts
//
// Restore / re-import planner — the reconciliation brain for bringing a client
// back from a backup (Machine B). PURE + deterministic so it can be unit-tested
// without a database: given a backup envelope and the CURRENT workspace's
// context it produces a RestorePlan the admin previews and approves BEFORE any
// write happens.
//
// Principles (from the product spec):
//   • Users are ADDITIVE BY EMAIL — an email already in the workspace re-links
//     to the existing person; an unknown email becomes an inactive "restored"
//     placeholder (no paid seat) to be re-invited. Auth creds are never restored.
//   • ORG-NAME COLLISIONS ("Acme" vs "Acme Inc.") are surfaced for the admin to
//     choose — never auto-merged.
//   • Old IDs are REMAPPED to the current workspace (org_id always; uid per the
//     email reconciliation) so foreign keys land correctly.
//   • Nothing is trusted blindly: incomplete backups and missing files surface
//     as warnings.

export interface RestoreEnvelopeLike {
  manifest: {
    orgId: string;
    orgName?: string;
    schemaVersion?: string;
    complete?: boolean;
    files?: { count?: number; missing?: number };
  };
  tables: Record<string, unknown[]>;
  files?: Array<{ path: string }>;
}

export interface CurrentMember { uid: string; email: string }
export interface CurrentOrgContext {
  orgId: string;
  orgName: string;
  /** Active members of the target workspace (the join key is email). */
  members: CurrentMember[];
}

export type UserDisposition = "linked" | "new";
export interface UserReconcileItem {
  oldUid: string;
  email: string;
  displayName?: string;
  role?: string;
  disposition: UserDisposition;
  /** Present when disposition === "linked": the existing workspace uid. */
  newUid?: string;
}

export interface TablePlanItem {
  name: string;
  rows: number;
  willImport: boolean;
  reason?: string;
}

export interface RestorePlan {
  schemaVersion?: string;
  targetOrgId: string;
  /** Non-null when the backup's org name differs from the current one — the
   *  admin must pick which to keep. */
  orgNameCollision: { backupName: string; currentName: string } | null;
  users: UserReconcileItem[];
  idRemap: {
    /** Always maps the backup org_id → the current workspace org_id. */
    orgId: Record<string, string>;
    /** old uid → existing uid, for emails already in the workspace. New users
     *  get their uid at apply time (not known until the row is created). */
    uid: Record<string, string>;
  };
  counts: {
    matchedUsers: number;
    newUsers: number;
    totalRows: number;
    files: number;
    tables: TablePlanItem[];
  };
  warnings: string[];
}

const norm = (s: string | undefined | null) => (s ?? "").trim().toLowerCase();

// Tables never imported by blind insert — identity/auth/config is handled by
// reconciliation, not copied over the top of the live workspace.
const SKIP_TABLES: Record<string, string> = {
  orgs: "target workspace already exists; org name is reconciled separately",
  org_members: "membership is rebuilt from the user reconciliation",
  users: "user profiles are created via the additive-by-email reconciliation",
  notification_preferences: "per-user settings are re-established on re-invite",
  subscriptions: "billing state is owned by the payment provider — re-subscribe, never copy",
  push_subscriptions: "device push registrations are machine-specific — re-established per device",
};

interface BackupMember { uid?: string; email?: string; display_name?: string; role?: string }

/** Build the reconciliation plan for restoring `env` into `current`. Pure. */
export function planRestore(env: RestoreEnvelopeLike, current: CurrentOrgContext): RestorePlan {
  const warnings: string[] = [];
  const backupOrgId = env.manifest.orgId;
  const targetOrgId = current.orgId;

  // ── Org-name collision ──────────────────────────────────────────────────
  const backupName = (env.manifest.orgName ?? "").trim();
  const currentName = (current.orgName ?? "").trim();
  const orgNameCollision =
    backupName && currentName && norm(backupName) !== norm(currentName)
      ? { backupName, currentName }
      : null;

  // ── User reconciliation (additive by email) ─────────────────────────────
  const existingByEmail = new Map<string, string>(); // email -> uid
  for (const m of current.members) {
    if (m.email) existingByEmail.set(norm(m.email), m.uid);
  }

  const members = (env.tables.org_members as BackupMember[] | undefined) ?? [];
  const seenEmail = new Set<string>();
  const users: UserReconcileItem[] = [];
  for (const m of members) {
    const email = norm(m.email);
    if (!email || seenEmail.has(email)) continue; // dedupe by email
    seenEmail.add(email);
    const existing = existingByEmail.get(email);
    users.push({
      oldUid: m.uid ?? "",
      email: (m.email ?? "").trim(),
      displayName: m.display_name,
      role: m.role,
      disposition: existing ? "linked" : "new",
      newUid: existing,
    });
  }

  const idRemap = {
    orgId: { [backupOrgId]: targetOrgId } as Record<string, string>,
    uid: {} as Record<string, string>,
  };
  for (const u of users) {
    if (u.disposition === "linked" && u.oldUid && u.newUid) idRemap.uid[u.oldUid] = u.newUid;
  }

  // ── Per-table import plan ────────────────────────────────────────────────
  const tables: TablePlanItem[] = [];
  let totalRows = 0;
  for (const [name, rows] of Object.entries(env.tables)) {
    const n = Array.isArray(rows) ? rows.length : 0;
    const skip = SKIP_TABLES[name];
    tables.push({ name, rows: n, willImport: !skip, reason: skip });
    if (!skip) totalRows += n;
  }
  tables.sort((a, b) => b.rows - a.rows);

  // ── Warnings ─────────────────────────────────────────────────────────────
  if (env.manifest.complete === false) {
    warnings.push("This backup was marked INCOMPLETE — some tables were not exported. Restoring it will not fully reconstruct the workspace.");
  }
  const missing = env.manifest.files?.missing ?? 0;
  if (missing > 0) {
    warnings.push(`${missing} referenced file(s) had no binary in the backup and cannot be restored.`);
  }
  if (orgNameCollision) {
    warnings.push(`Org name differs: backup "${orgNameCollision.backupName}" vs current "${orgNameCollision.currentName}". Choose which to keep before applying.`);
  }
  if (users.length === 0) {
    warnings.push("No members found in the backup (org_members empty) — users cannot be reconciled.");
  }

  const matchedUsers = users.filter((u) => u.disposition === "linked").length;

  return {
    schemaVersion: env.manifest.schemaVersion,
    targetOrgId,
    orgNameCollision,
    users,
    idRemap,
    counts: {
      matchedUsers,
      newUsers: users.length - matchedUsers,
      totalRows,
      files: env.files?.length ?? env.manifest.files?.count ?? 0,
      tables,
    },
    warnings,
  };
}

/** Apply the org/uid remap to a single row. Returns a new row object; never
 *  mutates the input. Used by the apply path (one place, tested here) so
 *  remapping is consistent across every table.
 *
 *  The uid remap is applied to EVERY string value in the row — top-level
 *  columns AND deep inside JSONB (ack rosters' assigneeIds, review-control
 *  reviewer lists, draft-viewer lists, unread_by arrays, audit details).
 *  The schema has 30+ user-reference columns (owner_user_id,
 *  supervisor_user_id, checked_out_by, signer_user_id, …) plus uid arrays
 *  inside policy JSONB — an allowlist provably rots (it had 14 of 30+).
 *  Old uids are UUIDs, so a value-equality match can't collide with
 *  ordinary text; anything not in the map passes through untouched. */
export function remapRow(
  row: Record<string, unknown>,
  idRemap: RestorePlan["idRemap"],
): Record<string, unknown> {
  const uidMap = idRemap.uid;
  // Storage keys embed the org id ("orgs/<orgId>/libraries/…"). When restoring
  // into a different workspace, those path strings must follow the org remap or
  // every restored file_url points at a prefix the new workspace can't touch.
  const orgPairs = Object.entries(idRemap.orgId).filter(([o, n]) => o && n && o !== n);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "org_id" && typeof v === "string" && idRemap.orgId[v]) {
      out[k] = idRemap.orgId[v];
    } else {
      out[k] = deepRemapValues(v, uidMap, orgPairs);
    }
  }
  return out;
}

/** Rewrite "orgs/<oldOrg>/…" storage-path prefixes to the new org. Exported so
 *  the put-files-back flow applies the SAME rule to zip entry keys. */
export function remapOrgPath(value: string, orgPairs: Array<[string, string]>): string {
  let s = value;
  for (const [oldOrg, newOrg] of orgPairs) {
    const needle = `orgs/${oldOrg}/`;
    if (s.includes(needle)) s = s.split(needle).join(`orgs/${newOrg}/`);
  }
  return s;
}

function deepRemapValues(value: unknown, uidMap: Record<string, string>, orgPairs: Array<[string, string]>): unknown {
  if (typeof value === "string") {
    const mapped = uidMap[value];
    if (mapped) return mapped;
    return orgPairs.length ? remapOrgPath(value, orgPairs) : value;
  }
  if (Array.isArray(value)) return value.map((v) => deepRemapValues(v, uidMap, orgPairs));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepRemapValues(v, uidMap, orgPairs);
    }
    return out;
  }
  return value;
}

/** True when `table` is one the restore never blind-imports. */
export function isSkippedTable(table: string): boolean {
  return table in SKIP_TABLES;
}

// User-reference columns across the schema — DOCUMENTATION of what the deep
// remap covers (the implementation matches by value, not by column name, so
// this list can't silently rot the way an allowlist did).
export const UID_COLUMNS = [
  "uid", "user_id", "created_by", "updated_by", "actor_user_id", "assigned_to",
  "triggered_by", "to_user_id", "reviewer_id", "owner_id", "approved_by",
  "checked_by", "drawn_by", "invited_by", "owner_user_id", "supervisor_user_id",
  "checked_out_by", "signer_user_id", "reviewer_user_id", "assignee_user_id",
  "requested_by_user_id", "requested_from_user_id", "released_by", "resolved_by",
  "revoked_by", "waived_by", "performed_by", "status_marked_by", "opened_by",
  "completed_by", "archived_by", "added_by", "assigned_by", "uploaded_by",
  "author_uid", "unread_by", "recipient_user_id", "requested_by",
  "requester_id", "assigned_drafter_id", "assigned_engineer_id", "watchers",
] as const;

// FK-dependency order for inserting on restore: parents before children, so a
// child row never references a parent that isn't in yet. Tables not listed are
// appended after (they're leaves or self-contained).
export const RESTORE_TABLE_ORDER: string[] = [
  "archive_settings", "archives",
  "libraries", "collections", "curated_collections",
  "metadata_templates", "watermark_policies",
  "plants", "units", "systems",
  // Codebook before assets/documents: entries carry no FKs beyond org, and
  // restored assets/suggestions read cleaner with the vocabulary in place.
  "codebook_entries", "codebook_config",
  "asset_types", "assets", "asset_photos",
  "teams", "team_members",
  "projects", "project_members",
  "documents", "document_versions", "document_supersessions",
  "document_holds", "document_assets", "document_sets", "document_shares",
  "document_equipment_suggestions",
  // Intelligence layer: instructions/numbering have no doc FKs (early is
  // fine); related/recents/asks reference documents so they come after.
  "org_ai_instructions", "library_numbering",
  "document_related_resources", "recently_viewed_docs",   "project_intake_links",
  "document_favorites", "e_signatures", "transmittals",
  "document_intents", "revision_branches",
  "work_packages", "work_package_documents", "distribution_acks",
  "document_acknowledgments", "document_review_signoffs", "document_review_events",
  "document_disposition_events", "access_recertification_events",
  "asset_files",
  "curated_collection_items", "library_views", "plot_plans",
  "project_documents", "project_activity",
  "milestones", "milestone_notes",
  "ticket_number_counters", "tickets", "ticket_comments",
  "checkout_sessions", "checkout_episodes", "checkout_messages",
  "markup_requests", "notes", "download_audits",
  "audit_logs", "notifications", "email_notifications",
  "table_views", "sla_defaults", "org_configurations",
  "export_destinations", "export_runs", "ai_usage_events",
  "ai_key_agreements", "ai_usage_limits",
  "access_requests",
  "project_parties",
  "cost_accounts", "cost_documents", "cost_entries",
  "knowledge_libraries", "knowledge_library_links", "knowledge_sources",
  "knowledge_documents", "knowledge_chunks", "knowledge_page_entities",
  "knowledge_questions",
  "output_templates", "output_generations",
];

// Conflict target per table for the additive upsert. Most tables have a plain
// `id` primary key; the ones listed here use composite (or differently-named)
// keys — upserting them on "id" errors and breaks re-runnability.
export const CONFLICT_TARGETS: Record<string, string> = {
  document_favorites: "user_id,document_id",
  curated_collection_items: "collection_id,document_id",
  team_members: "team_id,uid",
  ticket_number_counters: "org_id,year",
  archive_settings: "org_id",
  org_configurations: "org_id,key",
};

/** The ON CONFLICT target to use when additively restoring `table`. */
export function conflictTargetFor(table: string): string {
  return CONFLICT_TARGETS[table] ?? "id";
}

/** Order a set of table names for safe insertion (known FK order first, any
 *  unknown tables appended alphabetically). Pure. */
export function orderTablesForRestore(names: string[]): string[] {
  const idx = (n: string) => {
    const i = RESTORE_TABLE_ORDER.indexOf(n);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...names].sort((a, b) => {
    const d = idx(a) - idx(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
}

/** Fold newly-created user uids (old → freshly-minted) into an id remap. Pure;
 *  returns a new object. */
export function mergeNewUserUids(
  idRemap: RestorePlan["idRemap"],
  created: Record<string, string>,
): RestorePlan["idRemap"] {
  return { orgId: { ...idRemap.orgId }, uid: { ...idRemap.uid, ...created } };
}
