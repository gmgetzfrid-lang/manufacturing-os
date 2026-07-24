"use client";

// AccessRecertModal — set the access-recertification cadence for a LIBRARY and
// perform the attestation: review the current access list (from the ACL), prune
// via the Permissions panel if needed, then confirm it's still appropriate. The
// attestation snapshots the list and resets the clock.

import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, X, Loader2, CheckCircle2, ShieldAlert } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  setRecertPolicy, recertifyAccess, listAccessGrants, recertStatusFor, daysUntilRecert,
  type AccessGrant,
} from "@/lib/accessRecert";
import type { RecertPolicy } from "@/types/schema";

export default function AccessRecertModal({ libraryId, orgId, name, uid, userName, onClose, onSaved }: {
  libraryId: string;
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
  const [months, setMonths] = useState(6);
  const [existing, setExisting] = useState<RecertPolicy | null>(null);
  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [lastAt, setLastAt] = useState<string | null>(null);
  const [nextDate, setNextDate] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data }, g] = await Promise.all([
        supabase.from("libraries").select("recert_policy, last_recertified_at, next_recertification_date").eq("id", libraryId).maybeSingle(),
        listAccessGrants(orgId, libraryId),
      ]);
      const p = (data?.recert_policy as RecertPolicy) ?? null;
      setExisting(p);
      if (p) { setEnabled(p.enabled); setMonths(p.intervalMonths ?? 6); }
      setLastAt((data?.last_recertified_at as string | null) ?? null);
      setNextDate((data?.next_recertification_date as string | null) ?? null);
      setGrants(g);
    } finally { setLoading(false); }
  }, [libraryId, orgId]);
  useEffect(() => { void load(); }, [load]);

  const savePolicy = async () => {
    setBusy(true);
    try { await setRecertPolicy({ libraryId, orgId, policy: { enabled, intervalMonths: months }, actorId: uid, actorName: userName }); await load(); onSaved?.(); }
    finally { setBusy(false); }
  };
  const clearPolicy = async () => {
    setBusy(true);
    try { await setRecertPolicy({ libraryId, orgId, policy: null, actorId: uid, actorName: userName }); await load(); onSaved?.(); }
    finally { setBusy(false); }
  };
  const recertify = async () => {
    setBusy(true);
    try { await recertifyAccess({ libraryId, orgId, note: note.trim() || undefined, actorId: uid, actorName: userName }); setNote(""); await load(); onSaved?.(); }
    finally { setBusy(false); }
  };

  const status = recertStatusFor(nextDate);
  const days = daysUntilRecert(nextDate);
  const inp = "text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 outline-none focus:border-[var(--color-accent)]";

  return (
    <div className="fixed inset-0 z-[520] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <KeyRound className="w-5 h-5 text-[var(--color-accent)]" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-[var(--color-text)]">Access recertification</div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">Review &amp; attest who has access to {name || "this library"}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-accent)]" /></div>
        ) : (
          <div className="p-5 space-y-4 overflow-y-auto">
            {/* Status */}
            <div className="flex items-center gap-2 text-[12px]">
              {lastAt
                ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> Last recertified {lastAt.slice(0, 10)}</span>
                : <span className="text-[var(--color-text-muted)]">Never recertified</span>}
              {nextDate && <span className={`ml-auto inline-flex items-center gap-1 font-bold ${status === "overdue" ? "text-rose-700" : status === "due_soon" ? "text-amber-700" : "text-[var(--color-text-muted)]"}`}>
                {status === "overdue" ? `Overdue ${Math.abs(days ?? 0)}d` : status === "due_soon" ? `Due in ${days}d` : `Next ${nextDate.slice(0, 10)}`}
              </span>}
            </div>

            {/* Cadence */}
            <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-2">
              <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Require periodic recertification
              </label>
              {enabled && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--color-text-muted)]">Every</span>
                  <input type="number" min={1} value={months} onChange={(e) => setMonths(Math.max(1, parseInt(e.target.value) || 1))} className={`${inp} w-20`} />
                  <span className="text-xs text-[var(--color-text-muted)]">months</span>
                  <button onClick={() => void savePolicy()} disabled={busy} className="ml-auto px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white text-xs font-bold disabled:opacity-50">Save cadence</button>
                </div>
              )}
              {existing && <button onClick={() => void clearPolicy()} disabled={busy} className="text-[11px] text-red-600 hover:underline">Remove cadence</button>}
            </div>

            {/* Access list */}
            <div>
              <div className="text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">Current access · {grants.length}</div>
              {grants.length === 0 ? (
                <div className="text-[11px] text-[var(--color-text-muted)]">No explicit grants on this library (inherited / default access only).</div>
              ) : (
                <div className="rounded-lg border border-[var(--color-border)] max-h-52 overflow-y-auto divide-y divide-[var(--color-border)]">
                  {grants.map((g, i) => (
                    <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                      <span className="text-[10px] font-bold uppercase text-[var(--color-text-faint)] w-10 shrink-0">{g.subjectType}</span>
                      <span className="text-[var(--color-text)] min-w-0 truncate">{g.subjectName}</span>
                      <span className="ml-auto text-[10px] text-[var(--color-text-muted)] truncate">{g.actions.join(", ")}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="text-[10px] text-[var(--color-text-muted)] mt-1 flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> To remove access, use the library&apos;s Permissions panel, then attest below.</div>
            </div>

            {/* Attest */}
            <div className="space-y-2 pt-1 border-t border-[var(--color-border)]">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional) — e.g. removed 2 contractors" className={`${inp} w-full`} />
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)]">Close</button>
                <button onClick={() => void recertify()} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Recertify — access reviewed</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
