"use client";

// ReviewSection — the review-cycle panel shown in the document Inspector.
// Everyone sees the pill + effective policy; doc controllers (canManage) can
// "Mark reviewed / certify current" and set/clear the cycle on this document,
// its folder, or the whole library.

import React, { useCallback, useEffect, useState } from "react";
import { CalendarClock, CheckCircle2, Pencil, Loader2, X, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { searchOrgUsers, type OrgUser } from "@/lib/notifications";
import {
  resolveEffectivePolicy, describeInterval, markReviewed, setReviewPolicy,
} from "@/lib/reviewCycles";
import { setOwner, effectiveOwnerForDocument, type EffectiveOwner } from "@/lib/ownership";
import ReviewPill from "@/components/documents/ReviewPill";
import { User2 } from "lucide-react";
import type { DocumentRecord, ReviewPolicy } from "@/types/schema";

type Level = "document" | "collection" | "library";

interface ReviewEvent { id: string; action: string; outcome: string | null; note: string | null; next_review_date: string | null; performed_by_name: string | null; performed_at: string }

export default function ReviewSection({ doc, orgId, canManage, uid, userName, onChanged }: {
  doc: DocumentRecord;
  orgId: string;
  canManage: boolean;
  uid: string | null;
  userName?: string | null;
  onChanged?: () => void;
}) {
  const [docPol, setDocPol] = useState<ReviewPolicy | null>(null);
  const [folderPol, setFolderPol] = useState<ReviewPolicy | null>(null);
  const [libPol, setLibPol] = useState<ReviewPolicy | null>(null);
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"view" | "review" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const [effOwner, setEffOwner] = useState<EffectiveOwner | null>(null);
  const [ownerPicking, setOwnerPicking] = useState(false);
  const [ownerQuery, setOwnerQuery] = useState("");
  const [ownerHits, setOwnerHits] = useState<OrgUser[]>([]);

  const load = useCallback(async () => {
    if (!doc.id) return;
    setLoading(true);
    try {
      const [{ data: d }, { data: l }, evt] = await Promise.all([
        supabase.from("documents").select("review_policy, collection_id, library_id, next_review_date, last_reviewed_at, last_reviewed_by, owner_user_id, owner_name").eq("id", doc.id).maybeSingle(),
        supabase.from("libraries").select("review_policy").eq("id", doc.libraryId).maybeSingle(),
        supabase.from("document_review_events").select("id, action, outcome, note, next_review_date, performed_by_name, performed_at").eq("document_id", doc.id).order("performed_at", { ascending: false }).limit(3),
      ]);
      setDocPol((d?.review_policy as ReviewPolicy) ?? null);
      setLibPol((l?.review_policy as ReviewPolicy) ?? null);
      const colId = (d?.collection_id as string | null) ?? doc.collectionId ?? null;
      if (colId) {
        const { data: c } = await supabase.from("collections").select("review_policy").eq("id", colId).maybeSingle();
        setFolderPol((c?.review_policy as ReviewPolicy) ?? null);
      } else setFolderPol(null);
      setNextDate((d?.next_review_date as string | null) ?? doc.nextReviewDate ?? null);
      setLastReviewed((d?.last_reviewed_at as string | null) ?? null);
      setEvents((evt.data as ReviewEvent[]) ?? []);
      setEffOwner(await effectiveOwnerForDocument({
        ownerUserId: (d?.owner_user_id as string | null) ?? doc.ownerUserId ?? null,
        ownerName: (d?.owner_name as string | null) ?? doc.ownerName ?? null,
        collectionId: colId, libraryId: doc.libraryId,
      }));
    } finally { setLoading(false); }
  }, [doc.id, doc.libraryId, doc.collectionId, doc.nextReviewDate, doc.ownerUserId, doc.ownerName]);

  const [nextDate, setNextDate] = useState<string | null>(doc.nextReviewDate ?? null);
  const [lastReviewed, setLastReviewed] = useState<string | null>(null);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!ownerPicking || !ownerQuery.trim()) { setOwnerHits([]); return; }
    let alive = true;
    searchOrgUsers(orgId, ownerQuery.trim()).then((u) => { if (alive) setOwnerHits(u); }).catch(() => {});
    return () => { alive = false; };
  }, [ownerPicking, ownerQuery, orgId]);

  const assignOwner = async (u: OrgUser | null) => {
    if (!doc.id) return;
    setBusy(true);
    try {
      await setOwner({ level: "document", id: doc.id, orgId, userId: u?.uid ?? null, name: u?.name ?? null, actorId: uid ?? "", actorName: userName });
      setOwnerPicking(false); setOwnerQuery(""); setOwnerHits([]);
      await load(); onChanged?.();
    } finally { setBusy(false); }
  };

  const eff = resolveEffectivePolicy(docPol, folderPol, libPol);
  const source: Level | null = docPol ? "document" : folderPol ? "collection" : libPol ? "library" : null;
  const leadDays = eff?.leadDays ?? 30;

  // ── Mark reviewed ──
  const [outcome, setOutcome] = useState<"no_change" | "minor" | "needs_revision">("no_change");
  const [note, setNote] = useState("");
  const doReview = async () => {
    if (!uid || !doc.id) return;
    setBusy(true);
    try {
      await markReviewed({ orgId, documentId: doc.id, userId: uid, userName, outcome, note: note.trim() || undefined });
      setMode("view"); setNote("");
      await load(); onChanged?.();
    } finally { setBusy(false); }
  };

  // ── Edit cycle ──
  const [scope, setScope] = useState<Level>("document");
  const [enabled, setEnabled] = useState(true);
  const [count, setCount] = useState(12);
  const [unit, setUnit] = useState<"days" | "months" | "years">("months");
  const [lead, setLead] = useState(30);
  const [reviewers, setReviewers] = useState<OrgUser[]>([]);
  const [userQuery, setUserQuery] = useState("");
  const [userHits, setUserHits] = useState<OrgUser[]>([]);

  const beginEdit = () => {
    const src = scope === "document" ? docPol : scope === "collection" ? folderPol : libPol;
    setEnabled(src?.enabled ?? true);
    setCount(src?.intervalCount ?? 12);
    setUnit(src?.intervalUnit ?? "months");
    setLead(src?.leadDays ?? 30);
    setReviewers([]);
    setMode("edit");
  };
  useEffect(() => {
    if (mode !== "edit") return;
    const src = scope === "document" ? docPol : scope === "collection" ? folderPol : libPol;
    setEnabled(src?.enabled ?? true);
    setCount(src?.intervalCount ?? 12);
    setUnit(src?.intervalUnit ?? "months");
    setLead(src?.leadDays ?? 30);
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!userQuery.trim()) { setUserHits([]); return; }
    let alive = true;
    searchOrgUsers(orgId, userQuery.trim()).then((u) => { if (alive) setUserHits(u); }).catch(() => {});
    return () => { alive = false; };
  }, [userQuery, orgId]);

  const saveEdit = async () => {
    if (!doc.id) return;
    const targetId = scope === "document" ? doc.id : scope === "collection" ? doc.collectionId : doc.libraryId;
    if (!targetId) { return; }
    setBusy(true);
    try {
      const policy: ReviewPolicy = {
        enabled,
        intervalCount: enabled ? count : undefined,
        intervalUnit: enabled ? unit : undefined,
        leadDays: lead,
        reviewerIds: reviewers.map((r) => r.uid),
      };
      await setReviewPolicy({ level: scope, id: targetId, orgId, policy, userId: uid, userName });
      setMode("view");
      await load(); onChanged?.();
    } finally { setBusy(false); }
  };
  const clearPolicy = async () => {
    if (!doc.id) return;
    const targetId = scope === "document" ? doc.id : scope === "collection" ? doc.collectionId : doc.libraryId;
    if (!targetId) return;
    setBusy(true);
    try {
      await setReviewPolicy({ level: scope, id: targetId, orgId, policy: null, userId: uid, userName });
      setMode("view"); await load(); onChanged?.();
    } finally { setBusy(false); }
  };

  const inp = "text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 outline-none focus:border-[var(--color-accent)]";

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <CalendarClock className="w-4 h-4 text-[var(--color-text-muted)]" />
        <span className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">Review cycle</span>
        <div className="ml-auto"><ReviewPill nextReviewDate={nextDate} leadDays={leadDays} /></div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
      ) : (
        <>
          {/* Owner */}
          <div className="flex items-center gap-2 pb-2 border-b border-[var(--color-border)]">
            <User2 className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
            <span className="text-[11px] text-[var(--color-text)] min-w-0 truncate">
              Owner: <span className="font-bold">{effOwner?.name || (effOwner?.userId ? "Assigned" : "Admin / DocCtrl")}</span>
              {effOwner?.source && effOwner.source !== "document" && <span className="text-[var(--color-text-muted)]"> · from {effOwner.source === "collection" ? "folder" : "library"}</span>}
            </span>
            {canManage && !ownerPicking && (
              <button onClick={() => setOwnerPicking(true)} className="ml-auto shrink-0 text-[10px] font-bold text-[var(--color-accent)] hover:underline">{effOwner?.userId ? "Reassign" : "Assign"}</button>
            )}
          </div>
          {canManage && ownerPicking && (
            <div className="space-y-1 pb-2 border-b border-[var(--color-border)]">
              <input value={ownerQuery} onChange={(e) => setOwnerQuery(e.target.value)} placeholder="Search people…" className={`${inp} w-full`} autoFocus />
              {ownerHits.length > 0 && (
                <div className="rounded-lg border border-[var(--color-border)] max-h-28 overflow-y-auto">
                  {ownerHits.map((u) => (
                    <button key={u.uid} onClick={() => void assignOwner(u)} className="w-full text-left px-2 py-1 text-[11px] hover:bg-[var(--color-surface-2)] flex items-center gap-1.5"><Plus className="w-3 h-3" /> {u.name || u.email}</button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                {effOwner?.source === "document" && <button onClick={() => void assignOwner(null)} className="text-[10px] text-red-600 hover:underline">Clear (inherit)</button>}
                <button onClick={() => { setOwnerPicking(false); setOwnerQuery(""); }} className="text-[10px] text-[var(--color-text-muted)] hover:underline ml-auto">Cancel</button>
              </div>
            </div>
          )}

          <div className="text-[11px] text-[var(--color-text)]">
            {eff
              ? <>{describeInterval(eff)} · <span className="text-[var(--color-text-muted)]">from {source === "document" ? "this document" : source === "collection" ? "this folder" : "the library"}</span></>
              : <span className="text-[var(--color-text-muted)]">No review cycle set.</span>}
          </div>
          {lastReviewed && (
            <div className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-emerald-600" /> Last reviewed {lastReviewed.slice(0, 10)}</div>
          )}

          {canManage && mode === "view" && (
            <div className="flex items-center gap-2 pt-1">
              {eff && (
                <button onClick={() => setMode("review")} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold"><CheckCircle2 className="w-3.5 h-3.5" /> Mark reviewed</button>
              )}
              <button onClick={beginEdit} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[11px] font-bold hover:bg-[var(--color-surface-2)]"><Pencil className="w-3.5 h-3.5" /> {eff ? "Edit cycle" : "Set cycle"}</button>
            </div>
          )}

          {/* Mark reviewed form */}
          {canManage && mode === "review" && (
            <div className="space-y-2 pt-1 border-t border-[var(--color-border)]">
              <div className="text-[10px] font-bold text-[var(--color-text-muted)]">Certify this document is current &amp; accurate (resets the clock, no new revision).</div>
              <select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} className={`${inp} w-full`}>
                <option value="no_change">No change — still valid</option>
                <option value="minor">Minor edit made</option>
                <option value="needs_revision">Needs revision (flag for drafting)</option>
              </select>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={`${inp} w-full`} />
              <div className="flex justify-end gap-2">
                <button onClick={() => setMode("view")} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-[var(--color-text-muted)]">Cancel</button>
                <button onClick={() => void doReview()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold disabled:opacity-50">{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Confirm review</button>
              </div>
            </div>
          )}

          {/* Edit cycle form */}
          {canManage && mode === "edit" && (
            <div className="space-y-2 pt-1 border-t border-[var(--color-border)]">
              <div className="flex gap-1">
                {(["document", "collection", "library"] as Level[]).map((lv) => (
                  <button key={lv} onClick={() => setScope(lv)} disabled={lv === "collection" && !doc.collectionId}
                    className={`flex-1 px-2 py-1 rounded-lg text-[10px] font-bold disabled:opacity-30 ${scope === lv ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
                    {lv === "document" ? "This doc" : lv === "collection" ? "This folder" : "Library"}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-[11px] text-[var(--color-text)]">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Require periodic review
              </label>
              {enabled && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[var(--color-text-muted)]">Every</span>
                    <input type="number" min={1} value={count} onChange={(e) => setCount(Math.max(1, parseInt(e.target.value) || 1))} className={`${inp} w-16`} />
                    <select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} className={inp}>
                      <option value="days">days</option><option value="months">months</option><option value="years">years</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[var(--color-text-muted)]">Warn</span>
                    <input type="number" min={0} value={lead} onChange={(e) => setLead(Math.max(0, parseInt(e.target.value) || 0))} className={`${inp} w-16`} />
                    <span className="text-[11px] text-[var(--color-text-muted)]">days before due</span>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[10px] font-bold text-[var(--color-text-muted)]">Notify (besides Admin/DocCtrl)</div>
                    <div className="flex flex-wrap gap-1">
                      {reviewers.map((r) => (
                        <span key={r.uid} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[var(--color-text)]">{r.name || r.email}<button onClick={() => setReviewers((p) => p.filter((x) => x.uid !== r.uid))}><X className="w-3 h-3" /></button></span>
                      ))}
                    </div>
                    <input value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="Search people…" className={`${inp} w-full`} />
                    {userHits.length > 0 && (
                      <div className="rounded-lg border border-[var(--color-border)] max-h-28 overflow-y-auto">
                        {userHits.filter((u) => !reviewers.some((r) => r.uid === u.uid)).map((u) => (
                          <button key={u.uid} onClick={() => { setReviewers((p) => [...p, u]); setUserQuery(""); setUserHits([]); }} className="w-full text-left px-2 py-1 text-[11px] hover:bg-[var(--color-surface-2)] flex items-center gap-1.5"><Plus className="w-3 h-3" /> {u.name || u.email}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
              <div className="flex justify-between gap-2 pt-1">
                <button onClick={() => void clearPolicy()} disabled={busy} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-50">Remove cycle</button>
                <div className="flex gap-2">
                  <button onClick={() => setMode("view")} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-[var(--color-text-muted)]">Cancel</button>
                  <button onClick={() => void saveEdit()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white text-[11px] font-bold disabled:opacity-50">{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save</button>
                </div>
              </div>
            </div>
          )}

          {events.length > 0 && mode === "view" && (
            <div className="pt-1 border-t border-[var(--color-border)] space-y-1">
              {events.map((e) => (
                <div key={e.id} className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1.5">
                  <span className="font-bold text-[var(--color-text)] capitalize">{e.action}</span>
                  <span>{e.performed_at.slice(0, 10)}</span>
                  {e.performed_by_name && <span>· {e.performed_by_name}</span>}
                  {e.outcome && e.outcome !== "no_change" && <span>· {e.outcome.replace("_", " ")}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
