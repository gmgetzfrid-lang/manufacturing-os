// lib/libraryColumnWidths.ts — a library's shared column widths: who saves
// them, when, and how a stored width and this tab's own widths combine
// (document-control REV-38, DEC-90).
//
// The widths live where they always have: `libraries.column_widths`, read
// when the library loads and live-synced from the row's realtime UPDATE. The
// library page never wrote them (the two saves that stood there were never
// sent — projects-tab SAF-22, ruling R1). Now:
//   * a CONTROLLER (Admin / DocCtrl by the role collection — the page's
//     controller tier, `isControllerPrincipal`, which mirrors the database's
//     `is_org_controller`) saves the shared width, debounced: one save
//     ~500 ms after a drag that changed a width, or a reset of a column that
//     differed from its default, through a checked write. A save that does
//     not land is said in plain words, and the width stays as dragged;
//   * anyone else still resizes, for this view only — nothing is written,
//     and the handle says so (COLUMN_WIDTH_VIEW_ONLY_TITLE).
//
// Per-column last-writer-wins (the integrator's ruling at the F6 review).
// The saver keeps the latest KNOWN STORED map (the load, then every realtime
// UPDATE — none is dropped) and the columns THIS TAB changed and has not yet
// seen saved (`dirty`). What the screen shows is the stored map with the
// dirty columns laid on top, and the column under an active drag left where
// the drag has it. A save sends the same composition, so it never carries a
// stale copy of a column this tab did not touch. The echo of this tab's own
// save (the UPDATE carrying exactly what it sent) clears the dirty columns
// it carried (unless changed again since) — and so does the save's own ok
// answer, so a missed echo (realtime reconnecting, a throttled background
// tab) never leaves a column dirty for good. On that ok answer, unless the
// save's echo already came back, the columns it carried are laid over the
// latest known stored map (whether or not another map arrived during the
// flight), so the screen never jumps back and the next save never re-sends
// an older value of a column this tab saved; a map that arrives later
// (another controller's later save, or this tab's own echo) replaces the
// stored map as before. A save whose payload equals the latest known stored
// map is not sent (it would change nothing but `updated_by`). A person who
// may not save keeps
// their own columns dirty for as long as the page is open — their view-only
// widths survive a controller's save of other columns, and theirs win on
// the columns they set. When such a person becomes one who may save (the
// roles finish loading, or a promotion while the page is open), the columns
// last changed while they could not save are dropped — never sent as the
// shared width — and the screen is recomposed from the stored map; a column
// they changed while they could save is kept (and saved).
//
// The limit, stated (DEC-29): the write replaces the whole map. A save by
// another tab that commits while this tab's save is in flight (after this
// tab composed its payload) is overwritten on the columns this tab did not
// touch — a one-round-trip window. Closing it needs a server-side merge
// (a migration): document-control REV-39.

import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkedWrite } from "@/lib/checkedWrite";
import { answered, keptAnswer } from "@/lib/checkedWriteAnswer";
import { notLandedReason } from "@/lib/checkedWriteReason";

export const COLUMN_WIDTH_SAVE_DEBOUNCE_MS = 500;

/** The handle's title for a person whose widths are not saved. */
export const COLUMN_WIDTH_VIEW_ONLY_TITLE = "Column width applies to this view only";

export type ColumnWidths = Record<string, number>;

/** What a width save answered: landed, or the reason it did not (worded as
 *  a reason — lib/checkedWriteReason — never "nothing was changed", since the
 *  width on this screen did change). */
export type ColumnWidthSaveAnswer = { ok: true } | { ok: false; reason: string };

/** What the page says when a save did not land. */
export function columnWidthNotSavedMessage(reason: string): string {
  return `The column width was not saved for everyone — it still applies to this view: ${reason}`;
}

/** Save the library's shared widths: a checked write that reads its matched
 *  row back (`.select("id")`), so a refusal — zero rows — is never taken for
 *  a save. Never throws; a write that did not land answers its reason. */
