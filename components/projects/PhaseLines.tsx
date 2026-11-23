"use client";

// PhaseLines - a project split in phases, all picked: one line per phase,
// each on its own plan (lib/phaseStanding). Phases run in separate weeks on
// one budget; a percent or an ahead/behind verdict blended across them says
// nothing true, so the schedule's summary cards show this in its place.

import React, { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { usePhases } from "@/components/projects/PhaseContext";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import { useCriticalMode } from "@/lib/criticalModeStore";
import { clockLabel, fmtInTz } from "@/lib/scheduleTz";
import { phaseDates } from "@/lib/projectPhases";
import { phaseStandings, standingWords, type PhaseStanding } from "@/lib/phaseStanding";

/** The phases' standings when the project is split and all are picked;
 *  null otherwise (one phase picked, or no phases): the caller shows its
 *  single summary. */
export function usePhaseStandings(projectId: string | undefined, nowMs: number): PhaseStanding[] | null {
  const ph = usePhases();
  const tz = useScheduleTz();
  const shiftTimes = useShiftTimes(projectId);
  const criticalMode = useCriticalMode(projectId);
  const split = ph.phases.length > 1 && ph.phase === null;
  return useMemo(() => (split ? phaseStandings(ph.all, ph.phases, { now: nowMs, tz, shiftTimes, criticalMode }) : null),
    [split, ph.all, ph.phases, nowMs, tz, shiftTimes, criticalMode]);
}

const TONE = {
  rose: "text-[var(--state-overdue-text)]", emerald: "text-[var(--state-released-text)]",
  amber: "text-[var(--state-held-text)]", slate: "text-[var(--color-text)]",
} as const;
const BAR = { rose: "bg-[var(--state-overdue)]", emerald: "bg-[var(--color-main)]", amber: "bg-[var(--state-held)]", slate: "bg-[var(--color-main)]" } as const;

export default function PhaseLines({ rows, print }: { rows: PhaseStanding[]; print?: boolean }) {
  const ph = usePhases();
  const tz = useScheduleTz();
  const when = (iso: string) => { const t = Date.parse(iso); return `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${clockLabel(t, tz)}`; };
  return (
    <div data-phase-lines>
      <div className={`flex items-baseline justify-between gap-2 ${print ? "mb-2" : "mb-1"}`}>
        <div className={print ? "text-[12px] font-semibold text-[var(--color-text-muted)]" : "text-[13px] font-semibold text-[var(--color-text-muted)]"}>By phase</div>
        <div className={`${print ? "text-[11px]" : "text-[12px]"} text-[var(--color-text-muted)]`}>Each phase against its own plan</div>
      </div>
      {/* On screen the phases are rows on the card, split by hairlines; on paper, a framed list. */}
      <ul className={`divide-y divide-[var(--color-border)] ${print ? "rounded-xl border border-[var(--color-border)]" : "-mx-2"}`}>
        {rows.map((s) => {
          const w = standingWords(s, when);
          const p = ph.phases.find((x) => x.id === s.id);
          const pick = !print && ph.pick ? () => ph.pick!(s.id) : undefined;
          const body = (
            <>
              <span className="flex items-baseline gap-2 flex-wrap">
                <b className={`${print ? "text-[14px]" : "text-[14px]"} text-[var(--color-text)]`}>{s.name}</b>
                {p && <span className={`${print ? "text-[12px]" : "text-[12px]"} text-[var(--color-text-muted)]`}>{phaseDates(p)}</span>}
                {s.steps > 0 && <span className={`${print ? "text-[12px]" : "text-[12px]"} text-[var(--color-text-muted)]`}>{s.done} of {s.steps} steps</span>}
              </span>
              {s.steps > 0 && (
                <span className="relative mt-1.5 block h-1.5 rounded-full bg-[var(--color-accent-soft)]">
                  {/* Finished work is a full, plain bar: how it finished is in the words. */}
                  <span className={`absolute inset-y-0 left-0 rounded-full ${s.state === "finished" ? BAR.slate : BAR[w.tone]}`} style={{ width: `${Math.min(100, s.pct)}%` }} />
                  {s.state === "running" && <span className="absolute -top-[3px] h-3 w-0.5 bg-[var(--color-text-muted)]" style={{ left: `calc(${Math.min(100, s.planPct)}% - 1px)` }} title={`Plan by now ${s.planPct}%`} />}
                </span>
              )}
              <span className={`mt-1.5 block text-[13px] font-bold ${TONE[w.tone]}`}>{w.head}</span>
              {w.lines.map((l) => <span key={l} className="block text-[12px] text-[var(--color-text-muted)]">{l}</span>)}
            </>
          );
          return (
            <li key={s.id} data-phase-line={s.id}>
              {pick ? (
                <button type="button" onClick={pick} title={`Open ${s.name}`} className="group flex w-full items-center gap-2 px-2 py-2.5 text-left rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
                  <span className="min-w-0 flex-1">{body}</span>
                  <ChevronRight className="w-4 h-4 shrink-0 text-[var(--color-text-faint)] group-hover:text-[var(--color-text-muted)]" />
                </button>
              ) : <div className={print ? "px-3 py-2.5" : "px-2 py-2.5"}>{body}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
