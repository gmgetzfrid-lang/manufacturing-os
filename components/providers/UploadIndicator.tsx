"use client";

// Global upload indicator. Subscribes to the upload broadcast in lib/storage and
// shows a small bottom-right pill for every in-flight upload — filename, live
// progress bar, then a brief "Done" or a persistent "Failed" with the reason.
//
// Because every upload in the app goes through uploadToPath, this single mounted
// component gives consistent "it's working" feedback for a file attach ANYWHERE,
// regardless of which screen triggered it.
//
// Where it shows: on a desktop, in the side menu (lib/runningWork), with the
// same Try again and close; the corner cards below only when there's no side
// menu on screen (a phone).

import React, { useEffect, useState } from "react";
import { subscribeUploads, type UploadActivity } from "@/lib/storage";
import { subscribeUploadRetries } from "@/lib/uploadRetry";
import { Loader2, CheckCircle2, AlertCircle, X } from "lucide-react";
import { CornerPortal } from "@/components/ui/CornerDock";
import { publishRunning, useRunningDocked, type RunningItem } from "@/lib/runningWork";

type Tracked = UploadActivity & { _t: number; _p0?: { t: number; pct: number }; retry?: () => void };

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

  // A wrapped upload that failed: one card with Try again (the file is kept
  // in memory), replacing the transfer's own "didn't upload" card.
  useEffect(() => subscribeUploadRetries((e) => {
    setItems((prev) => {
      const next = { ...prev };
      if (e.kind === "failed") {
        for (const [k, v] of Object.entries(next)) if (v.name === e.name && v.status === "error" && !v.retry) delete next[k];
        next[e.id] = { id: e.id, name: e.name, percent: 0, status: "error", error: e.error, retry: e.retry, _t: prev[e.id]?._t ?? Date.now() };
      } else if (e.kind === "retrying") {
        if (next[e.id]) next[e.id] = { ...next[e.id], status: "uploading", percent: 0, retrying: true, retry: undefined, error: undefined };
      } else if (next[e.id]) {
        next[e.id] = { ...next[e.id], status: "done", percent: 100, retrying: false };
        window.setTimeout(() => setItems((p) => { if (p[e.id]?.status !== "done") return p; const n = { ...p }; delete n[e.id]; return n; }), 2500);
      }
      return next;
    });
  }), []);

  const dismiss = (id: string) =>
    setItems((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const all = Object.values(items).sort((a, b) => a._t - b._t);
  // Many failures at once (a big batch on a bad connection) fold into one
  // card with one Try again, so the corner doesn't fill up.
  const failed = all.filter((u) => u.status === "error");
  const grouped = failed.length > 3;
  const list = grouped ? all.filter((u) => u.status !== "error") : all;

  // The side menu's lines: the files going up as one line (how many are
  // done, the one going now), then each that didn't upload.
  useEffect(() => {
    const lines: RunningItem[] = [];
    const moving = all.filter((u) => u.status !== "error");
    const going = moving.filter((u) => u.status === "uploading");
    if (going.length) {
      const done = moving.length - going.length;
      const now = going[0]!;
      const pct = Math.round(moving.reduce((n, u) => n + (u.status === "done" ? 100 : u.percent), 0) / moving.length);
      lines.push({
        id: "uploads", kind: "upload",
        title: moving.length > 1 ? `Uploading ${moving.length} files` : "Uploading",
        detail: now.retrying && now.percent === 0 ? `${now.name}, trying again` : (timeLeft(now, Date.now()) ? `${now.name}, ${timeLeft(now, Date.now())}` : now.name),
        pct, right: moving.length > 1 ? `${done} of ${moving.length}` : `${pct}%`, state: "running",
      });
    }
    if (grouped) {
      lines.push({
        id: "uploads-failed", kind: "upload", title: `${failed.length} files didn't upload`, detail: failed[0]?.error, pct: null, state: "error",
        retry: failed.some((u) => u.retry) ? () => failed.forEach((u) => u.retry?.()) : undefined,
        dismiss: () => failed.forEach((u) => dismiss(u.id)),
      });
    } else {
      for (const u of failed) lines.push({ id: u.id, kind: "upload", title: "Didn't upload", detail: u.name, error: u.error, pct: null, state: "error", retry: u.retry, dismiss: () => dismiss(u.id) });
    }
    publishRunning("uploads", lines);
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps -- derived from items only
  useEffect(() => () => publishRunning("uploads", []), []);

  // The side menu shows them; the corner stays clear.
  const docked = useRunningDocked();
  if (all.length === 0 || docked) return null;

  return (
    <CornerPortal>
      <div className="flex flex-col gap-2 w-72 pointer-events-auto">
      {grouped && (
        <div className="bg-[var(--color-surface)] rounded-xl shadow-lg border border-[var(--color-border)] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-[var(--state-overdue-text)] shrink-0" />
            <span className="text-caption font-medium text-[var(--color-text)] flex-1">{failed.length} files didn&apos;t upload</span>
            <button onClick={() => failed.forEach((u) => dismiss(u.id))} className="p-0.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] shrink-0" aria-label="Close">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <details className="mt-1">
            <summary className="text-caption text-[var(--color-text-muted)] cursor-pointer">Show them</summary>
            <ul className="mt-1 max-h-40 overflow-y-auto space-y-0.5">
              {failed.map((u) => (
                <li key={u.id} className="text-caption text-[var(--color-text)] truncate" title={u.error}>{u.name}{u.error ? <span className="text-[var(--state-overdue-text)]">: {u.error}</span> : null}</li>
              ))}
            </ul>
          </details>
          {failed.some((u) => u.retry) && (
            <button type="button" onClick={() => failed.forEach((u) => u.retry?.())}
              className="mt-2 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-caption font-semibold hover:bg-[var(--color-accent-hover)]">
              Try them again
            </button>
          )}
        </div>
      )}
      {list.map((u) => (
        <div key={u.id} className="bg-[var(--color-surface)] rounded-xl shadow-lg border border-[var(--color-border)] px-3 py-2.5 animate-in slide-in-from-bottom-2 fade-in">
          <div className="flex items-center gap-2">
            {u.status === "uploading" && <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)] shrink-0" />}
            {u.status === "done" && <CheckCircle2 className="w-4 h-4 text-[var(--state-released-text)] shrink-0" />}
            {u.status === "error" && <AlertCircle className="w-4 h-4 text-[var(--state-overdue-text)] shrink-0" />}
            <span className="text-caption font-medium text-[var(--color-text)] truncate flex-1" title={u.name}>{u.name}</span>
            <span className={`text-caption font-semibold shrink-0 ${u.status === "error" ? "text-[var(--state-overdue-text)]" : u.status === "done" ? "text-[var(--state-released-text)]" : "text-[var(--color-text-faint)]"}`}>
              {u.status === "uploading" ? (u.retrying && u.percent === 0 ? "Trying again" : `${Math.round(u.percent)}%`) : u.status === "done" ? "Done" : "Didn't upload"}
            </span>
            {u.status !== "uploading" && (
              <button onClick={() => dismiss(u.id)} className="ui-hit p-0.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] shrink-0" aria-label="Dismiss">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {u.status === "uploading" && (
            <div className="mt-1.5 h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
              <div className="h-full bg-[var(--color-text)] transition-all duration-200" style={{ width: `${Math.max(4, Math.round(u.percent))}%` }} />
            </div>
          )}
          {u.status === "uploading" && (() => { const left = timeLeft(u, Date.now()); return left || u.retrying ? <div className="text-caption text-[var(--color-text-muted)] mt-1">{u.retrying ? "Trying again with the same file." : left}</div> : null; })()}
          {u.status === "error" && u.error && (
            <div className="text-caption text-[var(--state-overdue-text)] mt-1 line-clamp-3">{u.error}</div>
          )}
          {u.status === "error" && u.retry && (
            <button type="button" onClick={u.retry}
              className="mt-2 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-caption font-semibold hover:bg-[var(--color-accent-hover)]">
              Try again
            </button>
          )}
        </div>
      ))}
      </div>
    </CornerPortal>
  );
}
