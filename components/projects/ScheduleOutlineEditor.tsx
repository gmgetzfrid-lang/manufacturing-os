"use client";

// ScheduleOutlineEditor — the build-and-link surface shared by the AI
// generator (to edit a proposed schedule) and the manual "build by hand"
// path. It's a small MS-Project-style outline:
//
//   • Add task (sibling) / Add sub-task (child) anywhere
//   • Indent / outdent to reshape the WBS
//   • Edit name, start, finish, work hours, responsible party
//   • LINK predecessors with a real relationship type (FS/SS/FF/SF) + lag
//
// It operates on a flat DraftTask[] with stable local ids and a 1-based
// outlineLevel (a row is a "summary" when the next row is deeper). The parent
// applies it — converting to importable rows — so this component stays pure UI.

import React, { useMemo, useState } from "react";
import {
  Plus, CornerDownRight, Trash2, Link2, X as XIcon,
  ChevronRight, ChevronLeft, Clock,
} from "lucide-react";
import { LINK_TYPES, LINK_TYPE_HINT, linkCode, type LinkType } from "@/lib/scheduleLinks";

export interface DraftLink { predLocalId: string; type: LinkType; lagDays: number }

export interface DraftTask {
  localId: string;
  name: string;
  /** 1-based outline depth. */
  outlineLevel: number;
  plannedStartAt: string | null; // ISO
  plannedAt: string;             // ISO finish
  durationHours: number | null;
  responsibleParty: string | null;
  links: DraftLink[];
}

let _seq = 0;
export function newLocalId(): string {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return `t${Date.now().toString(36)}-${(_seq++).toString(36)}`;
}

const startOf = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");
const mkStart = (date: string) => (date ? `${date}T06:00:00Z` : null);
const mkFinish = (date: string, fallback: string) => (date ? `${date}T18:00:00Z` : fallback);

/** Build a fresh single-task draft anchored at a start date. */
export function blankDraft(startDate?: string): DraftTask {
  const base = startDate ? `${startDate}T06:00:00Z` : new Date().toISOString();
  const fin = startDate ? `${startDate}T18:00:00Z` : new Date().toISOString();
  return { localId: newLocalId(), name: "", outlineLevel: 1, plannedStartAt: base, plannedAt: fin, durationHours: null, responsibleParty: null, links: [] };
}

interface Props {
  tasks: DraftTask[];
  onChange: (tasks: DraftTask[]) => void;
}

export default function ScheduleOutlineEditor({ tasks, onChange }: Props) {
  const [linkingFor, setLinkingFor] = useState<string | null>(null);

  // index → whether the row has children (the next row is deeper).
  const hasChildren = useMemo(() => tasks.map((t, i) => {
    const next = tasks[i + 1];
    return !!next && next.outlineLevel > t.outlineLevel;
  }), [tasks]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) m.set(t.localId, t.name || "(unnamed)");
    return m;
  }, [tasks]);

  const update = (i: number, patch: Partial<DraftTask>) => {
    const next = tasks.slice(); next[i] = { ...next[i], ...patch }; onChange(next);
  };

  // The contiguous descendant block of row i (rows deeper than it).
  const subtreeLen = (i: number): number => {
    let n = 0;
    for (let j = i + 1; j < tasks.length && tasks[j].outlineLevel > tasks[i].outlineLevel; j++) n++;
    return n;
  };

  const addSibling = (i: number) => {
    const level = tasks[i]?.outlineLevel ?? 1;
    const anchor = tasks[i];
    const t = blankDraft(startOf(anchor?.plannedStartAt ?? anchor?.plannedAt) || undefined);
    t.outlineLevel = level;
    const insertAt = i + 1 + subtreeLen(i); // after the row and its whole subtree
    const next = tasks.slice(); next.splice(insertAt, 0, t); onChange(next);
  };

  const addChild = (i: number) => {
    const anchor = tasks[i];
    const t = blankDraft(startOf(anchor?.plannedStartAt ?? anchor?.plannedAt) || undefined);
    t.outlineLevel = (anchor?.outlineLevel ?? 1) + 1;
    const next = tasks.slice(); next.splice(i + 1, 0, t); onChange(next);
  };

  const addTop = () => {
    const t = blankDraft(startOf(tasks[tasks.length - 1]?.plannedAt) || undefined);
    onChange([...tasks, t]);
  };

  const removeRow = (i: number) => {
    const count = 1 + subtreeLen(i);
    const removed = new Set(tasks.slice(i, i + count).map((t) => t.localId));
    const next = tasks.slice();
    next.splice(i, count);
    // Drop any links that pointed at the removed rows.
    for (let j = 0; j < next.length; j++) {
      const kept = next[j].links.filter((l) => !removed.has(l.predLocalId));
      if (kept.length !== next[j].links.length) next[j] = { ...next[j], links: kept };
    }
    onChange(next);
  };

  const indent = (i: number) => {
    if (i === 0) return; // can't indent the first row (no parent above)
    const prev = tasks[i - 1];
    if (tasks[i].outlineLevel > prev.outlineLevel) return; // already a child of prev
    const delta = 1;
    const count = 1 + subtreeLen(i);
    const next = tasks.slice();
    for (let j = i; j < i + count; j++) next[j] = { ...next[j], outlineLevel: next[j].outlineLevel + delta };
    onChange(next);
  };

  const outdent = (i: number) => {
    if (tasks[i].outlineLevel <= 1) return;
    const count = 1 + subtreeLen(i);
    const next = tasks.slice();
    for (let j = i; j < i + count; j++) next[j] = { ...next[j], outlineLevel: Math.max(1, next[j].outlineLevel - 1) };
    onChange(next);
  };

  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center">
        <div className="text-sm text-slate-500 mb-2">No tasks yet.</div>
        <button onClick={addTop} className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-lg">
          <Plus className="w-4 h-4" /> Add the first task
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
        {tasks.map((t, i) => (
          <Row
            key={t.localId}
            task={t}
            index={i}
            isSummary={hasChildren[i]}
            canIndent={i > 0 && tasks[i].outlineLevel <= tasks[i - 1].outlineLevel}
            canOutdent={t.outlineLevel > 1}
            linking={linkingFor === t.localId}
            allTasks={tasks}
            nameById={nameById}
            onToggleLinking={() => setLinkingFor((c) => (c === t.localId ? null : t.localId))}
            onChange={(patch) => update(i, patch)}
            onAddSibling={() => addSibling(i)}
            onAddChild={() => addChild(i)}
            onRemove={() => removeRow(i)}
            onIndent={() => indent(i)}
            onOutdent={() => outdent(i)}
          />
        ))}
      </div>
      <button onClick={addTop} className="inline-flex items-center gap-1.5 text-[12px] font-bold text-indigo-700 hover:text-indigo-900 px-2 py-1 rounded-md hover:bg-indigo-50">
        <Plus className="w-3.5 h-3.5" /> Add task
      </button>
    </div>
  );
}

