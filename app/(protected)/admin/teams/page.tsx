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
import { Plus, Trash2, Loader2, Check, Search, ShieldAlert, Users } from "lucide-react";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary } from "@/components/ui/PageHero";
import { tbl, sheet, field, label, btnQuiet, btnIcon, FormRow, Section, Problem, Pill } from "@/components/admin/kit";
import { plural } from "@/components/admin/band";

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

  // Open the first team once the list arrives, so its people and libraries
  // are in view without a click.
  const autoOpened = React.useRef(false);

  const openTeam = async (team: Team) => {
    setSelected(team);
    setTeamMemberIds([]);
    try { setTeamMemberIds(await listTeamMembers(team.id)); }
    catch (e) { await appAlert({ title: "Couldn't load the team's members", message: (e as Error).message, tone: "danger" }); }
  };

  useEffect(() => {
    if (autoOpened.current || selected || teams.length === 0) return;
    autoOpened.current = true;
    void openTeam(teams[0]);
  }, [teams, selected]);

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
      <PageShell width="work">
        <PageHero kicker="Admin · Teams" title="Admins and managers only." overlap={false}
          sub={<span className="inline-flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> Only Admins and Managers can manage teams.</span>} />
      </PageShell>
    );
  }

  const filteredMembers = members.filter((m) => {
    const q = memberSearch.toLowerCase();
    return !q || (m.display_name ?? "").toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q);
  });

  const ownedCount = (teamId: string) => libraries.filter((l) => l.owner_team_id === teamId).length;
  const nameOf = (u?: string | null) => { const m = members.find((x) => x.uid === u); return m ? (m.display_name || m.email || m.uid) : null; };
  const ownedLibs = libraries.filter((l) => !!l.owner_team_id).length;

  const answer = loading && teams.length === 0 ? "Teams"
    : loadError ? "Couldn't load teams."
    : teams.length === 0 ? "No teams yet."
    : `${plural(teams.length, "team")}.`;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Teams and departments"
        title={answer}
        sub="Give a whole team access at once, and let a department own a library."
        facts={teams.length > 0 ? [
          { label: "People", value: members.length },
          { label: "Libraries owned", value: `${ownedLibs} of ${libraries.length}` },
        ] : undefined}
        primary={<button type="button" onClick={() => setCreating(true)} className={heroPrimary}><Plus className="w-4 h-4" /> New team</button>}
      />

      <PageBody>
      {loading && teams.length === 0 ? (
        <LoadingBlock what="teams" />
      ) : loadError ? (
        <Problem retry={() => void refresh()}>Couldn&apos;t load teams: {loadError}</Problem>
      ) : (
        <>
          <Section label="Teams" icon={Users} count={teams.length}>
            {creating && (
              <div className={`${sheet} mb-3 p-4 flex flex-wrap items-end gap-3`}>
                <div className="flex-1 min-w-[220px]">
                  <label htmlFor="new-team-name" className={label}>Team name</label>
                  <input id="new-team-name" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Drafting"
                    onKeyDown={(e) => e.key === "Enter" && handleCreate()} className={field} />
                </div>
                <div>
                  <div className={label} id="new-team-color">Color</div>
                  <div className="flex items-center gap-1.5 h-10" role="group" aria-labelledby="new-team-color">
                    {TEAM_COLORS.map((c) => (
                      <button key={c} type="button" onClick={() => setNewColor(c)} aria-label={`Team color ${c}`} aria-pressed={newColor === c} className={`w-6 h-6 rounded-full ${newColor === c ? "ring-2 ring-offset-2 ring-[var(--color-text)]" : ""}`} style={{ backgroundColor: c }} />
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={handleCreate} disabled={busy || !newName.trim()} className={btnQuiet}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Create team</button>
                  <button type="button" onClick={() => { setCreating(false); setNewName(""); }} className={btnQuiet}>Cancel</button>
                </div>
              </div>
            )}
            {teams.length === 0 ? (
              !creating && <div className={`${sheet} px-4 py-8 text-center text-[var(--color-text-muted)]`}>No teams yet. Make one to group people and give them access together.</div>
            ) : (
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={`${tbl.thead} max-sm:hidden`}>
                    <tr>
                      <th className={tbl.th}>Team</th>
                      <th className={`${tbl.th} text-right`}>People</th>
                      <th className={`${tbl.th} max-md:hidden`}>Supervisor</th>
                      <th className={`${tbl.th} text-right max-md:hidden`}>Libraries owned</th>
                      <th className={`${tbl.th} w-14`}><span className="sr-only">Delete</span></th>
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {teams.map((t) => {
                      const on = selected?.id === t.id;
                      return (
                        <tr key={t.id} onClick={() => void openTeam(t)} className={`${tbl.tr} cursor-pointer ${on ? "!bg-[var(--color-accent-soft)]" : ""}`}>
                          <td className={`${tbl.td} relative`}>
                            {on && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--color-main)]" />}
                            <button type="button" onClick={(e) => { e.stopPropagation(); void openTeam(t); }} aria-current={on ? "true" : undefined}
                              className={`inline-flex items-center gap-2.5 text-left font-semibold hover:text-[var(--color-accent-text)] ${on ? "text-[var(--color-accent-text)]" : "text-[var(--color-text)]"}`}>
                              {/* The team's own color on its tile. */}
                              <span aria-hidden className="ui-icon-tile is-sm" style={{ backgroundColor: `color-mix(in srgb, ${t.color ?? "#64748b"} 16%, transparent)`, color: t.color ?? "#64748b" }}><Users className="w-4 h-4" /></span>
                              {t.name}
                            </button>
                            <span className="sm:hidden ml-2 text-[13px] text-[var(--color-text-muted)]">{plural(t.memberCount ?? 0, "person", "people")}</span>
                          </td>
                          <td className={`${tbl.td} max-sm:hidden text-right`}><span className={`ui-count ${(t.memberCount ?? 0) > 0 ? (on ? "is-solid" : "") : "!bg-[var(--color-surface-2)] !text-[var(--color-text-muted)]"}`}>{t.memberCount ?? 0}</span></td>
                          <td className={`${tbl.td} max-md:hidden`}>{nameOf(t.supervisorUserId) ?? <Pill>Not set</Pill>}</td>
                          <td className={`${tbl.td} max-md:hidden text-right`}><span className={`ui-count ${ownedCount(t.id) > 0 ? (on ? "is-solid" : "") : "!bg-[var(--color-surface-2)] !text-[var(--color-text-muted)]"}`}>{ownedCount(t.id)}</span></td>
                          <td className={`${tbl.td} text-right`}>
                            <button type="button" aria-label={`Delete ${t.name}`} onClick={(e) => { e.stopPropagation(); void handleDelete(t); }} className={`${btnIcon} hover:text-[var(--state-overdue)]`}>
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {!selected ? (
            teams.length > 0 && <p className="text-[15px] text-[var(--color-text-muted)]">Pick a team to set its supervisor, libraries and people.</p>
          ) : (
            <section className="min-w-0" aria-label={`Team ${selected.name}`}>
              <div className="flex flex-wrap items-center gap-3 mb-2.5">
                <span aria-hidden className="ui-icon-tile" style={{ backgroundColor: selected.color ?? "var(--color-main)", color: "#ffffff" }}><Users className="w-[18px] h-[18px]" /></span>
                <input key={selected.id} defaultValue={selected.name} aria-label="Team name" onBlur={(e) => { if (e.target.value.trim() && e.target.value !== selected.name) { void rename(selected, e.target.value.trim()); } }}
                  className="font-display text-[22px] font-semibold text-[var(--color-text)] bg-transparent min-w-0 flex-1 rounded-md px-1.5 -ml-1.5 border border-transparent hover:border-[var(--color-border-strong)] focus:border-[var(--color-main)] focus:bg-[var(--color-surface)] outline-none" />
                <span className="inline-flex items-center gap-1.5 text-[14px] text-[var(--color-text-muted)]"><span className="ui-count is-solid">{teamMemberIds.length}</span> {teamMemberIds.length === 1 ? "person" : "people"} in this team</span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
                <div className={sheet}>
                  <FormRow label="Supervisor" htmlFor="team-supervisor" hint="Owns this department's libraries, unless a library names its own owner.">
                    <select id="team-supervisor" value={selected.supervisorUserId ?? ""} onChange={(e) => void setSupervisor(e.target.value || null)} className={field}>
                      <option value="">None</option>
                      {members.map((m) => <option key={m.uid} value={m.uid}>{m.display_name || m.email || m.uid}</option>)}
                    </select>
                  </FormRow>
                  <div className="border-t border-[var(--color-border)]" />
                  <FormRow label="Owns libraries" hint="Tap a library to give it to this department.">
                    <div className="flex flex-wrap gap-1.5">
                      {libraries.map((l) => {
                        const owned = l.owner_team_id === selected.id;
                        const otherTeam = !!l.owner_team_id && l.owner_team_id !== selected.id;
                        return (
                          <button key={l.id} type="button" onClick={() => void toggleLibrary(l.id, owned)} disabled={otherTeam} aria-pressed={owned}
                            title={otherTeam ? "Owned by another department" : undefined}
                            className={`ui-tag !h-8 disabled:opacity-50 disabled:!cursor-not-allowed ${owned ? "!bg-[var(--color-main)] !text-white !border-[var(--color-main)]" : "is-more"}`}>
                            {owned && <Check className="w-3.5 h-3.5" />}{l.name}{otherTeam ? " (another team)" : ""}
                          </button>
                        );
                      })}
                      {libraries.length === 0 && <span className="text-[14px] text-[var(--color-text-muted)]">No libraries yet.</span>}
                    </div>
                  </FormRow>
                </div>

                <div className={`${sheet} overflow-hidden`}>
                  <div className="p-3 border-b border-[var(--color-border)]">
                    <div className="relative">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
                      <input value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder="Find a person" aria-label="Find a person"
                        className={`${field} pl-9`} />
                    </div>
                  </div>
                  <div className="max-h-[480px] overflow-auto divide-y divide-[var(--color-border)]">
                    {filteredMembers.map((m) => {
                      const inTeam = teamMemberIds.includes(m.uid);
                      return (
                        <button key={m.uid} type="button" onClick={() => toggleMember(m.uid)} aria-pressed={inTeam} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)] text-left">
                          <span aria-hidden className={`w-5 h-5 rounded grid place-items-center shrink-0 ${inTeam ? "bg-[var(--color-main)] text-white" : "border border-[var(--color-border-strong)] bg-[var(--color-surface)]"}`}>
                            {inTeam && <Check className="w-3.5 h-3.5" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold text-[var(--color-text)] truncate">{m.display_name || m.email || m.uid}</span>
                            <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{m.email}</span>
                          </span>
                          {m.role && <span className="ui-tag shrink-0">{m.role}</span>}
                        </button>
                      );
                    })}
                    {filteredMembers.length === 0 && <div className="px-4 py-8 text-center text-[var(--color-text-muted)]">No matching people.</div>}
                  </div>
                </div>
              </div>
            </section>
          )}
        </>
      )}
      </PageBody>
    </PageShell>
  );
}
