// lib/runningWork.ts - work that runs in the background (uploads, the AI
// reading the library), told to whatever shows it.
//
// The drivers (components/providers/UploadIndicator, KnowledgeIndexIndicator,
// BackupIndicator)
// publish what they're doing here. On a desktop the side menu shows it, with
// progress, while it runs; the floating corner cards only show when there is
// no side menu on screen (a phone, where the menu is a closed drawer).

import { useSyncExternalStore } from "react";

export interface RunningItem {
  id: string;
  kind: "upload" | "reading" | "backup";
  /** "Uploading 3 files", "Reading the library". */
  title: string;
  /** The file or document, and where it is: "5602-D 1000, page 4 of 12". */
  detail?: string;
  /** 0 to 100, or null when not known yet. */
  pct: number | null;
  /** Short value at the right: "62%", "2 of 3". */
  right?: string;
  state: "running" | "done" | "error";
  /** What went wrong, in words. */
  error?: string;
  /** Try a failed upload again (the file is kept in memory). */
  retry?: () => void;
  /** Close a finished or failed line. */
  dismiss?: () => void;
  /** Stop it while it runs (a backup). */
  cancel?: () => void;
}

const bySource = new Map<string, RunningItem[]>();
let snapshot: RunningItem[] = [];
let docked = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** A driver's current lines (replaces its earlier ones; [] clears them). */
export function publishRunning(source: string, items: RunningItem[]): void {
  if (items.length) bySource.set(source, items); else bySource.delete(source);
  snapshot = [...bySource.values()].flat();
  emit();
}

/** Everything running now, in the order the drivers published. */
export function useRunning(): RunningItem[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** The side menu says it is on screen and shows running work. */
export function setRunningDock(on: boolean): void {
  if (docked === on) return;
  docked = on;
  emit();
}

/** Whether the side menu shows running work (then the corner cards don't). */
export function useRunningDocked(): boolean {
  return useSyncExternalStore(subscribe, () => docked, () => false);
}
