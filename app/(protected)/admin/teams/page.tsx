"use client";

// Admin → Teams. Build named groups of users that can be granted access
// as a single ACL subject (subject.type === "team"). Pairs with the
// document permission drawer, where a team can be granted access to a
// library/folder/file in one click.

import React, { useCallback, useEffect, useState } from "react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import {
  listTeams, createTeam, updateTeam, deleteTeam,
  listTeamMembers, addTeamMember, removeTeamMember, type Team,
} from "@/lib/teams";
import { setLibraryOwnerTeam } from "@/lib/ownership";
import { UsersRound, Plus, Trash2, Loader2, Check, Search, ShieldAlert } from "lucide-react";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";
import LoadingBlock from "@/components/ui/LoadingBlock";

interface OrgMember { uid: string; display_name: string | null; email: string | null; role: string }

const TEAM_COLORS = ["#4f46e5", "#2563eb", "#0d9488", "#059669", "#ea580c", "#e11d48", "#db2777", "#7c3aed"];

export default function AdminTeamsPage() {
  const { activeRole, activeOrgId, uid } = useRole();
  const isAdmin = activeRole === "Admin" || activeRole === "Manager";

  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [libraries, setLibraries] = useState<Array<{ id: string; name: string; owner_team_id: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Team | null>(null);
  const [teamMemberIds, setTeamMemberIds] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(TEAM_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    try {
      const [t, m, libs] = await Promise.all([
        listTeams(activeOrgId),
        supabase.from("org_members").select("uid, display_name, email, role").eq("org_id", activeOrgId).eq("status", "active"),
        supabase.from("libraries").select("id, name, owner_team_id").eq("org_id", activeOrgId).order("name", { ascending: true }),
      ]);
      if (m.error || libs.error) throw new Error((m.error ?? libs.error)?.message);
      setTeams(t);
      setMembers((m.data ?? []) as OrgMember[]);
      setLibraries((libs.data ?? []) as Array<{ id: string; name: string; owner_team_id: string | null }>);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message || "Couldn't load teams.");
    } finally { setLoading(false); }
  }, [activeOrgId]);

  const setSupervisor = async (sup: string | null) => {
    if (!selected) return;
    const before = selected.supervisorUserId ?? null;
    setSelected({ ...selected, supervisorUserId: sup });
    setTeams((prev) => prev.map((t) => (t.id === selected.id ? { ...t, supervisorUserId: sup } : t)));
    try { await updateTeam(selected.id, { supervisorUserId: sup }); }
    catch (e) {
      setSelected((cur) => (cur && cur.id === selected.id ? { ...cur, supervisorUserId: before } : cur));
      void refresh();
      await appAlert({ title: "Couldn't change the supervisor", message: (e as Error).message, tone: "danger" });
    }
  };
  const toggleLibrary = async (libId: string, owned: boolean) => {
    if (!selected || !uid) return;
    const teamId = owned ? null : selected.id;
    setLibraries((prev) => prev.map((l) => (l.id === libId ? { ...l, owner_team_id: teamId } : l)));
    try { await setLibraryOwnerTeam({ libraryId: libId, orgId: activeOrgId, teamId, actorId: uid }); }
    catch (e) {
      void refresh();
      await appAlert({ title: "Couldn't change who owns the library", message: (e as Error).message, tone: "danger" });
    }
  };

  useEffect(() => { void refresh(); }, [refresh]);

  const openTeam = async (team: Team) => {
    setSelected(team);
    setTeamMemberIds([]);
    try { setTeamMemberIds(await listTeamMembers(team.id)); }
    catch (e) { await appAlert({ title: "Couldn't load the team's members", message: (e as Error).message, tone: "danger" }); }
  };

  const handleCreate = async () => {
    if (!activeOrgId || !uid || !newName.trim()) return;
    setBusy(true);
    try {
      const t = await createTeam({ orgId: activeOrgId, name: newName.trim(), color: newColor, createdBy: uid });
      setNewName(""); setCreating(false);
      await refresh();
      // Straight into the new team, to add its people.
      await openTeam(t);
    } catch (e) {
      await appAlert({ title: "Couldn't create the team", message: (e as Error).message, tone: "danger" });
    } finally { setBusy(false); }
  };

  const toggleMember = async (memberUid: string) => {
    if (!selected || !activeOrgId || !uid) return;
    const has = teamMemberIds.includes(memberUid);
    setTeamMemberIds((prev) => has ? prev.filter((x) => x !== memberUid) : [...prev, memberUid]); // optimistic
    try {
      if (has) await removeTeamMember(selected.id, memberUid);
      else await addTeamMember({ teamId: selected.id, uid: memberUid, orgId: activeOrgId, addedBy: uid });
      void refresh();
    } catch (e) {
      setTeamMemberIds((prev) => has ? [...prev, memberUid] : prev.filter((x) => x !== memberUid)); // roll back
      await appAlert({ title: has ? "Couldn't remove them from the team" : "Couldn't add them to the team", message: (e as Error).message, tone: "danger" });
    }
  };

  const handleDelete = async (team: Team) => {
    if (!(await appConfirm({ message: `Delete team "${team.name}"? Members keep their accounts; only this grouping is removed.`, tone: "danger" }))) return;
    try { await deleteTeam(team.id); }
    catch (e) { await appAlert({ title: "Couldn't delete the team", message: (e as Error).message, tone: "danger" }); return; }
    if (selected?.id === team.id) setSelected(null);
    void refresh();
  };
  const rename = async (team: Team, name: string) => {
    try { await updateTeam(team.id, { name }); void refresh(); }
    catch (e) { await appAlert({ title: "Couldn't rename the team", message: (e as Error).message, tone: "danger" }); }
  };

  if (!isAdmin) {
    return (
      <div className="p-8 max-w-2xl">
        <p className="flex items-center gap-3 text-sm text-[var(--color-text-muted)]">
          <ShieldAlert className="w-5 h-5" />
          <span>Only Admins and Managers can manage teams.</span>
        </p>
      </div>
    );
  }

  const filteredMembers = members.filter((m) => {
    const q = memberSearch.toLowerCase();
    return !q || (m.display_name ?? "").toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q);
  });

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl grid place-items-center bg-[var(--color-surface-2)] text-[var(--color-text)]">
            <UsersRound className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-black text-[var(--color-text)]">Teams &amp; departments</h1>
            <p className="text-sm text-[var(--color-text-muted)]">
              {loading ? "Group people, give a whole team access, and let a department own a library." : `${teams.length} team${teams.length === 1 ? "" : "s"} · ${members.length} people`}
            </p>
          </div>
        </div>
        <button onClick={() => setCreating(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]">
          <Plus className="w-4 h-4" /> New team
        </button>
      </div>

      {loading && teams.length === 0 ? (
        <LoadingBlock what="teams" />
      ) : loadError ? (
        <p role="alert" className="border-l-2 border-red-500 pl-3 py-1 text-sm text-red-700 dark:text-red-400">
          Couldn&apos;t load teams: {loadError}{" "}
          <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">
          {/* team list */}
          <div className="space-y-2">
            {creating && (
              <div className="p-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
                <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Team name (e.g. Drafting)"
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-sm text-[var(--color-text)] mb-2" />
                <div className="flex items-center gap-1.5 mb-2">
                  {TEAM_COLORS.map((c) => (
                    <button key={c} onClick={() => setNewColor(c)} aria-label={`Team color ${c}`} aria-pressed={newColor === c} className={`w-5 h-5 rounded-full ${newColor === c ? "ring-2 ring-offset-1 ring-[var(--color-text-muted)]" : ""}`} style={{ backgroundColor: c }} />
                  ))}
                </div>
                <div className="flex gap-2">
                  <button onClick={handleCreate} disabled={busy || !newName.trim()} className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">{busy && <Loader2 className="w-3 h-3 animate-spin" />} Create</button>
                  <button onClick={() => { setCreating(false); setNewName(""); }} className="px-3 py-1.5 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Cancel</button>
                </div>
              </div>
            )}
            {teams.length === 0 && !creating && (
              <div className="p-6 text-center rounded-2xl border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">No teams yet. Create one to get started.</div>
            )}
            {teams.map((t) => (
              <button key={t.id} onClick={() => openTeam(t)}
                className={`group w-full flex items-center gap-3 p-3 rounded-2xl border text-left transition-colors ${selected?.id === t.id ? "border-[var(--color-text)] bg-[var(--color-surface-2)]" : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]"}`}>
                <span className="w-9 h-9 rounded-xl grid place-items-center text-white shrink-0" style={{ backgroundColor: t.color ?? "#4f46e5" }}>
                  <UsersRound className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-sm text-[var(--color-text)] truncate">{t.name}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">{t.memberCount ?? 0} member{(t.memberCount ?? 0) === 1 ? "" : "s"}</div>
                </div>
                <Trash2 aria-label={`Delete ${t.name}`} onClick={(e) => { e.stopPropagation(); void handleDelete(t); }} className="w-4 h-4 text-[var(--color-text-faint)] opacity-60 group-hover:opacity-100 hover:text-rose-600" />
              </button>
            ))}
          </div>

          {/* member editor */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden">
            {!selected ? (
              <div className="p-12 text-center text-[var(--color-text-muted)]">
                <UsersRound className="w-10 h-10 mx-auto mb-3 text-[var(--color-text-faint)]" />
                Select a team to manage its members.
              </div>
            ) : (
              <>
                <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
                  <span className="w-8 h-8 rounded-lg grid place-items-center text-white shrink-0" style={{ backgroundColor: selected.color ?? "#4f46e5" }}><UsersRound className="w-4 h-4" /></span>
                  <input key={selected.id} defaultValue={selected.name} aria-label="Team name" onBlur={(e) => { if (e.target.value.trim() && e.target.value !== selected.name) { void rename(selected, e.target.value.trim()); } }}
                    className="font-black text-[var(--color-text)] bg-transparent flex-1 outline-none" />
                  <span className="text-xs text-[var(--color-text-muted)]">{teamMemberIds.length} in team</span>
                </div>

                {/* Department: supervisor (effective owner of owned libraries) + owned libraries */}
                <div className="px-5 py-3 border-b border-[var(--color-border)] space-y-2 bg-[var(--color-surface-2)]/40">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-[var(--color-text-muted)] w-24 shrink-0">Supervisor</span>
                    <select value={selected.supervisorUserId ?? ""} onChange={(e) => void setSupervisor(e.target.value || null)}
                      className="flex-1 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] px-2 py-1.5 outline-none">
                      <option value="">None</option>
                      {members.map((m) => <option key={m.uid} value={m.uid}>{m.display_name || m.email || m.uid}</option>)}
                    </select>
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">The supervisor owns any library this department owns, unless that library names its own owner.</div>
                  <div>
                    <div className="text-[11px] font-bold text-[var(--color-text-muted)] mb-1">Owns libraries</div>
                    <div className="flex flex-wrap gap-1.5">
                      {libraries.map((l) => {
                        const owned = l.owner_team_id === selected.id;
                        const otherTeam = !!l.owner_team_id && l.owner_team_id !== selected.id;
                        return (
                          <button key={l.id} onClick={() => void toggleLibrary(l.id, owned)} disabled={otherTeam}
                            title={otherTeam ? "Owned by another department" : undefined}
                            className={`px-2 py-0.5 rounded-full text-[11px] font-bold border transition-colors disabled:opacity-40 ${owned ? "bg-[var(--color-text)] text-[var(--color-surface)] border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>
                            {l.name}{otherTeam ? " · other" : ""}
                          </button>
                        );
                      })}
                      {libraries.length === 0 && <span className="text-[11px] text-[var(--color-text-muted)]">No libraries yet.</span>}
                    </div>
                  </div>
                </div>

                <div className="px-5 py-3 border-b border-[var(--color-border)]">
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
                    <input value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder="Search people…"
                      className="w-full pl-9 pr-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-sm text-[var(--color-text)]" />
                  </div>
                </div>
                <div className="max-h-[480px] overflow-auto divide-y divide-[var(--color-border)]">
                  {filteredMembers.map((m) => {
                    const inTeam = teamMemberIds.includes(m.uid);
                    return (
                      <button key={m.uid} onClick={() => toggleMember(m.uid)} aria-pressed={inTeam} className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-[var(--color-surface-2)] text-left">
                        <span aria-hidden className={`w-5 h-5 rounded-md grid place-items-center shrink-0 ${inTeam ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "border border-[var(--color-border-strong)]"}`}>
                          {inTeam && <Check className="w-3.5 h-3.5" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-[var(--color-text)] truncate">{m.display_name || m.email || m.uid}</div>
                          <div className="text-xs text-[var(--color-text-muted)] truncate">{m.email} · {m.role}</div>
                        </div>
                      </button>
                    );
                  })}
                  {filteredMembers.length === 0 && <div className="px-5 py-8 text-center text-sm text-[var(--color-text-muted)]">No matching people.</div>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
