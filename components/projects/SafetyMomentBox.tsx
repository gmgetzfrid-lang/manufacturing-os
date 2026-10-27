"use client";

// SafetyMomentBox — the turnover's safety moment.
//
// The next shift's riskiest work, ranked from its steps. For each: why it
// made the list, what's specific to these steps tonight (crews meeting on
// the same equipment, a hand-off, a note, a job picked up part-way), two
// veteran checks, and one "don't miss" lesson from a real incident with
// its source. Built in: no AI, a different check and lesson each shift.

import { useMemo } from "react";
import { ShieldAlert } from "lucide-react";
import { rankHazards, hazardContext, lessonFor, checksFor, sourceLabel, type HazardJobInput } from "@/lib/safetyMoment";
import type { ShiftWindow } from "@/lib/shiftReport";

const muted = "text-orange-900/75 dark:text-orange-200/70";
const tag = "text-[9.5px] font-black uppercase tracking-wider text-orange-800 dark:text-orange-300";

export function SafetyMomentBox({ jobs, shift, T, print }: {
  jobs: HazardJobInput[];
  /** The shift being planned. */
  shift: ShiftWindow;
  T: (ms: number) => string;
  print: boolean;
}) {
  const hazards = useMemo(() => rankHazards(jobs, { shift, T }), [jobs, shift, T]);
  if (hazards.length === 0) return null;
  const when = shift.kind === "night" ? "Tonight's" : "Today's";

  return (
    <div className="keep rounded-md border border-orange-300 bg-orange-50/70 px-3 py-1.5 dark:border-orange-900 dark:bg-orange-950/25">
      <div className="flex items-baseline gap-2">
        <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-orange-800 dark:text-orange-300">
          <ShieldAlert className="w-3 h-3 self-center" aria-hidden="true" /> Safety moment
        </span>
        <span className={`text-[11px] ${muted}`}>{when} {hazards.length === 1 ? "riskiest work" : `${hazards.length} riskiest`}</span>
      </div>
      <ol className="divide-y divide-orange-200/80 dark:divide-orange-900/60">
        {hazards.map((h, i) => {
          const lesson = lessonFor(h.kind, shift.start);
          return (
            <li key={h.kind} className={`py-1.5 space-y-0.5 ${print ? "text-[8.5pt]" : "text-[12px]"} leading-snug`}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <b className="text-[var(--color-text)]">{i + 1} · {h.label}</b>
                <span className={`text-[10.5px] ${muted}`}>{hazardContext(h)}</span>
              </div>
              <div className={`text-[11px] ${muted}`}><span className={tag}>Why it&apos;s here </span>{h.why.join(" · ")}</div>
              {h.tonight.slice(0, 2).map((t, k) => (
                <div key={k} className="text-[var(--color-text)]"><span className={tag}>{k === 0 ? "On these steps " : "Also "}</span>{t}</div>
              ))}
              <div className="text-[var(--color-text)]"><span className={tag}>Veteran check </span>{checksFor(h.kind, shift.start, 2, h.jobs.map((j) => `${j.equipment ?? ""} ${j.name}`)).join(" ")}</div>
              {lesson && (
                <div className="text-[var(--color-text)]">
                  <span className={tag}>Don&apos;t miss </span>
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
