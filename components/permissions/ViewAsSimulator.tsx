"use client";

// ViewAsSimulator — "what does this person actually see and do?"
// Pick any member; their EFFECTIVE access is computed with the same
// evaluators the app enforces with (capability policy for actions,
// ACL chain for content) — not a re-implementation that could drift.

import React, { useEffect, useMemo, useState } from "react";
import { UserSearch, Check, Minus, Eye, EyeOff, UploadCloud } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { CAPABILITY_DEFS, loadCapabilityPolicy, policyAllows, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { canDiscover, canPublishOnLibrary, canPublishViaIndex, isControllerRole } from "@/lib/permissions";
import type { AccessControl, AclIndex, NodeVisibility, Role } from "@/types/schema";

interface Member { uid: string; name: string; role: string; roles: string[] }
interface LibRow { id: string; name: string; acl: AccessControl | null; aclIndex: AclIndex | null; visibility: NodeVisibility }

export default function ViewAsSimulator() {
  const { activeOrgId } = useRole();
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

  const caps = useMemo(() => {
    if (!who) return [];
    return CAPABILITY_DEFS.map((d) => ({
      def: d,
      ok: policyAllows(policy, d.id, who.role, who.roles),
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
    </div>
  );
}