export async function saveLibraryColumnWidths(
  sb: SupabaseClient,
  libraryId: string,
  widths: ColumnWidths,
  uid: string | null,
): Promise<ColumnWidthSaveAnswer> {
  const kept = keptAnswer();
  const saved = await checkedWrite(answered(sb.from("libraries").update({ column_widths: widths, updated_by: uid }).eq("id", libraryId).select("id"), kept));
  return saved.ok ? { ok: true } : { ok: false, reason: notLandedReason(kept, "library column widths") };
}

/** The same widths in any key order give the same key. */
export function columnWidthsKey(widths: ColumnWidths | null | undefined): string {
  const w = widths ?? {};
  return JSON.stringify(Object.keys(w).sort().map((k) => [k, w[k]]));
}

/** A column this tab set: a width, or `null` for "reset to the default". */
export type DirtyColumns = ReadonlyMap<string, number | null>;

/** The stored map with this tab's dirty columns on top; the column under an
 *  active drag (if any) stays as `prev` has it. */
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
  /** May this person save the shared width? Read when a change is made. */
  canSave(): boolean;
  /** The checked write. Answers landed or the reason. */
  write(widths: ColumnWidths): Promise<ColumnWidthSaveAnswer>;
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
  /** The library's stored widths, from the session cache or a fresh load:
   *  this tab's dirty columns still win. */
  load(stored: ColumnWidths): void;
  /** The row's realtime UPDATE: the latest stored map (never dropped); the
   *  echo of this tab's own save clears the dirty columns it carried. */
  remote(next: ColumnWidths): void;
  /** A drag ended on `width`, or a reset (`null`). Answers false — and
   *  changes nothing — when the column already has that value. A person who
   *  may save gets one save ~500 ms after the last change; anyone else's
   *  change is kept for this view only and nothing is written. */
  change(column: string, width: number | null): boolean;
  /** Re-compose the screen (after a press that changed nothing, so the
   *  column it held takes any stored width that arrived meanwhile). */
  settle(): void;
  /** This person may now save (they could not before): drop the columns
   *  last changed while they could not save, so they are never sent as the
   *  shared width, and recompose the screen from the stored map. A column
   *  changed while they could save is kept. */
  dropViewOnly(): void;
  /** Send a waiting save now (tab hidden, page hiding, or dispose). */
  flush(): Promise<void>;
  /** The library or page is being left: a waiting save is sent now. */
  dispose(): void;
}

/** How many sent saves are remembered to recognise their echo. */
const ECHO_MEMORY = 16;

