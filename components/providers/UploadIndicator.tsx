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

type Tracked = UploadActivity & { _t: number };

export default function UploadIndicator() {
  const [items, setItems] = useState<Record<string, Tracked>>({});

  useEffect(() => {
    return subscribeUploads((e) => {
      setItems((prev) => ({ ...prev, [e.id]: { ...e, _t: prev[e.id]?._t ?? Date.now() } }));
      if (e.status === "done" || e.status === "error") {
        const after = e.status === "done" ? 2500 : 7000;
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
    <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 w-72">
      {list.map((u) => (
        <div key={u.id} className="bg-white rounded-xl shadow-lg border border-slate-200 px-3 py-2.5 animate-in slide-in-from-bottom-2 fade-in">
          <div className="flex items-center gap-2">
            {u.status === "uploading" && <Loader2 className="w-4 h-4 animate-spin text-orange-500 shrink-0" />}
            {u.status === "done" && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
            {u.status === "error" && <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />}
            <span className="text-xs font-bold text-slate-800 truncate flex-1" title={u.name}>{u.name}</span>
            <span className={`text-[10px] font-black shrink-0 ${u.status === "error" ? "text-rose-500" : u.status === "done" ? "text-emerald-600" : "text-slate-400"}`}>
              {u.status === "uploading" ? `${Math.round(u.percent)}%` : u.status === "done" ? "Done" : "Failed"}
            </span>
            {u.status !== "uploading" && (
              <button onClick={() => dismiss(u.id)} className="p-0.5 rounded text-slate-300 hover:text-slate-600 shrink-0" aria-label="Dismiss">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {u.status === "uploading" && (
            <div className="mt-1.5 h-1 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-orange-500 transition-all duration-200" style={{ width: `${Math.max(4, Math.round(u.percent))}%` }} />
            </div>
          )}
          {u.status === "error" && u.error && (
            <div className="text-[10px] text-rose-600 mt-1 line-clamp-2">{u.error}</div>
          )}
        </div>
      ))}
    </div>
  );
}
