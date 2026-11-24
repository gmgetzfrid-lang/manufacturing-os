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
import { X, Loader2, Lock, FileText, ChevronRight, Send, ShieldOff } from "lucide-react";
import LibraryAiSwitch from "@/components/documents/LibraryAiSwitch";
import type { ConnectPlan, PlanFileState } from "@/lib/estate/connectPlan";
import { useEscapeClose } from "@/components/documents/useEscapeClose";
import { StatusTag, type DocTone } from "@/components/documents/StatusTag";
import { btnQuiet, btnPrimary, btnIcon } from "@/components/admin/kit";
import { Note, Cells } from "@/components/knowledge/panelKit";

const STATE: Record<PlanFileState, { label: string; short: string; tone: DocTone; sent: boolean }> = {
  new: { label: "New: will be read", short: "Will be read", tone: "none", sent: true },
  revised: { label: "New revision: read again", short: "Read again", tone: "none", sent: true },
  read: { label: "Already read: reused, nothing sent", short: "Already read", tone: "good", sent: false },
  held_back: { label: "Held back from AI", short: "Held back", tone: "bad", sent: false },
  not_current: { label: "Superseded or archived: never read", short: "Not current", tone: "none", sent: false },
  not_pdf: { label: "Not a PDF: not read", short: "Not a PDF", tone: "none", sent: false },
};

