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

/** A member row of the target workspace. `status` is one of
 *  RESTORE_LINK_MEMBER_STATUSES (absent = active, for older callers). A row
 *  with no address is passed too (fix pass 5): a backup member with no
 *  address links to the member under the same uid. */
export interface CurrentMember { uid: string; email: string | null; status?: string | null }
export interface CurrentOrgContext {
  orgId: string;
  orgName: string;
  /** Members of the target workspace in any RESTORE_LINK_MEMBER_STATUSES
   *  status (the join key is email) — a placeholder an earlier run of this
   *  restore created is inactive, and a re-run must link to it, never mint a
   *  second one. */
  members: CurrentMember[];
}

/** admin-and-org P1 (fix pass 3): the member statuses a backup person is
 *  linked to by email — every status a membership row can hold
 *  (types/schema.ts MemberStatus). Reconciling against active rows alone made
 *  a re-run (the stop panel tells the Admin to re-run) mint a SECOND inactive
 *  placeholder for every unlinked person and remap their old uid to a new
 *  one, so every uid-keyed row (favorites, recents) landed twice. Linking
 *  changes nothing about the member row: an inactive placeholder stays
 *  inactive, a suspended member stays suspended. When one address holds
 *  several rows, the earliest status in this list wins. */
export const RESTORE_LINK_MEMBER_STATUSES: readonly string[] = ["active", "invited", "suspended", "inactive"];

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
  /** Present when disposition === "linked": that member's status (an
   *  "inactive" one is usually a placeholder an earlier restore created). */
  linkedStatus?: string;
  /** admin-and-org P1 (fix pass 5): the backup's OTHER membership rows for
   *  this address, each under its own uid (the export carries every status,
   *  and 20261018 allows an inactive historical row beside a re-added one).
   *  Each is mapped to the same person as `oldUid`. */
  aliasUids?: string[];
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
    /** admin-and-org P1 (fix pass 5): backup member uids no person here can
     *  be found for (no email address, and no member under that uid). A row
     *  naming one is refused (`person_not_mapped`) — it would otherwise land
     *  naming the raw backup uid. Absent when there are none. */
    unmappedUids?: string[];
  };
  counts: {
    matchedUsers: number;
    newUsers: number;
    /** Backup members that could not be mapped (see idRemap.unmappedUids). */
    unmappedUsers: number;
    totalRows: number;
    files: number;
    tables: TablePlanItem[];
  };
  warnings: string[];
}

const norm = (s: string | undefined | null) => (s ?? "").trim().toLowerCase();

/** An OWN key of a lookup object — never one inherited from Object.prototype
 *  ("constructor", "__proto__", "toString" …), which a backup's table name, a
 *  row's text value or a hand-made idRemap can carry. */
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// Tables never imported by blind insert — identity/auth/config is handled by
// reconciliation, not copied over the top of the live workspace.
const SKIP_TABLES: Record<string, string> = {
  orgs: "target workspace already exists; org name is reconciled separately",
  org_members: "membership is rebuilt from the user reconciliation",
  users: "user profiles are created via the additive-by-email reconciliation",
  notification_preferences: "per-user settings are re-established on re-invite",
  // admin-and-org P1 (fix pass 3), BKP-11 restore half / DEC-45: the restore
  // writes with the service role, so the mail queue's INSERT rail (SURF-17:
  // same-org recipients only, never metadata.external) never sees a restored
  // row, and the drain sends every queued/failed row under the attempt cap.
  // Landing rows terminal is not enough — an Admin's dead-letter re-queue
  // (admin/settings) makes any failed row sendable again with its address
  // and body unchanged. So no row of the queue is ever written by a restore.
  email_notifications: "the outbound mail queue — a restored message would be sent again, to whatever address the backup names; delivery state is never restored",
  subscriptions: "billing state is owned by the payment provider — re-subscribe, never copy",
  push_subscriptions: "device push registrations are machine-specific — re-established per device",
  // admin-and-org P1 (fix pass 4): service-role only (20260916). The only
  // writer, POST /api/ai/usage, is controller-gated, bounds a cap to
  // 0..10000 and audits it (AI_CAP_CHANGED); a restored row would set any
  // value unaudited. Until a controller re-sets them the default cap applies.
  ai_usage_limits: "monthly AI spend caps are set only through the controller route, which bounds and audits them — re-set them after a restore (the default cap applies until then)",
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
  // admin-and-org P1 (fix pass 4): service-role only (20260916). The only
  // writer, POST /api/ai/agreement, records the CALLER's own acceptance (name,
  // agreement version, IP, time), and every AI ask gate reads it — a restored
  // row would be a signature nobody gave that passes the gate.
  ai_key_agreements: "acceptable-use agreements are the signer's own act — written only by /api/ai/agreement",
  // Service-role only (20260806): one row per metered call, written by the
  // call path; the monthly caps sum it, so a restored row would move this
  // month's spend (a negative cost would lift a cap).
  ai_usage_events: "the AI spend ledger is written only by the metered call path — the caps sum it, so a restored row would move this month's spend",
};

/** admin-and-org P1 (fix pass 4): contract tables that supabase/ makes
 *  service-role only for writes (REVOKE ALL / INSERT FROM authenticated, never
 *  granted back) and that a restore still writes — each with why a restored
 *  row is the workspace's data, not anyone's act and not a value only a
 *  bounded route may set. lib/__tests__/dataRestore.test.ts censuses
 *  supabase/ and fails when such a table is in none of SKIP_TABLES,
 *  IMMUTABLE_TABLES or this map — the class SURF-8 and ORG-1 close, so a new
 *  service-role-only table cannot become restorable unexamined. */
export const RESTORE_SERVICE_ROLE_WAIVERS: Readonly<Record<string, string>> = {
  archive_settings: "the archive location hint, naming and storage-alert threshold — the values an Admin / Doc Control sets through /api/admin/archive-settings; they drive only the archive prompt and storage alerts and confer no access",
  archives: "the catalog of archives this workspace produced (label, kind, counts); restored versions' archive_id labels name these rows. A row carries no bytes and grants nothing — a reclaim (shed/commit) still frees only this workspace's keys, after its legal-hold and shared-key checks",
  knowledge_page_entities: "derived drawing-page tags the indexer writes; bounded to this workspace's knowledge documents (RESTORE_PARENT_RULES) and replaced on re-index — no gate reads a row as anyone's act",
};

