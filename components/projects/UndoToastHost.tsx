"use client";

// UndoToastHost — renders the stack of undoable-action toasts in a
// fixed corner. Each toast confirms what happened and offers Undo.
// Intentionally quiet (bottom-center, auto-dismiss) so it informs
// without nagging.

import React from "react";
import { CheckCircle2, RotateCcw, X as XIcon, AlertTriangle, Info } from "lucide-react";
import type { UndoableToast } from "./useUndoableActions";

export default function UndoToastHost({
  toasts, onUndo, onDismiss,
}: {
  toasts: UndoableToast[];
  onUndo: (t: UndoableToast) => void;
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    // Above the phone's bottom bar (the page's one action), clear of the thumb.
    <div className="fixed bottom-4 max-sm:bottom-24 left-1/2 -translate-x-1/2 z-[280] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => {
        const Icon = t.tone === "warning" ? AlertTriangle : t.tone === "success" ? CheckCircle2 : Info;
        const accent = t.tone === "warning" ? "text-[var(--state-held-text)]" : t.tone === "success" ? "text-[var(--state-released-text)]" : "text-[var(--color-text-muted)]";
        return (
          <div key={t.id} className="pointer-events-auto flex items-center gap-3 bg-[var(--color-ink)] text-white rounded-xl shadow-2xl ring-1 ring-[var(--color-ink-line)] pl-3 pr-2 py-2 max-w-md animate-[toastin_.15s_ease-out]">
            <Icon className={`w-4 h-4 shrink-0 ${accent}`} />
            <span className="text-[13px] font-medium flex-1 min-w-0">{t.message}</span>
            {t.undo && (
              <button
                onClick={() => onUndo(t)}
                className="inline-flex items-center gap-1 text-[12px] font-bold text-white bg-white/10 hover:bg-white/20 px-2.5 py-1 rounded-lg transition-colors shrink-0"
              >
                <RotateCcw className="w-3 h-3" /> Undo
              </button>
            )}
            <button onClick={() => onDismiss(t.id)} className="p-1 rounded hover:bg-white/10 text-[var(--color-ink-muted)] shrink-0" title="Dismiss" aria-label="Dismiss">
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
      <style jsx>{`@keyframes toastin { from { transform: translateY(8px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }`}</style>
    </div>
  );
}
