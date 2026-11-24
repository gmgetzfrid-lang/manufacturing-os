"use client";

// ExecutionGuide — the single, always-available "how this works" for
// the Execution view: a ? button in the toolbar that opens a
// plain-language cheat sheet, using the SAME icons the UI uses, so
// nothing depends on discovering a hidden gesture.
//
// Design rule for this tool: every capability is named here. If we add
// an interaction, it gets a line here too — this is the contract that
// keeps the field user from being lost.

import React, { useState } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import {
  HelpCircle, X as XIcon, GripVertical, ChevronRight, ChevronLeft,
  CalendarRange, ListTree, CalendarDays,
} from "lucide-react";

// One home for the guide: the ? button. (The first-run "New here?" banner
// that also opened it is gone: one way in, and no banner over the work.)
export default function ExecutionGuide({ open: openProp, onOpenChange, buttonClass = "" }: {
  /** Open it from somewhere else (a More menu on a phone). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra classes for the ? button (e.g. hide it on a phone). */
  buttonClass?: string;
} = {}) {
  const [openSelf, setOpenSelf] = useState(false);
  const open = openProp ?? openSelf;
  const setOpen = (v: boolean) => { setOpenSelf(v); onOpenChange?.(v); };
  useEscapeClose(() => setOpen(false), open);

  return (
    <>
      {/* Toolbar trigger. */}
      <button
        onClick={() => setOpen(true)}
        className={`inline-flex items-center justify-center w-9 h-9 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors ${buttonClass}`}
        title="How this view works" aria-label="How this view works"
      >
        <HelpCircle className="w-4 h-4" />
      </button>

      {/* Cheat-sheet panel. */}
      {open && (
        <div role="dialog" aria-modal="true" aria-label="How this view works" className="fixed inset-0 z-[300] flex items-start sm:items-center justify-center overflow-y-auto p-4" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in" />
          <div className="relative w-full max-w-lg bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] overflow-hidden max-h-[85vh] flex flex-col animate-in fade-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-2">
              <HelpCircle className="w-5 h-5 text-[var(--color-text-muted)]" />
              <h2 className="text-reading font-medium text-[var(--color-text)]">How this view works</h2>
              <button onClick={() => setOpen(false)} aria-label="Close" className="ml-auto p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors"><XIcon className="w-4 h-4" /></button>
            </div>

            <div className="overflow-y-auto p-5 space-y-5 text-body text-[var(--color-text)]">
              <Section title="Two ways to look at the schedule">
                <Row icon={<ListTree className="w-4 h-4 text-[var(--color-text-muted)]" />} label="Timeline">
                  The work breakdown on the left, bars on a time axis on the right. Best for seeing sequence and overlap.
                </Row>
                <Row icon={<CalendarDays className="w-4 h-4 text-[var(--color-text-muted)]" />} label="Calendar">
                  Each task sits on the day tiles it runs. Best for &quot;what&apos;s happening today.&quot;
                </Row>
              </Section>

              <Section title="Mark what's done (or doing, on-hold, blocked)">
                <Row icon={<span className="w-3.5 h-3.5 rounded-full bg-slate-400 border border-black/10 inline-block" />} label="The status dot">
                  Click the colored dot on any task or sub-item. A menu lets you set <b>Planned · In progress · Done · On hold · Blocked · Missed</b>, the same everywhere. On-hold and Blocked let you type a quick reason.
                </Row>
              </Section>

              <Section title="Move a whole task to different days">
                <Row icon={<GripVertical className="w-4 h-4 text-[var(--color-text-muted)]" />} label="Drag the grip handle">
                  Each task chip has a small grip on its right. Drag <i>that</i> onto another day. (Clicking the rest of the chip opens it.)
                </Row>
                <Row icon={<CalendarRange className="w-4 h-4 text-[var(--color-text-muted)]" />} label="Or open it & use the buttons">
                  Click a task to open it, then use the move buttons. No dragging needed.
                </Row>
              </Section>

              <Section title="Move just ONE sub-step (not the whole task)">
                <Row icon={<span className="inline-flex items-center justify-center w-4 h-4 rounded bg-[var(--color-surface-2)] text-[var(--color-text)]"><ChevronRight className="w-3 h-3" /></span>} label="Expand the task">
                  On the calendar, click a task&apos;s <b>▸</b> arrow (or flip <b>Show → Sub-items</b>). Its steps drop onto their own days.
                </Row>
                <Row icon={<GripVertical className="w-4 h-4 text-[var(--color-text-muted)]" />} label="Then move the one step">
                  Drag that step&apos;s grip handle to another day, or open the task and use the <ChevronLeft className="inline w-3 h-3" /> <ChevronRight className="inline w-3 h-3" /> buttons on each sub-step row.
                </Row>
                <p className="text-caption text-[var(--color-text-muted)]">
                  Moving one step leaves the others where they were and stretches the task to cover both. Did 3 of 10 steps early? Only those 3 move; the rest stay on plan.
                </p>
              </Section>

              <Section title="Fix the plan to match the field">
                <Row icon={<CalendarRange className="w-4 h-4 text-[var(--color-text-muted)]" />} label="Edit anything">
                  Open a task to change dates, who actually did it (vs. who was planned), work order #, location, add notes, or delete it.
                </Row>
              </Section>
            </div>

            <div className="px-5 py-3 border-t border-[var(--color-border)] flex justify-end">
              <button onClick={() => setOpen(false)} className="h-10 text-body font-medium text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-5 rounded-xl transition-colors">Got it</button>
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
      <div className="text-body font-medium text-[var(--color-text-muted)] mb-2">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 w-5 flex justify-center">{icon}</span>
      <div className="min-w-0">
        <span className="font-medium text-[var(--color-text)]">{label}.</span>{" "}
        <span className="text-[var(--color-text-muted)]">{children}</span>
      </div>
    </div>
  );
}