/** True when `table` is append-only / self-insert-only and must not be blind-imported. */
export function isImmutableTable(table: string): boolean {
  return has(IMMUTABLE_TABLES, table);
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
 *  the target workspace (BKP-3 Done-when 3; DEC-75, admin-and-org Round G) —
 *  for these the parent column is REQUIRED (a NULL one is refused).
 *  lib/__tests__/restoreApplyRoute.test.ts proves against supabase/ that every
 *  other restorable contract table has an org_id column. */
export const ORG_LESS_RESTORE_PARENTS: Readonly<Record<string, { column: string; parent: string }>> = {
  project_members: { column: "project_id", parent: "projects" },
  curated_collection_items: { column: "collection_id", parent: "curated_collections" },
};

/** One foreign key a restored row must honour inside the target workspace:
 *  `column` names an `id` of `parent`. `clearWhenMissing`: the pointer is
 *  CLEARED (and reported) instead of the row being refused when its parent is
 *  not a row of this workspace — only for a nullable ON DELETE SET NULL
 *  pointer that confers no access and places the row under no ACL, so a
 *  cleared one never widens who can see or do anything (fix pass 2). */
export interface RestoreParentRule { column: string; parent: string; clearWhenMissing?: true }

/** "column>parent column>parent? …" → rules (the parent key is always `id`;
 *  a trailing `?` marks a pointer that is cleared rather than refused). */
function fkRules(spec: string): ReadonlyArray<RestoreParentRule> {
  return spec.split(/\s+/).filter(Boolean).map((pair) => {
    const [column, target] = pair.split(">");
    return target.endsWith("?") ? { column, parent: target.slice(0, -1), clearWhenMissing: true as const } : { column, parent: target };
  });
}

/** ORG-1 (admin-and-org Round G, fix pass): forcing org_id bounds the ROW;
 *  this bounds what it POINTS AT. Every FOREIGN KEY column of a restorable
 *  table whose parent is an org-scoped table. A restored row lands only when
 *  each such column is NULL (or absent) or names a parent row of the target
 *  workspace, read there before the write (`.in("id", …).eq("org_id", …)` —
 *  FK order restores parents first); a self-reference may also name a row of
 *  the same chunk whose id is new to the deployment. Any other row is refused
 *  (`parent_outside_workspace`) and never written — a team_members row naming
 *  another tenant's team, a checkout episode on another tenant's document —
 *  except that a `clearWhenMissing` pointer (marked `?`) is cleared instead
 *  and the row lands. An unreadable parent table fails the chunk closed.
 *  lib/__tests__/dataRestore.test.ts derives every foreign key from
 *  supabase/ and fails when one to an org-scoped parent has no rule here, or
 *  one to a parent with no org_id is not waived in RESTORE_FK_PARENT_WAIVERS. */
export const RESTORE_PARENT_RULES: Readonly<Record<string, ReadonlyArray<RestoreParentRule>>> = {
  access_recertification_events: fkRules("library_id>libraries"),
  asset_aliases: fkRules("asset_id>assets"),
  asset_files: fkRules("asset_id>assets document_id>documents"),
  asset_photos: fkRules("asset_id>assets"),
  assets: fkRules("plant_id>plants unit_id>units system_id>systems type_id>asset_types library_id>libraries"),
  change_orders: fkRules("project_id>projects cost_account_id>cost_accounts party_id>project_parties"),
  checklist_items: fkRules("checklist_id>project_checklists"),
  checkout_episodes: fkRules("document_id>documents library_id>libraries"),
  checkout_messages: fkRules("document_id>documents parent_message_id>checkout_messages episode_id>checkout_episodes"),
  checkout_sessions: fkRules("document_id>documents library_id>libraries linked_ticket_id>tickets project_id>projects episode_id>checkout_episodes"),
  collections: fkRules("library_id>libraries parent_id>collections"),
  companies: fkRules("quality_manual_doc_id>documents"),
  company_events: fkRules("company_id>companies project_id>projects"),
  cost_accounts: fkRules("project_id>projects party_id>project_parties wbs_milestone_id>milestones"),
  cost_documents: fkRules("project_id>projects party_id>project_parties intake_link_id>project_intake_links company_id>companies"),
  cost_entries: fkRules("project_id>projects cost_account_id>cost_accounts party_id>project_parties source_document_id>cost_documents"),
  curated_collection_items: fkRules("collection_id>curated_collections"),
  curated_collections: fkRules("library_id>libraries folder_id>collections"),
  document_assets: fkRules("document_id>documents asset_id>assets"),
  document_disposition_events: fkRules("document_id>documents"),
  document_equipment_suggestions: fkRules("document_id>documents"),
  document_holds: fkRules("document_id>documents origin_ticket_id>tickets"),
  document_intents: fkRules("document_id>documents library_id>libraries base_version_id>document_versions"),
  document_markups: fkRules("document_id>documents version_id>document_versions"),
  document_related_resources: fkRules("document_id>documents target_document_id>documents"),
  document_sets: fkRules("library_id>libraries"),
  document_shares: fkRules("document_id>documents"),
  document_supersessions: fkRules("superseded_doc_id>documents replacement_doc_id>documents"),
  document_versions: fkRules("record_id>documents supersedes_version_id>document_versions reverted_from_version_id>document_versions published_base_version_id>document_versions"),
  documents: fkRules("library_id>libraries collection_id>collections set_id>document_sets plant_id>plants unit_id>units system_id>systems"),
  entity_mentions: fkRules("asset_id>assets knowledge_document_id>knowledge_documents document_id>documents"),
  export_runs: fkRules("destination_id>export_destinations"),
  knowledge_chunks: fkRules("library_id>knowledge_libraries document_id>knowledge_documents"),
  knowledge_documents: fkRules("library_id>knowledge_libraries source_id>knowledge_sources source_document_id>documents"),
  knowledge_library_links: fkRules("library_id>knowledge_libraries linked_library_id>knowledge_libraries"),
  knowledge_page_entities: fkRules("library_id>knowledge_libraries document_id>knowledge_documents"),
  knowledge_questions: fkRules("library_id>knowledge_libraries"),
  knowledge_sources: fkRules("library_id>knowledge_libraries"),
  // An owner team makes its supervisor the library's effective owner
  // (lib/ownership.ts); without it ownership falls to the org's controllers
  // (narrower) — cleared, so one refused team never refuses its libraries,
  // their documents and their versions.
  libraries: fkRules("owner_team_id>teams?"),
  library_numbering: fkRules("library_id>libraries"),
  library_views: fkRules("library_id>libraries"),
  markup_requests: fkRules("project_id>projects document_id>documents"),
  metadata_templates: fkRules("library_id>libraries collection_id>collections"),
  milestone_notes: fkRules("milestone_id>milestones"),
  milestones: fkRules("project_id>projects document_id>documents linked_ticket_id>tickets parent_id>milestones"),
  notes: fkRules("document_id>documents project_id>projects asset_id>assets"),
  output_generations: fkRules("template_id>output_templates"),
  plot_plans: fkRules("plant_id>plants unit_id>units system_id>systems"),
  process_flows: fkRules("source_document_id>knowledge_documents"),
  project_activity: fkRules("project_id>projects"),
  project_checklists: fkRules("project_id>projects source_document_id>documents"),
  project_documents: fkRules("project_id>projects document_id>documents"),
  project_members: fkRules("project_id>projects"),
  project_parties: fkRules("project_id>projects company_id>companies"),
  // The scope-of-work pointer carries no access — cleared, so one refused
  // document never refuses its project and everything under it.
  projects: fkRules("sow_document_id>documents?"),
  proposed_links: fkRules("document_id>documents target_document_id>documents"),
  punch_items: fkRules("project_id>projects party_id>project_parties"),
  recently_viewed_docs: fkRules("document_id>documents"),
  revision_branches: fkRules("document_id>documents branch_version_id>document_versions diverged_from_version_id>document_versions"),
  systems: fkRules("unit_id>units plant_id>plants"),
  table_views: fkRules("library_id>libraries collection_id>collections"),
  team_members: fkRules("team_id>teams"),
  ticket_comments: fkRules("ticket_id>tickets"),
  transmittals: fkRules("project_id>projects"),
  turnover_items: fkRules("project_id>projects party_id>project_parties document_id>documents"),
  units: fkRules("plant_id>plants"),
  work_package_documents: fkRules("package_id>work_packages document_id>documents pinned_version_id>document_versions"),
  work_package_prints: fkRules("package_id>work_packages"),
};

/** Parents WITHOUT an org_id column that a restorable foreign key names, and
 *  why no workspace check applies (the census test requires an entry here for
 *  every such parent). */
export const RESTORE_FK_PARENT_WAIVERS: Readonly<Record<string, string>> = {
  orgs: "the org_id column itself — forced to the target workspace by bindRestoredRow",
  users: "a person's profile, not a workspace's row, so no workspace check applies; the uid is remapped by the email reconciliation, and RESTORE_USER_REFERENCES reads users for every uid these columns name — a restored placeholder has NO users row (users.id references auth.users), so it is cleared from a nullable column and refuses a team membership (person_not_restored). The membership row itself is bounded by its team_id (checked)",
};

/** Foreign keys of restorable tables onto `users` — a person's profile row,
 *  which exists only for a sign-in account (users.id REFERENCES auth.users).
 *  A restored placeholder (an email this workspace has no member for) is
 *  minted with a fresh uid that is no sign-in account, so /begin cannot give
 *  it a users row and the database would refuse every row naming it (23503).
 *  The restore reads `users` for every uid these columns name before the
 *  write: a uid with no profile is CLEARED from a nullable column (the row
 *  lands; reported) and REFUSES the row when the column is required (a team
 *  membership needs the person; reported as person_not_restored).
 *  lib/__tests__/dataRestore.test.ts derives every foreign key onto users from
 *  supabase/ and fails when one is missing here or `required` disagrees with
 *  the column's NOT NULL. */
export const RESTORE_USER_REFERENCES: Readonly<Record<string, ReadonlyArray<{ column: string; required: boolean }>>> = {
  teams: [{ column: "created_by", required: false }],
  team_members: [{ column: "uid", required: true }, { column: "added_by", required: false }],
};

/** The users-FK columns `table`'s restored rows carry. */
export function restoreUserReferencesFor(table: string): ReadonlyArray<{ column: string; required: boolean }> {
  return has(RESTORE_USER_REFERENCES, table) ? RESTORE_USER_REFERENCES[table] : [];
}

/** Columns the database COMPUTES (GENERATED ALWAYS … STORED). Postgres
 *  refuses any non-DEFAULT value for one (428C9 — not a row-level code, so it
 *  would stop the run), and the export carries them (select("*")). A restored
 *  row never sends one: the database recomputes it from the row.
 *  lib/__tests__/dataRestore.test.ts censuses supabase/ for GENERATED ALWAYS
 *  columns and fails when a restorable table's is missing here. */
export const RESTORE_GENERATED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  knowledge_chunks: ["tsv"],                // 20261007_rag_hardening.sql
  knowledge_questions: ["search_tsv"],      // 20260806 / 20261123
};

/** The parent rules `table`'s restored rows must honour. */
export function restoreParentRulesFor(table: string): ReadonlyArray<RestoreParentRule> {
  return has(RESTORE_PARENT_RULES, table) ? RESTORE_PARENT_RULES[table] : [];
}

/** A self-referencing table's rows, parents first (a version before the one
 *  that supersedes it, a folder before its sub-folder), so a chunked restore
 *  never writes a child before the row it names. Stable otherwise; a cycle is
 *  broken where it closes. Pure; returns a new array. */
export function restoreRowsInOrder(table: string, rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  const selfCols = restoreParentRulesFor(table).filter((r) => r.parent === table).map((r) => r.column);
  if (selfCols.length === 0 || rows.length < 2) return [...rows];
  const byId = new Map<string, number>();
  rows.forEach((r, i) => { if (typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, i); });
  const state = new Uint8Array(rows.length); // 0 unseen · 1 on the path · 2 placed
  const out: Array<Record<string, unknown>> = [];
  for (let start = 0; start < rows.length; start++) {
    if (state[start] !== 0) continue;
    const stack = [start];
    while (stack.length > 0) {
      const i = stack[stack.length - 1];
      if (state[i] === 0) {
        state[i] = 1;
        for (const c of selfCols) {
          const v = rows[i][c];
          const p = typeof v === "string" ? byId.get(v) : undefined;
          if (p !== undefined && state[p] === 0) stack.push(p);
        }
      } else {
        stack.pop();
        if (state[i] === 1) { state[i] = 2; out.push(rows[i]); }
      }
    }
  }
  return out;
}

/** Why `table` may not be written by a restore, or null when it may. The
 *  messages are the chunked route's; since fix pass 3 a skipped table's
 *  names its reason (not every skipped table is reconciled — the mail queue
 *  is never restored at all). */
export function restoreTableRefusal(table: string): string | null {
  if (!table || !isRestoreContractTable(table)) return `Table "${table}" is not part of the backup contract.`;
  if (isImmutableTable(table)) {
    // SURF-8: append-only / self-insert-only tables cannot be blind-imported.
    return `Table "${table}" is append-only (${IMMUTABLE_TABLES[table]}); it is never restored by import.`;
  }
  if (has(SKIP_TABLES, table)) return `Table "${table}" is never blind-imported (${SKIP_TABLES[table]}).`;
  return null;
}

/** FORCE the org boundary on a remapped row: whatever the backup (or a
 *  hostile client) claims, a restored row belongs to the authorized
 *  workspace. Set even when the row omits the key, so a hand-made row cannot
 *  land with a NULL or defaulted org. Org-less tables are bound by their
 *  parent instead (ORG_LESS_RESTORE_PARENTS). Returns a new object. */
export function bindRestoredRow(table: string, row: Record<string, unknown>, orgId: string): Record<string, unknown> {
  if (has(ORG_LESS_RESTORE_PARENTS, table)) return row;
  return { ...row, org_id: orgId };
}

/** How a restored row lands. admin-and-org BKP-11 (restore half): a
 *  restored export destination lands INERT whatever the backup row carries —
 *  disabled, with no next run (the scheduler selects only enabled rows with a
 *  due next_run_at) and with every credential column null, even when the row
 *  omits the keys (scrubRestoredRow only sees the columns a row carries). An
 *  Admin re-enters credentials and re-saves the schedule before it can fire
 *  again. BKP-5 (fix pass 2): a column the database computes
 *  (RESTORE_GENERATED_COLUMNS) is left out, so the database recomputes it.
 *  Returns a new object when it changes anything. */
