"use client";

// ExecutionGuide — the single, always-available "how this works" for
// the Execution view. Two pieces:
//
//   * A one-time first-run banner so a brand-new user gets oriented
//     without hunting.
//   * A "How it works" button (always in the toolbar) that opens a
//     plain-language cheat sheet, using the SAME icons the UI uses, so
//     nothing depends on discovering a hidden gesture.
//
// Design rule for this tool: every capability is named here. If we add
// an interaction, it gets a line here too — this is the contract that
// keeps the field user from being lost.

import React, { useState } from "react";
import {
  HelpCircle, X as XIcon, GripVertical, ChevronRight, ChevronLeft,
  CalendarRange, ListTree, CalendarDays, MousePointerClick,
} from "lucide-react";

const SEEN_KEY = "exec.guide.seen.v1";

export default function ExecutionGuide() {
  const [open, setOpen] = useState(false);
  // First-run: show the banner until the user has opened the guide or
  // dismissed it once.
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try { return window.localStorage.getItem(SEEN_KEY) === "1"; } catch { return true; }
  });

  const markSeen = () => {
    try { window.localStorage.setItem(SEEN_KEY, "1"); } catch { /* noop */ }
    setBannerDismissed(true);
  };

  return (
    <>
      {/* Toolbar trigger — always present. */}
      <button
        onClick={() => { setOpen(true); markSeen(); }}
        className="inline-flex items-center gap-1.5 text-[11px] font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-2.5 py-1.5 rounded-lg"
        title="How this view works"
      >
        <HelpCircle className="w-3.5 h-3.5" /> How it works
      </button>

      {/* First-run banner. */}
      {!bannerDismissed && (
        <div className="w-full flex items-center gap-2 bg-gradient-to-r from-indigo-50 to-white border border-indigo-200 rounded-lg px-3 py-2 text-xs text-slate-700">
          <MousePointerClick className="w-4 h-4 text-indigo-600 shrink-0" />
          <span className="flex-1">
            <b>New here?</b> This board runs the schedule day-by-day — move work, mark progress, and drill into sub-steps.
            <button onClick={() => { setOpen(true); markSeen(); }} className="ml-1 font-bold text-indigo-700 hover:underline">Show me how →</button>
          </span>
          <button onClick={markSeen} className="p-0.5 rounded hover:bg-black/5 text-slate-400" title="Dismiss"><XIcon className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Cheat-sheet panel. */}
      {open && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]" />
          <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl ring-1 ring-slate-900/10 overflow-hidden max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2 bg-gradient-to-b from-white to-slate-50/50">
              <HelpCircle className="w-5 h-5 text-indigo-600" />
              <h2 className="font-black text-slate-900">How the Execution board works</h2>
              <button onClick={() => setOpen(false)} className="ml-auto p-1.5 rounded-md text-slate-500 hover:bg-slate-100"><XIcon className="w-4 h-4" /></button>
            </div>

            <div className="overflow-y-auto p-5 space-y-5 text-sm text-slate-700">
              <Section title="Two ways to look at the schedule">
                <Row icon={<ListTree className="w-4 h-4 text-indigo-500" />} label="Timeline">
                  The work breakdown on the left, bars on a time axis on the right. Best for seeing sequence and overlap.
                </Row>
                <Row icon={<CalendarDays className="w-4 h-4 text-indigo-500" />} label="Calendar">
                  Each task sits on the day tiles it runs. Best for &quot;what&apos;s happening today.&quot;
                </Row>
              </Section>

              <Section title="Mark what's done (or doing, on-hold, blocked)">
                <Row icon={<span className="w-3.5 h-3.5 rounded-full bg-slate-400 border border-black/10 inline-block" />} label="The status dot">
                  Click the colored dot on any task or sub-item. A menu lets you set <b>Planned · In progress · Done · On hold · Blocked · Missed</b> — the same everywhere. On-hold and Blocked let you type a quick reason.
                </Row>
              </Section>

              <Section title="Move a whole task to different days">
                <Row icon={<GripVertical className="w-4 h-4 text-slate-500" />} label="Drag the grip handle">
                  Each task chip has a small grip on its right. Drag <i>that</i> onto another day. (Clicking the rest of the chip opens it.)
                </Row>
                <Row icon={<CalendarRange className="w-4 h-4 text-slate-500" />} label="Or open it & use the buttons">
                  Click a task to open it, then use the move buttons — no dragging needed.
                </Row>
              </Section>

              <Section title="Move just ONE sub-step (not the whole task)">
                <Row icon={<span className="inline-flex items-center justify-center w-4 h-4 rounded bg-indigo-600 text-white"><ChevronRight className="w-3 h-3" /></span>} label="Expand the task">
                  On the calendar, click a task&apos;s <b>▸</b> arrow (or flip <b>Show → Sub-items</b>). Its steps drop onto their own days.
                </Row>
                <Row icon={<GripVertical className="w-4 h-4 text-slate-500" />} label="Then move the one step">
                  Drag that step&apos;s grip handle to another day — or open the task and use the <ChevronLeft className="inline w-3 h-3" /> <ChevronRight className="inline w-3 h-3" /> buttons on each sub-step row.
                </Row>
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-[12px] text-emerald-900">
                  <b>The schedule keeps itself honest:</b> moving one step leaves the others where they were and stretches the parent to cover both. Example — you did 3 of 10 steps early; only those 3 move, the rest stay on plan, and the task now spans both.
                </div>
              </Section>

              <Section title="Fix the plan to match the field">
                <Row icon={<CalendarRange className="w-4 h-4 text-slate-500" />} label="Edit anything">
                  Open a task to change dates, who actually did it (vs. who was planned), work order #, location, add notes, or delete it.
                </Row>
              </Section>
            </div>

            <div className="px-5 py-3 border-t border-slate-200 bg-slate-50/60 flex justify-end">
              <button onClick={() => setOpen(false)} className="text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg">Got it</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 w-5 flex justify-center">{icon}</span>
      <div className="min-w-0">
        <span className="font-bold text-slate-900">{label}.</span>{" "}
        <span className="text-slate-600">{children}</span>
      </div>
    </div>
  );
}
