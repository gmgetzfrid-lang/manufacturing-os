// lib/auditActions.ts — the audit action registry the viewers read.
//
// admin-and-org ALOG-11 (P7): the action and resource filters on /admin/audit
// were built from the icon map (36 of the ~200 actions the app writes), so
// every admin-authority action — permission changes, ACL changes,
// recertifications, purges, restores, e-signatures, folder deletes — was
// unreachable through any filter, and the "deletes" KPI was a substring
// regex that erred both ways. This module is the ONE declaration the viewers
// read:
//   * AUDIT_ACTIONS — every action the app writes, with its category; the
//     census in lib/__tests__/auditViewers.test.ts walks every `action: "…"`
//     literal in app/, lib/, components/, hooks/ and every SQL INSERT INTO
//     audit_logs in the numbered migrations and fails if one is missing, so a
//     new action is filterable the day it ships. Writers are untouched
//     (DEC-31); a writer naming an unregistered action fails that test.
//   * AUDIT_ACTION_FAMILIES — the dynamic names (TICKET_<ACTION>, MARKUP_…),
//     filterable as a family.
//   * DESTRUCTIVE_AUDIT_ACTIONS — the stated, reviewable list the
//     "Destructive / undo / force" KPI counts (no substring match).
//   * AUDIT_RESOURCE_TYPES — every resource_type a writer uses.
//   * pairTicketAttempts — drafting-flow EVID-12's reading rule: a
//     TICKET_<ACTION> attempt row (details.recordedBeforeApply) stands for a
//     transition that landed unless a TICKET_<ACTION>_NOT_APPLIED row names it
//     in details.attempt; a _HOLDS_NOT_RELEASED row naming it says the
//     transition landed but its holds did not release. Both viewers pair them.

export type AuditCategory =
  | "documents" | "revisions" | "checkout" | "holds" | "reviews" | "distribution"
  | "requests" | "projects" | "cost" | "intake" | "knowledge" | "equipment"
  | "access" | "admin" | "export" | "storage" | "ai" | "billing" | "system";

export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = {
  documents: "Documents & folders", revisions: "Revisions & lifecycle", checkout: "Checkouts",
  holds: "Holds", reviews: "Reviews, signatures & acknowledgments", distribution: "Transmittals, shares & packages",
  requests: "Drafting requests", projects: "Projects & schedules", cost: "Cost & companies",
  intake: "Intake portal", knowledge: "Knowledge & flows", equipment: "Equipment & codebook",
  access: "Members, roles & permissions", admin: "Workspace settings", export: "Export, backup & restore",
  storage: "Storage, purge & archives", ai: "AI", billing: "Billing", system: "System",
};

