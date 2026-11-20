"use client";

// ProjectCoach — the wizard for the rest of the project's life.
//
// One strip under the project header: the health score (each part shows
// its work) and "what do I feed you" — the next most valuable inputs, each
// with its payoff stated and a deep link to the exact spot. Skipped wizard
// steps resurface here; new gaps (unread quotes, checklist items needing
// evidence, an outstanding turnover package) appear as the project runs.
// Pure engine (lib/projectHealth) + one bounded gather (lib/projectSnapshot).

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Sparkles, ArrowRight } from "lucide-react";
import { gatherProjectSnapshot } from "@/lib/projectSnapshot";
import { computeProjectHealth, buildCoachItems, type ProjectHealth, type CoachItem } from "@/lib/projectHealth";
import { ScoreDial, scoreBandColor } from "@/components/ui/ChartKit";

export default function ProjectCoach({ orgId, projectId, refreshKey }: {
  orgId: string;
  projectId: string;
  /** Bump to re-gather (e.g. after the page refreshes its own data). */
  refreshKey?: number;
}) {
  const [health, setHealth] = useState<ProjectHealth | null>(null);
  const [items, setItems] = useState<CoachItem[]>([]);
  // Folded to one line: the job's own results lead the Plan tab.
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await gatherProjectSnapshot(orgId, projectId);
        if (cancelled) return;
        setHealth(computeProjectHealth(snap));
        setItems(buildCoachItems(snap, projectId));
        setFailed(false);
      } catch {
        // The coach never breaks the page: it says it couldn't check.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, projectId, refreshKey]);

  const band = useMemo(() => {
    const s = health?.score;
    if (s == null) return "Getting started";
    if (s >= 85) return "Excellent";
    if (s >= 70) return "Good";
    if (s >= 50) return "Watch";
    return "Concern";
  }, [health]);

  if (!health) return (
    <div role="status" className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] px-4 sm:px-5 py-3 flex items-center gap-2 text-[14px]">
      <Sparkles className="w-4 h-4 text-[var(--color-text-muted)]" />
      <span className="font-bold text-[var(--color-text)]">Health</span>
      <span className="text-[13px] text-[var(--color-text-muted)]">{failed ? "Couldn't be checked right now." : "Checking…"}</span>
    </div>
  );
  const shown = showAll ? items : items.slice(0, 4);

  return (
    <div className="rounded-2xl bg-[var(--color-surface)] overflow-hidden shadow-[var(--shadow-card)]">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full px-4 sm:px-5 py-3 flex items-center gap-2 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
        {open ? <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />}
        <Sparkles className="w-4 h-4 text-[var(--color-text-muted)]" />
        <span className="text-[14px] font-bold text-[var(--color-text)]">Health</span>
        {health.score != null && (
          <span className="text-[12px] font-black tabular-nums whitespace-nowrap" style={{ color: scoreBandColor(health.score) }}>
            {health.score} · {band}
          </span>
        )}
        {items.length > 0 && (
          <span className="ml-auto text-[13px] font-semibold text-[var(--color-text-muted)] whitespace-nowrap">
            {items.length} <span className="max-sm:hidden">thing{items.length === 1 ? "" : "s"} not set up yet</span><span className="sm:hidden">to set up</span>
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 sm:px-5 pb-4 pt-1 border-t border-[var(--color-border)] grid grid-cols-1 md:grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3">
          {/* Health: the dial + each part showing its work. */}
          <div className="flex items-center gap-4 pt-2 min-w-0">
            <ScoreDial score={health.score} size={72} label={band} />
            <div className="space-y-1 min-w-0 flex-1">
              {health.parts.map((p) => (
                <div key={p.label} className="flex items-center gap-2 text-[11px]">
                  <span className="w-24 max-sm:w-20 shrink-0 font-bold text-[var(--color-text-muted)]">{p.label}</span>
                  {p.score != null ? (
                    <>
                      <span className="h-1.5 w-20 max-sm:w-12 rounded-full bg-[var(--viz-track)] overflow-hidden shrink-0">
                        <span className="block h-full rounded-full" style={{ width: `${p.score}%`, background: scoreBandColor(p.score) }} />
                      </span>
                      <span className="text-[var(--color-text-muted)] truncate" title={p.detail}>{p.detail}</span>
                    </>
                  ) : (
                    <span className="text-[var(--color-text-faint)] italic">{p.detail}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* The coach: what to feed the system next, payoff stated. */}
          <div className="pt-2 min-w-0">
            {items.length === 0 ? (
              <div className="text-xs text-[var(--color-text-muted)] italic">
                Nothing missing. New gaps show up here as the job runs.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {shown.map((it) => (
                  <li key={it.id}>
                    <Link href={it.href}
                      className="group flex items-start gap-2 rounded-lg px-2.5 py-2 hover:bg-[var(--color-surface-2)] transition-colors">
                      <ArrowRight className="w-3.5 h-3.5 mt-0.5 text-[var(--color-text-muted)] shrink-0 group-hover:translate-x-0.5 transition-transform" />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-bold text-[var(--color-text)]">{it.title}</span>
                        <span className="block text-[12px] text-[var(--color-text-muted)]">{it.payoff}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {items.length > 4 && (
              <button onClick={() => setShowAll((v) => !v)} className="mt-1.5 px-2.5 text-[13px] font-bold text-[var(--color-text)] hover:underline">
                {showAll ? "Show fewer" : `Show ${items.length - 4} more`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
