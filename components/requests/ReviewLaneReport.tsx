// components/requests/ReviewLaneReport.tsx
//
// drafting-flow GAP-101 acceptance 5 (Round G, DF-P19; the integrator's
// ruling (4) under DEC-90): "Review Lanes" on /admin/analytics, beside "How
// Requests Ended". For any period of filing dates: requests by review lane,
// and every like-in-kind declaration with who made it, what it says and the
// request's work / code class — read-only, from what each request already
// records (lib/reviewLaneReport.ts). The CSV is the same report, every cell
// through lib/csvSafe. Nothing here writes.

'use client';

import React, { useMemo, useState } from 'react';
import { Download, Scale } from 'lucide-react';
import type { OrgDraftingSettings, Ticket } from '@/types/schema';
import { reviewClassOptions } from '@/lib/reviewModel';
import {
  summarizeReviewLanes, reviewLaneReportCsv, periodBound, REVIEW_LANES, REVIEW_LANE_LABEL, type LaneTicket,
} from '@/lib/reviewLaneReport';

/** A class value as the workspace's list names it now (the value itself
 *  when the list no longer has it, or could not be read). */
export function classLabelFor(cfg: unknown, kind: 'workClasses' | 'codeClasses', value: string): string {
  const opt = reviewClassOptions((cfg ?? null) as Partial<OrgDraftingSettings> | null, kind).find((o) => o.value === value);
  return opt ? opt.label : value;
}

export default function ReviewLaneReport({ tickets, draftingConfig }: { tickets: readonly Ticket[]; draftingConfig?: unknown }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const summary = useMemo(
    () => summarizeReviewLanes(tickets as readonly LaneTicket[], { from: periodBound(from), to: periodBound(to) }),
    [tickets, from, to],
  );
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
          <button type="button" onClick={download} className="inline-flex items-center px-3 py-1.5 rounded-lg border border-[var(--color-border)] font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <Download className="w-3.5 h-3.5 mr-1.5 text-[var(--color-text-faint)]" /> Export CSV
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {REVIEW_LANES.map((l) => (
          <div key={l} data-testid={`review-lane-${l}`} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
            <p className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider">{REVIEW_LANE_LABEL[l]}</p>
            <p className="text-xl font-black text-[var(--color-text)]">{summary.lanes[l]}</p>
          </div>
        ))}
      </div>
      <p className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider mb-2">Like-in-kind declarations ({summary.declarations.length})</p>
      {summary.declarations.length === 0 ? (
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
                <th className="py-1 font-bold">Code class</th>
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
                  <td className="py-1.5 text-[var(--color-text-muted)]">{d.codeClass ? label('codeClasses', d.codeClass) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-[var(--color-text-muted)]">
        Lanes are what each request records: declared like-in-kind by its requester at filing; engineering review required; filed before the review model and left to the role-based gate; or not recorded (this workspace&rsquo;s database does not have the review-model columns yet). The lane counts add up to the requests filed in the period ({summary.total}). The declaration&rsquo;s e-signature is checked when the request is approved, not here. A period is a range of filing dates (UTC). Every request this page loaded counts — the page loads at most the server&rsquo;s row limit, so a very large workspace&rsquo;s oldest requests may be missing.
      </p>
    </section>
  );
}
