"use client";

import React, { useState } from "react";
import { BookOpen, X, ChevronUp, ChevronDown, Trash2, Play } from "lucide-react";
import type { DocumentRecord } from "@/types/schema";

interface StagingTrayProps {
  docs: DocumentRecord[];
  onRemove: (id: string) => void;
  onClear: () => void;
  onOpen: () => void;
}

export default function StagingTray({ docs, onRemove, onClear, onOpen }: StagingTrayProps) {
  const [expanded, setExpanded] = useState(false);

  if (docs.length === 0) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 flex flex-col items-center pointer-events-none">
      <div className="w-full pointer-events-auto">
        {/* Expanded document list */}
        {expanded && (
          <div className="bg-[var(--color-surface)] border-t border-x border-[var(--color-border)] shadow-2xl max-h-52 overflow-y-auto">
            <div className="p-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
              {docs.map((doc, idx) => (
                <div
                  key={doc.id}
                  className="flex items-center gap-2 bg-[var(--color-surface-2)] rounded-lg px-3 py-2 border border-[var(--color-border)] group"
                >
                  <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-[9px] font-black shrink-0">
                    {idx + 1}
                  </span>
                  <span className="text-[10px] font-mono font-bold text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded border border-orange-200 shrink-0 truncate max-w-[80px]">
                    {doc.documentNumber || "—"}
                  </span>
                  <span className="text-xs text-[var(--color-text)] truncate flex-1 min-w-0">
                    {doc.title || doc.name}
                  </span>
                  <button
                    onClick={() => onRemove(doc.id!)}
                    className="shrink-0 text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tray bar */}
        <div className="bg-slate-900 text-white flex items-center gap-3 px-5 py-2.5 shadow-2xl border-t border-slate-700">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <BookOpen className="w-4 h-4 text-orange-400 shrink-0" />
            <span className="text-sm font-bold text-white whitespace-nowrap">Reference Stack</span>
            <span className="text-xs font-black bg-orange-500 text-white px-2 py-0.5 rounded-full shrink-0">
              {docs.length}
            </span>
            {/* Pills preview — hidden on small screens */}
            <div className="hidden md:flex items-center gap-1 overflow-hidden flex-1 min-w-0">
              {docs.slice(0, 6).map((doc) => (
                <span
                  key={doc.id}
                  className="text-[10px] font-mono bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded text-slate-300 whitespace-nowrap cursor-pointer transition-colors border border-slate-700"
                  title={doc.title || doc.name}
                >
                  {doc.documentNumber || (doc.title || "").slice(0, 10) || "—"}
                </span>
              ))}
              {docs.length > 6 && (
                <span className="text-[10px] text-[var(--color-text-muted)] whitespace-nowrap">+{docs.length - 6} more</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="p-1.5 hover:bg-slate-700 rounded-lg transition-colors text-[var(--color-text-faint)] hover:text-white"
              title={expanded ? "Collapse list" : "Show all staged docs"}
            >
              {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </button>
            <button
              onClick={onClear}
              className="p-1.5 hover:bg-slate-700 rounded-lg transition-colors text-[var(--color-text-faint)] hover:text-red-400"
              title="Clear staging area"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <div className="w-px h-5 bg-slate-700 mx-1" />
            <button
              onClick={onOpen}
              className="flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-xl font-bold text-sm transition-all shadow-lg shadow-orange-900/30 active:scale-95"
            >
              <Play className="w-3.5 h-3.5" />
              Open Book
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
