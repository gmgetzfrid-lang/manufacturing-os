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
    <div className="mb-2 flex items-center gap-2.5 rounded-xl bg-[var(--color-surface-2)] px-3 py-2 text-[12.5px] animate-rise">
      <History className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">
        <b className="font-bold">Asked before</b>
        <span className="text-[var(--color-text-muted)]"> by {(past.userName ?? "someone").split("@")[0]} · {relativeTime(past.createdAt)}: </span>
        &ldquo;{past.question}&rdquo;
      </span>
      {stale && (
        <span title={changed!.join("\n")}
          className="hidden sm:inline-flex items-center gap-1 shrink-0 font-bold text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5" /> Sources changed
        </span>
      )}
      <button onClick={onReview} className="shrink-0 inline-flex items-center gap-1 font-bold text-[var(--color-text)] hover:underline">
        <Eye className="w-3.5 h-3.5" /> Review
      </button>
      <button onClick={onReuse} className="shrink-0 inline-flex items-center gap-1 font-bold text-[var(--color-accent)] hover:underline">
        <Redo2 className="w-3.5 h-3.5" /> Use it
      </button>
      <button onClick={onDismiss} title="Ask fresh" aria-label="Dismiss, ask fresh" className="shrink-0 w-7 h-7 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