export function landRestoredRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  let out = row;
  if (has(RESTORE_GENERATED_COLUMNS, table) && RESTORE_GENERATED_COLUMNS[table].some((c) => has(row, c))) {
    out = { ...row };
    for (const c of RESTORE_GENERATED_COLUMNS[table]) delete out[c];
  }
  if (table !== "export_destinations") return out;
  out = { ...out, enabled: false, next_run_at: null };
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

interface BackupMember { uid?: unknown; email?: unknown; display_name?: string; role?: string; roles?: string[] | null; status?: string | null }

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
  // Any membership status links (fix pass 3): a re-run finds the placeholder
  // the first run created. One address with several rows: the earliest
  // status in RESTORE_LINK_MEMBER_STATUSES wins, then the first row given.
  const statusRank = (st: string | null | undefined) => {
    const i = RESTORE_LINK_MEMBER_STATUSES.indexOf(st ?? "active");
    return i === -1 ? RESTORE_LINK_MEMBER_STATUSES.length : i;
  };
  const existingByEmail = new Map<string, { uid: string; status: string }>(); // email -> member
  const existingByUid = new Map<string, string>(); // uid -> status (fix pass 5)
  for (const m of current.members) {
    if (m.uid && !existingByUid.has(m.uid)) existingByUid.set(m.uid, m.status ?? "active");
    if (!m.email) continue;
    const k = norm(m.email);
    const held = existingByEmail.get(k);
    if (!held || statusRank(m.status) < statusRank(held.status)) existingByEmail.set(k, { uid: m.uid, status: m.status ?? "active" });
  }

  const members = ((env.tables.org_members as BackupMember[] | undefined) ?? []).filter((m): m is BackupMember => !!m && typeof m === "object");
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  // admin-and-org P1 (fix pass 5): EVERY backup uid is mapped, or the rows
  // naming it are refused — an uid left out of the map landed its rows
  // naming the raw backup uid. One person per address: the export carries
  // every membership row, and one address may hold several, each under its
  // own uid (20261018 allows an inactive historical row beside a re-added
  // one). The row with the earliest status in RESTORE_LINK_MEMBER_STATUSES
  // (then the first given) speaks for the person; every other row's uid is
  // an ALIAS mapped to the same person. A uid is given to one person only.
  const ordered = members.map((m, i) => ({ m, i }))
    .sort((a, b) => statusRank(a.m.status) - statusRank(b.m.status) || a.i - b.i)
    .map((x) => x.m);
  const byEmail = new Map<string, UserReconcileItem>();
  const claimed = new Set<string>();
  const noAddress: BackupMember[] = [];
  const users: UserReconcileItem[] = [];
  for (const m of ordered) {
    const uid = text(m.uid);
    const email = norm(text(m.email));
    if (!email) { if (uid) noAddress.push(m); continue; }
    const own = uid && !claimed.has(uid) ? uid : "";
    if (own) claimed.add(own);
    const held = byEmail.get(email);
    if (held) {
      if (own && !held.oldUid) held.oldUid = own;
      else if (own) (held.aliasUids ??= []).push(own);
      continue;
    }
    const existing = existingByEmail.get(email);
    const item: UserReconcileItem = {
      oldUid: own,
      email: text(m.email).trim(),
      displayName: m.display_name,
      role: m.role,
      roles: Array.isArray(m.roles) ? m.roles.filter((r): r is string => typeof r === "string") : undefined,
      disposition: existing ? "linked" : "new",
      newUid: existing?.uid,
      ...(existing ? { linkedStatus: existing.status } : {}),
    };
    byEmail.set(email, item);
    users.push(item);
  }
  // A backup member with NO address cannot be matched by address. When this
  // workspace has a member under that very uid (a restore into the same
  // workspace), it is that person and is linked to them; otherwise no person
  // here can be found for it, and every row naming it is refused
  // (person_not_mapped) — never written naming the raw backup uid.
  const unmapped: Array<{ uid: string; displayName?: string }> = [];
  for (const m of noAddress) {
    const uid = text(m.uid);
    if (claimed.has(uid)) continue;
    claimed.add(uid);
    const here = existingByUid.get(uid);
    if (here === undefined) { unmapped.push({ uid, displayName: m.display_name }); continue; }
    users.push({
      oldUid: uid, email: "", displayName: m.display_name, role: m.role,
      roles: Array.isArray(m.roles) ? m.roles.filter((r): r is string => typeof r === "string") : undefined,
      disposition: "linked", newUid: uid, linkedStatus: here,
    });
  }

  const idRemap: RestorePlan["idRemap"] = {
    orgId: { [backupOrgId]: targetOrgId } as Record<string, string>,
    uid: {} as Record<string, string>,
  };
  for (const u of users) {
    if (u.disposition !== "linked" || !u.newUid) continue;
    for (const old of [u.oldUid, ...(u.aliasUids ?? [])]) if (old) idRemap.uid[old] = u.newUid;
  }
  if (unmapped.length > 0) idRemap.unmappedUids = unmapped.map((x) => x.uid);

  // ── Per-table import plan ────────────────────────────────────────────────
  const tables: TablePlanItem[] = [];
  let totalRows = 0;
  for (const [name, rows] of Object.entries(env.tables)) {
    const n = Array.isArray(rows) ? rows.length : 0;
    // SURF-8: immutable tables are never planned in. ORG-1: neither is any
    // name the envelope carries that is not on the backup contract.
    const offContract = !isRestoreContractTable(name) && !has(SKIP_TABLES, name) && !has(IMMUTABLE_TABLES, name);
    const skip = skipReasonFor(name) ?? (offContract ? OFF_CONTRACT_REASON : undefined);
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
  if (members.length === 0) {
    warnings.push("No members found in the backup (org_members empty) — users cannot be reconciled.");
  }
  if (unmapped.length > 0) {
    const names = unmapped.slice(0, 5).map((x) => x.displayName?.trim() || x.uid).join(", ");
    warnings.push(
      `${unmapped.length} backup member(s) have no email address and no membership here under the same id (${names}${unmapped.length > 5 ? ", …" : ""}). ` +
      "A person is matched by address, so they cannot be mapped to anyone in this workspace: every record naming one is refused, reported row by row. " +
      "Add their address to the backup's org_members and restore again to bring those records back.",
    );
  }

  const matchedUsers = users.filter((u) => u.disposition === "linked").length;
  // Exactly the placeholders /begin and /apply create (fix pass 5: the
  // page's confirm states this count) — a person with no backup uid of their
  // own names no row, so none is made for them.
  const newUsers = users.filter((u) => u.disposition === "new" && u.oldUid).length;

  return {
    schemaVersion: env.manifest.schemaVersion,
    targetOrgId,
    orgNameCollision,
    users,
    idRemap,
    counts: {
      matchedUsers,
      newUsers,
      unmappedUsers: unmapped.length,
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
    if (k === "org_id" && typeof v === "string" && has(idRemap.orgId, v) && idRemap.orgId[v]) {
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

// ORG-1 (fix pass 2): a storage key names the workspace that owns the object
// ("orgs/<org uuid>/…"). remapOrgPath moves the BACKUP org's prefix to the
// target; any other org's prefix left in a restored row would name another
// tenant's object, and readers that resolve a stored key with the service
// role (lib/docFileServer.ts serves document_versions.file_url) do not check
// the prefix. Such a row is refused.
const STORAGE_ORG_PREFIX = /(?:^|[^0-9a-z])orgs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//gi;

/** The first string in `value` (top level or deep inside JSONB) carrying a
 *  storage key under an org prefix other than `orgId`'s, or null. Pure. */
export function foreignStorageKey(value: unknown, orgId: string): { org: string; value: string } | null {
  const mine = orgId.toLowerCase();
  if (typeof value === "string") {
    if (!value.includes("orgs/")) return null;
    for (const m of value.matchAll(STORAGE_ORG_PREFIX)) {
      if (m[1].toLowerCase() !== mine) return { org: m[1].toLowerCase(), value };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) { const hit = foreignStorageKey(v, orgId); if (hit) return hit; }
    return null;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) { const hit = foreignStorageKey(v, orgId); if (hit) return hit; }
  }
  return null;
}

function deepRemapValues(value: unknown, uidMap: Record<string, string>, orgPairs: Array<[string, string]>): unknown {
  if (typeof value === "string") {
    const mapped = has(uidMap, value) ? uidMap[value] : undefined;
    if (typeof mapped === "string" && mapped) return mapped;
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
  return has(SKIP_TABLES, table) || has(IMMUTABLE_TABLES, table);
}

/** Why a table is never blind-imported, for the plan review. */
export function skipReasonFor(table: string): string | null {
  if (has(SKIP_TABLES, table)) return SKIP_TABLES[table];
  if (has(IMMUTABLE_TABLES, table)) return IMMUTABLE_TABLES[table];
  return null;
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
// admin-and-org Round G (P1 fix pass): lib/__tests__/dataRestore.test.ts
// derives every FOREIGN KEY from supabase/ and fails when a parent sits at or
// after its child here — the restore stops at the first failed table, so an
// inverted pair would stop every restore of an org that uses it. A table that
// references itself (versions, folders, milestones, message threads) has its
// rows ordered parents-first by restoreRowsInOrder.
export const RESTORE_TABLE_ORDER: string[] = [
  "archive_settings", "archives",
  // Teams before libraries: a library's owner_team_id references teams (20261045).
  "teams", "team_members",
  "libraries", "collections", "curated_collections",
  // A library's document counter before the documents numbered from it (it
  // references only its library): a counter that cannot be advanced stops
  // the run before any of them lands (RESTORE_COUNTER_COLUMNS, fix pass 6).
  "library_numbering",
  "metadata_templates", "watermark_policies",
  "plants", "units", "systems",
  // Codebook before assets/documents: entries carry no FKs beyond org, and
  // restored assets/suggestions read cleaner with the vocabulary in place.
  "codebook_entries", "codebook_config",
  "asset_types", "assets", "asset_photos",
  // Sets hang off a library and documents.set_id references them.
  "document_sets",
  "documents", "document_versions", "document_supersessions",
  // Projects after documents: projects.sow_document_id references documents (20261013).
  "projects", "project_members",
  // Tickets before the holds and milestones that cite them (origin_ticket_id,
  // linked_ticket_id); a ticket references nothing but its org.
  "ticket_number_counters", "tickets",
  "document_holds", "document_assets", "document_shares",
  "document_equipment_suggestions",
  // Knowledge layer (intelligence ILIFE-2 / I-01 phase B): a knowledge
  // document may mirror a controlled document (source_document_id), and
  // process_flows / entity_mentions below reference knowledge documents.
  "knowledge_libraries", "knowledge_library_links", "knowledge_sources", "knowledge_documents",
  // Intelligence layer: instructions have no doc FKs (early is fine);
  // related/recents/asks reference documents so they come after. The
  // library numbering counter sits with the libraries, above.
  "org_ai_instructions",
  "document_related_resources", "recently_viewed_docs",   "project_intake_links",
  // Link discovery: aliases hang off assets, proposals off documents —
  // both already restored above. Connection Skills only reference the org,
  // so anywhere works; they ride with their consumers.
  "asset_aliases", "proposed_links", "link_rules", "answer_skills",
  // Flows may reference knowledge documents (source PFD), restored above.
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
  "ticket_comments",
  // An episode before the sessions and messages that name it (episode_id).
  "checkout_episodes", "checkout_sessions", "checkout_messages",
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
  "knowledge_chunks", "knowledge_page_entities",
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
  return has(CONFLICT_TARGETS, table) ? CONFLICT_TARGETS[table] : "id";
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
  return {
    orgId: { ...idRemap.orgId }, uid: { ...idRemap.uid, ...created },
    ...(idRemap.unmappedUids?.length ? { unmappedUids: [...idRemap.unmappedUids] } : {}),
  };
}

/** Give a restored placeholder its profile row, if the database lets it.
 *  False when it refuses — always, for a fresh uid that is no sign-in account
 *  (users.id references auth.users) — or the call fails: both restore routes
 *  count and report it (fix pass 2; it was swallowed). */
export async function placeholderProfile(sb: Pick<SupabaseClient, "from">, uid: string, email: string, displayName?: string | null): Promise<boolean> {
  try {
    const { error } = await sb.from("users").upsert({ id: uid, email, display_name: displayName ?? null });
    return !error;
  } catch {
    return false;
  }
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
   *  conflict target — usually its id) already exists IN THIS WORKSPACE. That
   *  row is kept exactly as it is: a restore only adds, it never overwrites
   *  or repairs (a numbering counter excepted — raised, never lowered, and
   *  counted as `advanced`). */
  existing: number;
  /** BKP-5 (fix pass): rows NOT written because their key is held by a row of
   *  ANOTHER workspace on this deployment (ids are preserved, so a backup
   *  restored beside its still-live source org collides with it). Nothing of
   *  these was restored here. */
  heldElsewhere: number;
  /** Rows the database wrote or skipped without reporting a count — honest
   *  "unknown", never assumed written. */
  uncounted: number;
  /** Rows not written, each with its reason (a database refusal of that single
   *  row, a parent that is not a row of this workspace, a person with no
   *  sign-in account, a storage key under another workspace's prefix). */
  refused: RestoreRowRefusal[];
  /** Rows WRITTEN with one nullable pointer cleared, each with the column and
   *  why (a person with no sign-in account; an owner team or SOW document
   *  that is not a row of this workspace). Fix pass 3: emitted only once the
   *  statement carrying the row is accepted — a row the database refuses is
   *  in `refused` alone, and a statement that fails the chunk reports no
   *  clear for its rows. Fix pass 5: and only for a row that statement
   *  WROTE — not for a copy ON CONFLICT DO NOTHING skipped because an
   *  earlier row of the request carries its key, and not for a row of a
   *  statement the server gave no count for (that row is `uncounted`). */
  cleared: RestoreRowRefusal[];
  /** admin-and-org P1 (fix pass 5): numbering counters this workspace
   *  already held that were ADVANCED to the backup's higher value
   *  (RESTORE_COUNTER_COLUMNS) — never lowered, nothing else changed. */
  advanced: number;
  /** Rows left after the restore's own filters (comments of a ticket archived
   *  since the backup are dropped). */
  rowsAfterFilters: number;
  /** Rows dropped by those filters — counted, never silently lost. */
  filtered: number;
}

/** admin-and-org P1 (fix pass 5): numbering counters, by table → the counter
 *  column. A restored record keeps the number it was issued
 *  (tickets.ticket_id, documents.document_number — neither is unique), so a
 *  counter row this workspace already holds, which an additive restore keeps
 *  as it is, would hand out numbers the restored records already carry. The
 *  restore ADVANCES such a counter to the backup's value when that is higher
 *  — a checked, guarded update (`counter < backup`) that can never lower it
 *  or change anything else. Both counters are monotonic in the same sense in
 *  the backup and here: next_ticket_number (20260724) stores the last number
 *  issued for (org, year); issue_document_number (20260806) the next one to
 *  issue for the library.
 *  Fix pass 6 — the trade-off: the raise is unconditional, but the prefix is
 *  not restored (orgs.ticket_prefix; an existing library_numbering row keeps
 *  its prefix), so a restore into a workspace whose prefix differs from the
 *  backup's leaves a GAP in this workspace's sequence (KE-DDRT-26-0006 …
 *  -0150 never issued). A gap is preferred to a number issued twice. */
export const RESTORE_COUNTER_COLUMNS: Readonly<Record<string, string>> = {
  ticket_number_counters: "next_seq",
  library_numbering: "next_number",
};

/** admin-and-org P1 (fix pass 6): the table whose records each counter
 *  numbers. RESTORE_TABLE_ORDER places every counter before it, so a counter
 *  that cannot be advanced stops the run before any record numbered from it
 *  lands (lib/__tests__/restoreApplyRoute.test.ts pins the order). */
export const RESTORE_COUNTER_NUMBERS: Readonly<Record<string, string>> = {
  ticket_number_counters: "tickets",
  library_numbering: "documents",
};

/** The first uid of `uids` that `value` names (top level or deep inside JSONB), or null. */
function namedUid(value: unknown, uids: ReadonlySet<string>): string | null {
  if (typeof value === "string") return uids.has(value) ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) { const hit = namedUid(v, uids); if (hit) return hit; }
    return null;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) { const hit = namedUid(v, uids); if (hit) return hit; }
  }
  return null;
}

/** SQLSTATEs that are a fact about ONE row — class 23, integrity constraint
 *  violation: not null (23502), foreign key (23503), unique (23505), check
 *  (23514), exclusion (23P01). A statement refused with one is bisected down
 *  to the rows the database refuses, which are reported (`refused`) while
 *  every other row lands — one duplicate (a mention re-indexed under a new id
 *  since the backup), one orphan, one row a trigger refuses (HLD-9) never
 *  sinks its chunk, its table or the run. Any other failure (a missing
 *  column, a lost connection, a permission) stops the chunk. */
export const ROW_LEVEL_SQLSTATES: ReadonlySet<string> = new Set(["23502", "23503", "23505", "23514", "23P01"]);

const conflictCols = (table: string): string[] => conflictTargetFor(table).split(",").map((c) => c.trim());
const isKeyValue = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";
/** A row's conflict-key identity, or null when a key column is unset (a defaulted id: always new). */
function restoreKeyOf(table: string, row: Record<string, unknown>): string | null {
  const cols = conflictCols(table);
  return cols.every((c) => isKeyValue(row[c])) ? cols.map((c) => String(row[c])).join("\u0000") : null;
}

/** A readable identity for a row in a report — its id, or its conflict-key values. */
export function restoreRowLabel(table: string, row: Record<string, unknown>): string | null {
  if (typeof row.id === "string") return row.id;
  const parts = conflictCols(table).map((c) => row[c]);
  return parts.every(isKeyValue) ? parts.join("/") : null;
}

/** admin-and-org BKP-15: the code a process flow carries when the database
 *  refuses it because one of its ends names no equipment of the workspace
 *  (or no Site Codebook unit) — 20261155's process_flows_guard, which binds
 *  every writer, the restore included. Such a flow was already dangling in
 *  the backup (a flow kept by DEC-80 item 3 when the guard was pasted), or
 *  its equipment was not restored here. It is reported as what it is, apart
 *  from the rows the database refused for a real fault. */
export const DANGLING_FLOW_CODE = "flow_endpoint_missing";

/** BKP-15: a refusal's restore code — the database's SQLSTATE, except a
 *  process flow refused by the endpoint check, which is a dangling flow. */
export function restoreRefusalCode(table: string, code: string, message: string): string {
  return table === "process_flows" && code === "23503" && /^process_flows_endpoint:/.test(message) ? DANGLING_FLOW_CODE : code;
}

/** BKP-15: is this refusal a dangling process flow (reported on its own line)? */
export function isDanglingFlowRefusal(r: Pick<RestoreRowRefusal, "code">): boolean {
  return r.code === DANGLING_FLOW_CODE;
}

/** What a refusal code means, for the restore page. */
export function restoreRefusalLabel(code: string): string {
  switch (code) {
    case DANGLING_FLOW_CODE: return "a process flow whose equipment or unit is not in this workspace — not restored (it was dangling in the backup, or its equipment was not restored here)";
    case "parent_outside_workspace": return "points at a row that is not in this workspace";
    case "23505": return "a unique key it carries is already in use";
    case "23503": return "references a row that is not there";
    case "23514": return "refused by a database check";
    case "23502": return "a required value is missing";
    case "23P01": return "overlaps an existing row";
    case "person_not_restored": return "names a person with no sign-in account yet (a restored placeholder) — re-invite them";
    case "person_not_mapped": return "names a backup member with no email address, whom the restore cannot map to a person of this workspace";
    case "storage_key_outside_workspace": return "carries a storage key under another workspace's prefix";
    default: return code;
  }
}

/** The ids among `ids` that are `parent` rows of `orgId`. */
async function idsInWorkspace(sb: RestoreDb, parent: string, orgId: string, ids: string[]): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: string }> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from(parent).select("id").in("id", ids.slice(i, i + 200)).eq("org_id", orgId);
    if (error) return { ok: false, error: error.message };
    for (const p of ((data ?? []) as Array<{ id: string }>)) out.add(p.id);
  }
  return { ok: true, ids: out };
}

