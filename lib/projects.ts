// lib/projects.ts
// CRUD + activity helpers for the Projects collaboration layer.
//
// A project owns one or more checkouts. Anyone in the org can list and view
// public projects; private projects are visible only to their members (admins
// always see everything for audit purposes).

import { supabase } from "@/lib/supabase";
import { normalizeRoles } from "@/lib/roleCapabilities";
import { isControllerPrincipal } from "@/lib/permissions";
import { SNAPSHOT_READS, type ProjectStateSnapshot } from "@/lib/projectHealth";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { logAuditAction } from "@/lib/audit";
import { notify, notifyMany } from "@/lib/inAppNotifications";
import { listFollowerIds } from "@/lib/subscriptions";
import {
  ensureActiveEpisode,
  postEpisodeSystemMessage,
  reconcileDocumentCheckoutState,
} from "@/lib/checkoutEpisodes";
import type {
  Project, ProjectMember, ProjectActivity, ProjectActivityType,
  ProjectStatus, ProjectVisibility, ProjectMemberRole,
  CheckoutSession, Timestamp, Role,
} from "@/types/schema";

/** Structural type for either the RLS-scoped browser client or a
 *  service-role client (cron). Same shape; lets server callers pass their
 *  own client into the otherwise client-bound helpers below. */
type SupabaseLike = typeof supabase;

// ─── ROW MAPPERS ─────────────────────────────────────────────────────────

export function rowToProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    name: r.name as string,
    description: r.description as string | undefined,
    status: r.status as ProjectStatus,
    ownerUserId: r.owner_user_id as string,
    ownerUserName: r.owner_user_name as string | undefined,
    visibility: r.visibility as ProjectVisibility,
    mocReference: r.moc_reference as string | undefined,
    linkedTicketId: r.linked_ticket_id as string | undefined,
    startedAt: r.started_at as Timestamp,
    targetCompletionDate: r.target_completion_date as Timestamp,
    completedAt: r.completed_at as Timestamp,
    cancelledAt: r.cancelled_at as Timestamp,
    cancelledReason: r.cancelled_reason as string | undefined,
    lastActivityAt: r.last_activity_at as Timestamp,
    createdAt: r.created_at as Timestamp,
    createdBy: r.created_by as string,
    updatedAt: r.updated_at as Timestamp,
    updatedBy: r.updated_by as string | undefined,
  };
}

export function rowToMember(r: Record<string, unknown>): ProjectMember {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    userId: r.user_id as string,
    userName: r.user_name as string | undefined,
    userEmail: r.user_email as string | undefined,
    role: r.role as ProjectMemberRole,
    responsibility: (r.responsibility as string | null) ?? null,
    joinedAt: r.joined_at as Timestamp,
  };
}

export function rowToActivity(r: Record<string, unknown>): ProjectActivity {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    orgId: r.org_id as string,
    userId: r.user_id as string | undefined,
    userName: r.user_name as string | undefined,
    type: r.type as ProjectActivityType,
    body: r.body as string | undefined,
    metadata: r.metadata as Record<string, unknown> | undefined,
    createdAt: r.created_at as Timestamp,
  };
}

// ─── CREATE ──────────────────────────────────────────────────────────────

export type CreateProjectInput = {
  orgId: string;
  name: string;
  description: string;            // required — a project without context is useless
  visibility?: ProjectVisibility;
  mocReference?: string;
  linkedTicketId?: string;
  targetCompletionDate?: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
};

