// lib/libraryColumnWidths.ts — a library's shared column widths: who saves
// them, when, and what the live-sync takes (document-control REV-38, DEC-90).
//
// The widths live where they always have: `libraries.column_widths`, read
// when the library loads and live-synced from the row's realtime UPDATE. The
// library page never wrote them (the two saves that stood there were never
// sent — projects-tab SAF-22, ruling R1). Now:
//   * a CONTROLLER (Admin / DocCtrl by the role collection — the page's
//     controller tier, `isControllerPrincipal`, which mirrors the database's
//     `is_org_controller`) saves the shared width, debounced: one save
//     ~500 ms after the drag ends or the reset double-click, carrying the
//     widths as they are when it fires, through a checked write. A save
//     that does not land is said in plain words, and the width stays as
//     dragged on this screen;
//   * anyone else still resizes, for this view only — nothing is written,
//     and the handle says so (COLUMN_WIDTH_VIEW_ONLY_TITLE);
//   * the live-sync never fights the person: nothing is taken while they
//     drag, while their own save waits or is in flight, and the echo of
//     their own save (the row's UPDATE carrying the widths they sent) is
//     not taken back as a jump.
//
// The controller below is framework-free so it can be tested with fake
// timers; the page holds one per library and disposes it when the library
// changes or the page closes (a waiting save is sent then, not dropped).

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

export interface ColumnWidthSaverDeps {
  /** May this person save the shared width? Read when a save is asked for. */
  canSave(): boolean;
  /** The widths on the screen now — read when the save fires. */
  current(): ColumnWidths;
  /** The checked write. Never throws; answers landed or the reason. */
  write(widths: ColumnWidths): Promise<ColumnWidthSaveAnswer>;
  /** Say a save that did not land. `afterClose`: the page or library it was
   *  made on has since been left (the save was sent as it closed). */
  notSaved(message: string, afterClose: boolean): void;
  debounceMs?: number;
}

export interface ColumnWidthSaver {
  /** A drag ended or a reset was double-clicked: save the widths in
   *  ~500 ms (a later ask restarts the wait). Answers false — and asks
   *  nothing of the database — for a person who may not save. */
  schedule(): boolean;
  /** Send a waiting save now (what dispose does). */
  flush(): Promise<void>;
  /** Should the live-sync take these widths from the row's UPDATE? */
  acceptRemote(next: ColumnWidths, resizing: boolean): boolean;
  /** The library or page is being left: a waiting save is sent now. */
  dispose(): void;
}

/** How many sent widths are remembered to recognise their echo. */
const ECHO_MEMORY = 16;

export function createColumnWidthSaver(deps: ColumnWidthSaverDeps): ColumnWidthSaver {
  const wait = deps.debounceMs ?? COLUMN_WIDTH_SAVE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;
  let closed = false;
  /** Widths this person sent whose echo has not come back yet. */
  const sent: string[] = [];

  const forgetSent = (key: string) => {
    const i = sent.indexOf(key);
    if (i >= 0) sent.splice(i, 1);
  };

  async function send(): Promise<void> {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const widths = { ...deps.current() };
    const key = columnWidthsKey(widths);
    sent.push(key);
    if (sent.length > ECHO_MEMORY) sent.shift();
    inFlight += 1;
    let answer: ColumnWidthSaveAnswer;
    try {
      answer = await deps.write(widths);
    } catch (e) {
      answer = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    } finally {
      inFlight -= 1;
    }
    if (!answer.ok) {
      // Nothing landed, so no echo is coming.
      forgetSent(key);
      deps.notSaved(columnWidthNotSavedMessage(answer.reason), closed);
    }
  }

  return {
    schedule() {
      if (closed || !deps.canSave()) return false;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void send(); }, wait);
      return true;
    },
    async flush() {
      if (timer === null) return;
      await send();
    },
    acceptRemote(next, resizing) {
      if (resizing) return false;
      const key = columnWidthsKey(next);
      if (sent.includes(key)) { forgetSent(key); return false; }
      if (timer !== null || inFlight > 0) return false;
      return true;
    },
    dispose() {
      if (closed) return;
      closed = true;
      if (timer !== null) void send();
    },
  };
}
