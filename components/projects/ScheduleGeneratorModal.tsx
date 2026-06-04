"use client";

// ScheduleGeneratorModal — create a schedule with AI, from documents, or by
// hand. AI proposes; nothing is written until the user clicks Create.
//
//   1. Describe   — type the job AND/OR attach documents the AI SEES and reads
//                   (scope PDFs, marked-up drawings, vendor sequences, task
//                   spreadsheets, photos of a handwritten plan), plus a couple
//                   of optional structured fields. Or skip straight to "build
//                   by hand".
//   2. Clarify    — the AI asks only the questions that would change the
//                   schedule; the user answers inline (or skips).
//   3. Review     — the result lands in a full outline editor: add tasks &
//                   sub-tasks, indent/outdent, edit dates, and LINK
//                   predecessors with real relationship types (FS/SS/FF/SF) +
//                   lag — then Create.

import React, { useState } from "react";
import {
  Sparkles, X as XIcon, Loader2, ChevronRight, ChevronLeft, Wand2,
  CheckCircle2, AlertTriangle, Calendar, Users, Clock, RotateCcw,
  Paperclip, FileText, Image as ImageIcon, PencilRuler,
} from "lucide-react";
import { getAiProvider } from "@/lib/ai";
import type { ScheduleBrief, ScheduleQuestion, GeneratedSchedule, GeneratedTask, AiFileAttachment } from "@/lib/ai/types";
import { importMilestonesFromParsed } from "@/lib/milestones";
import ScheduleOutlineEditor, { type DraftTask, blankDraft, newLocalId } from "@/components/projects/ScheduleOutlineEditor";

interface Props {
  orgId: string;
  projectId: string;
  userId: string;
  userName?: string;
  /** Open straight into the manual outline builder (skips the AI describe step). */
  initialMode?: "ai" | "manual";
  onClose: () => void;
  onDone: () => void;
}

type Step = "describe" | "clarify" | "preview";

