"use client";

// ReviewPolicyModal — set/clear a review cycle on a LIBRARY or a FOLDER
// (collection) from its own 3-dot / actions menu, so you don't have to drill
// into a document. Per-document policy still lives in the Inspector's
// ReviewSection. Saving recomputes every affected document's next-review date.

import React, { useEffect, useState } from "react";
import { CalendarClock, X, Loader2, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { searchOrgUsers, type OrgUser } from "@/lib/notifications";
import { setReviewPolicy, describeInterval } from "@/lib/reviewCycles";
import type { ReviewPolicy } from "@/types/schema";

export default function ReviewPolicyModal({ level, id, orgId, name, uid, userName, onClose, onSaved }: {
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
  const [count, setCount] = useState(12);
  const [unit, setUnit] = useState<"days" | "months" | "years">("months");
  const [lead, setLead] = useState(30);
  const [reviewers, setReviewers] = useState<OrgUser[]>([]);
  const [existing, setExisting] = useState<ReviewPolicy | null>(null);
  const [userQuery, setUserQuery] = useState("");
  const [userHits, setUserHits] = useState<OrgUser[]>([]);

  const table = level === "library" ? "libraries" : "collections";
  const scopeLabel = level === "library" ? "library" : "folder";

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from(table).select("review_policy").eq("id", id).maybeSingle();
      if (!alive) return;
      const p = (data?.review_policy as ReviewPolicy) ?? null;
      setExisting(p);
      if (p) {
        setEnabled(p.enabled);
        setCount(p.intervalCount ?? 12);
        setUnit(p.intervalUnit ?? "months");
        setLead(p.leadDays ?? 30);
        // Resolve reviewer names for display (org_members is the source of truth).
        if (p.reviewerIds?.length) {
          const { data: us } = await supabase.from("org_members").select("uid, email, display_name").eq("org_id", orgId).in("uid", p.reviewerIds);
          if (alive) setReviewers((us ?? []).map((u) => ({ uid: u.uid as string, name: (u.display_name as string) || (u.email as string) || "user", email: (u.email as string) || "", role: "" })));
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

  const save = async () => {
    setBusy(true);
    try {
      const policy: ReviewPolicy = {
        enabled,
        intervalCount: enabled ? count : undefined,
        intervalUnit: enabled ? unit : undefined,
        leadDays: lead,
        reviewerIds: reviewers.map((r) => r.uid),
      };
      await setReviewPolicy({ level, id, orgId, policy, userId: uid, userName });
      onSaved?.(); onClose();
    } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await setReviewPolicy({ level, id, orgId, policy: null, userId: uid, userName }); onSaved?.(); onClose(); }
    finally { setBusy(false); }
  };

  const inp = "text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 outline-none focus:border-[var(--color-accent)]";

  return (
    <div className="fixed inset-0 z-[520] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <CalendarClock className="w-5 h-5 text-[var(--color-accent)]" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-[var(--color-text)]">Review cycle</div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">Applies to every document in this {scopeLabel}{name ? ` · ${name}` : ""}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-accent)]" /></div>
        ) : (
          <div className="p-5 space-y-3">
            <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Require periodic review
            </label>
            {enabled && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--color-text-muted)]">Every</span>
                  <input type="number" min={1} value={count} onChange={(e) => setCount(Math.max(1, parseInt(e.target.value) || 1))} className={`${inp} w-20`} />
                  <select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} className={inp}>
                    <option value="days">days</option><option value="months">months</option><option value="years">years</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--color-text-muted)]">Warn</span>
                  <input type="number" min={0} value={lead} onChange={(e) => setLead(Math.max(0, parseInt(e.target.value) || 0))} className={`${inp} w-20`} />
                  <span className="text-xs text-[var(--color-text-muted)]">days before due</span>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-bold text-[var(--color-text-muted)]">Notify (besides Admin/DocCtrl)</div>
                  <div className="flex flex-wrap gap-1">
                    {reviewers.map((r) => (
                      <span key={r.uid} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[var(--color-text)]">{r.name || r.email}<button onClick={() => setReviewers((p) => p.filter((x) => x.uid !== r.uid))}><X className="w-3 h-3" /></button></span>
                    ))}
                  </div>
                  <input value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="Search people…" className={`${inp} w-full`} />
                  {userHits.length > 0 && (
                    <div className="rounded-lg border border-[var(--color-border)] max-h-32 overflow-y-auto">
                      {userHits.filter((u) => !reviewers.some((r) => r.uid === u.uid)).map((u) => (
                        <button key={u.uid} onClick={() => { setReviewers((p) => [...p, u]); setUserQuery(""); setUserHits([]); }} className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-2)] flex items-center gap-1.5"><Plus className="w-3 h-3" /> {u.name || u.email}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)]">{describeInterval({ enabled, intervalCount: count, intervalUnit: unit })} · a document overrides this with its own cycle.</div>
              </>
            )}
            <div className="flex justify-between gap-2 pt-2 border-t border-[var(--color-border)]">
              <button onClick={() => void remove()} disabled={busy || !existing} className="px-3 py-2 rounded-lg text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-40">Remove cycle</button>
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