/** The ids among `ids` that a row of `table` holds ANYWHERE on the deployment. */
async function idsTaken(sb: RestoreDb, table: string, ids: string[]): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: string }> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from(table).select("id").in("id", ids.slice(i, i + 200));
    if (error) return { ok: false, error: error.message };
    for (const p of ((data ?? []) as Array<{ id: string }>)) out.add(p.id);
  }
  return { ok: true, ids: out };
}

const KEY_PAGE = 1000;

/** BKP-12 (fix pass 2): the most write statements one restore request spends
 *  isolating rows the database refuses. Bisection costs ~2·k·log2(n/k)
 *  statements for k refused rows of n, so a chunk where EVERY row is refused
 *  (a NOT NULL column the backup lacks) would cost 2n-1; past this budget the
 *  rows of a refused statement are reported refused together, with the
 *  database's code and message, and a re-run retries them. */
export const RESTORE_BISECT_MAX_STATEMENTS = 100;

/** BKP-5 (fix pass): where the rows' keys are held now — by a row of THIS
 *  workspace, or by a row of another workspace on the same deployment.
 *  Read-only. A composite key is filtered on EVERY key column and read page by
 *  page until an empty page (so a server row cap below the page size cannot
 *  cut it short); a single-column key is unique, so one read per batch holds
 *  every match. An org-less table's row belongs to the workspace of its
 *  bounding parent (ORG_LESS_RESTORE_PARENTS). */
