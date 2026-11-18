// lib/libraryColumnWidths.ts — a library's shared column widths: who saves
// them, when, and how the stored widths and this tab's own widths combine
// (document-control REV-38 / REV-39, DEC-90).
//
// The widths live where they always have: `libraries.column_widths`, read
// when the library loads and live-synced from the row's realtime UPDATE. The
// library page never wrote them (the two saves that stood there were never
// sent — projects-tab SAF-22, ruling R1). Now:
//   * a CONTROLLER (Admin / DocCtrl by the role collection, mirroring the
//     database's `is_org_controller`) saves the shared width, debounced: one
//     save ~500 ms after a drag that changed a width, or a reset of a column
//     that differed from its default. A save that does not land is said in
//     plain words, and the width stays as dragged;
//   * anyone else still resizes, for this view only — nothing is written,
//     and the handle says so (COLUMN_WIDTH_VIEW_ONLY_TITLE).
//
// An ORDERED stored map (the integrator's ruling at the F6 stress review).
// Since 20261271 every map this tab learns carries the row's server-owned
// version, `column_widths_rev` (+1 on every change of column_widths): the
// load, the realtime row and the save's own answer. The saver holds the
// latest stored map and replaces it only with a map whose version is not
// older (a late load, a late echo are ignored). It also holds the columns
// THIS TAB changed and has not yet seen stored (`dirty`); after any change of
// the stored map every dirty entry that the stored map now shows is cleared.
// The screen is the stored map with the dirty columns on top, and the column
// under an active drag stays where the drag has it. A save sends ONLY this
// tab's changed and reset columns, and save_library_column_widths merges
// them per column on the server, in one statement, answering the committed
// map and its version — so a save never carries a stale copy of a column it
// did not touch, and no echo has to be recognised. A save that answers ok
// clears the columns it sent (unless changed again since) even when its
// answer is older than a map already held. Saves go one at a time.
//
// Before 20261271 is pasted (the function answers PGRST202 / 42883, the
// column 42703 / PGRST204): no version exists, so every map is taken as it
// arrives (today's order), and the save falls back to the whole-map checked
// write — but it re-reads the row's column_widths just before writing and
// sends that map with this tab's columns on top, and takes the committed row
// it reads back. The one thing only the version can fix stays, before the
// paste only: a map read or answered earlier but delivered later (a late
// fresh load) can replace a newer one until the next map arrives.
//
// A person who may not save keeps their own columns as view-only dirty
// entries while the page is open: their widths survive a controller's save
// of other columns, and theirs win on the columns they set. When they become
// one who may save (the roles finish loading, or a promotion), the columns
// last changed while they could not save are dropped — never sent — and the
// screen is recomposed; a column they changed while they could save is kept
// and a save is scheduled for it.

import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkedWrite } from "@/lib/checkedWrite";
import { answered, keptAnswer } from "@/lib/checkedWriteAnswer";
import { notLandedReason } from "@/lib/checkedWriteReason";

export const COLUMN_WIDTH_SAVE_DEBOUNCE_MS = 500;
/** The bounds a drag is clamped to — the same the database function holds a saved width to (20261271). */
export const COLUMN_WIDTH_MIN = 50;
export const COLUMN_WIDTH_MAX = 5000;

/** The handle's title for a person whose widths are not saved. */
export const COLUMN_WIDTH_VIEW_ONLY_TITLE = "Column width applies to this view only";

export type ColumnWidths = Record<string, number>;
/** A stored map's version (`libraries.column_widths_rev`); null before 20261271. */
export type ColumnWidthsRev = number | null;

/** What this tab sends: the columns it changed, and the columns it reset to their default. */
export interface ColumnWidthChanges { set: ColumnWidths; reset: string[] }

/** What a width save answered: landed (with the committed map, and its
 *  version when the database has one), or the reason it did not (worded as
 *  a reason — lib/checkedWriteReason — never "nothing was changed", since the
 *  width on this screen did change). */