export default function ConnectPreview({ orgId, plan, loading, canChange, onStart, onClose, onReplan }: {
  orgId: string; plan: ConnectPlan; loading: boolean; canChange: boolean;
  onStart: (libraryIds: string[]) => void; onClose: () => void; onReplan: (libraryIds: string[]) => void;
}) {
  // Escape closes this dialog (only the top one when they stack).
  useEscapeClose(() => onClose());
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
    <div role="dialog" aria-modal="true" aria-labelledby="connect-preview-title" className="fixed inset-0 z-[60] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--color-border)]">
          <div className="min-w-0">
            <h2 id="connect-preview-title" className="font-display text-section font-semibold text-[var(--color-text)]">Before anything is sent to AI</h2>
            <p className="text-body text-[var(--color-text-muted)]">Nothing has run yet. Check what will be read, change it, then press Start.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className={btnIcon}><X className="w-4 h-4" /></button>
        </div>

        {/* What leaves the server, as numbers. */}
        <div className="border-b border-[var(--color-border)]">
          <Cells size="sm" cells={[
            { label: "Files to read", value: totals.toRead.toLocaleString(), hint: "Text read on our server, not sent" },
            { label: "Drawings to your model", value: totals.census.toLocaleString(), hint: "Whole, plus four zoomed tiles each" },
            { label: "Already read", value: totals.read.toLocaleString(), hint: "Reused; nothing sent", tone: totals.read > 0 ? "good" : undefined },
            { label: "Held back", value: totals.blocked.toLocaleString(), hint: "Not touched", tone: totals.blocked > 0 ? "bad" : undefined },
          ]} />
        </div>
        <div className="px-5 py-3 space-y-2 border-b border-[var(--color-border)] text-body">
          <p className="flex items-start gap-2 text-[var(--color-text-muted)]">
            <Send className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Only pages with no usable text go to {model ? <>your key (<span className="text-[var(--color-text)] font-medium">{model}</span>)</> : "your AI key"}, as images.</span>
          </p>
          {!plan.hasKey && <Note tone="warn" title="No AI key on your account.">Text is still read on the server, but nothing goes to a model until you add a key in Intelligence, Setup.</Note>}
          <p className="text-body text-[var(--color-text-muted)]">Only Admin and Doc Control can run this. Every change it makes to a drawing is recorded and can be undone.</p>
        </div>

        <div className="px-5 pt-4 pb-1">
          <h3 className="font-display text-section font-semibold text-[var(--color-text)]">Libraries</h3>
        </div>
        <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)] mt-2">
          {plan.libraries.map((l) => {
            const isOpen = open === l.id;
            const tick = picked.has(l.id) && !l.neverAi;
            return (
              <li key={l.id} className="relative px-5 py-2.5">
                {l.neverAi && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
                <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap">
                  <label className={`inline-flex items-center gap-2.5 min-w-0 ${l.neverAi ? "opacity-60" : "cursor-pointer"}`}>
                    <input type="checkbox" checked={tick} disabled={l.neverAi} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(l.id); else n.delete(l.id); return n; })} className="w-4 h-4 accent-[var(--color-accent)]" />
                    {l.neverAi ? <ShieldOff className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" /> : <FileText className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />}
                    <span className="text-reading font-medium text-[var(--color-text)] truncate">{l.name}</span>
                  </label>
                  <span className="text-body text-[var(--color-text-muted)] tabular-nums">{l.files.toLocaleString()} file{l.files === 1 ? "" : "s"}{l.drawings ? ", drawings" : ""}</span>
                  <span className="ml-auto"><LibraryAiSwitch orgId={orgId} libraryId={l.id} libraryName={l.name} excluded={l.neverAi} canChange={canChange} compact onChanged={() => onReplan(pickedNow.filter((id) => id !== l.id))} /></span>
                </div>
                {l.selected && (
                  <div className="mt-1.5 pl-[26px]">
                    <div className="flex flex-wrap gap-1.5">
                      {(Object.keys(STATE) as PlanFileState[]).filter((k) => l.counts[k]).map((k) => <StatusTag key={k} tone={STATE[k].tone}>{l.counts[k]} {STATE[k].short.toLowerCase()}</StatusTag>)}
                      {l.toCensus > 0 && <StatusTag tone="none">{l.toCensus} drawings to your model</StatusTag>}
                    </div>
                    <button type="button" onClick={() => setOpen(isOpen ? null : l.id)} aria-expanded={isOpen} className="mt-1.5 text-body text-[var(--color-accent-text)] hover:underline underline-offset-2 inline-flex items-center gap-0.5">
                      <ChevronRight className={`w-4 h-4 ui-chevron${(isOpen) ? " rotate-90" : ""}`} /> {isOpen ? "Hide the files" : "Show every file"}
                    </button>
                    {isOpen && (
                      <ul className="mt-1.5 max-h-64 overflow-y-auto rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                        {l.sample.map((f) => (
                          <li key={f.id} className="flex items-center gap-3 px-3 py-1.5 text-body">
                            <span className="truncate flex-1 text-[var(--color-text)]">{f.name}</span>
                            {f.census && <span className="shrink-0 text-body text-[var(--color-text-muted)]">To your model</span>}
                            <StatusTag tone={STATE[f.state].tone}>{STATE[f.state].sent ? "Will be read" : STATE[f.state].short}</StatusTag>
                          </li>
                        ))}
                        {l.files > l.sample.length && <li className="px-3 py-1.5 text-body text-[var(--color-text-muted)]">And {(l.files - l.sample.length).toLocaleString()} more</li>}
                      </ul>
                    )}
                  </div>
                )}
                {!l.selected && !l.neverAi && tick && <div className="mt-1 pl-[26px] text-body text-[var(--color-text-muted)]">Ticked. Press Update the list to see its files.</div>}
                {l.neverAi && <div className="mt-1 pl-[26px] text-body text-[var(--color-text-muted)] inline-flex items-center gap-1"><Lock className="w-3.5 h-3.5" /> Never sent to AI. Nothing in it is read.</div>}
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-end gap-2 px-5 py-4">
          {loading && <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />}
          <button type="button" onClick={onClose} className={btnQuiet}>Cancel</button>
          {dirty
            ? <button type="button" onClick={() => onReplan(pickedNow)} disabled={loading || !pickedNow.length} className={btnPrimary}>Update the list</button>
            : <button type="button" onClick={() => onStart(chosen.map((l) => l.id))} disabled={loading || !chosen.length} className={btnPrimary}>Start</button>}
        </div>
      </div>
    </div>
  );
}
