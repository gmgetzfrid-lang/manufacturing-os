"use client";

// SafetyMomentBox — the turnover's safety moment, in the space the old
// "safety moment" checkbox had.
//
// The next shift's riskiest kinds of work, ranked from the schedule, three
// lines each: the job, its hit list of essentials (permit, gas test,
// attendant …), and one "don't miss" lesson drawn from a real incident —
// what to look out for, then what prevents it — with its source. Built in:
// no AI, nothing to click, a different lesson each shift.

import { useMemo } from "react";
import { ShieldAlert } from "lucide-react";
import {
  HAZARD_KINDS, rankHazards, hazardContext, lessonFor, sourceLabel,
  type HazardJobInput,
} from "@/lib/safetyMoment";

const muted = "text-orange-900/75 dark:text-orange-200/70";

export function SafetyMomentBox({ jobs, shiftKind, shiftStart, print }: {
  jobs: HazardJobInput[];
  shiftKind: "day" | "night";
  /** The shift being planned — picks this shift's lessons. */
  shiftStart: number;
  print: boolean;
}) {
  const hazards = useMemo(() => rankHazards(jobs), [jobs]);
  if (hazards.length === 0) return null;
  const when = shiftKind === "night" ? "Tonight's" : "Today's";

  return (
    <div className="keep rounded-md border border-orange-300 bg-orange-50/70 px-3 py-1.5 dark:border-orange-900 dark:bg-orange-950/25">
      <div className="flex items-baseline gap-2">
        <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-orange-800 dark:text-orange-300">
          <ShieldAlert className="w-3 h-3 self-center" aria-hidden="true" /> Safety moment
        </span>
        <span className={`text-[11px] ${muted}`}>{when} {hazards.length === 1 ? "riskiest job" : `${hazards.length} riskiest jobs`}</span>
      </div>
      <ol className="divide-y divide-orange-200/80 dark:divide-orange-900/60">
        {hazards.map((h, i) => {
          const lesson = lessonFor(h.kind, shiftStart);
          return (
            <li key={h.kind} className={`py-1 ${print ? "text-[8.5pt]" : "text-[11.5px]"} leading-snug`}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <b className="text-[var(--color-text)]">{i + 1} · {h.label}</b>
                <span className={`text-[10.5px] ${muted}`}>{hazardContext(h)}</span>
              </div>
              <div className="text-[var(--color-text)]">
                {HAZARD_KINDS[h.kind].hitList.map((t, k) => (
                  <span key={t}>{k > 0 && <span className="text-orange-500 font-black" aria-hidden="true"> · </span>}{t}</span>
                ))}
              </div>
              {lesson && (
                <div className="text-[var(--color-text)]">
                  <span className="text-[9.5px] font-black uppercase tracking-wider text-orange-800 dark:text-orange-300">Don&apos;t miss </span>
                  {lesson.watch} <span className="text-orange-700 dark:text-orange-300" aria-hidden="true">→</span> <b>{lesson.prevent}</b>{" "}
                  <a href={lesson.source.url} target="_blank" rel="noreferrer" title={lesson.source.title}
                    className={`text-[10px] underline underline-offset-2 decoration-orange-300 dark:decoration-orange-800 ${muted} hover:text-orange-950 dark:hover:text-orange-100`}>
                    {sourceLabel(lesson.source)}
                  </a>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