export type ColumnWidthSaveAnswer =
  | { ok: true; widths: ColumnWidths | null; rev: ColumnWidthsRev }
  | { ok: false; reason: string };

/** What the page says when a save did not land. */
export function columnWidthNotSavedMessage(reason: string): string {
  return `The column width was not saved for everyone — it still applies to this view: ${reason}`;
}

/** A version as PostgREST or the realtime row carries it (a bigint may come as a string). */
export function revOf(v: unknown): ColumnWidthsRev {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** A stored column_widths value as a map: only number entries; anything else is no widths. */
export function widthsOf(v: unknown): ColumnWidths {
  const out: ColumnWidths = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
    if (typeof w === "number" && Number.isFinite(w)) out[k] = w;
  }
  return out;
}

/** A map with the changes on top (a reset removes the key). */
export function applyColumnWidthChanges(base: ColumnWidths, changes: ColumnWidthChanges): ColumnWidths {
  const out: ColumnWidths = { ...base, ...changes.set };
  for (const k of changes.reset) delete out[k];
  return out;
}

/** The answers that mean 20261271 is not pasted (or the API has not reloaded its schema). */
const BEFORE_MERGE_CODES = new Set(["PGRST202", "42883", "42703", "PGRST204"]);

/** The stored widths with their version, or null when the version cannot be
 *  read (before 20261271, or the read failed): the caller keeps the
 *  unversioned map it already has. */
export async function readLibraryColumnWidths(sb: SupabaseClient, libraryId: string): Promise<{ widths: ColumnWidths; rev: number } | null> {
  const { data, error } = await sb.from("libraries").select("column_widths, column_widths_rev").eq("id", libraryId).maybeSingle();
  if (error || !data) return null;
  const row = data as { column_widths?: unknown; column_widths_rev?: unknown };
  const rev = revOf(row.column_widths_rev);
  return rev === null ? null : { widths: widthsOf(row.column_widths), rev };
}

/** Save this tab's changed / reset columns. Through save_library_column_widths
 *  (20261271: a per-column merge on the server, held to a controller, the
 *  committed map and version answered); before the paste, a re-read of the
 *  row's column_widths and the whole-map checked write (`.select("id,
 *  column_widths")`) of that map with the changes on top. Never throws. */
export async function saveLibraryColumnWidths(
  sb: SupabaseClient,
  libraryId: string,
  changes: ColumnWidthChanges,
  uid: string | null,
): Promise<ColumnWidthSaveAnswer> {
  const kept = keptAnswer();
  const merged = await checkedWrite(answered(sb.rpc("save_library_column_widths", { p_library: libraryId, p_set: changes.set, p_reset: changes.reset }), kept));
  if (merged.ok) {
    const row = (Array.isArray(kept.data) ? kept.data[0] : kept.data) as { column_widths?: unknown; column_widths_rev?: unknown } | undefined;
    return { ok: true, widths: row ? widthsOf(row.column_widths) : null, rev: row ? revOf(row.column_widths_rev) : null };
  }
  if (!kept.error || !BEFORE_MERGE_CODES.has(String(kept.error.code ?? ""))) {
    return { ok: false, reason: notLandedReason(kept, "library column widths") };
  }
  // Before 20261271: the whole map, re-read just before the write.
  const fresh = await sb.from("libraries").select("column_widths").eq("id", libraryId).maybeSingle();
  if (fresh.error || !fresh.data) return { ok: false, reason: notLandedReason({ error: fresh.error ?? null }, "library column widths") };
  const payload = applyColumnWidthChanges(widthsOf((fresh.data as { column_widths?: unknown }).column_widths), changes);
  const wrote = keptAnswer();
  const saved = await checkedWrite(answered(sb.from("libraries").update({ column_widths: payload, updated_by: uid }).eq("id", libraryId).select("id, column_widths"), wrote));
  if (!saved.ok) return { ok: false, reason: notLandedReason(wrote, "library column widths") };
  const row = (Array.isArray(wrote.data) ? wrote.data[0] : wrote.data) as { column_widths?: unknown } | undefined;
  return { ok: true, widths: row ? widthsOf(row.column_widths) : payload, rev: null };
}

