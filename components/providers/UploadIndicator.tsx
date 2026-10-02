"use client";

// Global upload indicator. Subscribes to the upload broadcast in lib/storage and
// shows a small bottom-right pill for every in-flight upload — filename, live
// progress bar, then a brief "Done" or a persistent "Failed" with the reason.
// A transfer the user stopped reads "Stopped" in a neutral tone and clears on
// the "Done" timing — the user's own Stop is not a failure (STACK-2).
//
// Because every upload in the app goes through uploadToPath, this single mounted
// component gives consistent "it's working" feedback for a file attach ANYWHERE,
// regardless of which screen triggered it.
//
// Under the dock's cap (STACK-9) the cards that show are chosen failures
// first, then running transfers, then finished ones — a failure's reason is
// never the card that gets collapsed into "+N more" while a progress bar
// shows. A failure's clear-timer starts only once it is visible, so a
// failure collapsed behind the cap is still there when it surfaces (on a
// phone, a card the folded summary pill stands for counts as visible — it
// clears on its own time, as on a desktop: STACK-7). A "Done" or "Stopped"
// card clears on its own time from the moment it finished, seen or not, as
// it always did: behind a running batch it would otherwise wait out the
// whole batch and then drain four at a time.
//
// These are the dock's `raisable` cards: while a modal that started an
// upload is open, they lift the dock above it, and only they hold places
// there — and the dock is raised only while one of them shows (STACK-10).

import React, { useEffect, useRef, useState } from "react";
import { subscribeUploads, type UploadActivity } from "@/lib/storage";
import { Loader2, CheckCircle2, AlertCircle, X, Square } from "lucide-react";
import { CornerPortal, useDockAllowances, DOCK_PRIORITY } from "@/components/ui/CornerDock";

type Tracked = UploadActivity & { _t: number };

/** How long a finished card stays once visible. */
export const UPLOAD_CLEAR_MS = { done: 2500, cancelled: 2500, error: 7000 } as const;

const RANK: Record<UploadActivity["status"], number> = { error: 0, uploading: 1, cancelled: 2, done: 3 };

/** Which cards show under an allowance: failures, then running, then the
 *  rest (newest first within each), displayed in start order. */
export function pickVisibleUploads<T extends { id: string; status: UploadActivity["status"]; _t: number }>(list: T[], allowance: number): T[] {
  if (allowance <= 0) return [];
  if (list.length <= allowance) return list;
  const keep = new Set(
    [...list].sort((a, b) => RANK[a.status] - RANK[b.status] || b._t - a._t).slice(0, allowance).map((u) => u.id),
  );
  return list.filter((u) => keep.has(u.id));
}

export default function UploadIndicator() {
  const [items, setItems] = useState<Record<string, Tracked>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    return subscribeUploads((e) => {
      setItems((prev) => ({ ...prev, [e.id]: { ...e, _t: prev[e.id]?._t ?? Date.now() } }));
    });
  }, []);

  const dismiss = (id: string) =>
    setItems((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const list = Object.values(items).sort((a, b) => a._t - b._t);
  const uploading = list.filter((u) => u.status === "uploading").length;
  const failed = list.filter((u) => u.status === "error").length;
  const { shown: allowance, timed } = useDockAllowances("jobs", DOCK_PRIORITY.upload, list.length, list.length === 0 ? null
    : failed > 0 ? { label: `${failed} upload${failed === 1 ? "" : "s"} failed`, tone: "error" }
    : uploading > 0 ? { label: `Uploading ${uploading} file${uploading === 1 ? "" : "s"}`, tone: "busy" }
    : { label: "Uploads finished", tone: "ok" },
    // These cards are what a modal that started an upload raises the dock
    // for — and, raised, the only cards that hold places (STACK-10).
    { raisable: true });
  const shown = pickVisibleUploads(list, allowance);

  // A finished card clears UPLOAD_CLEAR_MS after it finished — a failure
  // after it is first VISIBLE (or stood for by the phone's pill) — and only
  // if no newer event superseded it. A started clock is not paused when the
  // card later leaves the stack.
  useEffect(() => {
    const sorted = Object.values(items).sort((a, b) => a._t - b._t);
    const seen = new Set(pickVisibleUploads(sorted, timed).map((u) => u.id));
    for (const u of sorted) {
      if (u.status === "uploading") continue;
      if (u.status === "error" && !seen.has(u.id)) continue;
      const tk = `${u.id}:${u.status}`;
      if (timers.current.has(tk)) continue;
      const status = u.status;
      timers.current.set(tk, setTimeout(() => {
        timers.current.delete(tk);
        setItems((prev) => {
          // Only drop it if it hasn't been superseded by a newer event.
          if (prev[u.id]?.status !== status) return prev;
          const next = { ...prev };
          delete next[u.id];
          return next;
        });
      }, UPLOAD_CLEAR_MS[status]));
    }
  }, [items, timed]);

  useEffect(() => {
    const map = timers.current;
    return () => { for (const t of map.values()) clearTimeout(t); map.clear(); };
  }, []);

  if (shown.length === 0) return null;

  return (
    <CornerPortal slot="jobs" priority={DOCK_PRIORITY.upload}>
      <div className="flex flex-col gap-2 w-[min(18rem,calc(100vw-2rem))] pointer-events-auto">
      {shown.map((u) => (
        <div key={u.id} className="bg-[var(--color-surface)] rounded-xl shadow-lg border border-[var(--color-border)] px-3 py-2.5 animate-in slide-in-from-bottom-2 fade-in">
          <div className="flex items-center gap-2">
            {u.status === "uploading" && <Loader2 className="w-4 h-4 animate-spin text-orange-500 shrink-0" />}
            {u.status === "done" && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
            {u.status === "error" && <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />}
            {u.status === "cancelled" && <Square className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />}
            <span className="text-xs font-bold text-[var(--color-text)] truncate flex-1" title={u.name}>{u.name}</span>
            <span className={`text-[10px] font-black shrink-0 ${u.status === "error" ? "text-rose-500" : u.status === "done" ? "text-emerald-600" : u.status === "cancelled" ? "text-[var(--color-text-muted)]" : "text-[var(--color-text-faint)]"}`}>
              {u.status === "uploading" ? `${Math.round(u.percent)}%` : u.status === "done" ? "Done" : u.status === "cancelled" ? "Stopped" : "Failed"}
            </span>
            {u.status !== "uploading" && (
              <button onClick={() => dismiss(u.id)} className="p-0.5 rounded text-slate-300 hover:text-[var(--color-text-muted)] shrink-0" aria-label="Dismiss">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {u.status === "uploading" && (
            <div className="mt-1.5 h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
              <div className="h-full bg-orange-500 transition-all duration-200" style={{ width: `${Math.max(4, Math.round(u.percent))}%` }} />
            </div>
          )}
          {u.status === "error" && u.error && (
            <div className="text-[10px] text-rose-600 mt-1 line-clamp-2">{u.error}</div>
          )}
        </div>
      ))}
      </div>
    </CornerPortal>
  );
}