export function createColumnWidthSaver(deps: ColumnWidthSaverDeps): ColumnWidthSaver {
  const wait = deps.debounceMs ?? COLUMN_WIDTH_SAVE_DEBOUNCE_MS;
  let stored: ColumnWidths = {};
  const dirty = new Map<string, number | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let again = false;
  /** Dirty columns last changed while this person could not save. */
  const viewOnly = new Set<string>();
  let closed = false;
  /** Saves this tab sent whose echo has not come back, in send order. */
  const sent: Array<{ key: string; carried: Map<string, number | null>; echoed: boolean }> = [];

  const show = () => {
    const snapshot = new Map(dirty);
    const base = stored;
    deps.apply((prev) => composeColumnWidths(base, snapshot, prev, deps.dragging()));
  };

  async function send(): Promise<void> {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    // A person who may no longer save sends nothing (their change stays on
    // their screen, view-only).
    if (!deps.canSave()) return;
    // One save at a time, so this tab's saves commit in the order sent.
    if (inFlight) { again = true; return; }
    const carried = new Map(dirty);
    const payload = composeColumnWidths(stored, carried, {}, null);
    const key = columnWidthsKey(payload);
    if (key === columnWidthsKey(stored)) {
      // Nothing to change in the stored map: no write (it would only touch
      // updated_by). The carried columns already equal what is stored.
      for (const [col, v] of carried) {
        if (dirty.get(col) === v) dirty.delete(col);
      }
      return;
    }
    inFlight = true;
    const entry = { key, carried, echoed: false };
    sent.push(entry);
    if (sent.length > ECHO_MEMORY) sent.shift();
    let answer: ColumnWidthSaveAnswer;
    try {
      answer = await deps.write(payload);
    } catch (e) {
      answer = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    inFlight = false;
    if (!answer.ok) {
      // Nothing landed, so no echo is coming; the columns stay dirty (the
      // width stays as dragged, and the next save carries it again).
      const i = sent.indexOf(entry);
      if (i >= 0) sent.splice(i, 1);
      deps.notSaved(columnWidthNotSavedMessage(answer.reason), closed);
    } else {
      // Landed: the columns it carried are saved — do not wait for an echo
      // that may never come. Unless its echo already came back (then the
      // stored map is that echo or newer), lay the carried columns over the
      // latest known stored map, whatever arrived during the flight; then
      // clear the dirty entries that still equal what was carried.
      if (!entry.echoed) {
        const next = { ...stored };
        for (const [col, v] of carried) {
          if (v === null) delete next[col];
          else next[col] = v;
        }
        stored = next;
      }
      for (const [col, v] of carried) {
        if (dirty.has(col) && dirty.get(col) === v) dirty.delete(col);
      }
      show();
    }
    if (again) { again = false; await send(); }
  }

  function schedule() {
    if (closed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void send(); }, wait);
  }

  return {
    load(next) {
      stored = { ...next };
      show();
    },
    remote(next) {
      const key = columnWidthsKey(next);
      const i = sent.findIndex((e) => e.key === key);
      if (i >= 0) {
        // This tab's own save (its echo); any earlier entry's echo can no
        // longer come (saves are sent one at a time, so commit in order).
        const [echo] = sent.splice(0, i + 1).slice(-1);
        echo.echoed = true;
        for (const [col, v] of echo.carried) {
          if (dirty.has(col) && dirty.get(col) === v) dirty.delete(col);
        }
      }
      stored = { ...next };
      show();
    },
    change(column, width) {
      const current = dirty.has(column) ? dirty.get(column)! : (stored[column] ?? null);
      if (current === width) { show(); return false; }
      dirty.set(column, width);
      const canSave = deps.canSave();
      if (canSave) viewOnly.delete(column);
      else viewOnly.add(column);
      show();
      if (canSave) schedule();
      return true;
    },
    settle() { show(); },
    dropViewOnly() {
      if (viewOnly.size === 0) return;
      for (const col of viewOnly) dirty.delete(col);
      viewOnly.clear();
      show();
    },
    async flush() {
      if (timer === null) return;
      await send();
    },
    dispose() {
      if (closed) return;
      closed = true;
      if (timer !== null) void send();
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
 *  so the saver exists when the load hands it the stored widths. A waiting
 *  save is sent when the library changes or the page unmounts, and — best
 *  effort, the browser may not finish the request — when the tab is hidden
 *  or the page is being unloaded (pagehide). No leave-page prompt. */
export function useLibraryColumnWidths(opts: UseLibraryColumnWidthsOptions): MutableRefObject<ColumnWidthSaver | null> {
  const saverRef = useRef<ColumnWidthSaver | null>(null);
  const live = useRef(opts);
  // What the saver reads when it acts — who may save, the uid, the client —
  // kept current on every render (REV-38 F6 review item 7, pinned).
  const couldSave = useRef(opts.canSave);
  useEffect(() => {
    live.current = opts;
    // REV-38 (F6 second review, item 4): view-only columns are never sent —
    // dropped once, when this person becomes one who may save.
    if (!couldSave.current && opts.canSave) saverRef.current?.dropViewOnly();
    couldSave.current = opts.canSave;
  });
  const { libraryId } = opts;
  useEffect(() => {
    if (!libraryId) return;
    const saver = createColumnWidthSaver({
      canSave: () => live.current.canSave,
      write: (widths) => saveLibraryColumnWidths(live.current.client, libraryId, widths, live.current.uid),
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
