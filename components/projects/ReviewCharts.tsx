"use client";

// ReviewCharts - the pictures the post-event review draws from its own
// numbers (lib/postEventReview, lib/partyLoad):
//
//   - LateHours: where the late hours went. One bar per piece of the late
//     finish (they add up to it), split by the finding that explains it;
//     what is left is gray (not explained by the records).
//   - LoadChart: one party over the event. Ready (open) and being worked as
//     step lines, the number it was planned to work at once as a flat line,
//     and the time its ready jobs waited shaded: amber while it was working
//     its planned number or more (they waited for it), gray while it was
//     working fewer (nobody on them).
//   - LoadStrip: the jobs that waited, on the same time line: when each was
//     ready, how long it waited and why, when it was worked, and what it
//     held up after it.
//   - IdleBars: ready work with nobody on it, by party and step.
//
// Plain SVG and HTML, no chart library: thin marks, hairline grid, text in
// text colors, a legend for every chart with two or more series, a hover
// read-out on every mark. Charts draw at their measured width so text stays
// the same size on a phone and a desktop.

import React, { useEffect, useRef, useState } from "react";
import type { LateBar } from "@/lib/postEventReview";
import type { LoadJob, PartyLoad, HeldJob } from "@/lib/partyLoad";
import { fmtInTz, startOfDay, addDays } from "@/lib/scheduleTz";
import { neutralStep } from "@/components/dashboard/viz";

const WAIT = "var(--viz-cat-2)";
const OPEN = "var(--viz-cat-1)";
const WORK = "var(--color-text)";
const NOBODY = "color-mix(in srgb, var(--color-text) 22%, var(--color-surface))";
const LATER = "color-mix(in srgb, var(--color-text) 9%, var(--color-surface))";
const H = 3_600_000;

/** The width a box has, kept up to date. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((xs) => setW(Math.floor(xs[0].contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
const at = (t: number, tz: string) => `${fmtInTz(t, tz, { weekday: "short", month: "numeric", day: "numeric" })} ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;
const jobName = (j: { name: string; order: string }) => {
  const tag = j.order.split(" - ")[0].trim();
  const name = j.name.replace(/\s*\([^)]*\)/g, "").replace(/[()]/g, "").trim();
  if (/^[A-Z]{1,4}-?\d{1,5}[A-Z]{0,2}\b/.test(name)) return name;
  return /^[A-Z]{1,4}-?\d{1,5}[A-Z]{0,2}$/.test(tag) ? `${tag} ${name}` : `${name} on ${j.order}`;
};

// ─── Where the late hours went ─────────────────────────────────────

export function LateHours({ bars, late, onPick }: { bars: LateBar[]; late: number; onPick: (key: string) => void }) {
  // Each finding keeps its shade wherever it shows, darkest first in the
  // order it first appears (the app draws parts of a whole in steps of
  // graphite; the legend carries the names). Not explained: the track.
  const keys = [...new Set(bars.flatMap((b) => b.segs.map((x) => x.key)).filter((k): k is string => !!k))];
  const color = (k: string | null) => (k == null ? "var(--viz-track)" : neutralStep(Math.min(keys.indexOf(k), 5)));
  const max = Math.max(1, ...bars.map((b) => b.hours));
  const legend = new Map<string, { key: string | null; title: string; hours: number }>();
  for (const b of bars) for (const x of b.segs) { const k = x.key ?? (b.kind === "work" ? "~none" : `~${b.label}`); const e = legend.get(k) ?? { key: x.key, title: x.title, hours: 0 }; e.hours = Math.round((e.hours + x.hours) * 10) / 10; legend.set(k, e); }
  return (
    <div data-late-hours>
      <ul className="space-y-2.5" aria-label={`Where the ${late} h went`}>
        {bars.map((b, i) => (
          <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[150px_minmax(0,1fr)_64px] items-center gap-x-3 gap-y-1">
            <span className="text-[13px] font-semibold text-[var(--color-text)] truncate" title={b.line}>{b.label}</span>
            <span className="sm:order-last text-right text-[13px] font-semibold tabular-nums text-[var(--color-text)]">{b.hours} h</span>
            <div className="col-span-2 sm:col-span-1 flex gap-[2px] h-4" style={{ width: `${Math.max(3, (b.hours / max) * 100)}%` }}>
              {b.segs.map((x, k) => {
                const tip = `${b.label}: ${x.hours} h, ${x.title}`;
                const style = { flexGrow: x.hours, flexBasis: 0, background: color(x.key), borderRadius: 4, minWidth: 3 };
                return x.key ? <button key={k} type="button" onClick={() => onPick(x.key!)} title={tip} aria-label={tip} className="h-full hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]" style={style} />
                  : <span key={k} title={tip} className="h-full" style={style} />;
              })}
            </div>
          </li>
        ))}
      </ul>
      <ul className="mt-3 flex flex-col gap-1.5 text-[13px]" data-late-legend>
        {[...legend.values()].map((e, i) => (
          <li key={i} className="flex items-start gap-2 min-w-0">
            <span aria-hidden className="mt-[5px] w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: color(e.key) }} />
            {e.key ? <button type="button" onClick={() => onPick(e.key!)} className="min-w-0 text-left text-[var(--color-text)] hover:underline">{e.title}</button> : <span className="min-w-0 text-[var(--color-text-muted)]">{e.title}</span>}
            <span className="ml-auto pl-2 shrink-0 tabular-nums font-semibold text-[var(--color-text)]">{e.hours} h</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── One party over the event ──────────────────────────────────────

const PAD_L = 28, PAD_R = 10;
/** The x scale both the chart and the strip under it share. */
function scaleOf(L: PartyLoad, w: number) {
  const from = L.from, to = Math.max(L.to, from + H);
  const span = to - from, plot = Math.max(40, w - PAD_L - PAD_R);
  return { from, to, x: (t: number) => PAD_L + ((Math.min(to, Math.max(from, t)) - from) / span) * plot, pct: (t: number) => ((Math.min(to, Math.max(from, t)) - from) / span) * 100 };
}
/** Local midnights inside the span. */
function midnights(from: number, to: number, tz: string): number[] {
  const out: number[] = [];
  for (let t = addDays(startOfDay(from, tz), 1, tz); t < to; t = addDays(t, 1, tz)) out.push(t);
  return out;
}

