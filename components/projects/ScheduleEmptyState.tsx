"use client";

// ScheduleEmptyState — the first thing a brand-new user sees on a
// project with no schedule yet. Instead of a blank board, it offers the
// three ways to start, in plain language, biggest-value first. This is
// the front door for "an ignorant new user can handle complex tasks":
// no schedule jargon, just "what do you want to do."

import React from "react";
import { Sparkles, Upload, Plus, CalendarRange, ArrowRight } from "lucide-react";

interface Props {
  canEdit: boolean;
  onGenerate: () => void;
  onImport: () => void;
  onAdd: () => void;
}

export default function ScheduleEmptyState({ canEdit, onGenerate, onImport, onAdd }: Props) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden">
      <div className="px-6 py-8 text-center bg-gradient-to-b from-indigo-50/60 to-white border-b border-slate-100">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-900/20 mb-3">
          <CalendarRange className="w-7 h-7 text-white" />
        </div>
        <h2 className="text-lg font-black text-slate-900">Let&apos;s build your schedule</h2>
        <p className="text-sm text-slate-600 mt-1 max-w-md mx-auto">
          Pick how you want to start. You can mix and match later — everything lands in the same plan and runs in the Execution board.
        </p>
      </div>

      {canEdit ? (
        <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <StartCard
            tone="indigo"
            icon={<Sparkles className="w-5 h-5" />}
            badge="Easiest"
            title="Create with AI"
            body="Describe the job in plain English. We ask a couple of questions, then draft phases, tasks and dates for you to review."
            cta="Describe the work"
            onClick={onGenerate}
          />
          <StartCard
            tone="slate"
            icon={<Upload className="w-5 h-5" />}
            title="Import a schedule"
            body="Already have one? Drop a Microsoft Project (.mpp/.xml) or Primavera (.xer/.xml) file and we'll parse it — hierarchy and all."
            cta="Upload a file"
            onClick={onImport}
          />
          <StartCard
            tone="slate"
            icon={<Plus className="w-5 h-5" />}
            title="Start from scratch"
            body="Add tasks one at a time and build the structure yourself. Good for small jobs or quick punch lists."
            cta="Add a task"
            onClick={onAdd}
          />
        </div>
      ) : (
        <div className="p-8 text-center text-sm text-slate-500">
          No schedule has been created for this project yet.
        </div>
      )}
    </div>
  );
}

function StartCard({ tone, icon, badge, title, body, cta, onClick }: {
  tone: "indigo" | "slate";
  icon: React.ReactNode; badge?: string; title: string; body: string; cta: string; onClick: () => void;
}) {
  const accent = tone === "indigo"
    ? "border-indigo-200 hover:border-indigo-400 hover:shadow-indigo-100"
    : "border-slate-200 hover:border-slate-300";
  const iconBg = tone === "indigo" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600";
  const ctaCls = tone === "indigo" ? "text-indigo-700" : "text-slate-700";
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-xl border p-4 transition-all hover:shadow-md bg-white flex flex-col ${accent}`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-9 h-9 rounded-lg flex items-center justify-center ${iconBg}`}>{icon}</span>
        {badge && <span className="ml-auto text-[9px] font-black uppercase tracking-widest bg-indigo-600 text-white px-1.5 py-0.5 rounded-full">{badge}</span>}
      </div>
      <div className="mt-3 text-sm font-bold text-slate-900">{title}</div>
      <div className="mt-1 text-[12px] text-slate-500 leading-snug flex-1">{body}</div>
      <div className={`mt-3 inline-flex items-center gap-1 text-[12px] font-bold ${ctaCls}`}>
        {cta} <ArrowRight className="w-3.5 h-3.5" />
      </div>
    </button>
  );
}
