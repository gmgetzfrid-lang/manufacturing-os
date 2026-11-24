"use client";

// ReviewCharts - the pictures the post-event review draws from its own
// numbers (lib/postEventReview, lib/partyLoad):
//
//   - LateHours: where the late hours went. One row per piece of the late
//     finish (they add up to it): its name, its hours and the cause in
//     words on the row, then its bar, split by the finding that explains
//     it; what the records don't explain is hatched.
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
// Plain SVG and HTML, no chart library: every chart starts at zero; one
// series in the accent (the one the review is about), the rest in grays;
// lines named where they end instead of in a legend (a legend only for
// shaded areas, and on a phone where there's no room at the ends); the
// highest point said on the chart; a hover read-out on every mark. Charts
// draw at their measured width so text stays the same size on a phone and
// a desktop. Waiting is the app's waiting color (amber), as everywhere.

import React, { useEffect, useRef, useState } from "react";
import type { Finding, LateBar } from "@/lib/postEventReview";
import type { LoadJob, PartyLoad, HeldJob } from "@/lib/partyLoad";
import { fmtInTz, startOfDay, addDays } from "@/lib/scheduleTz";

const WAIT = "var(--state-held)";
const OPEN = "var(--color-main)";
const WORK = "var(--color-text-muted)";
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

/** The finding that explains the most hours: the one accent. */
const LEAD = "var(--color-main)";
/** Every other piece: one gray that reads on a sheet (3:1, both themes). */
const PIECE = "var(--color-border-control)";
/** What the records don't explain: the same gray, hatched, with its edge. */
const UNEXPLAINED: React.CSSProperties = { background: `repeating-linear-gradient(135deg, ${PIECE} 0 3px, var(--color-surface) 3px 6px)`, boxShadow: `inset 0 0 0 1px ${PIECE}` };
type Seg = LateBar["segs"][number];

/** Why a piece went, in the record's own words. A finding written on the
 *  job is headed with the job it was written on ("E-12 - Transmix Feed/
 *  Trans. Diesel Exchanger No. 2"); when what was written there names
 *  another work order (E-17), that piece goes to it, and its heading reads
 *  as the wrong work order's name on E-17's bar. So a note written on the
 *  job says what it says (its first sentence) and where it was written. A
 *  headline (from the records, a person's own, or a heading a person
 *  changed) is said as it is. */
export function causeWords(seg: Seg, f: Pick<Finding, "source" | "title" | "drafted" | "proof" | "observation"> | undefined): string {
  if (!f) return seg.title;
  if (f.source !== "job" || f.title !== f.drafted.title) return f.title;
  const said = (f.proof || f.observation.split("\n")[0] || "").trim().replace(/\.$/, "");
  const on = f.title.split(" - ")[0].trim() || f.title;
  return said ? `“${said}”, written on ${on}` : `Written on ${f.title}`;
}

