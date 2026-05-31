"use client";

// ScheduleGeneratorModal — create a schedule from plain English.
//
// A frictionless 4-step stepper:
//   1. Describe   — type what the job is, plus a couple of optional
//                   structured fields (start date, shift, crew).
//   2. Clarify    — the AI asks only the questions that would change
//                   the schedule; the user answers inline (or skips).
//   3. Preview    — the generated structure is shown as a hierarchy
//                   ("did we get this right?"). The user can tweak
//                   names/dates, regenerate, or refine the description.
//   4. Apply      — writes the rows through the SAME importer the file
//                   upload uses, so it lands in Execution identically.
//
// AI proposes; nothing is written until the user clicks Create.

import React, { useState } from "react";
import {
  Sparkles, X as XIcon, Loader2, ChevronRight, ChevronLeft, Wand2,
  CheckCircle2, AlertTriangle, Calendar, Users, Clock, RotateCcw,
} from "lucide-react";
import { getAiProvider } from "@/lib/ai";
import type { ScheduleBrief, ScheduleQuestion, GeneratedSchedule, GeneratedTask } from "@/lib/ai/types";
import { importMilestonesFromParsed } from "@/lib/milestones";

interface Props {
  orgId: string;
  projectId: string;
  userId: string;
  userName?: string;
  onClose: () => void;
  onDone: () => void;
}

type Step = "describe" | "clarify" | "preview";

