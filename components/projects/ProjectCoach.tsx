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
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await gatherProjectSnapshot(orgId, projectId);
        if (cancelled) return;
        setHealth(computeProjectHealth(snap));
        setItems(buildCoachItems(snap, projectId));
      } catch { /* coach is an enhancement — never breaks the page */ }
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

  if (!health) return null;
  const shown = showAll ? items : items.slice(0, 4);

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden shadow-sm mb-4">
      <button onClick={() => setOpen((v) => !v)} className="w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
        {open ? <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />}
        <Sparkles className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Project health &amp; coach</span>
        {health.score != null && (
          <span className="text-[11px] font-black tabular-nums" style={{ color: scoreBandColor(health.score) }}>
            {health.score} · {band}
          </span>
        )}
        {items.length > 0 && (
          <span className="ml-auto text-[10px] font-bold text-[var(--color-text-muted)]">
            {items.length} suggestion{items.length === 1 ? "" : "s"}
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-[var(--color-border)] grid md:grid-cols-[auto_1fr] gap-x-6 gap-y-3">
          {/* Health: the dial + each part showing its work. */}
          <div className="flex items-center gap-4 pt-2">
            <ScoreDial score={health.score} size={72} label={band} />
            <div className="space-y-1 min-w-52">
              {health.parts.map((p) => (
                <div key={p.label} className="flex items-center gap-2 text-[11px]">
                  <span className="w-24 shrink-0 font-bold text-[var(--color-text-muted)]">{p.label}</span>
                  {p.score != null ? (
                    <>
                      <span className="h-1.5 w-20 rounded-full bg-[var(--viz-track)] overflow-hidden shrink-0">
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
          <div className="pt-2">
            {items.length === 0 ? (
              <div className="text-xs text-[var(--color-text-muted)] italic">
                Nothing to ask for — the system has what it needs. New gaps will show up here as the job runs.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {shown.map((it) => (
                  <li key={it.id}>
                    <Link href={it.href}
                      className="group flex items-start gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 hover:border-[var(--color-accent-ring)] hover:bg-[var(--color-accent-soft)]/30 transition-colors">
                      <ArrowRight className="w-3.5 h-3.5 mt-0.5 text-[var(--color-accent)] shrink-0 group-hover:translate-x-0.5 transition-transform" />
                      <span className="min-w-0">
                        <span className="block text-xs font-bold text-[var(--color-text)]">{it.title}</span>
                        <span className="block text-[10px] text-[var(--color-text-muted)]">{it.payoff}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {items.length > 4 && (
              <button onClick={() => setShowAll((v) => !v)} className="mt-1.5 text-[10px] font-bold text-[var(--color-accent)] hover:underline">
                {showAll ? "Show fewer" : `Show all ${items.length}`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
