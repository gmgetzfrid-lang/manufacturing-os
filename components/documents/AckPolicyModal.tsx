"use client";

// AckPolicyModal — set/clear a read-&-understood requirement on a LIBRARY or a
// FOLDER from its actions / 3-dot menu, so responsibility is declared once and
// every document beneath it inherits it. Per-document overrides live in the
// Inspector's AckSection. Saving (re)opens rosters on already-issued documents.

import React, { useEffect, useState } from "react";
import { ClipboardCheck, X, Loader2, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { searchOrgUsers, type OrgUser } from "@/lib/notifications";
import { setAckPolicy } from "@/lib/acknowledgments";
import { ALL_ROLES, type AckPolicy, type Role } from "@/types/schema";

export default function AckPolicyModal({ level, id, orgId, name, uid, userName, onClose, onSaved }: {
  level: "library" | "collection";
  id: string;
  orgId: string;
  name?: string;
  uid: string | null;
  userName?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [hardGate, setHardGate] = useState(false);
  const [people, setPeople] = useState<OrgUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [existing, setExisting] = useState<AckPolicy | null>(null);
  const [userQuery, setUserQuery] = useState("");
  const [userHits, setUserHits] = useState<OrgUser[]>([]);

  const table = level === "library" ? "libraries" : "collections";
  const scopeLabel = level === "library" ? "library" : "folder";

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from(table).select("ack_policy").eq("id", id).maybeSingle();
      if (!alive) return;
      const p = (data?.ack_policy as AckPolicy) ?? null;
      setExisting(p);
      if (p) {
        setEnabled(p.enabled);
        setHardGate(!!p.hardGate);
        setRoles((p.assigneeRoles ?? []) as Role[]);
        if (p.assigneeIds?.length) {
          const { data: us } = await supabase.from("org_members").select("uid, email, display_name").eq("org_id", orgId).in("uid", p.assigneeIds);
          if (alive) setPeople((us ?? []).map((u) => ({ uid: u.uid as string, name: (u.display_name as string) || (u.email as string) || "user", email: (u.email as string) || "", role: "" })));
        }
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [table, id, orgId]);

  useEffect(() => {
    if (!userQuery.trim()) { setUserHits([]); return; }
    let alive = true;
    searchOrgUsers(orgId, userQuery.trim()).then((u) => { if (alive) setUserHits(u); }).catch(() => {});
    return () => { alive = false; };
  }, [userQuery, orgId]);

  const toggleRole = (r: Role) => setRoles((prev) => prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]);

  const save = async () => {
    setBusy(true);
    try {
      const policy: AckPolicy = {
        enabled,
        assigneeIds: people.map((p) => p.uid),
        assigneeRoles: roles,
        hardGate,
      };
      await setAckPolicy({ level, id, orgId, policy, actorId: uid, actorName: userName });
      onSaved?.(); onClose();
    } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await setAckPolicy({ level, id, orgId, policy: null, actorId: uid, actorName: userName }); onSaved?.(); onClose(); }
    finally { setBusy(false); }
  };

  const inp = "text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 outline-none focus:border-[var(--color-accent)]";
  const nobody = enabled && people.length === 0 && roles.length === 0;

  return (
    <div className="fixed inset-0 z-[520] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <ClipboardCheck className="w-5 h-5 text-[var(--color-accent)]" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-[var(--color-text)]">Read &amp; understood</div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">Every issued revision in this {scopeLabel}{name ? ` · ${name}` : ""} must be acknowledged</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-accent)]" /></div>
        ) : (
          <div className="p-5 space-y-3">
            <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Require acknowledgment
            </label>

            {enabled && (
              <>
                <div className="space-y-1">
                  <div className="text-[11px] font-bold text-[var(--color-text-muted)]">Named people</div>
                  <div className="flex flex-wrap gap-1">
                    {people.map((p) => (
                      <span key={p.uid} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[var(--color-text)]">{p.name || p.email}<button onClick={() => setPeople((prev) => prev.filter((x) => x.uid !== p.uid))}><X className="w-3 h-3" /></button></span>
                    ))}
                  </div>
                  <input value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="Search people…" className={`${inp} w-full`} />
                  {userHits.length > 0 && (
                    <div className="rounded-lg border border-[var(--color-border)] max-h-32 overflow-y-auto">
                      {userHits.filter((u) => !people.some((p) => p.uid === u.uid)).map((u) => (
                        <button key={u.uid} onClick={() => { setPeople((prev) => [...prev, u]); setUserQuery(""); setUserHits([]); }} className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-2)] flex items-center gap-1.5"><Plus className="w-3 h-3" /> {u.name || u.email}</button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] font-bold text-[var(--color-text-muted)]">Whole roles</div>
                  <div className="flex flex-wrap gap-1">
                    {ALL_ROLES.map((r) => (
                      <button key={r} onClick={() => toggleRole(r)} className={`px-2 py-0.5 rounded-full text-[11px] font-bold border transition-colors ${roles.includes(r) ? "bg-[var(--color-accent)] text-white border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>{r}</button>
                    ))}
                  </div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">Role members are resolved to individuals each time a revision is issued.</div>
                </div>

                <label className="flex items-start gap-2 text-[11px] text-[var(--color-text)] pt-1">
                  <input type="checkbox" checked={hardGate} onChange={(e) => setHardGate(e.target.checked)} className="mt-0.5" />
                  <span>Hard-gate: mark a revision <b>&ldquo;pending acknowledgment&rdquo;</b> until everyone has signed (default is soft — effective immediately, outstanding tracked &amp; escalated).</span>
                </label>

                {nobody && <div className="text-[11px] text-amber-600">Add at least one person or role, or nobody will be asked to sign.</div>}
              </>
            )}

            <div className="flex justify-between gap-2 pt-2 border-t border-[var(--color-border)]">
              <button onClick={() => void remove()} disabled={busy || !existing} className="px-3 py-2 rounded-lg text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-40">Remove</button>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)]">Cancel</button>
                <button onClick={() => void save()} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-xs font-bold disabled:opacity-50">{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