async function locateRestoreKeys(
  sb: RestoreDb, table: string, orgId: string, rows: ReadonlyArray<Record<string, unknown>>,
): Promise<{ ok: true; here: Set<string>; elsewhere: Set<string> } | { ok: false; error: string }> {
  const cols = conflictCols(table);
  const bound = has(ORG_LESS_RESTORE_PARENTS, table) ? ORG_LESS_RESTORE_PARENTS[table] : null;
  const owner = bound ? bound.column : "org_id";
  const select = Array.from(new Set([...cols, owner])).join(",");
  const keyed = rows.filter((r) => restoreKeyOf(table, r) !== null);
  const single = cols.length === 1;
  const batch = single ? 200 : 100;
  const found: Array<Record<string, unknown>> = [];
  for (let i = 0; i < keyed.length; i += batch) {
    const slice = keyed.slice(i, i + batch);
    const wanted = new Set(slice.map((r) => restoreKeyOf(table, r) as string));
    for (let from = 0; ;) {
      let q = sb.from(table).select(select);
      for (const c of cols) q = q.in(c, Array.from(new Set(slice.map((r) => r[c] as string | number))));
      if (!single) for (const c of cols) q = q.order(c);
      const { data, error } = single ? await q : await q.range(from, from + KEY_PAGE - 1);
      if (error) return { ok: false, error: error.message };
      const page = (data ?? []) as unknown as Array<Record<string, unknown>>;
      for (const row of page) {
        const k = restoreKeyOf(table, row);
        if (k !== null && wanted.has(k)) found.push(row);
      }
      if (single || page.length === 0) break;
      from += page.length;
    }
  }
  const here = new Set<string>();
  const elsewhere = new Set<string>();
  let mine: Set<string> | null = null;
  if (bound) {
    const parents = Array.from(new Set(found.map((r) => r[bound.column]).filter((v): v is string => typeof v === "string")));
    const res = await idsInWorkspace(sb, bound.parent, orgId, parents);
    if (!res.ok) return { ok: false, error: res.error };
    mine = res.ids;
  }
  for (const row of found) {
    const k = restoreKeyOf(table, row) as string;
    const ours = mine ? typeof row[owner] === "string" && mine.has(row[owner] as string) : row.org_id === orgId;
    (ours ? here : elsewhere).add(k);
  }
  return { ok: true, here, elsewhere };
}

/** Write one slice of one table into `orgId` additively (existing keys are
 *  skipped). Never throws for a database refusal; the caller answers with
 *  `status` / `error` when `ok` is false. Order of rules:
 *    1. the table must be on the backup contract and not reconciled / append-only;
 *    2. every row is remapped (uids, org paths, bearer scrub), bound to `orgId`
 *       and landed (export destinations inert; computed columns left out);
 *    3. comments of a ticket archived since the backup are dropped;
 *    4. before the write, each row is checked for what it carries, whom it
 *       names and what it points at: a storage key under another workspace's
 *       prefix refuses it; a person with no sign-in account (users) refuses a
 *       required column and is cleared from a nullable one
 *       (RESTORE_USER_REFERENCES); every foreign key to an org-scoped table
 *       must name a row of this workspace (RESTORE_PARENT_RULES — an org-less
 *       row's bounding parent is required; a `clearWhenMissing` pointer is
 *       cleared instead). A row these rules would refuse or clear whose key is
 *       already held — here or by another workspace — is never written either
 *       way, so it is counted as existing / held elsewhere, not refused;
 *    5. upsert on the table's real conflict target; a statement refused for
 *       one row's sake (ROW_LEVEL_SQLSTATES) is bisected to that row, within
 *       RESTORE_BISECT_MAX_STATEMENTS per request;
 *    6. skipped keys are split into kept-here and held-by-another-workspace. */
