"use client";

// SafetyMomentBox — the turnover's safety topics, three side by side in the
// height of one: the job as a whole (a turnaround next to live units), then
// the two riskiest kinds of work on the shift being planned. Each card is
// built to talk from: a title, a line on why now, three points with the
// thing to do in bold. Tap a card to present it full screen, big enough to
// read to a room. On a phone the cards swipe sideways. Built in: no AI.

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, ShieldAlert, X } from "lucide-react";
import { rankHazards, type HazardJobInput, type HazardKind } from "@/lib/safetyMoment";
import { safetyBrief, splitLead, talkSources, projectFacts, RISKS_RANKED, type ProjectBase, type SafetyTopic } from "@/lib/safetyTalk";
import type { ShiftWindow } from "@/lib/shiftReport";

// Each card's color: the job in blue, the risks in red and orange.
const TONE = [
  { bar: "border-t-sky-500", num: "bg-sky-600", kick: "text-sky-800 dark:text-sky-300", dot: "bg-sky-500" },
  { bar: "border-t-rose-500", num: "bg-rose-600", kick: "text-rose-800 dark:text-rose-300", dot: "bg-rose-500" },
  { bar: "border-t-orange-500", num: "bg-orange-600", kick: "text-orange-800 dark:text-orange-300", dot: "bg-orange-500" },
];

export function SafetyMomentBox({ jobs, shift, T, print, project, recent, label }: {
  jobs: HazardJobInput[];
  /** The shift being planned. */
  shift: ShiftWindow;
  T: (ms: number) => string;
  print: boolean;
  /** The project around the work: a turnaround, its unit, the day of the job. */
  project?: ProjectBase;
  /** The risk cards of the shifts before (riskHistory): a kind of work two
   *  shifts running steps aside unless it's still clearly on top. */
  recent?: HazardKind[][];
  /** "Night shift Tue, Oct 27" — whose topics these are. */
  label?: string;
}) {
  const topics = useMemo(() => safetyBrief(rankHazards(jobs, { shift, T, max: RISKS_RANKED }), shift,
    { project: projectFacts(project, shift, jobs.map((j) => j.name)), recentRisks: recent }),
  [jobs, shift, T, project, recent]);
  const [presenting, setPresenting] = useState<number | null>(null);
  // No work on the shift, no crew to talk to.
  if (jobs.length === 0 || topics.length === 0) return null;

  return (
    <div className="keep space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-orange-800 dark:text-orange-300">
          <ShieldAlert className="w-3 h-3 self-center" aria-hidden="true" /> Safety topics{label ? ` — ${label}` : ""}
        </span>
        {!print && <span className="text-[11px] text-[var(--color-text-muted)]">Tap one to present it full screen</span>}
      </div>
      {/* No risky work at all: two topics, side by side at full width. */}
      <div className={print ? `grid ${topics.length === 2 ? "grid-cols-2" : "grid-cols-3"} gap-2` : `-mx-1 px-1 flex gap-2 overflow-x-auto snap-x snap-mandatory sm:grid ${topics.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"} sm:overflow-visible scroll-quiet`}>
        {topics.map((t, i) => (
          <TopicCard key={t.key + i} t={t} n={i + 1} tone={TONE[i % TONE.length]} print={print} onPresent={() => setPresenting(i)} />
        ))}
      </div>
      {presenting != null && <Presenter topics={topics} at={presenting} label={label} onMove={setPresenting} onClose={() => setPresenting(null)} />}
    </div>
  );
}

