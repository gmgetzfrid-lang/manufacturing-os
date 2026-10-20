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
//
// drafting-flow DF-P16 — roles-and-permissions GAP-13 acceptance 2 (the
// integrator's ruling under DEC-90, fail-safe, no regression): under each
// outcome, a count per reason the workspace keeps (DF-P14's list, read by
// `metadata.outcome_reason.id`, named as the list names it NOW — or, for a
// reason since removed, in the words stored when the request ended), plus
// "No reason recorded". The outcome-level numbers above are unchanged and the
// rows under each outcome add up to its number exactly (`reasonBreakdown`).
// A workspace that keeps no reasons and recorded none sees exactly today's
// panel (no `reasons` prop is rendered as nothing).

import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { OUTCOME_LABEL, TICKET_OUTCOMES, isTicketOutcome, type OutcomeSummary, type TicketOutcome } from '@/lib/ticketOutcome';
import type { OutcomeReason } from '@/lib/ticketOutcomeReasons';

const formatPercent = (val: number) => `${(val * 100).toFixed(1)}%`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** An ended request as the breakdown reads it. */
export interface ReasonRow {
  status?: string | null;
  outcome?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** One line under an outcome. `reasonId` null = "No reason recorded". */
export interface ReasonLine {
  reasonId: string | null;
  label: string;
  count: number;
  /** A reason recorded on requests but no longer in the workspace's list —
   *  named in the words stored when the request ended. */
  removed: boolean;
  /** Under "Not recorded": the outcome the reason was recorded with. */
  recordedAs?: string;
}

export interface ReasonBreakdown {
  /** Only the outcomes that have a reason configured or recorded, in the
   *  panel's order; each one's lines add up to its outcome-level number. */
  groups: Array<{ outcome: TicketOutcome | 'unrecorded'; label: string; total: number; lines: ReasonLine[] }>;
  /** The workspace's reason list could not be read: every reason is named
   *  in its stored words, and configured reasons nothing ended with are not
   *  listed. */
  listUnread: boolean;
}

/** The recorded reason on an ended request (`metadata.outcome_reason`, as
 *  the workflow route writes it), or null. */
function recordedReason(meta: Record<string, unknown> | null | undefined): { id: string; label: string; category: string } | null {
  const r = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).outcome_reason : null;
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) return null;
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : id;
  return { id, label, category: typeof o.category === 'string' ? o.category : '' };
}

/**
 * GAP-13 acceptance 2 (DF-P16): the per-reason breakdown of how requests
 * ended. Counted from the same rows and the same rule as `summarizeOutcomes`
 * (an ended request = CLOSED or CANCELED; its outcome = `tickets.outcome` when
 * it is one of the five, else "Not recorded"), so the lines under an outcome
 * always add up to the outcome-level number. Under each outcome: every reason
 * the workspace keeps under it (its current words; 0 when nothing ended with
 * it), every other reason recorded with it (the list's current words for an
 * id it still holds, else the stored words, marked removed), and "No reason
 * recorded". Returns null — the panel exactly as before — when the workspace
 * keeps no reasons and no ended request recorded one.
 */
