// lib/teams.ts
// CRUD for Teams — named groups of users usable as an ACL subject
// (subject.type === "team"). Admins build teams once and grant whole
// teams access to libraries/folders/files instead of naming each user.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";

export interface Team {
  id: string;
  orgId: string;
  name: string;
  description?: string | null;
  color?: string | null;
  /** The team lead / department supervisor — becomes the effective owner of any
   *  library this team owns (see lib/ownership.ts). */
  supervisorUserId?: string | null;
  memberCount?: number;
  createdAt?: string;
}

export interface TeamMember {
  teamId: string;
  uid: string;
  orgId: string;
  addedAt?: string;
}

function fromDb(row: Record<string, unknown>): Team {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    color: (row.color as string | null) ?? null,
    supervisorUserId: (row.supervisor_user_id as string | null) ?? null,
    createdAt: row.created_at as string | undefined,
  };
}

export async function listTeams(orgId: string): Promise<Team[]> {
  const { data, error } = await supabase
    .from("teams")
    .select("*")
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) throw error;
  const teams = (data ?? []).map(fromDb);

  // Attach member counts in one query.
  const ids = teams.map((t) => t.id);
  if (ids.length) {
    const { data: members } = await supabase
      .from("team_members")
      .select("team_id")
      .in("team_id", ids);
    const counts = new Map<string, number>();
    for (const m of members ?? []) {
      const tid = (m as { team_id: string }).team_id;
      counts.set(tid, (counts.get(tid) ?? 0) + 1);
    }
    for (const t of teams) t.memberCount = counts.get(t.id) ?? 0;
  }
  return teams;
}

export async function createTeam(input: {
  orgId: string; name: string; description?: string; color?: string; createdBy: string;
}): Promise<Team> {
  const { data, error } = await supabase
    .from("teams")
    .insert({
      org_id: input.orgId,
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? null,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (error) throw error;
  return fromDb(data as Record<string, unknown>);
}

export async function updateTeam(teamId: string, patch: { name?: string; description?: string; color?: string; supervisorUserId?: string | null }): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.color !== undefined) row.color = patch.color;
  if (patch.supervisorUserId !== undefined) row.supervisor_user_id = patch.supervisorUserId;
  const { error } = await supabase.from("teams").update(row).eq("id", teamId);
  if (error) throw error;
}

/** DEC-9 fix 2 + 3: change a team's supervisor with an audit row naming both
 *  people and every affected library; clearing the supervisor of a team that
 *  OWNS libraries is refused unless `clearOwnership` is set, in which case the
 *  team ownership is cleared too (each library audited). Checked write. */
export async function setTeamSupervisor(input: {
  teamId: string; orgId: string; supervisorUserId: string | null;
  actorId: string; actorEmail?: string | null; clearOwnership?: boolean;
}): Promise<{ affectedLibraries: Array<{ id: string; name: string }> }> {
  const { data: teamRow, error: teamErr } = await supabase.from("teams")
    .select("id, name, supervisor_user_id").eq("id", input.teamId).maybeSingle();
  if (teamErr) throw new Error(teamErr.message);
  if (!teamRow) throw new Error("Team not found.");
  const previous = (teamRow.supervisor_user_id as string | null) ?? null;
  const { data: libs, error: libErr } = await supabase.from("libraries")
    .select("id, name").eq("org_id", input.orgId).eq("owner_team_id", input.teamId);
  if (libErr) throw new Error(libErr.message);
  const affected = ((libs ?? []) as Array<{ id: string; name: string }>);

  if (input.supervisorUserId === null && affected.length > 0 && !input.clearOwnership) {
    throw new Error(`This department owns ${affected.length} librar${affected.length === 1 ? "y" : "ies"} (${affected.map((l) => l.name).join(", ")}). Clearing its supervisor would leave them without an effective owner — pick a new supervisor, or clear the department's library ownership first.`);
  }

  const { data: updated, error } = await supabase.from("teams")
    .update({ supervisor_user_id: input.supervisorUserId, updated_at: new Date().toISOString() })
    .eq("id", input.teamId).select("id");
  if (error) throw new Error(error.message);
  if (!updated || updated.length === 0) throw new Error("Supervisor was NOT changed — you don't have authority over this team.");

  await logAuditAction({
    action: "TEAM_SUPERVISOR_CHANGED", resourceType: "team", resourceId: input.teamId,
    orgId: input.orgId, userId: input.actorId, userEmail: input.actorEmail ?? undefined,
    details: {
      teamName: teamRow.name, previousSupervisor: previous, newSupervisor: input.supervisorUserId,
      affectedLibraries: affected,
    },
  }).catch(() => {});

  if (input.supervisorUserId === null && affected.length > 0 && input.clearOwnership) {
    for (const l of affected) {
      const { data: cleared, error: clrErr } = await supabase.from("libraries")
        .update({ owner_team_id: null }).eq("id", l.id).select("id");
      if (clrErr || !cleared || cleared.length === 0) {
        throw new Error(`Supervisor cleared, but library "${l.name}" is still team-owned (refused) — clear it from the library's ownership controls.`);
      }
      await logAuditAction({
        action: "OWNER_TEAM_CLEARED", resourceType: "library", resourceId: l.id,
        orgId: input.orgId, userId: input.actorId, userEmail: input.actorEmail ?? undefined,
        details: { teamId: input.teamId, reason: "supervisor_cleared" },
      }).catch(() => {});
    }
  }
  return { affectedLibraries: affected };
}