const BY_CATEGORY: Record<AuditCategory, readonly string[]> = {
  documents: [
    "VIEW", "DOWNLOAD", "UPLOAD", "DOCUMENT_CREATED", "DOCUMENT_ORIGIN_SET", "DOCS_MOVED", "FOLDER_DELETED",
    "FOLDER_MOVED", "FOLDER_RESTORED", "NOTE_CREATED", "NOTE_DELETED", "DELETION_REQUESTED",
    "DELETION_REQUEST_RESOLVED", "OUTPUT_DOCS_GENERATED", "UNIT_CODE_DECODE", "STORAGE_OBJECT_DELETE",
    "LIBRARY_DELETED",
  ],
  revisions: [
    "REV_UP", "REV_BRANCH", "REV_BACKFILL", "SUPERSEDE_DOC", "REVERT", "ARCHIVE_DOC", "DOC_SPLIT",
    "CREATED_FROM_SPLIT", "DOC_MERGED", "CREATED_FROM_MERGE", "DOC_RENUMBERED", "SET_REV_UP",
    "DOC_SPLIT_REVERSED", "DOC_MERGE_REVERSED", "DOC_RENUMBER_REVERSED", "SUBMIT_FOR_REVIEW",
    "REV_LABEL_CORRECTED", "DISTRIBUTION_RECALL", "DOCUMENT_ISSUED", "REV_CONFLICT_BLOCKED",
    "REV_HOLD_OVERRIDDEN", "REV_HOLD_OVERRIDE_UNDONE", "REV_LOCK_OVERRIDDEN", "BRANCH_RESOLVED",
    "TRANSITION_IN", "WORK_PACKAGE_PIN_MOVED",
    // document-control DCK-15 (P33): a reviewed promote that landed while
    // someone else held the checkout (the ratified door (b)) — routine, not
    // an override, so not in DESTRUCTIVE_AUDIT_ACTIONS.
    "REVIEW_PROMOTED_OVER_CHECKOUT",
  ],
  checkout: ["CHECK_OUT", "CHECK_IN", "ABANDON", "FORCE_RELEASE", "JOIN", "FIELD_VERIFIED", "CHECKOUT_RELEASED"],
  holds: ["HOLD_OPENED", "HOLD_RELEASED", "HOLD_KEPT_ON_CLOSE"],
  reviews: [
    "REVIEW_REQUESTED", "REVIEW_ALTERNATE_ACTIVATED", "REVIEW_COMPLETE_AWAITING_PUBLISH", "REVIEW_GATE_SKIPPED",
    "REVIEW_ROSTER_FAILED", "REVISION_PUBLISHED_AFTER_REVIEW", "REVIEW_CONTROL_CHANGED", "ESIGNATURE_CAPTURED",
    "ACK_REQUESTED", "ACK_WAIVED", "COMPLIANCE_CLOCKS_NOT_STARTED", "PSM_ALERT_UNROUTED",
    // drafting-flow EVID-2 (DF-P11): a recipient confirmed a distributed revision.
    "ACK_DISTRIBUTION_CONFIRMED",
  ],
  distribution: [
    "TRANSMITTAL_CREATED", "TRANSMITTAL_ISSUED", "TRANSMITTAL_EMAILED", "TRANSMITTAL_ACKNOWLEDGED",
    "TRANSMITTAL_VOIDED", "TRANSMITTAL_LINK_REVOKED", "TRANSMITTAL_PORTAL_DOWNLOAD",
    "TRANSMITTAL_PORTAL_INTEGRITY_REFUSED", "TRANSMITTAL_PORTAL_UNSTAMPABLE_REFUSED", "SHARE_LINK_CREATED",
    "SHARE_LINK_REVOKED", "WORK_PACKAGE_REPINNED", "WORK_PACKAGE_REPIN_REFUSED", "MARKUP_REQUESTED",
  ],
  requests: [
    "TICKET_ROOT_CAUSE_UPDATE", "TICKET_MARK_URGENT", "TICKET_BULK_URGENT", "TICKET_BULK_ARCHIVE",
    "TICKET_REDLINE_CREATED", "TICKET_ARCHIVE_RECLAIM", "TICKET_ARCHIVE_RESTORE",
  ],
  projects: [
    "PROJECT_CREATED", "PROJECT_UPDATED", "PROJECT_DELETED", "PROJECT_REOPENED", "PROJECT_LESSONS_SAVED",
    "PROJECT_MEMBER_REMOVED", "PROJECT_OWNERSHIP_TRANSFERRED", "PURGE_PROJECT_SNAPSHOT", "MILESTONE_CREATED",
    "MILESTONE_UPDATED", "MILESTONE_COMPLETED", "MILESTONE_MISSED", "MILESTONE_BLOCKED", "MILESTONE_DELETED",
    "MILESTONE_SCOPE_RECORDED", "MILESTONES_RESCHEDULED", "SCHEDULE_BASELINED", "SCHEDULE_BASELINE_CLEARED",
    "SCHEDULE_REBASED", "TASKS_GROUPED", "PUNCH_CONTRACTOR_SET", "TURNOVER_CONTRACTOR_SET",
  ],
  cost: [
    "CHANGE_ORDER_PROPOSED", "CHANGE_ORDER_REPAIRED", "CHANGE_ORDER_VOIDED", "COMPANY_CREATED", "COMPANY_UPDATED",
    "COMPANY_EVENT_LOGGED", "COMPANY_QM_CONFIRMED", "COST_DOC_PARSED", "COST_DOC_VOIDED", "COST_DOC_MANUAL_TOTAL",
    "COST_DOC_COMPANY_LINKED", "COST_DOC_AWARDED", "COST_DOC_AWARD_OVERRIDE", "COST_DOC_AWARD_OVERRIDE_ABANDONED",
    "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE", "COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED",
    "COST_ENTRY_POSTED", "COST_ROW_PURGED",
  ],
  intake: [
    "INTAKE_LINK_CREATED", "INTAKE_LINK_REISSUED", "INTAKE_LINK_REVOKED", "INTAKE_LINKS_REVOKED_WITH_PROJECT",
    "INTAKE_QUOTE_LINK_CREATED", "INTAKE_QUOTE_LINK_REVOKED", "INTAKE_QUOTE_SUBMISSION", "INTAKE_REDLINE",
    "INTAKE_REJECTED", "INTAKE_SUBMISSION_DISPLACED", "INTAKE_DISPLACE_UNRESOLVED", "INTAKE_COLLISION_FLAGGED",
    "INTAKE_ASSIGNMENT_CHANGED", "INTAKE_OUTCOME_NOTICE_CLAIMED", "INTAKE_OUTCOME_NOTICE_FAILED", "INTAKE_OUTCOME_NOTIFIED",
  ],
  knowledge: [
    "KNOWLEDGE_ASKED", "KNOWLEDGE_DOC_INDEXED", "KNOWLEDGE_DOC_PARTIAL_ACCEPTED", "KNOWLEDGE_DOC_REJECTED",
    "KNOWLEDGE_DOC_RETRY_NOW", "KNOWLEDGE_LIBRARY_CREATED", "KNOWLEDGE_LIBRARY_REINDEXED", "KNOWLEDGE_SOURCES_LINKED",
    "KNOWLEDGE_SOURCE_REMOVED", "FLOWS_READ", "EMBED_BUILD_CONSENT_RECORDED", "SKILL_CREATED", "SKILL_UPDATED", "SKILL_DELETED",
  ],
  equipment: [
    "EQUIPMENT_STATE_CHANGED", "EQUIPMENT_BRIDGE_APPLIED", "EQUIPMENT_BRIDGE_DISCOVERED", "EQUIPMENT_BRIDGE_DISMISSED",
    "EQUIPMENT_BRIDGE_RELATION_ADOPTED", "EQUIPMENT_BRIDGE_VANISHED_KEPT", "ASSET_DELETED", "CODEBOOK_REDECODE",
    "CODEBOOK_CODE_RENAMED", "UNIT_IDENTITY_BACKFILL",
  ],
  access: [
    "CAPABILITY_POLICY_CHANGED", "NODE_ACL_CHANGED", "ACCESS_RECERTIFIED", "CONTROLLER_RESTRICTED_READ", "MEMBER_CREATED",
    "MEMBER_REMOVED", "MEMBER_RESTORED", "MEMBER_SUSPENDED", "ROLE_REMOVED", "OWNER_ASSIGNED", "OWNER_CLEARED",
    "OWNER_TEAM_CLEARED", "TEAM_CREATED", "TEAM_UPDATED", "TEAM_DELETED", "TEAM_MEMBER_ADDED", "TEAM_MEMBER_REMOVED",
    "TEAM_SUPERVISOR_CHANGED", "TEAM_SUPERVISOR_CLEARED", "WORKSPACE_SELF_HEAL", "MEMBER_ACL_GRANTS_PRUNED",
  ],
  admin: [
    "BRANDING_LOGO_UPLOAD", "BRANDING_CHANGED", "WORKSPACE_TIMEZONE_CHANGED", "ARCHIVE_SETTINGS_CHANGED",
    "STORAGE_QUOTA_CHANGED", "PLATFORM_STORAGE_LIMITS_CHANGED",
  ],
  export: [
    "DATA_EXPORT", "DATA_EXPORT_FILES", "DATA_EXPORT_UNDELIVERED", "EXPORT_DESTINATION_CREATED",
    "EXPORT_DESTINATION_UPDATED", "EXPORT_DESTINATION_DELETED", "EXPORT_DESTINATION_TEST", "RESTORE_BEGIN",
    "RESTORE_CHUNK", "RESTORE_PREVIEW", "RESTORE_MEMBERSHIP_CHECK", "DATA_RESTORE", "AUDIT_LOG_EXPORTED",
  ],
  storage: [
    "DATA_PURGE", "DATA_PURGE_ABANDONED_EMAIL", "STORAGE_ORPHANS_PURGED", "DATA_ARCHIVE_RECLAIM",
    "ARCHIVE_PRODUCE_CANCELED",
  ],
  ai: ["AI_ACTION_ATTEMPTED", "AI_ACTION_EXECUTED", "AI_ACTION_FAILED", "AI_CAP_CHANGED", "AI_CONNECTION_SAVED", "AI_EMBEDDING_KEY_SAVED"],
  billing: [
    "STRIPE_CHECKOUT_CREATED", "STRIPE_CUSTOMER_SUBSCRIPTION_CREATED", "STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED",
    "STRIPE_CUSTOMER_SUBSCRIPTION_DELETED", "STRIPE_INVOICE_PAYMENT_SUCCEEDED", "STRIPE_INVOICE_PAYMENT_FAILED",
  ],
  // EVID-6 (admin-and-org P13): an audit row that could not be written,
  // recovered from the dead-letter outbox by the maintenance cron (a machine
  // row typed org — lib/auditOutboxDrain.ts).
  system: ["AUDIT_DEAD_LETTER"],
};

