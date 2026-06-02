// lib/teams.ts
// CRUD for Teams — named groups of users usable as an ACL subject
// (subject.type === "team"). Admins build teams once and grant whole
// teams access to libraries/folders/files instead of naming each user.

import { supabase } from "@/lib/supabase";

export interface Team {
  id: string;
  orgId: string;
  name: string;
  description?: string | null;
  color?: string | null;
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

export async function updateTeam(teamId: string, patch: { name?: string; description?: string; color?: string }): Promise<void> {
  const { error } = await supabase
    .from("teams")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", teamId);
  if (error) throw error;
}

export async function deleteTeam(teamId: string): Promise<void> {
  const { error } = await supabase.from("teams").delete().eq("id", teamId);
  if (error) throw error;
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