/** The same widths in any key order give the same key. */
export function columnWidthsKey(widths: ColumnWidths | null | undefined): string {
  const w = widths ?? {};
  return JSON.stringify(Object.keys(w).sort().map((k) => [k, w[k]]));
}

/** A column this tab set: a width, or `null` for "reset to the default". */
export type DirtyColumns = ReadonlyMap<string, number | null>;

/** The stored map with this tab's dirty columns on top (null removes); the
 *  column under an active drag (if any) stays as `prev` has it. */
export function composeColumnWidths(
  stored: ColumnWidths,
  dirty: DirtyColumns,
  prev: ColumnWidths,
  dragging: string | null,
): ColumnWidths {
  const out: ColumnWidths = { ...stored };
  for (const [k, v] of dirty) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  if (dragging) {
    if (dragging in prev) out[dragging] = prev[dragging];
    else delete out[dragging];
  }
  return out;
}

export interface ColumnWidthSaverDeps {
  /** May this person save the shared width? Read when a change is made and when a save would be sent. */
  canSave(): boolean;
  /** Send this tab's changed / reset columns. */
  save(changes: ColumnWidthChanges): Promise<ColumnWidthSaveAnswer>;
  /** Say a save that did not land. `afterClose`: the library or page it was
   *  made on has since been left (the save was sent as it closed). */
  notSaved(message: string, afterClose: boolean): void;
  /** Put the composed widths on the screen. */
  apply(update: (prev: ColumnWidths) => ColumnWidths): void;
  /** The column under an active drag, if any. */
  dragging(): string | null;
  debounceMs?: number;
}

export interface ColumnWidthSaver {
  /** A stored map from the session cache or a load, with its version (null:
   *  none). Taken unless it is older than the map held (an unversioned map is
   *  not taken once a version is held). Answers whether it was taken. */
  load(widths: ColumnWidths, rev: ColumnWidthsRev): boolean;
  /** The row's realtime UPDATE: the same rule as load. */
  remote(widths: ColumnWidths, rev: ColumnWidthsRev): boolean;
  /** A drag ended on `width`, or a reset (`null`). Answers false — and
   *  changes nothing — when the column already has that value. A person who
   *  may save gets one save ~500 ms after the last change; anyone else's
   *  change is kept for this view only and nothing is written. */
  change(column: string, width: number | null): boolean;
  /** Re-compose the screen (after a press that changed nothing, so the
   *  column it held takes any stored width that arrived meanwhile). */
  settle(): void;
  /** This person may now save (they could not before): drop the columns last
   *  changed while they could not save (never sent), recompose the screen,
   *  and schedule a save of any column they changed while they could. */
  promoted(): void;
  /** Send this tab's unsaved columns now, when there are any (the tab
   *  hidden, the page hiding). */
  flush(): Promise<void>;
  /** The library or page is being left: unsaved columns are sent now. */
  dispose(): void;
}