export function LateHours({ bars, late, onPick, findings = [] }: { bars: LateBar[]; late: number; onPick: (key: string) => void; findings?: Finding[] }) {
  // Each cause is written on its own bar's row: nothing to match by color.
  // The finding that explains the most hours (over every bar) is the one
  // accent; the rest one gray; what the records don't explain is hatched.
  const totals = new Map<string, number>();
  for (const b of bars) for (const x of b.segs) if (x.key) totals.set(x.key, (totals.get(x.key) ?? 0) + x.hours);
  const lead = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const byKey = new Map(findings.map((f) => [f.key, f]));
  const fill = (k: string | null): React.CSSProperties => (k == null ? UNEXPLAINED : { background: k === lead ? LEAD : PIECE });
  const why = (x: Seg) => causeWords(x, x.key ? byKey.get(x.key) : undefined);
  const max = Math.max(1, ...bars.map((b) => b.hours));
  const rowBtn = "block w-[calc(100%+1rem)] text-left rounded-md -mx-2 px-2 py-1.5 pointer-coarse:min-h-11 hover:bg-[var(--color-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]";
  const bar = (b: LateBar) => (
    <span role="img" aria-label={`${b.label}: ${b.hours} h. ${b.segs.map((x) => `${x.hours} h, ${why(x)}`).join("; ")}`} className="mt-1.5 flex gap-[2px] h-4" style={{ width: `${Math.max(2, (b.hours / max) * 100)}%` }}>
      {b.segs.map((x, k) => <span key={k} aria-hidden className="h-full rounded-[4px]" style={{ flexGrow: x.hours, flexBasis: 0, minWidth: 3, ...fill(x.key) }} />)}
    </span>
  );
  return (
    <ul className="divide-y divide-[var(--color-border)]" aria-label={`Where the ${late} h went`} data-late-hours>
      {bars.map((b, i) => {
        const one = b.segs.length === 1 ? b.segs[0] : null;
        // One cause: the whole row says it, and goes to its finding.
        if (one) {
          const body = (
            <>
              <span className="block text-body text-[var(--color-text)]"><b className="font-medium">{b.label}</b> · <b className="font-medium tabular-nums">{b.hours} h</b> · <span className={one.key ? "" : "text-[var(--color-text-muted)]"}>{why(one)}</span></span>
              {bar(b)}
            </>
          );
          return <li key={i} className="py-1">{one.key ? <button type="button" onClick={() => onPick(one.key!)} className={rowBtn}>{body}</button> : <div className="py-1.5">{body}</div>}</li>;
        }
        // Split among causes: the total once, then each cause under the
        // bar, left to right, with its hours.
        return (
          <li key={i} className="py-2">
            <span className="block text-body text-[var(--color-text)]"><b className="font-medium">{b.label}</b> · <b className="font-medium tabular-nums">{b.hours} h</b></span>
            {bar(b)}
            <ul className="mt-1">
              {b.segs.map((x, k) => {
                const line = <span className="flex items-start gap-2 text-body"><span aria-hidden className="mt-[5px] w-3 h-3 rounded-[3px] shrink-0" style={fill(x.key)} /><span className="min-w-0"><b className="font-medium tabular-nums">{x.hours} h</b> · <span className={x.key ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>{why(x)}</span></span></span>;
                return <li key={k}>{x.key ? <button type="button" onClick={() => onPick(x.key!)} className={rowBtn}>{line}</button> : <div className="py-1.5">{line}</div>}</li>;
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

// ─── One party over the event ──────────────────────────────────────

const PAD_L = 28;
/** Room on the right for the lines' names where they end (wide charts only). */
const padR = (w: number) => (w >= 480 ? 104 : 10);
/** The x scale both the chart and the strip under it share. */
function scaleOf(L: PartyLoad, w: number) {
  const PAD_R = padR(w);
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
  const PAD_R = padR(w);
  const ends = w >= 480;
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
  // Each line named at its end, in its color, nudged apart so none overlap.
  const last = pts[pts.length - 1];
  const endLabels = (() => {
    if (!ends || !last) return [];
    const xs = [
      { key: "open", y: y(last.open), text: `Ready ${last.open}`, color: OPEN, bold: true },
      { key: "work", y: y(last.working), text: `Worked ${last.working}`, color: WORK, bold: false },
      { key: "plan", y: y(n), text: `Planned ${n}`, color: "var(--color-text-muted)", bold: false },
    ].sort((a, b) => a.y - b.y);
    for (let i = 1; i < xs.length; i++) if (xs[i].y - xs[i - 1].y < 13) xs[i].y = xs[i - 1].y + 13;
    return xs;
  })();
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
          {/* The highest point, said where it is. */}
          {(() => {
            const px = sc.x(L.peak.at), py = y(L.peak.open);
            const right = px < w - PAD_R - 110;
            return <text x={right ? px + 8 : px - 8} y={Math.max(PT + 9, py - 7)} fontSize={11} fontWeight={600} textAnchor={right ? "start" : "end"} fill={OPEN}>Most ready: {L.peak.open}</text>;
          })()}
          {endLabels.map((l) => <text key={l.key} x={w - PAD_R + 6} y={l.y + 4} fontSize={11} fontWeight={l.bold ? 600 : 400} fill={l.color}>{l.text}</text>)}
          {cur && hover != null && <line x1={sc.x(hover)} x2={sc.x(hover)} y1={PT} y2={Hh - PB} stroke="var(--color-text-muted)" strokeWidth={1} />}
          <rect x={PAD_L} y={PT} width={Math.max(1, w - PAD_L - PAD_R)} height={Hh - PT - PB} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {cur && hover != null && (
        <div className="pointer-events-none absolute top-1 z-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-caption shadow-sm text-[var(--color-text)]"
          style={{ left: Math.min(Math.max(0, sc.x(hover) + 10), Math.max(0, w - 210)), width: 200 }}>
          <b className="block">{at(hover, tz)}</b>
          <span className="block">Ready: {cur.open} · Being worked: {cur.working}</span>
          {cur.waiting > 0 && <span className="block">Waiting for {P}: {cur.waiting}</span>}
          {cur.nobody > 0 && <span className="block">Ready, nobody on it: {cur.nobody}</span>}
          <span className="block text-[var(--color-text-muted)]">Planned at once: {n}</span>
        </div>
      )}
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption text-[var(--color-text-muted)]">
        {/* The lines are named at their ends on a wide chart; on a narrow one, here. */}
        {!ends && <>
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 h-0.5 rounded-full" style={{ background: OPEN }} />Ready (open)</li>
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 h-0.5 rounded-full" style={{ background: WORK }} />Being worked</li>
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 border-t-[1.5px] border-dashed border-[var(--color-text-muted)]" />Planned at once ({n})</li>
        </>}
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
  const PAD_R = padR(w || 600);
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
            <li key={j.id} className="text-caption">
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
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-[var(--color-text-muted)]">
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
          <div className="flex items-baseline gap-2 text-caption min-w-0">
            <span className="min-w-0 truncate text-[var(--color-text)]"><b>{g.party}</b> · {g.step} <span className="text-[var(--color-text-muted)]">({g.jobs.length} job{g.jobs.length === 1 ? "" : "s"})</span></span>
            <span className="ml-auto shrink-0 tabular-nums font-medium text-[var(--color-text)]">{g.hours} h</span>
          </div>
          <div className="mt-0.5 h-2.5 rounded-md" style={{ width: `${Math.max(2, (g.hours / max) * 100)}%`, background: NOBODY }} />
        </li>
      ))}
    </ul>
  );
}