// Accepted upload types Gemini can read natively.
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.xml,.json,.md,application/pdf,image/*,text/plain,text/csv,text/xml,application/json";
const MAX_FILE_BYTES = 10 * 1024 * 1024;       // 10MB per file
const MAX_TOTAL_BASE64 = 18 * 1024 * 1024;     // ~13MB binary, matches the API guard

export default function ScheduleGeneratorModal({ orgId, projectId, userId, userName, initialMode = "ai", onClose, onDone }: Props) {
  const [step, setStep] = useState<Step>(initialMode === "manual" ? "preview" : "describe");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 fields
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [shiftPattern, setShiftPattern] = useState<ScheduleBrief["shiftPattern"]>(null);
  const [crew, setCrew] = useState("");
  const [attachments, setAttachments] = useState<AiFileAttachment[]>([]);

  // Step 2
  const [questions, setQuestions] = useState<ScheduleQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});

  // Step 3 — the editable outline (drafts) + metadata.
  const [title, setTitle] = useState("New schedule");
  const [notes, setNotes] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<DraftTask[]>(initialMode === "manual" ? [blankDraft()] : []);
  const [importResult, setImportResult] = useState<{ inserted: number; errors: string[] } | null>(null);

  const ai = getAiProvider();

  const buildBrief = (): ScheduleBrief => ({
    description: description.trim(),
    startDate: startDate || undefined,
    shiftPattern: shiftPattern ?? undefined,
    crew: crew.trim() || undefined,
    attachments: attachments.length ? attachments : undefined,
    answers: questions
      .map((q, i) => ({ question: q.question, answer: (answers[i] ?? "").trim() }))
      .filter((a) => a.answer.length > 0),
  });

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const next = [...attachments];
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_BYTES) { setError(`${file.name} is over 10MB — shrink it or remove it.`); continue; }
      try { next.push(await fileToAttachment(file)); }
      catch { setError(`Couldn't read ${file.name}.`); }
    }
    const total = next.reduce((n, a) => n + a.data.length, 0);
    if (total > MAX_TOTAL_BASE64) { setError("Attachments total over ~13MB — remove one."); return; }
    setAttachments(next);
  };

  // Step 1 → 2: ask clarifying questions. If none, jump to generate.
  const onDescribeNext = async () => {
    if (!description.trim() && attachments.length === 0) { setError("Describe the work or attach a document first."); return; }
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
      loadSchedule(result);
      setStep("preview");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const loadSchedule = (s: GeneratedSchedule) => {
    setTitle(s.title || "New schedule");
    setNotes(s.notes ?? []);
    setDrafts(generatedToDrafts(s.tasks));
  };

  // Apply: route the outline through the file-import pipeline (typed links + WBS).
  const onApply = async () => {
    if (drafts.length === 0) { setError("Add at least one task."); return; }
    if (drafts.every((d) => !d.name.trim())) { setError("Give your tasks names first."); return; }
    setBusy(true); setError(null);
    try {
      const rows = draftsToRows(drafts);
      const res = await importMilestonesFromParsed({
        orgId, projectId, source: "manual", rows, createdBy: userId, createdByName: userName,
      });
      setImportResult({ inserted: res.inserted, errors: res.errors });
      if (res.errors.length === 0 && res.inserted > 0) setTimeout(onDone, 700);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const headerSub = initialMode === "manual"
    ? "Build the schedule by hand — add tasks & sub-tasks, then link them."
    : "Describe the work or upload documents — we'll read them and build the schedule.";

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl ring-1 ring-slate-900/10 overflow-hidden flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3 bg-gradient-to-r from-indigo-50 via-white to-slate-50">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-black text-slate-900">Create a schedule</h2>
            <div className="text-[11px] text-slate-600">{headerSub} {!ai.isReal && initialMode !== "manual" && <span className="text-amber-700 font-bold">(local mode — connect AI to read documents)</span>}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-200 text-slate-500"><XIcon className="w-4 h-4" /></button>
        </div>

        {/* Stepper rail (hidden in pure manual mode) */}
        {initialMode !== "manual" && (
          <div className="px-5 py-2.5 border-b border-slate-100 flex items-center gap-2 text-[11px] font-bold">
            <Pip n={1} label="Describe" active={step === "describe"} done={step !== "describe"} />
            <ChevronRight className="w-3 h-3 text-slate-300" />
            <Pip n={2} label="Clarify" active={step === "clarify"} done={step === "preview"} />
            <ChevronRight className="w-3 h-3 text-slate-300" />
            <Pip n={3} label="Review & create" active={step === "preview"} done={false} />
          </div>
        )}

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
                <span className="text-[11px] text-slate-400">The more detail, the closer we get it. We&apos;ll ask about anything important you leave out.</span>
              </label>

              {/* Document upload — the AI reads these alongside the description. */}
              <AttachmentField attachments={attachments} onPick={onPickFiles} onRemove={(i) => setAttachments((a) => a.filter((_, j) => j !== i))} isReal={ai.isReal} />

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

              <button
                onClick={() => { setDrafts([blankDraft(startDate || undefined)]); setTitle("New schedule"); setNotes([]); setStep("preview"); }}
                className="inline-flex items-center gap-1.5 text-[12px] font-bold text-slate-600 hover:text-slate-900 border border-slate-200 px-2.5 py-1.5 rounded-lg hover:bg-slate-50"
              >
                <PencilRuler className="w-3.5 h-3.5" /> Prefer to build it yourself? Start a blank schedule
              </button>
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

          {step === "preview" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="flex-1 text-base font-bold text-slate-900 px-2 py-1 border border-transparent hover:border-slate-200 focus:border-indigo-400 rounded-md outline-none"
                />
                {initialMode !== "manual" && (
                  <button onClick={() => void runGenerate()} disabled={busy} className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 hover:text-slate-900 border border-slate-200 px-2 py-1 rounded-md hover:bg-slate-50">
                    <RotateCcw className="w-3 h-3" /> Regenerate
                  </button>
                )}
              </div>
              <div className="text-[11px] text-slate-500">
                Add tasks &amp; sub-tasks, indent to nest, and use the link button to set predecessors (FS/SS/FF/SF + lag). Everything is editable after you create it too.
              </div>

              {notes.length > 0 && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-900 space-y-0.5">
                  {notes.map((n, i) => <div key={i}>• {n}</div>)}
                </div>
              )}

              <ScheduleOutlineEditor tasks={drafts} onChange={setDrafts} />

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
            onClick={() => { if (step === "clarify") setStep("describe"); else if (step === "preview" && initialMode !== "manual") setStep(questions.length ? "clarify" : "describe"); else onClose(); }}
            disabled={busy}
            className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5"
          >
            {step === "describe" || (step === "preview" && initialMode === "manual") ? "Cancel" : <><ChevronLeft className="w-4 h-4" /> Back</>}
          </button>

          {step === "describe" && (
            <button onClick={() => void onDescribeNext()} disabled={busy || (!description.trim() && attachments.length === 0)} className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Continue
            </button>
          )}
          {step === "clarify" && (
            <button onClick={() => void runGenerate()} disabled={busy} className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Generate schedule
            </button>
          )}
          {step === "preview" && !importResult && (
            <button onClick={() => void onApply()} disabled={busy || drafts.length === 0} className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-lg disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Create {drafts.length} task{drafts.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Attachment field ──────────────────────────────────────────

function AttachmentField({ attachments, onPick, onRemove, isReal }: {
  attachments: AiFileAttachment[]; onPick: (f: FileList | null) => void; onRemove: (i: number) => void; isReal: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div>
      <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1"><Paperclip className="w-3 h-3" /> Documents</span>
      <div
        onClick={() => inputRef.current?.click()}
        onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onPick(e.dataTransfer.files); }}
        role="button" tabIndex={0}
        className={`mt-1 cursor-pointer rounded-lg border-2 border-dashed px-3 py-2.5 text-center transition-colors ${over ? "border-indigo-500 bg-indigo-50/60" : "border-slate-300 hover:border-indigo-400 hover:bg-slate-50/60"}`}
      >
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
        <div className="text-[12px] text-slate-600">
          <span className="font-semibold text-indigo-700">Drop or pick files</span> — scope PDF, drawing, vendor sequence, task list, or a photo of a plan.
        </div>
        <div className="text-[10px] text-slate-400 mt-0.5">PDF · images · CSV · text · XML. The AI reads them with your description.</div>
      </div>
      {attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {attachments.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 border border-slate-200 pl-2 pr-1 py-1 text-[11px] text-slate-700">
              {a.mimeType.startsWith("image/") ? <ImageIcon className="w-3 h-3 text-slate-500" /> : <FileText className="w-3 h-3 text-slate-500" />}
              <span className="truncate max-w-[160px] font-medium">{a.name}</span>
              <button onClick={(e) => { e.stopPropagation(); onRemove(i); }} className="p-0.5 rounded hover:bg-slate-300/60 text-slate-500" title="Remove"><XIcon className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}
      {attachments.length > 0 && !isReal && (
        <div className="mt-1 text-[10px] text-amber-700">Local mode can&apos;t read documents — connect AI (Gemini) to analyze them.</div>
      )}
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

// ─── File → attachment ─────────────────────────────────────────

async function fileToAttachment(file: File): Promise<AiFileAttachment> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { name: file.name, mimeType: file.type || guessMime(file.name), data: btoa(binary) };
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "pdf": return "application/pdf";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "csv": return "text/csv";
    case "xml": return "text/xml";
    case "json": return "application/json";
    case "txt": case "md": return "text/plain";
    default: return "application/octet-stream";
  }
}

// ─── Generated ⇆ draft conversion ──────────────────────────────

function generatedToDrafts(tasks: GeneratedTask[]): DraftTask[] {
  const ids = tasks.map(() => newLocalId());
  return tasks.map((t, i) => {
    // Prefer typed links; fall back to legacy dependsOn indices as FS+0.
    const rawLinks = t.links?.length
      ? t.links
      : (t.dependsOn ?? []).map((predIndex) => ({ predIndex, type: "FS" as const, lagDays: 0 }));
    const links = rawLinks
      .filter((l) => Number.isInteger(l.predIndex) && l.predIndex >= 0 && l.predIndex < tasks.length && l.predIndex !== i)
      .map((l) => ({ predLocalId: ids[l.predIndex], type: l.type, lagDays: Math.trunc(l.lagDays || 0) }));
    return {
      localId: ids[i],
      name: t.name,
      outlineLevel: t.outlineLevel ?? 1,
      plannedStartAt: t.plannedStartAt ?? t.plannedAt,
      plannedAt: t.plannedAt,
      durationHours: t.durationHours ?? null,
      responsibleParty: t.responsibleParty ?? null,
      links,
    };
  });
}

/** Convert the editable outline into importable rows: stable externalRefs,
 *  parent links from the outline, summary dates enveloping children, and
 *  typed dependency links. */
function draftsToRows(drafts: DraftTask[]) {
  const base = Date.now();
  const ref = (localId: string) => `gen:${base}:${localId}`;

  // Which rows are summaries (the next row is deeper) + envelope their dates.
  const isSummary = drafts.map((d, i) => { const n = drafts[i + 1]; return !!n && n.outlineLevel > d.outlineLevel; });
  const start = drafts.map((d) => Date.parse(d.plannedStartAt ?? d.plannedAt));
  const finish = drafts.map((d) => Date.parse(d.plannedAt));
  // Envelope deepest-first so nested summaries roll up correctly.
  for (let i = drafts.length - 1; i >= 0; i--) {
    if (!isSummary[i]) continue;
    let lo = Infinity, hi = -Infinity;
    for (let j = i + 1; j < drafts.length && drafts[j].outlineLevel > drafts[i].outlineLevel; j++) {
      if (Number.isFinite(start[j])) lo = Math.min(lo, start[j]);
      if (Number.isFinite(finish[j])) hi = Math.max(hi, finish[j]);
    }
    if (Number.isFinite(lo)) start[i] = lo;
    if (Number.isFinite(hi)) finish[i] = hi;
  }

  const rows = drafts.map((d, i) => ({
    name: d.name.trim() || "Untitled task",
    plannedAt: new Date(Number.isFinite(finish[i]) ? finish[i] : Date.now()).toISOString(),
    plannedStartAt: new Date(Number.isFinite(start[i]) ? start[i] : Date.now()).toISOString(),
    externalRef: ref(d.localId),
    parentExternalRef: null as string | null,
    outlineLevel: d.outlineLevel,
    isSummary: isSummary[i],
    durationHours: isSummary[i] ? null : d.durationHours,
    responsibleParty: d.responsibleParty,
    linksExternal: d.links.map((l) => ({ predExternalRef: ref(l.predLocalId), type: l.type, lagDays: l.lagDays })),
  }));
  reconstructFromOutline(rows);
  return rows;
}

/** Rebuild parent links from outline level (mirrors the file-import path). */
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