export function reasonBreakdown(rows: readonly ReasonRow[], configured: readonly OutcomeReason[], listUnread = false): ReasonBreakdown | null {
  const byId = new Map(configured.map((r) => [r.id, r] as const));
  type Acc = { total: number; none: number; lines: Map<string, ReasonLine> };
  const acc = new Map<TicketOutcome | 'unrecorded', Acc>();
  const get = (o: TicketOutcome | 'unrecorded'): Acc => {
    let a = acc.get(o);
    if (!a) { a = { total: 0, none: 0, lines: new Map() }; acc.set(o, a); }
    return a;
  };
  let anyRecorded = false;
  for (const row of rows) {
    if (row.status !== 'CLOSED' && row.status !== 'CANCELED') continue;
    const outcome: TicketOutcome | 'unrecorded' = isTicketOutcome(row.outcome) ? row.outcome : 'unrecorded';
    const a = get(outcome);
    a.total += 1;
    const rec = recordedReason(row.metadata);
    if (!rec) { a.none += 1; continue; }
    anyRecorded = true;
    const kept = byId.get(rec.id);
    const line = a.lines.get(rec.id) ?? {
      reasonId: rec.id,
      label: kept ? kept.label : rec.label,
      count: 0,
      removed: !kept && !listUnread,
      ...(outcome === 'unrecorded' && isTicketOutcome(rec.category) ? { recordedAs: OUTCOME_LABEL[rec.category] } : {}),
    };
    line.count += 1;
    a.lines.set(rec.id, line);
  }
  if (configured.length === 0 && !anyRecorded) return null;
  const groups: ReasonBreakdown['groups'] = [];
  for (const outcome of [...TICKET_OUTCOMES, 'unrecorded' as const]) {
    const a = acc.get(outcome) ?? { total: 0, none: 0, lines: new Map<string, ReasonLine>() };
    const keptHere = outcome === 'unrecorded' ? [] : configured.filter((r) => r.category === outcome);
    if (keptHere.length === 0 && a.lines.size === 0) continue;
    const lines: ReasonLine[] = keptHere.map((r) => a.lines.get(r.id) ?? { reasonId: r.id, label: r.label, count: 0, removed: false });
    for (const [id, line] of a.lines) if (!keptHere.some((r) => r.id === id)) lines.push(line);
    lines.push({ reasonId: null, label: 'No reason recorded', count: a.none, removed: false });
    groups.push({ outcome, label: outcome === 'unrecorded' ? 'Not recorded' : OUTCOME_LABEL[outcome], total: a.total, lines });
  }
  return { groups, listUnread };
}

export default function RequestOutcomes({ summary: outcomes, reasons = null }: { summary: OutcomeSummary; reasons?: ReasonBreakdown | null }) {
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
      {reasons && reasons.groups.length > 0 && (
        <div data-testid="outcome-reasons" className="mb-4">
          <p className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider mb-2">Why they ended — this workspace&rsquo;s reasons</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {reasons.groups.map((g) => (
              <div key={g.outcome} data-testid={`outcome-reasons-${g.outcome}`} className="rounded-lg border border-[var(--color-border)] p-3">
                <p className="text-xs font-bold text-[var(--color-text)] mb-1">{g.label} <span className="font-normal text-[var(--color-text-muted)]">({g.total})</span></p>
                <table className="w-full text-sm">
                  <tbody>
                    {g.lines.map((l) => (
                      <tr key={l.reasonId ?? '(none)'} data-testid={`outcome-reason-${g.outcome}-${l.reasonId ?? 'none'}`}>
                        <td className={`py-0.5 pr-3 ${l.reasonId ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)] italic'}`}>
                          {l.label}
                          {l.removed ? <span className="text-xs text-[var(--color-text-faint)]"> (no longer in the list)</span> : null}
                          {l.recordedAs ? <span className="text-xs text-[var(--color-text-faint)]"> (recorded as {l.recordedAs})</span> : null}
                        </td>
                        <td className="py-0.5 text-right font-bold text-[var(--color-text)]" data-testid={`outcome-reason-${g.outcome}-${l.reasonId ?? 'none'}-count`}>{l.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="outcome-reasons-note">
            Each outcome&rsquo;s lines add up to its number above. A reason is named as the list names it now; one since removed keeps the words it had when the request ended. &ldquo;No reason recorded&rdquo; counts requests that ended before the list existed, under an outcome with no reasons of its own, or without one.
            {reasons.listUnread ? <> The workspace&rsquo;s reason list could not be read, so every reason is named in the words it was recorded with, and reasons nothing ended with are not listed.</> : null}
          </p>
        </div>
      )}
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
