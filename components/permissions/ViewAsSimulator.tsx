"use client";

// ViewAsSimulator — "what does this person actually see and do?"
// Pick any member; their EFFECTIVE access is computed with the same
// evaluators the app enforces with (capability policy for actions,
// ACL chain for content) — not a re-implementation that could drift.
//
// admin-and-org Round G, P9:
//   * ALOG-1 — a policy that could not be read is SAID (and no grant is
//     offered), never shown as the org's policy; a refresh that failed shows
//     the policy as last read, said as such (DEC-89 item 3).
//   * ORG-10 — team memberships are read for the ACTIVE org only.
//   * ORG-14 — quality sign-off is answered the way the database answers it
//     (quality_signer_eligible, 20261136): the controllers and a project's
//     owner always can; a rule scoped to a project grants it there only — pick
//     a project to see it.
//   * DACL-5 (criterion 3, simulator half) — the picker shows each member's
//     whole role collection, and the content rules list names the held role
//     or team a role / team rule matches.
//   * Integrator fix pass (2026-10-08): the 20261136 probe runs on mount, so
//     with no project picked a policy grant of quality.sign_off is not drawn
//     as held where the database does not read it yet; a member who owns
//     projects is drawn as able to sign off THERE (user_owns_project) with no
//     project picked; a member whose headline role is not known is said so
//     (DEC-91: null, never a placeholder role).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { UserSearch, Check, Minus, Eye, EyeOff, UploadCloud, KeyRound, Loader2, X, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import {
  CAPABILITY_DEFS, loadCapabilityPolicyEntry, policyAllows, scopedTokensFor, addUserGrant, revokeUserGrant,
  grantsForUser, grantActive, invalidateCapabilityPolicy, PROJECT_SCOPED_CAPS, qualitySignOffEligible, isRuleArray,
  announceCapabilityPolicyChanged, onCapabilityPolicyChanged,
  type CapabilityPolicy, type CapabilityId, type CapabilityResource, type LoadedCapabilityPolicy,
} from "@/lib/capabilityPolicy";
import { loadRequestTypeOptions, type RequestTypeOption } from "@/lib/requestTypes";
import { composedAllows, probeQualitySignOffDecided, QUALITY_SIGNOFF_PRE_PASTE } from "@/components/permissions/PermissionsExplorer";
import { canDiscover, canPublishOnLibrary, canPublishViaIndex, isControllerPrincipal } from "@/lib/permissions";
import { heldRoles } from "@/lib/roleHeld";
import type { AccessControl, AclIndex, NodeVisibility, Role } from "@/types/schema";

/** `role` is the stored headline, or null when the row carries none — never
 *  a placeholder (DEC-91): a member with no role known holds no role here. */
interface Member { uid: string; name: string; role: string | null; roles: string[] }
interface LibRow { id: string; name: string; acl: AccessControl | null; aclIndex: AclIndex | null; visibility: NodeVisibility; ownerUserId: string | null }
interface ProjectRow { id: string; name: string; ownerUserId: string | null; visibility: string | null }

/** ALOG-1: what the console says about the policy it shows. */
type PolicyIssue = { kind: "unreadable" | "stale"; error: string } | null;
const issueOf = (e: LoadedCapabilityPolicy): PolicyIssue =>
  e.unreadable ? { kind: "unreadable", error: e.unreadable }
    : e.stale ? { kind: "stale", error: e.staleError ?? "the refresh failed" } : null;

/** DACL-5: every role the member holds — the headline and the collection
 *  (a null headline adds nothing; blanks are dropped). */
const heldOf = (m: Pick<Member, "role" | "roles">): string[] => heldRoles(m);
const NO_ROLE_KNOWN = "no role known";

