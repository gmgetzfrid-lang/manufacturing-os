// lib/projects.ts
// CRUD + activity helpers for the Projects collaboration layer.
//
// A project owns one or more checkouts. Anyone in the org can list and view
// public projects; private projects are visible only to their members (admins
// always see everything for audit purposes).

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import { notify } from "@/lib/inAppNotifications";
import {
  ensureActiveEpisode,
  postEpisodeSystemMessage,
  reconcileDocumentCheckoutState,
} from "@/lib/checkoutEpisodes";
import type {
  Project, ProjectMember, ProjectActivity, ProjectActivityType,
  ProjectStatus, ProjectVisibility, ProjectMemberRole,
  CheckoutSession, Timestamp,
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

  await writeActivity({
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
    details: { name: input.name, visibility: input.visibility || "public" },
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

export async function writeActivity(input: WriteActivityInput): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("project_activity").insert({
    project_id: input.projectId,
    org_id: input.orgId,
    user_id: input.userId || null,
    user_name: input.userName || null,
    type: input.type,
    body: input.body || null,
    metadata: input.metadata || null,
    created_at: now,
  });
  // Touch last_activity_at so the list view sorts correctly.
  await supabase
    .from("projects")
    .update({ last_activity_at: now, updated_at: now })
    .eq("id", input.projectId);
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

export type StatusTransitionInput = {
  projectId: string;
  orgId: string;
  toStatus: ProjectStatus;
  reason?: string;            // required for cancel
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
};

export async function transitionProjectStatus(input: StatusTransitionInput): Promise<void> {
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

  const { error } = await supabase.from("projects").update(update).eq("id", input.projectId);
  if (error) throw new Error(error.message);

  await writeActivity({
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
    details: { reason: input.reason || null },
  });

  // Cancelling or archiving releases every active checkout on the project.
  if (input.toStatus === "cancelled" || input.toStatus === "archived" || input.toStatus === "completed") {
    await releaseAllCheckoutsForProject({
      projectId: input.projectId,
      reason: input.reason || `Project ${input.toStatus}`,
      actorUserId: input.actorUserId,
    });
  }
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

async function releaseAllCheckoutsForProject(params: {
  projectId: string;
  reason: string;
  actorUserId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { data: active } = await supabase
    .from("checkout_sessions")
    .select("id, document_id, org_id")
    .eq("project_id", params.projectId)
    .eq("status", "active");

  if (!active || active.length === 0) return;

  const ids = active.map((r) => r.id as string);
  const docIds = Array.from(new Set(active.map((r) => r.document_id as string)));
  const orgByDoc = new Map(active.map((r) => [r.document_id as string, r.org_id as string]));

  await supabase
    .from("checkout_sessions")
    .update({
      status: "checked_in",
      ended_at: now,
      released_at: now,
      released_by: params.actorUserId,
      released_reason: params.reason,
    })
    .in("id", ids);

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
  await writeActivity({
    projectId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userName: input.actorEmail,
    type: "comment",
    body: input.body.trim(),
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
  await writeActivity({
    projectId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userName: input.actorEmail,
    type: "checkout_added",
    body: "Checkout attached to project",
    metadata: { checkoutSessionId: input.checkoutSessionId },
  });
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
  const { error } = await supabase.from("project_members").upsert({
    project_id: input.projectId,
    user_id: input.userId,
    user_name: input.userName || null,
    user_email: input.userEmail || null,
    role: input.role || "collaborator",
    responsibility: input.responsibility?.trim() || null,
  }, { onConflict: "project_id,user_id" });
  if (error) throw new Error(error.message);
  await writeActivity({
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
  await writeActivity({
    projectId: input.projectId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userName: input.actorEmail,
    type: "member_left",
    body: `${input.userName || input.userEmail || input.userId} was removed from the project`,
  });
}

// ─── OWNERSHIP / DELETE / MEMBER MANAGEMENT ──────────────────────────────

/** Verify the actor may manage this project — its current owner, or an org
 *  Admin/DocCtrl. Returns the project's core fields. Throws otherwise. */
export async function assertCanManageProject(projectId: string, actorUserId: string): Promise<{ id: string; orgId: string; ownerUserId: string; name: string }> {
  const { data, error } = await supabase
    .from("projects").select("id, org_id, owner_user_id, name").eq("id", projectId).maybeSingle();
  if (error || !data) throw new Error("Project not found.");
  const p = data as { id: string; org_id: string; owner_user_id: string; name: string };
  if (String(p.owner_user_id) === String(actorUserId)) {
    return { id: p.id, orgId: p.org_id, ownerUserId: p.owner_user_id, name: p.name };
  }
  const { data: mem } = await supabase
    .from("org_members").select("role").eq("org_id", p.org_id).eq("uid", actorUserId).eq("status", "active").maybeSingle();
  const role = (mem as { role?: string } | null)?.role;
  if (role === "Admin" || role === "DocCtrl") {
    return { id: p.id, orgId: p.org_id, ownerUserId: p.owner_user_id, name: p.name };
  }
  throw new Error("Only the project owner or an admin can do this.");
}

/** Delete a project and its schedule. Owner or org Admin/DocCtrl only.
 *  Checkouts are detached (kept), not deleted. Audited. */
export async function deleteProject(input: {
  projectId: string; actorUserId: string; actorEmail?: string; actorRole?: string;
}): Promise<void> {
  const p = await assertCanManageProject(input.projectId, input.actorUserId);
  // Keep document checkouts; just unlink them from the deleted project.
  await supabase.from("checkout_sessions").update({ project_id: null }).eq("project_id", input.projectId);
  await supabase.from("markup_requests").update({ project_id: null }).eq("project_id", input.projectId);
  // milestones.project_id is ON DELETE SET NULL, so delete them explicitly.
  await supabase.from("milestones").delete().eq("project_id", input.projectId);
  await supabase.from("project_activity").delete().eq("project_id", input.projectId);
  await supabase.from("project_members").delete().eq("project_id", input.projectId);
  const { error } = await supabase.from("projects").delete().eq("id", input.projectId);
  if (error) throw new Error(error.message);
  await logAuditAction({
    action: "PROJECT_DELETED", resourceId: input.projectId, resourceType: "project",
    orgId: p.orgId, userId: input.actorUserId, userEmail: input.actorEmail, userRole: input.actorRole,
    details: { name: p.name },
  });
}

/** Transfer project ownership to another user (who is made an 'owner' member).
 *  Current owner or org Admin/DocCtrl only. Audited + notifies the new owner. */
export async function transferOwnership(input: {
  projectId: string; newOwnerUserId: string; newOwnerName?: string; newOwnerEmail?: string;
  actorUserId: string; actorEmail?: string; actorRole?: string;
}): Promise<void> {
  const p = await assertCanManageProject(input.projectId, input.actorUserId);
  const now = new Date().toISOString();
  const { error } = await supabase.from("projects").update({
    owner_user_id: input.newOwnerUserId,
    owner_user_name: input.newOwnerName || null,
    updated_at: now, updated_by: input.actorUserId,
  }).eq("id", input.projectId);
  if (error) throw new Error(error.message);
  // Make the new owner an 'owner' member; demote the prior owner to collaborator.
  await supabase.from("project_members").upsert({
    project_id: input.projectId, user_id: input.newOwnerUserId,
    user_name: input.newOwnerName || null, user_email: input.newOwnerEmail || null, role: "owner",
  }, { onConflict: "project_id,user_id" });
  if (String(p.ownerUserId) !== String(input.newOwnerUserId)) {
    await supabase.from("project_members").update({ role: "collaborator" })
      .eq("project_id", input.projectId).eq("user_id", p.ownerUserId).eq("role", "owner");
  }
  await writeActivity({
    projectId: input.projectId, orgId: p.orgId, userId: input.actorUserId, userName: input.actorEmail,
    type: "ownership_transferred",
    body: `Ownership transferred to ${input.newOwnerName || input.newOwnerEmail || input.newOwnerUserId}`,
  });
  await logAuditAction({
    action: "PROJECT_OWNERSHIP_TRANSFERRED", resourceId: input.projectId, resourceType: "project",
    orgId: p.orgId, userId: input.actorUserId, userEmail: input.actorEmail, userRole: input.actorRole,
    details: { from: p.ownerUserId, to: input.newOwnerUserId },
  });
  void notify({
    orgId: p.orgId, userId: input.newOwnerUserId, actorUserId: input.actorUserId, actorName: input.actorEmail,
    kind: "project_member", title: "You're now the project owner",
    body: `${input.actorEmail || "Someone"} transferred ownership of "${p.name}" to you.`,
    link: `/projects/${input.projectId}`, resourceType: "project", resourceId: input.projectId,
  });
}

/** Update a member's role and/or responsibility. Owner or org Admin only. */
export async function updateMember(input: {
  projectId: string; userId: string;
  role?: ProjectMemberRole; responsibility?: string | null;
  actorUserId: string;
}): Promise<void> {
  await assertCanManageProject(input.projectId, input.actorUserId);
  const patch: Record<string, unknown> = {};
  if (input.role !== undefined) patch.role = input.role;
  if (input.responsibility !== undefined) patch.responsibility = input.responsibility?.trim() || null;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from("project_members").update(patch)
    .eq("project_id", input.projectId).eq("user_id", input.userId);
  if (error) throw new Error(error.message);
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
  if (project) {
    await writeActivity({
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
  };
}

/**
 * Auto-release ad-hoc checkouts whose 24h cap has passed. Idempotent.
 *
 * Two call modes:
 *  - Client (default): pass an `orgId`, uses the RLS-scoped browser client.
 *    Opportunistically invoked on page-load of /checkouts.
 *  - Cron/server: pass `{ client }` (a service-role client) and OMIT orgId
 *    to sweep every org in one pass. This is the authoritative enforcer —
 *    the page-load path is just a nicety. See /api/cron/maintenance.
 */
export async function autoReleaseExpiredAdHoc(
  orgId?: string | null,
  opts?: { client?: SupabaseLike },
): Promise<number> {
  const db = (opts?.client ?? supabase) as SupabaseLike;
  const nowIso = new Date().toISOString();

  let query = db
    .from("checkout_sessions")
    .select("id, document_id, org_id")
    .eq("status", "active")
    .is("project_id", null)
    .lt("auto_expires_at", nowIso);
  if (orgId) query = query.eq("org_id", orgId);

  const { data } = await query;

  if (!data || data.length === 0) return 0;
  const ids = data.map((r: { id: string }) => r.id);
  const docIds = Array.from(new Set(data.map((r: { document_id: string }) => r.document_id)));
  const orgByDoc = new Map(
    (data as Array<{ document_id: string; org_id: string }>).map((r) => [r.document_id, r.org_id]),
  );

  await db
    .from("checkout_sessions")
    .update({
      status: "checked_in",
      ended_at: nowIso,
      released_at: nowIso,
      released_reason: "Auto-released after 24h ad-hoc cap",
    })
    .in("id", ids);

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

  return data.length;
}
