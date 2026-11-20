"use client";

// Global upload indicator. Subscribes to the upload broadcast in lib/storage and
// shows a small bottom-right pill for every in-flight upload — filename, live
// progress bar, then a brief "Done" or a persistent "Failed" with the reason.
//
// Because every upload in the app goes through uploadToPath, this single mounted
// component gives consistent "it's working" feedback for a file attach ANYWHERE,
// regardless of which screen triggered it.

import React, { useEffect, useState } from "react";
import { subscribeUploads, type UploadActivity } from "@/lib/storage";
import { Loader2, CheckCircle2, AlertCircle, X } from "lucide-react";
import { CornerPortal } from "@/components/ui/CornerDock";

type Tracked = UploadActivity & { _t: number; _p0?: { t: number; pct: number } };

// Time left is worth showing only when a file takes a while.
const BIG = 25 * 1024 * 1024;
function timeLeft(u: Tracked, now: number): string | null {
  if (!u.size || u.size < BIG || !u._p0 || u.percent < 3) return null;
  const dt = (now - u._p0.t) / 1000, dp = u.percent - u._p0.pct;
  if (dt < 2 || dp <= 0) return null;
  const secs = ((100 - u.percent) / dp) * dt;
  if (secs < 60) return "under a minute left";
  const m = Math.round(secs / 60);
  return `about ${m} min left`;
}

export default function UploadIndicator() {
  const [items, setItems] = useState<Record<string, Tracked>>({});

  useEffect(() => {
    return subscribeUploads((e) => {
      setItems((prev) => {
        const old = prev[e.id];
        // Speed is measured from the first progress after a (re)start.
        const p0 = e.retrying || !old?._p0 ? (e.percent > 0 ? { t: Date.now(), pct: e.percent } : undefined) : old._p0;
        return { ...prev, [e.id]: { ...e, _t: old?._t ?? Date.now(), _p0: p0 } };
      });
      // Done fades out; a failure stays until you close it.
      if (e.status === "done") {
        const after = 2500;
        window.setTimeout(() => {
          setItems((prev) => {
            // Only drop it if it hasn't been superseded by a newer event.
            if (prev[e.id]?.status !== e.status) return prev;
            const next = { ...prev };
            delete next[e.id];
            return next;
          });
        }, after);
      }
    });
  }, []);

  const dismiss = (id: string) =>
    setItems((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const list = Object.values(items).sort((a, b) => a._t - b._t);
  if (list.length === 0) return null;

  return (
    <CornerPortal>
      <div className="flex flex-col gap-2 w-72 pointer-events-auto">
      {list.map((u) => (
        <div key={u.id} className="bg-[var(--color-surface)] rounded-xl shadow-lg border border-[var(--color-border)] px-3 py-2.5 animate-in slide-in-from-bottom-2 fade-in">
          <div className="flex items-center gap-2">
            {u.status === "uploading" && <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)] shrink-0" />}
            {u.status === "done" && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
            {u.status === "error" && <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />}
            <span className="text-xs font-bold text-[var(--color-text)] truncate flex-1" title={u.name}>{u.name}</span>
            <span className={`text-[10px] font-black shrink-0 ${u.status === "error" ? "text-rose-500" : u.status === "done" ? "text-emerald-600" : "text-[var(--color-text-faint)]"}`}>
              {u.status === "uploading" ? (u.retrying && u.percent === 0 ? "Trying again" : `${Math.round(u.percent)}%`) : u.status === "done" ? "Done" : "Didn't upload"}
            </span>
            {u.status !== "uploading" && (
              <button onClick={() => dismiss(u.id)} className="p-0.5 rounded text-slate-300 hover:text-[var(--color-text-muted)] shrink-0" aria-label="Dismiss">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {u.status === "uploading" && (
            <div className="mt-1.5 h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
              <div className="h-full bg-[var(--color-text)] transition-all duration-200" style={{ width: `${Math.max(4, Math.round(u.percent))}%` }} />
            </div>
          )}
          {u.status === "uploading" && (() => { const left = timeLeft(u, Date.now()); return left || u.retrying ? <div className="text-[10px] text-[var(--color-text-muted)] mt-1">{u.retrying ? "The connection dropped. Picking up again on its own." : left}</div> : null; })()}
          {u.status === "error" && u.error && (
            <div className="text-[10px] text-rose-600 mt-1 line-clamp-3">{u.error}</div>
          )}
        </div>
      ))}
      </div>
    </CornerPortal>
  );
}
