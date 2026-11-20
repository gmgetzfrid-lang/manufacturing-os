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
  Clock, AlertTriangle, Check, X,
  ChevronRight, Lock, TrendingUp,
} from "lucide-react";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import { plural } from "@/components/admin/band";
import { Spinner } from "@/components/ui/Spinner";
import { useRole } from "@/components/providers/RoleContext";
import {
  listActiveHoldsForOrg, getHoldMetrics, releaseHold,
  type HoldMetrics,
} from "@/lib/holds";
import type { DocumentHold } from "@/types/schema";
import { supabase } from "@/lib/supabase";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { useDraft } from "@/hooks/useDraft";

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
  // The release note autosaves on this device while it's being written.
  useDraft<string>(releasingId ? `hold-release:${releasingId}` : null, releaseDraft, setReleaseDraft, (v) => !v.trim());

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
    if (!uid) { setError("Your sign-in is still loading. Try again in a moment."); return; }
    setBusy(true);
    setError(null);
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
    } catch (e) { setError(`Couldn't release the hold: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  const totalByReason = useMemo(() => metrics?.activeByReason ?? [], [metrics]);
  const maxBarCount = useMemo(() => totalByReason.reduce((m, r) => Math.max(m, r.count), 1), [totalByReason]);

  if (!activeOrgId) return (
    <PageShell width="work">
      <PageHero kicker="Document control · Holds" title="Holds" sub="No active organization." overlap={false} />
    </PageShell>
  );

  // The answer: how much is blocked, and for how long.
  const onHold = metrics?.activeCount ?? holds.length;
  const answer = loading && !metrics ? "Holds"
    : error && holds.length === 0 ? "Couldn't load the holds."
    : onHold === 0 ? "Nothing on hold."
    : `${plural(onHold, "document")} on hold.`;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Document control · Holds"
        title={answer}
        sub={metrics ? (
          <span className="inline-flex items-center gap-x-2 gap-y-1 flex-wrap">
            {onHold > 0 && <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Longest <b className={metrics.longestActiveDays > 14 ? "text-rose-200" : "text-white"}>{metrics.longestActiveDays} days</b> ·</span>}
            <span className="inline-flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" /> closed in {metrics.avgClosedDurationDays} days on average (90 days)</span>
            <span>· last 7 days: {metrics.openedLast7Days} opened, {metrics.releasedLast7Days} released</span>
          </span>
        ) : "Blocked documents, oldest first."}
      >
        <div className="[&>div]:mb-0">
          <ViewTabs tabs={DOCUMENT_VIEWS} variant="dark" />
        </div>
      </PageHero>

      <PageBody>
      {/* Active queue */}
      {loading ? (
        <Card>
          <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)] py-6 justify-center">
            <Spinner size="xs" /> Loading the holds…
          </div>
        </Card>
      ) : holds.length === 0 ? (
        <Card className="text-center py-10">
          {error ? (
            <p role="alert" className="text-[14px] text-red-700 dark:text-red-400 flex items-center justify-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
              {!busy && <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>}
            </p>
          ) : (
            <>
              <div className="text-[14px] font-bold text-emerald-700 dark:text-emerald-400">Every document is free to move.</div>
              <div className="mt-1 text-[14px] text-[var(--color-text-muted)] max-w-md mx-auto">
                A hold is placed from the document&apos;s side panel, for example while waiting on sign-off, vendor data or a field check.
              </div>
            </>
          )}
        </Card>
      ) : (
        <Card pad={false} className="overflow-hidden" label={<span className="inline-flex items-center gap-2"><Lock className="w-3.5 h-3.5" /> On hold, oldest first</span>}>
          {error && (
            <p role="alert" className="px-4 sm:px-5 pb-3 flex items-center gap-2 text-[13px] text-red-700 dark:text-red-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
              {!busy && <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>}
            </p>
          )}
          <div className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
            {holds.map((h) => {
              const meta = docs.get(h.documentId);
              const ageDays = Math.max(0, Math.round((Date.now() - new Date(h.openedAt as string).getTime()) / 86400_000));
              const expectedMs = h.expectedReleaseAt ? new Date(h.expectedReleaseAt as string).getTime() : null;
              const lateDays = expectedMs && Date.now() > expectedMs ? Math.round((Date.now() - expectedMs) / 86400_000) : 0;
              return (
                <div key={h.id} className="px-4 sm:px-5 py-3 hover:bg-[var(--color-surface-2)] transition-colors flex items-start gap-3">
                  <div className="shrink-0 w-1 h-10 rounded-full bg-amber-500 mt-1" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {meta ? (
                        <Link href={`/documents/${meta.libraryId}?doc=${h.documentId}`} className="text-[14px] font-bold text-[var(--color-text)] hover:underline inline-flex items-center gap-1">
                          {meta.documentNumber && <span className="font-mono">{meta.documentNumber}</span>}
                          {meta.title && <span className="text-[var(--color-text)]">{meta.documentNumber ? "· " : ""}{meta.title}</span>}
                          <ChevronRight className="w-3 h-3" />
                        </Link>
                      ) : (
                        <span className="text-sm font-mono text-[var(--color-text-muted)]">(document)</span>
                      )}
                      <span className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">{h.reason}</span>
                    </div>
                    <div className="mt-1 text-[12px] text-[var(--color-text-muted)] flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-0.5">
                        <Clock className="w-3 h-3" /> {ageDays === 0 ? "today" : `${ageDays}d`}
                        {lateDays > 0 && <span className="ml-1 font-bold text-red-700 dark:text-red-400">(+{lateDays}d late)</span>}
                      </span>
                      {h.openedByName && <span>opened by {h.openedByName}</span>}
                    </div>
                    {h.notes && <div className="mt-1 text-[13px] text-[var(--color-text)] whitespace-pre-wrap">{h.notes}</div>}
                    {releasingId === h.id && (
                      <div className="mt-2 flex items-center gap-1.5">
                        <input
                          value={releaseDraft}
                          onChange={(e) => setReleaseDraft(e.target.value)}
                          placeholder="How it was resolved (optional)"
                          aria-label="How it was resolved"
                          onKeyDown={(e) => { if (e.key === "Enter" && !busy) void onRelease(h.id!); }}
                          className="flex-1 min-w-0 h-9 text-[13px] border border-[var(--color-border-strong)] rounded-lg px-2.5 bg-[var(--color-surface)] text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-ring)]"
                          autoFocus
                        />
                        <button type="button" onClick={() => onRelease(h.id!)} disabled={busy} className="inline-flex items-center gap-1 h-9 px-3 rounded-lg text-[13px] font-bold bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] disabled:opacity-40 transition-colors">
                          <Check className="w-3 h-3" /> Release
                        </button>
                        <button onClick={() => { setReleasingId(null); setReleaseDraft(""); }} disabled={busy} aria-label="Cancel release" className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  {canRelease && releasingId !== h.id && (
                    <button
                      onClick={() => { setReleasingId(h.id!); setReleaseDraft(""); }}
                      type="button"
                      className="shrink-0 h-8 text-[12px] font-semibold text-[var(--color-text)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] px-2.5 rounded-lg inline-flex items-center gap-1 transition-colors"
                    >
                      <Check className="w-3 h-3" /> Release
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* By reason */}
      {totalByReason.length > 0 && (
        <Card label="By reason">
          <div className="space-y-2">
            {totalByReason.map((r) => (
              <div key={r.reason} className="flex items-center gap-3 text-[13px]">
                <div className="w-44 shrink-0 truncate text-[var(--color-text)]">{r.reason}</div>
                <div className="flex-1 bg-[var(--color-surface-2)] rounded-full h-2.5 overflow-hidden">
                  <div
                    className="h-full bg-amber-500"
                    style={{ width: `${(r.count / maxBarCount) * 100}%` }}
                  />
                </div>
                <div className="w-8 text-right tabular-nums font-bold text-[var(--color-text)]">{r.count}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
      </PageBody>
    </PageShell>
  );
}