export default function ScheduleGeneratorModal({ orgId, projectId, userId, userName, onClose, onDone }: Props) {
  const [step, setStep] = useState<Step>("describe");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 fields
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [shiftPattern, setShiftPattern] = useState<ScheduleBrief["shiftPattern"]>(null);
  const [crew, setCrew] = useState("");

  // Step 2
  const [questions, setQuestions] = useState<ScheduleQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});

  // Step 3
  const [schedule, setSchedule] = useState<GeneratedSchedule | null>(null);
  const [importResult, setImportResult] = useState<{ inserted: number; errors: string[] } | null>(null);

  const ai = getAiProvider();

  const buildBrief = (): ScheduleBrief => ({
    description: description.trim(),
    startDate: startDate || undefined,
    shiftPattern: shiftPattern ?? undefined,
    crew: crew.trim() || undefined,
    answers: questions
      .map((q, i) => ({ question: q.question, answer: (answers[i] ?? "").trim() }))
      .filter((a) => a.answer.length > 0),
  });

  // Step 1 → 2: ask clarifying questions. If none, jump to generate.
  const onDescribeNext = async () => {
    if (!description.trim()) { setError("Tell us what the work is first."); return; }
    setError(null); setBusy(true);
    try {
      const qs = await ai.clarifySchedule(buildBrief());
      if (qs.length === 0) { await runGenerate(); }
      else { setQuestions(qs); setAnswers({}); setStep("clarify"); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runGenerate = async () => {
    setError(null); setBusy(true);
    try {
      const result = await ai.generateSchedule(buildBrief());
      setSchedule(result);
      setStep("preview");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  // Apply: route the generated tasks through the file-import pipeline.
  const onApply = async () => {
    if (!schedule) return;
    setBusy(true); setError(null);
    try {
      const rows = schedule.tasks.map((t, i) => ({
        name: t.name,
        plannedAt: t.plannedAt,
        plannedStartAt: t.plannedStartAt ?? null,
        externalRef: `gen:${Date.now()}:${i}`,
        outlineLevel: t.outlineLevel ?? 1,
        isSummary: !!t.isSummary,
        durationHours: t.durationHours ?? null,
        responsibleParty: t.responsibleParty ?? null,
        description: t.description ?? null,
      }));
      // Reconstruct parent links from outline level — same as imports.
      reconstructFromOutline(rows);
      const res = await importMilestonesFromParsed({
        orgId, projectId, source: "manual", rows, createdBy: userId, createdByName: userName,
      });
      setImportResult({ inserted: res.inserted, errors: res.errors });
      if (res.errors.length === 0 && res.inserted > 0) setTimeout(onDone, 700);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl ring-1 ring-slate-900/10 overflow-hidden flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3 bg-gradient-to-r from-indigo-50 via-white to-slate-50">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-black text-slate-900">Create a schedule</h2>
            <div className="text-[11px] text-slate-600">Describe the work in plain English — we&apos;ll build the schedule. {!ai.isReal && <span className="text-amber-700 font-bold">(local mode — connect AI for best results)</span>}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-200 text-slate-500"><XIcon className="w-4 h-4" /></button>
        </div>

        {/* Stepper rail */}
        <div className="px-5 py-2.5 border-b border-slate-100 flex items-center gap-2 text-[11px] font-bold">
          <Pip n={1} label="Describe" active={step === "describe"} done={step !== "describe"} />
          <ChevronRight className="w-3 h-3 text-slate-300" />
          <Pip n={2} label="Clarify" active={step === "clarify"} done={step === "preview"} />
          <ChevronRight className="w-3 h-3 text-slate-300" />
          <Pip n={3} label="Review & create" active={step === "preview"} done={false} />
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" /> {error}
            </div>
          )}

          {step === "describe" && (
            <div className="space-y-4">
              <label className="block">
                <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500">What&apos;s the job?</span>
                <textarea
                  autoFocus
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  placeholder="e.g. 5-day turnaround on Unit 12 — shut down and depressure, swap exchangers E-204 and E-205, replace PSV-12, inspect tower T-301, then test and restart."
                  className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 resize-y"
                />
                <span className="text-[11px] text-slate-400">The more detail, the closer we get it the first time. We&apos;ll ask about anything important you leave out.</span>
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1"><Calendar className="w-3 h-3" /> Start date</span>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1 w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30" />
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" /> Shift</span>
                  <select value={shiftPattern ?? ""} onChange={(e) => setShiftPattern((e.target.value || null) as ScheduleBrief["shiftPattern"])} className="mt-1 w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30">
                    <option value="">—</option>
                    <option value="day-only">Day only</option>
                    <option value="day-night">Day + night</option>
                    <option value="24x7">24/7</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1"><Users className="w-3 h-3" /> Crew</span>
                  <input value={crew} onChange={(e) => setCrew(e.target.value)} placeholder="in-house / contractor" className="mt-1 w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30" />
                </label>
              </div>
            </div>
          )}

          {step === "clarify" && (
            <div className="space-y-4">
              <div className="text-sm text-slate-600 flex items-center gap-1.5"><Wand2 className="w-4 h-4 text-indigo-500" /> A few quick questions so we get it right:</div>
              {questions.map((q, i) => (
                <div key={i}>
                  <div className="text-[13px] font-bold text-slate-900">{q.question}</div>
                  {q.why && <div className="text-[11px] text-slate-400 mb-1">{q.why}</div>}
                  {q.options && q.options.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {q.options.map((opt) => (
                        <button
                          key={opt}
                          onClick={() => setAnswers((a) => ({ ...a, [i]: opt }))}
                          className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${answers[i] === opt ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-300 hover:border-indigo-400"}`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    value={answers[i] ?? ""}
                    onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))}
                    placeholder="Your answer (optional)"
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30"
                  />
                </div>
              ))}
            </div>
          )}

          {step === "preview" && schedule && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  value={schedule.title}
                  onChange={(e) => setSchedule({ ...schedule, title: e.target.value })}
                  className="flex-1 text-base font-bold text-slate-900 px-2 py-1 border border-transparent hover:border-slate-200 focus:border-indigo-400 rounded-md outline-none"
                />
                <button onClick={() => void runGenerate()} disabled={busy} className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 hover:text-slate-900 border border-slate-200 px-2 py-1 rounded-md hover:bg-slate-50">
                  <RotateCcw className="w-3 h-3" /> Regenerate
                </button>
              </div>
              <div className="text-[11px] text-slate-500">Does this look right? Edit any name or date below, then create. You can fine-tune everything after.</div>

              {schedule.notes.length > 0 && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-900 space-y-0.5">
                  {schedule.notes.map((n, i) => <div key={i}>• {n}</div>)}
                </div>
              )}

              <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 max-h-[40vh] overflow-y-auto">
                {schedule.tasks.map((t, i) => (
                  <TaskRow key={i} task={t} onChange={(nt) => {
                    const next = schedule.tasks.slice(); next[i] = nt; setSchedule({ ...schedule, tasks: next });
                  }} onDelete={() => {
                    setSchedule({ ...schedule, tasks: schedule.tasks.filter((_, j) => j !== i) });
                  }} />
                ))}
              </div>

              {importResult && (
                <div className={`rounded-lg p-3 border text-sm ${importResult.errors.length ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}>
                  {importResult.errors.length === 0
                    ? <span className="inline-flex items-center gap-1.5 font-bold text-emerald-800"><CheckCircle2 className="w-4 h-4" /> Created {importResult.inserted} tasks.</span>
                    : <span className="text-rose-700">{importResult.errors.slice(0, 3).join(" · ")}</span>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50/60 flex items-center justify-between gap-2">
          <button
            onClick={() => { if (step === "clarify") setStep("describe"); else if (step === "preview") setStep(questions.length ? "clarify" : "describe"); else onClose(); }}
            disabled={busy}
            className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5"
          >
            {step === "describe" ? "Cancel" : <><ChevronLeft className="w-4 h-4" /> Back</>}
          </button>

          {step === "describe" && (
            <button onClick={() => void onDescribeNext()} disabled={busy || !description.trim()} className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Continue
            </button>
          )}
          {step === "clarify" && (
            <button onClick={() => void runGenerate()} disabled={busy} className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Generate schedule
            </button>
          )}
          {step === "preview" && !importResult && (
            <button onClick={() => void onApply()} disabled={busy || schedule!.tasks.length === 0} className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-lg disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Create {schedule!.tasks.length} tasks
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Pip({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${active ? "text-indigo-700" : done ? "text-emerald-600" : "text-slate-400"}`}>
      <span className={`w-4 h-4 rounded-full inline-flex items-center justify-center text-[9px] ${active ? "bg-indigo-600 text-white" : done ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"}`}>
        {done ? "✓" : n}
      </span>
      {label}
    </span>
  );
}

function TaskRow({ task, onChange, onDelete }: { task: GeneratedTask; onChange: (t: GeneratedTask) => void; onDelete: () => void }) {
  const indent = Math.max(0, (task.outlineLevel ?? 1) - 1) * 16;
  const dateVal = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 group" style={{ paddingLeft: 12 + indent }}>
      {task.isSummary
        ? <span className="shrink-0 text-[9px] font-black uppercase tracking-wider bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">Phase</span>
        : <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-slate-300" />}
      <input
        value={task.name}
        onChange={(e) => onChange({ ...task, name: e.target.value })}
        className={`flex-1 min-w-0 text-[13px] bg-transparent outline-none border-b border-transparent focus:border-indigo-300 ${task.isSummary ? "font-bold text-slate-900" : "text-slate-700"}`}
      />
      {!task.isSummary && (
        <>
          <input type="date" value={dateVal(task.plannedStartAt)} onChange={(e) => onChange({ ...task, plannedStartAt: e.target.value ? `${e.target.value}T06:00:00Z` : null })} className="shrink-0 text-[11px] text-slate-500 border border-slate-200 rounded px-1 py-0.5" title="Start" />
          <input type="date" value={dateVal(task.plannedAt)} onChange={(e) => onChange({ ...task, plannedAt: e.target.value ? `${e.target.value}T18:00:00Z` : task.plannedAt })} className="shrink-0 text-[11px] text-slate-500 border border-slate-200 rounded px-1 py-0.5" title="Finish" />
        </>
      )}
      <button onClick={onDelete} title="Remove" className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50">
        <XIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/** Rebuild parent links from outline level for the generated rows
 *  (mirrors the file-import path so hierarchy lands correctly). */
function reconstructFromOutline(rows: Array<{ externalRef?: string | null; parentExternalRef?: string | null; outlineLevel?: number | null }>): void {
  const recentByLevel = new Map<number, string>();
  for (const r of rows) {
    const lvl = r.outlineLevel ?? 1;
    if (r.externalRef && !r.parentExternalRef) {
      for (let l = lvl - 1; l >= 0; l--) {
        const p = recentByLevel.get(l);
        if (p && p !== r.externalRef) { r.parentExternalRef = p; break; }
      }
    }
    if (r.externalRef) {
      recentByLevel.set(lvl, r.externalRef);
      for (const k of Array.from(recentByLevel.keys())) if (k > lvl) recentByLevel.delete(k);
    }
  }
}