export interface AuditActionDef { action: string; category: AuditCategory; label: string; destructive: boolean }
export interface AuditActionFamily { prefix: string; category: AuditCategory; label: string }

/** The names a writer builds at run time — filterable as a family. */
export const AUDIT_ACTION_FAMILIES: readonly AuditActionFamily[] = [
  { prefix: "TICKET_", category: "requests", label: "Drafting request — any action (TICKET_…)" },
  { prefix: "MARKUP_", category: "distribution", label: "Markup request — any (MARKUP_…)" },
  { prefix: "PROJECT_", category: "projects", label: "Project — any (PROJECT_…)" },
  { prefix: "RETENTION_", category: "reviews", label: "Retention & disposition — any (RETENTION_…)" },
  { prefix: "MILESTONE_", category: "projects", label: "Milestone — any (MILESTONE_…)" },
  { prefix: "STRIPE_", category: "billing", label: "Billing event — any (STRIPE_…)" },
];

/** The stated list the "Destructive / undo / force" KPI counts: rows that
 *  delete, purge, void, reclaim, supersede, archive, reverse or force past a
 *  rule. Reviewable here — never a substring match (a request to delete, a
 *  restore and a cancel are not on it). */
export const DESTRUCTIVE_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  "FOLDER_DELETED", "LIBRARY_DELETED", "NOTE_DELETED", "STORAGE_OBJECT_DELETE", "PROJECT_DELETED", "MILESTONE_DELETED", "ASSET_DELETED",
  "TEAM_DELETED", "MEMBER_REMOVED", "EXPORT_DESTINATION_DELETED", "SKILL_DELETED",
  "DATA_PURGE", "DATA_PURGE_ABANDONED_EMAIL", "STORAGE_ORPHANS_PURGED", "COST_ROW_PURGED", "PURGE_PROJECT_SNAPSHOT",
  "DATA_ARCHIVE_RECLAIM", "TICKET_ARCHIVE_RECLAIM",
  "TRANSMITTAL_VOIDED", "COST_DOC_VOIDED", "CHANGE_ORDER_VOIDED",
  "SUPERSEDE_DOC", "ARCHIVE_DOC", "TICKET_BULK_ARCHIVE",
  "REVERT", "DOC_SPLIT_REVERSED", "DOC_MERGE_REVERSED", "DOC_RENUMBER_REVERSED",
  "FORCE_RELEASE", "REV_HOLD_OVERRIDDEN", "REV_LOCK_OVERRIDDEN", "COST_DOC_AWARD_OVERRIDE",
  "TRANSMITTAL_LINK_REVOKED", "SHARE_LINK_REVOKED", "INTAKE_LINK_REVOKED", "INTAKE_LINKS_REVOKED_WITH_PROJECT",
  "INTAKE_QUOTE_LINK_REVOKED", "DATA_RESTORE",
]);

