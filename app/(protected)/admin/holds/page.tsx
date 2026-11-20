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
import { Check } from "lucide-react";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody } from "@/components/ui/PageHero";
import { tbl, sheet, fieldBox, btnPrimary, btnQuiet, btnRow, StatusTag, RowEdge, Section, Problem } from "@/components/admin/kit";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { plural } from "@/components/admin/band";
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
        sub={metrics ? `Oldest first. Holds are released in ${metrics.avgClosedDurationDays} days on average.` : "Oldest first."}
        facts={metrics ? [
          { label: "Longest", value: `${metrics.longestActiveDays}d`, tone: metrics.longestActiveDays > 14 ? "bad" : undefined },
          { label: "Opened, 7d", value: metrics.openedLast7Days },
          { label: "Released, 7d", value: metrics.releasedLast7Days },
        ] : undefined}
      >
        <div className="[&>div]:mb-0">
          <ViewTabs tabs={DOCUMENT_VIEWS} variant="dark" />
        </div>
      </PageHero>

      <PageBody>
      {loading ? (
        <LoadingBlock what="the holds" />
      ) : holds.length === 0 ? (
        error ? (
          <Problem retry={busy ? undefined : () => void refresh()}>{error}</Problem>
        ) : (
          <div className={`${sheet} px-5 py-8 text-center`}>
            <StatusTag tone="good">Every document is free to move.</StatusTag>
            <p className="mt-1 text-[15px] text-[var(--color-text-muted)]">Holds are placed from a document&apos;s side panel, for example while waiting on sign-off or vendor data.</p>
          </div>
        )
      ) : (
        <Section label="On hold">
          {error && <Problem className="mb-3" retry={busy ? undefined : () => void refresh()}>{error}</Problem>}
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={`${tbl.thead} max-sm:hidden`}>
                <tr>
                  <th className={tbl.th}>Document</th>
                  <th className={tbl.th}>Reason</th>
                  <th className={`${tbl.th} text-right`}>On hold</th>
                  <th className={`${tbl.th} max-lg:hidden`}>Opened by</th>
                  <th className={`${tbl.th} max-xl:hidden`}>Note</th>
                  {canRelease && <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Release</span></th>}
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {holds.map((h) => {
                  const meta = docs.get(h.documentId);
                  const ageDays = Math.max(0, Math.round((Date.now() - new Date(h.openedAt as string).getTime()) / 86400_000));
                  const expectedMs = h.expectedReleaseAt ? new Date(h.expectedReleaseAt as string).getTime() : null;
                  const lateDays = expectedMs && Date.now() > expectedMs ? Math.round((Date.now() - expectedMs) / 86400_000) : 0;
                  return (
                    <React.Fragment key={h.id}>
                      <tr className={`${tbl.tr} max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:py-1`}>
                        <td className={`${tbl.td} relative max-sm:pb-0`}>
                          <RowEdge tone={lateDays > 0 ? "bad" : "warn"} />
                          {meta ? (
                            <Link href={`/documents/${meta.libraryId}?doc=${h.documentId}`} className="group block min-w-0">
                              {meta.documentNumber && <span className="font-display text-[16px] font-semibold tabular-nums text-[var(--color-text)] group-hover:text-[var(--color-accent-text)]">{meta.documentNumber}</span>}
                              {meta.title && meta.title !== meta.documentNumber && <span className="block text-[14px] text-[var(--color-text-muted)] truncate max-w-[42ch]">{meta.title}</span>}
                            </Link>
                          ) : (
                            <span className="text-[var(--color-text-muted)]">Document not found</span>
                          )}
                        </td>
                        <td className={`${tbl.td} max-sm:col-span-2 max-sm:row-start-2 max-sm:py-1`}>
                          <StatusTag tone="warn">{h.reason}</StatusTag>
                          <span className="sm:hidden ml-2 text-[13px] text-[var(--color-text-muted)]">{ageDays === 0 ? "today" : `${ageDays}d`}{lateDays > 0 && <span className="font-semibold text-[var(--state-overdue)]">, {lateDays}d late</span>}</span>
                        </td>
                        <td className={`${tbl.td} max-sm:hidden text-right whitespace-nowrap`}>
                          <span className="font-display text-[16px] font-semibold tabular-nums">{ageDays === 0 ? "Today" : `${ageDays}d`}</span>
                          {lateDays > 0 && <span className="block text-[13px] font-semibold text-[var(--state-overdue)]">{lateDays}d late</span>}
                        </td>
                        <td className={`${tbl.td} max-lg:hidden text-[var(--color-text-muted)]`}>{h.openedByName ?? ""}</td>
                        <td className={`${tbl.td} max-xl:hidden text-[14px] text-[var(--color-text-muted)] max-w-[32ch]`}><span className="line-clamp-2">{h.notes ?? ""}</span></td>
                        {canRelease && (
                          <td className={`${tbl.td} max-sm:col-start-2 max-sm:row-start-1 text-right`}>
                            {releasingId !== h.id && (
                              <button type="button" onClick={() => { setReleasingId(h.id!); setReleaseDraft(""); }} className={btnRow}>
                                <Check className="w-3.5 h-3.5" /> Release
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                      {releasingId === h.id && (
                        <tr className="bg-[var(--color-surface-2)]">
                          <td colSpan={6} className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                value={releaseDraft}
                                onChange={(e) => setReleaseDraft(e.target.value)}
                                placeholder="How it was resolved (optional)"
                                aria-label="How it was resolved"
                                onKeyDown={(e) => { if (e.key === "Enter" && !busy) void onRelease(h.id!); }}
                                className={`${fieldBox} h-10 text-[15px] flex-1 min-w-[220px]`}
                                autoFocus
                              />
                              <button type="button" onClick={() => onRelease(h.id!)} disabled={busy} className={btnPrimary}>
                                <Check className="w-4 h-4" /> Release hold
                              </button>
                              <button type="button" onClick={() => { setReleasingId(null); setReleaseDraft(""); }} disabled={busy} className={btnQuiet}>
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* By reason */}
      {totalByReason.length > 0 && (
        <Section label="By reason">
          <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
            {totalByReason.map((r) => (
              <div key={r.reason} className="flex items-center gap-4 px-4 py-2.5">
                <div className="w-48 max-sm:w-32 shrink-0 truncate text-[15px] text-[var(--color-text)]">{r.reason}</div>
                <div className="flex-1 bg-[var(--color-surface-2)] rounded-sm h-2.5 overflow-hidden">
                  <div className="h-full bg-[var(--state-held)]" style={{ width: `${(r.count / maxBarCount) * 100}%` }} />
                </div>
                <div className="w-10 text-right font-display text-[16px] font-semibold tabular-nums text-[var(--color-text)]">{r.count}</div>
              </div>
            ))}
          </div>
        </Section>
      )}
      </PageBody>
    </PageShell>
  );
}
