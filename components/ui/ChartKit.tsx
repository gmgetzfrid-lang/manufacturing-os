"use client";

// ChartKit — the dependency-free SVG charts the Project Controls program
// draws with: the cost S-curve, comparison bars, score dials, donuts, and
// the EXAMPLE frame that lets every chart be seen before real data exists.
//
// Honest by default: axes start at zero; ONE series in the brand (the one
// that matters) and the rest gray; names at the ends of lines instead of a
// legend; hairline grid; no fills or gradients. Identity is never color
// alone (labels carry names; dashes mark the planned line), every mark is
// hoverable via <title>. No chart library: these render anywhere the app
// does, at zero bundle cost.

import React from "react";
import { vizCat } from "@/components/dashboard/viz";

// ── S-curve: planned vs committed vs actual, cumulative over time ────────

export interface SCurvePoint {
  date: string;
  planned: number | null;
  committed: number;
  actual: number;
}

// Room on the right for the names at the line ends.
const VB_W = 600, VB_H = 220, PAD_L = 8, PAD_R = 112, PAD_T = 12, PAD_B = 24;

/** End labels pushed apart so two lines ending close together stay
 *  readable (at least `gap` apart, inside the plot). */
function spreadLabels<T extends { y: number }>(items: T[], gap: number, top: number, bottom: number): T[] {
  const out = [...items].sort((a, b) => a.y - b.y).map((it) => ({ ...it }));
  for (let i = 1; i < out.length; i++) if (out[i].y - out[i - 1].y < gap) out[i].y = out[i - 1].y + gap;
  const over = out.length ? out[out.length - 1].y - bottom : 0;
  if (over > 0) for (const it of out) it.y -= over;
  for (let i = 0; i < out.length; i++) if (out[i].y < top) out[i].y = top + i * gap;
  return out;
}

export function SCurveChart({ points, fmt, todayIso, className = "" }: {
  points: SCurvePoint[];
  fmt: (n: number) => string;
  /** Draw a "today" marker when it falls inside the span. */
  todayIso?: string | null;
  className?: string;
}) {
  if (points.length < 2) return null;
  const max = Math.max(
    1,
    ...points.map((p) => Math.max(p.planned ?? 0, p.committed, p.actual)),
  );
  const n = points.length;
  const px = (i: number) => PAD_L + (i / (n - 1)) * (VB_W - PAD_L - PAD_R);
  const py = (v: number) => PAD_T + (1 - v / max) * (VB_H - PAD_T - PAD_B);
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
  const todayIdx = todayIso
    ? points.findIndex((p) => p.date >= todayIso)
    : -1;
  const fmtDate = (d: string) =>
    new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="w-full h-auto" role="img"
        aria-label={`Cost curve - actual ${fmt(last.actual)}, committed ${fmt(last.committed)}${last.planned != null ? `, planned ${fmt(last.planned)}` : ""}`}>
        {/* Hairline grid at quarter lines, and the zero line. */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={PAD_L} x2={VB_W - PAD_R} y1={py(max * f)} y2={py(max * f)}
            stroke={f === 0 ? "var(--color-border-strong)" : "var(--viz-track)"} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {/* Committed: promised money, gray (the brand is for what was spent). */}
        <path d={path((p) => p.committed)} fill="none" stroke="var(--viz-neutral)" strokeWidth="1.75"
          strokeLinecap="round" strokeLinejoin="round" />
        {/* Planned: dashed so identity survives grayscale. */}
        {hasPlanned && (
          <path d={path((p) => p.planned)} fill="none" stroke="var(--color-text-faint)"
            strokeWidth="1.5" strokeDasharray="5 4" strokeLinecap="round" />
        )}
        <path d={path((p) => p.actual)} fill="none" stroke="var(--color-main)" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" />
        {/* Today marker. */}
        {todayIdx > 0 && todayIdx < n && (
          <line x1={px(todayIdx)} x2={px(todayIdx)} y1={PAD_T} y2={VB_H - PAD_B}
            stroke="var(--color-text-faint)" strokeWidth="1" strokeDasharray="2 3" />
        )}
        {/* Endpoint dots, and each line's name and value at its end. */}
        <circle cx={px(n - 1)} cy={py(last.actual)} r="3.5" fill="var(--color-main)" />
        <circle cx={px(n - 1)} cy={py(last.committed)} r="3" fill="var(--viz-neutral)" />
        {spreadLabels([
          { key: "spent", y: py(last.actual), text: `Spent ${fmt(last.actual)}`, color: "var(--color-main)", bold: true },
          { key: "committed", y: py(last.committed), text: `Committed ${fmt(last.committed)}`, color: "var(--color-text-muted)", bold: false },
          ...(hasPlanned && last.planned != null ? [{ key: "planned", y: py(last.planned), text: `Planned ${fmt(last.planned)}`, color: "var(--color-text-muted)", bold: false }] : []),
        ], 13, PAD_T + 4, VB_H - PAD_B).map((l) => (
          <text key={l.key} x={px(n - 1) + 8} y={l.y + 4} fontSize="11" fontWeight={l.bold ? 600 : 400} fill={l.color}
            style={{ fontVariantNumeric: "tabular-nums" }}>{l.text}</text>
        ))}
        {/* Per-point hover columns. */}
        {points.map((p, i) => (
          <rect key={i} x={px(i) - (VB_W / n) / 2} y={PAD_T} width={VB_W / n} height={VB_H - PAD_T - PAD_B}
            fill="transparent">
            <title>{`${fmtDate(p.date)} - spent ${fmt(p.actual)} · committed ${fmt(p.committed)}${p.planned != null ? ` · planned ${fmt(p.planned)}` : ""}`}</title>
          </rect>
        ))}
        {/* X extremes. */}
        <text x={PAD_L} y={VB_H - 8} fontSize="10" fill="var(--color-text-faint)">{fmtDate(points[0].date)}</text>
        <text x={VB_W - PAD_R} y={VB_H - 8} fontSize="10" textAnchor="end" fill="var(--color-text-faint)">{fmtDate(last.date)}</text>
      </svg>
      {hasPlanned && (
        <p className="mt-1 text-caption text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
          <span aria-hidden className="w-4 border-t border-dashed border-[var(--color-text-faint)]" />
          Dashed: the planned pace
        </p>
      )}
    </div>
  );
}

