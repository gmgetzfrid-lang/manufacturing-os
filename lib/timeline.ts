// lib/timeline.ts
//
// Phase 3 — Operational Timelines & Audit Intelligence (read layer).
//
// The platform has historically scattered audit data across four
// tables:
//
//   - audit_logs           (free-form action/resource events)
//   - document_versions    (revision lifecycle — release, supersede)
//   - documents            (archive_at / superseded_at column flags)
//   - project_activity     (project-scoped events)
//
// Every screen that wants "what happened to this drawing" has had to
// invent its own join. This module is the single read seam. It does
// NOT add new audit producers, does NOT mutate any table, and does
// NOT change RLS. It just unifies reads.
//
// Phase 3+ UIs (per-document history drawer, per-project timeline,
// holds/release feed) all consume this. Phase 9 AI scratchpad
// "summarize what happened this week" calls this too.
//
// Return shape: every event has a stable, source-prefixed id
// ("audit:<uuid>" or "version:<uuid>") so a consumer can dedupe or
// link back to the source row. We intentionally do NOT dedupe
// REV_UP audit rows against their corresponding version rows — the
// audit row records the actor + reason, the version row records the
// file payload + signoffs. They're complementary, and a renderer can
// group by timestamp if it wants a single visual entry.

import { supabase } from "@/lib/supabase";

export type TimelineEventKind = "audit" | "version" | "project_activity" | "hold";

/** Scope context attached to events that originate from documents.
 *  Populated by getDocumentTimeline (single doc, single lookup) and
 *  by getProjectTimeline for events whose document is scope-tagged. */
export interface TimelineEventScope {
  plantId: string | null;
  plantName: string | null;
  unitId: string | null;
  unitName: string | null;
  systemId: string | null;
  systemName: string | null;
}

export interface TimelineEvent {
  /** Source-prefixed id: "audit:<uuid>" | "version:<uuid>" | "activity:<uuid>". */
  id: string;
  kind: TimelineEventKind;
  /** Canonical action string. For audit rows, the audit `action` column.
   *  For version rows, "VERSION_CREATED" (or "VERSION_REVERT" if
   *  reverted_from_version_id is set). For project_activity, the
   *  `type` column. */
  action: string;
  resourceType: string;
  resourceId: string;
  /** ISO 8601 string. Sort key. */
  timestamp: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  /** Short human-readable summary derived from the row. */
  summary: string;
  /** Full row details for the renderer. Shape varies by kind. */
  details: Record<string, unknown> | null;
  /** Plant/Unit/System context if the event ties to a scoped document.
   *  Null on project_activity events that don't carry a document ref. */
  scope?: TimelineEventScope | null;
}