export default function ViewAsSimulator({ canEdit = false }: { canEdit?: boolean }) {
  const { activeOrgId, uid: actorUid, userEmail: actorEmail } = useRole();
  const [members, setMembers] = useState<Member[]>([]);
  const [libs, setLibs] = useState<LibRow[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  // OWN-10: a failed team lookup must be VISIBLE, never an empty result —
  // this is the tool an admin signs a recertification on.
  const [teamsErr, setTeamsErr] = useState<string | null>(null);
  const [pick, setPick] = useState<string>("");
  const [policy, setPolicy] = useState<CapabilityPolicy>({});
  const [policyIssue, setPolicyIssue] = useState<PolicyIssue>(null);
  const [teamNames, setTeamNames] = useState<Map<string, string>>(new Map());
  // ORG-14: the project quality sign-off is evaluated against.
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [simProject, setSimProject] = useState("");
  const [projectMembers, setProjectMembers] = useState<string[]>([]);
  const [projectErr, setProjectErr] = useState<string | null>(null);
  // ORG-14 (fix pass 2 / integrator fix pass): does the live database decide
  // quality sign-off per project yet? quality_signoff_status exists only once
  // 20261136 is pasted; before that the database admits the controllers and
  // the project's owner only, whatever the policy says. Asked once on mount
  // (probeQualitySignOffDecided). null = not known (not answered yet, or the
  // probe failed for another reason — nothing is claimed either way).
  const [signoffLive, setSignoffLive] = useState<boolean | null>(null);
  // DEC-13 stage 2: the simulator evaluates against a RESOURCE too — pick a
  // request type and the list below answers "for a ticket of this type",
  // through the same policyAllows(resource) the workflow route enforces.
  const [requestTypes, setRequestTypes] = useState<RequestTypeOption[]>([]);
  const [simType, setSimType] = useState("");
  // ALOG-14 (fix pass 2) / ORG-10's rule: a list read that failed is SAID —
  // an empty project picker or raw team ids must not read as "there are none".
  const [listErrors, setListErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!activeOrgId) return;
    void (async () => {
      const [m, l, p, rt, pr, tm] = await Promise.all([
        supabase.from("org_members").select("uid, display_name, email, role, roles").eq("org_id", activeOrgId).eq("status", "active").order("display_name"),
        supabase.from("libraries").select("id, name, acl, acl_index, visibility, owner_user_id").eq("org_id", activeOrgId).order("name"),
        loadCapabilityPolicyEntry(activeOrgId),
        loadRequestTypeOptions(activeOrgId),
        supabase.from("projects").select("id, name, owner_user_id, visibility").eq("org_id", activeOrgId).order("name"),
        supabase.from("teams").select("id, name").eq("org_id", activeOrgId),
      ]);
      setListErrors([
        ...(m.error ? [`members (${m.error.message})`] : []),
        ...(l.error ? [`libraries (${l.error.message})`] : []),
        ...(pr.error ? [`projects (${pr.error.message})`] : []),
        ...(tm.error ? [`team names (${tm.error.message})`] : []),
      ]);
      setProjects((((pr.data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        id: String(r.id), name: String(r.name ?? r.id),
        ownerUserId: (r.owner_user_id as string | null) ?? null, visibility: (r.visibility as string | null) ?? null,
      })));
      setTeamNames(new Map((((tm.data ?? []) as Array<Record<string, unknown>>)).map((r) => [String(r.id), String(r.name ?? r.id)])));
      setRequestTypes(rt);
      setMembers((((m.data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        uid: String(r.uid), name: String(r.display_name || r.email || r.uid),
        // DEC-91: a row with no headline role is null here, never "Viewer".
        role: typeof r.role === "string" && r.role.trim() ? r.role : null,
        roles: (r.roles as string[] | null) ?? [],
      })));
      setLibs((((l.data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        id: String(r.id), name: String(r.name),
        acl: (r.acl as AccessControl | null) ?? null,
        aclIndex: (r.acl_index as AclIndex | null) ?? null,
        visibility: ((r.visibility as NodeVisibility) || "normal"),
        ownerUserId: (r.owner_user_id as string | null) ?? null,
      })));
      setPolicy(p.policy);
      setPolicyIssue(issueOf(p));
    })();
  }, [activeOrgId]);

  // The picked member's team memberships (teams factor into ACL grants).
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!pick) { if (alive) { setTeamIds([]); setTeamsErr(null); } return; }
      try {
        // team_members is keyed (team_id, uid) — the old `user_id` filter was a
        // PostgREST 400 whose error was never read, so every member simulated
        // as belonging to zero teams (OWN-10).
        // ORG-10: scoped to the ACTIVE org — a member's teams in another
        // workspace grant nothing here.
        const { data, error } = await supabase.from("team_members").select("team_id").eq("uid", pick).eq("org_id", activeOrgId ?? "");
        if (!alive) return;
        if (error) { setTeamIds([]); setTeamsErr(error.message); return; }
        setTeamsErr(null);
        setTeamIds((((data ?? []) as Array<{ team_id: string }>)).map((r) => r.team_id));
      } catch (e) { if (alive) { setTeamIds([]); setTeamsErr((e as Error).message || "Team lookup failed"); } }
    })();
    return () => { alive = false; };
  }, [pick, activeOrgId]);

  // ORG-14: the picked project's members (a private project is visible to its
  // members, and quality_signoff_granted_for reads the same rule).
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!simProject) { if (alive) { setProjectMembers([]); setProjectErr(null); } return; }
      try {
        const { data, error } = await supabase.from("project_members").select("user_id").eq("project_id", simProject);
        if (!alive) return;
        if (error) { setProjectMembers([]); setProjectErr(error.message); return; }
        setProjectErr(null);
        setProjectMembers((((data ?? []) as Array<{ user_id: string }>)).map((r) => String(r.user_id)));
      } catch (e) { if (alive) { setProjectMembers([]); setProjectErr((e as Error).message || "Project members could not be read"); } }
    })();
    return () => { alive = false; };
  }, [simProject]);

  // ORG-14 (integrator fix pass): asked once, on mount — the answer qualifies
  // the no-project row too, not only a picked project.
  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    void probeQualitySignOffDecided().then((v) => { if (alive) setSignoffLive(v); });
    return () => { alive = false; };
  }, [activeOrgId]);

  const who = useMemo(() => members.find((m) => m.uid === pick) ?? null, [members, pick]);

  // ── Per-person delegation state ──
  const [grantCap, setGrantCap] = useState<CapabilityId>("ticket.assign");
  const [grantUntil, setGrantUntil] = useState("");
  const [grantNote, setGrantNote] = useState("");
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantErr, setGrantErr] = useState<string | null>(null);

  const refreshPolicy = useCallback(async () => {
    if (!activeOrgId) return;
    // WF-10: a grant or revoke drops this tab's cached copy, so the list
    // re-reads the stored policy.
    invalidateCapabilityPolicy(activeOrgId);
    const e = await loadCapabilityPolicyEntry(activeOrgId);
    setPolicy(e.policy);
    setPolicyIssue(issueOf(e));
    // ALOG-14 (fix pass 2): the explorer on this page re-reads too.
    announceCapabilityPolicyChanged(activeOrgId);
  }, [activeOrgId]);

  // ALOG-14 (fix pass 2): a save in the policy editor on this page is
  // announced; this list re-reads (the writer already dropped the cache).
  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    const off = onCapabilityPolicyChanged(activeOrgId, () => {
      void loadCapabilityPolicyEntry(activeOrgId).then((e) => {
        if (!alive) return;
        setPolicy(e.policy);
        setPolicyIssue(issueOf(e));
      }).catch((err: unknown) => {
        if (!alive) return;
        setPolicy({});
        setPolicyIssue({ kind: "unreadable", error: (err as Error)?.message || "the policy could not be read" });
      });
    });
    return () => { alive = false; off(); };
  }, [activeOrgId]);

  const doGrant = async () => {
    if (!activeOrgId || !actorUid || !who) return;
    setGrantBusy(true); setGrantErr(null);
    try {
      await addUserGrant({
        orgId: activeOrgId, uid: who.uid, cap: grantCap,
        expiresAt: grantUntil ? new Date(`${grantUntil}T23:59:59`).toISOString() : null,
        note: grantNote.trim() || null,
        actorUserId: actorUid, actorEmail,
      });
      setGrantUntil(""); setGrantNote("");
      await refreshPolicy();
    } catch (e) { setGrantErr((e as Error).message); }
    finally { setGrantBusy(false); }
  };

  const doRevoke = async (cap: CapabilityId) => {
    if (!activeOrgId || !actorUid || !who) return;
    setGrantBusy(true); setGrantErr(null);
    try {
      await revokeUserGrant({ orgId: activeOrgId, uid: who.uid, cap, actorUserId: actorUid, actorEmail });
      await refreshPolicy();
    } catch (e) { setGrantErr((e as Error).message); }
    finally { setGrantBusy(false); }
  };

  const personalGrants = who ? grantsForUser(policy, who.uid) : [];
  const capLabel = (c: CapabilityId) => CAPABILITY_DEFS.find((d) => d.id === c)?.label ?? c;

  // Content rules that reach this person (library-level scan): a rule naming
  // them, and — DACL-5 — a role rule naming any role they hold, or a team
  // rule naming a team they are in (in this org), each saying which.
  const contentRules = useMemo(() => {
    if (!who) return [] as Array<{ node: string; effect: string; actions: string; expiresAt?: string; via: string }>;
    const held = heldOf(who);
    const out: Array<{ node: string; effect: string; actions: string; expiresAt?: string; via: string }> = [];
    for (const l of libs) {
      for (const r of l.acl?.rules ?? []) {
        const sub = r.subject;
        const via = sub?.type === "user" && sub.id === who.uid ? "names them"
          : sub?.type === "role" && held.includes(String(sub.id)) ? `via their role ${sub.id}`
          : sub?.type === "team" && teamIds.includes(String(sub.id)) ? `via team ${teamNames.get(String(sub.id)) ?? sub.id}`
          : null;
        if (!via) continue;
        out.push({ node: l.name, effect: r.effect, actions: (r.actions ?? []).join(", "), expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : undefined, via });
      }
    }
    return out;
  }, [who, libs, teamIds, teamNames]);

  const project = useMemo(() => projects.find((p) => p.id === simProject) ?? null, [projects, simProject]);
  const caps = useMemo(() => {
    if (!who) return [];
    return CAPABILITY_DEFS.map((d) => {
      // DEC-13: a request type for the ticket capabilities; a project for the
      // one capability decided per project (QUAL-4, PROJECT_SCOPED_CAPS).
      const resource: CapabilityResource | undefined = PROJECT_SCOPED_CAPS.has(d.id)
        ? (simProject ? { projectId: simProject } : undefined)
        : (simType ? { requestType: simType } : undefined);
      // ALOG-14 (fix pass 2): the engine composes other capabilities onto
      // some ticket rows (a manager approves at every review stage via
      // ticket.manage; a co-reviewer reviews on the requester's behalf) —
      // the same composition the explorer's cells use (COMPOSED).
      const answer = composedAllows(policy, d.id, who.role, who.roles, who.uid, resource);
      const row = {
        def: d,
        ok: answer.ok,
        scoped: scopedTokensFor(policy, d.id, resource) !== null,
        why: (answer.via ?? answer.conditional) as string | null,
      };
      if (d.id === "quality.sign_off") {
        // ORG-14: the database's rule (quality_signer_eligible, 20261136) —
        // the controllers and the project's owner always can; anyone else by
        // the capability FOR THAT PROJECT, if they can see it.
        const held = heldOf(who);
        if (!project && isControllerPrincipal({ role: who.role as Role | null, roles: who.roles as Role[] })) {
          return { ...row, ok: true, why: "Admin / Document Control: on every project, whatever the policy says" };
        }
        if (project) {
          const v = qualitySignOffEligible({ policy, uid: who.uid, roles: held, project: { ...project, memberIds: projectMembers } });
          // Integrator fix pass: a capability grant is not what the database
          // decides until 20261136 is pasted — not drawn as held before it.
          if (v.via === "capability" && signoffLive === false) {
            return { ...row, ok: false, why: `on ${project.name}: granted by the policy for this project, but ${QUALITY_SIGNOFF_PRE_PASTE}` };
          }
          return {
            ...row, ok: v.eligible,
            why: v.via === "controller" ? `on ${project.name}: Admin / Document Control always can`
              : v.via === "owner" ? `on ${project.name}: they own the project`
              : v.via === "capability" ? `on ${project.name}: granted by the policy for this project`
              : `on ${project.name}: not eligible`,
          };
        }
        // ORG-14 (review fix): with no project picked the answer is the BASE
        // list (plus a personal grant, which counts on every project). A rule
        // scoped to a project REPLACES the base list there (tokensFor;
        // quality_signoff_granted_for, 20261136), so a base-list holder can
        // be refused on that project and a project-rule grantee admitted —
        // name those projects instead of claiming "every project".
        const entry = policy.caps?.["quality.sign_off"];
        const ruled = isRuleArray(entry)
          ? [...new Set(entry.flatMap((r) => r.when?.projectId ?? []))]
          : [];
        const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
        const differs = ruled
          .filter((pid) => policyAllows(policy, d.id, who.role, who.roles, who.uid, { projectId: pid }) !== row.ok)
          .map(nameOf);
        const rules = `${ruled.length} project rule${ruled.length === 1 ? "" : "s"}`;
        // Integrator fix pass: the projects this member OWNS — the owner
        // disjunct (user_owns_project) holds there whatever the policy says,
        // before and after 20261136, so with no project picked an owner is
        // drawn as able to sign off on those, named.
        const owned = projects.filter((p) => p.ownerUserId === who.uid).map((p) => p.name);
        const ownsNote = owned.length > 0 ? `owns ${owned.join(", ")} — a project's owner always can sign off there` : null;
        if (signoffLive === false) {
          // Integrator fix pass: the policy's grant is not what the database
          // decides yet — never drawn as held before the paste.
          return {
            ...row, ok: owned.length > 0,
            why: `${ownsNote ? `${ownsNote}; ` : ""}${row.ok ? "the policy grants it, but " : ""}${QUALITY_SIGNOFF_PRE_PASTE}`,
          };
        }
        if (row.ok) {
          return {
            ...row,
            why: ruled.length === 0 ? "granted on every project they can see"
              : differs.length === 0 ? `granted on every project they can see (${rules} replace the base list; none excludes them)`
              : `granted where no project rule applies — not on ${differs.join(", ")}, whose project rule replaces the base list (pick a project)`,
          };
        }
        const elsewhere = differs.length > 0
          ? `not by the base list — granted on ${differs.join(", ")} by a project rule`
          : "not by the base list";
        if (ownsNote) return { ...row, ok: true, why: `${ownsNote}; elsewhere ${elsewhere} (pick a project)` };
        return {
          ...row,
          why: differs.length > 0
            ? `${elsewhere}; a project's owner always can (pick a project)`
            : "per project — a project's owner always can; pick a project to see project-scoped rules",
        };
      }
      return row;
    });
  }, [who, policy, simType, simProject, project, projectMembers, projects, signoffLive]);

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] mb-5 overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <UserSearch className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-base font-bold text-[var(--color-text)]">View as…</span>
        <span className="text-xs text-[var(--color-text-muted)]">simulate any member — computed with the SAME evaluators the app enforces with</span>
        <select value={pick} onChange={(e) => setPick(e.target.value)} className="ml-auto h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs min-w-[180px]">
          <option value="">Pick a member…</option>
          {members.map((m) => <option key={m.uid} value={m.uid}>{m.name} — {heldOf(m).join(", ") || NO_ROLE_KNOWN}</option>)}
        </select>
      </div>
      {listErrors.length > 0 && (
        <div role="alert" className="mx-4 mt-3 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-2.5 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Some lists could not be read: {listErrors.join("; ")}. What follows is incomplete — a missing project, library or member is not evidence that there is none, and a team or project may be named by its id. Do not sign off an access review on it.</span>
        </div>
      )}
      {policyIssue?.kind === "unreadable" && (
        <div role="alert" className="mx-4 mt-3 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-2.5 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>This workspace&apos;s action-permission policy could not be read ({policyIssue.error}). The actions below are NOT this org&apos;s policy — they follow the shipped defaults — and no grant can be made until it loads. Do not sign off an access review on them.</span>
        </div>
      )}
      {policyIssue?.kind === "stale" && (
        <div className="mx-4 mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Couldn&apos;t refresh the action-permission policy ({policyIssue.error}) — the actions below use it as last read.</span>
        </div>
      )}
      {who && (
        <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5 flex items-center gap-2 flex-wrap">
              <span>Actions {who.name} can take ({caps.filter((c) => c.ok).length}/{caps.length})</span>
              <label className="inline-flex items-center gap-1 font-medium">
                <span>for request type</span>
                <select value={simType} onChange={(e) => setSimType(e.target.value)} className="h-6 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-[11px]">
                  <option value="">(any — base rules)</option>
                  {requestTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              <label className="inline-flex items-center gap-1 font-medium">
                <span>project</span>
                <select value={simProject} onChange={(e) => setSimProject(e.target.value)} className="h-6 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-[11px]">
                  <option value="">(any — base rules)</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>
            {projectErr && <div className="mb-1 text-[10px] font-bold text-rose-700 dark:text-rose-300">The project&apos;s members could not be read ({projectErr}) — a private project&apos;s quality sign-off below may under-report.</div>}
            {signoffLive === false && (
              <div data-signoff-pending="" className="mb-1 text-[10px] font-bold text-amber-800 dark:text-amber-300">
                This database does not decide quality sign-off per project yet (migration 20261136 is not applied): today it admits Admin / Document Control and the project&apos;s owner only, and reads no policy grant of &ldquo;Sign off quality records&rdquo;. The row below says what holds today; a grant the policy makes is named but not ticked until 20261136 is pasted.
              </div>
            )}
            <ul className="space-y-0.5">
              {caps.map(({ def, ok, scoped, why }) => (
                <li key={def.id} data-cap={def.id} data-ok={ok ? "yes" : "no"} className={`text-[11px] flex items-center gap-1.5 flex-wrap ${ok ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}`}>
                  {ok ? <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" /> : <Minus className="w-3 h-3 shrink-0" />}
                  {def.label} <span className="text-[var(--color-text-faint)]">· {def.area}</span>
                  {scoped && <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300" title="A scoped rule replaces the base list for this capability">· scoped to {PROJECT_SCOPED_CAPS.has(def.id) ? (project?.name ?? simProject) : simType}</span>}
                  {why && <span className="text-[10px] text-[var(--color-text-faint)]">· {why}</span>}
                </li>
              ))}
            </ul>
            {who && heldOf(who).length === 0 && (
              <div data-no-role="" className="mb-1 text-[10px] font-bold text-amber-800 dark:text-amber-300">No role is known for {who.name}: their membership row carries no headline role and no collection. The actions below are what a member with no role gets — nothing a role grants.</div>
            )}
            <div className="mt-2 text-[10px] text-[var(--color-text-faint)]">Plus identity rights on their own tickets (requester / assigned drafter / assigned engineer), and on their own projects (a project&apos;s owner signs off its quality records).</div>
          </div>
          <div>
            <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5">Content access by library</div>
            {teamsErr && (
              <div className="mb-2 rounded-lg border border-rose-300 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
                Team memberships could not be loaded ({teamsErr}). The rows below OMIT team-derived grants — do not sign off on them.
              </div>
            )}
            <ul className="space-y-1">
              {libs.map((l) => {
                // The SAME principal shape the mutators now build (roles collection +
                // teams), evaluated by the SAME functions — so this reports what the
                // app will actually allow, not a re-implementation. A null headline
                // (no role known) reaches them as null: heldRoles drops it and the
                // ACL role match (lib/acl.ts) guards `ctx.role &&` — it grants nothing.
                const principal = { uid: who.uid, role: who.role as Role, roles: who.roles as Role[], orgId: activeOrgId ?? undefined, teamIds, isActiveMember: true };
                const isLibOwner = !!l.ownerUserId && l.ownerUserId === who.uid;
                const sees = canDiscover({ principal, aclChain: [l.acl ?? undefined], visibility: l.visibility, effectiveOwnerUserId: l.ownerUserId });
                const viaIdx = canPublishViaIndex(l.aclIndex, principal);
                const publishes = isControllerPrincipal(principal) || isLibOwner
                  || (viaIdx !== null ? viaIdx : canPublishOnLibrary({ principal, libraryAcl: l.acl ?? undefined }));
                return (
                  <li key={l.id} className="text-[11px] flex items-center gap-2">
                    <span className="font-bold text-[var(--color-text)]">{l.name}</span>
                    {sees
                      ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><Eye className="w-3 h-3" /> visible</span>
                      : <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300"><EyeOff className="w-3 h-3" /> hidden</span>}
                    {publishes && <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-300"><UploadCloud className="w-3 h-3" /> can publish</span>}
                    <span className="text-[var(--color-text-faint)]">{l.visibility !== "normal" ? l.visibility : ""}</span>
                  </li>
                );
              })}
              {libs.length === 0 && <li className="text-[11px] italic text-[var(--color-text-faint)]">No libraries.</li>}
            </ul>
            <div className="mt-2 text-[10px] text-[var(--color-text-faint)]">Folder/document-level rules refine within each library — open a node&apos;s permissions to inspect. Library ownership is reflected above; folder/document ownership and a team-supervisor rung are resolved per node.</div>
          </div>
        </div>
      )}

      {/* ── This person's SPECIFIC permissions: delegations + content rules ── */}
      {who && (
        <div className="px-4 pb-4 border-t border-[var(--color-border)] pt-3">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className="w-4 h-4 text-violet-600 dark:text-violet-400" />
            <span className="text-sm font-bold text-[var(--color-text)]">Personal permissions for {who.name}</span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5">Delegated actions (beyond their role)</div>
              {personalGrants.length === 0 && <div className="text-[11px] italic text-[var(--color-text-faint)]">None — everything they can do comes from their role{contentRules.length ? " and the content rules on the right" : ""}.</div>}
              <ul className="space-y-1">
                {personalGrants.map((g) => (
                  <li key={g.cap} className="text-[11px] flex items-center gap-2">
                    <span className={`font-bold ${grantActive(g) ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)] line-through"}`}>{capLabel(g.cap)}</span>
                    <span className="text-[var(--color-text-faint)]">
                      {g.expiresAt ? `until ${new Date(g.expiresAt).toLocaleDateString()}${grantActive(g) ? "" : " (expired)"}` : "until revoked"}
                      {g.note ? ` · “${g.note}”` : ""}
                    </span>
                    {canEdit && policyIssue?.kind !== "unreadable" && (
                      <button onClick={() => void doRevoke(g.cap)} disabled={grantBusy} className="ml-auto p-0.5 rounded text-[var(--color-text-faint)] hover:text-rose-600" title="Revoke">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {canEdit && policyIssue?.kind === "unreadable" && (
                <div className="mt-2.5 text-[10px] font-bold text-rose-700 dark:text-rose-300">Grants are unavailable until the policy can be read.</div>
              )}
              {canEdit && policyIssue?.kind !== "unreadable" && (
                <div className="mt-2.5 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]/40 p-2.5 space-y-1.5">
                  <div className="text-[10px] font-bold text-[var(--color-text-muted)]">Delegate an action — leave the date empty for a standing grant</div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <select value={grantCap} onChange={(e) => setGrantCap(e.target.value as CapabilityId)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[11px]">
                      {CAPABILITY_DEFS.map((d) => <option key={d.id} value={d.id}>{d.area}: {d.label}</option>)}
                    </select>
                    <input type="date" value={grantUntil} onChange={(e) => setGrantUntil(e.target.value)} min={new Date().toISOString().slice(0, 10)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[11px] [color-scheme:light] dark:[color-scheme:dark]" title="Expires (optional)" />
                    <input value={grantNote} onChange={(e) => setGrantNote(e.target.value)} placeholder="why (goes on the audit)…" className="flex-1 min-w-[120px] h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[11px]" />
                    <button onClick={() => void doGrant()} disabled={grantBusy} className="h-7 inline-flex items-center gap-1 px-2.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
                      {grantBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Grant
                    </button>
                  </div>
                  {grantErr && <div className="text-[10px] text-rose-600 dark:text-rose-400 font-bold">{grantErr}</div>}
                  <div className="text-[10px] text-[var(--color-text-faint)]">Additive only — a delegation can widen this person&apos;s authority, never narrow anyone else&apos;s. Admin only, never to yourself; applied and audited with before/after on the server (WF-11); a workflow action it admits names it in the audit log (WF-16). Grants have no request-type scope — a delegation applies to every ticket (WF-13). The &ldquo;View as&rdquo; list above updates instantly.</div>
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5">Content rules that reach them (library level)</div>
              {contentRules.length === 0 && <div className="text-[11px] italic text-[var(--color-text-faint)]">No library rule names this person, a role they hold, or a team they are in — access comes from visibility, ownership or the controller tier. Use Content permissions above to add a per-person rule on any library, folder, or document (with an expiry if temporary).</div>}
              <ul className="space-y-1">
                {contentRules.map((r, i) => (
                  <li key={i} className="text-[11px] flex items-center gap-2">
                    <span className="font-bold text-[var(--color-text)]">{r.node}</span>
                    <span className={r.effect === "deny" ? "text-rose-700 dark:text-rose-300 font-bold" : "text-emerald-700 dark:text-emerald-300 font-bold"}>{r.effect}</span>
                    <span className="text-[var(--color-text-muted)]">{r.actions}</span>
                    <span className="text-[var(--color-text-faint)]">{r.via}</span>
                    {r.expiresAt && <span className="text-[var(--color-text-faint)]">until {new Date(r.expiresAt).toLocaleDateString()}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
