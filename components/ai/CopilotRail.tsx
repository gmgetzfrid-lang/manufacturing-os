"use client";

// CopilotRail — a docked AI assistant available everywhere. Paste a change
// narrative, handoff, or meeting notes and it summarizes them or pulls out
// equipment tags / MOC refs / dates / action items. Works today on the local
// on-device heuristic provider; the moment an external provider is configured
// (server-side key) it gets genuinely
// smart (the provider abstraction proxies to /api/ai). Quiet by default — a
// floating button, not a modal you have to dismiss.

import React, { useState } from "react";
import { Wand2, X, FileText, Tag, ListChecks } from "lucide-react";
import { getAiProvider } from "@/lib/ai";
import type { Entity } from "@/lib/ai/types";
import { Button } from "@/components/ui/Button";

export function CopilotRail() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [entities, setEntities] = useState<Entity[] | null>(null);
  const [tasks, setTasks] = useState<string[] | null>(null);
  const ai = getAiProvider();

  const reset = () => { setSummary(null); setEntities(null); setTasks(null); };

  const run = async (kind: "summarize" | "analyze") => {
    if (!text.trim() || busy) return;
    setBusy(true); reset();
    try {
      if (kind === "summarize") setSummary(await ai.summarize(text));
      else { const r = await ai.analyzeNote(text); setEntities(r.entities); setTasks(r.suggestedTasks); }
    } catch (e) {
      setSummary(`Couldn't run: ${(e as Error).message}`);
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="AI co-pilot"
        aria-label="Open AI co-pilot"
        className="fixed bottom-5 right-5 z-[120] w-12 h-12 rounded-full bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] shadow-lg shadow-black/20 flex items-center justify-center transition-transform hover:scale-105"
      >
        <Wand2 className="w-5 h-5" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-[120] w-[360px] max-w-[calc(100vw-2.5rem)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-2xl flex flex-col max-h-[80vh]">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <Wand2 className="w-4 h-4 text-[var(--color-accent)]" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-black text-[var(--color-text)]">AI co-pilot</div>
          <div className="text-[10px] text-[var(--color-text-muted)]">{ai.isReal ? "Connected" : "On-device assistant"}</div>
        </div>
        <button onClick={() => setOpen(false)} aria-label="Close" className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
      </div>
      <div className="p-3 space-y-2 overflow-y-auto">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="Paste a change narrative, handoff note, or meeting minutes — I'll summarize it or pull out equipment tags, MOC refs, dates, and action items."
          className="w-full text-sm border border-[var(--color-border)] rounded-lg px-2.5 py-2 bg-[var(--color-surface)] text-[var(--color-text)] resize-y outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]"
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void run("summarize")} loading={busy} disabled={!text.trim()}><FileText className="w-3.5 h-3.5" /> Summarize</Button>
          <Button size="sm" variant="secondary" onClick={() => void run("analyze")} loading={busy} disabled={!text.trim()}><Tag className="w-3.5 h-3.5" /> Extract</Button>
        </div>

        {summary && <div className="text-xs text-[var(--color-text)] bg-[var(--color-surface-2)] rounded-lg p-2.5 leading-relaxed whitespace-pre-wrap">{summary}</div>}

        {entities && (
          entities.length > 0 ? (
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1">Found</div>
              <div className="flex flex-wrap gap-1">
                {entities.map((e, i) => (
                  <span key={i} className="text-[11px] font-semibold rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2 py-0.5">
                    <span className="text-[var(--color-text-muted)]">{e.kind}:</span> {e.text}
                  </span>
                ))}
              </div>
            </div>
          ) : (tasks && tasks.length === 0) ? (
            <div className="text-xs text-[var(--color-text-muted)] italic">No tags, refs, or tasks found.</div>
          ) : null
        )}

        {tasks && tasks.length > 0 && (
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1 inline-flex items-center gap-1"><ListChecks className="w-3 h-3" /> Suggested tasks</div>
            <ul className="space-y-1">
              {tasks.map((t, i) => <li key={i} className="text-xs text-[var(--color-text)] flex items-start gap-1.5"><span className="mt-1.5 w-1 h-1 rounded-full bg-[var(--color-accent)] shrink-0" />{t}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export default CopilotRail;
