"use client";

// An error, said plainly where it happened: what went wrong, what to do
// next, and a way to try again. Never a raw database or HTTP message
// (lib/friendlyError turns those into words). Keeps whatever the person
// typed: it sits beside the part that failed, it doesn't replace the page.

import React from "react";
import { CircleAlert, RotateCcw } from "lucide-react";
import { explainError } from "@/lib/friendlyError";

export function ErrorNote({
  error,
  title,
  next,
  onRetry,
  retryLabel = "Try again",
  compact = false,
  className = "",
}: {
  /** The caught error (any shape); said in plain words. */
  error?: unknown;
  /** Override what happened ("Couldn't load the shift report."). */
  title?: React.ReactNode;
  /** Override what to do next. */
  next?: React.ReactNode;
  /** Shows a Try again button. */
  onRetry?: () => void;
  retryLabel?: string;
  /** One line, no box (inside a table row or under a toolbar). */
  compact?: boolean;
  className?: string;
}) {
  const f = explainError(error);
  const what = title ?? f.message;
  const todo = next ?? f.next;
  if (compact) {
    return (
      <p role="alert" className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[14px] ${className}`}>
        <CircleAlert aria-hidden className="w-4 h-4 shrink-0 self-center text-[var(--state-overdue)]" />
        <span className="font-semibold text-[var(--color-text)]">{what}</span>
        <span className="text-[var(--color-text-muted)]">{todo}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="font-semibold text-[var(--color-accent-text)] hover:underline underline-offset-2">
            {retryLabel}
          </button>
        )}
      </p>
    );
  }
  return (
    <div role="alert" className={`flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3.5 ${className}`}>
      <CircleAlert aria-hidden className="w-5 h-5 shrink-0 mt-0.5 text-[var(--state-overdue)]" />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-[var(--color-text)]">{what}</p>
        <p className="mt-0.5 text-[14px] text-[var(--color-text-muted)]">{todo}</p>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry}
          className="shrink-0 inline-flex items-center gap-1.5 h-9 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
          <RotateCcw aria-hidden className="w-3.5 h-3.5" />{retryLabel}
        </button>
      )}
    </div>
  );
}

export default ErrorNote;
