"use client";

// Close-out › How the job did › Manpower: who was on the job shift by
// shift as counted at the meetings, against each company's bid; man-hours,
// safety exposure, cost at the bid rates, and each work order's man-hours
// (estimated). Counts carried from an earlier shift are said so.

import React, { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { fmtInTz } from "@/lib/scheduleTz";
import { shiftLabel, type ShiftRow } from "@/lib/phaseReport";
import type { ShiftRecord } from "@/lib/shiftRecord";
import type { StepLook } from "@/lib/lookBack";
import { companyOf, estimateByWorkOrder, manpowerSummary, shiftCounts, type ManpowerSettings, type ShiftCount, type WorkSpan } from "@/lib/manpower";
import LoadingBlock from "@/components/ui/LoadingBlock";
import HelpTooltip from "@/components/ui/HelpTooltip";

// Each company keeps its color (fixed order, by man-hours); past eight, Other.
// The crew colors (globals.css --crew-*), validated apart, as on the schedules.
const SWATCH = [
  "bg-[var(--crew-1)]", "bg-[var(--crew-2)]", "bg-[var(--crew-3)]", "bg-[var(--crew-4)]",
  "bg-[var(--crew-5)]", "bg-[var(--crew-6)]", "bg-[var(--crew-7)]", "bg-[var(--crew-8)]",
];
const OTHER = "bg-[var(--viz-neutral)]";
const OTHER_NAME = "Other";

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const money = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The work as built, less its holds: when each step was really going. */
function workSpans(steps: StepLook[], now: number): Array<WorkSpan & { step: StepLook }> {
  const out: Array<WorkSpan & { step: StepLook }> = [];
  for (const x of steps) {
    if (!x.started || !x.crew) continue;
    const end = x.done ? x.af : Math.min(x.af, now);
    let parts: Array<[number, number]> = [[x.as, end]];
    for (const h of x.holdSpans) parts = parts.flatMap(([a, b]) => (h.to <= a || h.from >= b ? [[a, b]] : [[a, h.from], [h.to, b]]).filter(([p, q]) => q > p) as Array<[number, number]>);
    for (const [a, b] of parts) if (b > a) out.push({ wo: x.id, label: x.name, crew: x.crew, start: a, end: b, step: x });
  }
  return out;
}

export default function ManpowerLook({ shifts, records, settings, steps, tz, now }: {
  shifts: ShiftRow[]; records: Map<string, ShiftRecord> | null; settings: ManpowerSettings | null; steps: StepLook[]; tz: string; now: number;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [allWos, setAllWos] = useState(false);
  const data = useMemo(() => {
    if (!records) return null;
    const windows = shifts.filter((r) => r.start <= now).map((r) => ({ kind: r.kind, dayKey: r.dayKey, start: r.start, end: Math.min(r.end, now) }));
    const counts = shiftCounts(records, windows, settings);
    const sum = manpowerSummary(counts, records, settings);
    const spans = workSpans(steps, now);
    const est = estimateByWorkOrder(counts, spans, settings);
    // Each step's estimate, gathered to its work order; added work apart.
    const byStep = new Map(est.orders.map((o) => [o.wo, o.directMH]));
    const wos = new Map<string, { key: string; label: string; mh: number; added: boolean }>();
    let addedMH = 0;
    const stepOf = new Map(steps.map((x) => [x.id, x]));
    for (const [id, mh] of byStep) {
      const x = stepOf.get(id);
      if (!x) continue;
      if (x.addedKind) addedMH += mh;
      const key = x.wo || x.task || x.name;
      const w = wos.get(key) ?? { key, label: x.wo ? `WO ${x.wo}${x.task ? ` ${x.task}` : ""}` : x.task || x.name, mh: 0, added: false };
      w.mh += mh;
      if (x.addedKind) w.added = true;
      wos.set(key, w);
    }
    // Direct man-hours per planned hour, per company: finished steps worked
    // wholly on counted shifts only.
    const counted = counts.filter((c) => c.counted);
    const inCounted = (a: number, b: number) => counted.reduce((s, c) => s + Math.max(0, Math.min(b, c.end) - Math.max(a, c.start)), 0);
    const rate = new Map<string, { mh: number; planH: number; steps: number }>();
    for (const x of steps) {
      if (!x.done || !x.crew || !byStep.has(x.id)) continue;
      const mine = spans.filter((s) => s.step.id === x.id);
      const worked = mine.reduce((s, p) => s + (p.end - p.start), 0);
      if (worked <= 0 || mine.reduce((s, p) => s + inCounted(p.start, p.end), 0) < worked * 0.95) continue;
      const planH = (x.bf - x.bs) / 3_600_000;
      if (planH <= 0) continue;
      const co = companyOf(x.crew, settings);
      const r = rate.get(co) ?? { mh: 0, planH: 0, steps: 0 };
      r.mh += byStep.get(x.id) ?? 0; r.planH += planH; r.steps += 1;
      rate.set(co, r);
    }
    const order = sum.companies.map((c) => c.company);
    return { counts, sum, est, wos: [...wos.values()].sort((a, b) => b.mh - a.mh), addedMH: Math.round(addedMH * 10) / 10, rate, order };
  }, [records, shifts, settings, steps, now]);

  // Still reading the shift records: say so, never a blank space.
  if (!data) return <LoadingBlock what="the head counts" rows={2} />;
  const { counts, sum, est, wos, addedMH, rate, order } = data;
  const head = "text-caption font-medium text-[var(--color-text)]";
  if (sum.counted === 0) {
    return (
      <p className="text-body text-[var(--color-text-muted)]">
        <span className="font-medium text-[var(--color-text)]">Manpower: </span>
        no head counts were entered at the shift meetings{shifts.some((r) => r.start <= now) ? "" : " yet"}. Enter each crew&apos;s direct and indirect on Shift › Meeting; they show here shift by shift against the bid.
      </p>
    );
  }

  const colorOf = (co: string) => { const i = order.indexOf(co); return i >= 0 && i < SWATCH.length ? SWATCH[i] : OTHER; };
  const shown = order.slice(0, SWATCH.length);
  const hasOther = order.length > SWATCH.length;
  const bidOf = (c: ShiftCount) => {
    let t = 0, any = false;
    for (const x of c.companies) {
      const b = settings?.bids?.[x.company]?.[c.kind];
      if (b && (b.direct != null || b.indirect != null)) { t += (b.direct ?? 0) + (b.indirect ?? 0); any = true; }
    }
    return any ? t : null;
  };
  const onSite = (c: ShiftCount) => c.companies.reduce((a, x) => a + x.total, 0);
  const max = Math.max(1, ...counts.map((c) => Math.max(onSite(c), bidOf(c) ?? 0)));
  const anyBid = counts.some((c) => bidOf(c) != null);
  const labelOf = (c: Pick<ShiftCount, "key" | "kind">) => shiftLabel({ dayKey: c.key.split(":")[0], kind: c.kind } as ShiftRow);
  const time = (t: number) => fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true });

  // Rows: each counted shift; runs of shifts with no count, one row.
  type Row = { kind: "count"; c: ShiftCount } | { kind: "gap"; from: ShiftCount; to: ShiftCount; n: number };
  const rows: Row[] = [];
  for (const c of counts) {
    const last = rows.at(-1);
    if (c.counted) rows.push({ kind: "count", c });
    else if (last?.kind === "gap") { last.to = c; last.n += 1; }
    else rows.push({ kind: "gap", from: c, to: c, n: 1 });
  }
  const costRates = sum.companies.some((x) => x.cost != null);
  const ir = sum.directMH + sum.indirectMH > 0 ? Math.round((sum.indirectMH / (sum.directMH + sum.indirectMH)) * 100) : null;

  return (
    <div className="space-y-3">
      {/* The answer: the man-hours counted, big; the rest small on one line. */}
      <div>
        <div className={head}>Manpower, as counted at the shift meetings</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-display text-section font-bold tabular-nums whitespace-nowrap text-[var(--color-text)]">{n0(sum.totalMH)}</span>
          <span className="text-body text-[var(--color-text)]">man-hours, counted on {sum.counted} of {plural(sum.shifts, "shift")}{sum.carried > 0 ? `; ${sum.carried} of those carried over from the shift before, not checked` : ""}.</span>
          <HelpTooltip>Man-hours are the count times the shift&apos;s hours: who left early or came late isn&apos;t seen.</HelpTooltip>
        </div>
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-caption text-[var(--color-text-muted)]">
          <Fact k="Split" v={sum.directMH + sum.indirectMH > 0 ? `${n0(sum.directMH)} direct · ${n0(sum.indirectMH)} indirect${sum.unsplitMH > 0 ? ` · ${n0(sum.unsplitMH)} not split` : ""}` : "not split direct / indirect"} />
          <Fact k="Peak on site" v={sum.peak ? `${sum.peak.n}, ${labelOf({ key: sum.peak.key, kind: sum.peak.key.endsWith(":night") ? "night" : "day" })}` : "-"} />
          <Fact k="Recordable rate" v={sum.recordableRate != null ? sum.recordableRate.toFixed(2) : "-"} s={`${plural(sum.incidents.recordable, "recordable")} on counted hours`} />
          {costRates
            ? <Fact k="At bid rates" v={money(sum.cost ?? 0)} s="counted man-hours x rate" />
            : <Fact k="Indirect" v={ir != null ? `${ir}%` : "-"} s="of split man-hours" />}
        </dl>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-[var(--color-text-muted)]">
          {shown.map((co) => <span key={co} className="inline-flex items-center gap-1"><span className={`inline-block w-2.5 h-2.5 rounded-sm ${colorOf(co)}`} />{co}</span>)}
          {hasOther && <span className="inline-flex items-center gap-1"><span className={`inline-block w-2.5 h-2.5 rounded-sm ${OTHER}`} />{OTHER_NAME}</span>}
          {anyBid && <span className="inline-flex items-center gap-1"><span className="inline-block w-0.5 h-3 bg-[var(--color-text)]" />bid</span>}
          <span>Tap a shift for its counts.</span>
        </div>
        <div className="mt-1 divide-y divide-[var(--color-border)]/60">
          {rows.map((r) => {
            if (r.kind === "gap") {
              return (
                <div key={r.from.key} className="grid grid-cols-[116px_minmax(0,1fr)] gap-2 py-1 text-caption text-[var(--color-text-muted)]">
                  <span className="pl-1 leading-tight">{labelOf(r.from)}{r.n > 1 && <span className="block">to {labelOf(r.to)}</span>}</span>
                  <span className="italic self-center">{r.n > 1 ? `${r.n} shifts not counted` : "Not counted"}</span>
                </div>
              );
            }
            const c = r.c;
            const total = onSite(c);
            const bid = bidOf(c);
            const isOpen = open === c.key;
            const segs = new Map<string, number>();
            for (const x of c.companies) { const k = shown.includes(x.company) ? x.company : OTHER_NAME; segs.set(k, (segs.get(k) ?? 0) + x.total); }
            return (
              <div key={c.key} className={c.kind === "night" ? "bg-[var(--color-surface-2)]/50" : ""}>
                <button type="button" onClick={() => setOpen(isOpen ? null : c.key)} aria-expanded={isOpen}
                  className="w-full grid grid-cols-[116px_minmax(0,1fr)_auto] gap-2 items-center py-1 text-left text-caption">
                  <span className="text-[var(--color-text)] leading-tight pl-1 inline-flex items-start gap-0.5">
                    <ChevronRight className={`w-3.5 h-3.5 mt-px shrink-0 ui-chevron${(isOpen) ? " rotate-90" : ""}`} />
                    <span>{labelOf(c)}{c.carried && <span className="block text-caption text-[var(--state-held-text)]">carried, not checked</span>}</span>
                  </span>
                  <span className="relative h-3">
                    <span className={`absolute inset-y-0 left-0 flex gap-[2px] ${c.carried ? "opacity-50" : ""}`} style={{ width: `${(total / max) * 100}%` }}>
                      {[...segs].map(([co, v]) => <span key={co} className={`h-full first:rounded-l last:rounded-r ${co === OTHER_NAME ? OTHER : colorOf(co)}`} style={{ flexGrow: v, flexBasis: 0 }} />)}
                    </span>
                    {bid != null && <span className="absolute -inset-y-0.5 w-0.5 bg-[var(--color-text)]" style={{ left: `calc(${Math.min(100, (bid / max) * 100)}% - 1px)` }} />}
                  </span>
                  <span className="text-right tabular-nums text-[var(--color-text-muted)] pr-1">
                    <b className="text-[var(--color-text)]">{total}</b>{bid != null && <> / {bid} bid</>}
                  </span>
                </button>
                {isOpen && (
                  <ul className="pb-1.5 pl-6 pr-1 space-y-0.5 text-caption text-[var(--color-text-muted)]">
                    {c.companies.map((x) => {
                      const b = settings?.bids?.[x.company]?.[c.kind];
                      return (
                        <li key={x.company}>
                          <b className="text-[var(--color-text)]">{x.company}</b> {x.total}{x.split ? ` (${x.direct} direct, ${x.indirect} indirect)` : ", not split"}
                          {b && (b.direct != null || b.indirect != null) ? `; bid ${b.direct ?? 0} direct, ${b.indirect ?? 0} indirect` : ""}
                        </li>
                      );
                    })}
                    {c.carried && <li className="text-[var(--state-held-text)]">Carried from an earlier {c.kind} shift; nobody changed or confirmed it at this meeting.</li>}
                    <li>{time(c.start)} to {time(c.end)}, {Math.round(c.hours * 10) / 10} h</li>
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className={`${head} flex items-center gap-1.5`}>By company{rate.size > 0 && <HelpTooltip>Man-hours per planned hour compare companies and jobs, not a crew rate: the schedule&apos;s hours are clock time, not man-hours. Only finished steps worked wholly on counted shifts are in it.</HelpTooltip>}</div>
        <ul className="mt-1 divide-y divide-[var(--color-border)]/60">
          {sum.companies.map((x) => {
            const r = rate.get(x.company);
            const rateSet = settings?.bids?.[x.company]?.rate;
            return (
              <li key={x.company} className="py-1.5 text-caption leading-snug">
                <div>
                  <span className={`inline-block w-2.5 h-2.5 rounded-sm mr-1.5 ${colorOf(x.company)}`} />
                  <b className="text-[var(--color-text)]">{x.company}</b>
                  <span className="text-[var(--color-text-muted)]"> peak {x.peak}, average {x.average} on site, {plural(x.shifts, "shift")}{x.carried ? ` (${x.carried} carried)` : ""}</span>
                </div>
                <div className="text-[var(--color-text-muted)]">
                  {n0(x.totalMH)} man-hours
                  {x.directMH + x.indirectMH > 0 && <>: {n0(x.directMH)} direct, {n0(x.indirectMH)} indirect{x.indirectShare != null ? ` (${Math.round(x.indirectShare * 100)}% indirect)` : ""}</>}
                  {x.unsplitMH > 0 && <>, {n0(x.unsplitMH)} not split</>}
                  {x.bidMH != null && x.bidMH > 0 && <>; {x.onBidMH < x.totalMH ? <>{n0(x.onBidMH)} on bid shifts, </> : ""}{Math.round((x.onBidMH / x.bidMH) * 100)}% of the bid&apos;s {n0(x.bidMH)}</>}
                </div>
                {x.shortShifts > 0 && <div className="text-[var(--state-held-text)]">Short of its bid direct hands on {plural(x.shortShifts, "checked shift")}</div>}
                {r && r.mh > 0 && <div className="text-[var(--color-text-muted)]">{(Math.round((r.mh / r.planH) * 10) / 10).toLocaleString("en-US")} direct man-hours per planned hour of work, on {plural(r.steps, "finished step")}</div>}
                {x.cost != null && rateSet != null && <div className="text-[var(--color-text-muted)]">{money(x.cost)} at {money(rateSet)} / man-hour: hold it against the invoices</div>}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="text-caption leading-snug">
        <div className={head}>Safety exposure</div>
        <div className="text-[var(--color-text-muted)]">
          {n0(sum.totalMH)} counted man-hours. {plural(sum.incidents.recordable, "recordable")}, {sum.incidents.firstAid} first aid, {sum.incidents.nearMiss} near miss{sum.incidents.nearMiss === 1 ? "" : "es"} written on these shifts.
          {sum.recordableRate != null && <> Recordable rate {sum.recordableRate.toFixed(2)} per 200,000 man-hours, on counted hours only.</>}
        </div>
      </div>

      {wos.length > 0 && (
        <div>
          <div className={`${head} flex items-center gap-1.5`}>Man-hours by work order (estimated) <HelpTooltip>Nobody counts by job: each shift, a company&apos;s direct hours are shared over its work going then, by hours going (holds left out).</HelpTooltip></div>
          {(addedMH > 0 || est.untiedMH > 0) && (
            <p className="mt-0.5 text-caption leading-snug text-[var(--color-text-muted)]">
              {addedMH > 0 && <>Added work took about {n0(addedMH)} direct man-hours.</>}
              {est.untiedMH > 0 && <>{addedMH > 0 ? " " : ""}{n0(est.untiedMH)} direct man-hours were counted with none of that company&apos;s work going.</>}
            </p>
          )}
          <ul className="mt-1 divide-y divide-[var(--color-border)]/60 text-caption">
            {(allWos ? wos : wos.slice(0, 10)).map((w) => (
              <li key={w.key} className="flex items-baseline gap-2 py-1">
                <span className="flex-1 min-w-0 break-words text-[var(--color-text)]">{w.label}{w.added && <span className="ml-1.5 text-caption font-medium text-[var(--state-held-text)]">added</span>}</span>
                <span className="tabular-nums text-[var(--color-text-muted)]">{n0(w.mh)} h</span>
              </li>
            ))}
          </ul>
          {wos.length > 10 && <button type="button" onClick={() => setAllWos(!allWos)} className="mt-1 text-body text-[var(--color-accent-text)] hover:underline">{allWos ? "Show the top 10" : `Show all ${wos.length}`}</button>}
        </div>
      )}
    </div>
  );
}

/** One small fact on the line under the answer: "Peak on site 45, Thu day". */
function Fact({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div className="min-w-0">
      <dt className="inline">{k} </dt>
      <dd className="inline font-medium tabular-nums text-[var(--color-text)]">{v}</dd>
      {s && <dd className="inline"> ({s})</dd>}
    </div>
  );
}
