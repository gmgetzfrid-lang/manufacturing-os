"use client";

// RetentionPolicyModal — set/clear the retention policy on a LIBRARY or FOLDER
// (records series). Retention is usually declared at this level and inherited by
// every document beneath it. Per-document overrides + legal hold live in the
// Inspector's RetentionSection.

import React, { useEffect, useState } from "react";
import { Archive, X, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { setRetentionPolicy } from "@/lib/retention";
import type { RetentionPolicy } from "@/types/schema";

type Basis = NonNullable<RetentionPolicy["basis"]>;
type Action = NonNullable<RetentionPolicy["action"]>;

export default function RetentionPolicyModal({ level, id, orgId, name, uid, userName, onClose, onSaved }: {
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
  const [existing, setExisting] = useState<RetentionPolicy | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [years, setYears] = useState(7);
  const [basis, setBasis] = useState<Basis>("created");
  const [action, setAction] = useState<Action>("review");

  const table = level === "library" ? "libraries" : "collections";
  const scopeLabel = level === "library" ? "library" : "folder";

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from(table).select("retention_policy").eq("id", id).maybeSingle();
      if (!alive) return;
      const p = (data?.retention_policy as RetentionPolicy) ?? null;
      setExisting(p);
      if (p) { setEnabled(p.enabled); setYears(p.years ?? 7); setBasis(p.basis ?? "created"); setAction(p.action ?? "review"); }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [table, id]);

  const save = async () => {
    setBusy(true);
    try { await setRetentionPolicy({ level, id, orgId, policy: { enabled, years, basis, action }, actorId: uid, actorName: userName }); onSaved?.(); onClose(); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await setRetentionPolicy({ level, id, orgId, policy: null, actorId: uid, actorName: userName }); onSaved?.(); onClose(); }
    finally { setBusy(false); }
  };

  const inp = "text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 outline-none focus:border-[var(--color-accent)]";

  return (
    <div className="fixed inset-0 z-[520] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <Archive className="w-5 h-5 text-[var(--color-accent)]" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-[var(--color-text)]">Retention</div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">How long records in this {scopeLabel}{name ? ` · ${name}` : ""} are kept</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-accent)]" /></div>
        ) : (
          <div className="p-5 space-y-3">
            <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Require retention
            </label>
            {enabled && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-[var(--color-text-muted)]">Retain</span>
                <input type="number" min={1} value={years} onChange={(e) => setYears(Math.max(1, parseInt(e.target.value) || 1))} className={`${inp} w-20`} />
                <span className="text-xs text-[var(--color-text-muted)]">years from</span>
                <select value={basis} onChange={(e) => setBasis(e.target.value as Basis)} className={inp}>
                  <option value="created">created</option><option value="issued">issued</option><option value="effective">effective</option><option value="superseded">superseded</option>
                </select>
              </div>
            )}
            {enabled && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--color-text-muted)]">At end of life</span>
                <select value={action} onChange={(e) => setAction(e.target.value as Action)} className={inp}>
                  <option value="review">flag for review</option><option value="archive">archive</option><option value="destroy">destroy</option>
                </select>
              </div>
            )}
            <div className="text-[10px] text-[var(--color-text-muted)]">Records are never auto-destroyed — disposition is always an explicit, logged action, and a legal hold overrides it.</div>

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
