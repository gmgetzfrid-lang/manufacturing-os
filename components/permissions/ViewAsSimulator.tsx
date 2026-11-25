"use client";

// ViewAsSimulator: "what does this person actually see and do?"
// Pick any member; their EFFECTIVE access is computed with the same
// evaluators the app enforces with (capability policy for actions,
// ACL chain for content) — not a re-implementation that could drift.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Minus, Eye, EyeOff, UploadCloud, CircleAlert } from "lucide-react";
import { Section, sheet, btnLink, shortDate } from "@/components/admin/kit";
import { said } from "@/components/admin/said";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { appConfirm } from "@/components/providers/DialogProvider";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import {
  CAPABILITY_DEFS, loadCapabilityPolicy, policyAllows, addUserGrant, revokeUserGrant,
  grantsForUser, grantActive, __resetCapabilityPolicyCache,
  type CapabilityPolicy, type CapabilityId,
} from "@/lib/capabilityPolicy";
import { canDiscover, canPublishOnLibrary, canPublishViaIndex, isControllerRole } from "@/lib/permissions";
import type { AccessControl, AclIndex, NodeVisibility, Role } from "@/types/schema";

interface Member { uid: string; name: string; role: string; roles: string[] }
interface LibRow { id: string; name: string; acl: AccessControl | null; aclIndex: AclIndex | null; visibility: NodeVisibility }