export async function applyRestoreChunk(
  sb: RestoreDb,
  params: { orgId: string; table: string; rows: ReadonlyArray<Record<string, unknown>>; idRemap: RestorePlan["idRemap"] },
): Promise<RestoreChunkResult> {
  const { orgId, table, idRemap } = params;
  const refused: RestoreRowRefusal[] = [];
  const cleared: RestoreRowRefusal[] = [];
  let existing = 0;
  let heldElsewhere = 0;
  let uncounted = 0;
  let advanced = 0;
  const fail = (status: number, error: string, inserted = 0, rowsAfterFilters = 0, code?: string | null): RestoreChunkResult =>
    ({ ok: false, status, error, ...(code ? { code: String(code) } : {}), inserted, existing, heldElsewhere, uncounted, refused, cleared, advanced, rowsAfterFilters, filtered: params.rows.length - rowsAfterFilters });

  const refusal = restoreTableRefusal(table);
  if (refusal) return fail(400, refusal, 0, params.rows.length);
  if (!orgId) return fail(400, "No target workspace.", 0, params.rows.length);

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
      if (error) return fail(500, `Could not check for archived tickets: ${error.message}`, 0, params.rows.length);
      for (const t of ((data ?? []) as Array<{ id: string }>)) archived.add(t.id);
    }
    if (archived.size) mapped = mapped.filter((r) => !archived.has(r.ticket_id as string));
  }
  const rowsAfterFilters = mapped.length;

  // ── 4. Before the write: what a row carries, whom it names, what it points at.
  // A rule that cannot read what it needs fails the chunk closed — nothing is
  // written on a guess.
  const label = (r: Record<string, unknown>) => restoreRowLabel(table, r);
  /** Refusals that do not depend on other rows of the chunk (reported after
   *  a parent refusal of the same row: the workspace boundary comes first). */
  const storageRefusal = new Map<Record<string, unknown>, RestoreRowRefusal>();
  const personRefusal = new Map<Record<string, unknown>, RestoreRowRefusal>();
  /** Nullable columns to clear on a row that is written, with the note. */
  const clears = new Map<Record<string, unknown>, Array<{ column: string; note: RestoreRowRefusal }>>();
  const addClear = (r: Record<string, unknown>, column: string, code: string, message: string) => {
    if (!clears.has(r)) clears.set(r, []);
    clears.get(r)!.push({ column, note: { id: label(r), code, message } });
  };

  // (a) ORG-1 (fix pass 2): a storage key under another workspace's prefix.
  for (const r of mapped) {
    const hit = foreignStorageKey(r, orgId);
    if (hit) {
      storageRefusal.set(r, {
        id: label(r), code: "storage_key_outside_workspace",
        message: `carries the storage key "${hit.value.length > 160 ? `${hit.value.slice(0, 160)}…` : hit.value}" under another workspace's prefix (orgs/${hit.org}/)`,
      });
    }
  }

  // (a2) admin-and-org P1 (fix pass 5): a backup member the reconciliation
  // could not map to any person here (no email address, no member under
  // that uid — RestorePlan.idRemap.unmappedUids). The remap leaves such a uid
  // as it is, so the row would land naming the raw backup uid, which may be a
  // live person of another workspace on this deployment. Refused, top level
  // or deep inside JSONB, like the remap itself.
  const unmappedUids = new Set((Array.isArray(idRemap.unmappedUids) ? idRemap.unmappedUids : [])
    .filter((v): v is string => typeof v === "string" && v.length > 0 && !has(idRemap.uid, v)));
  const unmappedRefusal = new Map<Record<string, unknown>, RestoreRowRefusal>();
  if (unmappedUids.size) {
    for (const r of mapped) {
      const hit = namedUid(r, unmappedUids);
      if (hit) {
        unmappedRefusal.set(r, {
          id: label(r), code: "person_not_mapped",
          message: `names ${hit}, a backup member with no email address and no membership here — the restore cannot map them to a person of this workspace`,
        });
      }
    }
  }

  // (b) BKP-5 (fix pass 2): a person with no sign-in account. A restored
  // placeholder has no users row (users.id references auth.users), so the
  // database would refuse every row naming it.
  const userRefs = restoreUserReferencesFor(table);
  if (userRefs.length && mapped.length) {
    const uids = new Set<string>();
    for (const r of mapped) for (const ref of userRefs) { const v = r[ref.column]; if (typeof v === "string" && v) uids.add(v); }
    const profiles = await idsTaken(sb, "users", Array.from(uids));
    if (!profiles.ok) return fail(500, `Could not check the people these ${table} rows name: ${profiles.error}`, 0, rowsAfterFilters);
    for (const r of mapped) {
      for (const ref of userRefs) {
        const v = r[ref.column];
        if (typeof v !== "string" || !v || profiles.ids.has(v)) continue;
        if (ref.required) {
          personRefusal.set(r, {
            id: label(r), code: "person_not_restored",
            message: `${ref.column} ${v} has no sign-in account on this deployment (a restored placeholder) — re-invite the person, then add them again`,
          });
          clears.delete(r);
          break;
        }
        addClear(r, ref.column, "person_not_restored", `${ref.column} ${v} cleared: no sign-in account on this deployment (a restored placeholder)`);
      }
    }
  }

  // (c) ORG-1 / BKP-3: a restored row is bounded by what it POINTS AT, not
  // only by its org. Every parent a row names through a foreign key is read in
  // THIS workspace (FK order restores parents first); a row naming one that
  // is elsewhere — or missing — is refused, never written. An org-less row's
  // bounding parent is required (BKP-3 Done-when 3). A `clearWhenMissing`
  // pointer is cleared instead of refusing the row.
  const rules = restoreParentRulesFor(table);
  const inWorkspace = new Map<string, Set<string>>();
  const newHere = new Set<string>();
  if (rules.length && mapped.length) {
    const wanted = new Map<string, Set<string>>();
    for (const r of mapped) {
      for (const rule of rules) {
        const v = r[rule.column];
        if (typeof v !== "string" || !v) continue;
        if (!wanted.has(rule.parent)) wanted.set(rule.parent, new Set());
        wanted.get(rule.parent)!.add(v);
      }
    }
    for (const [parent, ids] of wanted) {
      const res = await idsInWorkspace(sb, parent, orgId, Array.from(ids));
      if (!res.ok) return fail(500, `Could not check the ${parent} rows these ${table} rows belong to: ${res.error}`, 0, rowsAfterFilters);
      inWorkspace.set(parent, res.ids);
    }
    // A self-reference may name a row of this same chunk (rows are ordered
    // parents-first): it counts once that id is new to the deployment — an id
    // another workspace holds is skipped by the write, and a child naming it
    // would point there.
    const selfIds = wanted.get(table);
    if (selfIds) {
      const chunkIds = new Set(mapped.map((r) => r.id).filter((v): v is string => typeof v === "string"));
      const here = inWorkspace.get(table) ?? new Set<string>();
      const candidates = Array.from(selfIds).filter((id) => chunkIds.has(id) && !here.has(id));
      if (candidates.length) {
        const taken = await idsTaken(sb, table, candidates);
        if (!taken.ok) return fail(500, `Could not check the ${table} rows these rows belong to: ${taken.error}`, 0, rowsAfterFilters);
        for (const id of candidates) if (!taken.ids.has(id)) newHere.add(id);
      }
    }
  }
  const bound = has(ORG_LESS_RESTORE_PARENTS, table) ? ORG_LESS_RESTORE_PARENTS[table] : null;
  const parentHere = (rule: RestoreParentRule, v: unknown) =>
    typeof v === "string" && (inWorkspace.get(rule.parent)?.has(v) || (rule.parent === table && newHere.has(v)));
  const outside = (r: Record<string, unknown>): RestoreRowRefusal | null => {
    const storage = storageRefusal.get(r);
    if (storage) return storage;
    for (const rule of rules) {
      if (rule.clearWhenMissing) continue;
      const v = r[rule.column];
      const required = bound !== null && bound.column === rule.column;
      if ((v === null || v === undefined) && !required) continue;
      if (parentHere(rule, v)) continue;
      return {
        id: label(r),
        code: "parent_outside_workspace",
        message: `${rule.column} ${typeof v === "string" ? v : "(none)"} is not a ${rule.parent} row of this workspace`,
      };
    }
    // Fix pass 6: an unmapped backup member first — the row would name the
    // raw backup uid, which also has no profile here, and only this refusal
    // names the right remedy (an address in the backup's org_members).
    return unmappedRefusal.get(r) ?? personRefusal.get(r) ?? null;
  };
  // To a fixed point: a refused row's id no longer counts as a parent here.
  const refusedRows: Array<{ row: Record<string, unknown>; why: RestoreRowRefusal }> = [];
  for (let changed = true; changed;) {
    changed = false;
    mapped = mapped.filter((r) => {
      const why = outside(r);
      if (!why) return true;
      refusedRows.push({ row: r, why });
      if (typeof r.id === "string" && newHere.delete(r.id)) changed = true;
      return false;
    });
  }
  for (const r of mapped) {
    for (const rule of rules) {
      if (!rule.clearWhenMissing) continue;
      const v = r[rule.column];
      if (v === null || v === undefined || parentHere(rule, v)) continue;
      addClear(r, rule.column, "parent_outside_workspace", `${rule.column} ${typeof v === "string" ? v : String(v)} cleared: not a ${rule.parent} row of this workspace`);
    }
  }

  // A row refused or cleared above whose key is already held is never
  // written either way: kept here (existing) or held by another workspace —
  // counted as such, never reported as refused. When the keys cannot be read
  // the refusals stand (each is true of the row as it was sent).
  const flagged = [...refusedRows.map((x) => x.row), ...mapped.filter((r) => clears.has(r))];
  const settled = new Set<Record<string, unknown>>();
  let clearsLocated = true;
  if (flagged.length) {
    const where = await locateRestoreKeys(sb, table, orgId, flagged);
    clearsLocated = where.ok;
    if (where.ok) {
      for (const r of flagged) {
        const k = restoreKeyOf(table, r);
        if (k === null) continue;
        if (where.here.has(k)) { existing++; settled.add(r); }
        else if (where.elsewhere.has(k)) { heldElsewhere++; settled.add(r); }
      }
    }
  }
  for (const { row, why } of refusedRows) if (!settled.has(row)) refused.push(why);
  // Fix pass 3: a clear is reported only for a row the database took — the
  // note rides with the row and is emitted when the statement carrying it is
  // accepted, never for a row the write then refuses or a statement that
  // fails the chunk.
  const clearNotes = new Map<Record<string, unknown>, RestoreRowRefusal[]>();
  mapped = mapped.filter((r) => !settled.has(r)).map((r) => {
    const list = clears.get(r);
    if (!list) return r;
    const out = { ...r };
    for (const { column } of list) out[column] = null;
    clearNotes.set(out, list.map((x) => x.note));
    return out;
  });

  // BKP-12: the upsert's own refusal is the answer. There is no plain-insert
  // retry of a chunk the upsert already rejected — every conflict target is a
  // real key (census test). A refusal about ONE row (ROW_LEVEL_SQLSTATES) is
  // bisected down to that row, which is reported, within a statement budget;
  // anything else stops here.
  let inserted = 0;
  let skipped = 0;
  let bisectLeft = RESTORE_BISECT_MAX_STATEMENTS;
  const skippedPool: Array<Record<string, unknown>> = [];
  // Fix pass 5: keys of rows in statements the database accepted (written or
  // skipped), in the order sent. A cleared row's key was held by no row when
  // the keys were read above, so ON CONFLICT DO NOTHING can skip it only for
  // a row sent before it in this request with the same key (when that read
  // failed, a clear is reported only from a statement that wrote every row).
  const acceptedKeys = new Set<string>();
  const write = async (rows: Array<Record<string, unknown>>): Promise<{ error: string; code: string } | null> => {
    const up = await sb.from(table).upsert(rows, { onConflict: conflictTargetFor(table), ignoreDuplicates: true, count: "exact" });
    if (!up.error) {
      // count: "exact" reports the rows the statement WROTE; ON CONFLICT DO
      // NOTHING skipped the rest. No count is recorded as unknown, never as
      // written — and a clear is reported only for a row the database took
      // (fix pass 5): every row of a statement that wrote them all; in a
      // statement that skipped some, the rows whose key no earlier row of the
      // request carried; none of a statement with no count (`uncounted`).
      const counted = typeof up.count === "number";
      const all = counted && up.count === rows.length;
      for (const r of rows) {
        const k = restoreKeyOf(table, r);
        const notes = clearNotes.get(r);
        if (notes && counted && (all || (clearsLocated && (k === null || !acceptedKeys.has(k))))) cleared.push(...notes);
        if (k !== null) acceptedKeys.add(k);
      }
      if (!counted) { uncounted += rows.length; return null; }
      inserted += up.count as number;
      if ((up.count as number) < rows.length) { skipped += rows.length - (up.count as number); skippedPool.push(...rows); }
      return null;
    }
    const code = String(up.error.code ?? "");
    if (!ROW_LEVEL_SQLSTATES.has(code)) return { error: up.error.message, code };
    if (rows.length === 1) {
      refused.push({ id: label(rows[0]), code: restoreRefusalCode(table, code, up.error.message), message: up.error.message });
      return null;
    }
    if (bisectLeft < 2) {
      for (const r of rows) {
        refused.push({
          id: label(r), code,
          message: `${up.error.message} — refused with the ${rows.length} row(s) of one statement: this request stopped isolating rows after ${RESTORE_BISECT_MAX_STATEMENTS} statements; run the restore again to retry them`,
        });
      }
      return null;
    }
    bisectLeft -= 2;
    const mid = Math.ceil(rows.length / 2);
    return (await write(rows.slice(0, mid))) ?? write(rows.slice(mid));
  };
  // Skipped rows: kept here, or held by another workspace? A row whose key is
  // held elsewhere cannot have been written, so the split is exact; when it
  // cannot be read the skipped rows are "uncounted", never "kept".
  const settleSkipped = async () => {
    if (skipped === 0) return;
    const where = await locateRestoreKeys(sb, table, orgId, skippedPool);
    if (!where.ok) { uncounted += skipped; skipped = 0; return; }
    const elsewhereRows = skippedPool.filter((r) => { const k = restoreKeyOf(table, r); return k !== null && where.elsewhere.has(k); }).length;
    const moved = Math.min(elsewhereRows, skipped);
    heldElsewhere += moved;
    existing += skipped - moved;
    skipped = 0;
  };
  for (let i = 0; i < mapped.length; i += 500) {
    const failed = await write(mapped.slice(i, i + 500));
    if (failed) {
      await settleSkipped();
      return fail(500, failed.error, inserted, rowsAfterFilters, failed.code || null);
    }
  }
  await settleSkipped();

  // Fix pass 5: a numbering counter this workspace already held is advanced
  // to the backup's value when that is higher (RESTORE_COUNTER_COLUMNS) —
  // otherwise the next number issued repeats one a restored record carries.
  // Checked: a counter that cannot be read or advanced fails the chunk, so
  // the run stops before the records numbered from it (fix pass 6: each
  // counter table sits before its numbered table in RESTORE_TABLE_ORDER —
  // ticket_number_counters before tickets, library_numbering before
  // documents; RESTORE_COUNTER_NUMBERS pins it).
  const counter = has(RESTORE_COUNTER_COLUMNS, table) ? RESTORE_COUNTER_COLUMNS[table] : null;
  if (counter && mapped.length) {
    const cols = conflictCols(table);
    const want = new Map<string, { row: Record<string, unknown>; value: number }>();
    for (const r of mapped) {
      const k = restoreKeyOf(table, r);
      const v = r[counter];
      if (k === null || typeof v !== "number" || !Number.isFinite(v)) continue;
      const held = want.get(k);
      if (!held || v > held.value) want.set(k, { row: r, value: v });
    }
    const keyed = Array.from(want.values());
    for (let i = 0; i < keyed.length; i += 100) {
      const slice = keyed.slice(i, i + 100);
      let q = sb.from(table).select(Array.from(new Set([...cols, counter])).join(",")).eq("org_id", orgId);
      for (const c of cols) q = q.in(c, Array.from(new Set(slice.map((x) => x.row[c] as string | number))));
      const { data, error } = await q;
      if (error) return fail(500, `Could not read the ${table} numbering counters to advance them: ${error.message}`, inserted, rowsAfterFilters, error.code ?? null);
      const live = new Map<string, number>();
      for (const row of ((data ?? []) as unknown as Array<Record<string, unknown>>)) {
        const k = restoreKeyOf(table, row);
        if (k !== null && typeof row[counter] === "number") live.set(k, row[counter] as number);
      }
      for (const x of slice) {
        const now = live.get(restoreKeyOf(table, x.row) as string);
        if (now === undefined || now >= x.value) continue;
        let u = sb.from(table).update({ [counter]: x.value }).eq("org_id", orgId);
        for (const c of cols) u = u.eq(c, x.row[c] as string | number);
        const { data: moved, error: moveErr } = await u.lt(counter, x.value).select(counter);
        if (moveErr) return fail(500, `Could not advance the ${table} numbering counter past the restored numbers: ${moveErr.message}`, inserted, rowsAfterFilters, moveErr.code ?? null);
        advanced += Array.isArray(moved) ? moved.length : 0;
      }
    }
  }
  return { ok: true, inserted, existing, heldElsewhere, uncounted, refused, cleared, advanced, rowsAfterFilters, filtered: params.rows.length - rowsAfterFilters };
}

