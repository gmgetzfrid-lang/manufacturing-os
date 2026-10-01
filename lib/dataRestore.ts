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

import { heldRoles } from "@/lib/roleHeld";
import { primaryRole } from "@/lib/roleCapabilities";
import { ORG_SCOPED_TABLES, USER_SCOPED_FOR_ORG_TABLES, REDACT_COLUMNS, redactedColumnsFor } from "@/lib/exportTables";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "@/types/schema";

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
  /** The backup's additive collection, carried so restore can keep what confers nothing. */
  roles?: string[];
  disposition: UserDisposition;
  /** Present when disposition === "linked": the existing workspace uid. */
  newUid?: string;
}

export interface TablePlanItem {
  name: string;
  rows: number;
  willImport: boolean;
  reason?: string;
  /** ORG-1: the name is not on the backup contract (nor a reconciled /
   *  append-only table the contract once carried) — never written, and the
   *  single-shot apply refuses an envelope that carries rows for it. */
  offContract?: boolean;
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

// SURF-8: append-only / self-insert-only tables are never blind-imported.
// The service-role restore path bypasses every RLS rail that makes them
// immutable, so an import would mint signatures, acknowledgments and audit
// history the people named never made. They stay in the backup for review.
export const IMMUTABLE_TABLES: Record<string, string> = {
  e_signatures: "e-signatures are minted only by the signing ceremony's server route, after re-authentication",
  audit_logs: "the audit trail is append-only — restored history would be indistinguishable from real",
  drawing_audit_logs: "drawing audit completions are written only by the reviewing path",
  document_acknowledgments: "read-and-understood acknowledgments are the assignee's own act",
  distribution_acks: "distribution acknowledgments are the recipient's own act",
  document_review_signoffs: "review sign-offs are bound to the reviewer's e-signature",
  org_configurations: "the capability policy changes only through the audited, controller-gated editor",
  // XEDGE-3: the download register is the recall population (DIST-1) and the
  // egress evidence — written only at the download egress, never by import.
  download_audits: "download audits are written only by the download egress — a restored row would name a copy holder nobody served",
  milestone_baseline_history: "prior approved-plan snapshots are written only by set_project_baseline / clear_project_baseline (projects Round G, PC SCHED-3)",
  turnover_review_events: "the turnover review history is written only by the database's trigger on turnover_items (a restored decided item gets one row from its own stamps)",
};

/** True when `table` is append-only / self-insert-only and must not be blind-imported. */
export function isImmutableTable(table: string): boolean {
  return table in IMMUTABLE_TABLES;
}

// ── The restore boundary (admin-and-org ORG-1 / BKP-3) ───────────────────
// The ONLY tables a restore may ever write are the export contract's
// (lib/exportTables.ts). Both restore routes write with the service-role
// client, which bypasses RLS, so the contract — not the uploaded envelope's
// keys — decides what is attempted.
export const RESTORE_CONTRACT_TABLES: ReadonlySet<string> = new Set<string>([
  ...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES,
]);

/** True when `table` is on the backup contract (exported, hence restorable
 *  unless it is reconciled or append-only). */
export function isRestoreContractTable(table: string): boolean {
  return RESTORE_CONTRACT_TABLES.has(table);
}

export const OFF_CONTRACT_REASON = "not part of the backup contract — never imported";

/** Contract tables that carry NO org_id column. Forcing org_id cannot bound
 *  them, so a restored row lands only when its parent row is already a row of
 *  the target workspace (BKP-3 Done-when 3; DEC-44, admin-and-org Round G).
 *  lib/__tests__/restoreApplyRoute.test.ts proves against supabase/ that every
 *  other restorable contract table has an org_id column. */
export const ORG_LESS_RESTORE_PARENTS: Readonly<Record<string, { column: string; parent: string }>> = {
  project_members: { column: "project_id", parent: "projects" },
  curated_collection_items: { column: "collection_id", parent: "curated_collections" },
};

/** Why `table` may not be written by a restore, or null when it may. The
 *  messages are the chunked route's, unchanged. */
export function restoreTableRefusal(table: string): string | null {
  if (!table || !isRestoreContractTable(table)) return `Table "${table}" is not part of the backup contract.`;
  if (isImmutableTable(table)) {
    // SURF-8: append-only / self-insert-only tables cannot be blind-imported.
    return `Table "${table}" is append-only (${IMMUTABLE_TABLES[table]}); it is never restored by import.`;
  }
  if (table in SKIP_TABLES) return `Table "${table}" is reconciled, never blind-imported.`;
  return null;
}

/** FORCE the org boundary on a remapped row: whatever the backup (or a
 *  hostile client) claims, a restored row belongs to the authorized
 *  workspace. Set even when the row omits the key, so a hand-made row cannot
 *  land with a NULL or defaulted org. Org-less tables are bound by their
 *  parent instead (ORG_LESS_RESTORE_PARENTS). Returns a new object. */
export function bindRestoredRow(table: string, row: Record<string, unknown>, orgId: string): Record<string, unknown> {
  if (table in ORG_LESS_RESTORE_PARENTS) return row;
  return { ...row, org_id: orgId };
}

/** admin-and-org BKP-11 (restore half): a restored export destination lands
 *  INERT whatever the backup row carries — disabled, with no next run (the
 *  scheduler selects only enabled rows with a due next_run_at) and with every
 *  credential column null, even when the row omits the keys (scrubRestoredRow
 *  only sees the columns a row carries). An Admin re-enters credentials and
 *  re-saves the schedule before it can fire again. Returns a new object. */
export function landRestoredRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (table !== "export_destinations") return row;
  const out: Record<string, unknown> = { ...row, enabled: false, next_run_at: null };
  for (const c of redactedColumnsFor(table)) out[c] = null;
  return out;
}