function TopicCard({ t, n, tone, print, onPresent }: { t: SafetyTopic; n: number; tone: (typeof TONE)[number]; print: boolean; onPresent: () => void }) {
  const sources = talkSources(t);
  return (
    <article
      onClick={print ? undefined : onPresent}
      className={`snap-start shrink-0 w-[86%] sm:w-auto min-w-0 flex flex-col rounded-lg border border-[var(--color-border)] border-t-4 ${tone.bar} bg-[var(--color-surface)] ${print ? "p-1.5" : "p-2.5 cursor-pointer hover:shadow-md transition-shadow"}`}>
      <div className="flex items-center gap-1.5">
        <span className={`shrink-0 w-4 h-4 rounded-full ${tone.num} text-white text-[10px] font-black flex items-center justify-center`}>{n}</span>
        <span className={`min-w-0 truncate text-[9.5px] font-black uppercase tracking-wider ${tone.kick}`}>{t.kicker}</span>
        {!print && (
          <button type="button" onClick={(e) => { e.stopPropagation(); onPresent(); }} title="Present this topic full screen" aria-label={`Present ${t.title}`}
            className="ml-auto shrink-0 p-0.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <h4 className={`mt-0.5 font-black leading-tight text-[var(--color-text)] ${print ? "text-[10pt]" : "text-[14.5px]"}`}>{t.title}</h4>
      <p className={`mt-0.5 leading-snug text-[var(--color-text-muted)] ${print ? "text-[7.5pt]" : "text-[11px]"}`}>{t.why}</p>
      <ul className={`mt-1.5 space-y-1.5 leading-snug text-[var(--color-text)] ${print ? "text-[8pt]" : "text-[12.5px]"}`}>
        {t.points.map((p, i) => {
          const [lead, rest] = splitLead(p.say);
          return (
            <li key={i} className="flex gap-1.5">
              <span className={`mt-[6px] shrink-0 w-1.5 h-1.5 rounded-full ${tone.dot}`} aria-hidden />
              <span><b>{lead}</b>{rest ? <span className="text-[var(--color-text-muted)]"> {rest}</span> : null}</span>
            </li>
          );
        })}
      </ul>
      {sources.length > 0 && (
        <div className="mt-auto pt-1.5 text-[9.5px] text-[var(--color-text-faint)] truncate">
          From {sources.map((s, i) => (
            <span key={s.url}>{i > 0 && " · "}<a href={s.url} target="_blank" rel="noreferrer" title={s.title} onClick={(e) => e.stopPropagation()} className="underline underline-offset-2 hover:text-[var(--color-text)]">{s.label}</a></span>
          ))}
        </div>
      )}
    </article>
  );
}

/** One topic at a time, big enough to read to a room. ← → between topics, Esc out. */
function Presenter({ topics, at, label, onMove, onClose }: { topics: SafetyTopic[]; at: number; label?: string; onMove: (i: number) => void; onClose: () => void }) {
  const t = topics[at];
  const tone = TONE[at % TONE.length];
  const sources = talkSources(t);
  useEffect(() => {
    // Caught first, so the report's own Present keys don't move under it.
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); }
      else if (e.key === "ArrowRight" || e.key === " ") { e.stopPropagation(); e.preventDefault(); onMove(Math.min(topics.length - 1, at + 1)); }
      else if (e.key === "ArrowLeft") { e.stopPropagation(); e.preventDefault(); onMove(Math.max(0, at - 1)); }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [at, topics.length, onMove, onClose]);
  return (
    <div className="fixed inset-0 z-[400] bg-slate-950 text-white flex flex-col" role="dialog" aria-modal="true" aria-label={`Safety topic ${at + 1} of ${topics.length}`}>
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/10">
        <ShieldAlert className="w-5 h-5 text-orange-400" aria-hidden />
        <span className="text-[13px] font-black uppercase tracking-widest text-white/70">Safety{label ? ` — ${label}` : ""}</span>
        <span className="ml-auto text-[13px] font-bold text-white/60 tabular-nums">{at + 1} / {topics.length}</span>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-md hover:bg-white/10"><X className="w-5 h-5" /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 sm:px-14 py-8 max-w-5xl w-full mx-auto">
        <div className="flex items-center gap-3">
          <span className={`w-9 h-9 rounded-full ${tone.num} text-white text-[18px] font-black flex items-center justify-center`}>{at + 1}</span>
          <span className="text-[15px] font-black uppercase tracking-widest text-white/70">{t.kicker}</span>
        </div>
        <h2 className="mt-3 text-[34px] sm:text-[48px] font-black leading-[1.05]">{t.title}</h2>
        <p className="mt-3 text-[18px] sm:text-[22px] text-white/75 leading-snug">{t.why}</p>
        <ol className="mt-8 space-y-6">
          {t.points.map((p, i) => {
            const [lead, rest] = splitLead(p.say);
            return (
              <li key={i} className="flex gap-4">
                <span className={`mt-3 shrink-0 w-3 h-3 rounded-full ${tone.dot}`} aria-hidden />
                <span className="text-[22px] sm:text-[30px] leading-snug"><b>{lead}</b>{rest ? <span className="text-white/70"> {rest}</span> : null}</span>
              </li>
            );
          })}
        </ol>
        {sources.length > 0 && <div className="mt-10 text-[13px] text-white/45">From {sources.map((s) => s.label).join(" · ")}</div>}
      </div>
      <div className="flex items-center justify-between px-5 py-3 border-t border-white/10">
        <button type="button" disabled={at === 0} onClick={() => onMove(at - 1)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[14px] font-bold hover:bg-white/10 disabled:opacity-30">
          <ChevronLeft className="w-5 h-5" /> {at > 0 ? topics[at - 1].title : "Back"}
        </button>
        <div className="flex gap-1.5" aria-hidden>
          {topics.map((_, i) => <span key={i} className={`w-2.5 h-2.5 rounded-full ${i === at ? "bg-white" : "bg-white/25"}`} />)}
        </div>
        {at < topics.length - 1 ? (
          <button type="button" onClick={() => onMove(at + 1)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[14px] font-bold hover:bg-white/10">
            {topics[at + 1].title} <ChevronRight className="w-5 h-5" />
          </button>
        ) : (
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-white text-slate-900 text-[14px] font-black">Done</button>
        )}
      </div>
    </div>
  );
}