/** BKP-5: what a restore of these rows WOULD do, read-only — how many already
 *  exist IN THIS WORKSPACE under the table's conflict key (and would be kept
 *  as they are), how many keys another workspace on this deployment holds
 *  (those rows could NOT be restored here) and how many would be new. Rows
 *  are remapped and bound to the workspace exactly as the write does, so a
 *  composite key that carries an org or a user is compared as it would be
 *  written. It does not apply the write's other rules (archived-ticket
 *  comments, parents outside the workspace, a person with no sign-in
 *  account, a foreign storage key, a second unique key): their outcome is
 *  reported per row after the apply. The route records every call
 *  (RESTORE_PREVIEW) — the check reads deployment-wide. */
export interface RestorePreviewResult {
  ok: boolean;
  status?: number;
  error?: string;
  rows: number;
  existing: number;
  heldElsewhere: number;
  wouldInsert: number;
}

export async function previewRestoreChunk(
  sb: RestoreDb,
  params: { orgId: string; table: string; rows: ReadonlyArray<Record<string, unknown>>; idRemap: RestorePlan["idRemap"] },
): Promise<RestorePreviewResult> {
  const { orgId, table, idRemap } = params;
  const refusal = restoreTableRefusal(table);
  if (refusal) return { ok: false, status: 400, error: refusal, rows: 0, existing: 0, heldElsewhere: 0, wouldInsert: 0 };
  const mapped = params.rows.map((r) => bindRestoredRow(table, remapRow(r, idRemap), orgId));
  const where = await locateRestoreKeys(sb, table, orgId, mapped);
  if (!where.ok) return { ok: false, status: 500, error: where.error, rows: mapped.length, existing: 0, heldElsewhere: 0, wouldInsert: 0 };
  let existing = 0;
  let heldElsewhere = 0;
  const seen = new Set<string>();
  for (const r of mapped) {
    const k = restoreKeyOf(table, r);
    if (k === null) continue; // no key yet (a defaulted id): always new
    if (where.elsewhere.has(k)) heldElsewhere++;
    else if (where.here.has(k) || seen.has(k)) existing++;
    seen.add(k);
  }
  return { ok: true, rows: mapped.length, existing, heldElsewhere, wouldInsert: mapped.length - existing - heldElsewhere };
}

// ── The chunked restore, driven from the browser (BKP-5) ─────────────────
// The page's whole restore flow, kept here — pure apart from the injected
// `post` — so it runs the same in a test against the real routes as it does
// in the browser against fetch.

/** DEC-75 §5 — the sentence the page shows before and after a restore.
 *  Fix pass 6: it names the one exception (RESTORE_COUNTER_COLUMNS), so the
 *  Admin never consents to "kept exactly as it is" for a counter the restore
 *  then raises. */
export const RESTORE_ADDITIVE_NOTE =
  "A restore only ADDS records. A record whose id (or key) already exists in this workspace is kept exactly as it is — " +
  "a restore cannot overwrite, repair or roll back a record that was changed or damaged after the backup. " +
  "The one exception the restore itself makes is a ticket or document numbering counter, which is raised (never lowered) to the backup's value so no number is issued twice — " +
  "when the backup carries its counters (one made before 2026-08-18, or an incomplete export, may not); " +
  "where this workspace's number prefix differs from the backup's, that leaves a gap in its numbering. " +
  "Restored records still run the database's own bookkeeping (for example a project's last-activity time), " +
  "and choosing the backup's workspace name renames this workspace.";

/** BKP-5 (fix pass) — what the page says about records whose key another workspace holds. */
export const RESTORE_HELD_ELSEWHERE_NOTE =
  "Their ids are in use by another workspace on this deployment (a restore keeps every id), so they could NOT be restored here — " +
  "restore them into the workspace that holds them, or remove that workspace's copy first.";

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
  /** Not restored: the key is held by another workspace on this deployment. */
  heldElsewhere: number;
  uncounted: number;
  /** Dropped by a restore rule (comments of a ticket archived since the backup). */
  filtered: number;
  refused: RestoreRowRefusal[];
  /** Written with one nullable pointer cleared (see RestoreChunkResult.cleared). */
  cleared: RestoreRowRefusal[];
  /** Numbering counters advanced past the restored numbers (see RestoreChunkResult.advanced). */
  advanced: number;
  error?: string;
}

export interface ChunkedRestoreResult {
  /** The org + uid map /begin answered — "Put the files back" remaps storage keys with it. */
  idRemap: RestorePlan["idRemap"];
  createdUsers: number;
  linkedUsers: number;
  /** Placeholders /begin could give no profile row (no sign-in account yet):
   *  rows that must name a profile cannot name them (RESTORE_USER_REFERENCES). */
  placeholdersWithoutProfile: number;
  /** Backup members /begin could map to no person here (no email address,
   *  no member under that uid): rows naming one are refused (fix pass 5). */
  unmappedMembers: number;
  totalInserted: number;
  totalExisting: number;
  totalHeldElsewhere: number;
  totalUncounted: number;
  totalFiltered: number;
  /** Rows the database refused, less the dangling process flows below. */
  totalRefused: number;
  /** BKP-15: process flows not restored because an end names no equipment or
   *  unit here (DANGLING_FLOW_CODE) — counted apart from a real refusal. */
  totalDanglingFlows: number;
  totalCleared: number;
  totalAdvanced: number;
  tables: RestoreTableOutcome[];
  /** BKP-5 Done-when 2: the table the restore STOPPED at (tables are
   *  FK-ordered, so nothing after it was attempted), and why. */
  stoppedAt: { table: string; error: string } | null;
  notAttempted: string[];
}

export interface ChunkedRestorePreview {
  tables: Record<string, { rows: number; existing: number; heldElsewhere: number; wouldInsert: number }>;
  existing: number;
  heldElsewhere: number;
  wouldInsert: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const restoreOrder = (plan: RestorePlan) =>
  orderTablesForRestore(plan.counts.tables.filter((t) => t.willImport && t.rows > 0).map((t) => t.name));
const tableRows = (envelope: RestoreEnvelopeLike, table: string): Array<Record<string, unknown>> => {
  const raw = has(envelope.tables, table) ? envelope.tables[table] : undefined;
  return restoreRowsInOrder(table, (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>);
};
const keyProjection = (table: string, row: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const c of conflictCols(table)) if (c in row) out[c] = row[c];
  return out;
};

/** BKP-5 Done-when 1, BEFORE applying: per table, how many backup rows already
 *  exist here under the table's key (and would be kept as they are), how many
 *  keys another workspace holds (could not be restored here) and how many
 *  would be new. Read-only; sends only the key columns. Throws with the
 *  server's message when a check cannot run (nothing has been written). */
export async function previewChunkedRestore(params: {
  orgId: string; envelope: RestoreEnvelopeLike; plan: RestorePlan; post: RestorePost;
  onProgress?: (p: RestoreRunProgress) => void;
}): Promise<ChunkedRestorePreview> {
  const { orgId, envelope, plan, post } = params;
  const order = restoreOrder(plan);
  const rowsTotal = order.reduce((s, t) => s + tableRows(envelope, t).length, 0);
  const manifest = { orgId: envelope.manifest.orgId, orgName: envelope.manifest.orgName };
  const out: ChunkedRestorePreview = { tables: {}, existing: 0, heldElsewhere: 0, wouldInsert: 0 };
  let rowsDone = 0;
  for (const [tablesDone, table] of order.entries()) {
    const rows = tableRows(envelope, table);
    const acc = { rows: 0, existing: 0, heldElsewhere: 0, wouldInsert: 0 };
    for (let i = 0; i < rows.length; i += RESTORE_CHUNK_ROWS) {
      params.onProgress?.({ phase: "checking", currentTable: table, rowsDone, rowsTotal, tablesDone, tablesTotal: order.length });
      const chunk = rows.slice(i, i + RESTORE_CHUNK_ROWS).map((r) => keyProjection(table, r));
      const res = await post(`/api/admin/restore/apply-table?orgId=${encodeURIComponent(orgId)}`, { table, rows: chunk, idRemap: plan.idRemap, preview: true, manifest });
      if (!res.ok) throw new Error(`Could not check ${table} against this workspace: ${String(res.body?.error ?? `HTTP ${res.status}`)}`);
      acc.rows += num(res.body?.rows);
      acc.existing += num(res.body?.existing);
      acc.heldElsewhere += num(res.body?.heldElsewhere);
      acc.wouldInsert += num(res.body?.wouldInsert);
      rowsDone += chunk.length;
    }
    out.tables[table] = acc;
    out.existing += acc.existing;
    out.heldElsewhere += acc.heldElsewhere;
    out.wouldInsert += acc.wouldInsert;
  }
  return out;
}

/** The chunked restore: /begin (users), then every importable table in FK
 *  order through /apply-table. Counts are what the server reported, never
 *  assumed. BKP-5 Done-when 2 (intelligence ILIFE-4): the run STOPS at the
 *  first table that fails — continuing would write children of parents that
 *  never landed — and names the tables it did not attempt; a refused ROW
 *  never stops it (it is reported). A request that cannot reach the server
 *  stops the run the same way: what was written is still returned, with the
 *  org map "Put the files back" needs. Throws only when /begin fails or
 *  cannot be reached (no table was attempted). */
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
    idRemap, createdUsers: num(begin.body?.createdUsers), linkedUsers: num(begin.body?.linkedUsers),
    placeholdersWithoutProfile: num(begin.body?.placeholdersWithoutProfile),
    unmappedMembers: num(begin.body?.unmappedMembers),
    totalInserted: 0, totalExisting: 0, totalHeldElsewhere: 0, totalUncounted: 0, totalFiltered: 0, totalRefused: 0, totalDanglingFlows: 0, totalCleared: 0, totalAdvanced: 0,
    tables: [], stoppedAt: null, notAttempted: [],
  };
  let rowsDone = 0;
  for (const [tablesDone, table] of order.entries()) {
    const rows = tableRows(envelope, table);
    const t: RestoreTableOutcome = { name: table, rows: rows.length, inserted: 0, existing: 0, heldElsewhere: 0, uncounted: 0, filtered: 0, refused: [], cleared: [], advanced: 0 };
    for (let i = 0; i < rows.length; i += RESTORE_CHUNK_ROWS) {
      params.onProgress?.({ phase: "tables", currentTable: table, rowsDone, rowsTotal, tablesDone, tablesTotal: order.length });
      const chunk = rows.slice(i, i + RESTORE_CHUNK_ROWS);
      let res: Awaited<ReturnType<RestorePost>>;
      try {
        res = await post(`/api/admin/restore/apply-table?orgId=${encodeURIComponent(orgId)}`, { table, rows: chunk, idRemap, manifest });
      } catch (e) {
        // The request never got an answer: whether this chunk landed is
        // unknown — a re-run skips whatever did.
        t.error = `The connection failed while restoring ${table} (${(e as Error)?.message ?? String(e)}) — whether its last ${chunk.length} row(s) landed is unknown`;
        break;
      }
      // A failed chunk may still have written rows before it stopped — count them.
      t.inserted += num(res.body?.inserted);
      t.existing += num(res.body?.existing);
      t.heldElsewhere += num(res.body?.heldElsewhere);
      t.uncounted += num(res.body?.uncounted);
      t.filtered += num(res.body?.filtered);
      t.advanced += num(res.body?.advanced);
      if (Array.isArray(res.body?.refused)) t.refused.push(...(res.body.refused as RestoreRowRefusal[]));
      if (Array.isArray(res.body?.cleared)) t.cleared.push(...(res.body.cleared as RestoreRowRefusal[]));
      if (!res.ok) { t.error = String(res.body?.error ?? `HTTP ${res.status}`); break; }
      rowsDone += chunk.length;
    }
    result.tables.push(t);
    result.totalInserted += t.inserted;
    result.totalExisting += t.existing;
    result.totalHeldElsewhere += t.heldElsewhere;
    result.totalUncounted += t.uncounted;
    result.totalFiltered += t.filtered;
    const dangling = t.refused.filter(isDanglingFlowRefusal).length;
    result.totalRefused += t.refused.length - dangling;
    result.totalDanglingFlows += dangling;
    result.totalCleared += t.cleared.length;
    result.totalAdvanced += t.advanced;
    if (t.error) {
      result.stoppedAt = { table, error: t.error };
      result.notAttempted = order.slice(order.indexOf(table) + 1);
      break;
    }
  }
  return result;
}