export function LoadChart({ load: L, tz }: { load: PartyLoad; tz: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const Hh = 200, PT = 10, PB = 26;
  const sc = scaleOf(L, w);
  const top = Math.max(L.planned.n, ...L.series.map((p) => p.open)) + 1;
  const y = (n: number) => PT + (1 - n / top) * (Hh - PT - PB);
  const pts = L.series;
  // Each value holds from its point to the next.
  const step = (pick: (p: (typeof pts)[number]) => number) => {
    let d = "";
    pts.forEach((p, i) => { const nx = i + 1 < pts.length ? pts[i + 1].t : sc.to; d += `${d ? "L" : "M"}${sc.x(p.t).toFixed(1)},${y(pick(p)).toFixed(1)}L${sc.x(nx).toFixed(1)},${y(pick(p)).toFixed(1)}`; });
    return d;
  };
  const end = sc.to;
  const bands = (() => {
    const out: Array<{ a: number; b: number; kind: "wait" | "nobody" }> = [];
    pts.forEach((p, i) => {
      const kind = p.waiting > 0 ? "wait" : p.nobody > 0 ? "nobody" : null;
      if (!kind) return;
      const b = i + 1 < pts.length ? pts[i + 1].t : end, last = out[out.length - 1];
      if (last && last.kind === kind && last.b === p.t) last.b = b; else out.push({ a: p.t, b, kind });
    });
    return out;
  })();
  const days = midnights(sc.from, sc.to, tz);
  const ticks = Array.from({ length: top + 1 }, (_, i) => i).filter((i) => top <= 8 || i % 2 === 0);
  const cur = hover == null ? null : [...pts].reverse().find((p) => p.t <= hover) ?? pts[0];
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    setHover(sc.from + ((px - PAD_L) / Math.max(1, w - PAD_L - PAD_R)) * (sc.to - sc.from));
  };
  const P = L.party, n = L.planned.n;
  return (
    <div ref={ref} className="relative" data-load-chart={P}>
      {w > 0 && (
        <svg width={w} height={Hh} role="img" aria-label={`${P}: jobs ready and being worked over the event, against ${n} planned at once. Most ready at once: ${L.peak.open}.`}>
          {bands.map((b, i) => <rect key={i} x={sc.x(b.a)} y={PT} width={Math.max(1, sc.x(b.b) - sc.x(b.a))} height={Hh - PT - PB} fill={b.kind === "wait" ? WAIT : NOBODY} opacity={b.kind === "wait" ? 0.16 : 0.45} />)}
          {ticks.map((i) => <g key={i}><line x1={PAD_L} x2={w - PAD_R} y1={y(i)} y2={y(i)} stroke="var(--viz-track)" strokeWidth={1} /><text x={PAD_L - 6} y={y(i) + 3.5} fontSize={11} textAnchor="end" fill="var(--color-text-muted)">{i}</text></g>)}
          {days.map((t) => <line key={t} x1={sc.x(t)} x2={sc.x(t)} y1={PT} y2={Hh - PB} stroke="var(--viz-track)" strokeWidth={1} />)}
          {[sc.from, ...days].map((t, i, all) => {
            const mid = (Math.max(t, sc.from) + Math.min(all[i + 1] ?? sc.to, sc.to)) / 2;
            const wide = sc.x(Math.min(all[i + 1] ?? sc.to, sc.to)) - sc.x(Math.max(t, sc.from));
            return wide >= 34 ? <text key={t} x={sc.x(mid)} y={Hh - 8} fontSize={11} textAnchor="middle" fill="var(--color-text-muted)">{fmtInTz(mid, tz, wide >= 70 ? { weekday: "short", month: "numeric", day: "numeric" } : { month: "numeric", day: "numeric" })}</text> : null;
          })}
          <line x1={PAD_L} x2={w - PAD_R} y1={y(n)} y2={y(n)} stroke="var(--color-text-muted)" strokeWidth={1.5} strokeDasharray="5 4" />
          <path d={step((p) => p.open)} fill="none" stroke={OPEN} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={step((p) => p.working)} fill="none" stroke={WORK} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={sc.x(L.peak.at)} cy={y(L.peak.open)} r={4.5} fill={OPEN} stroke="var(--color-surface)" strokeWidth={2} />
          {cur && hover != null && <line x1={sc.x(hover)} x2={sc.x(hover)} y1={PT} y2={Hh - PB} stroke="var(--color-text-muted)" strokeWidth={1} />}
          <rect x={PAD_L} y={PT} width={Math.max(1, w - PAD_L - PAD_R)} height={Hh - PT - PB} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {cur && hover != null && (
        <div className="pointer-events-none absolute top-1 z-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] shadow-sm text-[var(--color-text)]"
          style={{ left: Math.min(Math.max(0, sc.x(hover) + 10), Math.max(0, w - 210)), width: 200 }}>
          <b className="block">{at(hover, tz)}</b>
          <span className="block">Ready: {cur.open} · Being worked: {cur.working}</span>
          {cur.waiting > 0 && <span className="block">Waiting for {P}: {cur.waiting}</span>}
          {cur.nobody > 0 && <span className="block">Ready, nobody on it: {cur.nobody}</span>}
          <span className="block text-[var(--color-text-muted)]">Planned at once: {n}</span>
        </div>
      )}
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--color-text-muted)]">
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 h-0.5 rounded-full" style={{ background: OPEN }} />Ready (open)</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 h-0.5 rounded-full" style={{ background: WORK }} />Being worked</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 border-t-[1.5px] border-dashed border-[var(--color-text-muted)]" />Planned at once ({n})</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-3 h-3 rounded-[2px]" style={{ background: WAIT, opacity: 0.35 }} />Jobs waiting for {P}</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-3 h-3 rounded-[2px]" style={{ background: NOBODY }} />Ready, nobody on it</li>
      </ul>
    </div>
  );
}