function Row({
  task, index, isSummary, canIndent, canOutdent, linking, allTasks, nameById,
  onToggleLinking, onChange, onAddSibling, onAddChild, onRemove, onIndent, onOutdent,
}: {
  task: DraftTask; index: number; isSummary: boolean; canIndent: boolean; canOutdent: boolean;
  linking: boolean; allTasks: DraftTask[]; nameById: Map<string, string>;
  onToggleLinking: () => void; onChange: (patch: Partial<DraftTask>) => void;
  onAddSibling: () => void; onAddChild: () => void; onRemove: () => void;
  onIndent: () => void; onOutdent: () => void;
}) {
  const indentPx = 8 + (task.outlineLevel - 1) * 18;
  return (
    <div className="group bg-white">
      <div className="flex items-center gap-1.5 px-2 py-1.5" style={{ paddingLeft: indentPx }}>
        {isSummary
          ? <span className="shrink-0 text-[9px] font-black uppercase tracking-wider bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">Phase</span>
          : <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-slate-300" />}
        <input
          value={task.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Task name"
          className={`flex-1 min-w-0 text-[13px] bg-transparent outline-none border-b border-transparent focus:border-indigo-300 ${isSummary ? "font-bold text-slate-900" : "text-slate-700"}`}
        />
        {!isSummary && (
          <>
            <input type="date" value={startOf(task.plannedStartAt)} onChange={(e) => onChange({ plannedStartAt: mkStart(e.target.value) })} title="Start" className="shrink-0 text-[11px] text-slate-500 border border-slate-200 rounded px-1 py-0.5" />
            <input type="date" value={startOf(task.plannedAt)} onChange={(e) => onChange({ plannedAt: mkFinish(e.target.value, task.plannedAt) })} title="Finish" className="shrink-0 text-[11px] text-slate-500 border border-slate-200 rounded px-1 py-0.5" />
          </>
        )}
        {/* Controls */}
        <div className="shrink-0 flex items-center gap-0.5 opacity-40 group-hover:opacity-100 transition-opacity">
          <IconBtn title="Outdent" disabled={!canOutdent} onClick={onOutdent}><ChevronLeft className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn title="Indent (make a sub-task of the row above)" disabled={!canIndent} onClick={onIndent}><ChevronRight className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn title="Add a sub-task" onClick={onAddChild}><CornerDownRight className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn title="Add a task below" onClick={onAddSibling}><Plus className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn
            title="Link predecessors"
            onClick={onToggleLinking}
            className={task.links.length > 0 ? "text-indigo-600" : ""}
          >
            <Link2 className="w-3.5 h-3.5" />{task.links.length > 0 && <span className="text-[9px] font-bold ml-0.5">{task.links.length}</span>}
          </IconBtn>
          <IconBtn title="Remove" onClick={onRemove} className="hover:text-rose-600 hover:bg-rose-50"><Trash2 className="w-3.5 h-3.5" /></IconBtn>
        </div>
      </div>

      {/* Existing link chips */}
      {task.links.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pb-1.5" style={{ paddingLeft: indentPx + 22 }}>
          {task.links.map((l, li) => (
            <span key={li} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-800 text-[10px] font-semibold pl-1.5 pr-1 py-0.5">
              <span className="font-mono">{linkCode(l)}</span>
              <span className="truncate max-w-[140px]">{nameById.get(l.predLocalId) ?? "(removed)"}</span>
              <button onClick={() => onChange({ links: task.links.filter((_, j) => j !== li) })} className="p-0.5 rounded-full hover:bg-indigo-200/60" title="Remove link">
                <XIcon className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Inline link editor */}
      {linking && (
        <LinkPicker
          task={task} index={index} allTasks={allTasks}
          onAdd={(l) => onChange({ links: [...task.links.filter((x) => x.predLocalId !== l.predLocalId), l] })}
          onClose={onToggleLinking}
        />
      )}
    </div>
  );
}

function LinkPicker({ task, index, allTasks, onAdd, onClose }: {
  task: DraftTask; index: number; allTasks: DraftTask[];
  onAdd: (l: DraftLink) => void; onClose: () => void;
}) {
  const [pred, setPred] = useState("");
  const [type, setType] = useState<LinkType>("FS");
  const [lag, setLag] = useState("0");

  // Candidate predecessors: any OTHER task that wouldn't create a cycle and
  // isn't already linked.
  const candidates = useMemo(() => {
    const linked = new Set(task.links.map((l) => l.predLocalId));
    return allTasks.filter((t) =>
      t.localId !== task.localId && !linked.has(t.localId) && !wouldCycle(allTasks, task.localId, t.localId),
    );
  }, [allTasks, task]);

  const indentPx = 8 + (task.outlineLevel - 1) * 18 + 22;
  return (
    <div className="px-2 pb-2 pt-1 bg-indigo-50/40 border-t border-indigo-100" style={{ paddingLeft: indentPx }}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <select value={pred} onChange={(e) => setPred(e.target.value)} className="text-[11px] border border-slate-300 rounded px-1.5 py-1 bg-white max-w-[180px]">
          <option value="">{candidates.length === 0 ? "No eligible tasks" : "Predecessor…"}</option>
          {candidates.map((c) => <option key={c.localId} value={c.localId}>{c.name || "(unnamed)"}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value as LinkType)} className="text-[11px] border border-slate-300 rounded px-1.5 py-1 bg-white" title={LINK_TYPE_HINT[type]}>
          {LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="inline-flex items-center gap-1 text-[10px] text-slate-500"><Clock className="w-3 h-3" />lag
          <input type="number" value={lag} onChange={(e) => setLag(e.target.value)} className="w-12 text-[11px] border border-slate-300 rounded px-1 py-1" />
        </label>
        <button
          disabled={!pred}
          onClick={() => { if (pred) { onAdd({ predLocalId: pred, type, lagDays: Math.trunc(Number(lag) || 0) }); setPred(""); setLag("0"); setType("FS"); } }}
          className="text-[11px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-2 py-1 rounded disabled:opacity-40"
        >
          Add link
        </button>
        <button onClick={onClose} className="text-[11px] text-slate-500 hover:text-slate-800 px-1.5 py-1">Done</button>
      </div>
      <div className="text-[10px] text-slate-400 mt-1">{LINK_TYPE_HINT[type]} · index {index + 1}</div>
    </div>
  );
}

function IconBtn({ children, title, onClick, disabled, className = "" }: {
  children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; className?: string;
}) {
  return (
    <button
      type="button" title={title} disabled={disabled} onClick={onClick}
      className={`inline-flex items-center justify-center px-1 py-1 rounded text-slate-400 hover:text-slate-800 hover:bg-slate-100 disabled:opacity-25 disabled:hover:bg-transparent ${className}`}
    >
      {children}
    </button>
  );
}

/** Would linking task→pred create a cycle within the draft? */
function wouldCycle(tasks: DraftTask[], taskLocalId: string, predLocalId: string): boolean {
  if (taskLocalId === predLocalId) return true;
  const byId = new Map(tasks.map((t) => [t.localId, t]));
  const stack = [predLocalId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskLocalId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const l of byId.get(cur)?.links ?? []) stack.push(l.predLocalId);
  }
  return false;
}
