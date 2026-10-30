"use client";

// components/documents/ConnectPreview.tsx — what Connect everything will
// send to AI, before it sends anything.
//
// Every library, with a tick for this run and the never-AI switch beside
// it. For each library being read: its files by state (already read and
// reused, new, revised, held back, not current, not a PDF), and the
// drawings that will go to the person's model whole. At the top, plainly,
// what leaves the server and on whose key. Nothing runs until Start.

import React, { useMemo, useState } from "react";
import { X, Loader2, Lock, FileText, ChevronRight, ChevronDown, Send, ShieldOff } from "lucide-react";
import LibraryAiSwitch from "@/components/documents/LibraryAiSwitch";
import type { ConnectPlan, PlanFileState } from "@/lib/estate/connectPlan";

const STATE: Record<PlanFileState, { label: string; tone: string; sent: boolean }> = {
  new: { label: "new - will be read", tone: "bg-sky-50 border-sky-200 text-sky-800", sent: true },
  revised: { label: "new revision - read again", tone: "bg-sky-50 border-sky-200 text-sky-800", sent: true },
  read: { label: "already read - reused, nothing sent", tone: "bg-emerald-50 border-emerald-200 text-emerald-800", sent: false },
  held_back: { label: "held back from AI", tone: "bg-rose-50 border-rose-200 text-rose-700", sent: false },
  not_current: { label: "superseded or archived - never read", tone: "bg-slate-50 border-slate-200 text-slate-600", sent: false },
  not_pdf: { label: "not a PDF - not read", tone: "bg-slate-50 border-slate-200 text-slate-600", sent: false },
};

