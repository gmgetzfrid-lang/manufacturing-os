"use client";

// ChartKit — the dependency-free SVG charts the Project Controls program
// draws with: the cost S-curve, comparison bars, score dials, donuts, and
// the EXAMPLE frame that lets every chart be seen before real data exists.
//
// Same design method as components/dashboard/viz.tsx: thin marks, recessive
// grids, text wears text tokens (never series color), identity never
// color-alone (legends carry labels; each S-curve series has its own line
// and marker shape — solid, dash-dot, the planned line's even dash), colours
// are theme tokens only, every mark hoverable via <title>. No chart library —
// these render anywhere the app does, at zero bundle cost.

import React from "react";
import { vizCat } from "@/components/dashboard/viz";

// ── S-curve: planned vs committed vs actual, cumulative over time ────────

export interface SCurvePoint {
  date: string;
  planned: number | null;
  committed: number;
  actual: number;
}

export const SCURVE_VIEWBOX = { width: 600, height: 220 } as const;
const VB_W = SCURVE_VIEWBOX.width, VB_H = SCURVE_VIEWBOX.height, PAD_L = 8, PAD_R = 8, PAD_T = 12, PAD_B = 24;
const PLOT_W = VB_W - PAD_L - PAD_R, PLOT_H = VB_H - PAD_T - PAD_B;

// CHART-2: series identity is hue AND shape. Both hues are slots 1 and 2 of
// the validated categorical scale (never the white-label brand accent);
// Committed also wears a dash-dot line and a square end marker, Spent a
// solid line, an area wash and a round marker, Planned the even dash.
const SPENT = vizCat(0);
const COMMITTED = vizCat(1);
const COMMITTED_DASH = "8 3 2 3";
const PLANNED_DASH = "5 4";

/** A clean tick step (1, 2, 2.5 or 5 × 10ⁿ) giving about four intervals. */
function niceStep(range: number): number {
  const raw = range / 4;
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag);
}

/**
 * CHART-1: the S-curve's value scale. The top was clamped and the bottom was
 * not, so a credit that took a cumulative line below zero projected below the
 * plot floor — or, with a zero budget, ~920,000 units off the canvas. The
 * domain now spans [min(0, data), max(1, data, budget)], widened to clean tick
 * values, and every projected value lands inside the plot.
 */
export function sCurveScale(values: number[]): { lo: number; hi: number; ticks: number[]; py: (v: number) => number } {
  const finite = values.filter(Number.isFinite);
  const dataHi = Math.max(1, ...finite);
  const dataLo = Math.min(0, ...finite);
  const step = niceStep(dataHi - dataLo);
  const hi = Math.ceil(dataHi / step) * step;
  const lo = Math.floor(dataLo / step) * step;
  const count = Math.round((hi - lo) / step);
  const ticks = Array.from({ length: count + 1 }, (_, k) => lo + k * step);
  const py = (v: number) => PAD_T + ((hi - Math.min(hi, Math.max(lo, v))) / (hi - lo)) * PLOT_H;
  return { lo, hi, ticks, py };
}

/**
 * CHART-5: today's x from the actual date — the curve's samples are evenly
 * spaced in time from the first point's date to the last, so the marker is
 * interpolated on that same axis instead of snapping to the next sample (on a
 * three-year job the samples are 28 days apart). Null outside the span.
 */
export function sCurveTodayX(points: SCurvePoint[], todayIso: string | null | undefined): number | null {
  if (!todayIso || points.length < 2) return null;
  const t0 = Date.parse(points[0].date);
  const t1 = Date.parse(points[points.length - 1].date);
  const now = Date.parse(todayIso);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || !Number.isFinite(now) || !(t1 > t0)) return null;
  if (now < t0 || now > t1) return null;
  return PAD_L + ((now - t0) / (t1 - t0)) * PLOT_W;
}

// In-plot labels get a surface-coloured halo so a line crossing them never
// makes them unreadable.
const HALO = { stroke: "var(--color-surface)", strokeWidth: 3, paintOrder: "stroke" } as const;