/** "REV_UP" → "Rev Up". */
export function prettyAuditAction(action: string): string {
  return action.toLowerCase().replace(/_/g, " ").replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}

/** document-control P28 (DIST-16; the integrator's fix pass at the P28
 *  merge, 2026-10-21, DEC-90): the label a ROW reads as, where one action
 *  carries several meanings told apart by its details. A
 *  DISTRIBUTION_RECALL row is a recall — "Distribution Recall", as every
 *  recall row has always read — unless its details say it is the withdrawal
 *  of one (`recallWithdrawn: true` → "Recall withdrawn"), a withdrawal that
 *  could not be computed (`withdrawalUnavailable: true` → "Recall withdrawal
 *  could not be computed"), the return to force of a document whose
 *  retirement notice named nobody to withdraw it from (`recallWithdrawn` with
 *  `returnedToForce: true` → "Back in force (no recall to withdraw)"), or a
 *  retirement whose watchers were told and whose copy holders were not
 *  recalled (`watchersOnly: true`, DIST-16 done-when 2 → "Retirement notice
 *  (watchers only)") — the last two rows are new with the same pass. Every other row reads
 *  prettyAuditAction(action), unchanged. The audit viewer's badge and the
 *  export's "Action" column read it (the "Action code" column keeps the
 *  action itself). */
