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
import { UsersRound, Plus, Trash2, Loader2, Check, Search, ShieldAlert } from "lucide-react";
import { appConfirm } from "@/components/providers/DialogProvider";

interface OrgMember { uid: string; display_name: string | null; email: string | null; role: string }

const TEAM_COLORS = ["#4f46e5", "#2563eb", "#0d9488", "#059669", "#ea580c", "#e11d48", "#db2777", "#7c3aed"];

export default function AdminTeamsPage() {
  const { activeRole, activeOrgId, uid } = useRole();
  const isAdmin = activeRole === "Admin" || activeRole === "Manager";

  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Team | null>(null);
  const [teamMemberIds, setTeamMemberIds] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(TEAM_COLORS[0]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    try {
      const [t, m] = await Promise.all([
        listTeams(activeOrgId),
        supabase.from("org_members").select("uid, display_name, email, role").eq("org_id", activeOrgId).eq("status", "active"),
      ]);
      setTeams(t);
      setMembers((m.data ?? []) as OrgMember[]);
    } finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const openTeam = async (team: Team) => {
    setSelected(team);
    setTeamMemberIds(await listTeamMembers(team.id));
  };

  const handleCreate = async () => {
    if (!activeOrgId || !uid || !newName.trim()) return;
    setBusy(true);
    try {
      const t = await createTeam({ orgId: activeOrgId, name: newName.trim(), color: newColor, createdBy: uid });
      setNewName(""); setCreating(false);
      await refresh();
      await openTeam(t);
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
    } catch {
      setTeamMemberIds(await listTeamMembers(selected.id)); // revert on error
    }
  };

  const handleDelete = async (team: Team) => {
    if (!(await appConfirm({ message: `Delete team "${team.name}"? Members keep their accounts; only this grouping is removed.`, tone: "danger" }))) return;
    await deleteTeam(team.id);
    if (selected?.id === team.id) setSelected(null);
    void refresh();
  };

  if (!isAdmin) {
    return (
      <div className="p-8 max-w-2xl">
        <div className="flex items-center gap-3 p-4 rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-text)]">
          <ShieldAlert className="w-5 h-5" />
          <span>Only Admins and Managers can manage teams.</span>
        </div>
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
          <div className="w-11 h-11 rounded-2xl grid place-items-center text-white" style={{ background: "var(--brand-gradient)" }}>
            <UsersRound className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-black text-[var(--color-text)]">Teams</h1>
            <p className="text-sm text-[var(--color-text-muted)]">Group users, then grant a whole team access to libraries, folders, or files.</p>
          </div>
        </div>
        <button onClick={() => setCreating(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-[var(--color-accent-fg)] shadow-sm hover:opacity-90" style={{ background: "var(--color-accent)" }}>
          <Plus className="w-4 h-4" /> New team
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
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
                    <button key={c} onClick={() => setNewColor(c)} className={`w-5 h-5 rounded-full ${newColor === c ? "ring-2 ring-offset-1 ring-[var(--color-text-muted)]" : ""}`} style={{ backgroundColor: c }} />
                  ))}
                </div>
                <div className="flex gap-2">
                  <button onClick={handleCreate} disabled={busy || !newName.trim()} className="flex-1 px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-50" style={{ background: "var(--color-accent)" }}>Create</button>
                  <button onClick={() => { setCreating(false); setNewName(""); }} className="px-3 py-1.5 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Cancel</button>
                </div>
              </div>
            )}
            {teams.length === 0 && !creating && (
              <div className="p-6 text-center rounded-2xl border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">No teams yet. Create one to get started.</div>
            )}
            {teams.map((t) => (
              <button key={t.id} onClick={() => openTeam(t)}
                className={`group w-full flex items-center gap-3 p-3 rounded-2xl border text-left transition-colors ${selected?.id === t.id ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]"}`}>
                <span className="w-9 h-9 rounded-xl grid place-items-center text-white shrink-0" style={{ backgroundColor: t.color ?? "#4f46e5" }}>
                  <UsersRound className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-sm text-[var(--color-text)] truncate">{t.name}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">{t.memberCount ?? 0} member{(t.memberCount ?? 0) === 1 ? "" : "s"}</div>
                </div>
                <Trash2 onClick={(e) => { e.stopPropagation(); handleDelete(t); }} className="w-4 h-4 text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-accent)]" />
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
                  <input defaultValue={selected.name} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== selected.name) { void updateTeam(selected.id, { name: e.target.value.trim() }).then(refresh); } }}
                    className="font-black text-[var(--color-text)] bg-transparent flex-1 outline-none" />
                  <span className="text-xs text-[var(--color-text-muted)]">{teamMemberIds.length} in team</span>
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
                      <button key={m.uid} onClick={() => toggleMember(m.uid)} className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-[var(--color-surface-2)] text-left">
                        <span className={`w-5 h-5 rounded-md grid place-items-center shrink-0 ${inTeam ? "text-white" : "border border-[var(--color-border-strong)]"}`} style={inTeam ? { background: "var(--color-accent)" } : undefined}>
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