/** The jobs that waited, on the chart's time line, and what each held up. */
export function LoadStrip({ load: L, jobs, held, tz }: { load: PartyLoad; jobs: LoadJob[]; held: HeldJob[]; tz: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const sc = scaleOf(L, w || 600);
  const left = (t: number) => `${sc.pct(t)}%`;
  const width = (a: number, b: number) => `${Math.max(0.6, sc.pct(b) - sc.pct(a))}%`;
  const P = L.party;
  return (
    <div ref={ref} data-load-strip={P}>
      <ul className="space-y-2.5">
        {jobs.map((j) => {
          const after = held.filter((h) => h.by === j.id);
          const tip = `${jobName(j)}: ready ${at(j.ready, tz)}${j.start != null ? `, started ${at(j.start, tz)}` : ""}${j.partyH ? `. Waited for ${P} ${j.partyH} h` : ""}${j.nobodyH ? `. Nobody on it ${j.nobodyH} h` : ""}${j.laterH ? `. Plan said later ${j.laterH} h` : ""}.`;
          return (
            <li key={j.id} className="text-[12px]">
              <div className="flex items-baseline gap-2 min-w-0">
                <b className="min-w-0 truncate text-[var(--color-text)]" title={jobName(j)}>{jobName(j)}</b>
                <span className="ml-auto shrink-0 tabular-nums text-[var(--color-text)]">{j.partyH ? `waited ${j.partyH} h` : ""}{j.partyH && j.nobodyH ? " · " : ""}{j.nobodyH ? `nobody on it ${j.nobodyH} h` : ""}</span>
              </div>
              <div className="relative h-3 mt-1" style={{ marginLeft: PAD_L, marginRight: PAD_R }} title={tip} aria-label={tip} role="img">
                <span className="absolute inset-y-[5px] left-0 right-0 rounded-full" style={{ background: "var(--viz-track)" }} />
                {j.spans.map((x, k) => <span key={k} className="absolute inset-y-0" style={{ left: left(x.from), width: width(x.from, x.to), background: x.kind === "party" ? WAIT : x.kind === "nobody" ? NOBODY : LATER, borderRadius: 3, opacity: x.kind === "party" ? 0.85 : 1 }} />)}
                {j.start != null && <span className="absolute inset-y-0" style={{ left: left(j.start), width: width(j.start, j.finish ?? sc.to), background: WORK, borderRadius: 3 }} />}
              </div>
              {after.length > 0 && <div className="mt-0.5 text-[var(--color-text-muted)]">Held up after it: {after.map((h) => `${jobName(h)} (${h.party}) ${h.hours} h`).join("; ")}</div>}
            </li>
          );
        })}
      </ul>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--color-text-muted)]">
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 h-2 rounded-[2px]" style={{ background: WAIT, opacity: 0.85 }} />Waited for {P}</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 h-2 rounded-[2px]" style={{ background: NOBODY }} />Nobody on it</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 h-2 rounded-[2px]" style={{ background: LATER }} />Ready before its planned start</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 h-2 rounded-[2px]" style={{ background: WORK }} />Started to finished</li>
      </ul>
    </div>
  );
}

/** Ready work with nobody on it, by party and step: one bar each. */
export function IdleBars({ groups }: { groups: Array<{ party: string; step: string; jobs: LoadJob[]; hours: number }> }) {
  const max = Math.max(1, ...groups.map((g) => g.hours));
  return (
    <ul className="space-y-2" data-idle-bars>
      {groups.map((g, i) => (
        <li key={i} title={`${g.party}, ${g.step}: ${g.jobs.length} job${g.jobs.length === 1 ? "" : "s"}, ${g.hours} h`}>
          <div className="flex items-baseline gap-2 text-[12px] min-w-0">
            <span className="min-w-0 truncate text-[var(--color-text)]"><b>{g.party}</b> · {g.step} <span className="text-[var(--color-text-muted)]">({g.jobs.length} job{g.jobs.length === 1 ? "" : "s"})</span></span>
            <span className="ml-auto shrink-0 tabular-nums font-semibold text-[var(--color-text)]">{g.hours} h</span>
          </div>
          <div className="mt-0.5 h-2.5 rounded-[4px]" style={{ width: `${Math.max(2, (g.hours / max) * 100)}%`, background: NOBODY }} />
        </li>
      ))}
    </ul>
  );
}
