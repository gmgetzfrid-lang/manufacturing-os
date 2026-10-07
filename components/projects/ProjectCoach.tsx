"use client";

// ProjectCoach — the wizard for the rest of the project's life.
//
// One strip under the project header: the health score (each part shows
// its work) and "what do I feed you" — the next most valuable inputs, each
// with its payoff stated and a deep link to the exact spot. Skipped wizard
// steps resurface here; new gaps (unread quotes, checklist items needing
// evidence, an outstanding turnover package) appear as the project runs.
// Pure engine (lib/projectHealth) + one bounded gather (lib/projectSnapshot).
// The gather is aborted on unmount / re-key. Sharing a round is opt-in and
// the coach opts in only where no write can sit behind the request: the
// FIRST re-key, which is the Costs or Quality tab's mount-time refresh
// bumping the key while the coach's own mount round is still landing — so
// that tab mount does not re-run thirteen queries. The mount run gathers
// its own round (the page's refresh() shows a spinner and remounts the
// coach after every write), and every later re-key follows a mutation
// inside the tab, so both gather fresh.

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Sparkles, ArrowRight, AlertTriangle } from "lucide-react";
import { gatherProjectSnapshot, snapshotRekeyMayShare, type SnapshotPreRead } from "@/lib/projectSnapshot";
import { computeProjectHealth, buildCoachItems, type ProjectHealth, type CoachItem } from "@/lib/projectHealth";
import { ScoreDial, scoreBandColor } from "@/components/ui/ChartKit";

export default function ProjectCoach({ orgId, projectId, refreshKey, preRead }: {
  orgId: string;
  projectId: string;
  /** Bump to re-gather (e.g. after the page refreshes its own data). */
  refreshKey?: number;
  /** PERF-8: the project row and roster the page already read in this load
   *  — the gather does not read them again. */
  preRead?: SnapshotPreRead;
}) {
  const [health, setHealth] = useState<ProjectHealth | null>(null);
  const [items, setItems] = useState<CoachItem[]>([]);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const [readFailures, setReadFailures] = useState<string[]>([]);
  const [notMigrated, setNotMigrated] = useState<string[]>([]);
  // The key's initial and previous values: only the first change (a tab
  // mounting underneath) may share the round in flight; the mount run and
  // every later change must not be served from a round whose queries were
  // issued before a write.
  const keys = useRef<{ initial: number | undefined; prev: number | undefined }>({ initial: refreshKey, prev: refreshKey });
  // The latest pre-read, for the gather below (declared first, so it is
  // current when that effect runs in the same commit).
  const pre = useRef<SnapshotPreRead | undefined>(preRead);
  useEffect(() => { pre.current = preRead; }, [preRead]);

  useEffect(() => {
    // Abort on unmount / re-key: in-flight requests are cancelled (once no
    // other subscriber shares the round — the re-key's own run, subscribed
    // in the same tick, can still join it), not merely ignored.
    const controller = new AbortController();
    const share = snapshotRekeyMayShare(keys.current.initial, keys.current.prev, refreshKey);
    keys.current.prev = refreshKey;
    void (async () => {
      try {
        const snap = await gatherProjectSnapshot(orgId, projectId, { signal: controller.signal, share, pre: pre.current });
        if (controller.signal.aborted) return;
        setHealth(computeProjectHealth(snap));
        setItems(buildCoachItems(snap, projectId));
        setReadFailures(snap.readFailures ?? []);
        setNotMigrated(snap.notMigrated ?? []);
      } catch { /* coach is an enhancement — never breaks the page */ }
    })();
    return () => { controller.abort(); };
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
          // CHART-6: the figure wears a text token; the band's colour is a
          // mark beside it (the word carries the band too), never text paint.
          <span className="inline-flex items-center gap-1 text-[11px] font-black tabular-nums text-[var(--color-text)]">
            <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: scoreBandColor(health.score) }} />
            {health.score} · {band}
          </span>
        )}
        {items.length > 0 && (
          <span className="ml-auto text-[10px] font-bold text-[var(--color-text-muted)]">
            {items.length} suggestion{items.length === 1 ? "" : "s"}
          </span>
        )}
      </button>

      {open && readFailures.length > 0 && (
        <div role="status" className="mx-4 mt-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.08] px-2.5 py-1.5 text-[11px] text-[var(--color-text)]">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <span>Could not read {listJoin(readFailures)} — the parts of the score and the suggestions that depend on {readFailures.length === 1 ? "it" : "them"} are left out, not counted as empty.</span>
        </div>
      )}
      {open && notMigrated.length > 0 && (
        <div role="status" className="mx-4 mt-2 text-[11px] text-[var(--color-text-muted)]">
          The database has not been migrated for {listJoin(notMigrated)} (migration 20261013) — the parts of the score and the suggestions that need {notMigrated.length === 1 ? "it" : "them"} are left out until it is applied.
        </div>
      )}
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

/** "a", "a and b", "a, b and c". */
function listJoin(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
