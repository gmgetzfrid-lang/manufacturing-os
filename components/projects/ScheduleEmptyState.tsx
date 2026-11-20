"use client";

// ScheduleEmptyState — the first thing a brand-new user sees on a
// project with no schedule yet. Instead of a blank board, it offers the
// three ways to start, in plain language, biggest-value first. This is
// the front door for "an ignorant new user can handle complex tasks":
// no schedule jargon, just "what do you want to do."

import React from "react";
import { Upload, Plus, CalendarRange, ArrowRight } from "lucide-react";

interface Props {
  canEdit: boolean;
  onImport: () => void;
  onAdd: () => void;
  /** A phase of the project with no schedule yet ("Transmix-2"). */
  phaseName?: string | null;
}

export default function ScheduleEmptyState({ canEdit, onImport, onAdd, phaseName }: Props) {
  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden">
      <div className="px-6 py-8 text-center border-b border-[var(--color-border)] bg-[var(--color-surface-2)]">
        <div className="w-12 h-12 mx-auto rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center mb-3">
          <CalendarRange className="w-6 h-6 text-[var(--color-text-muted)]" />
        </div>
        <h2 className="text-lg font-black text-[var(--color-text)]">{phaseName ? `No schedule in ${phaseName} yet` : "Let's build your schedule"}</h2>
        <p className="text-sm text-[var(--color-text-muted)] mt-1 max-w-md mx-auto">
          {phaseName
            ? `Import ${phaseName}'s schedule file: it goes into ${phaseName} only and is tracked on its own. The other phases aren't touched, and All phases shows the whole project.`
            : "Import the schedule file you already have, or add tasks one at a time. Both land in the same plan."}
        </p>
      </div>

      {canEdit ? (
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <StartCard
            main
            icon={<Upload className="w-5 h-5" />}
            title={phaseName ? `Import ${phaseName}'s schedule` : "Import a schedule"}
            body="A Microsoft Project XML or Primavera (.xer or .xml) file. Phases, tasks and steps come in as they are."
            cta="Pick the file"
            onClick={onImport}
          />
          <StartCard
            icon={<Plus className="w-5 h-5" />}
            title="Start from scratch"
            body="Add tasks one at a time. Good for small jobs or a punch list."
            cta="Add a task"
            onClick={onAdd}
          />
        </div>
      ) : (
        <div className="p-8 text-center text-sm text-[var(--color-text-muted)]">
          No schedule has been created for this project yet.
        </div>
      )}
    </div>
  );
}

function StartCard({ main, icon, title, body, cta, onClick }: {
  /** The one way in most people take: its button is the orange one. */
  main?: boolean;
  icon: React.ReactNode; title: string; body: string; cta: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-2xl border p-4 bg-[var(--color-surface)] flex flex-col border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
    >
      <span className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">{icon}</span>
      <div className="mt-3 text-sm font-bold text-[var(--color-text)]">{title}</div>
      <div className="mt-1 text-[12px] text-[var(--color-text-muted)] leading-snug flex-1">{body}</div>
      <div className={`mt-3 self-start inline-flex items-center gap-1 text-[12px] font-bold rounded-lg px-3 py-1.5 ${main
        ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] group-hover:bg-[var(--color-accent-hover)]"
        : "border border-[var(--color-border)] text-[var(--color-text)] group-hover:bg-[var(--color-surface-2)]"}`}>
        {cta} <ArrowRight className="w-3.5 h-3.5" />
      </div>
    </button>
  );
}
