"use client";

// CostVisuals — the cost-performance graphs the cockpit was missing.
//
//   * EVM S-curve — the planned-value (BCWS) cost curve over the schedule, with
//     today's Earned Value and Actual Cost plotted and a forecast line to EAC.
//     The gap between the lines IS the variance, read at a glance.
//   * CPI / SPI gauges — the indices as needles against the 1.0 target.
//   * Breakdown bars — budget vs actual per contractor (or cost type).
//
// Dependency-free SVG in the house viz style (see components/ui/Sparkline).
// Pure presentation; the curve math is the tested buildCostCurve().

import React from "react";
import { TrendingUp } from "lucide-react";
import { formatMoney, type EvmResult } from "@/lib/evm";
import { buildCostCurve, type GroupRollup } from "@/lib/costControls";
import type { Milestone } from "@/types/schema";

interface Props {
  milestones: Milestone[];
  bac: number;
  result: EvmResult;
  hasActuals: boolean;
  currency: string;
  byParty?: GroupRollup[];
  byCostType?: GroupRollup[];
}

export default function CostVisuals({ milestones, bac, result, hasActuals, currency, byParty, byCostType }: Props) {
  const groups = (byParty && byParty.length > 0 ? byParty : byCostType) ?? [];
  const groupLabel = byParty && byParty.length > 0 ? "By contractor" : "By cost type";

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] bg-slate-50/60 flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-[var(--color-accent)]" />
        <div className="font-bold text-sm text-[var(--color-text)]">Cost performance</div>
        <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">planned vs earned vs actual</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4 p-4">
        <EvmSCurve milestones={milestones} bac={bac} result={result} hasActuals={hasActuals} currency={currency} />
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Gauge label="CPI" value={result.cpi} />
            <Gauge label="SPI" value={result.spi} />
          </div>
          {groups.length > 0 && <Breakdown title={groupLabel} groups={groups} currency={currency} />}
        </div>
      </div>
    </div>
  );
}

// ─── EVM S-curve ─────────────────────────────────────────────────