// ── BarList: horizontal money bars with labels — bids, burn by line ──────

export interface BarItem {
  label: string;
  value: number;
  sublabel?: string;
  /** Slot for a vizCat color; omit for gray (the default). */
  slot?: number;
  /** The bar that matters (e.g. the best-value bid): drawn in the brand. */
  highlight?: boolean;
  /** Small red flag text (e.g. "over budget"). */
  flag?: string;
}

export function BarList({ items, fmt, className = "" }: {
  items: BarItem[]; fmt: (n: number) => string; className?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className={`space-y-2 ${className}`}>
      {items.map((it, i) => (
        <div key={`${it.label}-${i}`} title={`${it.label} · ${fmt(it.value)}`}>
          <div className="flex items-baseline justify-between gap-2 text-caption">
            <span className={`truncate font-medium ${it.highlight ? "text-[var(--color-accent-text)]" : "text-[var(--color-text)]"}`}>
              {it.label}
              {it.flag && <span className="ml-1.5 font-medium text-caption text-[var(--state-overdue-text)]">{it.flag}</span>}
            </span>
            <span className="tabular-nums font-medium text-[var(--color-text)] shrink-0">{fmt(it.value)}</span>
          </div>
          <div className="mt-0.5 h-2 rounded-full bg-[var(--viz-track)] overflow-hidden">
            <div className="h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${Math.max(2, (it.value / max) * 100)}%`,
                // One bar in the brand (the highlighted one), the rest gray.
                background: it.highlight ? "var(--color-main)" : it.slot != null ? vizCat(it.slot) : "var(--viz-neutral)",
              }} />
          </div>
          {it.sublabel && <div className="mt-0.5 text-caption text-[var(--color-text-muted)]">{it.sublabel}</div>}
        </div>
      ))}
    </div>
  );
}

// ── ScoreDial: a 0-100 composite with its band, honest about Unrated ─────

export function scoreBandColor(score: number | null): string {
  if (score == null) return "var(--color-text-faint)";
  if (score >= 85) return "var(--viz-up)";
  if (score >= 70) return "var(--color-main)";
  if (score >= 50) return "#d97706"; // amber-600 — reads in both themes
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
      title={score == null ? "Not enough evidence to score yet" : `${score} / 100${label ? ` - ${label}` : ""}`}>
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
        <div className="font-medium tabular-nums text-[var(--color-text)]" style={{ fontSize: size / 3.4 }}>
          {score == null ? "-" : Math.round(score)}
        </div>
        {label && <div className="mt-0.5 text-body font-medium " style={{ color }}>{label}</div>}
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
          <div className="absolute inset-0 flex items-center justify-center text-caption font-medium text-[var(--color-text-muted)] text-center leading-tight">
            {centerLabel}
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        {shown.map((s) => {
          const slot = segments.indexOf(s);
          return (
            <div key={s.label} className="flex items-center gap-1.5 text-caption text-[var(--color-text-muted)]">
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
        <span className="rotate-[-18deg] text-4xl font-medium text-[var(--color-text)] opacity-[0.07] select-none">
          Example
        </span>
      </div>
      <div className="px-3 pt-2.5 pb-1 flex items-center gap-2">
        <span className="text-body font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40">
          Example data
        </span>
        <span className="text-caption text-[var(--color-text-muted)]">
          {note ?? "This is what the view looks like with a job in flight - it turns real as your numbers land."}
        </span>
      </div>
      <div className="p-3 opacity-90">{children}</div>
    </div>
  );
}