export async function createProject(input: CreateProjectInput): Promise<Project> {
  if (!input.name.trim()) throw new Error("Project name is required");
  if (!input.description?.trim()) throw new Error("Project description is required — explain what the team will be doing");
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("projects")
    .insert({
      org_id: input.orgId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      status: "active",
      owner_user_id: input.actorUserId,
      owner_user_name: input.actorEmail || input.actorUserId,
      visibility: input.visibility || "public",
      moc_reference: input.mocReference?.trim() || null,
      linked_ticket_id: input.linkedTicketId || null,
      target_completion_date: input.targetCompletionDate || null,
      started_at: now,
      last_activity_at: now,
      created_at: now,
      created_by: input.actorUserId,
      updated_at: now,
      updated_by: input.actorUserId,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Failed to create project");

  // Owner is automatically a member with role 'owner'.
  await supabase.from("project_members").insert({
    project_id: data.id,
    user_id: input.actorUserId,
    user_name: input.actorEmail || input.actorUserId,
    user_email: input.actorEmail || null,
    role: "owner",
  });

  // PM-9: the project exists — a refused feed row must not read as a failed
  // create (a retry would make a second project), and must not vanish:
  // it is written into the PROJECT_CREATED audit row.
  const activityError = await writeActivity({
    projectId: data.id,
    orgId: input.orgId,
    userId: input.actorUserId,
    userName: input.actorEmail,
    type: "status_changed",
    body: "Project created",
  });

  await logAuditAction({
    action: "PROJECT_CREATED",
    resourceId: data.id,
    resourceType: "project",
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorEmail,
    userRole: input.actorRole,
    details: { name: input.name, visibility: input.visibility || "public", ...(activityError ? { activityError } : {}) },
  });

  return rowToProject(data as Record<string, unknown>);
}

// ─── ACTIVITY WRITE ──────────────────────────────────────────────────────

type WriteActivityInput = {
  projectId: string;
  orgId: string;
  userId?: string;
  userName?: string;
  type: ProjectActivityType;
  body?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Write one project_activity row — the feed row for a change that has
 * ALREADY committed. The write is checked (PM-9), and its refusal (the
 * 20261102 insert policy — identity, visibility, observers may not comment)
 * comes back as TEXT for the caller to carry (a result field, an audit
 * detail, a message); null means the row was written.
 *
 * It never throws. That is the exported contract its callers in other
 * packages were written against (components/documents/CheckoutFlowModal —
 * after the session insert and the lock claim, before the CHECK_OUT audit;
 * lib/markupRequests — after the request write, before the MARKUP_* audit):
 * a refused feed row must not abort the rest of a flow whose main write
 * saved, skip its audit row, or tell the user an action failed that
 * succeeded. Where the feed row IS the action (a comment),
 * writeActivityChecked throws instead.
 *
 * Identity is the session's (PM-7): the database stamps user_id, user_name
 * and created_at from the signed-in caller (trg_project_activity_stamp), so
 * the userId / userName passed here are a pre-migration fallback only and
 * cannot attribute a row to someone else.
 *
 * projects.last_activity_at is no longer touched from here (PM-9): the
 * client UPDATE was silently filtered out by RLS for every non-owner. An
 * AFTER INSERT trigger on project_activity (20261102) advances it for
 * every author.
 */
export async function writeActivity(input: WriteActivityInput): Promise<string | null> {
  const now = new Date().toISOString();
  try {
    const { error } = await supabase.from("project_activity").insert({
      project_id: input.projectId,
      org_id: input.orgId,
      user_id: input.userId || null,
      user_name: input.userName || null,
      type: input.type,
      body: input.body || null,
      metadata: input.metadata || null,
      created_at: now,
    });
    return error ? `The project activity row was not written: ${error.message}` : null;
  } catch (e) {
    return `The project activity row was not written: ${(e as Error).message}`;
  }
}

/** A feed row that IS the action (a comment): its refusal means nothing
 *  happened, so it throws. */
export async function writeActivityChecked(input: WriteActivityInput): Promise<void> {
  const refused = await writeActivity(input);
  if (refused) throw new Error(refused);
}

/** PM-9: the change landed; its feed row did not. Said, not swallowed —
 *  thrown AFTER everything else the change owes (audit, notices) is done. */
function savedButNotRecorded(what: string, activityError: string): Error {
  return new Error(`${what} — saved, but the project feed row was not written: ${activityError.replace(/^The project activity row was not written: /, "")}`);
}

// ─── LIST PROJECTS ───────────────────────────────────────────────────────

export type ListProjectsFilters = {
  orgId: string;
  status?: ProjectStatus | "all";
  ownerUserId?: string;
  search?: string;
  /** If true, restrict to projects the user can see (public + private where member). */
  visibleToUserId?: string;
};

export async function listProjects(f: ListProjectsFilters): Promise<Project[]> {
  let q = supabase.from("projects").select("*").eq("org_id", f.orgId);
  if (f.status && f.status !== "all") q = q.eq("status", f.status);
  if (f.ownerUserId) q = q.eq("owner_user_id", f.ownerUserId);
  if (f.search?.trim()) q = q.ilike("name", `%${f.search.trim()}%`);
  q = q.order("last_activity_at", { ascending: false });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = (data ?? []).map((r) => rowToProject(r as Record<string, unknown>));

  // If the caller wants private projects filtered, we need a second pass
  // against project_members. Without an org-admin override, hide privates the
  // user doesn't belong to.
  if (f.visibleToUserId) {
    const privates = rows.filter((p) => p.visibility === "private");
    if (privates.length > 0) {
      const ids = privates.map((p) => p.id!).filter(Boolean);
      const { data: memRows } = await supabase
        .from("project_members")
        .select("project_id")
        .in("project_id", ids)
        .eq("user_id", f.visibleToUserId);
      const memberOf = new Set((memRows ?? []).map((r) => r.project_id as string));
      rows = rows.filter((p) =>
        p.visibility === "public"
        || p.ownerUserId === f.visibleToUserId
        || memberOf.has(p.id!)
      );
    }
  }
  return rows;
}

export async function getProject(projectId: string): Promise<Project | null> {
  const { data } = await supabase.from("projects").select("*").eq("id", projectId).maybeSingle();
  return data ? rowToProject(data as Record<string, unknown>) : null;
}

/** PERF-8: the project row once, with the wizard field the page needs
 *  (job_kind — not on the typed Project) read from the SAME row rather than
 *  a second round trip for one column. A refused read throws. */
export async function getProjectForPage(projectId: string): Promise<{ project: Project; jobKind: string | null } | null> {
  const { data, error } = await supabase.from("projects").select("*").eq("id", projectId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return { project: rowToProject(r), jobKind: (r.job_kind as string | null | undefined) ?? null };
}

/** SEC-15: which of these users are ACTIVE members of the org — ownership can
 *  only go to one of them (transfer_project_ownership refuses anyone else),
 *  so the page offers "Make owner" only for them. */
export async function activeOrgMemberIds(orgId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { data, error } = await supabase.from("org_members").select("uid")
    .eq("org_id", orgId).eq("status", "active").in("uid", userIds);
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as Array<{ uid: string }>).map((r) => String(r.uid)));
}

export async function listMembers(projectId: string): Promise<ProjectMember[]> {
  const { data, error } = await supabase
    .from("project_members")
    .select("*")
    .eq("project_id", projectId)
    .order("joined_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => rowToMember(r as Record<string, unknown>));
}

// ─── PROJECT STATUS TRANSITIONS ──────────────────────────────────────────

/** The closed statuses (PM-1): a project in one of these is closed out —
 *  its regulated record refuses writes at the database (20261103), its
 *  intake links are revoked, and only a controller's audited Reopen makes
 *  it writable again. */
export const CLOSED_PROJECT_STATUSES: ReadonlySet<ProjectStatus> = new Set<ProjectStatus>(["completed", "cancelled", "archived"]);

export type StatusTransitionInput = {
  projectId: string;
  orgId: string;
  toStatus: ProjectStatus;
  reason?: string;            // required for cancel
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** SAF-14: the gate state the actor was shown when they confirmed a
   *  completion. Omitted → gathered here, at the moment of the override. */
  gateSnapshot?: ProjectStateSnapshot | null;
};

/** One closeout gate as recorded and rendered: `ok` null = the read it
 *  depends on failed or is not migrated — unknown, never a pass. */
export interface CloseoutGateLine {
  key: "punch" | "turnover" | "checklists" | "checklistsVoided" | "changeOrders";
  ok: boolean | null;
  text: string;
  /** How many items are open behind the gate (null = unknown). Named so
   *  the report prints the line's own text, not "text — n". */
  openCount: number | null;
}

/**
 * SAF-14: the closeout gates — the same lines the Complete dialog shows
 * and the completion's audit row records, so what the report prints is what
 * was open at the moment of the override. A gate whose read failed (or is
 * not migrated) is recorded as unknown, not as clear. Pure.
 *
 * QUAL-15: the checklist gate counts SIGN-OFF, not only item colours — a
 * non-void checklist that is not complete is "not signed off" (and a
 * completion with no signature on record is named as such) whatever its
 * items read; the text keeps "not signed off" apart from "items
 * unresolved". A voided checklist leaves every count, so each one is named
 * on its own failing line with who voided it — a fifth line, present only
 * when one exists.
 */
export function closeoutGateLines(s: ProjectStateSnapshot): CloseoutGateLine[] {
  const gap = new Set([...(s.readFailures ?? []), ...(s.notMigrated ?? [])]);
  const unknown = (...reads: string[]) => reads.some((r) => gap.has(r));
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const checklistOpen = s.checklistOpenItems + s.checklistNeedsEvidence;
  const awaitingSignoff = s.checklistsAwaitingSignoff ?? 0;
  const completedUnsigned = s.checklistsCompletedUnsigned ?? 0;
  const checklistGateOpen = awaitingSignoff + completedUnsigned + checklistOpen;
  const checklistText = [
    awaitingSignoff > 0 ? `${plural(awaitingSignoff, "checklist")} not signed off` : null,
    completedUnsigned > 0 ? `${plural(completedUnsigned, "checklist")} completed with no signature on record` : null,
    checklistOpen > 0 ? `${plural(checklistOpen, "checklist item")} unresolved` : null,
  ].filter(Boolean).join(" · ");
  const voided = s.checklistsVoided ?? [];
  const voidedLine: CloseoutGateLine[] = unknown(SNAPSHOT_READS.checklists) || voided.length === 0 ? [] : [{
    key: "checklistsVoided",
    ok: false,
    text: `${plural(voided.length, "checklist")} voided — ${voided.map((v) => `${v.title} (${
      v.voidedBy ? `voided by ${v.voidedBy}` : v.voidedByUnreadable ? "who voided it could not be read" : "who voided it is not on record"
    })`).join("; ")}`,
    openCount: voided.length,
  }];
  return [
    unknown(SNAPSHOT_READS.punch)
      ? { key: "punch", ok: null, text: "Punch list — could not be read", openCount: null }
      : { key: "punch", ok: s.punchOpen === 0, text: s.punchOpen === 0 ? "Punch list clear" : `${plural(s.punchOpen, "punch item")} still open`, openCount: s.punchOpen },
    unknown(SNAPSHOT_READS.turnover)
      ? { key: "turnover", ok: null, text: "Turnover package — could not be read", openCount: null }
      : {
          key: "turnover",
          ok: s.turnoverRequired === 0 || s.turnoverAccepted >= s.turnoverRequired,
          text: s.turnoverRequired === 0 ? "No turnover requirements set"
            : s.turnoverAccepted >= s.turnoverRequired ? "Turnover package fully accepted"
            : `Turnover ${s.turnoverAccepted}/${s.turnoverRequired} accepted`,
          openCount: Math.max(0, s.turnoverRequired - s.turnoverAccepted),
        },
    unknown(SNAPSHOT_READS.checklists, SNAPSHOT_READS.checklistItems)
      ? { key: "checklists", ok: null, text: "Checklists — could not be read", openCount: null }
      : { key: "checklists", ok: checklistGateOpen === 0, text: checklistGateOpen === 0 ? "Checklists clear" : checklistText, openCount: checklistGateOpen },
    ...voidedLine,
    unknown(SNAPSHOT_READS.changeOrders)
      ? { key: "changeOrders", ok: null, text: "Change orders — could not be read", openCount: null }
      : { key: "changeOrders", ok: s.openChangeOrders === 0, text: s.openChangeOrders === 0 ? "No change orders awaiting decision" : `${plural(s.openChangeOrders, "change order")} awaiting decision`, openCount: s.openChangeOrders },
  ];
}

/** A session the release could not end, and why — shown as "still held by X". */
export interface StillHeldCheckout {
  sessionId: string;
  documentId: string;
  userId: string;
  userName: string | null;
  reason: string;
}

/** PM-4: what the project release actually did — never assumed. */
export interface ProjectReleaseOutcome {
  released: number;
  releasedSessionIds: string[];
  stillHeld: StillHeldCheckout[];
}

export interface StatusTransitionResult {
  /** Set when the status DID change but not every active checkout was
   *  released (DCK-9 / PM-4) — "still held by …", or the release's own
   *  failure. The caller shows it against the new status. */
  releaseError: string | null;
  /** PM-4: the real release outcome (null when the transition releases nothing). */
  release: ProjectReleaseOutcome | null;
  /** PM-1: intake links revoked by this closure. */
  revokedIntakeLinks: number;
  /** PM-9: the status change landed but its feed row was refused. */
  activityError: string | null;
}

/** Human line for a release outcome — the notification body and the page's
 *  message are built from THIS, i.e. from what really happened (PM-4 dw3). */
export function describeReleaseOutcome(o: ProjectReleaseOutcome): string {
  const parts: string[] = [];
  if (o.released > 0) parts.push(`${o.released} active checkout${o.released === 1 ? " was" : "s were"} released`);
  if (o.stillHeld.length > 0) {
    const names = Array.from(new Set(o.stillHeld.map((h) => h.userName || h.userId)));
    parts.push(`${o.stillHeld.length} ${o.stillHeld.length === 1 ? "is" : "are"} still held by ${names.join(", ")}`);
  }
  return parts.length ? `${parts.join("; ")}.` : "No checkouts were active on the project.";
}

/**
 * Change a project's status. Owner or controller (defense in depth beside
 * the 20260906 / 20261102 RLS).
 *
 * Closing (completed / cancelled / archived — PM-1):
 *  · the project's intake links are REVOKED first (fail safe: if that write
 *    is refused nothing else happens; a reopened project mints new links);
 *  · a completion records the closeout gate snapshot in its audit row
 *    (SAF-14) — the gates are checks with an override, not blocks;
 *  · every active checkout is released PER SESSION (PM-4): sessions the
 *    actor may not release stay active and come back as "still held by X".
 *
 * A closed project is reopened only by reopenProject (controller-only,
 * audited); this function refuses to move a closed project back to an open
 * status.
 *
 * Returns `releaseError` when the status change succeeded but checkouts
 * were NOT all released. The status DID change — a throw here would make
 * the caller skip its refresh and render the old status beside the message
 * — so the refusal travels in the result. Any failure BEFORE the status
 * change throws.
 */
export async function transitionProjectStatus(input: StatusTransitionInput): Promise<StatusTransitionResult> {
  // Defense in depth alongside the 20260906 RLS: owner/controller only.
  const current = await assertCanManageProject(input.projectId, input.actorUserId);
  const closing = CLOSED_PROJECT_STATUSES.has(input.toStatus);
  if (current.status && CLOSED_PROJECT_STATUSES.has(current.status) && !closing) {
    throw new Error(`This project is ${current.status}. Reopening a closed project is a separate, audited action (Admin / Document Control).`);
  }
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: input.toStatus,
    updated_at: now,
    updated_by: input.actorUserId,
  };
  if (input.toStatus === "completed") update.completed_at = now;
  if (input.toStatus === "cancelled") {
    if (!input.reason?.trim()) throw new Error("Cancellation reason is required");
    update.cancelled_at = now;
    update.cancelled_reason = input.reason.trim();
  }

  // PM-1: the external door closes with the project — before the status
  // changes, so a refused revocation leaves the project open, never closed
  // with live contractor links.
  let revokedIntakeLinks = 0;
  if (closing) revokedIntakeLinks = await revokeProjectIntakeLinks(input.projectId, now);

  // SAF-14: what was open at the moment of the completion override.
  let gates: CloseoutGateLine[] | null = null;
  let gateSnapshotError: string | null = null;
  if (input.toStatus === "completed") {
    try {
      const snap = input.gateSnapshot
        ?? await (await import("@/lib/projectSnapshot")).gatherProjectSnapshotUncached(input.orgId, input.projectId);
      gates = closeoutGateLines(snap);
    } catch (e) {
      gateSnapshotError = (e as Error).message;
    }
  }

  // RETURNING: an UPDATE the policy filters out matches zero rows with no
  // error. The status did NOT change then, so nothing below — the feed row,
  // the audit row, the release, the notice — may happen.
  const { data: changed, error } = await supabase.from("projects").update(update).eq("id", input.projectId).select("id");
  if (error) throw new Error(error.message);
  if (((changed ?? []) as unknown[]).length === 0) {
    throw new Error(`The project's status did not change: the database did not update it (you may no longer be allowed to manage it).${revokedIntakeLinks > 0 ? ` Its ${revokedIntakeLinks} contractor intake link(s) were revoked first — mint new ones if the project stays open.` : ""}`);
  }

  const activityError = await writeActivity({
    projectId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userName: input.actorEmail,
    type: "status_changed",
    body: `Project ${input.toStatus}${input.reason ? `: ${input.reason}` : ""}`,
    metadata: { toStatus: input.toStatus, reason: input.reason },
  });

  await logAuditAction({
    action: `PROJECT_${input.toStatus.toUpperCase()}`,
    resourceId: input.projectId,
    resourceType: "project",
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorEmail,
    userRole: input.actorRole,
    details: {
      reason: input.reason || null,
      fromStatus: current.status ?? null,
      ...(closing ? { revokedIntakeLinks } : {}),
      ...(input.toStatus === "completed"
        // SAF-14: a snapshot that could not be gathered is UNKNOWN, never
        // "not overridden" — overridden is null beside gates: null.
        ? { gates, overridden: gates === null ? null : gates.some((g) => g.ok !== true), ...(gateSnapshotError ? { gateSnapshotError } : {}) }
        : {}),
      ...(activityError ? { activityError } : {}),
    },
  });

  // Closing releases every active checkout on the project — per session
  // (PM-4). DCK-9: a refused release is reported AFTER the audience is told
  // about the status change — the status did change; what did not happen
  // must not vanish into a warn, and must not be thrown as if the change
  // had not happened.
  let release: ProjectReleaseOutcome | null = null;
  let releaseFailure: Error | null = null;
  if (closing) {
    try {
      release = await releaseAllCheckoutsForProject({
        projectId: input.projectId,
        reason: input.reason || `Project ${input.toStatus}`,
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail ?? null,
        actorRole: input.actorRole ?? null,
      });
    } catch (e) {
      releaseFailure = e as Error;
    }
  }

  // Tell the people who care — built from what really happened (PM-4 dw3).
  const { data: pj } = await supabase.from("projects").select("name").eq("id", input.projectId).maybeSingle();
  const releaseLine = release ? describeReleaseOutcome(release)
    : releaseFailure ? "Its active checkouts were NOT released." : null;
  await notifyProjectAudience({
    projectId: input.projectId, orgId: input.orgId,
    actorUserId: input.actorUserId, actorName: input.actorEmail?.split("@")[0],
    kind: "project_status",
    title: `Project ${input.toStatus}: ${(pj?.name as string) ?? "project"}`,
    body: [input.reason ? `Reason: ${input.reason}` : null, closing ? releaseLine : null].filter(Boolean).join(" ") || undefined,
  });

  let releaseError: string | null = null;
  if (releaseFailure) {
    releaseError = `The project is ${input.toStatus}, but its active checkouts were NOT released: ${releaseFailure.message.replace(/^The project's active checkouts were NOT released: /, "")}`;
  } else if (release && release.stillHeld.length > 0) {
    releaseError = `The project is ${input.toStatus}, but not every active checkout was released: ${describeReleaseOutcome(release)} Ask the holder to check in, or an Admin / Document Control to release them.`;
  }
  return { releaseError, release, revokedIntakeLinks, activityError };
}

/** PM-1: revoke the project's live intake links. Checked; a missing table
 *  (pre-20260902) means there is nothing to revoke. Kept inline rather than
 *  calling lib/intakeLinks.ts's revokeProjectIntakeLinks (J1): a refused
 *  revocation must THROW here, before the status changes, and the close and
 *  delete audit rows already carry the count. The database closes the doors
 *  on every delete path as well (delete_project_record, 20261103; the
 *  AFTER DELETE trigger trg_projects_close_intake_links, 20261104). */
async function revokeProjectIntakeLinks(projectId: string, nowIso: string): Promise<number> {
  const { data, error } = await supabase
    .from("project_intake_links")
    .update({ revoked_at: nowIso })
    .eq("project_id", projectId)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return 0;
    throw new Error(`The project's contractor intake links could not be revoked, so the project was not closed: ${error.message}`);
  }
  return ((data ?? []) as unknown[]).length;
}

/**
 * PM-1 dw2/dw3: reopen a closed project — a distinct, audited,
 * controller-only action. The 20261103 reopen_project RPC checks the
 * controller tier, requires a reason, clears completed_at / cancelled_at /
 * cancelled_reason, and writes the PROJECT_REOPENED audit row and the feed
 * row in one transaction; the closed-project write guard lets it through
 * and nothing else. Intake links stay revoked — reopening mints new ones.
 */
export async function reopenProject(input: {
  projectId: string; orgId: string; reason: string;
  actorUserId: string; actorEmail?: string;
}): Promise<void> {
  if (!input.reason.trim()) throw new Error("A reason is required to reopen a closed project.");
  const { error } = await supabase.rpc("reopen_project", { p_project: input.projectId, p_reason: input.reason.trim() });
  if (error) {
    if (isMissingRpc(error)) throw new Error("Reopening a closed project needs database migration 20261103 (reopen_project). Ask an administrator to apply it.");
    throw new Error(error.message);
  }
  await notifyProjectAudience({
    projectId: input.projectId, orgId: input.orgId,
    actorUserId: input.actorUserId, actorName: input.actorEmail?.split("@")[0],
    kind: "project_status",
    title: "Project reopened",
    body: `Reason: ${input.reason.trim()}`,
  });
}

/** PostgREST / Postgres "function does not exist" — the migration that
 *  defines the RPC has not been applied yet. */
function isMissingRpc(error: { code?: string | null; message?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883"
    || /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

// ─── CHECKOUTS LINKED TO PROJECTS ────────────────────────────────────────

export async function listProjectCheckouts(projectId: string): Promise<CheckoutSession[]> {
  const { data, error } = await supabase
    .from("checkout_sessions")
    .select("*")
    .eq("project_id", projectId)
    .order("started_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToCheckoutSession);
}

export async function listAllActiveCheckouts(orgId: string): Promise<CheckoutSession[]> {
  const { data, error } = await supabase
    .from("checkout_sessions")
    .select("*")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("started_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToCheckoutSession);
}

function rowToCheckoutSession(r: Record<string, unknown>): CheckoutSession {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    documentId: r.document_id as string,
    libraryId: r.library_id as string,
    userId: r.user_id as string,
    userName: r.user_name as string | undefined,
    mode: r.mode as CheckoutSession["mode"],
    note: r.note as string | undefined,
    status: r.status as CheckoutSession["status"],
    linkedTicketId: r.linked_ticket_id as string | undefined,
    lockId: r.lock_id as string | undefined,
    startedAt: r.started_at as Timestamp,
    lastSeenAt: r.last_seen_at as Timestamp,
    expiresAt: r.expires_at as Timestamp,
    endedAt: r.ended_at as Timestamp,
    projectId: r.project_id as string | undefined,
    purpose: r.purpose as string | undefined,
    expectedReleaseAt: r.expected_release_at as Timestamp,
    autoExpiresAt: r.auto_expires_at as Timestamp,
    releasedAt: r.released_at as Timestamp,
    releasedBy: r.released_by as string | undefined,
    releasedReason: r.released_reason as string | undefined,
    episodeId: (r.episode_id as string | null | undefined) ?? null,
  };
}

/** DCK-9: ending every checkout on a project is a CHECK-IN of each session,
 *  and the register says so — an outcome on every row (`auto_released`: the
 *  project's state change ended it, nobody chose it; the reason travels in
 *  outcome_note) and a CHECK_IN audit row per document.
 *
 *  PM-4: the release runs PER SESSION. The release guard
 *  (enforce_checkout_release_guard) refuses a status change on another
 *  user's session unless the actor holds checkout.force_release, and a
 *  BEFORE-trigger RAISE aborts the whole statement — so one batch UPDATE let
 *  a single refusal leave EVERY session active, the actor's own included.
 *  Now the actor's own sessions end in one statement (the guard never
 *  refuses those), every other session is released on its own, and a
 *  refused session stays active and comes back in `stillHeld` naming its
 *  holder. The authority is the guard's, unchanged: a controller (or anyone
 *  holding checkout.force_release) releases everyone's; nobody else releases
 *  anyone else's. (force_release_document is not used here: it ends EVERY
 *  active session on the document, including ones held outside this
 *  project, which the per-document settle below exists to protect.)
 *
 *  A failure of the actor's own batch throws. Exported for tests;
 *  transitionProjectStatus is the caller. */
export async function releaseAllCheckoutsForProject(params: {
  projectId: string;
  reason: string;
  actorUserId: string;
  actorEmail?: string | null;
  actorRole?: string | null;
}): Promise<ProjectReleaseOutcome> {
  const now = new Date().toISOString();
  const { data: active, error: listErr } = await supabase
    .from("checkout_sessions")
    .select("id, document_id, org_id, user_id, user_name")
    .eq("project_id", params.projectId)
    .eq("status", "active");
  if (listErr) throw new Error(`Project checkouts could not be read: ${listErr.message}`);

  const none: ProjectReleaseOutcome = { released: 0, releasedSessionIds: [], stillHeld: [] };
  if (!active || active.length === 0) return none;

  type ActiveRow = { id: string; document_id: string; org_id: string; user_id: string; user_name: string | null };
  const rows = active as ActiveRow[];
  const docIds = Array.from(new Set(rows.map((r) => r.document_id)));
  const orgByDoc = new Map(rows.map((r) => [r.document_id, r.org_id]));

  const basePayload = {
    status: "checked_in",
    ended_at: now,
    released_at: now,
    released_by: params.actorUserId,
    released_reason: params.reason,
  };
  type EndedRow = { id: string; document_id: string; user_id: string; user_name: string | null };
  const endSessions = async (ids: string[]): Promise<{ ended: EndedRow[]; error: { message: string; code?: string } | null }> => {
    const run = (payload: Record<string, unknown>) =>
      supabase
        .from("checkout_sessions")
        .update(payload)
        .in("id", ids)
        .eq("status", "active")
        .select("id, document_id, user_id, user_name");
    let { data, error } = await run({ ...basePayload, outcome: "auto_released", outcome_note: params.reason });
    if (error) {
      const { isMissingOutcomeSchema } = await import("@/lib/checkoutEpisodes");
      // Pre-20261012 environment: record the check-in without the register columns.
      if (isMissingOutcomeSchema(error)) ({ data, error } = await run(basePayload));
    }
    return { ended: ((data ?? []) as EndedRow[]), error: error ? { message: error.message, code: (error as { code?: string }).code } : null };
  };

  const endedRows: EndedRow[] = [];
  const stillHeld: StillHeldCheckout[] = [];

  // The actor's own sessions: one statement — the guard never refuses these.
  const own = rows.filter((r) => String(r.user_id) === String(params.actorUserId));
  // In batches of IN_FILTER_CHUNK ids: a longer `.in("id", …)` list can
  // exceed the API gateway's URL limit.
  for (let i = 0; i < own.length; i += IN_FILTER_CHUNK) {
    const res = await endSessions(own.slice(i, i + IN_FILTER_CHUNK).map((r) => r.id));
    if (res.error) throw new Error(`The project's active checkouts were NOT released: ${res.error.message}`);
    endedRows.push(...res.ended);
  }
  // Everyone else's: one session at a time, so a refusal holds only itself.
  for (const r of rows.filter((x) => String(x.user_id) !== String(params.actorUserId))) {
    const res = await endSessions([r.id]);
    if (res.error) {
      stillHeld.push({ sessionId: r.id, documentId: r.document_id, userId: r.user_id, userName: r.user_name, reason: res.error.message });
      continue;
    }
    endedRows.push(...res.ended);
  }

  // The document's control history shows the check-in — one row per
  // document naming every session it ended (DCK-9 done-when 2).
  for (const docId of Array.from(new Set(endedRows.map((r) => r.document_id)))) {
    const mine = endedRows.filter((r) => r.document_id === docId);
    await logAuditAction({
      action: "CHECK_IN",
      resourceId: docId,
      resourceType: "document",
      orgId: orgByDoc.get(docId),
      userId: params.actorUserId,
      userEmail: params.actorEmail ?? undefined,
      userRole: params.actorRole ?? undefined,
      details: {
        outcome: "auto_released",
        via: "project_release",
        projectId: params.projectId,
        reason: params.reason,
        releasedSessions: mine.map((x) => ({ sessionId: x.id, userId: x.user_id, userName: x.user_name })),
      },
    });
  }

  // Settle each document from its REMAINING active sessions. A blanket
  // column-clear here used to free docs that other users (outside this
  // project) still had checked out, and left stale collaborator names.
  for (const docId of docIds) {
    try {
      await reconcileDocumentCheckoutState(docId, {
        orgId: orgByDoc.get(docId),
        actorUserId: params.actorUserId,
        closeReason: "checked_in",
      });
    } catch (e) {
      console.warn("[releaseAllCheckoutsForProject] reconcile failed for", docId, e);
    }
  }
  return { released: endedRows.length, releasedSessionIds: endedRows.map((r) => r.id), stillHeld };
}

// ─── THE DOCUMENT REGISTER (UX-11) ───────────────────────────────────────

/** One row of the project's Documents tab register — a live reference to a
 *  controlled document (DEC-40: never a copy), marked current or not. */
export interface ProjectDocumentRow {
  /** project_documents.id — null for an approved intake document that is
   *  not (yet) adopted into the register. */
  linkId: string | null;
  docId: string;
  label: string;
  rev: string | null;
  status: string | null;
  libraryId: string | null;
  source: "checkout" | "manual" | "intake";
  lastSeenAt: string | null;
  /** DEC-40: false for a superseded / voided / archived document — the tab
   *  says so rather than presenting it as the drawing in force. */
  isCurrent: boolean;
}

export interface ProjectDocumentRegister {
  rows: ProjectDocumentRow[];
  /** Linked documents the viewer's permissions hide — disclosed as a count,
   *  never silently dropped. */
  hiddenByPermissions: number;
  /** Their ids (distinct), so the tab badge can count a hidden document
   *  that is ALSO checked out under the project once, not twice. */
  hiddenDocIds: string[];
}

/** Document ids per `.in()` read of the register — keeps the request line
 *  bounded however many documents a project lists. */
const REGISTER_DOC_CHUNK = 100;
/** The most ids one `.in("id", …)` filter carries (the gateway URL limit). */
const IN_FILTER_CHUNK = 100;

/** Before 20260902 the projects row has no intake_collection_id — then the
 *  project simply has no intake collection. Any OTHER failure of that read
 *  is a failure, never "no intake". */
function isMissingIntakeColumn(error: { code?: string | null; message?: string }): boolean {
  const msg = (error.message ?? "").toLowerCase();
  if (!msg.includes("intake_collection_id")) return false;
  return error.code === "42703" || error.code === "PGRST204"
    || msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find");
}

/**
 * UX-11: the Documents tab's primary list. The project's register
 * (project_documents: checkout-linked and hand-attached) PLUS the
 * contractor intake documents that were APPROVED (they carry a current
 * version) but not yet adopted — so 40 approved sheets are visible here,
 * not only inside the Intake tab's transition-in panel. A pending (never
 * approved) submission is not listed. Linked rows the viewer cannot read
 * are counted in `hiddenByPermissions`.
 *
 * Every read is complete or fails: the register and the approved intake
 * page to exhaustion under PostgREST's row cap, the linked documents are
 * read 100 ids per request, and a failed project read throws (it used to
 * read as "no intake collection", and the approved sheets vanished from
 * the tab and the badge with no message).
 */
export async function listProjectDocuments(projectId: string): Promise<ProjectDocumentRegister> {
  const [linkRows, projRes] = await Promise.all([
    readAllPages("The project's document register could not be read", (from, to) => supabase.from("project_documents")
      .select("id, document_id, source, last_seen_at")
      .eq("project_id", projectId)
      .order("last_seen_at", { ascending: false })
      .order("id")
      .range(from, to)),
    supabase.from("projects").select("org_id, intake_collection_id").eq("id", projectId).maybeSingle(),
  ]);
  const links = linkRows as Array<{ id: string; document_id: string; source: string | null; last_seen_at: string | null }>;
  if (projRes.error && !isMissingIntakeColumn(projRes.error)) {
    throw new Error(`The project could not be read, so its approved intake documents cannot be listed: ${projRes.error.message}`);
  }
  const proj = (projRes.error ? null : projRes.data) as { org_id: string; intake_collection_id: string | null } | null;

  const COLS = "id, document_number, title, name, rev, status, library_id, archived_at";
  type DocRow = { id: string; document_number: string | null; title: string | null; name: string | null; rev: string | null; status: string | null; library_id: string | null; archived_at?: string | null };
  const linkedIds = [...new Set(links.map((l) => String(l.document_id)))];
  const readLinked = async (): Promise<DocRow[]> => {
    const out: DocRow[] = [];
    for (let i = 0; i < linkedIds.length; i += REGISTER_DOC_CHUNK) {
      const { data, error } = await supabase.from("documents").select(COLS).in("id", linkedIds.slice(i, i + REGISTER_DOC_CHUNK));
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as DocRow[]));
    }
    return out;
  };
  const readIntake = async (): Promise<DocRow[]> => {
    if (!proj?.intake_collection_id) return [];
    const { org_id, intake_collection_id } = proj;
    return (await readAllPages("The project's approved intake documents could not be read", (from, to) => supabase.from("documents").select(COLS)
      .eq("org_id", org_id)
      .eq("collection_id", intake_collection_id)
      .not("current_version_id", "is", null)
      .order("created_at", { ascending: false })
      .order("id")
      .range(from, to))) as DocRow[];
  };
  const [linkedDocs, intakeDocs] = await Promise.all([readLinked(), readIntake()]);
  const byId = new Map(linkedDocs.map((d) => [String(d.id), d]));
  const toRow = (d: DocRow, link: { id: string; source: string | null; last_seen_at: string | null } | null): ProjectDocumentRow => ({
    linkId: link ? String(link.id) : null,
    docId: String(d.id),
    label: String(d.document_number || d.title || d.name || "Document"),
    rev: d.rev ?? null,
    status: d.status ?? null,
    libraryId: d.library_id ?? null,
    source: link ? (link.source === "manual" ? "manual" : "checkout") : "intake",
    lastSeenAt: link?.last_seen_at ?? null,
    isCurrent: !d.archived_at && !NOT_CURRENT_STATUSES.has(d.status ?? ""),
  });

  const rows: ProjectDocumentRow[] = [];
  const hidden = new Set<string>();
  for (const l of links) {
    const d = byId.get(String(l.document_id));
    if (!d) { hidden.add(String(l.document_id)); continue; }
    rows.push(toRow(d, l));
  }
  const inRegister = new Set(rows.map((r) => r.docId));
  const linkedSet = new Set(linkedIds);
  for (const d of intakeDocs) {
    if (!inRegister.has(String(d.id)) && !linkedSet.has(String(d.id))) rows.push(toRow(d, null));
  }
  return { rows, hiddenByPermissions: hidden.size, hiddenDocIds: [...hidden] };
}

/** UX-11: the Documents tab badge — DISTINCT documents the tab shows (the
 *  register, approved intake, and anything checked out under the project),
 *  plus the ones hidden by permissions it discloses — all in ONE set, so a
 *  restricted document that is also checked out under the project counts
 *  once. Never a session count. Pure. */
export function documentsTabCount(register: ProjectDocumentRegister | null, checkoutDocIds: readonly string[]): number {
  const ids = new Set<string>(checkoutDocIds.filter(Boolean));
  for (const r of register?.rows ?? []) ids.add(r.docId);
  for (const id of register?.hiddenDocIds ?? []) ids.add(id);
  return ids.size;
}

// ─── COMMENTS / ACTIVITY READ ────────────────────────────────────────────

export async function listActivity(projectId: string, limit = 100): Promise<ProjectActivity[]> {
  const { data, error } = await supabase
    .from("project_activity")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => rowToActivity(r as Record<string, unknown>));
}

export async function postComment(input: {
  projectId: string;
  orgId: string;
  body: string;
  actorUserId: string;
  actorEmail?: string;
}): Promise<void> {
  if (!input.body.trim()) throw new Error("Comment cannot be empty");
  // The comment IS the activity row: a refusal (20261102 — an observer, or a
  // project the caller cannot see) means nothing was posted, and says so.
  try {
    await writeActivityChecked({
      projectId: input.projectId,
      orgId: input.orgId,
      userId: input.actorUserId,
      userName: input.actorEmail,
      type: "comment",
      body: input.body.trim(),
    });
  } catch (e) {
    throw new Error(`Your comment was not posted: ${(e as Error).message.replace(/^The project activity row was not written: /, "")}`);
  }
  const trimmed = input.body.trim();
  await notifyProjectAudience({
    projectId: input.projectId, orgId: input.orgId,
    actorUserId: input.actorUserId, actorName: input.actorEmail?.split("@")[0],
    kind: "project_comment",
    title: `New comment from ${input.actorEmail?.split("@")[0] ?? "a teammate"}`,
    body: trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed,
  });
}

// ─── ADD/REMOVE CHECKOUT ON A PROJECT ────────────────────────────────────

/** Re-attach an existing active checkout to a project (or move it). */
export async function attachCheckoutToProject(input: {
  checkoutSessionId: string;
  projectId: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
}): Promise<void> {
  const { error } = await supabase
    .from("checkout_sessions")
    .update({ project_id: input.projectId })
    .eq("id", input.checkoutSessionId);
  if (error) throw new Error(error.message);
  const activityError = await writeActivity({
    projectId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userName: input.actorEmail,
    type: "checkout_added",
    body: "Checkout attached to project",
    metadata: { checkoutSessionId: input.checkoutSessionId },
  });
  if (activityError) throw savedButNotRecorded("The checkout was attached to the project", activityError);
}

export async function addMember(input: {
  projectId: string;
  orgId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  role?: ProjectMemberRole;
  responsibility?: string;
  actorUserId: string;
  actorEmail?: string;
}): Promise<void> {
  if (input.role === "owner") {
    throw new Error("Ownership moves only through Transfer ownership — a member cannot be added as owner.");
  }
  const { error } = await supabase.from("project_members").upsert({
    project_id: input.projectId,
    user_id: input.userId,
    user_name: input.userName || null,
    user_email: input.userEmail || null,
    role: input.role || "collaborator",
    responsibility: input.responsibility?.trim() || null,
  }, { onConflict: "project_id,user_id" });
  if (error) throw new Error(error.message);
  const activityError = await writeActivity({
    projectId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userName: input.actorEmail,
    type: "member_joined",
    body: `${input.userName || input.userEmail || input.userId} joined the project`,
  });
  // Bell notification to the user being added so they know.
  void notify({
    orgId: input.orgId,
    userId: input.userId,
    actorUserId: input.actorUserId,
    actorName: input.actorEmail,
    kind: "project_member",
    title: `Added to project`,
    body: `${input.actorEmail || "Someone"} added you to a project. Click to open.`,
    link: `/projects/${input.projectId}`,
    resourceType: "project",
    resourceId: input.projectId,
  });
  if (activityError) throw savedButNotRecorded(`${input.userName || input.userEmail || "The member"} was added`, activityError);
}

/**
 * Remove a member from a project. Idempotent — removing someone who
 * isn't a member is a no-op. Owner of the project cannot remove
 * themselves; callers must transfer ownership first (separate flow).
 */
export async function removeMember(input: {
  projectId: string;
  orgId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  actorUserId: string;
  actorEmail?: string;
}): Promise<void> {
  await assertCanManageProject(input.projectId, input.actorUserId);
  const proj = await getProject(input.projectId);
  if (!proj) throw new Error("Project not found");
  if (proj.ownerUserId === input.userId) {
    throw new Error("Can't remove the project owner. Transfer ownership first.");
  }
  const { error } = await supabase
    .from("project_members")
    .delete()
    .eq("project_id", input.projectId)
    .eq("user_id", input.userId);
  if (error) throw new Error(error.message);
  const activityError = await writeActivity({
    projectId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userName: input.actorEmail,
    type: "member_left",
    body: `${input.userName || input.userEmail || input.userId} was removed from the project`,
  });
  await logAuditAction({
    action: "PROJECT_MEMBER_REMOVED",
    resourceId: input.projectId, resourceType: "project",
    orgId: input.orgId, userId: input.actorUserId, userEmail: input.actorEmail,
    details: { removedUserId: input.userId, removedName: input.userName ?? input.userEmail ?? null },
  });
  // The removed person deserves to know — they'd otherwise discover it by 404.
  await notify({
    orgId: input.orgId, userId: input.userId,
    actorUserId: input.actorUserId, actorName: input.actorEmail?.split("@")[0],
    kind: "project_member",
    title: `You were removed from ${proj.name}`,
    link: "/projects",
    resourceType: "project", resourceId: input.projectId,
  }).catch(() => undefined);
  if (activityError) throw savedButNotRecorded(`${input.userName || input.userEmail || "The member"} was removed`, activityError);
}

// ─── OWNERSHIP / DELETE / MEMBER MANAGEMENT ──────────────────────────────

export interface ManagedProject {
  id: string; orgId: string; ownerUserId: string; name: string;
  status: ProjectStatus | null;
}

/** Verify the actor may manage this project — its current owner, or an org
 *  controller — and is an ACTIVE member of the project's org (SEC-9: the
 *  user_owns_project shape; an offboarded owner manages nothing). The
 *  controller tier is the role COLLECTION through isControllerPrincipal
 *  (PM-5, DEC-35) — the same rule as the database's is_org_controller, with
 *  no facility role literal here. Returns the project's core fields.
 *  Throws otherwise. */
export async function assertCanManageProject(projectId: string, actorUserId: string): Promise<ManagedProject> {
  const { data, error } = await supabase
    .from("projects").select("id, org_id, owner_user_id, name, status").eq("id", projectId).maybeSingle();
  if (error || !data) throw new Error("Project not found.");
  const p = data as { id: string; org_id: string; owner_user_id: string; name: string; status?: ProjectStatus | null };
  const out: ManagedProject = { id: p.id, orgId: p.org_id, ownerUserId: p.owner_user_id, name: p.name, status: p.status ?? null };
  const { data: mem, error: memErr } = await supabase
    .from("org_members").select("role, roles").eq("org_id", p.org_id).eq("uid", actorUserId).eq("status", "active").maybeSingle();
  if (memErr) throw new Error(`Your membership could not be checked: ${memErr.message}`);
  if (!mem) throw new Error("Only an active member of this workspace can manage its projects.");
  if (String(p.owner_user_id) === String(actorUserId)) return out;
  const m = mem as { role?: string | null; roles?: unknown };
  if (isControllerPrincipal({ role: (m.role ?? "") as Role, roles: normalizeRoles(m.roles, m.role) })) return out;
  throw new Error("Only the project owner or an admin can do this.");
}

/** PM-6 / QUAL-3: what deleting a project would destroy, by table. `null`
 *  = that count could not be read (shown as unknown, never as zero). */
export interface ProjectRecordCounts {
  costAccounts: number | null;
  costEntries: number | null;
  costDocuments: number | null;
  changeOrders: number | null;
  parties: number | null;
  checklists: number | null;
  checklistItems: number | null;
  turnoverItems: number | null;
  punchItems: number | null;
  documentLinks: number | null;
  milestones: number | null;
}

const RECORD_COUNT_LABELS: Array<[keyof ProjectRecordCounts, string, string]> = [
  ["costAccounts", "budget line", "budget lines"],
  ["costEntries", "cost entry", "cost entries"],
  ["costDocuments", "quote / invoice", "quotes / invoices"],
  ["changeOrders", "change order", "change orders"],
  ["parties", "company on the job", "companies on the job"],
  ["checklists", "checklist", "checklists"],
  ["checklistItems", "checklist item", "checklist items"],
  ["turnoverItems", "turnover item", "turnover items"],
  ["punchItems", "punch item", "punch items"],
  ["documentLinks", "document link", "document links"],
  ["milestones", "schedule task", "schedule tasks"],
];

/** The financial and quality record (PM-6 / QUAL-3): a project carrying any
 *  of these cannot be hard-deleted except by a controller, with a reason,
 *  through delete_project_record — which audits the counts and a snapshot. */
export const REGULATED_RECORD_KEYS: ReadonlyArray<keyof ProjectRecordCounts> = [
  "costAccounts", "costEntries", "costDocuments", "changeOrders",
  "checklists", "checklistItems", "turnoverItems", "punchItems",
];

/** Regulated rows present, or null when any of those counts is unknown. Pure. */
export function regulatedRecordTotal(c: ProjectRecordCounts): number | null {
  let n = 0;
  for (const k of REGULATED_RECORD_KEYS) {
    const v = c[k];
    if (v === null) return null;
    n += v;
  }
  return n;
}

/** The confirm's lines: every non-zero count, and every unknown one. Pure. */
export function describeProjectRecords(c: ProjectRecordCounts): string[] {
  const out: string[] = [];
  for (const [k, one, many] of RECORD_COUNT_LABELS) {
    const v = c[k];
    if (v === null) out.push(`${many}: could not be counted`);
    else if (v > 0) out.push(`${v} ${v === 1 ? one : many}`);
  }
  return out;
}

/** Live counts for the delete confirmation (PM-6 dw1). Each count is a
 *  head-only read; a refused or missing table reads as null (unknown). */
export async function countProjectRecords(projectId: string): Promise<ProjectRecordCounts> {
  const count = async (table: string, build?: (q: ReturnType<typeof headQuery>) => ReturnType<typeof headQuery>): Promise<number | null> => {
    const q = build ? build(headQuery(table)) : headQuery(table).eq("project_id", projectId);
    const { count: n, error } = await q;
    return error ? null : (n ?? 0);
  };
  const [costAccounts, costEntries, costDocuments, changeOrders, parties, checklists, checklistIds, turnoverItems, punchItems, documentLinks, milestones] = await Promise.all([
    count("cost_accounts"), count("cost_entries"), count("cost_documents"), count("change_orders"),
    count("project_parties"), count("project_checklists"),
    supabase.from("project_checklists").select("id").eq("project_id", projectId),
    count("turnover_items"), count("punch_items"), count("project_documents"), count("milestones"),
  ]);
  let checklistItems: number | null = null;
  if (!checklistIds.error) {
    const ids = ((checklistIds.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    checklistItems = ids.length === 0 ? 0 : await count("checklist_items", (q) => q.in("checklist_id", ids));
  }
  return { costAccounts, costEntries, costDocuments, changeOrders, parties, checklists, checklistItems, turnoverItems, punchItems, documentLinks, milestones };
}

function headQuery(table: string) {
  return supabase.from(table).select("id", { count: "exact", head: true });
}

/**
 * Delete a project (PM-6 / QUAL-3 / SEC-9). One transaction in the
 * database — delete_project_record (20261103) — which:
 *  · refuses a project under legal hold;
 *  · refuses a project carrying any cost or quality record unless the
 *    caller is a controller AND gives a reason (the default is Archive);
 *  · revokes the project's contractor intake links (PM-2's inline limb —
 *    PC-1 / J1 exports the shared intake-link revoke helper);
 *  · writes PROJECT_DELETED (org-readable) with the counts and how many
 *    stored files the delete orphans, and PURGE_PROJECT_SNAPSHOT — a
 *    serialized snapshot of the cost and quality rows plus the orphaned
 *    storage keys (they carry original file names) for the orphan sweep,
 *    readable by the org's audit viewers only (a PURGE_ action is inside the
 *    audit_logs_admin_trail overlay);
 *  · then deletes the schedule and the project (the rest cascades; the
 *    purge GUC app.record_purge = 'project:<id>' is the one pass through the
 *    money and quality delete guards).
 * Nothing is deleted before that transaction starts, so a refusal can no
 * longer leave a live project stripped of its roster, feed and schedule.
 * Without the migration the delete is refused (fail closed) — Archive.
 */
export async function deleteProject(input: {
  projectId: string; actorUserId: string; actorEmail?: string; actorRole?: string;
  /** Required by the database when the project carries cost / quality records. */
  reason?: string;
}): Promise<{ counts: Record<string, unknown> | null }> {
  const p = await assertCanManageProject(input.projectId, input.actorUserId);
  const { data, error } = await supabase.rpc("delete_project_record", {
    p_project: input.projectId,
    p_reason: input.reason?.trim() || null,
  });
  if (error) {
    if (isMissingRpc(error)) return legacyDeleteRecordlessProject(p, input);
    throw new Error(error.message);
  }
  const counts = (data && typeof data === "object" ? (data as { counts?: Record<string, unknown> }).counts : null) ?? null;
  return { counts };
}

/** Before 20261103: only a project with NO cost or quality record may be
 *  deleted (every count read, all zero) — anything else is refused and
 *  archived instead (fail closed). The projects row is deleted FIRST (its
 *  roster, feed and links cascade) and must come back from the DELETE,
 *  then the schedule rows it named, so a refused or filtered delete strips
 *  nothing and audits nothing. Audited with the counts. */
async function legacyDeleteRecordlessProject(
  p: ManagedProject,
  input: { projectId: string; actorUserId: string; actorEmail?: string; actorRole?: string },
): Promise<{ counts: Record<string, unknown> | null }> {
  const counts = await countProjectRecords(input.projectId);
  const regulated = regulatedRecordTotal(counts);
  if (regulated === null || regulated > 0) {
    throw new Error("This project carries cost or quality records (or they could not be counted). It cannot be deleted until database migration 20261103 (delete_project_record) is applied — archive it instead.");
  }
  const { data: ms, error: msErr } = await supabase.from("milestones").select("id").eq("project_id", input.projectId);
  if (msErr) throw new Error(`The project's schedule could not be read, so nothing was deleted: ${msErr.message}`);
  const milestoneIds = ((ms ?? []) as Array<{ id: string }>).map((r) => r.id);
  const revokedLinks = await revokeProjectIntakeLinks(input.projectId, new Date().toISOString());
  // RETURNING: a DELETE the policy filters out matches zero rows with no
  // error — the project is still there, so its schedule is NOT deleted and
  // PROJECT_DELETED is NOT written.
  const { data: gone, error } = await supabase.from("projects").delete().eq("id", input.projectId).select("id");
  if (error) throw new Error(error.message);
  if (((gone ?? []) as unknown[]).length === 0) {
    throw new Error(`Nothing was deleted: the database did not remove the project (you may no longer be allowed to delete it).${revokedLinks > 0 ? ` Its ${revokedLinks} contractor intake link(s) were revoked first — mint new ones if the project stays in use.` : ""}`);
  }
  // milestones.project_id is ON DELETE SET NULL — the schedule goes with the project.
  let scheduleError: string | null = null;
  if (milestoneIds.length > 0) {
    const { error: mdErr } = await supabase.from("milestones").delete().in("id", milestoneIds);
    if (mdErr) scheduleError = mdErr.message;
  }
  await logAuditAction({
    action: "PROJECT_DELETED", resourceId: input.projectId, resourceType: "project",
    orgId: p.orgId, userId: input.actorUserId, userEmail: input.actorEmail, userRole: input.actorRole,
    details: { name: p.name, counts, path: "pre-20261103", ...(scheduleError ? { scheduleError } : {}) },
  });
  if (scheduleError) throw new Error(`The project was deleted, but its ${milestoneIds.length} schedule task(s) were not: ${scheduleError}`);
  return { counts: counts as unknown as Record<string, unknown> };
}

/** Transfer project ownership to another user (who is made an 'owner' member).
 *  Current owner or org controller only; the recipient must be an ACTIVE
 *  member of the project's org. SEC-15: the transfer_project_ownership RPC
 *  (20261102) is the path — projects_update_owner's WITH CHECK cannot admit
 *  the post-transfer row for a plain owner, so the direct UPDATE failed with
 *  a raw RLS error for exactly the person offered the button. Audited (in
 *  the RPC) + notifies the new owner. */
export async function transferOwnership(input: {
  projectId: string; newOwnerUserId: string; newOwnerName?: string; newOwnerEmail?: string;
  actorUserId: string; actorEmail?: string; actorRole?: string;
}): Promise<void> {
  const p = await assertCanManageProject(input.projectId, input.actorUserId);
  const { error } = await supabase.rpc("transfer_project_ownership", {
    p_project: input.projectId,
    p_new_owner: input.newOwnerUserId,
    p_new_owner_name: input.newOwnerName || input.newOwnerEmail || null,
  });
  if (error) {
    if (!isMissingRpc(error)) throw new Error(error.message);
    await legacyTransferOwnership(p, input);
  }
  void notify({
    orgId: p.orgId, userId: input.newOwnerUserId, actorUserId: input.actorUserId, actorName: input.actorEmail,
    kind: "project_member", title: "You're now the project owner",
    body: `${input.actorEmail || "Someone"} transferred ownership of "${p.name}" to you.`,
    link: `/projects/${input.projectId}`, resourceType: "project", resourceId: input.projectId,
  });
}

/** Before 20261102: the direct writes. They succeed for a controller; a
 *  plain owner is refused by projects_update_owner's WITH CHECK, and is told
 *  so in words rather than with the raw RLS text. The recipient must be an
 *  active member either way. */
async function legacyTransferOwnership(
  p: ManagedProject,
  input: { projectId: string; newOwnerUserId: string; newOwnerName?: string; newOwnerEmail?: string; actorUserId: string; actorEmail?: string; actorRole?: string },
): Promise<void> {
  const { data: target, error: tErr } = await supabase.from("org_members").select("uid")
    .eq("org_id", p.orgId).eq("uid", input.newOwnerUserId).eq("status", "active").maybeSingle();
  if (tErr) throw new Error(`The new owner's membership could not be checked: ${tErr.message}`);
  if (!target) throw new Error("The new owner must be an active member of this workspace.");
  const now = new Date().toISOString();
  const { data: moved, error } = await supabase.from("projects").update({
    owner_user_id: input.newOwnerUserId,
    owner_user_name: input.newOwnerName || null,
    updated_at: now, updated_by: input.actorUserId,
  }).eq("id", input.projectId).select("id");
  if (error || !moved || (moved as unknown[]).length === 0) {
    throw new Error("Only an Admin / Document Control can transfer ownership until database migration 20261102 (transfer_project_ownership) is applied.");
  }
  // Make the new owner an 'owner' member; demote the prior owner to collaborator.
  const { error: upErr } = await supabase.from("project_members").upsert({
    project_id: input.projectId, user_id: input.newOwnerUserId,
    user_name: input.newOwnerName || null, user_email: input.newOwnerEmail || null, role: "owner",
  }, { onConflict: "project_id,user_id" });
  if (upErr) throw new Error(`Ownership moved, but the roster was not updated: ${upErr.message}`);
  if (String(p.ownerUserId) !== String(input.newOwnerUserId)) {
    const { error: dErr } = await supabase.from("project_members").update({ role: "collaborator" })
      .eq("project_id", input.projectId).eq("user_id", p.ownerUserId).eq("role", "owner");
    if (dErr) throw new Error(`Ownership moved, but the previous owner's roster row was not updated: ${dErr.message}`);
  }
  const activityError = await writeActivity({
    projectId: input.projectId, orgId: p.orgId, userId: input.actorUserId, userName: input.actorEmail,
    type: "ownership_transferred",
    body: `Ownership transferred to ${input.newOwnerName || input.newOwnerEmail || input.newOwnerUserId}`,
  });
  await logAuditAction({
    action: "PROJECT_OWNERSHIP_TRANSFERRED", resourceId: input.projectId, resourceType: "project",
    orgId: p.orgId, userId: input.actorUserId, userEmail: input.actorEmail, userRole: input.actorRole,
    details: { from: p.ownerUserId, to: input.newOwnerUserId, ...(activityError ? { activityError } : {}) },
  });
  if (activityError) throw savedButNotRecorded("Ownership was transferred", activityError);
}

/** Update a member's role and/or responsibility. Owner or org controller
 *  only. PM-11: 'owner' is never set here — ownership moves only through
 *  transferOwnership, which also moves projects.owner_user_id (the one
 *  value authority reads). */
export async function updateMember(input: {
  projectId: string; userId: string;
  role?: ProjectMemberRole; responsibility?: string | null;
  actorUserId: string;
}): Promise<void> {
  if (input.role === "owner") {
    throw new Error("Ownership moves only through Transfer ownership — a member cannot be given the owner role here.");
  }
  await assertCanManageProject(input.projectId, input.actorUserId);
  const patch: Record<string, unknown> = {};
  if (input.role !== undefined) patch.role = input.role;
  if (input.responsibility !== undefined) patch.responsibility = input.responsibility?.trim() || null;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from("project_members").update(patch)
    .eq("project_id", input.projectId).eq("user_id", input.userId);
  if (error) throw new Error(error.message);
}

// ─── AUDIENCE FAN-OUT ────────────────────────────────────────────────────
// Members ∪ watchers, minus the actor. This is what makes the Watch button
// real: following a project previously produced zero notifications ever.

async function notifyProjectAudience(input: {
  projectId: string; orgId: string; actorUserId: string; actorName?: string;
  kind: Parameters<typeof notifyMany>[0]["kind"];
  title: string; body?: string;
}): Promise<void> {
  try {
    const [{ data: mem }, watchers] = await Promise.all([
      supabase.from("project_members").select("user_id").eq("project_id", input.projectId),
      listFollowerIds("project", input.projectId),
    ]);
    const ids = [...new Set([
      ...(((mem ?? []) as Array<{ user_id: string }>).map((m) => m.user_id)),
      ...watchers,
    ])].filter((id) => id && id !== input.actorUserId);
    if (!ids.length) return;
    const { emit } = await import("@/lib/notify/dispatch");
    await emit({
      orgId: input.orgId,
      category: "status",
      kind: input.kind,
      title: input.title,
      body: input.body,
      link: `/projects/${input.projectId}`,
      resource: { type: "project", id: input.projectId },
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      audience: { involved: ids },
    });
  } catch { /* fan-out is best-effort — never blocks the mutation */ }
}

// ─── EDIT PROJECT ────────────────────────────────────────────────────────
// The audit found projects were immutable after creation — a typo in the
// name was permanent. Owner/controller only; before/after audited.

export async function updateProjectMeta(input: {
  projectId: string;
  patch: {
    name?: string; description?: string | null; mocReference?: string | null;
    targetCompletionDate?: string | null; visibility?: ProjectVisibility;
  };
  actorUserId: string; actorEmail?: string; actorRole?: string;
}): Promise<void> {
  const proj = await assertCanManageProject(input.projectId, input.actorUserId);
  const { data: beforeRow } = await supabase.from("projects")
    .select("name, description, moc_reference, target_completion_date, visibility")
    .eq("id", input.projectId).maybeSingle();
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: input.actorUserId,
  };
  if (input.patch.name !== undefined) {
    const name = input.patch.name.trim();
    if (!name) throw new Error("Project name can't be empty.");
    update.name = name;
  }
  if (input.patch.description !== undefined) update.description = input.patch.description?.trim() || null;
  if (input.patch.mocReference !== undefined) update.moc_reference = input.patch.mocReference?.trim() || null;
  if (input.patch.targetCompletionDate !== undefined) update.target_completion_date = input.patch.targetCompletionDate || null;
  if (input.patch.visibility !== undefined) update.visibility = input.patch.visibility;
  const { error } = await supabase.from("projects").update(update).eq("id", input.projectId);
  if (error) throw new Error(error.message);

  const activityError = await writeActivity({
    projectId: input.projectId, orgId: proj.orgId,
    userId: input.actorUserId, userName: input.actorEmail,
    type: "comment",
    body: `Project details updated${input.patch.name && input.patch.name !== (beforeRow?.name as string) ? ` — renamed to "${input.patch.name.trim()}"` : ""}`,
    metadata: { edited: Object.keys(input.patch) },
  });
  await logAuditAction({
    action: "PROJECT_UPDATED",
    resourceId: input.projectId, resourceType: "project",
    orgId: proj.orgId, userId: input.actorUserId,
    userEmail: input.actorEmail, userRole: input.actorRole,
    details: { before: beforeRow ?? null, after: input.patch, ...(activityError ? { activityError } : {}) },
  });
  if (activityError) throw savedButNotRecorded("The project details", activityError);
}

// ─── STALE-CHECKOUT WARNINGS ─────────────────────────────────────────────
// Client-side check: returns checkouts that have passed their expected
// release date OR (for ad-hoc) their hard 24h cap. The UI uses this to
// nag the owner and, for ad-hoc, automatically end them on next load.

export async function listStaleCheckoutsForUser(userId: string): Promise<CheckoutSession[]> {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("checkout_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .or(`expected_release_at.lt.${nowIso},auto_expires_at.lt.${nowIso}`);
  return (data ?? []).map(rowToCheckoutSession);
}

// ─── TICKET ↔ PROJECT INTEGRATION ────────────────────────────────────────
// Converts a ticket from the request portal into a project. The project
// inherits the ticket title + description, links back to the ticket so the
// ticket page can show the linked project, and writes audit + activity rows
// on both sides.

export async function convertTicketToProject(input: {
  ticketId: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}): Promise<Project> {
  // Fetch the ticket so we can copy title/description/moc onto the project
  const { data: ticket, error: tErr } = await supabase
    .from("tickets")
    .select("id, title, description, request_type, requester_id, requester_name")
    .eq("id", input.ticketId)
    .single();
  if (tErr || !ticket) throw new Error(tErr?.message || "Ticket not found");

  // Description is required by createProject. If the ticket has none, fall
  // back to the title so the project is still meaningfully described and
  // the user can edit it on the project page after conversion.
  const ticketTitle = (ticket.title as string) ?? "Converted ticket";
  const ticketDescription = ((ticket.description as string | undefined) || "").trim()
    || `Converted from ticket ${ticket.id}. Originally: ${ticketTitle}`;

  const project = await createProject({
    orgId: input.orgId,
    name: ticketTitle,
    description: ticketDescription,
    linkedTicketId: ticket.id as string,
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
  });

  // Optional: also add the original requester as a member so they show up.
  if (ticket.requester_id && ticket.requester_id !== input.actorUserId) {
    await addMember({
      projectId: project.id!,
      orgId: input.orgId,
      userId: ticket.requester_id as string,
      userName: (ticket.requester_name as string | undefined) ?? undefined,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
    });
  }

  // Append a history entry on the ticket so the ticket page reflects the link.
  try {
    const { data: existing } = await supabase
      .from("tickets")
      .select("history")
      .eq("id", input.ticketId)
      .single();
    const history = Array.isArray(existing?.history) ? existing.history : [];
    history.push({
      action: "Converted to Project",
      user: input.actorEmail || input.actorUserId,
      date: new Date().toISOString(),
      details: `Project ${project.id} (${project.name})`,
    });
    await supabase.from("tickets").update({ history }).eq("id", input.ticketId);
  } catch (e) {
    console.error("Failed to update ticket history", e);
  }

  return project;
}

// ─── BULK CHECKOUT ───────────────────────────────────────────────────────
// Atomically check out N documents under a single project. Used by the
// library bulk-action bar (multi-select) AND the MultiDocViewer "Checkout
// all to project" button. Always tied to a project — bulk checkouts are
// real work, not ad-hoc reviews.

export type BulkCheckoutInput = {
  orgId: string;
  docs: Array<{
    id: string;
    libraryId: string;
    documentNumber?: string | null;
    title?: string | null;
    activeCollaborators?: string[];
    checkedOutBy?: string | null;
    currentLockId?: string | null;
  }>;
  mode?: "view" | "markup" | "edit";
  purpose?: string;
  expectedReleaseAt?: string;
  // Project linkage is OPTIONAL. Three valid shapes:
  //   { existingProjectId }     → attach to an existing project
  //   { newProject }            → create a project, then attach
  //   neither                   → ad-hoc bulk (no project), 24h auto-expiry
  existingProjectId?: string;
  newProject?: { name: string; description: string; visibility?: ProjectVisibility; mocReference?: string; targetCompletionDate?: string };
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
};

export type BulkCheckoutResult = {
  /** Null when this was an ad-hoc bulk checkout (no project). */
  projectId: string | null;
  projectName: string | null;
  checkedOutCount: number;
  skipped: Array<{ docId: string; reason: string }>;
  /** PM-9: the checkouts landed but the project's summary feed row was refused. */
  activityError?: string | null;
};

export async function bulkCheckoutToProject(input: BulkCheckoutInput): Promise<BulkCheckoutResult> {
  if (input.docs.length === 0) throw new Error("At least one document is required");

  // 1. Resolve the project — create, use existing, or skip entirely
  //    (ad-hoc bulk).
  let project: Project | null = null;
  if (input.newProject) {
    project = await createProject({
      orgId: input.orgId,
      name: input.newProject.name,
      description: input.newProject.description,
      visibility: input.newProject.visibility,
      mocReference: input.newProject.mocReference,
      targetCompletionDate: input.newProject.targetCompletionDate,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
    });
  } else if (input.existingProjectId) {
    const existing = await getProject(input.existingProjectId);
    if (!existing) throw new Error("Project not found");
    project = existing;
  }
  // else: ad-hoc bulk — no project linkage, 24h auto-expiry.

  // 2. Insert one checkout_session per doc. Skip docs already locked by
  //    someone else — surface them in `skipped` so the UI can warn.
  const now = new Date().toISOString();
  const userName = input.actorEmail?.split("@")[0] || input.actorUserId;
  const mode = input.mode || "edit";
  // Ad-hoc bulk gets the same 24h cap as single-doc ad-hoc checkouts so
  // forgotten locks don't linger forever.
  const autoExpiresAt = project ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const skipped: Array<{ docId: string; reason: string }> = [];
  let checkedOutCount = 0;

  for (const doc of input.docs) {
    if (doc.checkedOutBy && doc.checkedOutBy !== input.actorUserId) {
      skipped.push({ docId: doc.id, reason: `Already checked out by another user` });
      continue;
    }

    // Each document gets its own checkout episode ("ticket"); the episode id
    // doubles as the lock id. Null on pre-migration envs → legacy lock id.
    let episodeId: string | null = null;
    try {
      const ensured = await ensureActiveEpisode({
        orgId: input.orgId,
        documentId: doc.id,
        libraryId: doc.libraryId,
        userId: input.actorUserId,
        userName,
      });
      episodeId = ensured?.episode.id ?? null;
    } catch (e) {
      console.warn("[bulkCheckout] episode ensure failed (continuing legacy)", e);
    }
    const lockId = episodeId ?? crypto.randomUUID();

    const sessionRow: Record<string, unknown> = {
      org_id: input.orgId,
      document_id: doc.id,
      library_id: doc.libraryId,
      user_id: input.actorUserId,
      user_name: userName,
      mode,
      note: input.purpose || null,
      status: "active",
      lock_id: lockId,
      project_id: project?.id ?? null,
      purpose: input.purpose || null,
      expected_release_at: input.expectedReleaseAt || null,
      // Project checkouts never auto-expire; ad-hoc bulk gets a 24h cap.
      auto_expires_at: autoExpiresAt,
      started_at: now,
      last_seen_at: now,
    };
    if (episodeId) sessionRow.episode_id = episodeId;
    const { error: insertErr } = await supabase.from("checkout_sessions").insert(sessionRow);

    if (insertErr) {
      skipped.push({ docId: doc.id, reason: insertErr.message });
      continue;
    }

    // Update the documents pointer (best-effort)
    const newCollaborators = Array.from(new Set([...(doc.activeCollaborators ?? []), userName]));
    await supabase.from("documents").update({
      checked_out_by: input.actorUserId,
      checked_out_by_name: userName,
      checked_out_at: now,
      checkout_note: input.purpose || null,
      current_lock_id: lockId,
      active_collaborators: newCollaborators,
    }).eq("id", doc.id);

    // Open the episode's visible record in the thread.
    await postEpisodeSystemMessage({
      orgId: input.orgId,
      documentId: doc.id,
      episodeId,
      text: `${userName} checked out (${mode})${input.purpose ? ` — ${input.purpose}` : ""}${project ? ` · Project: ${project.name}` : ""}.`,
    });

    checkedOutCount += 1;
  }

  // 3. Single activity entry summarising the batch (cleaner than N rows).
  //    Only fires for project checkouts — ad-hoc bulk lives in each
  //    document's own activity thread.
  let activityError: string | null = null;
  if (project) {
    activityError = await writeActivity({
      projectId: project.id!,
      orgId: input.orgId,
      userId: input.actorUserId,
      userName: input.actorEmail,
      type: "checkout_added",
      body: `Checked out ${checkedOutCount} document${checkedOutCount === 1 ? "" : "s"} (${mode})`,
      metadata: {
        mode,
        purpose: input.purpose,
        docs: input.docs.map((d) => ({ id: d.id, documentNumber: d.documentNumber, title: d.title })),
        skipped,
      },
    });
  }

  return {
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    checkedOutCount,
    skipped,
    activityError,
  };
}

/** A session row the sweep ended — the shape the UPDATE's RETURNING gives
 *  back, which is the ONLY thing notifications and audit rows are built from. */
interface SweptSession {
  id: string; document_id: string; org_id: string; user_id: string; library_id: string | null;
}

/** PM-4 dw4: the window after a project closes before its stranded
 *  checkouts are swept — the same 24h as the ad-hoc cap. */
export const CLOSED_PROJECT_SWEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Auto-release ad-hoc checkouts whose cap has passed. Idempotent.
 *
 * PM-4 dw4: also releases a PROJECT checkout still active on a project that
 * closed (completed / cancelled / archived) more than CLOSED_PROJECT_SWEEP_MS
 * ago — the sessions the closer could not release (the release guard) no
 * longer stay locked to a closed project forever. Same register outcome
 * (`auto_released`), same CHECK_IN rows, its own reason and notice.
 *
 * Two call modes:
 *  - Client (default): pass an `orgId` AND `{ userId }`; uses the RLS-scoped
 *    browser client and — DCK-7 — sweeps ONLY the caller's own expired
 *    sessions. The release guard refuses a status change on anyone else's
 *    session unless the caller holds checkout.force_release, and a BEFORE
 *    trigger RAISE aborts the whole batch statement, so a page-load sweep
 *    over other people's rows released nobody (including the caller) while
 *    telling everyone "your checkout auto-released" on every visit. Without
 *    a userId the browser sweep does nothing.
 *  - Cron/server: pass `{ client }` (a service-role client) and OMIT orgId
 *    to sweep every org in one pass. This is the authoritative enforcer —
 *    the page-load path is just a nicety. See /api/cron/maintenance.
 *
 * Notifications and the CHECK_IN audit rows (DCK-9) are driven by the rows
 * the UPDATE actually changed, never by the pre-update selection. A sweep
 * write that fails for any reason other than the missing outcome schema
 * THROWS — the caller surfaces it (the /checkouts error strip, the library
 * page banner, the cron's `errors` list).
 */
export async function autoReleaseExpiredAdHoc(
  orgId?: string | null,
  opts?: { client?: SupabaseLike; userId?: string | null },
): Promise<number> {
  const db = (opts?.client ?? supabase) as SupabaseLike;
  const browserMode = !opts?.client;
  if (browserMode && !opts?.userId) return 0;
  const nowIso = new Date().toISOString();

  let query = db
    .from("checkout_sessions")
    .select("id")
    .eq("status", "active")
    .is("project_id", null)
    .lt("auto_expires_at", nowIso);
  if (orgId) query = query.eq("org_id", orgId);
  if (browserMode) query = query.eq("user_id", opts!.userId as string);

  const { data, error: listErr } = await query;
  if (listErr) throw new Error(`Expired checkouts could not be read: ${listErr.message}`);

  let released = 0;
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length > 0) {
    released += await sweepSessions(db, ids, {
      browserMode, nowIso,
      reason: "Auto-released after 24h ad-hoc cap",
      title: "Your ad-hoc checkout auto-released",
      body: "The time window you picked ran out, so the checkout closed on its own. If you're still working on this document, check it out again — otherwise nothing to do.",
    });
  }

  // PM-4 dw4: project checkouts stranded on a closed project.
  const strandedIds = await strandedClosedProjectSessions(db, { orgId: orgId ?? null, userId: browserMode ? (opts!.userId as string) : null, nowMs: Date.parse(nowIso) });
  if (strandedIds.length > 0) {
    released += await sweepSessions(db, strandedIds, {
      browserMode, nowIso,
      reason: "Auto-released: the project was closed",
      title: "Your project checkout was released",
      body: "The project this checkout belonged to was closed, so the checkout ended on its own. If the work continues, check the document out again.",
    });
  }
  return released;
}

/** Project ids per `.in()` read in the stranded sweep — keeps the request
 *  line bounded however many projects carry active checkouts. */
const SWEEP_PROJECT_CHUNK = 100;
/** PostgREST's max-rows: the sweep's and the register's reads page in
 *  windows of this size until a short page, never taking a capped read as
 *  the whole set. */
const PAGE_ROWS = 1000;

type RowPage = (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
async function readAllPages(label: string, page: RowPage): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    rows.push(...batch);
    if (batch.length < PAGE_ROWS) return rows;
  }
}

/** When a closed project closed: its FIRST closure stamp (completed_at /
 *  cancelled_at — an archive after a completion does not restart the
 *  clock); for a project archived with neither stamp, the newest closing
 *  status_changed feed row; failing both, updated_at — which is never
 *  EARLIER than the closure, so the sweep may wait longer, never release
 *  early. updated_at alone moved on every later edit (a transfer, a
 *  description change) and restarted the window. */
function closedAtMs(p: { completed_at?: string | null; cancelled_at?: string | null; updated_at?: string | null }, feedClosedAt: string | undefined): number | null {
  const stamps = [p.completed_at, p.cancelled_at].filter((v): v is string => !!v).map((v) => Date.parse(v)).filter(Number.isFinite);
  if (stamps.length > 0) return Math.min(...stamps);
  const fallback = feedClosedAt ?? p.updated_at ?? null;
  const ms = fallback ? Date.parse(fallback) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** PM-4 dw4: active checkouts tied to a project that has been closed for
 *  longer than CLOSED_PROJECT_SWEEP_MS. Bounded reads: the active
 *  project-tied sessions (scoped like the ad-hoc selection, paged), then
 *  the status and closure stamps of the projects they name (chunked), and
 *  for an archived project without a stamp, its closing feed row. */
async function strandedClosedProjectSessions(
  db: SupabaseLike,
  scope: { orgId: string | null; userId: string | null; nowMs: number },
): Promise<string[]> {
  const sessions = await readAllPages("Project checkouts could not be read", (from, to) => {
    let q = db
      .from("checkout_sessions")
      .select("id, project_id")
      .eq("status", "active")
      .not("project_id", "is", null);
    if (scope.orgId) q = q.eq("org_id", scope.orgId);
    if (scope.userId) q = q.eq("user_id", scope.userId);
    return q.order("id").range(from, to);
  });
  const rows = (sessions as Array<{ id: string; project_id: string | null }>).filter((r) => !!r.project_id);
  if (rows.length === 0) return [];
  const projectIds = Array.from(new Set(rows.map((r) => r.project_id as string)));

  type ClosedRow = { id: string; status: ProjectStatus; completed_at: string | null; cancelled_at: string | null; updated_at: string | null };
  const projects: ClosedRow[] = [];
  for (let i = 0; i < projectIds.length; i += SWEEP_PROJECT_CHUNK) {
    const part = projectIds.slice(i, i + SWEEP_PROJECT_CHUNK);
    projects.push(...(await readAllPages("Project status could not be read for the checkout sweep", (from, to) => db
      .from("projects")
      .select("id, status, completed_at, cancelled_at, updated_at")
      .in("id", part)
      .order("id").range(from, to))) as ClosedRow[]);
  }
  const closedProjects = projects.filter((p) => CLOSED_PROJECT_STATUSES.has(p.status));

  // An archived project carries neither stamp: its closing feed row says when.
  const unstamped = closedProjects.filter((p) => !p.completed_at && !p.cancelled_at).map((p) => p.id);
  const feedClosedAt = new Map<string, string>();
  for (let i = 0; i < unstamped.length; i += SWEEP_PROJECT_CHUNK) {
    const part = unstamped.slice(i, i + SWEEP_PROJECT_CHUNK);
    const feed = await readAllPages("Project closure times could not be read for the checkout sweep", (from, to) => db
      .from("project_activity")
      .select("id, project_id, created_at, metadata")
      .in("project_id", part)
      .eq("type", "status_changed")
      .order("id").range(from, to));
    for (const f of feed as Array<{ project_id: string; created_at: string | null; metadata: { toStatus?: string } | null }>) {
      if (!f.created_at || !CLOSED_PROJECT_STATUSES.has(f.metadata?.toStatus as ProjectStatus)) continue;
      const prev = feedClosedAt.get(f.project_id);
      if (!prev || Date.parse(f.created_at) > Date.parse(prev)) feedClosedAt.set(f.project_id, f.created_at);
    }
  }

  const cutoff = scope.nowMs - CLOSED_PROJECT_SWEEP_MS;
  const closed = new Set(closedProjects
    .filter((p) => { const at = closedAtMs(p, feedClosedAt.get(p.id)); return at !== null && at < cutoff; })
    .map((p) => p.id));
  return rows.filter((r) => closed.has(r.project_id as string)).map((r) => r.id);
}

/** The sweep's write, settle, CHECK_IN rows and holder notices — one pass
 *  over the given session ids, everything built from the rows the UPDATE
 *  returned. Returns the number of sessions actually released. */
async function sweepSessions(
  db: SupabaseLike,
  ids: string[],
  o: { browserMode: boolean; nowIso: string; reason: string; title: string; body: string },
): Promise<number> {
  // In batches of IN_FILTER_CHUNK ids: a longer `.in("id", …)` list can
  // exceed the API gateway's URL limit.
  if (ids.length > IN_FILTER_CHUNK) {
    let released = 0;
    for (let i = 0; i < ids.length; i += IN_FILTER_CHUNK) released += await sweepSessions(db, ids.slice(i, i + IN_FILTER_CHUNK), o);
    return released;
  }
  const { browserMode, nowIso } = o;
  // The register outcome for a sweep is 'auto_released' — the one outcome no
  // human ever chooses. Pre-migration (no outcome columns) the write retries
  // without them, same tolerance as finishMySession.
  const basePayload = {
    status: "checked_in",
    ended_at: nowIso,
    released_at: nowIso,
    released_reason: o.reason,
  };
  const RETURNING = "id, document_id, org_id, user_id, library_id";
  const sweep = db
    .from("checkout_sessions")
    .update({ ...basePayload, outcome: "auto_released" })
    .in("id", ids)
    .eq("status", "active")
    // LIFE-14: a session that already carries a human verdict keeps it —
    // the sweep must never overwrite evidence with 'auto_released'.
    .is("outcome", null);
  // DCK-7: RETURNING — the rows the UPDATE actually changed drive everything below.
  let { data: swept, error: sweepErr } = await sweep.select(RETURNING);
  if (sweepErr) {
    const { isMissingOutcomeSchema } = await import("@/lib/checkoutEpisodes");
    if (isMissingOutcomeSchema(sweepErr)) {
      ({ data: swept, error: sweepErr } = await db
        .from("checkout_sessions").update(basePayload).in("id", ids).eq("status", "active").select(RETURNING));
    }
  }
  if (sweepErr) throw new Error(`Expired checkouts were NOT released: ${sweepErr.message}`);
  const released = ((swept ?? []) as SweptSession[]);
  if (released.length === 0) return 0;

  const docIds = Array.from(new Set(released.map((r) => r.document_id)));
  const orgByDoc = new Map(released.map((r) => [r.document_id, r.org_id]));

  // Settle each affected document from its remaining active sessions —
  // blanket-clearing freed docs that non-expired sessions still held, and
  // never closed the episode record.
  for (const docId of docIds) {
    try {
      await reconcileDocumentCheckoutState(docId, {
        client: db,
        orgId: orgByDoc.get(docId),
        actorUserId: "system",
        actorName: "System",
        closeReason: "expired",
      });
    } catch (e) {
      console.warn("[autoReleaseExpiredAdHoc] reconcile failed for", docId, e);
    }
  }

  // DCK-9: an auto-release is a check-in the document's history must show,
  // not only a notification. Under the RLS client the row is the caller's
  // own (user_id = auth.uid(), as the audit_logs INSERT policy requires);
  // under the cron it is the system's (no user), naming the holder in details.
  try {
    const audits = released.map((r) => ({
      action: "CHECK_IN",
      resource_id: r.document_id,
      resource_type: "document",
      org_id: r.org_id,
      user_id: browserMode ? r.user_id : null,
      user_email: browserMode ? null : "system",
      user_role: null,
      details: {
        outcome: "auto_released",
        via: browserMode ? "page_sweep" : "cron",
        sessionId: r.id,
        releasedUserId: r.user_id,
        reason: basePayload.released_reason,
      },
      metadata: null,
    }));
    const { error: auditErr } = await db.from("audit_logs").insert(audits);
    if (auditErr) console.warn("[autoReleaseExpiredAdHoc] CHECK_IN audit rows not written (non-blocking)", auditErr.message);
  } catch (e) {
    console.warn("[autoReleaseExpiredAdHoc] CHECK_IN audit rows not written (non-blocking)", e);
  }

  // Personal interrupt: tell each former holder their checkout evaporated —
  // built from the rows the UPDATE actually changed. Direct notification-row
  // inserts (works under both the RLS client and the cron's service-role
  // client); never fails the sweep.
  try {
    const inserts = released.map((r) => ({
      org_id: r.org_id,
      user_id: r.user_id,
      kind: "checkout_released",
      title: o.title,
      body: o.body,
      link: r.library_id ? `/documents/${r.library_id}?doc=${r.document_id}` : "/checkouts",
      resource_type: "document",
      resource_id: r.document_id,
      actor_name: "System",
      metadata: { autoReleasedSessionId: r.id },
    }));
    if (inserts.length > 0) await db.from("notifications").insert(inserts);
  } catch (e) {
    console.warn("[autoReleaseExpiredAdHoc] holder notify failed (non-blocking)", e);
  }

  return released.length;
}