function EvmSCurve({ milestones, bac, result, hasActuals, currency }: { milestones: Milestone[]; bac: number; result: EvmResult; hasActuals: boolean; currency: string }) {
  const curve = buildCostCurve(milestones, bac);
  if (curve.points.length < 2 || bac <= 0) {
    return (
      <div className="h-56 rounded-xl border border-dashed border-[var(--color-border-strong)] flex items-center justify-center text-center p-6 text-sm text-[var(--color-text-muted)]">
        Add a dated schedule and a budget to draw the earned-value curve.
      </div>
    );
  }

  const W = 640, H = 230, padL = 8, padR = 8, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const { startMs, finishMs, nowMs } = curve;
  const eac = result.eacCpi ?? result.eacBudgetRate ?? bac;
  const ev = result.ev, ac = result.ac;
  const maxY = Math.max(bac, eac, ev, ac ?? 0, curve.pvNow) * 1.08 || 1;

  const x = (t: number) => padL + ((t - startMs) / (finishMs - startMs || 1)) * plotW;
  const y = (v: number) => padT + plotH * (1 - v / maxY);
  const nowX = Math.max(padL, Math.min(padL + plotW, x(nowMs)));

  const pvPath = curve.points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.t).toFixed(1)} ${y(p.pv).toFixed(1)}`).join(" ");
  const pvArea = `${pvPath} L ${x(curve.points[curve.points.length - 1].t).toFixed(1)} ${y(0)} L ${x(curve.points[0].t).toFixed(1)} ${y(0)} Z`;

  const fmtD = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const nowInRange = nowMs >= startMs && nowMs <= finishMs;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Earned value S-curve">
        <defs>
          <linearGradient id="pvfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* BAC reference line */}
        <line x1={padL} y1={y(bac)} x2={padL + plotW} y2={y(bac)} stroke="var(--color-border-strong)" strokeWidth="1" strokeDasharray="2 3" />
        <text x={padL + plotW} y={y(bac) - 3} textAnchor="end" className="fill-[var(--color-text-faint)]" fontSize="9">BAC {formatMoney(bac, currency)}</text>

        {/* Planned value (BCWS) */}
        <path d={pvArea} fill="url(#pvfill)" stroke="none" />
        <path d={pvPath} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

        {/* Today guide */}
        {nowInRange && (
          <>
            <line x1={nowX} y1={padT} x2={nowX} y2={padT + plotH} stroke="var(--color-text-faint)" strokeWidth="1" strokeDasharray="3 3" />
            <text x={nowX} y={padT - 3} textAnchor="middle" className="fill-[var(--color-text-muted)]" fontSize="9">today</text>
          </>
        )}

        {/* Forecast line: actual cost today → EAC at finish (amber dashed) */}
        {hasActuals && ac != null && (
          <line x1={nowX} y1={y(ac)} x2={x(finishMs)} y2={y(eac)} stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="4 3" />
        )}
        {hasActuals && ac != null && (
          <>
            <circle cx={x(finishMs)} cy={y(eac)} r="3" fill="#ef4444" />
            <text x={x(finishMs)} y={y(eac) - 6} textAnchor="end" className="fill-rose-600" fontSize="9">EAC {formatMoney(eac, currency)}</text>
          </>
        )}

        {/* Earned value point (green) + actual cost point (amber) at today */}
        {nowInRange && ev > 0 && (
          <circle cx={nowX} cy={y(ev)} r="3.5" fill="#10b981" stroke="white" strokeWidth="1" />
        )}
        {nowInRange && hasActuals && ac != null && (
          <circle cx={nowX} cy={y(ac)} r="3.5" fill="#f59e0b" stroke="white" strokeWidth="1" />
        )}

        {/* X axis labels */}
        <text x={padL} y={H - 6} textAnchor="start" className="fill-[var(--color-text-faint)]" fontSize="9">{fmtD(startMs)}</text>
        <text x={padL + plotW} y={H - 6} textAnchor="end" className="fill-[var(--color-text-faint)]" fontSize="9">{fmtD(finishMs)}</text>
      </svg>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-[10px] text-[var(--color-text-muted)]">
        <Legend color="#3b82f6" label="Planned (PV)" />
        <Legend color="#10b981" label="Earned (EV)" />
        {hasActuals && <Legend color="#f59e0b" label="Actual (AC)" />}
        {hasActuals && <Legend color="#ef4444" label="Forecast (EAC)" dashed />}
        <span className="ml-auto italic text-[var(--color-text-faint)]">EV/AC are today&rsquo;s position</span>
      </div>
    </div>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <svg width="14" height="6" aria-hidden><line x1="0" y1="3" x2="14" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "3 2" : undefined} /></svg>
      {label}
    </span>
  );
}

// ─── CPI / SPI gauge ─────────────────────────────────────────────

function Gauge({ label, value }: { label: string; value: number | null }) {
  const cx = 50, cy = 50, r = 40;
  // Map an index 0.5..1.5 onto the semicircle (left → right).
  const polar = (idx: number) => {
    const frac = Math.max(0, Math.min(1, (idx - 0.5) / 1.0));
    const ang = Math.PI * (1 - frac);
    return { x: cx + r * Math.cos(ang), y: cy - r * Math.sin(ang) };
  };
  const seg = (from: number, to: number) => {
    const a = polar(from), b = polar(to);
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${r} ${r} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  };
  const v = value;
  const tone = v == null ? "#94a3b8" : v >= 1 ? "#10b981" : v >= 0.9 ? "#f59e0b" : "#ef4444";
  const needle = v != null ? polar(v) : null;
  const tick = polar(1.0);

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-2 text-center">
      <svg viewBox="0 0 100 60" className="w-full" role="img" aria-label={`${label} gauge`}>
        {/* zones */}
        <path d={seg(0.5, 0.9)} fill="none" stroke="#fecaca" strokeWidth="7" strokeLinecap="round" />
        <path d={seg(0.9, 1.0)} fill="none" stroke="#fde68a" strokeWidth="7" />
        <path d={seg(1.0, 1.5)} fill="none" stroke="#a7f3d0" strokeWidth="7" strokeLinecap="round" />
        {/* 1.0 target tick */}
        <line x1={cx} y1={cy} x2={tick.x} y2={tick.y} stroke="var(--color-text-faint)" strokeWidth="0.8" strokeDasharray="2 2" />
        {/* needle */}
        {needle && <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke={tone} strokeWidth="2.5" strokeLinecap="round" />}
        {needle && <circle cx={cx} cy={cy} r="3" fill={tone} />}
      </svg>
      <div className="-mt-1">
        <span className="text-lg font-black" style={{ color: tone }}>{v != null ? v.toFixed(2) : "—"}</span>
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] ml-1">{label}</span>
      </div>
    </div>
  );
}

// ─── Breakdown bars ──────────────────────────────────────────────

function Breakdown({ title, groups, currency }: { title: string; groups: GroupRollup[]; currency: string }) {
  const max = Math.max(1, ...groups.map((g) => g.budget));
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3">
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-2">{title}</div>
      <div className="space-y-2">
        {groups.slice(0, 6).map((g) => (
          <div key={g.key}>
            <div className="flex items-baseline justify-between text-[11px] mb-0.5">
              <span className="font-bold text-[var(--color-text)] truncate pr-2">{g.label}</span>
              <span className="text-[var(--color-text-muted)] font-mono shrink-0">{formatMoney(g.budget, currency)}</span>
            </div>
            <div className="relative h-2.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
              {/* committed (light) */}
              <div className="absolute inset-y-0 left-0 bg-blue-200" style={{ width: `${Math.min(100, (g.committed / max) * 100)}%` }} />
              {/* actual (solid) */}
              <div className="absolute inset-y-0 left-0 bg-amber-500" style={{ width: `${Math.min(100, (g.actual / max) * 100)}%` }} />
              {/* budget cap marker */}
              <div className="absolute inset-y-0 bg-[var(--color-text)]/40" style={{ left: `${Math.min(100, (g.budget / max) * 100)}%`, width: 1.5 }} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-2 text-[9px] text-[var(--color-text-muted)]">
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500" /> actual</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-200" /> committed</span>
        <span className="inline-flex items-center gap-1"><span className="w-px h-2.5 bg-[var(--color-text)]/40" /> budget</span>
      </div>
    </div>
  );
}
