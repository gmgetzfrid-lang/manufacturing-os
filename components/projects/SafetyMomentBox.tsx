"use client";

// SafetyMomentBox — the turnover's safety topic.
//
// One topic, picked from what the next shift is doing, given the way a
// supervisor gives it: a line on why today, then five short things to say
// out loud — two on the work, the rest on the job around it — with sources.
// The other topics sit underneath, a tap away. Built in: no AI.

import { useMemo } from "react";
import { ShieldAlert } from "lucide-react";
import { rankHazards, type HazardJobInput } from "@/lib/safetyMoment";
import { safetyTalks, pickTalk, talkSources, projectFacts, type ProjectBase } from "@/lib/safetyTalk";
import type { ShiftWindow } from "@/lib/shiftReport";

const muted = "text-orange-900/75 dark:text-orange-200/70";

export function SafetyMomentBox({ jobs, shift, T, print, pick, onPick, project }: {
  jobs: HazardJobInput[];
  /** The shift being planned. */
  shift: ShiftWindow;
  T: (ms: number) => string;
  print: boolean;
  /** The topic picked at the meeting; the best one when none is. */
  pick?: string | null;
  onPick?: (key: string) => void;
  /** The project around the work: a turnaround, the day of the job, behind. */
  project?: ProjectBase;
}) {
  const talks = useMemo(() => safetyTalks(rankHazards(jobs, { shift, T }), shift, { project: projectFacts(project, shift, jobs.map((j) => j.name)) }),
    [jobs, shift, T, project]);
  const talk = pickTalk(talks, pick);
  // No work on the shift, no crew to talk to.
  if (!talk || jobs.length === 0) return null;
  const sources = talkSources(talk);
  const others = talks.filter((t) => t !== talk);

  return (
    <div className="keep rounded-md border border-orange-300 bg-orange-50/70 px-3 py-2 dark:border-orange-900 dark:bg-orange-950/25">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-orange-800 dark:text-orange-300">
          <ShieldAlert className="w-3 h-3 self-center" aria-hidden="true" /> Safety topic
        </span>
        <b className={`${print ? "text-[10pt]" : "text-[15px]"} text-[var(--color-text)]`}>{talk.title}</b>
      </div>
      <p className={`${print ? "text-[8pt]" : "text-[12px]"} ${muted}`}>{talk.today}</p>
      <ul className={`mt-1 list-disc space-y-1 pl-5 marker:text-orange-500 ${print ? "text-[9pt]" : "text-[14px]"} leading-snug text-[var(--color-text)]`}>
        {talk.points.map((p, i) => <li key={i}>{p.say}</li>)}
      </ul>
      {sources.length > 0 && (
        <div className={`mt-1 text-[10px] ${muted}`}>
          From{" "}
          {sources.map((s, i) => (
            <span key={s.url}>
              {i > 0 && " · "}
              <a href={s.url} target="_blank" rel="noreferrer" title={s.title}
                className="underline underline-offset-2 decoration-orange-300 dark:decoration-orange-800 hover:text-orange-950 dark:hover:text-orange-100">{s.label}</a>
            </span>
          ))}
        </div>
      )}
      {!print && onPick && others.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 print:hidden">
          <span className={`text-[10.5px] ${muted}`}>Other topic:</span>
          {others.map((t) => (
            <button key={t.key} type="button" onClick={() => onPick(t.key)}
              className="rounded-full border border-orange-300 dark:border-orange-800 px-2 py-px text-[10.5px] font-semibold text-orange-800 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-950/50">
              {t.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