// PERF-10: one date formatter for every label and tooltip, not one per point.
let dayFmt: Intl.DateTimeFormat | null = null;
const fmtDay = (d: string) => {
  dayFmt ??= new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  return dayFmt.format(new Date(d + "T00:00:00"));
};

/** Legend key drawn with the series' own stroke, dash and marker. */
function LegendKey({ stroke, dash, marker, vertical }: {
  stroke: string; dash?: string; marker?: "circle" | "square"; vertical?: boolean;
}) {
  return (
    <svg aria-hidden width="20" height="10" viewBox="0 0 20 10" className="shrink-0 overflow-visible">
      {vertical
        ? <line x1="10" x2="10" y1="0" y2="10" stroke={stroke} strokeWidth="1.5" />
        : <line x1="1" x2="19" y1="5" y2="5" stroke={stroke} strokeWidth="2" strokeDasharray={dash} />}
      {marker === "circle" && <circle cx="17" cy="5" r="3" fill={stroke} />}
      {marker === "square" && <rect x="14" y="2" width="6" height="6" fill={stroke} />}
    </svg>
  );
}

export function SCurveChart({ points, fmt, tickFmt, todayIso, budget, budgetLabel = "Budget", example = false, className = "" }: {
  points: SCurvePoint[];
  fmt: (n: number) => string;
  /** Axis-label format (compact); defaults to `fmt`. */
  tickFmt?: (n: number) => string;
  /** Draw a labelled "today" marker at today's true position when it falls inside the span. */
  todayIso?: string | null;
  /** CHART-5: the budget the planned line climbs to — drawn as a labelled
   *  reference line whenever it is above zero, schedule or not. */
  budget?: number | null;
  budgetLabel?: string;
  /** REL-10: stand-in data — the figure carries its watermark in-mark and
   *  every figure in its legend and tooltips says "example". */
  example?: boolean;
  className?: string;
}) {
  if (points.length < 2) return null;
  const n = points.length;
  const ref = budget != null && Number.isFinite(budget) && budget > 0 ? budget : null;
  const { lo, ticks, py } = sCurveScale([
    ...points.flatMap((p) => [p.planned ?? 0, p.committed, p.actual]),
    ...(ref != null ? [ref] : []),
  ]);
  const px = (i: number) => PAD_L + (i / (n - 1)) * PLOT_W;
  const path = (pick: (p: SCurvePoint) => number | null) => {
    let dStr = "";
    for (let i = 0; i < n; i++) {
      const v = pick(points[i]);
      if (v == null) continue;
      dStr += `${dStr ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
    }
    return dStr;
  };
  const hasPlanned = points.some((p) => p.planned != null);
  const last = points[n - 1];
  const todayX = sCurveTodayX(points, todayIso);
  const money = (v: number) => (example ? `${fmt(v)} (example)` : fmt(v));
  const tick = tickFmt ?? fmt;
  const budgetY = ref != null ? py(ref) : null;

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="w-full h-auto" role="img"
        aria-label={`${example ? "Example cost curve, not this project's numbers" : "Cost curve"} — actual ${fmt(last.actual)}, committed ${fmt(last.committed)}${last.planned != null ? `, planned ${fmt(last.planned)}` : ""}${ref != null ? `, ${budgetLabel.toLowerCase()} ${fmt(ref)}` : ""}`}>
        {/* Recessive horizontal grid at clean values, each labelled (CHART-5). */}
        {ticks.map((v) => (
          <line key={v} data-mark="grid" data-value={v} x1={PAD_L} x2={VB_W - PAD_R} y1={py(v)} y2={py(v)}
            stroke="var(--viz-track)" strokeWidth="1" />
        ))}
        {/* CHART-1: a zero baseline whenever the scale goes below zero. */}
        {lo < 0 && (
          <line data-mark="zero" x1={PAD_L} x2={VB_W - PAD_R} y1={py(0)} y2={py(0)}
            stroke="var(--color-text-muted)" strokeWidth="1" />
        )}
        {/* REL-10: the watermark sits in the figure itself, twice, so no crop loses it. */}
        {example && [0.27, 0.73].map((f) => (
          <text key={f} data-mark="watermark" x={PAD_L + f * PLOT_W} y={PAD_T + PLOT_H / 2 + 12}
            textAnchor="middle" fontSize="38" fontWeight="900" letterSpacing="6"
            fill="var(--color-text)" opacity="0.13" transform={`rotate(-14 ${PAD_L + f * PLOT_W} ${PAD_T + PLOT_H / 2})`}>
            EXAMPLE
          </text>
        ))}
        {/* Budget reference line (CHART-5) — drawn with or without a schedule. */}
        {budgetY != null && (
          <line data-mark="budget" x1={PAD_L} x2={VB_W - PAD_R} y1={budgetY} y2={budgetY}
            stroke="var(--color-text-muted)" strokeWidth="1" />
        )}
        {/* Actual: filled area + line (the money that really left). */}
        <path d={`${path((p) => p.actual)} L${px(n - 1).toFixed(1)},${py(0).toFixed(1)} L${px(0).toFixed(1)},${py(0).toFixed(1)} Z`}
          fill={SPENT} opacity="0.1" />
        {/* Committed: promised money — its own hue and a dash-dot line. */}
        <path data-series="committed" d={path((p) => p.committed)} fill="none" stroke={COMMITTED} strokeWidth="2"
          strokeDasharray={COMMITTED_DASH} strokeLinecap="butt" strokeLinejoin="round" />
        {/* Planned: dashed so identity survives grayscale. */}
        {hasPlanned && (
          <path data-series="planned" d={path((p) => p.planned)} fill="none" stroke="var(--color-text-faint)"
            strokeWidth="1.5" strokeDasharray={PLANNED_DASH} strokeLinecap="round" />
        )}
        <path data-series="spent" d={path((p) => p.actual)} fill="none" stroke={SPENT} strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" />
        {/* Today marker: at today's true position, labelled, in the legend. */}
        {todayX != null && (
          <g data-mark="today">
            <line x1={todayX} x2={todayX} y1={PAD_T} y2={VB_H - PAD_B} stroke="var(--color-text-muted)" strokeWidth="1">
              <title>{`Today — ${fmtDay(todayIso as string)}`}</title>
            </line>
            <text x={todayX} y={PAD_T - 3} fontSize="9" fontWeight="700"
              textAnchor={todayX < PAD_L + 20 ? "start" : todayX > VB_W - PAD_R - 20 ? "end" : "middle"}
              fill="var(--color-text-muted)" {...HALO}>Today</text>
          </g>
        )}
        {/* Endpoint markers — round for Spent, square for Committed, ringed in the surface. */}
        <circle cx={px(n - 1)} cy={py(last.actual)} r="4" fill={SPENT} stroke="var(--color-surface)" strokeWidth="2" />
        <rect x={px(n - 1) - 4} y={py(last.committed) - 4} width="8" height="8" fill={COMMITTED}
          stroke="var(--color-surface)" strokeWidth="2" />
        {/* In-plot labels last, haloed, so no line crosses them: each gridline's
            value (CHART-5) and the budget line's name and figure. */}
        {ticks.map((v) => (
          <text key={v} data-mark="grid-label" x={PAD_L + 2} y={py(v) - 3} fontSize="9"
            fill="var(--color-text-muted)" {...HALO}>{tick(v)}</text>
        ))}
        {ref != null && budgetY != null && (
          <text data-mark="budget-label" x={VB_W - PAD_R - 2} y={budgetY < PAD_T + 14 ? budgetY + 11 : budgetY - 3}
            fontSize="9" textAnchor="end" fill="var(--color-text-muted)" {...HALO}>{`${budgetLabel} ${money(ref)}`}</text>
        )}
        {/* Per-point hover columns. */}
        {points.map((p, i) => (
          <rect key={i} x={px(i) - (VB_W / n) / 2} y={PAD_T} width={VB_W / n} height={PLOT_H}
            fill="transparent">
            <title>{`${example ? "Example — " : ""}${fmtDay(p.date)} — spent ${fmt(p.actual)} · committed ${fmt(p.committed)}${p.planned != null ? ` · planned ${fmt(p.planned)}` : ""}`}</title>
          </rect>
        ))}
        {/* X extremes. */}
        <text x={PAD_L} y={VB_H - 8} fontSize="10" fill="var(--color-text-faint)">{fmtDay(points[0].date)}</text>
        <text x={VB_W - PAD_R} y={VB_H - 8} fontSize="10" textAnchor="end" fill="var(--color-text-faint)">{fmtDay(last.date)}</text>
      </svg>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <LegendKey stroke={SPENT} marker="circle" />
          Spent <b className="text-[var(--color-text)] tabular-nums">{money(last.actual)}</b>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <LegendKey stroke={COMMITTED} dash={COMMITTED_DASH} marker="square" />
          Committed <b className="text-[var(--color-text)] tabular-nums">{money(last.committed)}</b>
        </span>
        {hasPlanned && (
          <span className="inline-flex items-center gap-1.5">
            <LegendKey stroke="var(--color-text-faint)" dash={PLANNED_DASH} />
            Planned pace
          </span>
        )}
        {ref != null && (
          <span className="inline-flex items-center gap-1.5">
            <LegendKey stroke="var(--color-text-muted)" />
            {budgetLabel} <b className="text-[var(--color-text)] tabular-nums">{money(ref)}</b>
          </span>
        )}
        {todayX != null && (
          <span className="inline-flex items-center gap-1.5">
            <LegendKey stroke="var(--color-text-muted)" vertical />
            Today
          </span>
        )}
      </div>
    </div>
  );
}

// ── BarList: horizontal money bars with labels — bids, burn by line ──────

export interface BarItem {
  label: string;
  value: number;
  sublabel?: string;
  /** Slot for vizCat color; omit for accent. */
  slot?: number;
  /** Highlight ring (e.g. best-value bid). */
  highlight?: boolean;
  /** Small red flag text (e.g. "over budget"). */
  flag?: string;
}

export function BarList({ items, fmt, example = false, className = "" }: {
  items: BarItem[]; fmt: (n: number) => string;
  /** REL-10: stand-in data — every value says "example". */
  example?: boolean;
  className?: string;
}) {
  const money = (v: number) => (example ? `${fmt(v)} (example)` : fmt(v));
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className={`space-y-2 ${className}`}>
      {items.map((it, i) => (
        <div key={`${it.label}-${i}`} title={`${it.label} · ${money(it.value)}`}>
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className={`truncate font-bold ${it.highlight ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>
              {it.label}
              {it.flag && <span className="ml-1.5 font-black text-[10px] text-rose-600 dark:text-rose-400">{it.flag}</span>}
            </span>
            <span className="tabular-nums font-black text-[var(--color-text)] shrink-0">{money(it.value)}</span>
          </div>
          <div className="mt-0.5 h-2 rounded-full bg-[var(--viz-track)] overflow-hidden">
            <div className="h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${Math.max(2, (it.value / max) * 100)}%`,
                background: it.slot != null ? vizCat(it.slot) : "var(--color-accent)",
                opacity: it.highlight ? 1 : 0.75,
              }} />
          </div>
          {it.sublabel && <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{it.sublabel}</div>}
        </div>
      ))}
    </div>
  );
}

