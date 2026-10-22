// components/requests/ReviewLaneReport.tsx
//
// drafting-flow GAP-101 acceptance 5 (Round G, DF-P19; the integrator's
// ruling (4) under DEC-90): "Review Lanes" on /admin/analytics, beside "How
// Requests Ended". For any period of filing dates: requests by review lane,
// and every like-in-kind declaration with who made it, what it says and the
// request's work / code class — read-only, from what each request already
// records (lib/reviewLaneReport.ts). The CSV is the same report, every cell
// through lib/csvSafe. Nothing here writes.
//
// DF-P19 second fix pass (review major 1): given `loadPeriod`, the panel
// reads EVERY request filed in the chosen period from the server
// (/api/admin/analytics/review-lanes — filtered on created_at and paged past
// the row limit), so the counts hold for any period. While it reads, no
// count is shown; when the read fails it says so and falls back to the
// requests the page loaded, with that load's coverage notice.

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Download, Scale } from 'lucide-react';
import type { OrgDraftingSettings, Ticket } from '@/types/schema';
import { reviewClassOptions } from '@/lib/reviewModel';
import {
  summarizeReviewLanes, reviewLaneReportCsv, reviewLaneCoverage, periodBound, REVIEW_LANES, REVIEW_LANE_LABEL, laneTicketFromRow,
  reviewLanePeriodNotice, type LaneTicket, type ReviewLanePeriod, type ReviewLanePeriodRead,
} from '@/lib/reviewLaneReport';

/** DF-P19 second fix pass: one period, read whole from the server. */
export type ReviewLanePeriodLoader = (period: ReviewLanePeriod) => Promise<ReviewLanePeriodRead>;
/** A finished period read — for the period (`key`) and the loader (the
 *  workspace) it was made with; anything else is still reading. */
type PeriodState =
  | { key: string; loader: ReviewLanePeriodLoader; status: 'ok'; rows: LaneTicket[]; total: number | null; complete: boolean }
  | { key: string; loader: ReviewLanePeriodLoader; status: 'error'; error: string };

/** A class value as the workspace's list names it now (the value itself
 *  when the list no longer has it, or could not be read). */
export function classLabelFor(cfg: unknown, kind: 'workClasses' | 'codeClasses', value: string): string {
  const opt = reviewClassOptions((cfg ?? null) as Partial<OrgDraftingSettings> | null, kind).find((o) => o.value === value);
  return opt ? opt.label : value;
}

/** DF-P19 fix pass (review minor 5): what the panel says about the load —
 *  null when it holds every request of the period. */
export function reviewLaneCoverageNotice(c: ReturnType<typeof reviewLaneCoverage>): string | null {
  if (c.periodComplete) return null;
  if (c.truncated === null) return `Showing the ${c.loaded} newest requests this page loaded; the server did not say how many there are in all, so requests filed before ${c.oldestLoaded ?? 'the oldest one shown'} may be missing from these counts.`;
  return `Showing ${c.loaded} of ${c.total} requests (the newest; the server's row limit cut the rest) — requests filed before ${c.oldestLoaded ?? 'the oldest one shown'} are not counted. Narrow the period to start after ${c.oldestLoaded ?? 'that date'} for complete counts.`;
}