/** DEC-9 fix 4: deleting a team must not leave libraries.owner_team_id
 *  dangling — ownership is cleared (audited per library) BEFORE the delete;
 *  the database FK (ON DELETE SET NULL) is the backstop. */
export async function deleteTeam(teamId: string, ctx?: { orgId?: string | null; actorId?: string | null; actorEmail?: string | null }): Promise<void> {
  if (ctx?.orgId) {
    const { data: libs } = await supabase.from("libraries").select("id, name").eq("org_id", ctx.orgId).eq("owner_team_id", teamId);
    for (const l of ((libs ?? []) as Array<{ id: string; name: string }>)) {
      const { error: clrErr } = await supabase.from("libraries").update({ owner_team_id: null }).eq("id", l.id);
      if (clrErr) throw new Error(`Team not deleted: library "${l.name}" is still owned by it and could not be released (${clrErr.message}).`);
      await logAuditAction({
        action: "OWNER_TEAM_CLEARED", resourceType: "library", resourceId: l.id,
        orgId: ctx.orgId, userId: ctx.actorId ?? "unknown", userEmail: ctx.actorEmail ?? undefined,
        details: { teamId, reason: "team_deleted" },
      }).catch(() => {});
    }
  }
  const { error } = await supabase.from("teams").delete().eq("id", teamId);
  if (error) throw error;
  if (ctx?.orgId) {
    await logAuditAction({
      action: "TEAM_DELETED", resourceType: "team", resourceId: teamId,
      orgId: ctx.orgId, userId: ctx.actorId ?? "unknown", userEmail: ctx.actorEmail ?? undefined,
    }).catch(() => {});
  }
}

export async function listTeamMembers(teamId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("team_members")
    .select("uid")
    .eq("team_id", teamId);
  if (error) throw error;
  return (data ?? []).map((r) => (r as { uid: string }).uid);
}

export async function addTeamMember(input: { teamId: string; uid: string; orgId: string; addedBy: string }): Promise<void> {
  const { error } = await supabase.from("team_members").insert({
    team_id: input.teamId, uid: input.uid, org_id: input.orgId, added_by: input.addedBy,
  });
  if (error) throw error;
}

export async function removeTeamMember(teamId: string, uid: string): Promise<void> {
  const { error } = await supabase.from("team_members").delete().eq("team_id", teamId).eq("uid", uid);
  if (error) throw error;
}

/** Team ids the given user belongs to — used to populate the ACL principal. */
export async function getMyTeamIds(uid: string): Promise<string[]> {
  const { data, error } = await supabase.from("team_members").select("team_id").eq("uid", uid);
  if (error) return [];
  return (data ?? []).map((r) => (r as { team_id: string }).team_id);
}
