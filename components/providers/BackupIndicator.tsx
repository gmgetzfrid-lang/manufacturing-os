"use client";

// BackupIndicator — the floating progress card for a running full backup.
// Mounted in the app shell, so it follows the user to ANY page: the backup
// keeps running while they work elsewhere, and this keeps saying exactly
// what it's doing — which file, which part, how far along. Closing or
// refreshing the tab is the only thing that kills a run (a beforeunload
// warning guards that); navigating inside the app never does.
//
// Where it shows: on a desktop, in the side menu with the other running
// work (lib/runningWork), with Cancel and close; this floating card only
// when there's no side menu on screen (a phone).

import React, { useEffect, useState } from "react";
import { Loader2, X, HardDriveDownload, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  subscribeBackup, cancelBackup, dismissBackup, type BackupProgress,
} from "@/lib/clientBackup";
import { publishRunning, useRunningDocked } from "@/lib/runningWork";

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

export default function BackupIndicator() {
  const [p, setP] = useState<BackupProgress | null>(null);
  useEffect(() => subscribeBackup(setP), []);
  const docked = useRunningDocked();

  // The side menu's line for it.
  useEffect(() => {
    if (!p) { publishRunning("backup", []); return; }
    const pctNow = p.filesTotal > 0 ? Math.round((p.filesDone / p.filesTotal) * 100) : 5;
    const running = !(p.phase === "done" || p.phase === "cancelled" || p.phase === "failed");
    publishRunning("backup", [running ? {
      id: "backup", kind: "backup", title: "Backup",
      detail: `${p.phase === "envelope" ? "Reading every table" : p.phase === "files" ? `File ${p.filesDone + 1} of ${p.filesTotal}` : `Packing part ${p.part}`}. Keep this tab open.`,
      pct: pctNow, right: `${pctNow}%`, state: "running", cancel: cancelBackup,
    } : p.phase === "failed" ? {
      id: "backup", kind: "backup", title: "Backup failed", pct: null, state: "error", error: p.fatalError ?? undefined, dismiss: dismissBackup,
    } : {
      id: "backup", kind: "backup", title: p.phase === "cancelled" ? "Backup cancelled" : "Backup complete", pct: null, state: "done", dismiss: dismissBackup,
      detail: p.phase === "cancelled" ? "The parts so far are saved." : p.errors.length ? `${p.errors.length} file${p.errors.length === 1 ? "" : "s"} missed: see backup-report.json in the last part.` : `${p.part} part${p.part === 1 ? "" : "s"}, every file checked.`,
    }]);
  }, [p]);
  useEffect(() => () => publishRunning("backup", []), []);

  if (!p || docked) return null;

  const pct = p.filesTotal > 0 ? Math.round((p.filesDone / p.filesTotal) * 100) : 5;
  const finished = p.phase === "done" || p.phase === "cancelled" || p.phase === "failed";

  return (
    <div className="fixed bottom-5 left-5 z-[300] w-[340px] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl p-3.5 animate-in slide-in-from-bottom-4">
      <div className="flex items-center gap-2 mb-2">
        {p.phase === "failed" ? (
          <AlertTriangle className="w-4 h-4 text-[var(--state-overdue-text)] shrink-0" />
        ) : finished ? (
          <CheckCircle2 className="w-4 h-4 text-[var(--state-released-text)] shrink-0" />
        ) : (
          <HardDriveDownload className="w-4 h-4 text-[var(--state-released-text)] shrink-0" />
        )}
        <span className="text-caption font-semibold text-[var(--color-text)] flex-1">
          {p.phase === "envelope" && "Backup - reading every table…"}
          {p.phase === "files" && `Backup - file ${p.filesDone + 1} of ${p.filesTotal}`}
          {p.phase === "finalizing" && `Backup - packing part ${p.part}…`}
          {p.phase === "done" && `Backup complete - ${p.part} part(s)`}
          {p.phase === "cancelled" && "Backup cancelled - partial parts saved"}
          {p.phase === "failed" && "Backup failed"}
        </span>
        {finished ? (
          <button onClick={dismissBackup} className="p-1 rounded hover:bg-[var(--color-surface-2)]" title="Dismiss">
            <X className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
          </button>
        ) : (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-text-muted)] shrink-0" />
        )}
      </div>

      {!finished && (
        <>
          <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden mb-1.5">
            <div className="h-full bg-[var(--state-released)] transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-caption text-[var(--color-text-muted)] truncate" title={p.currentPath}>
            {p.currentPath
              ? `Fetching ${p.currentPath.split("/").pop()}`
              : p.phase === "envelope" ? "Tables, records, and file links" : "…"}
          </div>
          <div className="mt-1.5 flex items-center justify-between text-caption text-[var(--color-text-muted)]">
            <span>{mb(p.bytesDone)}{p.bytesTotal > 0 ? ` of ~${mb(p.bytesTotal)}` : ""} · part {p.part}</span>
            <button onClick={cancelBackup} className="font-semibold text-[var(--state-overdue-text)] hover:underline">Cancel</button>
          </div>
          <div className="mt-1.5 text-caption text-[var(--color-text-faint)]">
            Keep this tab open - you can use the app freely while it runs.
          </div>
        </>
      )}

      {p.phase === "failed" && p.fatalError && (
        <div className="text-caption text-[var(--state-overdue-text)]">{p.fatalError}</div>
      )}
      {finished && p.phase !== "failed" && (
        <div className="text-caption text-[var(--color-text-muted)]">
          {p.errors.length > 0
            ? `${p.errors.length} file(s) missed - see backup-report.json in the last part.`
            : "Every file SHA-256 verified - manifest in the last part."}
        </div>
      )}
    </div>
  );
}
