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
    <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50/70 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 flex items-center justify-between border-b border-amber-200">
        <div className="text-sm font-black text-amber-900 inline-flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> {suggestions.length === 1 ? "This looks like it belongs somewhere else" : `${suggestions.length} of these look like they belong somewhere else`}</div>
        <button onClick={onClose} className="text-amber-800/70 hover:text-amber-900" title="Close"><X className="w-4 h-4" /></button>
      </div>
      <ul className="divide-y divide-amber-200/70">
        {suggestions.map((s) => (
          <li key={s.targetId} className="px-4 py-2.5 flex items-start gap-3">
            <FolderOpen className="w-4 h-4 mt-0.5 text-amber-700 shrink-0" />
            <div className="flex-1 min-w-0 text-xs text-amber-900">
              <div className="font-semibold truncate">{s.targetName}</div>
              <div className="text-amber-800/90">{s.reason}</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => onLink(s)} disabled={busyId === s.targetId} className="inline-flex items-center gap-1 rounded-lg bg-amber-600 text-white px-2 py-1 text-xs font-bold hover:bg-amber-500 disabled:opacity-60">
                {busyId === s.targetId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />} Link it there
              </button>
              <button onClick={() => onDismiss(s)} disabled={busyId === s.targetId} className="rounded-lg border border-amber-300 px-2 py-1 text-xs font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-60">Leave it</button>
            </div>
          </li>
        ))}
      </ul>
      <div className="px-4 py-1.5 text-[11px] text-amber-800/80">Linking keeps the file where it is and also files it there. Nothing is moved.</div>
    </div>
  );
}
