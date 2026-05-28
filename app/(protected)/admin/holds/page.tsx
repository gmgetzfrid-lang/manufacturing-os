"use client";

// /admin/holds — Org-wide hold queue + bottleneck metrics.
//
// Top: KPI strip (active count, longest open, avg closed duration,
// 7-day open/release counts).
// Middle: active-by-reason breakdown.
// Bottom: list of active holds, oldest first (biggest blockers up
// top). Each row links to the affected document's inspector.
//
// Admin-class roles only — even though RLS would let any org member
// read, only the controllers act on these. Read-only for the rest;
// they can still see what's blocked but can't release.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertOctagon, Loader2, Clock, AlertTriangle, Check, X,
  ChevronRight, Lock, TrendingUp,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  listActiveHoldsForOrg, getHoldMetrics, releaseHold,
  type HoldMetrics,
} from "@/lib/holds";
import type { DocumentHold } from "@/types/schema";
import { supabase } from "@/lib/supabase";

const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);

interface DocMeta {
  documentNumber: string | null;
  title: string | null;
  libraryId: string;
}

export default function HoldsPage() {
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const canRelease = !!activeRole && ADMIN_ROLES.has(activeRole);

  const [holds, setHolds] = useState<DocumentHold[]>([]);
  const [docs, setDocs] = useState<Map<string, DocMeta>>(new Map());
  const [metrics, setMetrics] = useState<HoldMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [releaseDraft, setReleaseDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const [list, m] = await Promise.all([
        listActiveHoldsForOrg(activeOrgId, { limit: 500 }),
        getHoldMetrics(activeOrgId),
      ]);
      setHolds(list);
      setMetrics(m);

      // Hydrate document metadata for the rows. One IN query.
      const docIds = Array.from(new Set(list.map((h) => h.documentId)));
      if (docIds.length > 0) {
        const { data } = await supabase
          .from("documents")
          .select("id, document_number, title, name, library_id")
          .in("id", docIds);
        const map = new Map<string, DocMeta>();
        for (const row of (data as Array<{ id: string; document_number: string | null; title: string | null; name: string | null; library_id: string }>) ?? []) {
          map.set(row.id, { documentNumber: row.document_number, title: row.title || row.name, libraryId: row.library_id });
        }
        setDocs(map);
      } else {
        setDocs(new Map());
      }
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onRelease = async (holdId: string) => {
    if (!uid) return;
    setBusy(true);
    try {
      await releaseHold({
        holdId, releasedBy: uid,
        releasedByName: userEmail ?? undefined,
        releasedByEmail: userEmail ?? undefined,
        releasedByRole: activeRole ?? undefined,
        releasedReason: releaseDraft.trim() || undefined,
      });
      setReleasingId(null);
      setReleaseDraft("");
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const totalByReason = useMemo(() => metrics?.activeByReason ?? [], [metrics]);
  const maxBarCount = useMemo(() => totalByReason.reduce((m, r) => Math.max(m, r.count), 1), [totalByReason]);

  if (!activeOrgId) return <div className="p-6 text-sm text-slate-500">No active organization.</div>;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-5">
      <div>
        <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
          <AlertOctagon className="w-5 h-5 text-amber-600" /> Hold Queue
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          Documents currently blocked. Oldest first. Click a row to open the document; release from there or here.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="Active" value={metrics?.activeCount ?? 0} tone="amber" icon={<Lock className="w-3.5 h-3.5" />} />
        <Kpi label="Longest open" value={`${metrics?.longestActiveDays ?? 0}d`} tone="red" icon={<Clock className="w-3.5 h-3.5" />} />
        <Kpi label="Avg closed (90d)" value={`${metrics?.avgClosedDurationDays ?? 0}d`} tone="slate" icon={<TrendingUp className="w-3.5 h-3.5" />} />
        <Kpi label="Opened (7d)" value={metrics?.openedLast7Days ?? 0} tone="amber" />
        <Kpi label="Released (7d)" value={metrics?.releasedLast7Days ?? 0} tone="emerald" />
      </div>

      {/* By reason */}
      {totalByReason.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest mb-3">By reason</div>
          <div className="space-y-1.5">
            {totalByReason.map((r) => (
              <div key={r.reason} className="flex items-center gap-3 text-xs">
                <div className="w-44 shrink-0 truncate text-slate-800">{r.reason}</div>
                <div className="flex-1 bg-slate-100 rounded-full h-3 overflow-hidden">
                  <div
                    className="h-full bg-amber-500"
                    style={{ width: `${(r.count / maxBarCount) * 100}%` }}
                  />
                </div>
                <div className="w-8 text-right font-mono font-bold text-slate-700">{r.count}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active queue */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500 py-8 justify-center">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading hold queue…
        </div>
      ) : holds.length === 0 ? (
        <div className="text-sm text-slate-500 py-12 text-center border border-dashed border-slate-300 rounded-xl px-6 space-y-2">
          <div className="font-bold text-slate-700">No active holds.</div>
          <div className="text-xs text-slate-500 max-w-md mx-auto">
            Holds appear here when a document is blocked — waiting on engineering signoff, vendor data, field verification, or client review.
            Place a hold from the document inspector. Duration tracks automatically; metrics show the queue&apos;s bottlenecks at a glance.
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="divide-y divide-slate-100">
            {holds.map((h) => {
              const meta = docs.get(h.documentId);
              const ageDays = Math.max(0, Math.round((Date.now() - new Date(h.openedAt as string).getTime()) / 86400_000));
              const expectedMs = h.expectedReleaseAt ? new Date(h.expectedReleaseAt as string).getTime() : null;
              const lateDays = expectedMs && Date.now() > expectedMs ? Math.round((Date.now() - expectedMs) / 86400_000) : 0;
              return (
                <div key={h.id} className="px-4 py-3 hover:bg-slate-50/60 flex items-start gap-3">
                  <div className="shrink-0 w-1 h-10 rounded-full bg-amber-500 mt-1" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {meta ? (
                        <Link href={`/documents/${meta.libraryId}`} className="text-sm font-bold text-slate-900 hover:text-blue-700 inline-flex items-center gap-1">
                          {meta.documentNumber && <span className="font-mono">{meta.documentNumber}</span>}
                          {meta.title && <span className="text-slate-700">— {meta.title}</span>}
                          <ChevronRight className="w-3 h-3" />
                        </Link>
                      ) : (
                        <span className="text-sm font-mono text-slate-500">(document)</span>
                      )}
                      <span className="text-[10px] font-bold text-amber-800 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded">{h.reason}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-0.5">
                        <Clock className="w-3 h-3" /> {ageDays === 0 ? "today" : `${ageDays}d`}
                        {lateDays > 0 && <span className="ml-1 font-bold text-red-700">(+{lateDays}d late)</span>}
                      </span>
                      {h.openedByName && <span>opened by {h.openedByName}</span>}
                    </div>
                    {h.notes && <div className="mt-1 text-[11px] text-slate-700 whitespace-pre-wrap">{h.notes}</div>}
                    {releasingId === h.id && (
                      <div className="mt-2 flex items-center gap-1.5">
                        <input
                          value={releaseDraft}
                          onChange={(e) => setReleaseDraft(e.target.value)}
                          placeholder="Resolution (optional)"
                          className="flex-1 text-[11px] border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                          autoFocus
                        />
                        <button onClick={() => onRelease(h.id!)} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40">
                          <Check className="w-3 h-3" /> Release
                        </button>
                        <button onClick={() => { setReleasingId(null); setReleaseDraft(""); }} disabled={busy} className="p-1 rounded text-slate-500 hover:bg-slate-100">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  {canRelease && releasingId !== h.id && (
                    <button
                      onClick={() => { setReleasingId(h.id!); setReleaseDraft(""); }}
                      className="shrink-0 text-[10px] font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2 py-1 rounded inline-flex items-center gap-1"
                    >
                      <Check className="w-3 h-3" /> Release
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone, icon }: { label: string; value: string | number; tone: "amber" | "red" | "slate" | "emerald"; icon?: React.ReactNode }) {
  const toneClass =
    tone === "amber" ? "border-amber-200 bg-amber-50 text-amber-900"
    : tone === "red" ? "border-red-200 bg-red-50 text-red-900"
    : tone === "emerald" ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : "border-slate-200 bg-slate-50 text-slate-800";
  return (
    <div className={`border ${toneClass} rounded-xl px-3 py-2`}>
      <div className="text-[10px] font-bold uppercase tracking-widest opacity-70 flex items-center gap-1">{icon}{label}</div>
      <div className="text-xl font-black mt-0.5">{value}</div>
    </div>
  );
}
