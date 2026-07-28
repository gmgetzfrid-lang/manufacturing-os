"use client";

// ViewAsSimulator — "what does this person actually see and do?"
// Pick any member; their EFFECTIVE access is computed with the same
// evaluators the app enforces with (capability policy for actions,
// ACL chain for content) — not a re-implementation that could drift.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { UserSearch, Check, Minus, Eye, EyeOff, UploadCloud, KeyRound, Loader2, X } from "lucide-react";
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

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] mb-5 overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <UserSearch className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-base font-bold text-[var(--color-text)]">View as…</span>
        <span className="text-xs text-[var(--color-text-muted)]">simulate any member — computed with the SAME evaluators the app enforces with</span>
        <select value={pick} onChange={(e) => setPick(e.target.value)} className="ml-auto h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs min-w-[180px]">
          <option value="">Pick a member…</option>
          {members.map((m) => <option key={m.uid} value={m.uid}>{m.name} — {m.role}</option>)}
        </select>
      </div>
      {who && (
        <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5">Actions {who.name} can take ({caps.filter((c) => c.ok).length}/{caps.length})</div>
            <ul className="space-y-0.5">
              {caps.map(({ def, ok }) => (
                <li key={def.id} className={`text-[11px] flex items-center gap-1.5 ${ok ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}`}>
                  {ok ? <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" /> : <Minus className="w-3 h-3 shrink-0" />}
                  {def.label} <span className="text-[var(--color-text-faint)]">· {def.area}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 text-[10px] text-[var(--color-text-faint)]">Plus identity rights on their own tickets (requester / assigned drafter / assigned engineer).</div>
          </div>
          <div>
            <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5">Content access by library</div>
            <ul className="space-y-1">
              {libs.map((l) => {
                const principal = { uid: who.uid, role: who.role as Role, orgId: activeOrgId ?? undefined, teamIds, isActiveMember: true };
                const sees = canDiscover({ principal, aclChain: [l.acl ?? undefined], visibility: l.visibility });
                const viaIdx = canPublishViaIndex(l.aclIndex, principal);
                const publishes = isControllerRole(principal.role) || (viaIdx !== null ? viaIdx : canPublishOnLibrary({ principal, libraryAcl: l.acl ?? undefined }));
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
            <div className="mt-2 text-[10px] text-[var(--color-text-faint)]">Folder/document-level rules refine within each library — open a node&apos;s permissions to inspect. Ownership grants (owner of a doc/folder/library) add publish authority on those items.</div>
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
                    {canEdit && (
                      <button onClick={() => void doRevoke(g.cap)} disabled={grantBusy} className="ml-auto p-0.5 rounded text-[var(--color-text-faint)] hover:text-rose-600" title="Revoke">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {canEdit && (
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
                  <div className="text-[10px] text-[var(--color-text-faint)]">Additive only — a delegation can widen this person&apos;s authority, never narrow anyone else&apos;s. Audited with before/after; the &ldquo;View as&rdquo; list above updates instantly.</div>
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5">Content rules naming them (library level)</div>
              {contentRules.length === 0 && <div className="text-[11px] italic text-[var(--color-text-faint)]">No library rule names this person — access comes from role defaults, visibility, or team/role rules. Use Content permissions above to add a per-person rule on any library, folder, or document (with an expiry if temporary).</div>}
              <ul className="space-y-1">
                {contentRules.map((r, i) => (
                  <li key={i} className="text-[11px] flex items-center gap-2">
                    <span className="font-bold text-[var(--color-text)]">{r.node}</span>
                    <span className={r.effect === "deny" ? "text-rose-700 dark:text-rose-300 font-bold" : "text-emerald-700 dark:text-emerald-300 font-bold"}>{r.effect}</span>
                    <span className="text-[var(--color-text-muted)]">{r.actions}</span>
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