export function auditRowLabel(action: string, details?: Record<string, unknown> | null): string {
  if (action === "DISTRIBUTION_RECALL" && details) {
    if (details.withdrawalUnavailable === true) return "Recall withdrawal could not be computed";
    if (details.recallWithdrawn === true && details.returnedToForce === true) return "Back in force (no recall to withdraw)";
    if (details.recallWithdrawn === true) return "Recall withdrawn";
    if (details.watchersOnly === true) return "Retirement notice (watchers only)";
  }
  return prettyAuditAction(action);
}

export const AUDIT_ACTIONS: readonly AuditActionDef[] = (Object.entries(BY_CATEGORY) as Array<[AuditCategory, readonly string[]]>)
  .flatMap(([category, list]) => list.map((action) => ({ action, category, label: prettyAuditAction(action), destructive: DESTRUCTIVE_AUDIT_ACTIONS.has(action) })));

const BY_ACTION = new Map(AUDIT_ACTIONS.map((d) => [d.action, d]));

/** The ticket workflow's follow-up suffixes (drafting-flow EVID-12). */
export const TICKET_FOLLOW_UP_SUFFIXES = ["_NOT_APPLIED", "_HOLDS_NOT_RELEASED"] as const;

/** The registry entry, a family's, or null for an action nothing registers. */
export function auditActionDef(action: string): AuditActionDef | null {
  const hit = BY_ACTION.get(action);
  if (hit) return hit;
  const fam = AUDIT_ACTION_FAMILIES.find((f) => action.startsWith(f.prefix));
  return fam ? { action, category: fam.category, label: prettyAuditAction(action), destructive: false } : null;
}

export function isDestructiveAuditAction(action: string): boolean {
  return DESTRUCTIVE_AUDIT_ACTIONS.has(action);
}

/** Every resource_type a writer uses (the resource filter's options). */
export const AUDIT_RESOURCE_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "document", label: "Documents" }, { value: "document_version", label: "Document revisions" },
  { value: "collection", label: "Folders" }, { value: "library", label: "Libraries" }, { value: "note", label: "Notes" },
  { value: "ticket", label: "Drafting requests" }, { value: "project", label: "Projects" }, { value: "milestone", label: "Milestones" },
  { value: "project_intake_link", label: "Intake links" }, { value: "project_checklist", label: "Project checklists" },
  { value: "turnover_item", label: "Turnover items" }, { value: "cost", label: "Cost records" }, { value: "company", label: "Companies" },
  { value: "transmittal", label: "Transmittals" }, { value: "work_package", label: "Work packages" },
  { value: "markup_request", label: "Markup requests" }, { value: "asset", label: "Assets" }, { value: "codebook_entry", label: "Codebook" },
  { value: "knowledge_document", label: "Knowledge documents" }, { value: "knowledge_library", label: "Knowledge libraries" },
  { value: "answer_skill", label: "Answer skills" }, { value: "link_rule", label: "Link rules" },
  { value: "org", label: "Workspace" }, { value: "org_configuration", label: "Capability policy & settings" },
  { value: "org_branding", label: "Branding" }, { value: "archive_settings", label: "Archive settings" },
  { value: "platform_settings", label: "Platform settings" }, { value: "member", label: "Members" },
  { value: "org_member", label: "Memberships" }, { value: "team", label: "Teams" },
  { value: "export", label: "Exports" }, { value: "export_destination", label: "Export destinations" },
  { value: "org_export_ledger", label: "Export file ledger" }, { value: "storage", label: "Storage" },
  { value: "storage_object", label: "Stored files" }, { value: "output_template", label: "Output templates" },
  { value: "ai_connection", label: "AI connection" }, { value: "ai_usage_limit", label: "AI caps" },
  { value: "orchestrator", label: "AI assistant actions" },
];

