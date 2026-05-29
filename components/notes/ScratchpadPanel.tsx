"use client";

// ScratchpadPanel — embeddable scratchpad UI. Drop into:
//   - document inspector (pass documentId)
//   - project page tab    (pass projectId)
//   - asset detail        (pass assetId)
//   - standalone           (omit all three)
//
// The panel:
//   - Lists existing notes scoped to the given attachment (or org-wide)
//   - Each note renders its body with inline checkbox tasks the user
//     can click to toggle
//   - "Add note" composer at the bottom
//   - Resolve / Reopen / Delete actions per note (author or admin)
//
// No AI dependency. AI-enhanced affordances (summarize, suggest
// follow-ups, generate handoff) layer on via lib/ai when a provider
// is configured — see AiAssistStrip below for the hook point.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  StickyNote, Plus, Loader2, AlertTriangle, Check, Pencil, Trash2,
  CheckCircle2, RotateCcw, ListChecks,
} from "lucide-react";
import {
  createNote, listNotes, updateNoteBody, setNoteResolved, deleteNote,
  extractTasks, toggleTaskInBody, type Note,
} from "@/lib/notes";
import { translatePostgresError } from "@/lib/inputValidation";
import { getAiProvider, type Entity } from "@/lib/ai";
import { Sparkles, Copy, ChevronDown } from "lucide-react";

interface ScratchpadPanelProps {
  orgId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  /** Scope. Provide at most one of these; omit all for org-wide. */
  documentId?: string;
  projectId?: string;
  assetId?: string;
  /** Optional title override. */
  title?: string;
  /** Whether the AI assist strip should render. Defaults true; the
   *  strip itself handles graceful "no provider" empty state. */
  showAiAssist?: boolean;
  /** Optional max-height for the list (defaults to auto). */
  listMaxHeight?: string;
}