export function createColumnWidthSaver(deps: ColumnWidthSaverDeps): ColumnWidthSaver {
  const wait = deps.debounceMs ?? COLUMN_WIDTH_SAVE_DEBOUNCE_MS;
  let stored: ColumnWidths = {};
  let storedRev: ColumnWidthsRev = null;
  const dirty = new Map<string, number | null>();
  /** Dirty columns last changed while this person could not save. */
  const viewOnly = new Set<string>();
  /** The columns of the save in flight. */
  let sending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let again = false;
  let closed = false;

  const valueOf = (col: string): number | null => (Object.prototype.hasOwnProperty.call(stored, col) ? stored[col] : null);
  const show = () => {
    const snapshot = new Map(dirty);
    const base = stored;
    deps.apply((prev) => composeColumnWidths(base, snapshot, prev, deps.dragging()));
  };
  const forget = (col: string) => { dirty.delete(col); viewOnly.delete(col); };

  /** Take a stored map unless it is older than the one held; then clear
   *  every dirty column it shows. */
  function accept(widths: ColumnWidths, rev: ColumnWidthsRev): boolean {
    if (storedRev !== null && (rev === null || rev < storedRev)) return false;
    stored = { ...widths };
    if (rev !== null) storedRev = rev;
    for (const [col, v] of [...dirty]) {
      if (valueOf(col) === v) forget(col);
    }
    show();
    return true;
  }

  /** This tab's columns to send (never a view-only one), or null when none. */
  function pending(): ColumnWidthChanges | null {
    const set: ColumnWidths = {};
    const reset: string[] = [];
    for (const [col, v] of dirty) {
      if (viewOnly.has(col)) continue;
      if (v === null) reset.push(col);
      else set[col] = v;
    }
    return Object.keys(set).length > 0 || reset.length > 0 ? { set, reset } : null;
  }

  async function send(): Promise<void> {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    // A person who may no longer save sends nothing (their change stays on
    // their screen; a promotion schedules it again).
    if (!deps.canSave()) return;
    // One save at a time.
    if (inFlight) { again = true; return; }
    const changes = pending();
    if (!changes) return;
    inFlight = true;
    sending = new Set([...Object.keys(changes.set), ...changes.reset]);
    let answer: ColumnWidthSaveAnswer;
    try {
      answer = await deps.save(changes);
    } catch (e) {
      answer = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    inFlight = false;
    sending = new Set();
    if (answer.ok) {
      // Landed: the columns it sent are saved (unless changed again since),
      // whatever the order its answer arrives in.
      for (const [col, v] of Object.entries(changes.set)) if (!viewOnly.has(col) && dirty.get(col) === v) forget(col);
      for (const col of changes.reset) if (!viewOnly.has(col) && dirty.has(col) && dirty.get(col) === null) forget(col);
      // Its answer is one more versioned map (ignored when older than the
      // map held); the screen is recomposed either way.
      if (!answer.widths || !accept(answer.widths, answer.rev)) show();
    } else {
      // Nothing landed (or the answer was lost): the columns stay dirty —
      // the width stays as dragged, and a later map that shows the value, or
      // the next save, settles it.
      deps.notSaved(columnWidthNotSavedMessage(answer.reason), closed);
    }
    if (again) { again = false; await send(); }
  }

  function schedule() {
    if (closed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void send(); }, wait);
  }

  return {
    load(widths, rev) { return accept(widths, rev); },
    remote(widths, rev) { return accept(widths, rev); },
    change(column, width) {
      const current = dirty.has(column) ? dirty.get(column)! : valueOf(column);
      if (current === width) { show(); return false; }
      const canSave = deps.canSave();
      if (valueOf(column) === width && !sending.has(column)) {
        // Back to what is stored (and no save of this column is in flight).
        forget(column);
      } else {
        dirty.set(column, width);
        if (canSave) viewOnly.delete(column);
        else viewOnly.add(column);
      }
      show();
      if (canSave) schedule();
      return true;
    },
    settle() { show(); },
    promoted() {
      if (viewOnly.size > 0) {
        for (const col of viewOnly) dirty.delete(col);
        viewOnly.clear();
        show();
      }
      if (pending()) schedule();
    },
    async flush() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (!pending()) return;
      await send();
    },
    dispose() {
      if (closed) return;
      closed = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (pending()) void send();
    },
  };
}

export interface UseLibraryColumnWidthsOptions {
  libraryId: string | null | undefined;
  /** The controller tier (who saves the shared width). */
  canSave: boolean;
  uid: string | null;
  client: SupabaseClient;
  setColWidths: Dispatch<SetStateAction<ColumnWidths>>;
  /** The column under an active drag, if any (the page's resizingRef). */
  dragging: () => string | null;
  notSaved: (message: string, afterClose: boolean) => void;
}