/** A filter option value for a family. */
export const FAMILY_FILTER_PREFIX = "family:";

/** The action filter's options: every registered action and family, grouped
 *  by category, plus any action seen in the loaded rows that nothing
 *  registers (so the filter never hides a row it shows). */
export function auditActionFilterOptions(seen: Iterable<string> = []): Array<{ value: string; label: string; group: string }> {
  const out: Array<{ value: string; label: string; group: string }> = [];
  for (const f of AUDIT_ACTION_FAMILIES) out.push({ value: FAMILY_FILTER_PREFIX + f.prefix, label: f.label, group: AUDIT_CATEGORY_LABEL[f.category] });
  for (const d of AUDIT_ACTIONS) out.push({ value: d.action, label: d.label, group: AUDIT_CATEGORY_LABEL[d.category] });
  const known = new Set(AUDIT_ACTIONS.map((d) => d.action));
  for (const a of new Set(seen)) if (!known.has(a)) out.push({ value: a, label: prettyAuditAction(a), group: "Other (not in the registry)" });
  return out.sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : a.group.localeCompare(b.group)));
}

/** A LIKE pattern matching every action that starts with `prefix`, the
 *  prefix taken literally: `_`, `%` and `\` are escaped (PostgreSQL LIKE's
 *  default escape is the backslash, as lib/auditLogExport.ts userEmailPattern
 *  uses), so `TICKET_%` cannot match `TICKETX_FOO` — a family filter, and the
 *  "complete" export built on it, select only the family they name. */
export function auditFamilyLikePattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** How an action filter is applied to a query: one action (a ticket action
 *  brings its EVID-12 follow-ups, so a pair is never split), or a family. */
export function auditActionFilterQuery(value: string): { kind: "family"; like: string } | { kind: "in"; actions: string[] } | null {
  if (!value || value === "ALL") return null;
  if (value.startsWith(FAMILY_FILTER_PREFIX)) return { kind: "family", like: auditFamilyLikePattern(value.slice(FAMILY_FILTER_PREFIX.length)) };
  if (value.startsWith("TICKET_") && !TICKET_FOLLOW_UP_SUFFIXES.some((s) => value.endsWith(s))) {
    return { kind: "in", actions: [value, ...TICKET_FOLLOW_UP_SUFFIXES.map((s) => value + s)] };
  }
  return { kind: "in", actions: [value] };
}

// ── drafting-flow EVID-12: reading the ticket trail ─────────────────────────
export interface AuditRowLike { id: string; action: string; details?: Record<string, unknown> | null }
export type TicketAttemptOutcome = "applied" | "not_applied" | "holds_not_released";

/** Pairs each TICKET_<ACTION> attempt row (details.recordedBeforeApply) with
 *  the _NOT_APPLIED / _HOLDS_NOT_RELEASED rows that name it in
 *  details.attempt. `attempts` gives an attempt's outcome (applied unless a
 *  follow-up in these rows names it — the viewers load newest first, so a
 *  loaded attempt's follow-up, written after it, is loaded too); `followUps`
 *  maps a follow-up row to the attempt it names. */