// ── Reading a backup archive (BKP-7) ─────────────────────────────────────
// ONE archive layout, written by both producers (lib/exportRunner.ts — the
// server ZIP — and lib/clientBackup.ts — the browser-built Full ZIP, in
// parts): manifest.json + tables/<table>.json carry the records (part 1),
// files/<storage-key> the binaries (any part), files-manifest.json their
// hashes. Archives the browser wrote before that layout carry the whole
// envelope as data.json instead; they are still read. Anything else is
// refused with a message that says why — a backup is never half-read.

/** The minimal JSZip surface the reader needs. */
export interface BackupZipLike {
  files: Record<string, { dir: boolean }>;
  file(path: string): { async(type: "string"): Promise<string> } | null;
}

export interface BackupArchiveRead {
  envelope: RestoreEnvelopeLike;
  /** Which layout carried the records. */
  layout: "manifest+tables" | "data.json";
  /** The dropped part (by name) that carries the records. */
  recordsPart: string;
  /** Every embedded binary across the dropped parts — the first copy of a key wins. */
  files: Array<{ zip: number; entry: string; key: string }>;
  /** What the archive itself says is missing or incomplete. */
  warnings: string[];
}

const depthOf = (p: string) => p.split("/").length;
const insideFilesDir = (p: string) => /(^|\/)files\//i.test(p);

/** Read the records and the file list out of one backup's ZIP part(s). Throws
 *  an Error whose message is shown to the admin as is. */
export async function readBackupArchive(parts: ReadonlyArray<{ name: string; zip: BackupZipLike }>): Promise<BackupArchiveRead> {
  if (parts.length === 0) throw new Error("Drop the backup's ZIP part(s).");
  const readJson = async (zip: BackupZipLike, entry: string, what: string): Promise<unknown> => {
    const f = zip.file(entry);
    if (!f) throw new Error(`${what} is missing.`);
    try { return JSON.parse(await f.async("string")); }
    catch { throw new Error(`${what} is unreadable — this archive is damaged. Nothing was restored.`); }
  };

  type Found = { index: number; name: string; prefix: string; layout: "manifest+tables" | "data.json"; entry: string };
  const found: Found[] = [];
  const prefixes: string[] = [];
  for (const [index, { name, zip }] of parts.entries()) {
    const entries = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
    const shallowest = (re: RegExp) => entries.filter((p) => re.test(p) && !insideFilesDir(p)).sort((a, b) => depthOf(a) - depthOf(b))[0];
    const manifest = shallowest(/(^|\/)manifest\.json$/i);
    const dataJson = shallowest(/(^|\/)data\.json$/i);
    const partMarker = shallowest(/(^|\/)backup-part\.json$/i);
    const anchor = manifest ?? dataJson ?? partMarker;
    const prefix = anchor ? anchor.slice(0, anchor.lastIndexOf("/") + 1) : "";
    prefixes.push(prefix);
    if (manifest) found.push({ index, name, prefix, layout: "manifest+tables", entry: manifest });
    else if (dataJson) found.push({ index, name, prefix, layout: "data.json", entry: dataJson });
  }
  if (found.length === 0) {
    throw new Error(
      "None of the dropped files carries the backup's records (manifest.json with tables/, or data.json in an older backup). " +
      "Drop part 1 — it carries the records — together with the other parts.",
    );
  }
  if (found.length > 1) {
    throw new Error(`More than one backup's records were dropped (${found.map((f) => f.name).join(", ")}). Drop the parts of ONE backup.`);
  }
  const rec = found[0];
  const recZip = parts[rec.index].zip;

  let envelope: RestoreEnvelopeLike;
  if (rec.layout === "manifest+tables") {
    const manifest = (await readJson(recZip, rec.entry, `${rec.name}: manifest.json`)) as RestoreEnvelopeLike["manifest"];
    const tables: Record<string, unknown[]> = {};
    const tableRe = new RegExp(`^${rec.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}tables/([^/]+)\\.json$`, "i");
    for (const entry of Object.keys(recZip.files)) {
      const m = entry.match(tableRe);
      if (!m || recZip.files[entry].dir) continue;
      const rows = await readJson(recZip, entry, `${rec.name}: tables/${m[1]}.json`);
      if (!Array.isArray(rows)) throw new Error(`${rec.name}: tables/${m[1]}.json is not a list of rows — this archive is damaged. Nothing was restored.`);
      tables[m[1]] = rows;
    }
    envelope = { manifest, tables };
  } else {
    envelope = (await readJson(recZip, rec.entry, `${rec.name}: data.json`)) as RestoreEnvelopeLike;
  }
  if (!envelope?.manifest?.orgId || !envelope?.tables || typeof envelope.tables !== "object") {
    throw new Error("Not a recognizable backup: missing manifest/tables.");
  }

  // Parts that say which backup they belong to must agree with the records.
  const warnings: string[] = [];
  const seenParts = new Set<number>();
  type BackupReport = { cancelled?: boolean; notAttempted?: unknown[]; parts?: unknown[]; complete?: boolean | null };
  let report: BackupReport | null = null;
  for (const [index, { name, zip }] of parts.entries()) {
    const marker = zip.file(`${prefixes[index]}backup-part.json`);
    if (marker) {
      const info = (await readJson(zip, `${prefixes[index]}backup-part.json`, `${name}: backup-part.json`)) as { orgId?: string; exportedAt?: string; part?: number };
      const exportedAt = (envelope.manifest as { exportedAt?: string }).exportedAt;
      if ((info.orgId && info.orgId !== envelope.manifest.orgId) || (info.exportedAt && exportedAt && info.exportedAt !== exportedAt)) {
        throw new Error(`${name} belongs to a different backup (exported ${info.exportedAt ?? "?"}) than the records in ${rec.name} — drop the parts of ONE backup. Nothing was restored.`);
      }
      if (typeof info.part === "number") seenParts.add(info.part);
    }
    if (zip.file(`${prefixes[index]}backup-report.json`)) {
      report = (await readJson(zip, `${prefixes[index]}backup-report.json`, `${name}: backup-report.json`)) as BackupReport;
    }
  }
  if (report?.cancelled) {
    warnings.push(`This backup was CANCELLED before every file was packed: ${Array.isArray(report.notAttempted) ? report.notAttempted.length : "some"} file(s) are in no part of it and cannot be put back.`);
  }
  if (Array.isArray(report?.parts) && report.parts.length > parts.length) {
    warnings.push(`The backup has ${report.parts.length} part(s); ${parts.length} were dropped — files in the missing part(s) will not be put back.`);
  } else if (seenParts.size > 0) {
    const max = Math.max(...seenParts);
    const missing = Array.from({ length: max }, (_, i) => i + 1).filter((n) => !seenParts.has(n));
    if (missing.length) warnings.push(`Part(s) ${missing.join(", ")} of this backup were not dropped — their files will not be put back.`);
  }

  // Every binary, from every part: files/<storage-key> under the part's root.
  const files: BackupArchiveRead["files"] = [];
  const seenKeys = new Set<string>();
  for (const [index, { zip }] of parts.entries()) {
    const root = `${prefixes[index]}files/`;
    for (const entry of Object.keys(zip.files)) {
      if (zip.files[entry].dir || !entry.toLowerCase().startsWith(root.toLowerCase())) continue;
      const key = entry.slice(root.length);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      files.push({ zip: index, entry, key });
    }
  }
  // Part 1 cannot know how many parts follow it, but the manifest knows how
  // many files the backup references: name the shortfall.
  const listed = envelope.manifest.files?.count ?? 0;
  if (listed > files.length) {
    warnings.push(
      `The backup lists ${listed} file(s); the dropped part(s) carry ${files.length}. The rest are in part(s) not dropped, ` +
      "were archived offline, or were never packed (backup-report.json in the last part says which) — they will not be put back.",
    );
  }
  return { envelope, layout: rec.layout, recordsPart: rec.name, files, warnings };
}
