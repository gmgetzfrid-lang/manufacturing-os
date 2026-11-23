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
import { Plus, Trash2, Check, Search } from "lucide-react";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Button } from "@/components/ui/Button";
import MoreMenu from "@/components/ui/MoreMenu";
import { said } from "@/components/admin/said";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary } from "@/components/ui/PageHero";
import { tbl, sheet, field, label, btnIcon, btnLink, link, FormRow, Section } from "@/components/admin/kit";
import { plural, bandInput, bandInputIcon } from "@/components/admin/band";

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
  const [loadError, setLoadError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    try {
      const [t, m, libs] = await Promise.all([
        listTeams(activeOrgId),
        supabase.from("org_members").select("uid, display_name, email, role").eq("org_id", activeOrgId).eq("status", "active"),
        supabase.from("libraries").select("id, name, owner_team_id").eq("org_id", activeOrgId).order("name", { ascending: true }),
      ]);
      if (m.error || libs.error) throw m.error ?? libs.error;
      setTeams(t);
      setMembers((m.data ?? []) as OrgMember[]);
      setLibraries((libs.data ?? []) as Array<{ id: string; name: string; owner_team_id: string | null }>);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
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
      await appAlert({ title: "Couldn't change the supervisor", message: said(e), tone: "danger" });
    }
  };
  const toggleLibrary = async (libId: string, owned: boolean) => {
    if (!selected || !uid) return;
    const teamId = owned ? null : selected.id;
    setLibraries((prev) => prev.map((l) => (l.id === libId ? { ...l, owner_team_id: teamId } : l)));
    try { await setLibraryOwnerTeam({ libraryId: libId, orgId: activeOrgId, teamId, actorId: uid }); }
    catch (e) {
      void refresh();
      await appAlert({ title: "Couldn't change who owns the library", message: said(e), tone: "danger" });
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
    catch (e) { await appAlert({ title: "Couldn't load the team's people", message: said(e), tone: "danger" }); }
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
      await appAlert({ title: "Couldn't make the team", message: said(e), tone: "danger" });
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
      await appAlert({ title: has ? "Couldn't take them off the team" : "Couldn't add them to the team", message: said(e), tone: "danger" });
    }
  };

  const handleDelete = async (team: Team) => {
    if (!(await appConfirm({ message: `Delete the team "${team.name}"? Its people keep their accounts, and rules that name the team stop applying. Libraries it owns go back to having no department.`, tone: "danger", confirmLabel: "Delete team" }))) return;
    try { await deleteTeam(team.id); }
    catch (e) { await appAlert({ title: "Couldn't delete the team", message: said(e), tone: "danger" }); return; }
    if (selected?.id === team.id) setSelected(null);
    void refresh();
  };
  const rename = async (team: Team, name: string) => {
    try { await updateTeam(team.id, { name }); void refresh(); }
    catch (e) { await appAlert({ title: "Couldn't rename the team", message: said(e), tone: "danger" }); }
  };

  if (!isAdmin) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Teams" title="Admins and managers only." sub="Ask an admin to change the teams." />
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
    : loadError != null ? "Couldn't load the teams."
    : teams.length === 0 ? "No teams yet."
    : `${plural(teams.length, "team")}.`;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Teams and departments"
        title={answer}
        sub="Give a whole team access at once, and let a department own a library."
        factsHero="none"
        facts={teams.length > 0 ? [
          { label: "People", value: members.length },
          { label: "Libraries owned", value: `${ownedLibs} of ${libraries.length}` },
        ] : undefined}
        primary={<button type="button" onClick={() => setCreating(true)} className={heroPrimary}><Plus className="w-4 h-4" /> New team</button>}
      />

      <PageBody>
      {loading && teams.length === 0 ? (
        <SkeletonRows rows={3} cols={3} what="teams" />
      ) : loadError != null ? (
        <ErrorNote error={loadError} title="Couldn't load the teams." onRetry={() => void refresh()} />
      ) : (
        <>
          <Section label="Teams" count={teams.length}>
            {creating && (
              <div className={`${sheet} mb-3 p-4 flex flex-wrap items-end gap-3`}>
                <div className="flex-1 min-w-[220px]">
                  <label htmlFor="new-team-name" className={label}>Team name</label>
                  <input id="new-team-name" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Drafting"
                    onKeyDown={(e) => e.key === "Enter" && void handleCreate()} className={field} />
                </div>
                <div>
                  <div className={label} id="new-team-color">Color</div>
                  <div className="flex items-center gap-1.5 h-10" role="group" aria-labelledby="new-team-color">
                    {TEAM_COLORS.map((c) => (
                      <button key={c} type="button" onClick={() => setNewColor(c)} aria-label={`Team color ${c}`} aria-pressed={newColor === c} className={`w-6 h-6 pointer-coarse:w-9 pointer-coarse:h-9 rounded-full grid place-items-center ${newColor === c ? "ring-2 ring-offset-2 ring-offset-[var(--color-surface)] ring-[var(--color-text)]" : ""}`} style={{ backgroundColor: c }} />
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="secondary" onClick={() => void handleCreate()} loading={busy} disabled={!newName.trim()}>Make team</Button>
                  <button type="button" onClick={() => { setCreating(false); setNewName(""); }} className={btnLink}>Cancel</button>
                </div>
              </div>
            )}
            {teams.length === 0 ? (
              !creating && (
                <div className={`${sheet} px-4 py-8 text-center`}>
                  <p className="text-[15px] text-[var(--color-text)]">A team gets access together, and can own a library.</p>
                  <button type="button" onClick={() => setCreating(true)} className={`${link} mt-1.5 font-semibold`}>Make the first team</button>
                </div>
              )
            ) : (
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={`${tbl.thead} max-sm:hidden`}>
                    <tr>
                      <th className={tbl.th}>Team</th>
                      <th className={`${tbl.th} text-right`}>People</th>
                      <th className={`${tbl.th} max-md:hidden`}>Supervisor</th>
                      <th className={`${tbl.th} text-right max-md:hidden`}>Libraries owned</th>
                      <th className={`${tbl.th} w-14`}><span className="sr-only">More</span></th>
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {teams.map((t) => {
                      const on = selected?.id === t.id;
                      return (
                        <tr key={t.id} onClick={() => void openTeam(t)} className={`${tbl.tr} cursor-pointer ${on ? "!bg-[var(--color-surface-2)]" : ""}`}>
                          <td className={`${tbl.td} relative`}>
                            {on && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--color-current)]" />}
                            <button type="button" onClick={(e) => { e.stopPropagation(); void openTeam(t); }} aria-current={on ? "true" : undefined}
                              className="inline-flex items-center gap-2.5 text-left font-semibold text-[var(--color-text)] hover:underline underline-offset-2">
                              {/* The team's own color, as a dot. */}
                              <span aria-hidden className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: t.color ?? "var(--color-text-faint)" }} />
                              {t.name}
                            </button>
                            <span className="sm:hidden ml-2 text-[13px] text-[var(--color-text-muted)]">{plural(t.memberCount ?? 0, "person", "people")}</span>
                          </td>
                          <td className={`${tbl.td} max-sm:hidden text-right ${(t.memberCount ?? 0) === 0 ? "text-[var(--color-text-faint)]" : ""}`}>{t.memberCount ?? 0}</td>
                          <td className={`${tbl.td} max-md:hidden`}>{nameOf(t.supervisorUserId) ?? <span className="text-[var(--color-text-faint)]">Not set</span>}</td>
                          <td className={`${tbl.td} max-md:hidden text-right ${ownedCount(t.id) === 0 ? "text-[var(--color-text-faint)]" : ""}`}>{ownedCount(t.id)}</td>
                          <td className={`${tbl.td} text-right`} onClick={(e) => e.stopPropagation()}>
                            <MoreMenu iconOnly label={`More for ${t.name}`} triggerClass={btnIcon} items={[
                              { icon: <Trash2 className="w-4 h-4" />, label: "Delete team", tone: "bad", onClick: () => handleDelete(t) },
                            ]} />
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
                <span aria-hidden className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: selected.color ?? "var(--color-text-faint)" }} />
                <input key={selected.id} defaultValue={selected.name} aria-label="Team name" title="Rename the team" onBlur={(e) => { if (e.target.value.trim() && e.target.value !== selected.name) { void rename(selected, e.target.value.trim()); } }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  className="font-display text-[20px] font-semibold text-[var(--color-text)] bg-transparent min-w-0 flex-1 rounded-md px-1.5 -ml-1.5 h-10 border border-transparent hover:border-[var(--color-border-strong)] focus:bg-[var(--color-surface)]" />
                <span className="text-[14px] text-[var(--color-text-muted)] tabular-nums">{plural(teamMemberIds.length, "person", "people")} in this team</span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,38fr)_minmax(0,62fr)] gap-6 items-start">
                <div className={sheet}>
                  <FormRow label="Supervisor" htmlFor="team-supervisor" hint="Owns this department's libraries, unless a library names its own owner.">
                    <select id="team-supervisor" value={selected.supervisorUserId ?? ""} onChange={(e) => void setSupervisor(e.target.value || null)} className={field}>
                      <option value="">None</option>
                      {members.map((m) => <option key={m.uid} value={m.uid}>{m.display_name || m.email || m.uid}</option>)}
                    </select>
                  </FormRow>
                  <div className="border-t border-[var(--color-border)]" />
                  <FormRow label="Owns libraries" hint="Pick a library to give it to this department.">
                    <div className="flex flex-wrap gap-1.5">
                      {libraries.map((l) => {
                        const owned = l.owner_team_id === selected.id;
                        const otherTeam = !!l.owner_team_id && l.owner_team_id !== selected.id;
                        return (
                          <button key={l.id} type="button" onClick={() => void toggleLibrary(l.id, owned)} disabled={otherTeam} aria-pressed={owned}
                            title={otherTeam ? "Owned by another department" : undefined}
                            className={`ui-tag !h-8 pointer-coarse:!h-10 disabled:opacity-50 disabled:!cursor-not-allowed ${owned ? "!border-[var(--color-text)]" : "is-more"}`}>
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
                      <Search className={bandInputIcon} />
                      <input type="search" value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder="Find a person" aria-label="Find a person"
                        className={bandInput} />
                    </div>
                  </div>
                  <div className="max-h-[480px] overflow-auto divide-y divide-[var(--color-border)]">
                    {filteredMembers.map((m) => {
                      const inTeam = teamMemberIds.includes(m.uid);
                      return (
                        <button key={m.uid} type="button" role="checkbox" onClick={() => toggleMember(m.uid)} aria-checked={inTeam} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)] text-left">
                          <span aria-hidden className={`w-5 h-5 rounded-[5px] grid place-items-center shrink-0 border ${inTeam ? "border-[var(--color-text)] text-[var(--color-text)]" : "border-[var(--color-border-control)]"} bg-[var(--color-surface)]`}>
                            {inTeam && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold text-[var(--color-text)] truncate">{m.display_name || m.email || m.uid}</span>
                            <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{m.email}</span>
                          </span>
                          {m.role && <span className="text-[13px] text-[var(--color-text-muted)] shrink-0">{m.role}</span>}
                        </button>
                      );
                    })}
                    {filteredMembers.length === 0 && <div className="px-4 py-8 text-center text-[var(--color-text-muted)]">Nobody matches &ldquo;{memberSearch}&rdquo;.</div>}
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