/** SURF-8 done-when 3: a restored placeholder never carries a privileged role
 *  the operator did not choose. The backup's role is honoured only when it
 *  confers nothing; anything else becomes Viewer until an Admin re-grants it. */
export const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(["Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSupervisor"]);
export function restoredMemberRole(backupRole: string | undefined | null): string {
  const r = (backupRole ?? "").trim();
  if (!r || PRIVILEGED_ROLES.has(r)) return "Viewer";
  return r;
}

/** ADD-1: the restored COLLECTION — every non-privileged role the backup held
 *  (headline or additive) survives; privileged ones are dropped, not the whole
 *  set. Empty after filtering → ["Viewer"], so the row is never born with roles = {}. */
export function restoredMemberRoles(backupRole: string | undefined | null, backupRoles?: readonly string[] | null): string[] {
  const kept = heldRoles({ role: backupRole ?? undefined, roles: backupRoles ?? undefined }).filter((r) => !PRIVILEGED_ROLES.has(r));
  return kept.length > 0 ? kept : ["Viewer"];
}

/** The headline mirrored into `org_members.role` for a restored collection —
 *  the highest-ranked of what survived (the DB trigger would derive the same). */
export function restoredMemberHeadline(roles: readonly string[]): string {
  return primaryRole(roles as Role[]);
}

interface BackupMember { uid?: string; email?: string; display_name?: string; role?: string; roles?: string[] | null }

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
      roles: Array.isArray(m.roles) ? m.roles.filter((r): r is string => typeof r === "string") : undefined,
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
    // SURF-8: immutable tables are never planned in. ORG-1: neither is any
    // name the envelope carries that is not on the backup contract.
    const offContract = !isRestoreContractTable(name) && !(name in SKIP_TABLES) && !(name in IMMUTABLE_TABLES);
    const skip = SKIP_TABLES[name] ?? IMMUTABLE_TABLES[name] ?? (offContract ? OFF_CONTRACT_REASON : undefined);
    tables.push({ name, rows: n, willImport: !skip, reason: skip, ...(offContract ? { offContract: true } : {}) });
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
  // EGR-7 / XEDGE-10: a bearer column never comes back from a backup. Applied
  // here — the one place BOTH restore paths (single-shot apply and the chunked
  // apply-table) pass every row through — so no caller can forget it.
  return scrubRestoredRow(out);
}