/** One saver per library. Call it BEFORE the effect that loads the library,
 *  so the saver exists when the load hands it the stored widths. Unsaved
 *  columns are sent when the library changes or the page unmounts, and —
 *  best effort, the browser may not finish the request — when the tab is
 *  hidden or the page is being unloaded (pagehide). No leave-page prompt. */
export function useLibraryColumnWidths(opts: UseLibraryColumnWidthsOptions): MutableRefObject<ColumnWidthSaver | null> {
  const saverRef = useRef<ColumnWidthSaver | null>(null);
  const live = useRef(opts);
  // What the saver reads when it acts — who may save, the uid, the client —
  // kept current on every render (pinned).
  const couldSave = useRef(opts.canSave);
  useEffect(() => {
    live.current = opts;
    // Becoming one who may save: view-only columns are never sent; the
    // columns changed as one who may save are scheduled.
    if (!couldSave.current && opts.canSave) saverRef.current?.promoted();
    couldSave.current = opts.canSave;
  });
  const { libraryId } = opts;
  useEffect(() => {
    if (!libraryId) return;
    const saver = createColumnWidthSaver({
      canSave: () => live.current.canSave,
      save: (changes) => saveLibraryColumnWidths(live.current.client, libraryId, changes, live.current.uid),
      notSaved: (message, afterClose) => live.current.notSaved(message, afterClose),
      apply: (update) => live.current.setColWidths(update),
      dragging: () => live.current.dragging(),
    });
    saverRef.current = saver;
    const onPageHide = () => { void saver.flush(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") void saver.flush(); };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      saver.dispose();
      if (saverRef.current === saver) saverRef.current = null;
    };
  }, [libraryId]);
  return saverRef;
}

// ── the resize handle's click vs drag ────────────────────────────────────

/** A press that moves less than this is a click, not a drag. */
export const RESIZE_DRAG_THRESHOLD_PX = 3;

/** A press on the resize handle: a drag (it moved past the threshold) or
 *  not. What a click on the handle does is the page's, per group, each as
 *  on the base (F6 second review, item 2): for a person who may save, a
 *  click does nothing and a double-click resets; for anyone else (who had
 *  no handle, so the whole header sorted) the click goes on to the header
 *  and sorts at once, and there is no double-click reset. A real drag never
 *  sorts for anyone: the header click that ends it is swallowed, once. */
export interface ResizeHandleGesture {
  /** The press began at x. */
  down(x: number): void;
  /** The pointer is at x: answers whether this press is now a drag. */
  move(x: number): boolean;
  /** The press ended: answers whether it was a drag. After a drag the
   *  header's own click (a drag that ends inside the header) is swallowed. */
  up(): boolean;
  /** The header was clicked: true when this click ends a drag (swallow it). */
  headerClick(): boolean;
  dispose(): void;
}

export function createResizeHandleGesture(opts?: { thresholdPx?: number }): ResizeHandleGesture {
  const threshold = opts?.thresholdPx ?? RESIZE_DRAG_THRESHOLD_PX;
  let startX: number | null = null;
  let moved = false;
  let swallowHeader = false;
  let swallowTimer: ReturnType<typeof setTimeout> | null = null;
  return {
    down(x) { startX = x; moved = false; },
    move(x) {
      if (startX !== null && !moved && Math.abs(x - startX) >= threshold) moved = true;
      return moved;
    },
    up() {
      startX = null;
      if (moved) {
        swallowHeader = true;
        // The click (if any) is dispatched right after the press ends; a
        // drag that ends outside the header gets none, so do not keep the
        // swallow for the next real click.
        if (swallowTimer !== null) clearTimeout(swallowTimer);
        swallowTimer = setTimeout(() => { swallowHeader = false; swallowTimer = null; }, 0);
      }
      return moved;
    },
    headerClick() {
      if (!swallowHeader) return false;
      swallowHeader = false;
      return true;
    },
    dispose() {
      if (swallowTimer !== null) { clearTimeout(swallowTimer); swallowTimer = null; }
    },
  };
}
