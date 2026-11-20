"use client";

// ScheduleEmptyState — the first thing a brand-new user sees on a
// project with no schedule yet. Instead of a blank board, it offers the
// three ways to start, in plain language, biggest-value first. This is
// the front door for "an ignorant new user can handle complex tasks":
// no schedule jargon, just "what do you want to do."

import React from "react";
import { Upload, Plus, CalendarRange, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/PageHero";

interface Props {
  canEdit: boolean;
  onImport: () => void;
  onAdd: () => void;
  /** A phase of the project with no schedule yet ("Transmix-2"). */
  phaseName?: string | null;
  /** A row on top of the card (setup still to finish). */
  lead?: React.ReactNode;
  /** The page's one orange action is elsewhere (the band): Import is quiet here. */
  quietMain?: boolean;
}

export default function ScheduleEmptyState({ canEdit, onImport, onAdd, phaseName, lead, quietMain }: Props) {
  return (
    <Card pad={false}>
      {lead && <div className="px-4 sm:px-5 pt-4">{lead}</div>}
      <div className="px-5 sm:px-6 pt-6 pb-5">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
          <CalendarRange className="w-3.5 h-3.5" /> Schedule
        </div>
        <h2 className="mt-2 text-[15px] font-bold text-[var(--color-text)]">{phaseName ? `No schedule in ${phaseName} yet.` : "No schedule yet."}</h2>
        <p className="text-[13px] text-[var(--color-text-muted)] mt-1 max-w-xl">
          {phaseName
            ? `Import ${phaseName}'s schedule file: it goes into ${phaseName} only and is tracked on its own. The other phases aren't touched, and All phases shows the whole project.`
            : "Import the schedule file you already have, or add tasks one at a time. Both land in the same plan."}
        </p>
      </div>

      {canEdit ? (
        // Two ways in, side by side on one card, split by a hairline.
        <div className="grid grid-cols-1 md:grid-cols-2 border-t border-[var(--color-border)] md:divide-x max-md:divide-y divide-[var(--color-border)]">
          <StartCard
            main={!quietMain}
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
        <div className="px-6 pb-6 text-[13px] text-[var(--color-text-muted)]">
          No schedule has been created for this project yet.
        </div>
      )}
    </Card>
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
      className="group text-left p-5 sm:p-6 flex flex-col hover:bg-[var(--color-surface-2)] transition-colors first:rounded-bl-2xl last:rounded-br-2xl max-md:first:rounded-bl-none max-md:last:rounded-b-2xl"
    >
      <span className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">{icon}</span>
      <div className="mt-3 text-[14px] font-bold text-[var(--color-text)]">{title}</div>
      <div className="mt-1 text-[13px] text-[var(--color-text-muted)] leading-snug flex-1">{body}</div>
      <div className={`mt-4 self-start inline-flex items-center gap-1.5 rounded-xl ${main
        ? "h-11 px-5 text-[14px] font-extrabold bg-[var(--color-accent)] text-[var(--color-accent-fg)] group-hover:bg-[var(--color-accent-hover)] shadow-[0_12px_24px_-12px_var(--color-accent)]"
        : "h-9 px-3 text-[13px] font-semibold bg-[var(--color-surface-2)] text-[var(--color-text)] group-hover:bg-[var(--color-border)]"}`}>
        {cta} <ArrowRight className="w-3.5 h-3.5" />
      </div>
    </button>
  );
}