// ── ScoreDial: a 0-100 composite with its band, honest about Unrated ─────

/** The band's colour for MARKS (the dial arc, a bar fill). Theme tokens
 *  only (CHART-4): the "watch" band is --state-held, whose light and dark
 *  steps are each validated against their own surface — the old literal
 *  amber-600 was 3.2:1 on white, under AA for the text some callers paint. */
export function scoreBandColor(score: number | null): string {
  if (score == null) return "var(--color-text-faint)";
  if (score >= 85) return "var(--viz-up)";
  if (score >= 70) return "var(--color-accent)";
  if (score >= 50) return "var(--state-held)";
  return "var(--viz-down)";
}

export function ScoreDial({ score, size = 64, label, className = "" }: {
  score: number | null;
  size?: number;
  /** Band word under the number ("Excellent", "Watch", "Unrated"). */
  label?: string;
  className?: string;
}) {
  const strokeWidth = Math.max(4, Math.round(size / 11));
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const frac = score == null ? 0 : Math.min(1, Math.max(0, score / 100));
  const color = scoreBandColor(score);
  return (
    <div className={`relative inline-flex flex-col items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
      title={score == null ? "Not enough evidence to score yet" : `${score} / 100${label ? ` — ${label}` : ""}`}>
      <svg width={size} height={size} className="-rotate-90 absolute inset-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--viz-track)" strokeWidth={strokeWidth} />
        {score != null && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - frac)}
            className="transition-[stroke-dashoffset] duration-700" />
        )}
      </svg>
      <div className="relative text-center leading-none">
        <div className="font-black tabular-nums text-[var(--color-text)]" style={{ fontSize: size / 3.4 }}>
          {score == null ? "—" : Math.round(score)}
        </div>
        {/* Text wears a text token; the arc above carries the band's colour (CHART-4). */}
        {label && <div className="mt-0.5 text-[8px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>}
      </div>
    </div>
  );
}

// ── Donut: shares of a whole with a legend (CO reasons, event mix) ───────

export interface DonutSegment { label: string; value: number }

export function Donut({ segments, size = 96, fmt, centerLabel, className = "" }: {
  segments: DonutSegment[];
  size?: number;
  fmt?: (n: number) => string;
  centerLabel?: string;
  className?: string;
}) {
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((s, x) => s + x.value, 0);
  if (total === 0) return null;
  const strokeWidth = Math.max(8, Math.round(size / 9));
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  // Precomputed running offsets — no mutation during render.
  const offsets: number[] = [];
  shown.reduce((acc, s) => { offsets.push(acc); return acc + s.value / total; }, 0);
  const f = fmt ?? ((n: number) => String(n));
  return (
    <div className={`flex items-center gap-4 ${className}`}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          {shown.map((s, i) => {
            const frac = s.value / total;
            const slot = segments.indexOf(s);
            return (
              <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke={vizCat(slot)} strokeWidth={strokeWidth}
                strokeDasharray={`${Math.max(frac * c - 2, 1)} ${c}`}
                strokeDashoffset={-offsets[i] * c}>
                <title>{`${s.label} · ${f(s.value)}`}</title>
              </circle>
            );
          })}
        </svg>
        {centerLabel && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] font-black text-[var(--color-text-muted)] text-center leading-tight">
            {centerLabel}
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        {shown.map((s) => {
          const slot = segments.indexOf(s);
          return (
            <div key={s.label} className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: vizCat(slot) }} />
              <span className="truncate">{s.label}</span>
              <b className="text-[var(--color-text)] tabular-nums shrink-0">{f(s.value)}</b>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── ExampleFrame: the "see it before you have data" wrapper ──────────────
// Renders children through the SAME components real data uses, visibly
// watermarked so nobody mistakes the preview for the project's numbers.

export function ExampleFrame({ children, note, className = "" }: {
  children: React.ReactNode;
  note?: string;
  className?: string;
}) {
  return (
    <div className={`relative rounded-2xl border-2 border-dashed border-[var(--color-border-strong)] overflow-hidden ${className}`}>
      <div aria-hidden className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <span className="rotate-[-18deg] text-4xl font-black uppercase tracking-[0.3em] text-[var(--color-text)] opacity-[0.12] select-none">
          Example
        </span>
      </div>
      <div className="px-3 pt-2.5 pb-1 flex items-center gap-2">
        <span className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40">
          Example data
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {note ?? "This is what the view looks like with a job in flight — it turns real as your numbers land."}
        </span>
      </div>
      <div className="p-3 opacity-90">{children}</div>
    </div>
  );
}