export interface AuditRow {
  id: string;
  action: string;
  resource_id: string;
  resource_type: string;
  org_id: string | null;
  user_id: string | null;
  user_email: string | null;
  user_role: string | null;
  details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

interface VersionRow {
  id: string;
  org_id: string | null;
  record_id: string;
  revision_label: string;
  issue_type: string | null;
  change_type: string | null;
  change_log: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  released_at: string | null;
  superseded_at: string | null;
  moc_reference: string | null;
  supersedes_version_id: string | null;
  reverted_from_version_id: string | null;
  drawn_by_name: string | null;
  checked_by_name: string | null;
  approved_by_name: string | null;
  file_hash: string | null;
  source_file_name: string | null;
}

export interface HoldRow {
  id: string;
  org_id: string;
  document_id: string;
  reason: string;
  notes: string | null;
  expected_release_at: string | null;
  opened_by: string;
  opened_by_name: string | null;
  opened_at: string;
  released_by: string | null;
  released_by_name: string | null;
  released_at: string | null;
  released_reason: string | null;
}

function holdRowsToEvents(rows: HoldRow[]): TimelineEvent[] {
  // Each hold row emits up to two events: one on open, one on
  // release. Audit events with action HOLD_OPENED/HOLD_RELEASED
  // also exist (fired by lib/holds.ts), but those carry the actor
  // metadata; the version emitted here carries the duration and
  // reason fields denormalized for the renderer. mergeHoldHistory
  // (HLD-11) decides which of the two renders for each hold.
  const out: TimelineEvent[] = [];
  for (const r of rows) {
    out.push({
      id: `hold-open:${r.id}`,
      kind: "hold",
      action: "HOLD_OPENED",
      resourceType: "document",
      resourceId: r.document_id,
      timestamp: r.opened_at,
      userId: r.opened_by,
      userName: r.opened_by_name,
      userEmail: null,
      summary: `Hold opened — ${r.reason}`,
      details: {
        holdId: r.id, reason: r.reason, notes: r.notes,
        expectedReleaseAt: r.expected_release_at,
      },
    });
    if (r.released_at) {
      const durationDays = Math.max(0, Math.round((new Date(r.released_at).getTime() - new Date(r.opened_at).getTime()) / 86400_000));
      out.push({
        id: `hold-release:${r.id}`,
        kind: "hold",
        action: "HOLD_RELEASED",
        resourceType: "document",
        resourceId: r.document_id,
        timestamp: r.released_at,
        userId: r.released_by,
        userName: r.released_by_name,
        userEmail: null,
        // HLD-11: the resolution the releaser typed is part of the story —
        // in the summary line, not buried in details.
        summary: `Hold released — ${r.reason} (${durationDays}d)${r.released_reason ? ` — "${r.released_reason}"` : ""}`,
        details: {
          holdId: r.id, reason: r.reason,
          releasedReason: r.released_reason, durationDays,
        },
      });
    }
  }
  return out;
}

/** The audit action written when a HOLD_OPENED / HOLD_RELEASED audit row has
 *  no surviving document_holds row: the hold happened, and its mutable record
 *  was later deleted. Renders as an explicit event, never as silence. */
export const HOLD_RECORD_REMOVED = "HOLD_RECORD_REMOVED";

/** The hold ids the HOLD_OPENED / HOLD_RELEASED audit rows in a window
 *  point at (audit details.holdId). Pure. */
export function holdIdsReferencedBy(auditRows: AuditRow[]): string[] {
  const ids = new Set<string>();
  for (const r of auditRows) {
    if (r.action !== "HOLD_OPENED" && r.action !== "HOLD_RELEASED") continue;
    const holdId = typeof r.details?.holdId === "string" ? (r.details.holdId as string) : null;
    if (holdId) ids.add(holdId);
  }
  return [...ids];
}

/** Targeted, UNPAGED existence check for the hold ids an audit window
 *  references: which of them still have a document_holds row. The windowed
 *  holds query is a page ordered by opened_at, so a long-lived hold released
 *  recently can be inside the audit window and outside the holds page —
 *  absence from a page is not deletion. Ids already on the page are skipped. */
async function lookupExistingHoldIds(ids: string[], alreadyOnPage: ReadonlySet<string>): Promise<Set<string>> {
  const missing = ids.filter((id) => !alreadyOnPage.has(id));
  if (missing.length === 0) return new Set();
  const rows = await readByIdChunks<{ id: string }>(missing, (part) => supabase.from("document_holds").select("id").in("id", part));
  return new Set(rows.map((r) => r.id));
}

/** Ids per `.in()` read. A list of 100 UUIDs keeps a request line near
 *  4 KB; a busy project (hundreds of quotes, hundreds of linked drawings)
 *  used to put every id in ONE filter, past the gateway's URL limit, and a
 *  refused request failed the whole Activity tab. */
export const TIMELINE_ID_CHUNK = 100;

/** One read per chunk of ids (in parallel), concatenated; any failed chunk
 *  fails the read — a partial feed is never presented as the whole one.
 *  Callers that cap each read at `limit` still get the newest `limit`
 *  overall after their merged sort and slice. */
async function readByIdChunks<T>(
  ids: readonly string[],
  read: (part: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const parts: string[][] = [];
  for (let i = 0; i < ids.length; i += TIMELINE_ID_CHUNK) parts.push(ids.slice(i, i + TIMELINE_ID_CHUNK));
  const results = await Promise.all(parts.map((part) => read(part)));
  const out: T[] = [];
  for (const r of results) {
    if (r.error) throw new Error(r.error.message);
    out.push(...(((r.data as T[] | null) ?? [])));
  }
  return out;
}

/**
 * HLD-11: reconcile the two sources of hold history. The mutable
 * document_holds row is the richer render (duration, reason) — but it is
 * exactly that: mutable, and controller-deletable. The immutable audit rows
 * used to be discarded BY ACTION NAME, so deleting a hold row erased the hold
 * from the document's timeline. Now the dedup keys on the hold id
 * (audit details.holdId ↔ document_holds.id):
 *   · an audit row whose hold row is on the page is dropped (the row renders it);
 *   · an audit row whose hold row EXISTS but is outside the holds page is kept
 *     as an ordinary audit event — never declared removed;
 *   · an audit row whose hold row is GONE — confirmed by the targeted
 *     existence check, not inferred from the page — renders as a
 *     "hold record removed" event carrying the audit row's own reason/actor;
 *   · an audit row with no holdId cannot be correlated and is kept as-is.
 * `existingHoldIds` is the result of that check (`lookupExistingHoldIds`);
 * `null` means no check was run, and then nothing is ever declared removed.
 * Pure — unit-tested without a database.
 */
export function mergeHoldHistory(
  auditRows: AuditRow[],
  holdRows: HoldRow[],
  existingHoldIds: ReadonlySet<string> | null,
): { auditEvents: TimelineEvent[]; holdEvents: TimelineEvent[] } {
  const surviving = new Set(holdRows.map((h) => h.id));
  const auditEvents: TimelineEvent[] = [];
  for (const r of auditRows) {
    if (r.action !== "HOLD_OPENED" && r.action !== "HOLD_RELEASED") {
      auditEvents.push(auditRowToEvent(r));
      continue;
    }
    const holdId = typeof r.details?.holdId === "string" ? (r.details.holdId as string) : null;
    if (holdId && surviving.has(holdId)) continue; // the hold row renders this fact
    const ev = auditRowToEvent(r);
    // Only a CONFIRMED absence is a removed record: the id was looked up by
    // itself and no row came back. Outside the page, or unchecked → plain audit.
    const confirmedGone = holdId !== null && existingHoldIds !== null && !existingHoldIds.has(holdId);
    if (confirmedGone) {
      const reason = typeof r.details?.reason === "string" ? (r.details.reason as string) : "hold";
      const releasedReason = typeof r.details?.releasedReason === "string" ? (r.details.releasedReason as string) : null;
      ev.kind = "hold";
      ev.action = HOLD_RECORD_REMOVED;
      ev.summary = r.action === "HOLD_OPENED"
        ? `Hold opened — ${reason} — hold record removed (the audit row is the only surviving evidence)`
        : `Hold released — ${reason}${releasedReason ? ` — "${releasedReason}"` : ""} — hold record removed`;
      ev.details = { ...(r.details ?? {}), originalAction: r.action, holdRecordRemoved: true };
    }
    auditEvents.push(ev);
  }
  return { auditEvents, holdEvents: holdRowsToEvents(holdRows) };
}

interface ProjectActivityRow {
  id: string;
  project_id: string;
  org_id: string;
  user_id: string | null;
  user_name: string | null;
  type: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function auditRowToEvent(r: AuditRow): TimelineEvent {
  const summary = summarizeAudit(r);
  return {
    id: `audit:${r.id}`,
    kind: "audit",
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    timestamp: r.timestamp,
    userId: r.user_id,
    userName: null,
    userEmail: r.user_email,
    summary,
    details: r.details,
  };
}

function versionRowToEvent(r: VersionRow): TimelineEvent {
  const isRevert = !!r.reverted_from_version_id;
  const action = isRevert ? "VERSION_REVERT" : "VERSION_CREATED";
  const summary = isRevert
    ? `Reverted to rev ${r.revision_label}`
    : `Rev ${r.revision_label} created${r.change_type ? ` (${r.change_type})` : ""}`;
  return {
    id: `version:${r.id}`,
    kind: "version",
    action,
    resourceType: "document",
    resourceId: r.record_id,
    // Prefer released_at if set (matches operational "when did this go out")
    timestamp: r.released_at || r.created_at,
    userId: r.created_by,
    userName: r.created_by_name,
    userEmail: null,
    summary,
    details: {
      versionId: r.id,
      revisionLabel: r.revision_label,
      changeType: r.change_type,
      issueType: r.issue_type,
      changeLog: r.change_log,
      mocReference: r.moc_reference,
      supersedesVersionId: r.supersedes_version_id,
      revertedFromVersionId: r.reverted_from_version_id,
      drawnBy: r.drawn_by_name,
      checkedBy: r.checked_by_name,
      approvedBy: r.approved_by_name,
      fileHash: r.file_hash,
      sourceFileName: r.source_file_name,
      supersededAt: r.superseded_at,
    },
  };
}

function projectActivityRowToEvent(r: ProjectActivityRow): TimelineEvent {
  return {
    id: `activity:${r.id}`,
    kind: "project_activity",
    action: r.type,
    resourceType: "project",
    resourceId: r.project_id,
    timestamp: r.created_at,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: null,
    summary: r.body || humanizeActivityType(r.type),
    details: r.metadata,
  };
}

/** SAF-16: the ONE visibility rule every timeline reader applies to
 *  document_versions. In-review drafts (and rejected ones) are only visible
 *  to their reviewers/owner (see lib/reviewControl.ts) — no timeline may
 *  leak them to everyone who can read the document. PostgREST `.or()` form. */
export const CONTROLLED_VERSIONS_ONLY = "review_state.is.null,review_state.eq.approved";

/**
 * SAF-6 / GAP-408: the project timeline's vocabulary for the project- and
 * cost-scoped audit rows the controls program writes — ONE map, read by the
 * project timeline's queries. The class decides whether a row reaches the
 * project's Activity tab:
 *   · milestone — shown: an award, a change-order decision, a checklist
 *     ruling (created / assessed / completed or voided), a turnover review
 *     (accept / reject / waive), a punch-item close, a schedule hit or miss;
 *   · noise     — left in audit_logs (the admin audit page shows it) but off
 *     the feed: individual cost entries and ledger edits, individual
 *     checklist item updates, evidence sweeps, uploads and reads;
 *   · mirrored  — the same fact is already a project_activity row the feed
 *     shows (status changes, ownership, membership, edits), so the audit row
 *     would render it twice.
 * An action NOT in this map is shown: a new event is never silently
 * dropped from the record because nobody classified it yet.
 */
export type ProjectEventClass = "milestone" | "noise" | "mirrored";
export const PROJECT_EVENT_VOCABULARY: Readonly<Record<string, ProjectEventClass>> = {
  // Money & commercial (resource_type 'cost', resource_id = the cost row)
  COST_DOC_AWARDED: "milestone",
  COST_DOC_AWARD_OVERRIDE_DO_NOT_USE: "milestone",
  COST_DOC_UPLOADED: "noise",
  COST_DOC_PARSED: "noise",
  COST_DOC_MANUAL_TOTAL: "noise",
  COST_DOC_POSTED: "noise",
  COST_DOC_VOIDED: "noise",
  COST_DOC_COMPANY_LINKED: "noise",
  COST_DOC_AWARD_OVERRIDE_ABANDONED: "noise",
  COST_ENTRY_POSTED: "noise",
  COST_ENTRY_VOIDED: "noise",
  COST_ACCOUNT_CREATED: "noise",
  COST_ACCOUNT_UPDATED: "noise",
  COST_PARTY_CREATED: "noise",
  COST_PARTY_UPDATED: "noise",
  INTAKE_QUOTE_SUBMISSION: "noise",
  // Change control (resource_type 'project')
  CHANGE_ORDER_PROPOSED: "milestone",
  CHANGE_ORDER_APPROVED: "milestone",
  CHANGE_ORDER_REJECTED: "milestone",
  CHANGE_ORDER_VOIDED: "milestone",
  // Quality & closeout
  CHECKLIST_CREATED: "milestone",
  CHECKLIST_ASSESSED: "milestone",
  CHECKLIST_STATUS: "milestone",
  CHECKLIST_ITEM_UPDATED: "noise",
  CHECKLIST_AUTO_EVIDENCE: "noise",
  TURNOVER_SEEDED: "milestone",
  TURNOVER_ITEM_ADDED: "noise",
  TURNOVER_REVIEWED: "milestone",
  PUNCH_ADDED: "noise",
  PUNCH_STATUS: "milestone",
  // Schedule
  MILESTONE_COMPLETED: "milestone",
  MILESTONE_MISSED: "milestone",
  MILESTONE_BLOCKED: "milestone",
  MILESTONES_RESCHEDULED: "milestone",
  SCHEDULE_BASELINED: "milestone",
  SCHEDULE_REBASED: "milestone",
  MILESTONE_CREATED: "noise",
  MILESTONE_UPDATED: "noise",
  MILESTONE_DELETED: "noise",
  TASKS_GROUPED: "noise",
  // The project itself — the feed already carries these as activity rows
  PROJECT_CREATED: "mirrored",
  PROJECT_UPDATED: "mirrored",
  PROJECT_ACTIVE: "mirrored",
  PROJECT_PAUSED: "mirrored",
  PROJECT_COMPLETED: "mirrored",
  PROJECT_CANCELLED: "mirrored",
  PROJECT_ARCHIVED: "mirrored",
  PROJECT_REOPENED: "mirrored",
  PROJECT_OWNERSHIP_TRANSFERRED: "mirrored",
  PROJECT_MEMBER_REMOVED: "mirrored",
  PROJECT_LESSONS_SAVED: "milestone",
};

/** The actions the project timeline leaves off the feed (noise + mirrored),
 *  as the PostgREST `not.in` list its queries use. Pure. */
export function hiddenProjectActions(): string[] {
  return Object.entries(PROJECT_EVENT_VOCABULARY)
    .filter(([, c]) => c !== "milestone")
    .map(([a]) => a)
    .sort();
}

/** Is this project- or cost-scoped audit action shown on the feed? Pure. */
export function isProjectFeedAction(action: string): boolean {
  return (PROJECT_EVENT_VOCABULARY[action] ?? "milestone") === "milestone";
}

const pgList = (xs: string[]) => `(${xs.map((x) => `"${x}"`).join(",")})`;

const money = (v: unknown): string | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : null;
};

/** Best-effort human summary for an audit row. Mirrors the action vocabulary
 *  used by lib/audit.ts so renderers don't reinvent strings. Exported for
 *  the renderer-map tests (DCK-12). */
export function summarizeAudit(r: Pick<AuditRow, "action" | "details">): string {
  const d = r.details || {};
  switch (r.action) {
    case "VIEW":         return `Viewed${d.fileName ? ` ${d.fileName}` : ""}`;
    case "DOWNLOAD":     return `Downloaded${d.fileName ? ` ${d.fileName}` : ""}`;
    case "CHECK_OUT":    return "Checked out";
    case "CHECK_IN":     return d.outcome === "auto_released" ? "Checked in (auto-released)" : "Checked in";
    // DCK-12: the walkdown attestation — legible in the history it is
    // written to, with the revision it attested against.
    case "FIELD_VERIFIED": return `Field verified${d.rev ? ` against Rev ${d.rev}` : ""}`;
    // DCK-9: rows the stale-checkout banner wrote before it went through the
    // shared check-in. Nothing writes this action any more.
    case "CHECKOUT_RELEASED": return "Checked in (released from the stale-checkout banner)";
    // Legacy names the checkout modal wrote before the CHECK_OUT/CHECK_IN
    // unification — old rows must keep reading correctly.
    case "DOCUMENT_CHECKOUT": return "Checked out";
    case "DOCUMENT_CHECKIN":  return "Checked in";
    case "ABANDON":      return "Checkout abandoned";
    case "JOIN":         return "Joined collaborative session";
    case "FORCE_RELEASE":return "Checkout force-released";
    case "REV_UP":              return `Rev-up${d.newRev ? ` → ${d.newRev}` : ""}`;
    case "REV_BACKFILL":        return `Backfilled${d.revisionLabel ? ` Rev ${d.revisionLabel}` : " historical revision"}`;
    case "REVERT":              return `Reverted${d.revertedFromRev ? ` from ${d.revertedFromRev}` : ""}`;
    case "DOC_SPLIT":           return `Split into ${d.newDocumentCount ?? "?"} new doc${d.newDocumentCount === 1 ? "" : "s"}`;
    case "CREATED_FROM_SPLIT":  return `Created via split of ${d.sourceDocumentNumber ?? "source"}`;
    case "DOC_MERGED":          return `Merged into ${d.mergedIntoDocumentId ? "target" : "another doc"}`;
    case "CREATED_FROM_MERGE":  return `Created via merge of ${(d.sourceDocumentNumbers as string[] | undefined)?.filter(Boolean).join(", ") || "sources"}`;
    case "DOC_RENUMBERED":      return `Renumbered ${d.previousDocumentNumber ?? "—"} → ${d.newDocumentNumber ?? "?"}`;
    case "SET_REV_UP":          return `Set bumped${d.totalSheets ? `: ${d.succeeded}/${d.totalSheets} sheets succeeded` : ""}`;
    case "DOC_SPLIT_REVERSED":  return `Split reversed${(d.reversedNewDocIds as string[] | undefined)?.length ? ` — ${(d.reversedNewDocIds as string[]).length} new doc${(d.reversedNewDocIds as string[]).length === 1 ? "" : "s"} parked` : ""}`;
    case "DOC_MERGE_REVERSED":  return `Merge reversed${(d.reversedSourceDocIds as string[] | undefined)?.length ? ` — ${(d.reversedSourceDocIds as string[]).length} source${(d.reversedSourceDocIds as string[]).length === 1 ? "" : "s"} restored` : ""}`;
    case "DOC_RENUMBER_REVERSED": return `Renumber reversed${d.restoredToDocumentNumber ? ` → ${d.restoredToDocumentNumber}` : ""}`;
    case "EQUIPMENT_STATE_CHANGED": {
      const prev = d.previousState as string | undefined;
      const next = d.newState as string | undefined;
      const tag = d.assetTag as string | undefined;
      return `${tag ? tag + ": " : ""}${prev ?? "?"} → ${next ?? "?"}`;
    }
    case "MILESTONE_CREATED":   return `Milestone created${d.name ? `: ${d.name}` : ""}`;
    case "MILESTONE_UPDATED":   return `Milestone updated${d.name ? `: ${d.name}` : ""}`;
    case "MILESTONE_COMPLETED": return `Milestone hit${d.name ? `: ${d.name}` : ""}`;
    case "MILESTONE_MISSED":    return `Milestone missed${d.name ? `: ${d.name}` : ""}`;
    case "MILESTONE_BLOCKED":   return `Milestone blocked${d.name ? `: ${d.name}` : ""}`;
    case "MILESTONE_DELETED":   return `Milestone deleted${d.name ? `: ${d.name}` : ""}`;
    // SAF-6: the controls program's milestone vocabulary (PROJECT_EVENT_VOCABULARY).
    case "COST_DOC_AWARDED":    return `Quote awarded${d.vendor ? ` — ${d.vendor}` : ""}${money(d.total) ? ` (${money(d.total)})` : ""}`;
    case "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE": return `Award made over a do-not-use flag${d.vendor ? ` — ${d.vendor}` : ""}`;
    case "CHANGE_ORDER_PROPOSED": return `Change order proposed${d.coNumber ? ` ${d.coNumber}` : ""}${money(d.amount) ? ` (${money(d.amount)})` : ""}`;
    case "CHANGE_ORDER_APPROVED": return `Change order approved${d.coNumber ? ` ${d.coNumber}` : ""}${money(d.amount) ? ` (${money(d.amount)})` : ""}`;
    case "CHANGE_ORDER_REJECTED": return `Change order rejected${d.coNumber ? ` ${d.coNumber}` : ""}`;
    case "CHANGE_ORDER_VOIDED":   return `Change order voided${d.coNumber ? ` ${d.coNumber}` : ""}`;
    case "CHECKLIST_CREATED":   return `Checklist created${d.title ? `: ${d.title}` : ""}`;
    case "CHECKLIST_ASSESSED":  return `Checklist assessed${typeof d.applied === "number" ? ` — ${d.applied} item${d.applied === 1 ? "" : "s"} ruled` : ""}`;
    case "CHECKLIST_STATUS":    return `Checklist ${d.status === "complete" ? "completed" : d.status === "void" ? "voided" : d.status === "open" ? "reopened" : "status changed"}${d.title ? `: ${d.title}` : ""}`;
    case "TURNOVER_SEEDED":     return "Turnover package seeded";
    case "TURNOVER_REVIEWED":   return `Turnover ${typeof d.status === "string" ? d.status : "reviewed"}${d.name ? `: ${d.name}` : ""}`;
    case "PUNCH_STATUS":        return `Punch item ${d.status === "done" ? "closed" : d.status === "void" ? "voided" : "reopened"}${d.title ? `: ${d.title}` : ""}`;
    case "MILESTONES_RESCHEDULED": return `Schedule moved${typeof d.count === "number" ? ` — ${d.count} task${d.count === 1 ? "" : "s"}` : ""}`;
    case "SCHEDULE_BASELINED":  return "Schedule baselined";
    case "SCHEDULE_REBASED":    return "Schedule re-based";
    case "PROJECT_LESSONS_SAVED": return "Lessons learned saved";
    case "SUPERSEDE_DOC":return "Document superseded";
    case "ARCHIVE_DOC":  return d.action === "unarchive" ? "Restored from archive" : "Archived";
    default:             return r.action.replace(/_/g, " ").toLowerCase();
  }
}

function humanizeActivityType(t: string): string {
  return t.replace(/_/g, " ");
}

export interface DocumentTimelineParams {
  documentId: string;
  /** Maximum events to return per source. Default 100. */
  limit?: number;
}

/** Unified per-document timeline. Pulls audit_logs and document_versions
 *  for the given document, attaches Plant/Unit/System context from the
 *  document row itself (single denormalization read, no per-event join),
 *  merges, sorts newest-first. */
export async function getDocumentTimeline(params: DocumentTimelineParams): Promise<TimelineEvent[]> {
  const { documentId, limit = 100 } = params;

  const [auditResult, versionResult, holdResult, scope] = await Promise.all([
    supabase
      .from("audit_logs")
      .select("*")
      .eq("resource_type", "document")
      .eq("resource_id", documentId)
      .order("timestamp", { ascending: false })
      .limit(limit),
    supabase
      .from("document_versions")
      .select("*")
      .eq("record_id", documentId)
      // In-review drafts are only visible to their reviewers/owner (see
      // lib/reviewControl.ts) — the timeline must not leak them to everyone.
      .or(CONTROLLED_VERSIONS_ONLY)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("document_holds")
      .select("*")
      .eq("document_id", documentId)
      .order("opened_at", { ascending: false })
      .limit(limit),
    loadDocumentScope(documentId),
  ]);

  if (auditResult.error) throw new Error(auditResult.error.message);
  if (versionResult.error) throw new Error(versionResult.error.message);
  if (holdResult.error) throw new Error(holdResult.error.message);

  // Holds and the matching HOLD_OPENED / HOLD_RELEASED audit rows
  // describe the same fact pair. HLD-11: dedup by HOLD ID, not by action
  // name — an audit row whose hold row was deleted still renders. "Deleted"
  // is decided by a targeted lookup of the referenced ids, not by absence
  // from the paged holds query.
  const auditRows = (auditResult.data as AuditRow[]) ?? [];
  const holdRows = (holdResult.data as HoldRow[]) ?? [];
  const existingHoldIds = await lookupExistingHoldIds(holdIdsReferencedBy(auditRows), new Set(holdRows.map((h) => h.id)));
  const { auditEvents, holdEvents } = mergeHoldHistory(auditRows, holdRows, existingHoldIds);

  const events: TimelineEvent[] = [
    ...auditEvents,
    ...((versionResult.data as VersionRow[]) ?? []).map(versionRowToEvent),
    ...holdEvents,
  ];

  // Apply the per-document scope to every event. Constant per call,
  // so this is a cheap fan-out, not a per-row join.
  if (scope) for (const e of events) e.scope = scope;

  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return events;
}

/** Resolve plant/unit/system FKs on a document into their human names.
 *  Returns null if the document has no scope attached. One query for
 *  the document, one for each non-null scope FK. */
async function loadDocumentScope(documentId: string): Promise<TimelineEventScope | null> {
  const { data: doc, error } = await supabase
    .from("documents")
    .select("plant_id, unit_id, system_id")
    .eq("id", documentId)
    .maybeSingle();
  if (error || !doc) return null;
  const d = doc as { plant_id: string | null; unit_id: string | null; system_id: string | null };
  if (!d.plant_id && !d.unit_id && !d.system_id) return null;

  const [plant, unit, system] = await Promise.all([
    d.plant_id ? supabase.from("plants").select("id, name").eq("id", d.plant_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    d.unit_id ? supabase.from("units").select("id, name").eq("id", d.unit_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    d.system_id ? supabase.from("systems").select("id, name").eq("id", d.system_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);

  return {
    plantId: d.plant_id,
    plantName: (plant.data as { name?: string } | null)?.name ?? null,
    unitId: d.unit_id,
    unitName: (unit.data as { name?: string } | null)?.name ?? null,
    systemId: d.system_id,
    systemName: (system.data as { name?: string } | null)?.name ?? null,
  };
}

export interface ProjectTimelineParams {
  projectId: string;
  limit?: number;
}

/** Per-project timeline. Merges:
 *   - project_activity rows (the project's own event log)
 *   - the controls program's project- and cost-scoped audit rows (SAF-6):
 *     resource_type 'project' for this project, and resource_type 'cost'
 *     for this project's cost documents — through PROJECT_EVENT_VOCABULARY,
 *     so a milestone is shown and noise stays in audit_logs
 *   - audit_logs, document_versions and document_holds for documents linked
 *     to the project via the Phase 1 project_documents join table — and for
 *     documents DETACHED from it (SAF-17): a doc_removed activity row keeps
 *     the document's history up to the moment it was detached, so one ✕
 *     click no longer erases a drawing's history from the project view
 *
 *  Versions follow the one visibility rule every timeline reader applies
 *  (CONTROLLED_VERSIONS_ONLY, SAF-16): an in-review or rejected draft never
 *  reaches the project feed.
 *
 *  The directive's "linked scope visibility" requirement is what
 *  drives the cross-table pull — without it, a project timeline
 *  showed only manual activity entries and missed the actual
 *  document work the project produced. */
export async function getProjectTimeline(params: ProjectTimelineParams): Promise<TimelineEvent[]> {
  const { projectId, limit = 100 } = params;
  const hidden = pgList(hiddenProjectActions());

  // 1. project_activity (manual + system events tied to the project)
  // 2. Resolve linked document IDs via project_documents
  // 3. SAF-6: the project-scoped controls audit rows, noise filtered in the query
  // 4. SAF-17: documents detached from the project (doc_removed rows) and when
  // 5. SAF-6: the project's cost documents — their awards are cost-scoped rows
  const [activityResult, linkedDocsResult, projectAuditResult, detachedResult, costDocsResult] = await Promise.all([
    supabase
      .from("project_activity")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("project_documents")
      .select("document_id")
      .eq("project_id", projectId),
    supabase
      .from("audit_logs")
      .select("*")
      .eq("resource_type", "project")
      .eq("resource_id", projectId)
      .not("action", "in", hidden)
      .order("timestamp", { ascending: false })
      .limit(limit),
    supabase
      .from("project_activity")
      .select("metadata, created_at")
      .eq("project_id", projectId)
      .eq("type", "doc_removed"),
    supabase
      .from("cost_documents")
      .select("id")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);
  if (activityResult.error) throw new Error(activityResult.error.message);
  if (linkedDocsResult.error) throw new Error(linkedDocsResult.error.message);
  if (projectAuditResult.error) throw new Error(projectAuditResult.error.message);
  if (detachedResult.error) throw new Error(detachedResult.error.message);
  if (costDocsResult.error) throw new Error(costDocsResult.error.message);

  const events: TimelineEvent[] = ((activityResult.data as ProjectActivityRow[]) ?? []).map(projectActivityRowToEvent);
  // The query already left noise out; the map is re-applied so a row the
  // database returned for any other reason is still classified the same way.
  events.push(...((projectAuditResult.data as AuditRow[]) ?? [])
    .filter((r) => isProjectFeedAction(r.action))
    .map(auditRowToEvent));

  const costDocIds = ((costDocsResult.data as Array<{ id: string }>) ?? []).map((r) => r.id);
  if (costDocIds.length > 0) {
    const costAudit = await readByIdChunks<AuditRow>(costDocIds, (part) => supabase
      .from("audit_logs")
      .select("*")
      .eq("resource_type", "cost")
      .in("resource_id", part)
      .not("action", "in", hidden)
      .order("timestamp", { ascending: false })
      .limit(limit));
    events.push(...costAudit
      .filter((r) => isProjectFeedAction(r.action))
      .map(auditRowToEvent));
  }

  const linkedDocIds = ((linkedDocsResult.data as Array<{ document_id: string }>) ?? []).map((r) => r.document_id);
  // SAF-17: a document no longer linked keeps its history up to its latest
  // detach — events after that are not the project's.
  const detachedAt = detachCutoffs(
    ((detachedResult.data as Array<{ metadata: Record<string, unknown> | null; created_at: string }>) ?? []),
    new Set(linkedDocIds),
  );
  const docIds = [...linkedDocIds, ...detachedAt.keys()];
  if (docIds.length > 0) {
    // 6. Audit + version + hold events for the linked (and detached) documents.
    // Each read is chunked (TIMELINE_ID_CHUNK ids) and each chunk capped to
    // `limit` so a project with many docs doesn't return 10,000 rows; the
    // merged sort + final slice still respects the overall limit.
    const [auditRows, versionRows, holdRows] = await Promise.all([
      readByIdChunks<AuditRow>(docIds, (part) => supabase
        .from("audit_logs")
        .select("*")
        .eq("resource_type", "document")
        .in("resource_id", part)
        .order("timestamp", { ascending: false })
        .limit(limit)),
      readByIdChunks<VersionRow>(docIds, (part) => supabase
        .from("document_versions")
        .select("*")
        .in("record_id", part)
        // SAF-16: the same rule as getDocumentTimeline and getRevisionChain.
        .or(CONTROLLED_VERSIONS_ONLY)
        .order("created_at", { ascending: false })
        .limit(limit)),
      readByIdChunks<HoldRow>(docIds, (part) => supabase
        .from("document_holds")
        .select("*")
        .in("document_id", part)
        .order("opened_at", { ascending: false })
        .limit(limit)),
    ]);

    // Same dedup as getDocumentTimeline — by hold id (HLD-11), with the
    // same targeted existence check: the holds page is pooled across every
    // linked document, so a busy project pushes old rows off it fast.
    const existingHoldIds = await lookupExistingHoldIds(holdIdsReferencedBy(auditRows), new Set(holdRows.map((h) => h.id)));
    const { auditEvents, holdEvents } = mergeHoldHistory(auditRows, holdRows, existingHoldIds);

    const docEvents = [
      ...auditEvents,
      ...versionRows.map(versionRowToEvent),
      ...holdEvents,
    ];
    events.push(...docEvents.filter((e) => {
      const cut = detachedAt.get(e.resourceId);
      return cut === undefined || e.timestamp <= cut;
    }));
  }

  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return events.slice(0, limit);
}

/** SAF-17: for every document a doc_removed row names that is NOT linked
 *  now, the time of its latest detach — the cutoff for the history the
 *  project timeline keeps showing. A document linked again is simply
 *  linked (its full history returns). Pure. */
export function detachCutoffs(
  rows: Array<{ metadata: Record<string, unknown> | null; created_at: string }>,
  linked: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const id = typeof r.metadata?.documentId === "string" ? (r.metadata.documentId as string) : null;
    if (!id || linked.has(id)) continue;
    const prev = out.get(id);
    if (!prev || r.created_at > prev) out.set(id, r.created_at);
  }
  return out;
}

// ─── Revision chain ───────────────────────────────────────────
//
// The "revision chain visualization" requirement asks for the
// supersedes lineage to be inspectable. document_versions already
// carries supersedes_version_id; this helper walks the chain in
// release order so a renderer can draw it as a connected list.

export interface RevisionChainNode {
  versionId: string;
  revisionLabel: string;
  releasedAt: string | null;
  createdAt: string;
  createdByName: string | null;
  changeType: string | null;
  changeLog: string | null;
  mocReference: string | null;
  supersedesVersionId: string | null;
  revertedFromVersionId: string | null;
  isCurrent: boolean;
}

export async function getRevisionChain(documentId: string): Promise<RevisionChainNode[]> {
  const [docResult, versionsResult] = await Promise.all([
    supabase
      .from("documents")
      .select("id, current_version_id")
      .eq("id", documentId)
      .maybeSingle(),
    supabase
      .from("document_versions")
      .select("id, revision_label, released_at, created_at, created_by_name, change_type, change_log, moc_reference, supersedes_version_id, reverted_from_version_id")
      .eq("record_id", documentId)
      // Hide in-review drafts — the chain shows controlled revisions only.
      .or(CONTROLLED_VERSIONS_ONLY)
      .order("released_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true }),
  ]);
  if (docResult.error) throw new Error(docResult.error.message);
  if (versionsResult.error) throw new Error(versionsResult.error.message);

  const currentVersionId = (docResult.data as { current_version_id: string | null } | null)?.current_version_id ?? null;
  return ((versionsResult.data as Array<{
    id: string; revision_label: string; released_at: string | null; created_at: string;
    created_by_name: string | null; change_type: string | null; change_log: string | null;
    moc_reference: string | null; supersedes_version_id: string | null;
    reverted_from_version_id: string | null;
  }>) ?? []).map((r) => ({
    versionId: r.id,
    revisionLabel: r.revision_label,
    releasedAt: r.released_at,
    createdAt: r.created_at,
    createdByName: r.created_by_name,
    changeType: r.change_type,
    changeLog: r.change_log,
    mocReference: r.moc_reference,
    supersedesVersionId: r.supersedes_version_id,
    revertedFromVersionId: r.reverted_from_version_id,
    isCurrent: r.id === currentVersionId,
  }));
}