export function pairTicketAttempts(rows: readonly AuditRowLike[]): {
  attempts: Map<string, { outcome: TicketAttemptOutcome; followUpId: string | null }>;
  followUps: Map<string, string>;
} {
  const attempts = new Map<string, { outcome: TicketAttemptOutcome; followUpId: string | null }>();
  const followUps = new Map<string, string>();
  for (const r of rows) {
    if (r.action.startsWith("TICKET_") && r.details && r.details.recordedBeforeApply === true
        && !TICKET_FOLLOW_UP_SUFFIXES.some((s) => r.action.endsWith(s))) {
      attempts.set(r.id, { outcome: "applied", followUpId: null });
    }
  }
  for (const r of rows) {
    const suffix = TICKET_FOLLOW_UP_SUFFIXES.find((s) => r.action.startsWith("TICKET_") && r.action.endsWith(s));
    const attempt = typeof r.details?.attempt === "string" ? (r.details.attempt as string) : null;
    if (!suffix || !attempt) continue;
    followUps.set(r.id, attempt);
    const a = attempts.get(attempt);
    if (!a) continue;
    // _NOT_APPLIED decides; a holds row only marks an applied transition.
    if (suffix === "_NOT_APPLIED") attempts.set(attempt, { outcome: "not_applied", followUpId: r.id });
    else if (a.outcome === "applied") attempts.set(attempt, { outcome: "holds_not_released", followUpId: r.id });
  }
  return { attempts, followUps };
}

/** One line for an attempt's outcome, said beside its row. */
export function ticketAttemptNote(outcome: TicketAttemptOutcome): string {
  return outcome === "not_applied"
    ? "Not applied — a later row records that this transition did not land"
    : outcome === "holds_not_released"
      ? "Applied, but its holds were NOT released (a later row names them)"
      : "Applied (no later row says otherwise)";
}

/** /activity's reading of the ticket trail (EVID-12), kept here so the page
 *  stays at one call (its plan entry is rule copy only): pairs `rows`, drops
 *  from each day every follow-up row whose attempt is loaded (it is said on
 *  the attempt's line instead; a day left empty goes), and gives the suffix
 *  an attempt's verb carries. */
export function foldTicketFeed<T extends AuditRowLike>(
  rows: readonly AuditRowLike[], groups: ReadonlyArray<{ day: string; rows: T[] }>,
): { groups: Array<{ day: string; rows: T[] }>; verbSuffix: (id: string) => string } {
  const { attempts, followUps } = pairTicketAttempts(rows);
  const folded = (id: string) => { const a = followUps.get(id); return a !== undefined && attempts.has(a); };
  return {
    groups: groups.map((g) => ({ day: g.day, rows: g.rows.filter((r) => !folded(r.id)) })).filter((g) => g.rows.length > 0),
    verbSuffix: (id) => {
      const o = attempts.get(id)?.outcome;
      return o === "not_applied" ? " (not applied)" : o === "holds_not_released" ? " (applied — its holds were not released)" : "";
    },
  };
}

// ── ALOG-7: whose word a row's identity is ──────────────────────────────────
/** What the viewer says beside the actor (actor_kind, 20261201). */
export function auditActorNote(actorKind: unknown): string {
  return actorKind === "member" ? "identity resolved by the database at write time"
    : actorKind === "server" ? "recorded by the server"
      : actorKind === "system" ? "system — no person"
        : "as sent by the writer (before identity was resolved by the database)";
}

// ── ALOG-16 (20261219): a document's trail is the reader's share of it ─────
/** One neutral line for a reader that presents a document's audit trail as
 *  its whole history (admin-and-org P13 integrator fix pass): after 20261219
 *  the database leaves out the node-level authority rows the reader may not
 *  see, so the reader says entries may be missing — never how many. */
const UNSEEN_RULE = "permission, ownership and recertification changes on a library, folder or document are shown only to people with the Audit log permission and to those who may manage it.";
export const AUDIT_TRAIL_UNSEEN_NOTE = `Entries you may not see are not listed: ${UNSEEN_RULE}`;
/** The printed evidence pack's form: its reader is not the person who generated it. */
export const AUDIT_TRAIL_UNSEEN_NOTE_PACK = `Entries the person who generated this pack may not see are not listed: ${UNSEEN_RULE}`;