export default function ConnectPreview({ orgId, plan, loading, canChange, onStart, onClose, onReplan }: {
  orgId: string; plan: ConnectPlan; loading: boolean; canChange: boolean;
  onStart: (libraryIds: string[]) => void; onClose: () => void; onReplan: (libraryIds: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(plan.libraries.filter((l) => l.selected).map((l) => l.id)));
  const [open, setOpen] = useState<string | null>(null);
  const chosen = plan.libraries.filter((l) => l.selected);
  const totals = useMemo(() => {
    let read = 0, toRead = 0, census = 0, blocked = 0;
    for (const l of chosen) { read += l.counts.read; toRead += l.counts.new + l.counts.revised; census += l.toCensus; blocked += l.counts.held_back; }
    return { read, toRead, census, blocked };
  }, [chosen]);
  const pickedNow = [...picked].filter((id) => !plan.libraries.find((l) => l.id === id)?.neverAi);
  const dirty = pickedNow.sort().join(",") !== chosen.map((l) => l.id).sort().join(",");
  const model = plan.model.model ? `${plan.model.provider ?? ""} · ${plan.model.model}` : null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 p-4 border-b border-[var(--color-border)]">
          <div>
            <div className="text-base font-black">Before anything is sent to AI</div>
            <div className="text-xs text-[var(--color-text-muted)]">Nothing has run yet. Check what will be read, change it, then press Start.</div>
          </div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-4 space-y-3 text-xs">
          <div className="rounded-xl border border-violet-200 bg-violet-50/60 dark:bg-violet-950/20 p-3 space-y-1">
            <div className="font-bold inline-flex items-center gap-1.5"><Send className="w-3.5 h-3.5 text-violet-700" /> What leaves the server, on {model ? <>your key ({model})</> : <>your AI key</>}</div>
            <ul className="list-disc pl-5 space-y-0.5 text-[var(--color-text)]">
              <li><b>{totals.toRead}</b> file{totals.toRead === 1 ? "" : "s"} will be read. Their text is read on our server and is <b>not</b> sent anywhere. Only pages with no usable text are sent to your model as images.</li>
              <li><b>{totals.census}</b> drawing{totals.census === 1 ? "" : "s"} will be sent to your model whole, plus four zoomed tiles each, to read their equipment.</li>
              <li><b>{totals.read}</b> file{totals.read === 1 ? " is" : "s are"} already read. Those readings are reused and nothing is sent for them.</li>
              {totals.blocked > 0 && <li><b>{totals.blocked}</b> file{totals.blocked === 1 ? " is" : "s are"} held back from AI and will not be touched.</li>}
            </ul>
            {!plan.hasKey && <div className="text-amber-800">No AI key on your account. Text will still be read on the server, but nothing can be sent to a model until you add a key in Intelligence › Setup.</div>}
            <div className="text-[11px] text-[var(--color-text-muted)]">Only Admin and Doc Control can run this. Every change it makes to a drawing is recorded and can be undone afterwards.</div>
          </div>

          <div className="font-bold">Libraries</div>
          <ul className="space-y-1.5">
            {plan.libraries.map((l) => {
              const isOpen = open === l.id;
              const tick = picked.has(l.id) && !l.neverAi;
              return (
                <li key={l.id} className={`rounded-xl border ${l.neverAi ? "border-rose-200 bg-rose-50/40" : "border-[var(--color-border)]"} p-2`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <label className={`inline-flex items-center gap-1.5 font-bold ${l.neverAi ? "opacity-60" : "cursor-pointer"}`}>
                      <input type="checkbox" checked={tick} disabled={l.neverAi} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(l.id); else n.delete(l.id); return n; })} className="w-3.5 h-3.5 accent-[var(--color-accent)]" />
                      {l.neverAi ? <ShieldOff className="w-3.5 h-3.5 text-rose-600" /> : <FileText className="w-3.5 h-3.5" />} {l.name}
                    </label>
                    <span className="text-[var(--color-text-muted)]">{l.files} file{l.files === 1 ? "" : "s"}{l.drawings ? " · drawings" : ""}</span>
                    <span className="ml-auto"><LibraryAiSwitch orgId={orgId} libraryId={l.id} libraryName={l.name} excluded={l.neverAi} canChange={canChange} compact onChanged={() => onReplan(pickedNow.filter((id) => id !== l.id))} /></span>
                  </div>
                  {l.selected && (
                    <div className="mt-1.5 pl-5">
                      <div className="flex flex-wrap gap-1">
                        {(Object.keys(STATE) as PlanFileState[]).filter((k) => l.counts[k]).map((k) => <span key={k} className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${STATE[k].tone}`}>{l.counts[k]} {STATE[k].label}</span>)}
                        {l.toCensus > 0 && <span className="rounded-full border border-violet-300 bg-violet-50 text-violet-800 px-1.5 py-0.5 text-[10px] font-semibold">{l.toCensus} drawings to your model</span>}
                      </div>
                      <button onClick={() => setOpen(isOpen ? null : l.id)} className="mt-1 text-[11px] text-[var(--color-text-muted)] hover:underline inline-flex items-center gap-0.5">{isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} {isOpen ? "Hide the files" : "Show every file"}</button>
                      {isOpen && (
                        <ul className="mt-1 max-h-64 overflow-y-auto space-y-0.5 pr-1">
                          {l.sample.map((f) => (
                            <li key={f.id} className="flex items-center gap-2">
                              <span className="truncate flex-1">{f.name}</span>
                              {f.census && <span className="shrink-0 text-[10px] font-semibold text-violet-700">to your model</span>}
                              <span className={`shrink-0 rounded-full border px-1.5 text-[10px] ${STATE[f.state].tone}`}>{STATE[f.state].sent ? "will be read" : STATE[f.state].label.split(" - ")[0]}</span>
                            </li>
                          ))}
                          {l.files > l.sample.length && <li className="text-[var(--color-text-muted)]">…and {l.files - l.sample.length} more</li>}
                        </ul>
                      )}
                    </div>
                  )}
                  {!l.selected && !l.neverAi && tick && <div className="mt-1 pl-5 text-[11px] text-[var(--color-text-muted)]">Ticked. Press &ldquo;Update the list&rdquo; to see its files.</div>}
                  {l.neverAi && <div className="mt-1 pl-5 text-[11px] text-rose-700 inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Never sent to AI. Nothing in it is read.</div>}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-[var(--color-border)]">
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          <button onClick={onClose} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-semibold">Cancel</button>
          {dirty
            ? <button onClick={() => onReplan(pickedNow)} disabled={loading || !pickedNow.length} className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm font-bold disabled:opacity-50">Update the list</button>
            : <button onClick={() => onStart(chosen.map((l) => l.id))} disabled={loading || !chosen.length} className="rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] px-3 py-1.5 text-sm font-bold disabled:opacity-50">Start</button>}
        </div>
      </div>
    </div>
  );
}
