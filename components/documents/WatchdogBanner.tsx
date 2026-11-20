"use client";

// WatchdogBanner — "that looks like it belongs somewhere else."
// Shown once after an upload or a new folder, never blocking. Each row is
// the thing, where the estate keeps things like it, and why. "Link it there"
// keeps the file where it is AND files it there (a filed_under edge — the
// symbolic link). "Leave it" is remembered.

import React from "react";
import { ShieldAlert, Link2, X, Loader2, FolderOpen } from "lucide-react";
import type { HomeSuggestion } from "@/lib/estate/watchdog";

export default function WatchdogBanner({ suggestions, busyId, onLink, onDismiss, onClose }: {
  suggestions: HomeSuggestion[]; busyId: string | null;
  onLink: (s: HomeSuggestion) => void; onDismiss: (s: HomeSuggestion) => void; onClose: () => void;
}) {
  if (!suggestions.length) return null;
  return (
    <div className="mb-3 border-l-2 border-amber-500 pl-3">
      <div className="py-1 flex items-center justify-between">
        <div className="text-sm font-black text-amber-800 dark:text-amber-300 inline-flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> {suggestions.length === 1 ? "This looks like it belongs somewhere else" : `${suggestions.length} of these look like they belong somewhere else`}</div>
        <button aria-label="Dismiss" onClick={onClose} className="p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]" title="Dismiss"><X className="w-4 h-4" /></button>
      </div>
      <ul className="divide-y divide-[var(--color-border)]">
        {suggestions.map((s) => (
          <li key={s.targetId} className="py-2 flex items-start gap-3">
            <FolderOpen className="w-4 h-4 mt-0.5 text-[var(--color-text-muted)] shrink-0" />
            <div className="flex-1 min-w-0 text-xs text-[var(--color-text)]">
              <div className="font-semibold truncate">{s.targetName}</div>
              <div className="text-[var(--color-text-muted)]">{s.reason}</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => onLink(s)} disabled={busyId === s.targetId} title="Keeps the file here and also files it there. Nothing moves." className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] px-2 py-1 text-xs font-bold hover:bg-[var(--color-surface-2)] disabled:opacity-60">
                {busyId === s.targetId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />} Link it there
              </button>
              <button onClick={() => onDismiss(s)} disabled={busyId === s.targetId} className="rounded-lg px-2 py-1 text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-60">Leave it</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