// ── Bearer columns never return (EGR-7 / XEDGE-10) ───────────────────────
// The export nulls every column in lib/exportTables.ts REDACT_COLUMNS. A
// restore must not reinstate them either — from a redacted backup (null) or
// from an older / hand-edited envelope that still carries the plaintext. The
// column set is DERIVED from the export map so the two sides cannot drift;
// lib/__tests__/exportCoverage.test.ts censuses the schema for any new
// bearer column.
const BEARER_COLUMNS: ReadonlySet<string> = new Set(
  Object.values(REDACT_COLUMNS).flatMap((r) => [...r.columns]),
);
/** Bearer columns declared NOT NULL UNIQUE (document_shares.token,
 *  project_intake_links.token): they take an unguessable placeholder so the
 *  row can land, and the row is marked revoked so the placeholder can never
 *  be presented. Nullable bearer columns (portal_token, *_encrypted) are nulled. */
const PLACEHOLDER_COLUMNS: ReadonlySet<string> = new Set(["token"]);
export const RESTORED_TOKEN_PREFIX = "restored-";

function restoredPlaceholder(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${RESTORED_TOKEN_PREFIX}${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

/** The register note a restored, formerly issued transmittal carries. */
export const RESTORED_TRANSMITTAL_NOTE = "Restored from a backup: the portal link was not restored (DEC-45). Issue a new transmittal to send these documents again.";

/** Scrub every bearer column of a restored row. Pure apart from the random
 *  placeholder; returns a new object. A row that carries a scrubbed column and
 *  a `revoked_at` column arrives REVOKED (shares, intake links); one that
 *  carries `enabled` arrives DISABLED (export destinations); an ISSUED
 *  transmittal arrives VOIDED — `trg_transmittals_guard` (20261027) mints a
 *  fresh portal token for every row INSERTED with status 'issued', which
 *  would be a live credential nobody chose to issue, so the row lands in the
 *  one state that keeps the register record and can never present a link.
 *  Nothing restored can be presented or fire until a person re-issues /
 *  re-enters it. */
export function scrubRestoredRow(row: Record<string, unknown>, now: string = new Date().toISOString()): Record<string, unknown> {
  const hit = Object.keys(row).filter((k) => BEARER_COLUMNS.has(k));
  if (hit.length === 0) return row;
  const out: Record<string, unknown> = { ...row };
  for (const c of hit) out[c] = PLACEHOLDER_COLUMNS.has(c) ? restoredPlaceholder() : null;
  if ("revoked_at" in out && out.revoked_at == null) out.revoked_at = now;
  if ("enabled" in out) out.enabled = false;
  if (hit.includes("portal_token") && out.status === "issued") {
    out.status = "voided";
    if ("notes" in out) {
      const notes = typeof out.notes === "string" ? out.notes.trim() : "";
      out.notes = notes ? `${notes}\n\n${RESTORED_TRANSMITTAL_NOTE}` : RESTORED_TRANSMITTAL_NOTE;
    }
  }
  return out;
}

/** True when `column` is a bearer column the restore scrubs (exposed for the
 *  coverage tripwire, which proves export and restore agree). */
export function isBearerColumn(column: string): boolean {
  return BEARER_COLUMNS.has(column);
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

/** True when `table` is one the restore never blind-imports (reconciled
 *  identity/config tables, and SURF-8's immutable tables). */
export function isSkippedTable(table: string): boolean {
  return table in SKIP_TABLES || table in IMMUTABLE_TABLES;
}

/** Why a table is never blind-imported, for the plan review. */
export function skipReasonFor(table: string): string | null {
  return SKIP_TABLES[table] ?? IMMUTABLE_TABLES[table] ?? null;
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
  // Link discovery: aliases hang off assets, proposals off documents —
  // both already restored above. Connection Skills only reference the org,
  // so anywhere works; they ride with their consumers.
  "asset_aliases", "proposed_links", "link_rules", "answer_skills",
  // Flows may reference knowledge documents (source PFD), restored earlier.
  "process_flows",
  // Mentions reference BOTH an asset and a document (controlled or
  // knowledge), so they can only land once both sides exist. Audit memory
  // hangs off documents alone.
  "entity_mentions", "drawing_audit_logs",
  "document_favorites", "e_signatures", "transmittals",
  "document_intents", "revision_branches",
  "work_packages", "work_package_documents", "work_package_prints", "distribution_acks",
  "document_acknowledgments", "document_review_signoffs", "document_review_events",
  "document_disposition_events", "access_recertification_events",
  "asset_files",
  "curated_collection_items", "library_views", "plot_plans",
  "project_documents", "project_activity",
  "milestones", "milestone_notes",
  "ticket_number_counters", "tickets", "ticket_comments",
  "checkout_sessions", "checkout_episodes", "checkout_messages",
  "markup_requests",
  "document_markups", // GAP-7: after documents + document_versions (FKs); the author uid is remapped like any user column
  "notes", "download_audits",
  "audit_logs", "notifications", "email_notifications",
  "table_views", "sla_defaults", "org_configurations",
  "export_destinations", "export_runs", "ai_usage_events",
  "ai_key_agreements", "ai_usage_limits",
  "access_requests",
  // Companies before project_parties (parties carry company_id) and before
  // the events that hang off them.
  "companies", "company_events",
  "project_parties",
  "cost_accounts", "cost_documents", "cost_entries",
  // Change orders reference cost_accounts + project_parties, both above.
  "change_orders",
  // Quality program: checklists before their items; turnover/punch only
  // need projects + parties + documents, all long since restored.
  "project_checklists", "checklist_items",
  "turnover_items", "turnover_review_events", "punch_items",
  "knowledge_libraries", "knowledge_library_links", "knowledge_sources",
  "knowledge_documents", "knowledge_chunks", "knowledge_page_entities",
  "knowledge_questions",
  "output_templates", "output_generations",
];

// Conflict target per table for the additive upsert. Most tables have a plain
// `id` primary key; the ones listed here use composite (or differently-named)
// keys — upserting them on "id" errors and breaks re-runnability.
// BKP-12: lib/__tests__/dataRestore.test.ts censuses supabase/ and fails when
// a restorable table's target is not one of its PRIMARY KEY / UNIQUE keys.
export const CONFLICT_TARGETS: Record<string, string> = {
  document_favorites: "user_id,document_id",
  curated_collection_items: "collection_id,document_id",
  team_members: "team_id,uid",
  ticket_number_counters: "org_id,year",
  archive_settings: "org_id",
  org_configurations: "org_id,key",
  codebook_config: "org_id",                          // one row per org (20260928)
  document_equipment_suggestions: "org_id,document_id", // 20260928
  recently_viewed_docs: "user_id,document_id",        // 20260806
  library_numbering: "library_id",                    // 20260806
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

// ── The shared restore write (ORG-1 / BKP-3 Done-when 2) ─────────────────
// ONE function writes a slice of one table for BOTH restore routes — the
// chunked /apply-table the UI uses and the single-shot /apply — so the two
// paths cannot diverge again (the single-shot route had lost the org
// boundary and the table allowlist the chunked one enforces).

type RestoreDb = Pick<SupabaseClient, "from">;

/** One row the restore did not write, and why. */
export interface RestoreRowRefusal { id: string | null; code: string; message: string }

export interface RestoreChunkResult {
  ok: boolean;
  /** When !ok: the HTTP status to answer (400 contract refusal, 500 database failure). */
  status?: number;
  /** The database's own message (BKP-12: the underlying error, never a retry's). */
  error?: string;
  /** Its SQLSTATE, when the database gave one. */
  code?: string;
  /** Rows written. Earlier sub-chunks stay written when a later one fails. */
  inserted: number;
  /** BKP-5: rows NOT written because a row with the same key (the table's
   *  conflict target — usually its id) already exists. That row is kept
   *  exactly as it is: a restore only adds, it never overwrites or repairs. */
  existing: number;
  /** Rows the database wrote or skipped without reporting a count — honest
   *  "unknown", never assumed written. */
  uncounted: number;
  /** Rows not written, each with its reason (a database refusal of that single
   *  row, or a parent that is not a row of this workspace). */
  refused: RestoreRowRefusal[];
  /** Rows left after the restore's own filters (comments of a ticket archived
   *  since the backup are dropped). */
  rowsAfterFilters: number;
}

/** Codes a single document_holds row may be refused with (HLD-9, 20261073):
 *  the row's org differs from its document's (23514) or the document is gone
 *  (23503). One such row must not sink the legitimate holds sharing its chunk. */
const ROW_REFUSAL_CODES: ReadonlySet<string> = new Set(["23514", "23503"]);
const ROW_REFUSAL_TABLES: ReadonlySet<string> = new Set(["document_holds"]);

/** A readable identity for a row in a report — its id, or its conflict-key values. */
export function restoreRowLabel(table: string, row: Record<string, unknown>): string | null {
  if (typeof row.id === "string") return row.id;
  const parts = conflictTargetFor(table).split(",").map((c) => row[c.trim()]);
  return parts.every((p) => typeof p === "string" || typeof p === "number") ? parts.join("/") : null;
}

/** Write one slice of one table into `orgId` additively (existing keys are
 *  skipped). Never throws for a database refusal; the caller answers with
 *  `status` / `error` when `ok` is false. Order of rules:
 *    1. the table must be on the backup contract and not reconciled / append-only;
 *    2. every row is remapped (uids, org paths, bearer scrub), bound to `orgId`
 *       and landed inert where the table requires it (export destinations);
 *    3. comments of a ticket archived since the backup are dropped;
 *    4. a row of an org-less table lands only under a parent of this workspace;
 *    5. upsert on the table's real conflict target. */
export async function applyRestoreChunk(
  sb: RestoreDb,
  params: { orgId: string; table: string; rows: ReadonlyArray<Record<string, unknown>>; idRemap: RestorePlan["idRemap"] },
): Promise<RestoreChunkResult> {
  const { orgId, table, idRemap } = params;
  const refused: RestoreRowRefusal[] = [];
  let existing = 0;
  let uncounted = 0;
  const fail = (status: number, error: string, inserted = 0, rowsAfterFilters = 0, code?: string | null): RestoreChunkResult =>
    ({ ok: false, status, error, ...(code ? { code: String(code) } : {}), inserted, existing, uncounted, refused, rowsAfterFilters });
  // count: "exact" reports the rows the statement WROTE; ON CONFLICT DO
  // NOTHING skips the rest. No count is recorded as unknown, never as written.
  const tally = (count: number | null | undefined, sent: number): number => {
    if (typeof count !== "number") { uncounted += sent; return 0; }
    existing += Math.max(0, sent - count);
    return count;
  };

  const refusal = restoreTableRefusal(table);
  if (refusal) return fail(400, refusal);
  if (!orgId) return fail(400, "No target workspace.");

  let mapped = params.rows.map((r) => landRestoredRow(table, bindRestoredRow(table, remapRow(r, idRemap), orgId)));

  // Never resurrect comments onto a ticket that's since been archived to a
  // stub — the JSONB stays cleared, so re-inserting rows would split-brain it.
  if (table === "ticket_comments" && mapped.length) {
    const ticketIds = Array.from(new Set(mapped.map((r) => r.ticket_id).filter((v): v is string => typeof v === "string")));
    const archived = new Set<string>();
    for (let i = 0; i < ticketIds.length; i += 500) {
      const { data, error } = await sb
        .from("tickets").select("id")
        .in("id", ticketIds.slice(i, i + 500)).eq("org_id", orgId).not("archived_at", "is", null);
      if (error) return fail(500, `Could not check for archived tickets: ${error.message}`);
      for (const t of ((data ?? []) as Array<{ id: string }>)) archived.add(t.id);
    }
    if (archived.size) mapped = mapped.filter((r) => !archived.has(r.ticket_id as string));
  }
  const rowsAfterFilters = mapped.length;

  // BKP-3 Done-when 3: an org-less row is bounded by its parent. The parent
  // is read in THIS workspace (FK order restores parents first); a row whose
  // parent is elsewhere — or missing — is refused, never written.
  const parentRule = ORG_LESS_RESTORE_PARENTS[table];
  if (parentRule && mapped.length) {
    const parentIds = Array.from(new Set(mapped.map((r) => r[parentRule.column]).filter((v): v is string => typeof v === "string")));
    const inOrg = new Set<string>();
    for (let i = 0; i < parentIds.length; i += 200) {
      const { data, error } = await sb
        .from(parentRule.parent).select("id")
        .in("id", parentIds.slice(i, i + 200)).eq("org_id", orgId);
      if (error) return fail(500, `Could not check the ${parentRule.parent} rows these ${table} rows belong to: ${error.message}`, 0, rowsAfterFilters);
      for (const p of ((data ?? []) as Array<{ id: string }>)) inOrg.add(p.id);
    }
    mapped = mapped.filter((r) => {
      const parentId = r[parentRule.column];
      if (typeof parentId === "string" && inOrg.has(parentId)) return true;
      refused.push({
        id: restoreRowLabel(table, r),
        code: "parent_outside_workspace",
        message: `${parentRule.column} ${typeof parentId === "string" ? parentId : "(none)"} is not a ${parentRule.parent} row of this workspace`,
      });
      return false;
    });
  }

  // BKP-12: the upsert's own refusal is the answer. There is no plain-insert
  // retry of a chunk the upsert already rejected — every conflict target is a
  // real key (census test), so a rejection is a data or schema fact, and
  // re-sending the same rows could only fail again (or, on a table whose
  // target was wrong, land rows the next re-run then collides with).
  let inserted = 0;
  for (let i = 0; i < mapped.length; i += 500) {
    const chunk = mapped.slice(i, i + 500);
    const up = await sb.from(table).upsert(chunk, { onConflict: conflictTargetFor(table), ignoreDuplicates: true, count: "exact" });
    if (!up.error) { inserted += tally(up.count, chunk.length); continue; }
    if (!(ROW_REFUSAL_TABLES.has(table) && ROW_REFUSAL_CODES.has(String(up.error.code ?? "")))) {
      return fail(500, up.error.message, inserted, rowsAfterFilters, up.error.code);
    }
    // HLD-9: one refused hold must not sink its chunk — retry row by row.
    for (const row of chunk) {
      const one = await sb.from(table).upsert([row], { onConflict: conflictTargetFor(table), ignoreDuplicates: true, count: "exact" });
      if (!one.error) { inserted += tally(one.count, 1); continue; }
      if (!ROW_REFUSAL_CODES.has(String(one.error.code ?? ""))) {
        return fail(500, one.error.message, inserted, rowsAfterFilters, one.error.code);
      }
      refused.push({ id: typeof row.id === "string" ? row.id : null, code: String(one.error.code), message: one.error.message });
    }
  }
  return { ok: true, inserted, existing, uncounted, refused, rowsAfterFilters };
}

/** BKP-5: what a restore of these rows WOULD do, read-only — how many already
 *  exist in the database under the table's conflict key (and would be kept
 *  as they are) and how many would be new. Rows are remapped and bound to the
 *  workspace exactly as the write does, so a composite key that carries an
 *  org or a user is compared as it would be written. It does not apply the
 *  write's other filters (archived-ticket comments, org-less parents): their
 *  outcome is reported per row after the apply. */
export interface RestorePreviewResult {
  ok: boolean;
  status?: number;
  error?: string;
  rows: number;
  existing: number;
  wouldInsert: number;
}

export async function previewRestoreChunk(
  sb: RestoreDb,
  params: { orgId: string; table: string; rows: ReadonlyArray<Record<string, unknown>>; idRemap: RestorePlan["idRemap"] },
): Promise<RestorePreviewResult> {
  const { orgId, table, idRemap } = params;
  const refusal = restoreTableRefusal(table);
  if (refusal) return { ok: false, status: 400, error: refusal, rows: 0, existing: 0, wouldInsert: 0 };
  const cols = conflictTargetFor(table).split(",").map((c) => c.trim());
  const mapped = params.rows.map((r) => bindRestoredRow(table, remapRow(r, idRemap), orgId));
  const isKeyValue = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";
  const keyOf = (r: Record<string, unknown>) => (cols.every((c) => isKeyValue(r[c])) ? cols.map((c) => String(r[c])).join("\u0000") : null);
  // Probe on the most selective key column (never org_id when there is another).
  const probe = cols.find((c) => c !== "org_id") ?? cols[0];
  const values = Array.from(new Set(mapped.filter((r) => keyOf(r) !== null).map((r) => String(r[probe]))));
  const present = new Set<string>();
  for (let i = 0; i < values.length; i += 200) {
    let q = sb.from(table).select(cols.join(",")).in(probe, values.slice(i, i + 200));
    if (cols.includes("org_id")) q = q.eq("org_id", orgId);
    const { data, error } = await q;
    if (error) return { ok: false, status: 500, error: error.message, rows: mapped.length, existing: 0, wouldInsert: 0 };
    for (const row of ((data ?? []) as unknown as Array<Record<string, unknown>>)) {
      const k = keyOf(row);
      if (k !== null) present.add(k);
    }
  }
  let existing = 0;
  const seen = new Set<string>();
  for (const r of mapped) {
    const k = keyOf(r);
    if (k === null) continue; // no key yet (a defaulted id): always new
    if (present.has(k) || seen.has(k)) existing++;
    seen.add(k);
  }
  return { ok: true, rows: mapped.length, existing, wouldInsert: mapped.length - existing };
}

// ── The chunked restore, driven from the browser (BKP-5) ─────────────────
// The page's whole restore flow, kept here — pure apart from the injected
// `post` — so it runs the same in a test against the real routes as it does
// in the browser against fetch.

/** DEC-44 (A&O P1) §5 — the sentence the page shows before and after a restore. */
export const RESTORE_ADDITIVE_NOTE =
  "A restore only ADDS records. A record whose id (or key) already exists in this workspace is kept exactly as it is — " +
  "a restore cannot overwrite, repair or roll back a record that was changed or damaged after the backup.";

export const RESTORE_CHUNK_ROWS = 500;

export type RestorePost = (path: string, body: unknown) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }>;

export interface RestoreRunProgress {
  phase: "checking" | "begin" | "tables";
  currentTable?: string;
  rowsDone: number;
  rowsTotal: number;
  tablesDone: number;
  tablesTotal: number;
}

export interface RestoreTableOutcome {
  name: string;
  rows: number;
  inserted: number;
  existing: number;
  uncounted: number;
  refused: RestoreRowRefusal[];
  error?: string;
}

export interface ChunkedRestoreResult {
  createdUsers: number;
  linkedUsers: number;
  totalInserted: number;
  totalExisting: number;
  totalUncounted: number;
  totalRefused: number;
  tables: RestoreTableOutcome[];
  /** BKP-5 Done-when 2: the table the restore STOPPED at (tables are
   *  FK-ordered, so nothing after it was attempted), and why. */
  stoppedAt: { table: string; error: string } | null;
  notAttempted: string[];
}

export interface ChunkedRestorePreview {
  tables: Record<string, { rows: number; existing: number; wouldInsert: number }>;
  existing: number;
  wouldInsert: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const restoreOrder = (plan: RestorePlan) =>
  orderTablesForRestore(plan.counts.tables.filter((t) => t.willImport && t.rows > 0).map((t) => t.name));
const tableRows = (envelope: RestoreEnvelopeLike, table: string): Array<Record<string, unknown>> => {
  const raw = envelope.tables[table];
  return (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
};
const keyProjection = (table: string, row: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const c of conflictTargetFor(table).split(",").map((x) => x.trim())) if (c in row) out[c] = row[c];
  return out;
};

/** BKP-5 Done-when 1, BEFORE applying: per table, how many backup rows already
 *  exist here under the table's key (and would be kept as they are) and how
 *  many would be new. Read-only; sends only the key columns. Throws with the
 *  server's message when a check cannot run. */
export async function previewChunkedRestore(params: {
  orgId: string; envelope: RestoreEnvelopeLike; plan: RestorePlan; post: RestorePost;
  onProgress?: (p: RestoreRunProgress) => void;
}): Promise<ChunkedRestorePreview> {
  const { orgId, envelope, plan, post } = params;
  const order = restoreOrder(plan);
  const rowsTotal = order.reduce((s, t) => s + tableRows(envelope, t).length, 0);
  const out: ChunkedRestorePreview = { tables: {}, existing: 0, wouldInsert: 0 };
  let rowsDone = 0;
  for (const [tablesDone, table] of order.entries()) {
    const rows = tableRows(envelope, table);
    const acc = { rows: 0, existing: 0, wouldInsert: 0 };
    for (let i = 0; i < rows.length; i += RESTORE_CHUNK_ROWS) {
      params.onProgress?.({ phase: "checking", currentTable: table, rowsDone, rowsTotal, tablesDone, tablesTotal: order.length });
      const chunk = rows.slice(i, i + RESTORE_CHUNK_ROWS).map((r) => keyProjection(table, r));
      const res = await post(`/api/admin/restore/apply-table?orgId=${encodeURIComponent(orgId)}`, { table, rows: chunk, idRemap: plan.idRemap, preview: true });
      if (!res.ok) throw new Error(`Could not check ${table} against this workspace: ${String(res.body?.error ?? `HTTP ${res.status}`)}`);
      acc.rows += num(res.body?.rows);
      acc.existing += num(res.body?.existing);
      acc.wouldInsert += num(res.body?.wouldInsert);
      rowsDone += chunk.length;
    }
    out.tables[table] = acc;
    out.existing += acc.existing;
    out.wouldInsert += acc.wouldInsert;
  }
  return out;
}

/** The chunked restore: /begin (users), then every importable table in FK
 *  order through /apply-table. Counts are what the server reported, never
 *  assumed. BKP-5 Done-when 2 (intelligence ILIFE-4): the run STOPS at the
 *  first table that fails — continuing would write children of parents that
 *  never landed — and names the tables it did not attempt. Throws only when
 *  /begin fails (nothing was restored). */
export async function runChunkedRestore(params: {
  orgId: string; envelope: RestoreEnvelopeLike; plan: RestorePlan; orgNameChoice: "backup" | "current"; post: RestorePost;
  onProgress?: (p: RestoreRunProgress) => void;
}): Promise<ChunkedRestoreResult> {
  const { orgId, envelope, plan, post } = params;
  const order = restoreOrder(plan);
  const rowsTotal = order.reduce((s, t) => s + tableRows(envelope, t).length, 0);
  const manifest = { orgId: envelope.manifest.orgId, orgName: envelope.manifest.orgName };
  params.onProgress?.({ phase: "begin", rowsDone: 0, rowsTotal, tablesDone: 0, tablesTotal: order.length });
  const begin = await post(`/api/admin/restore/begin?orgId=${encodeURIComponent(orgId)}`, {
    manifest, orgMembers: envelope.tables.org_members ?? [], orgNameChoice: params.orgNameChoice,
  });
  if (!begin.ok) throw new Error(String(begin.body?.error ?? `HTTP ${begin.status}`));
  const idRemap = begin.body?.idRemap as RestorePlan["idRemap"];

  const result: ChunkedRestoreResult = {
    createdUsers: num(begin.body?.createdUsers), linkedUsers: num(begin.body?.linkedUsers),
    totalInserted: 0, totalExisting: 0, totalUncounted: 0, totalRefused: 0,
    tables: [], stoppedAt: null, notAttempted: [],
  };
  let rowsDone = 0;
  for (const [tablesDone, table] of order.entries()) {
    const rows = tableRows(envelope, table);
    const t: RestoreTableOutcome = { name: table, rows: rows.length, inserted: 0, existing: 0, uncounted: 0, refused: [] };
    for (let i = 0; i < rows.length; i += RESTORE_CHUNK_ROWS) {
      params.onProgress?.({ phase: "tables", currentTable: table, rowsDone, rowsTotal, tablesDone, tablesTotal: order.length });
      const chunk = rows.slice(i, i + RESTORE_CHUNK_ROWS);
      const res = await post(`/api/admin/restore/apply-table?orgId=${encodeURIComponent(orgId)}`, { table, rows: chunk, idRemap, manifest });
      // A failed chunk may still have written rows before it stopped — count them.
      t.inserted += num(res.body?.inserted);
      t.existing += num(res.body?.existing);
      t.uncounted += num(res.body?.uncounted);
      if (Array.isArray(res.body?.refused)) t.refused.push(...(res.body.refused as RestoreRowRefusal[]));
      if (!res.ok) { t.error = String(res.body?.error ?? `HTTP ${res.status}`); break; }
      rowsDone += chunk.length;
    }
    result.tables.push(t);
    result.totalInserted += t.inserted;
    result.totalExisting += t.existing;
    result.totalUncounted += t.uncounted;
    result.totalRefused += t.refused.length;
    if (t.error) {
      result.stoppedAt = { table, error: t.error };
      result.notAttempted = order.slice(order.indexOf(table) + 1);
      break;
    }
  }
  return result;
}
