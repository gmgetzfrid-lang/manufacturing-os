"use client";

// Dashboard viz kit — the small, dependency-free SVG marks that give widgets
// real fidelity: a trend you can see, not just a number.
//
// Built to the dataviz method:
//   • thin marks (2px lines, slim bars with rounded data-ends)
//   • 2px surface gaps between adjacent fills (SegmentBar)
//   • recessive tracks/grids; TEXT always wears text tokens, never series color
//   • identity never color-alone (legend rows with labels+counts; trend chips
//     carry ▲/▼ glyphs; every mark has a <title> hover tooltip)
//   • categorical colors come from --viz-cat-1..6 (validated, fixed order,
//     never cycled; dark mode has its own validated steps in globals.css)

import React from "react";

/** Fixed-order categorical color for slot i (0-based). Never cycles — callers
 *  must fold overflow into "Other" before slot 6. */
export const vizCat = (i: number) => `var(--viz-cat-${Math.min(i + 1, 6)})`;

// ── Day bucketing (shared by sparkline/bars callers) ─────────────────────────

/** Count ISO timestamps into N daily buckets ending today. Returns oldest→newest. */
export function dayBuckets(isoDates: Array<string | null | undefined>, days: number): { counts: number[]; labels: string[] } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  const counts = new Array<number>(days).fill(0);
  for (const iso of isoDates) {
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) continue;
    const idx = days - 1 - Math.floor((today + DAY - t) / DAY);
    if (idx >= 0 && idx < days) counts[idx]++;
  }
  const labels = counts.map((_, i) => {
    const d = new Date(today - (days - 1 - i) * DAY);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  });
  return { counts, labels };
}

// ── Sparkline — change-over-time in a whisper ───────────────────────────────

export function Sparkline({
  values, labels, height = 36, stroke = "var(--color-accent)", className = "",
}: {
  values: number[];
  /** Per-point hover labels (same length as values). */
  labels?: string[];
  height?: number;
  stroke?: string;
  className?: string;
}) {
  const W = 100, H = 100; // normalized viewBox; CSS sizes the box
  const max = Math.max(1, ...values);
  const n = values.length;
  if (n === 0) return null;
  const px = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * (W - 4) + 2);
  const py = (v: number) => H - 6 - (v / max) * (H - 12);
  const pts = values.map((v, i) => `${px(i)},${py(v)}`).join(" ");
  const area = `2,${H - 4} ${pts} ${W - 2},${H - 4}`;
  const last = values[n - 1];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={`w-full ${className}`}
      style={{ height }}
      role="img"
      aria-label={`Trend, latest ${last}`}
    >
      <polygon points={area} fill={stroke} opacity="0.1" />
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* Endpoint dot — the "now" anchor. */}
      <circle cx={px(n - 1)} cy={py(last)} r="3" fill={stroke}>
        {labels?.[n - 1] && <title>{`${labels[n - 1]} · ${last}`}</title>}
      </circle>
    </svg>
  );
}

// ── MiniBars — daily activity columns with per-bar hover ────────────────────

export function MiniBars({
  values, labels, height = 40, fill = "var(--color-accent)", className = "",
}: {
  values: number[];
  labels?: string[];
  height?: number;
  fill?: string;
  className?: string;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className={`flex items-end gap-[3px] ${className}`} style={{ height }} role="img" aria-label="Daily activity">
      {values.map((v, i) => {
        const h = v === 0 ? 3 : Math.max(4, Math.round((v / max) * height));
        return (
          <div
            key={i}
            className="flex-1 min-w-[3px] rounded-t-[3px] transition-[height] duration-300"
            style={{ height: h, background: fill, opacity: v === 0 ? 0.22 : 0.9 }}
            title={labels?.[i] != null ? `${labels[i]} · ${v}` : String(v)}
          />
        );
      })}
    </div>
  );
}

// ── TrendChip — this period vs last, with a glyph (never color-alone) ───────

export function TrendChip({ current, previous, unit = "" }: { current: number; previous: number; unit?: string }) {
  const diff = current - previous;
  const pct = previous > 0 ? Math.round((diff / previous) * 100) : (current > 0 ? 100 : 0);
  const flat = diff === 0;
  const up = diff > 0;
  const color = flat ? "var(--color-text-faint)" : up ? "var(--viz-up)" : "var(--viz-down)";
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-bold tabular-nums"
      style={{ color }}
      title={`${current}${unit} this period vs ${previous}${unit} last`}
    >
      <span aria-hidden>{flat ? "―" : up ? "▲" : "▼"}</span>
      {flat ? "flat" : `${Math.abs(pct)}%`}
      <span className="font-semibold text-[var(--color-text-faint)]">vs last wk</span>
    </span>
  );
}

// ── ProgressRing — one value of a whole ─────────────────────────────────────

export function ProgressRing({
  value, total, size = 56, strokeWidth = 6, color = "var(--color-accent)", children,
}: {
  value: number;
  total: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  children?: React.ReactNode;
}) {
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <div className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }} title={`${value} of ${total}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--viz-track)" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - frac)}
          className="transition-[stroke-dashoffset] duration-700"
          style={{ transitionTimingFunction: "var(--ease-fluid)" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

// ── SegmentBar — one whole split into named parts ───────────────────────────
// 2px surface gaps between fills; a legend row beneath carries identity
// (dot + label + count) so color is never the only encoding.

export interface Segment { label: string; count: number }

export function SegmentBar({ segments, className = "" }: { segments: Segment[]; className?: string }) {
  const shown = segments.filter((s) => s.count > 0);
  const total = shown.reduce((s, x) => s + x.count, 0);
  if (total === 0) return null;
  return (
    <div className={className}>
      <div className="flex h-2.5 rounded-full overflow-hidden gap-[2px]" role="img" aria-label={shown.map((s) => `${s.label} ${s.count}`).join(", ")}>
        {shown.map((s) => {
          const slot = segments.indexOf(s);
          return (
            <div
              key={s.label}
              className="min-w-[6px] first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(s.count / total) * 100}%`, background: vizCat(slot) }}
              title={`${s.label} · ${s.count}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {shown.map((s) => {
          const slot = segments.indexOf(s);
          return (
            <span key={s.label} className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: vizCat(slot) }} />
              {s.label}
              <b className="text-[var(--color-text)] tabular-nums">{s.count}</b>
            </span>
          );
        })}
      </div>
    </div>
  );
}