export default function ViewAsSimulator({ canEdit = false }: { canEdit?: boolean }) {
  const { activeOrgId, uid: actorUid, userEmail: actorEmail } = useRole();
  const [members, setMembers] = useState<Member[]>([]);
  const [libs, setLibs] = useState<LibRow[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [pick, setPick] = useState<string>("");
  const [policy, setPolicy] = useState<CapabilityPolicy>({});

  useEffect(() => {
    if (!activeOrgId) return;
    void (async () => {
      const [m, l, p] = await Promise.all([
        supabase.from("org_members").select("uid, display_name, email, role, roles").eq("org_id", activeOrgId).eq("status", "active").order("display_name"),
        supabase.from("libraries").select("id, name, acl, acl_index, visibility").eq("org_id", activeOrgId).order("name"),
        loadCapabilityPolicy(activeOrgId),
      ]);
      setMembers((((m.data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        uid: String(r.uid), name: String(r.display_name || r.email || r.uid),
        role: String(r.role ?? "Viewer"), roles: (r.roles as string[] | null) ?? [],
      })));
      setLibs((((l.data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        id: String(r.id), name: String(r.name),
        acl: (r.acl as AccessControl | null) ?? null,
        aclIndex: (r.acl_index as AclIndex | null) ?? null,
        visibility: ((r.visibility as NodeVisibility) || "normal"),
      })));
      setPolicy(p);
    })();
  }, [activeOrgId]);

  // The picked member's team memberships (teams factor into ACL grants).
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!pick) { if (alive) setTeamIds([]); return; }
      try {
        const { data } = await supabase.from("team_members").select("team_id").eq("user_id", pick);
        if (alive) setTeamIds((((data ?? []) as Array<{ team_id: string }>)).map((r) => r.team_id));
      } catch { if (alive) setTeamIds([]); }
    })();
    return () => { alive = false; };
  }, [pick]);

  const who = useMemo(() => members.find((m) => m.uid === pick) ?? null, [members, pick]);

  // ── Per-person delegation state ──
  const [grantCap, setGrantCap] = useState<CapabilityId>("ticket.assign");
  const [grantUntil, setGrantUntil] = useState("");
  const [grantNote, setGrantNote] = useState("");
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantErr, setGrantErr] = useState<string | null>(null);

  const refreshPolicy = useCallback(async () => {
    if (!activeOrgId) return;
    __resetCapabilityPolicyCache();
    setPolicy(await loadCapabilityPolicy(activeOrgId));
  }, [activeOrgId]);

  const capLabel = (c: CapabilityId) => CAPABILITY_DEFS.find((d) => d.id === c)?.label ?? c;

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
    } catch (e) { setGrantErr(said(e, "Couldn't delegate it.")); }
    finally { setGrantBusy(false); }
  };

  const doRevoke = async (cap: CapabilityId) => {
    if (!activeOrgId || !actorUid || !who) return;
    if (!(await appConfirm({ title: `Take back "${capLabel(cap)}" from ${who.name}?`, message: "They lose it now, unless their role gives it.", tone: "danger", confirmLabel: "Take back" }))) return;
    setGrantBusy(true); setGrantErr(null);
    try {
      await revokeUserGrant({ orgId: activeOrgId, uid: who.uid, cap, actorUserId: actorUid, actorEmail });
      await refreshPolicy();
    } catch (e) { setGrantErr(said(e, "Couldn't take it back.")); }
    finally { setGrantBusy(false); }
  };

  const personalGrants = who ? grantsForUser(policy, who.uid) : [];

  // Explicit content rules naming this person (library-level scan).
  const contentRules = useMemo(() => {
    if (!who) return [] as Array<{ node: string; effect: string; actions: string; expiresAt?: string }>;
    const out: Array<{ node: string; effect: string; actions: string; expiresAt?: string }> = [];
    for (const l of libs) {
      for (const r of l.acl?.rules ?? []) {
        if (r.subject?.type === "user" && r.subject.id === who.uid) {
          out.push({ node: l.name, effect: r.effect, actions: (r.actions ?? []).join(", "), expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : undefined });
        }
      }
    }
    return out;
  }, [who, libs]);

  const caps = useMemo(() => {
    if (!who) return [];
    return CAPABILITY_DEFS.map((d) => ({
      def: d,
      ok: policyAllows(policy, d.id, who.role, who.roles, who.uid),
    }));
  }, [who, policy]);

  const sub = "text-reading font-medium text-[var(--color-text)] mb-2";
  const note = "mt-2 text-body text-[var(--color-text-muted)]";
  return (
    <Section
      label={<>View as <HelpTooltip>See what any member can see and do, using the same checks the app enforces. Delegate a single action to one person here, too.</HelpTooltip></>}
      action={
        <Select value={pick} aria-label="Person to view as" onChange={(e) => setPick(e.target.value)} className="w-full sm:w-72">
          <option value="">Pick a person</option>
          {members.map((m) => <option key={m.uid} value={m.uid}>{m.name}, {m.role}</option>)}
        </Select>
      }
    >
      {!who ? (
        <div className={`${sheet} px-4 py-6 text-center text-reading text-[var(--color-text-muted)]`}>Pick a person to see what they can see and do.</div>
      ) : (
        // Two groups in one sheet: space between them, no rule (B3).
        <div className={sheet}>
          <div className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-[minmax(0,62fr)_minmax(0,38fr)] gap-x-8 gap-y-6">
            <div>
              <h3 className={sub}>Actions {who.name} can take <span className="font-normal text-[var(--color-text-muted)] tabular-nums">{caps.filter((c) => c.ok).length} of {caps.length}</span></h3>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                {caps.map(({ def, ok }) => (
                  <li key={def.id} className={`text-body flex items-start gap-2 ${ok ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}`}>
                    {ok ? <Check aria-label="Can" className="w-4 h-4 mt-0.5 text-[var(--color-text-muted)] shrink-0" /> : <Minus aria-label="Can't" className="w-4 h-4 mt-0.5 shrink-0" />}
                    <span>{def.label} <span className="text-body text-[var(--color-text-faint)]">{def.area}</span></span>
                  </li>
                ))}
              </ul>
              <p className={note}>Plus their own requests: as requester, assigned drafter or assigned engineer.</p>
            </div>
            <div>
              <h3 className={sub}>Libraries</h3>
              {/* A short list: space between the rows, no line under each. */}
              <ul className="grid gap-1">
                {libs.map((l) => {
                  const principal = { uid: who.uid, role: who.role as Role, orgId: activeOrgId ?? undefined, teamIds, isActiveMember: true };
                  const sees = canDiscover({ principal, aclChain: [l.acl ?? undefined], visibility: l.visibility });
                  const viaIdx = canPublishViaIndex(l.aclIndex, principal);
                  const publishes = isControllerRole(principal.role) || (viaIdx !== null ? viaIdx : canPublishOnLibrary({ principal, libraryAcl: l.acl ?? undefined }));
                  return (
                    <li key={l.id} className="py-0.5 flex items-center gap-2 text-body">
                      <span className="font-medium text-[var(--color-text)] truncate flex-1 min-w-0">{l.name}</span>
                      {sees
                        ? <span className="inline-flex items-center gap-1 text-[var(--color-text)]"><Eye aria-hidden className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> Sees</span>
                        : <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]"><EyeOff aria-hidden className="w-3.5 h-3.5" /> Hidden</span>}
                      {publishes && <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]"><UploadCloud aria-hidden className="w-3.5 h-3.5" /> Publishes</span>}
                    </li>
                  );
                })}
                {libs.length === 0 && <li className="py-0.5 text-body text-[var(--color-text-muted)]">No libraries yet.</li>}
              </ul>
              <p className={note}>Folder and document rules narrow this inside each library; open one&apos;s permissions to check. Owning a document, folder or library also lets them publish there.</p>
            </div>
          </div>

          {/* This person's own permissions: delegations and content rules. */}
          <div className="px-4 pb-4 pt-2 sm:px-5 sm:pb-5 grid grid-cols-1 lg:grid-cols-[minmax(0,62fr)_minmax(0,38fr)] gap-x-8 gap-y-6">
            <div>
              <h3 className={sub}>Actions delegated to {who.name}</h3>
              {personalGrants.length === 0 ? (
                <p className="text-body text-[var(--color-text-muted)]">None. Everything they can do comes from their role{contentRules.length ? " and the content rules beside this" : ""}.</p>
              ) : (
                <ul className="grid gap-2">
                  {personalGrants.map((g) => (
                    <li key={g.cap} className="flex items-center gap-3 text-body">
                      <span className="min-w-0 flex-1">
                        <span className={`font-medium ${grantActive(g) ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)] line-through"}`}>{capLabel(g.cap)}</span>
                        <span className="block text-body text-[var(--color-text-muted)]">
                          {g.expiresAt ? `Until ${shortDate(g.expiresAt)}${grantActive(g) ? "" : ", ended"}` : "Until taken back"}
                          {g.note ? `. ${g.note}` : ""}
                        </span>
                      </span>
                      {canEdit && (
                        <button type="button" onClick={() => void doRevoke(g.cap)} disabled={grantBusy} className={`${btnLink} !text-[var(--color-text-muted)] hover:!text-[var(--state-overdue-text)]`}>
                          Take back
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canEdit && (
                <form className="mt-4 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_160px] gap-3" onSubmit={(e) => { e.preventDefault(); void doGrant(); }}>
                  <Field label="Delegate an action" className="sm:col-span-2">
                    <Select value={grantCap} onChange={(e) => setGrantCap(e.target.value as CapabilityId)}>
                      {CAPABILITY_DEFS.map((d) => <option key={d.id} value={d.id}>{d.area}: {d.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Why" hint="Goes in the audit log.">
                    <Input value={grantNote} onChange={(e) => setGrantNote(e.target.value)} placeholder="Covering for J. Ortiz this week" />
                  </Field>
                  <Field label="Until" hint="Blank: until taken back.">
                    <Input type="date" value={grantUntil} onChange={(e) => setGrantUntil(e.target.value)} min={new Date().toISOString().slice(0, 10)} className="[color-scheme:light] dark:[color-scheme:dark]" />
                  </Field>
                  <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
                    <Button type="submit" variant="secondary" loading={grantBusy}>Delegate</Button>
                    <span className="text-body text-[var(--color-text-muted)]">Only adds to what {who.name} can do; nobody else loses anything.</span>
                  </div>
                  {grantErr && <p role="alert" className="sm:col-span-2 text-body font-medium text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" /><span>{grantErr}</span></p>}
                </form>
              )}
            </div>

            <div>
              <h3 className={sub}>Library rules that name them</h3>
              {contentRules.length === 0 ? (
                <p className="text-body text-[var(--color-text-muted)]">None. Their access comes from role defaults, visibility, or team and role rules. To add a rule for one person, open a library, folder or document under Content permissions.</p>
              ) : (
                <ul className="grid gap-2">
                  {contentRules.map((r, i) => (
                    <li key={i} className="text-body">
                      <span className="font-medium text-[var(--color-text)]">{r.node}</span>{" "}
                      <span className={r.effect === "deny" ? "font-medium text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}>{r.effect === "deny" ? "Denied" : "Allowed"}</span>
                      <span className="block text-body text-[var(--color-text-muted)]">{r.actions}{r.expiresAt ? `, until ${shortDate(r.expiresAt)}` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
