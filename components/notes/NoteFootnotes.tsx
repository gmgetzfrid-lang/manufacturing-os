"use client";

// NoteFootnotes — the passive intelligence strip under a note.
//
// Renders what lib/noteIntel resolved from the note's text: live
// status footnotes for the assets / documents / tickets / projects /
// schedule tasks the note mentions, "did you mean E-204?" close-miss
// suggestions, and — only as a last resort — a quiet clarification row
// for something that clearly reads like a reference but matched nothing.
//
// Zero AI, zero egress: everything comes from the org's own database
// via heuristics. Renders NOTHING when there's nothing worth saying —
// silence is the default, signals are the exception.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  KeyRound, FileText, Ticket as TicketIcon, Briefcase, CalendarClock,
  AlertTriangle, ChevronRight, Search, X, Sparkles,
} from "lucide-react";
import { analyzeNoteReferences, type NoteIntel, type Footnote, type RefKind } from "@/lib/noteIntel";

const KIND_ICON: Record<RefKind, React.ComponentType<{ className?: string }>> = {
  asset: KeyRound,
  document: FileText,
  ticket: TicketIcon,
  project: Briefcase,
  milestone: CalendarClock,
};

const TONE_DOT: Record<Footnote["tone"], string> = {
  alert: "bg-rose-400",
  warn: "bg-amber-400",
  info: "bg-slate-500",
};

const TONE_TEXT: Record<Footnote["tone"], string> = {
  alert: "text-rose-300",
  warn: "text-amber-300",
  info: "text-slate-500",
};

export default function NoteFootnotes({ orgId, body }: { orgId: string; body: string }) {
  const [intel, setIntel] = useState<NoteIntel | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await analyzeNoteReferences(orgId, body);
        if (!cancelled) setIntel(res);
      } catch {
        if (!cancelled) setIntel({ footnotes: [], suggestions: [], unplaced: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, body]);

  if (!intel) return null;
  const unplaced = intel.unplaced.filter((u) => !dismissed.has(u));
  if (intel.footnotes.length === 0 && intel.suggestions.length === 0 && unplaced.length === 0) return null;

  return (
    <div className="mt-3 pt-2 border-t border-dashed border-slate-800 space-y-1">
      {intel.footnotes.map((f) => {
        const Icon = KIND_ICON[f.kind];
        return (
          <Link
            key={`${f.kind}:${f.id}`}
            href={f.href}
            className="group/fn flex items-start gap-2 rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-white/[0.03]"
          >
            <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${TONE_DOT[f.tone]} ${f.tone === "alert" ? "animate-pulse" : ""}`} />
            <Icon className="w-3.5 h-3.5 text-slate-500 mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 text-[11px] leading-snug">
              <span className="font-black text-slate-200">{f.label}</span>
              {f.sub && <span className="text-slate-500"> — {f.sub}</span>}
              {f.signal && <span className={`block font-bold ${TONE_TEXT[f.tone]}`}>{f.signal}</span>}
              {!f.signal && f.metric && <span className="text-slate-500"> · {f.metric}</span>}
            </span>
            <ChevronRight className="w-3 h-3 text-slate-700 group-hover/fn:text-slate-400 mt-1 shrink-0" />
          </Link>
        );
      })}

      {intel.suggestions.map((s) => (
        <div key={s.raw} className="flex items-center gap-2 px-1.5 py-0.5 text-[11px]">
          <Sparkles className="w-3 h-3 text-amber-400 shrink-0" />
          <span className="text-slate-500">
            “{s.raw}” — did you mean{" "}
            <Link href={s.href} className="font-black text-amber-300 hover:text-amber-200">{s.label}</Link>?
          </span>
        </div>
      ))}

      {unplaced.map((u) => (
        <div key={u} className="flex items-center gap-2 px-1.5 py-0.5 text-[11px] text-slate-600">
          <AlertTriangle className="w-3 h-3 text-slate-600 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Couldn&apos;t place <span className="font-bold text-slate-400">“{u}”</span> — nothing in scope matches.
          </span>
          <Link href={`/search?q=${encodeURIComponent(u)}`} className="inline-flex items-center gap-0.5 font-bold text-slate-500 hover:text-slate-300 shrink-0">
            <Search className="w-3 h-3" /> search
          </Link>
          <button onClick={() => setDismissed((d) => new Set(d).add(u))} className="text-slate-700 hover:text-slate-400 shrink-0" title="Dismiss">
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
