"use client";

// MemoryStrip — "asked before", as a thin line above the composer instead
// of a wall. Appears only on a strong match while you type, remembers a
// dismissal per question, and offers three moves: review the past answer
// in the panel, reuse it in this conversation (no AI call), or ignore it.

import React from "react";
import { History, Eye, Redo2, X, AlertTriangle } from "lucide-react";
import type { PastAnswer } from "@/lib/chatClient";
import { relativeTime } from "./shared";

export default function MemoryStrip({ past, changed, onReview, onReuse, onDismiss }: {
  past: PastAnswer;
  /** Sources that moved on since the answer — set when known. */
  changed: string[] | null;
  onReview: () => void;
  onReuse: () => void;
  onDismiss: () => void;
}) {
  const stale = (changed?.length ?? 0) > 0;
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--color-border)] dark:border-[var(--color-border)] bg-[var(--color-surface-2)] dark:bg-[var(--color-surface-2)] px-3 py-1.5 text-[11px] animate-rise">
      <History className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">
        <b className="font-black">Asked before</b>
        <span className="text-[var(--color-text-muted)]"> by {(past.userName ?? "someone").split("@")[0]} · {relativeTime(past.createdAt)}: </span>
        <i>&ldquo;{past.question}&rdquo;</i>
      </span>
      {stale && (
        <span title={changed!.join("\n")}
          className="hidden sm:inline-flex items-center gap-1 shrink-0 text-[11px] font-black text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-3 h-3" /> sources changed
        </span>
      )}
      <button onClick={onReview} className="shrink-0 inline-flex items-center gap-1 font-black text-[var(--color-accent)] dark:text-[var(--color-text)] hover:underline">
        <Eye className="w-3 h-3" /> Review
      </button>
      <button onClick={onReuse} className="shrink-0 inline-flex items-center gap-1 font-black text-[var(--color-accent)] dark:text-[var(--color-text)] hover:underline">
        <Redo2 className="w-3 h-3" /> Use it
      </button>
      <button onClick={onDismiss} title="Ask fresh" aria-label="Dismiss, ask fresh" className="shrink-0 p-0.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
