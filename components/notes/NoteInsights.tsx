"use client";

// NoteInsights — AI panel that hangs below each note in the
// scratchpad. Auto-runs provider.analyzeNote() on the note body,
// shows entity chips, and lists "suggested tasks" the AI thinks
// might be hiding in the prose. Each suggestion has a one-click
// "+ Add" button that appends `- [ ] <task>` to the note body.
//
// Idempotency: cached per (noteId, bodyHash) in a top-level Map so
// editing or scrolling a note doesn't refire the API. Cache lives
// for the lifetime of the page — that's enough for a session.

import React, { useEffect, useState } from "react";
import { Wand2, Loader2, Plus, KeyRound, Calendar, FileText, AlertOctagon, AtSign } from "lucide-react";
import { getAiProvider } from "@/lib/ai";
import type { Entity, NoteInsights as Insights } from "@/lib/ai/types";

interface Props {
  noteId: string;
  body: string;
  busy: boolean;
  onAppendTask: (line: string) => Promise<void>;
}

// Session-lifetime cache. Key is `${noteId}::${hash}`.
const insightsCache = new Map<string, Insights>();

function quickHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

export default function NoteInsights({ noteId, body, busy, onAppendTask }: Props) {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  // Consent gate: the local heuristic provider runs automatically
  // (zero egress); an EXTERNAL provider only runs after the user
  // explicitly asks, per note — note text never leaves silently.
  const [requested, setRequested] = useState(false);
  const isExternal = getAiProvider().isReal;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!body.trim()) { if (!cancelled) setInsights(null); return; }
      if (isExternal && !requested) { if (!cancelled) setInsights(null); return; }
      const key = `${noteId}::${quickHash(body)}`;
      const hit = insightsCache.get(key);
      if (hit) { if (!cancelled) setInsights(hit); return; }
      setLoading(true);
      try {
        const res = await getAiProvider().analyzeNote(body);
        if (cancelled) return;
        insightsCache.set(key, res);
        setInsights(res);
      } catch {
        if (!cancelled) setInsights({ entities: [], suggestedTasks: [] });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [noteId, body, isExternal, requested]);

  if (!body.trim()) return null;

  if (isExternal && !requested) {
    return (
      <div className="mt-2 pt-2 border-t border-dashed border-amber-200/60">
        <button
          onClick={() => setRequested(true)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-amber-300 bg-white text-amber-700 text-[10px] font-bold hover:bg-amber-50"
          title="Sends this note's text to the configured AI provider. Nothing is sent until you click."
        >
          <Wand2 className="w-2.5 h-2.5" /> Analyze note
        </button>
        <span className="ml-2 text-[10px] text-slate-400 italic">sends this note to the configured AI — only when you ask</span>
      </div>
    );
  }

  const hasEntities = (insights?.entities.length ?? 0) > 0;
  const hasTasks = (insights?.suggestedTasks.length ?? 0) > 0;
  if (!loading && !hasEntities && !hasTasks) return null;

  return (
    <div className="mt-2 pt-2 border-t border-dashed border-amber-200/60 space-y-1.5">
      {loading && (
        <div className="text-[10px] text-slate-400 italic inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Scanning…
        </div>
      )}

      {hasEntities && (
        <div className="flex items-start gap-1.5">
          <Wand2 className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
          <div className="flex flex-wrap gap-1">
            {insights!.entities.slice(0, 12).map((e, i) => (
              <EntityChip key={i} entity={e} />
            ))}
          </div>
        </div>
      )}

      {hasTasks && (
        <div className="flex items-start gap-1.5">
          <span className="text-amber-500 text-xs leading-none mt-1">+</span>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="text-[10px] font-black text-amber-800 uppercase tracking-widest">Suggested tasks</div>
            {insights!.suggestedTasks.map((t, i) => {
              const key = `${noteId}::${i}::${t}`;
              const wasAdded = added.has(key);
              return (
                <div key={i} className="flex items-start gap-1.5 group">
                  <button
                    onClick={async () => {
                      if (busy || wasAdded) return;
                      await onAppendTask(t);
                      setAdded((s) => new Set(s).add(key));
                    }}
                    disabled={busy || wasAdded}
                    className={`shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                      wasAdded
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-white text-amber-700 border-amber-300 hover:bg-amber-50"
                    } disabled:opacity-50`}
                  >
                    <Plus className="w-2.5 h-2.5" /> {wasAdded ? "Added" : "Add"}
                  </button>
                  <span className="text-xs text-slate-700 flex-1">{t}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function EntityChip({ entity }: { entity: Entity }) {
  const cfg = entityStyle(entity.kind);
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold border ${cfg.cls}`}>
      <Icon className="w-2.5 h-2.5" /> {entity.text}
    </span>
  );
}

function entityStyle(kind: string): { icon: React.ComponentType<{ className?: string }>; cls: string } {
  switch (kind) {
    case "equipment": return { icon: KeyRound,      cls: "bg-purple-50 text-purple-700 border-purple-200" };
    case "moc":       return { icon: FileText,      cls: "bg-blue-50 text-blue-700 border-blue-200" };
    case "person":    return { icon: AtSign,        cls: "bg-slate-50 text-slate-700 border-slate-200" };
    case "date":
    case "deadline":  return { icon: Calendar,      cls: "bg-amber-50 text-amber-700 border-amber-200" };
    case "document":  return { icon: FileText,      cls: "bg-indigo-50 text-indigo-700 border-indigo-200" };
    default:          return { icon: AlertOctagon,  cls: "bg-slate-50 text-slate-700 border-slate-200" };
  }
}
