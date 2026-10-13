// components/requests/RequestOutcomes.tsx
//
// drafting-flow LEAK-9 / GAP-107 (Round G, DF-P3): "How Requests Ended" on
// /admin/analytics — the only instrument that says whether work is leaving
// the app. Read-only; it draws lib/ticketOutcome.ts summarizeOutcomes().
//
// Fix pass 3 (DEC-29 — a number never claims more than it measured): until
// DF-P9 ships the cancel-category picker, a cancel from the request page
// records no outcome, while an acknowledged close records "completed". A rate
// over the recorded rows alone would then read 0 % by construction. When no
// cancel named a category and some named none, the rate is NOT MEASURED
// ('—', with how many cancels named none); when some did, the rate is shown
// and the cancels that named none are counted next to it, as not in it.

import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { OUTCOME_LABEL, TICKET_OUTCOMES, type OutcomeSummary } from '@/lib/ticketOutcome';

const formatPercent = (val: number) => `${(val * 100).toFixed(1)}%`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function RequestOutcomes({ summary: outcomes }: { summary: OutcomeSummary }) {
  const recorded = outcomes.ended - outcomes.byOutcome.unrecorded;
  const unnamed = outcomes.uncategorizedCancels;
  return (
    <section aria-labelledby="request-outcomes-heading" className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h3 id="request-outcomes-heading" className="font-bold text-[var(--color-text)] flex items-center"><ArrowUpRight className="w-5 h-5 mr-2 text-[var(--color-text-faint)]" /> How Requests Ended <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]" data-testid="outcomes-scope">(all time — not the Request Volume range)</span></h3>
        <p className="text-xs text-[var(--color-text-muted)]" data-testid="leak-rate-line">
          Leak rate (withdrawn or handled outside the app):{' '}
          <span className="font-bold text-[var(--color-text)]" data-testid="leak-rate">{outcomes.leakRate === null ? '—' : formatPercent(outcomes.leakRate)}</span>
          {outcomes.notMeasured
            ? <>{' '}— not measured yet: {plural(unnamed, 'cancel', 'cancels')} named no category, and no cancel named one, so nothing recorded could show a leak</>
            : <>{' '}of {plural(recorded, 'ended request', 'ended requests')} with a recorded outcome{unnamed > 0 ? <>; {plural(unnamed, 'cancel', 'cancels')} named no category and {unnamed === 1 ? 'is' : 'are'} not in this rate</> : null}</>}
        </p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        {[...TICKET_OUTCOMES, 'unrecorded' as const].map((o) => (
          <div key={o} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
            <p className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider">{o === 'unrecorded' ? 'Not recorded' : OUTCOME_LABEL[o]}</p>
            <p className="text-xl font-black text-[var(--color-text)]">{outcomes.byOutcome[o]}</p>
          </div>
        ))}
      </div>
      {outcomes.byType.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
              <th className="py-1 pr-4 font-bold">Request type</th>
              <th className="py-1 pr-4 font-bold">Ended</th>
              <th className="py-1 pr-4 font-bold">Left the app</th>
              <th className="py-1 pr-4 font-bold">Cancels with no category</th>
              <th className="py-1 font-bold">Leak rate</th>
            </tr>
          </thead>
          <tbody>
            {outcomes.byType.map((row) => (
              <tr key={row.requestType} className="border-t border-[var(--color-border)]" data-testid={`outcomes-type-${row.requestType}`}>
                <td className="py-1.5 pr-4 font-medium text-[var(--color-text)]">{row.requestType}</td>
                <td className="py-1.5 pr-4 text-[var(--color-text-muted)]">{row.ended}</td>
                <td className="py-1.5 pr-4 text-[var(--color-text-muted)]">{row.leaked}</td>
                <td className="py-1.5 pr-4 text-[var(--color-text-muted)]" data-testid={`outcomes-type-${row.requestType}-uncategorized`}>{row.uncategorizedCancels}</td>
                <td className="py-1.5 text-[var(--color-text-muted)]">{row.leakRate === null ? '—' : formatPercent(row.leakRate)}{row.notMeasured ? ' (not measured)' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-[var(--color-text-muted)]">&ldquo;Not recorded&rdquo; counts requests that ended before outcomes were recorded, force closes that named none, and cancels that named no category; none of them is in the leak rate. Until the request page asks for a cancel&rsquo;s category, a cancel from it records none, so the leak rate stays unmeasured (&mdash;) wherever no cancel named one, rather than showing 0&nbsp;%. Every request this page loaded counts, whenever it ended — the page loads at most the server&rsquo;s row limit, so a very large workspace&rsquo;s oldest requests may be missing.</p>
    </section>
  );
}