export default function ScratchpadPanel({
  orgId, userId, userName, userEmail, userRole,
  documentId, projectId, assetId,
  title, showAiAssist = true, listMaxHeight,
}: ScratchpadPanelProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listNotes({
        orgId, documentId, projectId, assetId,
        resolved: showResolved ? undefined : false,
        // Standalone scratchpad notes are private; scoped notes
        // (documentId/projectId/assetId set) remain org-visible.
        actorUserId: userId,
      });
      setNotes(list);
    } catch (e) {
      const f = translatePostgresError(e, { entity: "note" });
      setError(`${f.heading} — ${f.message}`);
    } finally { setLoading(false); }
  }, [orgId, documentId, projectId, assetId, showResolved, userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const addNote = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createNote({
        orgId, body: draft,
        documentId: documentId ?? null,
        projectId: projectId ?? null,
        assetId: assetId ?? null,
        createdBy: userId, createdByName: userName,
        createdByEmail: userEmail, createdByRole: userRole,
      });
      setDraft(""); setComposerOpen(false);
      await refresh();
    } catch (e) {
      const f = translatePostgresError(e, { entity: "note" });
      setError(`${f.heading} — ${f.message}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between bg-slate-50/40">
        <div className="text-xs font-bold text-slate-700 inline-flex items-center gap-1.5">
          <StickyNote className="w-3.5 h-3.5 text-amber-600" />
          {title || "Scratchpad"}
          <span className="text-[10px] text-slate-500 font-mono">{notes.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-slate-600 inline-flex items-center gap-1">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            Include resolved
          </label>
          <button
            onClick={() => setComposerOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 hover:text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-1.5 py-1 rounded"
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
      </div>

      {/* Composer */}
      {composerOpen && (
        <div className="px-3 py-2 border-b border-slate-100 bg-amber-50/40">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder={"Type a note. Tasks: prefix lines with `- [ ]` (open) or `- [x]` (done)."}
            className="w-full text-xs border border-slate-300 rounded px-2 py-1.5 resize-y"
            autoFocus
          />
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button onClick={() => { setComposerOpen(false); setDraft(""); }} disabled={busy} className="text-[11px] text-slate-600 hover:text-slate-900 px-2 py-1">Cancel</button>
            <button
              onClick={addNote}
              disabled={!draft.trim() || busy}
              className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-amber-600 hover:bg-amber-700 px-2 py-1 rounded disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save
            </button>
          </div>
        </div>
      )}

      {/* AI assist strip (hidden if showAiAssist=false; renders empty if no provider) */}
      {showAiAssist && notes.length > 0 && (
        <AiAssistStrip notes={notes} />
      )}

      {/* Error */}
      {error && (
        <div className="m-2 flex items-start gap-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* Notes list */}
      <div className="overflow-y-auto" style={listMaxHeight ? { maxHeight: listMaxHeight } : undefined}>
        {loading ? (
          <div className="py-6 text-center text-xs text-slate-500 inline-flex items-center gap-2 justify-center w-full">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading notes…
          </div>
        ) : notes.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500 italic">
            No notes yet. Click <b>Add</b> to jot the first one.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {notes.map((n) => (
              <NoteRow
                key={n.id}
                note={n}
                canEdit={n.createdBy === userId || (!!userRole && (userRole === "Admin" || userRole === "DocCtrl"))}
                onAfterChange={refresh}
                actorUserId={userId}
                actorUserEmail={userEmail}
                actorUserRole={userRole}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── NoteRow ───────────────────────────────────────────────────

function NoteRow({
  note, canEdit, onAfterChange, actorUserId, actorUserEmail, actorUserRole,
}: {
  note: Note;
  canEdit: boolean;
  onAfterChange: () => void;
  actorUserId: string;
  actorUserEmail?: string;
  actorUserRole?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [busy, setBusy] = useState(false);
  const tasks = useMemo(() => extractTasks(note), [note]);
  const openTasks = tasks.filter((t) => !t.completed).length;

  const onToggleTask = async (lineIndex: number) => {
    const newBody = toggleTaskInBody(note.body, lineIndex);
    if (newBody === note.body) return;
    setBusy(true);
    try {
      await updateNoteBody({ id: note.id, body: newBody, updatedBy: actorUserId });
      onAfterChange();
    } finally { setBusy(false); }
  };

  const onResolve = async () => {
    setBusy(true);
    try {
      await setNoteResolved({ id: note.id, resolved: !note.resolved, actorUserId, actorUserEmail, actorUserRole });
      onAfterChange();
    } finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (!confirm("Delete this note? This action is audited.")) return;
    setBusy(true);
    try {
      await deleteNote(note.id, actorUserId, note.orgId);
      onAfterChange();
    } finally { setBusy(false); }
  };

  const saveEdit = async () => {
    if (!draft.trim() || draft === note.body) { setEditing(false); return; }
    setBusy(true);
    try {
      await updateNoteBody({ id: note.id, body: draft, updatedBy: actorUserId });
      setEditing(false);
      onAfterChange();
    } finally { setBusy(false); }
  };

  return (
    <div className={`px-3 py-2.5 ${note.resolved ? "opacity-60 bg-slate-50/40" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {editing ? (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.max(3, draft.split("\n").length)}
                className="w-full text-xs border border-slate-300 rounded px-2 py-1.5 resize-y font-mono"
                autoFocus
              />
              <div className="mt-1.5 flex items-center justify-end gap-2">
                <button onClick={() => { setEditing(false); setDraft(note.body); }} disabled={busy} className="text-[11px] text-slate-600 hover:text-slate-900 px-2 py-1">Cancel</button>
                <button onClick={saveEdit} disabled={busy} className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-amber-600 hover:bg-amber-700 px-2 py-1 rounded disabled:opacity-40">
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save
                </button>
              </div>
            </>
          ) : (
            <NoteBody body={note.body} tasks={tasks} onToggleTask={canEdit && !note.resolved ? onToggleTask : undefined} busy={busy} />
          )}
          <div className="mt-1 text-[10px] text-slate-400 flex items-center gap-2 flex-wrap">
            <span>{formatWhen(note.createdAt)}</span>
            {note.createdByName && <span>· {note.createdByName}</span>}
            {tasks.length > 0 && (
              <span className="inline-flex items-center gap-0.5">
                · <ListChecks className="w-3 h-3" /> {tasks.length - openTasks}/{tasks.length} done
              </span>
            )}
            {note.resolved && <span className="text-emerald-700 font-bold">· Resolved</span>}
          </div>
        </div>
        {canEdit && !editing && (
          <div className="shrink-0 flex items-center gap-0.5">
            <button onClick={() => setEditing(true)} disabled={busy} title="Edit" className="p-1 rounded text-slate-400 hover:text-amber-700 hover:bg-amber-50">
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button onClick={onResolve} disabled={busy} title={note.resolved ? "Reopen" : "Mark resolved"} className="p-1 rounded text-slate-400 hover:text-emerald-700 hover:bg-emerald-50">
              {note.resolved ? <RotateCcw className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            </button>
            <button onClick={onDelete} disabled={busy} title="Delete" className="p-1 rounded text-slate-400 hover:text-red-700 hover:bg-red-50">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NoteBody({ body, tasks, onToggleTask, busy }: { body: string; tasks: ReturnType<typeof extractTasks>; onToggleTask?: (lineIndex: number) => void; busy: boolean }) {
  // Render the body line-by-line. Task lines become interactive
  // checkboxes; other lines render as plain text.
  const taskByLine = new Map(tasks.map((t) => [t.lineIndex, t]));
  return (
    <div className="text-xs text-slate-800 whitespace-pre-wrap break-words font-sans">
      {body.split("\n").map((line, idx) => {
        const task = taskByLine.get(idx);
        if (task) {
          const today = new Date().toISOString().slice(0, 10);
          const overdue = !!task.dueAt && !task.completed && task.dueAt < today;
          const dueToday = !!task.dueAt && !task.completed && task.dueAt === today;
          const dueTone = overdue ? "bg-rose-100 text-rose-800"
            : dueToday ? "bg-amber-100 text-amber-800"
            : "bg-blue-100 text-blue-800";
          // Show the body with the due-marker stripped — the pill carries that info.
          const display = task.dueText ? task.body.replace(task.dueText, "").trim() : task.body;
          return (
            <div key={idx} className="flex items-start gap-1.5 py-0.5">
              <input
                type="checkbox"
                checked={task.completed}
                onChange={() => onToggleTask?.(idx)}
                disabled={!onToggleTask || busy}
                className="mt-[3px] accent-amber-600"
              />
              <span className={task.completed ? "line-through text-slate-400" : "text-slate-800"}>{display}</span>
              {task.dueAt && !task.completed && (
                <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${dueTone}`} title={`Due ${task.dueAt}`}>
                  {humanDueShort(task.dueAt)}
                </span>
              )}
            </div>
          );
        }
        return <div key={idx}>{line || " "}</div>;
      })}
    </div>
  );
}

function formatWhen(ts: string): string {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function humanDueShort(dueAt: string): string {
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(`${dueAt}T00:00:00`);
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diff < 0)  return `${-diff}d overdue`;
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff < 7)  return `${diff}d`;
  return dueAt;
}

// ─── AI assist strip ────────────────────────────────────────────
//
// Reads recent notes' bodies, calls into lib/ai for one of four
// non-mutating tasks: summarize, extract entities, suggest follow-
// ups, generate handoff. The result is shown inline; the user
// chooses whether to copy/paste any of it as a new note.
//
// Per the directive:
//   - AI never auto-applies anything to the database.
//   - With no real provider configured, the mock provider runs
//     and the strip shows a small "(mock)" badge.
//   - Errors / timeouts in the AI call don't break the panel.

type AiAction = "summarize" | "extract" | "followups" | "handoff";

function AiAssistStrip({ notes }: { notes: Note[] }) {
  const provider = getAiProvider();
  const [busy, setBusy] = useState<AiAction | null>(null);
  const [output, setOutput] = useState<{ action: AiAction; text: string; entities?: Entity[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Build the AI context from recent notes (last 20 unresolved).
  const context = notes.slice(0, 20).map((n) => n.body).join("\n\n");

  const run = async (action: AiAction) => {
    setBusy(action);
    setError(null);
    setOutput(null);
    try {
      if (action === "summarize") {
        const text = await provider.summarize(context);
        setOutput({ action, text });
      } else if (action === "extract") {
        const entities = await provider.extractEntities(context);
        const text = entities.length === 0
          ? "No entities detected."
          : entities.map((e) => `- ${e.kind}: ${e.text}`).join("\n");
        setOutput({ action, text, entities });
      } else if (action === "followups") {
        const lines = await provider.suggestFollowups(context);
        const text = lines.length === 0 ? "No follow-ups suggested." : lines.map((l) => `- [ ] ${l}`).join("\n");
        setOutput({ action, text });
      } else if (action === "handoff") {
        const text = await provider.generateHandoff(context);
        setOutput({ action, text });
      }
    } catch (e) {
      setError((e as Error).message || "AI call failed.");
    } finally {
      setBusy(null);
    }
  };

  const copyToClipboard = async () => {
    if (!output) return;
    try { await navigator.clipboard.writeText(output.text); } catch { /* noop */ }
  };

  return (
    <div className="border-b border-slate-100 bg-gradient-to-r from-violet-50/40 to-amber-50/30">
      <div className="px-3 py-1.5 flex items-center gap-1.5 flex-wrap">
        <Sparkles className="w-3.5 h-3.5 text-violet-600" />
        <span className="text-[10px] font-black uppercase tracking-widest text-violet-800">AI assist</span>
        {/* Status pill — green = real provider connected, slate = local
            heuristics fallback. The pill is dense and high-contrast so a
            user can tell at a glance whether their key is wired up. */}
        <span
          title={
            provider.isReal
              ? `Connected to ${provider.name}. Outputs are model-generated.`
              : `Local heuristic fallback (no API key configured). Outputs are regex-based, deterministic, and run entirely in-browser.`
          }
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider border ${
            provider.isReal
              ? "bg-emerald-50 text-emerald-700 border-emerald-300"
              : "bg-slate-100 text-slate-600 border-slate-300"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${provider.isReal ? "bg-emerald-500 animate-pulse" : "bg-slate-400"}`} />
          {provider.isReal ? "Live" : "Mock"}
        </span>
        <span className="text-[9px] font-mono text-slate-500">{provider.name}</span>
        <div className="ml-auto flex items-center gap-1 flex-wrap">
          <AiButton label="Summarize" onClick={() => run("summarize")} busy={busy === "summarize"} />
          <AiButton label="Entities"  onClick={() => run("extract")}    busy={busy === "extract"} />
          <AiButton label="Follow-ups" onClick={() => run("followups")} busy={busy === "followups"} />
          <AiButton label="Handoff"   onClick={() => run("handoff")}    busy={busy === "handoff"} />
        </div>
      </div>
      {(output || error) && (
        <div className="px-3 pb-2">
          {error && (
            <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
              {error}
            </div>
          )}
          {output && (
            <div className="bg-white border border-violet-200 rounded p-2">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10px] font-bold text-violet-700 uppercase tracking-widest">{labelFor(output.action)}</div>
                <button
                  onClick={copyToClipboard}
                  className="inline-flex items-center gap-1 text-[10px] text-slate-600 hover:text-slate-900 px-1.5 py-0.5 rounded hover:bg-slate-100"
                  title="Copy to clipboard — paste as a new note if you want to keep it."
                >
                  <Copy className="w-3 h-3" /> Copy
                </button>
              </div>
              <div className="text-[11px] text-slate-800 whitespace-pre-wrap break-words font-sans max-h-60 overflow-y-auto">
                {output.text}
              </div>
              <div className="mt-1 text-[10px] text-slate-500 italic">
                Suggestion only. Nothing was saved — copy and paste if you want to keep it as a note.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AiButton({ label, onClick, busy }: { label: string; onClick: () => void; busy: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1 text-[10px] font-bold text-violet-700 hover:text-violet-800 bg-violet-50 hover:bg-violet-100 border border-violet-200 px-1.5 py-0.5 rounded disabled:opacity-40"
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronDown className="w-3 h-3" />} {label}
    </button>
  );
}

function labelFor(a: AiAction): string {
  switch (a) {
    case "summarize": return "Summary";
    case "extract":   return "Entities";
    case "followups": return "Suggested follow-ups";
    case "handoff":   return "Handoff scaffold";
  }
}
