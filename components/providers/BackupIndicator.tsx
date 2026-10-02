"use client";

// BackupIndicator — the floating progress card for a running full backup.
// Mounted in the app shell, so it follows the user to ANY page: the backup
// keeps running while they work elsewhere, and this keeps saying exactly
// what it's doing — which file, which part, how far along. Closing or
// refreshing the tab is the only thing that kills a run (a beforeunload
// warning guards that); navigating inside the app never does.
//
// notifications Round G, N7 CORNER (STACK-8 / TAX-14): the card lives in the
// corner dock's jobs slot, pinned nearest the corner — it used to pin itself
// to the bottom-LEFT at z-300, over the offline / update pills there. It
// minimizes to a pill like the indexing card, and Cancel asks first: one
// stray click used to end a 40-minute run.

import React, { useEffect, useState } from "react";
import { Loader2, X, HardDriveDownload, CheckCircle2, AlertTriangle, Minus } from "lucide-react";
import {
  subscribeBackup, cancelBackup, dismissBackup, type BackupProgress,
} from "@/lib/clientBackup";
import { appConfirm } from "@/components/providers/DialogProvider";
import { CornerPortal, useDockAllowance, DOCK_PRIORITY } from "@/components/ui/CornerDock";

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

/** Cancel only after the person says so — a cancelled backup cannot be
 *  resumed, only re-run. */
export async function confirmCancelBackup(
  confirm: typeof appConfirm = appConfirm,
  cancel: () => void = cancelBackup,
): Promise<boolean> {
  const ok = await confirm({
    title: "Cancel the backup?",
    message: "The parts already saved stay on your device, but the backup will be incomplete — files not yet fetched are in no part of it. It cannot be resumed; a new backup starts from the beginning.",
    confirmLabel: "Cancel backup",
    cancelLabel: "Keep running",
    tone: "danger",
  });
  if (ok) cancel();
  return ok;
}

export default function BackupIndicator() {
  const [p, setP] = useState<BackupProgress | null>(null);
  const [minimized, setMinimized] = useState(false);
  useEffect(() => subscribeBackup(setP), []);

  const pct = p && p.filesTotal > 0 ? Math.round((p.filesDone / p.filesTotal) * 100) : 5;
  const finished = !!p && (p.phase === "done" || p.phase === "cancelled" || p.phase === "failed");
  const allowance = useDockAllowance("jobs", DOCK_PRIORITY.backup, p ? 1 : 0, !p ? null
    : p.phase === "failed" ? { label: "Backup failed", tone: "error" }
    : finished ? { label: p.phase === "cancelled" ? "Backup cancelled" : "Backup complete", tone: "ok" }
    : { label: `Backup ${pct}%`, tone: "busy" });
  if (!p || allowance === 0) return null;

  if (minimized) {
    return (
      <CornerPortal slot="jobs" priority={DOCK_PRIORITY.backup}>
        <button
          onClick={() => setMinimized(false)}
          title={finished ? "Backup finished — click to expand" : "Backup running — click to expand"}
          className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg px-3 py-1.5 text-[11px] font-black text-[var(--color-text)] hover:shadow-xl transition-shadow"
        >
          {p.phase === "failed"
            ? <><AlertTriangle className="w-3.5 h-3.5 text-rose-600" /> Backup failed</>
            : finished
              ? <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Backup {p.phase === "cancelled" ? "cancelled" : "done"}</>
              : <><Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600" /> Backup {pct}%</>}
        </button>
      </CornerPortal>
    );
  }

  return (
    <CornerPortal slot="jobs" priority={DOCK_PRIORITY.backup}>
    <div className="pointer-events-auto w-[min(340px,calc(100vw-2rem))] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl p-3.5 animate-in slide-in-from-bottom-4">
      <div className="flex items-center gap-2 mb-2">
        {p.phase === "failed" ? (
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
        ) : finished ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
        ) : (
          <HardDriveDownload className="w-4 h-4 text-emerald-600 shrink-0" />
        )}
        <span className="text-xs font-black text-[var(--color-text)] flex-1">
          {p.phase === "envelope" && "Backup — reading every table…"}
          {p.phase === "files" && `Backup — file ${p.filesDone + 1} of ${p.filesTotal}`}
          {p.phase === "finalizing" && `Backup — packing part ${p.part}…`}
          {p.phase === "done" && `Backup complete — ${p.part} part(s)`}
          {p.phase === "cancelled" && "Backup cancelled — partial parts saved"}
          {p.phase === "failed" && "Backup failed"}
        </span>
        <button onClick={() => setMinimized(true)} className="p-1 rounded hover:bg-[var(--color-surface-2)] shrink-0" title="Minimize — the backup keeps running">
          <Minus className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
        </button>
        {finished ? (
          <button onClick={dismissBackup} className="p-1 rounded hover:bg-[var(--color-surface-2)]" title="Dismiss" aria-label="Dismiss">
            <X className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
          </button>
        ) : (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-text-muted)] shrink-0" />
        )}
      </div>

      {!finished && (
        <>
          <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden mb-1.5">
            <div className="h-full bg-emerald-600 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[10px] text-[var(--color-text-muted)] truncate" title={p.currentPath}>
            {p.currentPath
              ? `Fetching ${p.currentPath.split("/").pop()}`
              : p.phase === "envelope" ? "Tables, records, and file links" : "…"}
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
            <span>{mb(p.bytesDone)}{p.bytesTotal > 0 ? ` of ~${mb(p.bytesTotal)}` : ""} · part {p.part}</span>
            <button onClick={() => { void confirmCancelBackup(); }} className="font-black text-rose-600 hover:underline">Cancel</button>
          </div>
          <div className="mt-1.5 text-[9px] text-[var(--color-text-faint)]">
            Keep this tab open — you can use the app freely while it runs.
          </div>
        </>
      )}

      {p.phase === "failed" && p.fatalError && (
        <div className="text-[10px] text-rose-600">{p.fatalError}</div>
      )}
      {finished && p.phase !== "failed" && (
        <div className="text-[10px] text-[var(--color-text-muted)]">
          {p.errors.length > 0
            ? `${p.errors.length} file(s) missed — see backup-report.json in the last part.`
            : "Every file SHA-256 verified — manifest in the last part."}
        </div>
      )}
    </div>
    </CornerPortal>
  );
}