export default function ReviewLaneReport({ tickets, ticketsTotal = null, draftingConfig, loadPeriod }: { tickets: readonly Ticket[]; ticketsTotal?: number | null; draftingConfig?: unknown; loadPeriod?: ReviewLanePeriodLoader }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const pFrom = periodBound(from);
  const pTo = periodBound(to);
  const periodKey = `${pFrom ?? ''}|${pTo ?? ''}`;
  const [periodRead, setPeriodRead] = useState<PeriodState | null>(null);
  useEffect(() => {
    if (!loadPeriod) return;
    let alive = true;
    loadPeriod({ from: pFrom, to: pTo })
      .then((r) => { if (alive) setPeriodRead({ key: periodKey, loader: loadPeriod, status: 'ok', rows: r.rows.map(laneTicketFromRow), total: r.total, complete: r.complete }); })
      .catch((e: unknown) => { if (alive) setPeriodRead({ key: periodKey, loader: loadPeriod, status: 'error', error: (e as Error)?.message || 'the read failed' }); });
    return () => { alive = false; };
  }, [loadPeriod, periodKey, pFrom, pTo]);
  const current = loadPeriod && periodRead && periodRead.key === periodKey && periodRead.loader === loadPeriod ? periodRead : null;
  const reading = !!loadPeriod && current === null;
  const whole = current && current.status === 'ok' ? current : null;
  // Whole period from the server; otherwise (no loader, or the read failed)
  // the requests the page loaded.
  const source = (whole ? whole.rows : tickets) as readonly LaneTicket[];
  const summary = useMemo(
    () => summarizeReviewLanes(source, { from: pFrom, to: pTo }),
    [source, pFrom, pTo],
  );
  const coverage = useMemo(
    () => reviewLaneCoverage(tickets as readonly LaneTicket[], ticketsTotal, { from: pFrom, to: pTo }),
    [tickets, ticketsTotal, pFrom, pTo],
  );
  const coverageNotice = whole
    ? reviewLanePeriodNotice({ loaded: whole.rows.length, total: whole.total, complete: whole.complete })
    : reviewLaneCoverageNotice(coverage);
  const label = (kind: 'workClasses' | 'codeClasses', v: string) => classLabelFor(draftingConfig, kind, v);
  const download = () => {
    const csv = reviewLaneReportCsv(summary, label);
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `review-lanes_${summary.period.from ?? 'start'}_${summary.period.to ?? 'today'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const periodText = summary.period.from || summary.period.to
    ? `filed ${summary.period.from ? `from ${summary.period.from}` : ''}${summary.period.from && summary.period.to ? ' ' : ''}${summary.period.to ? `to ${summary.period.to}` : ''}`
    : 'all time';
  return (
    <section aria-labelledby="review-lanes-heading" data-testid="review-lanes" className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm p-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <h3 id="review-lanes-heading" className="font-bold text-[var(--color-text)] flex items-center">
          <Scale className="w-5 h-5 mr-2 text-[var(--color-text-faint)]" /> Review Lanes
          <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]" data-testid="review-lanes-scope">({periodText})</span>
        </h3>
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-0.5 text-[var(--color-text-muted)]">Filed from
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)]" />
          </label>
          <label className="flex flex-col gap-0.5 text-[var(--color-text-muted)]">to
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)]" />
          </label>
          <button type="button" onClick={download} disabled={reading} className="disabled:opacity-40 inline-flex items-center px-3 py-1.5 rounded-lg border border-[var(--color-border)] font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <Download className="w-3.5 h-3.5 mr-1.5 text-[var(--color-text-faint)]" /> Export CSV
          </button>
        </div>
      </div>
      {reading && (
        <p role="status" data-testid="review-lanes-reading" className="mb-3 text-xs text-[var(--color-text-muted)]">Counting every request filed in this period…</p>
      )}
      {current && current.status === 'error' && (
        <p role="alert" data-testid="review-lanes-read-error" className="mb-3 rounded-lg border border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-800 dark:text-rose-200">The period could not be read from the server ({current.error}). The counts below are from the requests this page loaded.</p>
      )}
      {!reading && coverageNotice && (
        <p role="status" data-testid="review-lanes-truncated" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">{coverageNotice}</p>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {REVIEW_LANES.map((l) => (
          <div key={l} data-testid={`review-lane-${l}`} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
            <p className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider">{REVIEW_LANE_LABEL[l]}</p>
            <p className="text-xl font-black text-[var(--color-text)]">{reading ? '…' : summary.lanes[l]}</p>
          </div>
        ))}
      </div>
      <p className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider mb-2">Like-in-kind declarations ({reading ? '…' : summary.declarations.length})</p>
      {reading ? null : summary.declarations.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)] italic" data-testid="review-lanes-no-declarations">No request filed in this period was declared like-in-kind.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="review-lanes-declarations">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
                <th className="py-1 pr-3 font-bold">Request</th>
                <th className="py-1 pr-3 font-bold">Declared</th>
                <th className="py-1 pr-3 font-bold">By</th>
                <th className="py-1 pr-3 font-bold">Statement</th>
                <th className="py-1 pr-3 font-bold">Work class</th>
                <th className="py-1 pr-3 font-bold">Code class</th>
                <th className="py-1 font-bold">Lane now</th>
              </tr>
            </thead>
            <tbody>
              {summary.declarations.map((d) => (
                <tr key={d.id} className="border-t border-[var(--color-border)] align-top">
                  <td className="py-1.5 pr-3 text-[var(--color-text)]"><span className="font-mono text-xs">{d.ticketId}</span> {d.title}</td>
                  <td className="py-1.5 pr-3 text-[var(--color-text-muted)] whitespace-nowrap">{d.declaredAt ? d.declaredAt.slice(0, 10) : '—'}</td>
                  <td className="py-1.5 pr-3 text-[var(--color-text-muted)]">{d.declaredByName ?? (d.declaredBy ? `${d.declaredBy.slice(0, 8)}…` : '—')}</td>
                  <td className="py-1.5 pr-3 text-[var(--color-text)] whitespace-pre-wrap">{d.statement}</td>
                  <td className="py-1.5 pr-3 text-[var(--color-text-muted)]">{d.workClass ? label('workClasses', d.workClass) : '—'}</td>
                  <td className="py-1.5 pr-3 text-[var(--color-text-muted)]">{d.codeClass ? label('codeClasses', d.codeClass) : '—'}</td>
                  <td className="py-1.5 text-[var(--color-text-muted)]" data-overridden={d.overridden ? 'true' : 'false'}>{d.overridden ? 'Engineering review required since (declaration overridden)' : REVIEW_LANE_LABEL[d.lane]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-[var(--color-text-muted)]">
        Lanes are what each request records, decided as the approval gate decides them: engineering review required (including a request declared like-in-kind and raised to engineering review since — it is listed below as overridden); declared like-in-kind by its requester at filing; filed before the review model and left to the role-based gate; or not recorded (this workspace&rsquo;s database does not have the review-model columns yet). The lane counts add up to the requests filed in the period ({summary.total}). Every declaration filed in the period is listed, whatever its lane now. The declaration&rsquo;s e-signature is checked when the request is approved, not here. A period is a range of filing dates (UTC); every request filed in it is read from the server, page by page past its row limit (a period holding more than one read returns is said above).
      </p>
    </section>
  );
}
