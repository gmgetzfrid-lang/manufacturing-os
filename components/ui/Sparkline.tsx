"use client";

// Sparkline + MiniBars — the app's first shared data-viz primitives.
//
// Analytics today is hand-rolled SVG per screen with no shared vocabulary, so
// quantitative surfaces drift visually. These are tiny, dependency-free, token-
// driven building blocks for "status as a visual language": inline trend lines
// and aging/distribution bars that read at a glance. No charting library.

import React from "react";

function pathFor(values: number[], width: number, height: number, pad = 1): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const stepX = (width - pad * 2) / Math.max(1, values.length - 1);
  return values
    .map((v, i) => {
      const x = pad + i * stepX;
      const y = pad + (height - pad * 2) * (1 - (v - min) / span);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Inline trend line. Pass a series of numbers; the last point gets a dot.
 *  `tone` maps to a CSS color (defaults to the brand accent). */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  strokeWidth = 1.5,
  color = "var(--color-accent)",
  fill = true,
  className = "",
  ariaLabel,
}: {
  values: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  color?: string;
  fill?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  // useId must run unconditionally (Rules of Hooks) — call it before any early
  // return so the gradient id is stable across renders.
  const gid = React.useId();
  if (!values || values.length < 2) {
    return <div className={className} style={{ width, height }} aria-hidden />;
  }
  const d = pathFor(values, width, height);
  const last = values[values.length - 1];
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const stepX = (width - 2) / Math.max(1, values.length - 1);
  const lastX = 1 + (values.length - 1) * stepX;
  const lastY = 1 + (height - 2) * (1 - (last - min) / span);
  const areaD = `${d} L ${lastX.toFixed(1)} ${height} L 1 ${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={ariaLabel ?? "trend"}
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaD} fill={`url(#${gid})`} stroke="none" />
        </>
      )}
      <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={strokeWidth + 1} fill={color} />
    </svg>
  );
}

export interface MiniBarSegment {
  value: number;
  color: string;
  label?: string;
}

/** Horizontal stacked distribution bar — e.g. an "aging" trail (new / 7d /
 *  30d / 90d) or a status mix. Proportional, with accessible titles. */
export function MiniBars({
  segments,
  height = 8,
  rounded = true,
  className = "",
}: {
  segments: MiniBarSegment[];
  height?: number;
  rounded?: boolean;
  className?: string;
}) {
  const total = segments.reduce((s, seg) => s + Math.max(0, seg.value), 0);
  if (total <= 0) {
    return <div className={`bg-[var(--color-surface-2)] ${rounded ? "rounded-full" : ""} ${className}`} style={{ height }} />;
  }
  return (
    <div className={`flex w-full overflow-hidden ${rounded ? "rounded-full" : ""} ${className}`} style={{ height }}>
      {segments.map((seg, i) =>
        seg.value > 0 ? (
          <div
            key={i}
            style={{ width: `${(seg.value / total) * 100}%`, backgroundColor: seg.color }}
            title={seg.label ? `${seg.label}: ${seg.value}` : String(seg.value)}
          />
        ) : null,
      )}
    </div>
  );
}

export default Sparkline;
