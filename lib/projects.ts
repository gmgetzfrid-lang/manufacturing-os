// lib/projects.ts
// CRUD + activity helpers for the Projects collaboration layer.
//
// A project owns one or more checkouts. Anyone in the org can list and view
// public projects; private projects are visible only to their members (admins
// always see everything for audit purposes).

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import type {
  Project, ProjectMember, ProjectActivity, ProjectActivityType,
  ProjectStatus, ProjectVisibility, ProjectMemberRole,
  CheckoutSession,
} from "@/types/schema";

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
    startedAt: r.started_at as any,
    targetCompletionDate: r.target_completion_date as any,
    completedAt: r.completed_at as any,
    cancelledAt: r.cancelled_at as any,
    cancelledReason: r.cancelled_reason as string | undefined,
    lastActivityAt: r.last_activity_at as any,
    createdAt: r.created_at as any,
    createdBy: r.created_by as string,
    updatedAt: r.updated_at as any,
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
    joinedAt: r.joined_at as any,
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
    createdAt: r.created_at as any,
  };
}

// ─── CREATE ──────────────────────────────────────────────────────────────

export type CreateProjectInput = {
  orgId: string;
  name: string;
  description?: string;
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
    startedAt: r.started_at as any,
    lastSeenAt: r.last_seen_at as any,
    expiresAt: r.expires_at as any,
    endedAt: r.ended_at as any,
    projectId: r.project_id as string | undefined,
    purpose: r.purpose as string | undefined,
    expectedReleaseAt: r.expected_release_at as any,
    autoExpiresAt: r.auto_expires_at as any,
    releasedAt: r.released_at as any,
    releasedBy: r.released_by as string | undefined,
    releasedReason: r.released_reason as string | undefined,
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
    .select("id, document_id")
    .eq("project_id", params.projectId)
    .eq("status", "active");

  if (!active || active.length === 0) return;

  const ids = active.map((r) => r.id as string);
  const docIds = active.map((r) => r.document_id as string);

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

  // Clear the documents-table checkout pointers
  await supabase
    .from("documents")
    .update({
      checked_out_by: null,
      checked_out_by_name: null,
      checked_out_at: null,
      checkout_note: null,
      current_lock_id: null,
    })
    .in("id", docIds);
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
  actorUserId: string;
  actorEmail?: string;
}): Promise<void> {
  const { error } = await supabase.from("project_members").upsert({
    project_id: input.projectId,
    user_id: input.userId,
    user_name: input.userName || null,
    user_email: input.userEmail || null,
    role: input.role || "collaborator",
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

/** Auto-release ad-hoc checkouts whose 24h cap has passed. Idempotent. */
export async function autoReleaseExpiredAdHoc(orgId: string): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("checkout_sessions")
    .select("id, document_id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .is("project_id", null)
    .lt("auto_expires_at", nowIso);

  if (!data || data.length === 0) return 0;
  const ids = data.map((r) => r.id as string);
  const docIds = data.map((r) => r.document_id as string);

  await supabase
    .from("checkout_sessions")
    .update({
      status: "checked_in",
      ended_at: nowIso,
      released_at: nowIso,
      released_reason: "Auto-released after 24h ad-hoc cap",
    })
    .in("id", ids);

  await supabase
    .from("documents")
    .update({
      checked_out_by: null,
      checked_out_by_name: null,
      checked_out_at: null,
      checkout_note: null,
      current_lock_id: null,
    })
    .in("id", docIds);

  return data.length;
}
