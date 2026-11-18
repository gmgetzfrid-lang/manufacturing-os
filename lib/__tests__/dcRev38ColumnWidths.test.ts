// document-control REV-38 / REV-39 (DEC-90) — a library's shared column widths.
//
// A controller's change (a drag that changed a width, a reset of a column
// that differed from its default) is saved ~500 ms later; a save that does
// not land is said in plain words while the width stays as dragged; anyone
// else resizes for this view only and nothing is written. The ORDERED stored
// map (the integrator's ruling at the F6 stress review): every map carries
// the row's server-owned version (20261271) — the load, the realtime row,
// the save's answer — and only an equal-or-newer one replaces the map held;
// after every change of it, each dirty column it shows is cleared; a save
// sends only this tab's changed / reset columns (merged per column on the
// server). Before the paste no version exists: the save re-reads the row and
// writes the whole map, and a late map is the recorded pre-paste residual.
// Every sequence of the stress review's probe is pinned here in both modes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  COLUMN_WIDTH_SAVE_DEBOUNCE_MS,
  COLUMN_WIDTH_VIEW_ONLY_TITLE,
  RESIZE_DRAG_THRESHOLD_PX,
  applyColumnWidthChanges,
  columnWidthNotSavedMessage,
  columnWidthsKey,
  composeColumnWidths,
  createColumnWidthSaver,
  createResizeHandleGesture,
  readLibraryColumnWidths,
  revOf,
  saveLibraryColumnWidths,
  widthsOf,
  type ColumnWidthChanges,
  type ColumnWidthSaveAnswer,
  type ColumnWidths,
} from "@/lib/libraryColumnWidths";
import { NOT_MATCHED_REASON } from "@/lib/checkedWriteReason";

const WAIT = COLUMN_WIDTH_SAVE_DEBOUNCE_MS;

/** A saver whose saves the test answers; `server` plays the database (a
 *  per-column merge with a version, or — `versioned: false` — the whole-map
 *  write before 20261271, answering the committed row with no version). */
function rig(opts: { canSave?: boolean; versioned?: boolean } = {}) {
  let canSave = opts.canSave ?? true;
  const versioned = opts.versioned ?? true;
  let screen: ColumnWidths = {};
  let dragging: string | null = null;
  const server = { widths: {} as ColumnWidths, rev: 0 };
  const sent: ColumnWidthChanges[] = [];
  const held: Array<(a?: ColumnWidthSaveAnswer | "commit" | "lost") => void> = [];
  const notSaved = vi.fn();
  const commit = (c: ColumnWidthChanges) => {
    server.widths = applyColumnWidthChanges(server.widths, c);
    server.rev += 1;
    return { widths: { ...server.widths }, rev: versioned ? server.rev : null };
  };
  const saver = createColumnWidthSaver({
    canSave: () => canSave,
    save: (c) => {
      sent.push(c);
      return new Promise<ColumnWidthSaveAnswer>((resolve) => {
        held.push((a = "commit") => {
          if (a === "commit") { const m = commit(c); resolve({ ok: true, widths: m.widths, rev: m.rev }); }
          else if (a === "lost") { commit(c); resolve({ ok: false, reason: "network" }); }
          else resolve(a);
        });
      });
    },
    notSaved,
    apply: (u) => { screen = u(screen); },
    dragging: () => dragging,
  });
  const v = (rev: number) => (versioned ? rev : null);
  return {
    saver, sent, notSaved, server, v,
    get screen() { return screen; },
    setCan(x: boolean) { canSave = x; },
    /** Answer the oldest save in flight. */
    answer(a?: ColumnWidthSaveAnswer | "commit" | "lost") { const r = held.shift(); if (!r) throw new Error("no save in flight"); r(a); },
    get inFlight() { return held.length; },
    /** Another tab's save: merged on the server; its map as the realtime row carries it. */
    other(c: ColumnWidthChanges) { const m = commit(c); return m; },
    drag(col: string, w: number) { dragging = col; screen = { ...screen, [col]: w }; },
    release() { dragging = null; },
  };
}
const tick = () => vi.advanceTimersByTimeAsync(0);
const set = (s: ColumnWidths, reset: string[] = []): ColumnWidthChanges => ({ set: s, reset });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("REV-38 — a controller's change is saved, debounced, as only the columns changed", () => {
  it("one save ~500 ms after the last change, carrying only this tab's changed columns", async () => {
    const r = rig();
    r.saver.load({ title: 150, keep: 60 }, 0);
    expect(r.saver.change("title", 220)).toBe(true);
    expect(r.screen).toEqual({ title: 220, keep: 60 });
    await vi.advanceTimersByTimeAsync(WAIT - 1);
    r.saver.change("rev", 80); // a second change inside the wait restarts it
    await vi.advanceTimersByTimeAsync(WAIT - 1);
    expect(r.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.sent).toEqual([set({ title: 220, rev: 80 })]);
    expect(WAIT).toBe(500);
    r.answer();
    await tick();
    expect(r.notSaved).not.toHaveBeenCalled();
  });

  it("a reset is sent as a reset: the column leaves the map", async () => {
    const r = rig();
    r.saver.load({ title: 300, keep: 90 }, 0);
    r.server.widths = { title: 300, keep: 90 };
    expect(r.saver.change("title", null)).toBe(true);
    expect(r.screen).toEqual({ keep: 90 });
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent).toEqual([set({}, ["title"])]);
    r.answer();
    await tick();
    expect(r.screen).toEqual({ keep: 90 });
  });

  it("no change, no save: the column's own width, a reset of a column with none, or a change back before the wait ends (P7)", async () => {
    const r = rig();
    r.saver.load({ title: 150 }, 0);
    expect(r.saver.change("title", 150)).toBe(false);
    expect(r.saver.change("rev", null)).toBe(false);
    r.saver.change("title", 190);
    r.saver.change("title", 150);
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    await r.saver.flush();
    r.saver.dispose();
    await tick();
    expect(r.sent).toEqual([]);
  });

  it("a refused save is said in plain words — never 'nothing was changed' — the width stays as dragged and the next save carries it again", async () => {
    const r = rig();
    r.saver.load({ title: 150, keep: 60 }, 0);
    r.saver.change("title", 260);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.answer({ ok: false, reason: NOT_MATCHED_REASON });
    await tick();
    expect(r.notSaved).toHaveBeenCalledTimes(1);
    const [message, afterClose] = r.notSaved.mock.calls[0];
    expect(message).toBe(columnWidthNotSavedMessage(NOT_MATCHED_REASON));
    expect(message).toMatch(/not saved for everyone — it still applies to this view/);
    expect(message).not.toMatch(/nothing was changed/i);
    expect(afterClose).toBe(false);
    expect(r.screen).toEqual({ title: 260, keep: 60 });
    r.saver.remote({ title: 150, keep: 75 }, 1); // another column moves; title stays as dragged
    expect(r.screen).toEqual({ title: 260, keep: 75 });
    r.saver.change("rev", 99);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[1]).toEqual(set({ title: 260, rev: 99 }));
  });

  it("a save that throws is said too, never swallowed", async () => {
    const notSaved = vi.fn();
    const saver = createColumnWidthSaver({ canSave: () => true, save: async () => { throw new Error("boom"); }, notSaved, apply: () => {}, dragging: () => null });
    saver.change("title", 200);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(notSaved).toHaveBeenCalledWith(columnWidthNotSavedMessage("boom"), false);
  });

  it("this tab's saves go one at a time: a change made while one is in flight is sent when it answers", async () => {
    const r = rig();
    r.saver.change("a", 110);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.saver.change("b", 120);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent.length).toBe(1);
    r.answer();
    await tick();
    expect(r.sent).toEqual([set({ a: 110 }), set({ b: 120 })]);
    r.answer();
    await tick();
    expect(r.screen).toEqual({ a: 110, b: 120 });
  });

  it("a column changed again while its save is in flight is saved again; one changed BACK to the stored width while in flight too (sequence 22)", async () => {
    const r = rig();
    r.saver.load({ a: 100, b: 100 }, 0);
    r.server.widths = { a: 100, b: 100 };
    r.saver.change("a", 150);
    r.saver.change("b", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.saver.change("a", 170);  // again
    r.saver.change("b", 100);  // back to what is stored — but the save in flight writes 150
    r.answer();
    await tick();
    expect(r.screen).toEqual({ a: 170, b: 100 });
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[1]).toEqual(set({ a: 170, b: 100 }));
    r.answer();
    await tick();
    expect(r.server.widths).toEqual({ a: 170, b: 100 });
  });

  it("settle re-composes after a press that changed nothing (the held column takes what arrived meanwhile)", () => {
    const r = rig();
    r.saver.load({ a: 100 }, 0);
    r.drag("a", 100);
    r.saver.remote({ a: 140 }, 1);
    expect(r.screen).toEqual({ a: 100 });
    r.release();
    r.saver.settle();
    expect(r.screen).toEqual({ a: 140 });
  });
});

describe("REV-38 — the ordered stored map (20261271): an older map never replaces a newer one", () => {
  it("P2: a fresh load read before this tab's own save, delivered after its answer, is ignored — no roll-back, and the next save does not re-send the old value", async () => {
    const r = rig();
    r.saver.load({ a: 100 }, null); // the session cache
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.answer(); // committed rev 1
    await tick();
    expect(r.saver.load({ a: 100 }, 0)).toBe(false);   // the late fresh load (rev 0)
    expect(r.saver.load({ a: 100 }, null)).toBe(false); // or an unversioned one
    expect(r.screen).toEqual({ a: 150 });
    r.saver.change("b", 90);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[1]).toEqual(set({ b: 90 }));
  });

  it("P2b: a load older than a realtime map already received is ignored", () => {
    const r = rig();
    r.saver.load({ a: 100 }, null);
    r.saver.remote({ a: 200 }, 3);
    expect(r.saver.load({ a: 100 }, 2)).toBe(false);
    expect(r.screen).toEqual({ a: 200 });
    expect(r.saver.load({ a: 210 }, 3)).toBe(true); // an equal version is taken
    expect(r.screen).toEqual({ a: 210 });
  });

  it("P1: this tab's echo missed and another controller's LATER save of the same column arrives during the flight: the screen shows theirs, and this tab never re-sends its older value", async () => {
    const r = rig();
    r.saver.load({ a: 100 }, 0);
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.answer(); // committed rev 1 (a 150); its echo never arrives
    const theirs = r.other(set({ a: 300 })); // rev 2, after ours
    r.saver.remote(theirs.widths, theirs.rev);
    await tick();
    expect(r.screen).toEqual({ a: 300 });
    r.saver.change("b", 90);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[1]).toEqual(set({ b: 90 }));
  });

  it("…and when their later map arrives BEFORE this tab's answer: the answer (older) is ignored, the column is no longer dirty", async () => {
    const r = rig();
    r.saver.load({ a: 100 }, 0);
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    // our save commits (rev 1), then theirs (rev 2) — theirs is delivered first
    r.saver.remote({ a: 300 }, 2);
    r.answer({ ok: true, widths: { a: 150 }, rev: 1 });
    await tick();
    expect(r.screen).toEqual({ a: 300 });
    r.saver.change("c", 70);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[1]).toEqual(set({ c: 70 }));
  });

  it("P4: a failure answer for a save that landed — its echo clears the column by the equality rule; another controller's later save is then taken and never overwritten", async () => {
    const r = rig();
    r.saver.load({ a: 100 }, 0);
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.saver.remote({ a: 150 }, 1); // the echo (it landed)
    r.answer("lost");
    await tick();
    expect(r.notSaved).toHaveBeenCalledTimes(1);
    r.saver.remote({ a: 300 }, 2);
    expect(r.screen).toEqual({ a: 300 });
    r.saver.change("b", 90);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[1]).toEqual(set({ b: 90 }));
  });

  it("P4b: the failure answer first, then the echo, then another controller's save", async () => {
    const r = rig();
    r.saver.load({ a: 100 }, 0);
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.answer("lost");
    await tick();
    r.saver.remote({ a: 150 }, 1);
    r.saver.remote({ a: 300 }, 2);
    expect(r.screen).toEqual({ a: 300 });
    r.saver.change("b", 90);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[1]).toEqual(set({ b: 90 }));
  });

  it("P5: repeated values across saves with missed echoes; a late echo of an earlier save and another controller's later save — the newest map wins", async () => {
    const r = rig();
    r.saver.load({ a: 100 }, 0);
    for (const w of [150, 200, 150]) {
      r.saver.change("a", w);
      await vi.advanceTimersByTimeAsync(WAIT);
      r.answer();
      await tick();
    }
    expect(r.screen).toEqual({ a: 150 });
    r.saver.remote({ a: 150 }, 1); // a late echo of the FIRST save
    expect(r.screen).toEqual({ a: 150 });
    r.saver.remote({ a: 300 }, 4); // another controller after the third
    expect(r.screen).toEqual({ a: 300 });
    r.saver.remote({ a: 200 }, 2); // the second save's late echo: older, ignored
    expect(r.screen).toEqual({ a: 300 });
  });

  it("P6: two quick saves; the first one's echo during the second's flight; the second's echo missed — no jump, and the next save sends only the new column", async () => {
    const r = rig();
    r.saver.load({ a: 100, b: 100 }, 0);
    r.server.widths = { a: 100, b: 100 };
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.saver.change("b", 200);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.answer(); // a committed rev 1; b sent
    await tick();
    expect(r.sent[1]).toEqual(set({ b: 200 }));
    r.saver.remote({ a: 150, b: 100 }, 1); // the first echo, during b's flight
    expect(r.screen).toEqual({ a: 150, b: 200 });
    r.answer(); // b committed rev 2; its echo missed
    await tick();
    expect(r.screen).toEqual({ a: 150, b: 200 });
    r.saver.change("c", 60);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[2]).toEqual(set({ c: 60 }));
  });

  it("a stored map during the WAIT moves the other columns at once; the save sends only this tab's column", async () => {
    const r = rig();
    r.saver.load({ a: 100, b: 100 }, 0);
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT / 2);
    r.saver.remote({ a: 100, b: 300 }, 1);
    expect(r.screen).toEqual({ a: 150, b: 300 });
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent).toEqual([set({ a: 150 })]);
  });

  it("a stored map DURING a drag never moves the dragged column; the others move at once", async () => {
    const r = rig();
    r.saver.load({ a: 100, b: 100 }, 0);
    r.drag("a", 180);
    r.saver.remote({ a: 120, b: 300 }, 1);
    expect(r.screen).toEqual({ a: 180, b: 300 });
    r.drag("a", 200);
    r.release();
    expect(r.saver.change("a", 200)).toBe(true);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent).toEqual([set({ a: 200 })]);
  });

  it("the equality rule: a map showing this tab's value clears the column; a later map changing it is taken", () => {
    const r = rig({ canSave: false });
    r.saver.load({ a: 100 }, 0);
    r.saver.change("a", 150);
    r.saver.remote({ a: 140 }, 1);
    expect(r.screen).toEqual({ a: 150 }); // still this view's
    r.saver.remote({ a: 150 }, 2);
    r.saver.remote({ a: 160 }, 3);
    expect(r.screen).toEqual({ a: 160 });
  });

  it("a fresh load after the cached view never wipes a resize made from the cached view, and the save carries only that column", async () => {
    const r = rig();
    r.saver.load({ a: 100 }, null); // the session cache
    r.saver.change("a", 150);
    r.saver.load({ a: 120, b: 90 }, 5); // the fresh row
    expect(r.screen).toEqual({ a: 150, b: 90 });
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent).toEqual([set({ a: 150 })]);
  });
});

describe("REV-38 — the probe's sequences BEFORE 20261271 (no version): the save re-reads and writes the whole map; late maps are the recorded residual", () => {
  it("P1 / P6 / P5 / P4 hold without a version: the committed row the save reads back is taken, and the next save sends only the new column", async () => {
    const r = rig({ versioned: false });
    r.saver.load({ a: 100, b: 100 }, null);
    r.server.widths = { a: 100, b: 100 };
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.saver.change("b", 200);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.answer();
    await tick();
    r.answer();
    await tick();
    expect(r.screen).toEqual({ a: 150, b: 200 });
    r.saver.change("c", 60);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[2]).toEqual(set({ c: 60 }));
    r.answer("lost"); // P4 before the paste: landed, answer lost
    await tick();
    r.saver.remote({ a: 150, b: 200, c: 60 }, null); // its echo clears c by equality
    r.saver.remote({ a: 150, b: 200, c: 300 }, null); // another controller
    expect(r.screen).toEqual({ a: 150, b: 200, c: 300 });
    r.saver.change("d", 70);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[3]).toEqual(set({ d: 70 }));
  });

  it("the residual, as recorded: with no version a late map (P2's fresh load read before this tab's save) replaces the newer one until the next map arrives — and never makes a later save re-send the old value", async () => {
    const r = rig({ versioned: false });
    r.saver.load({ a: 100 }, null);
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.answer();
    await tick();
    expect(r.saver.load({ a: 100 }, null)).toBe(true); // taken: order unknown
    expect(r.screen).toEqual({ a: 100 });
    r.saver.change("b", 90);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[1]).toEqual(set({ b: 90 })); // the server re-read keeps a 150
    r.answer();
    await tick();
    expect(r.server.widths).toEqual({ a: 150, b: 90 });
    expect(r.screen).toEqual({ a: 150, b: 90 }); // the committed row brings it back
  });

  it("once a version is known, an unversioned map is never taken (the paste landing while the page is open)", () => {
    const r = rig();
    r.saver.load({ a: 100 }, null);
    r.saver.remote({ a: 120 }, 4);
    expect(r.saver.remote({ a: 100 }, null)).toBe(false);
    expect(r.screen).toEqual({ a: 120 });
  });
});

describe("REV-38 — a person who may not save resizes for this view only; promotion and demotion", () => {
  it("no save is attempted, after a drag or a reset, however long they wait, on flush or when they leave", async () => {
    const r = rig({ canSave: false });
    r.saver.load({ title: 150, rev: 60 }, 0);
    expect(r.saver.change("title", 400)).toBe(true);
    expect(r.saver.change("rev", null)).toBe(true);
    await vi.advanceTimersByTimeAsync(WAIT * 4);
    await r.saver.flush();
    r.saver.dispose();
    await tick();
    expect(r.sent).toEqual([]);
    expect(r.notSaved).not.toHaveBeenCalled();
    expect(r.screen).toEqual({ title: 400 });
  });

  it("…sees a controller's save of the other columns, and keeps their own on the columns they set", () => {
    const r = rig({ canSave: false });
    r.saver.load({ title: 150, rev: 60 }, 0);
    r.saver.change("title", 400);
    r.saver.remote({ title: 500, rev: 70, status: 90 }, 1);
    expect(r.screen).toEqual({ title: 400, rev: 70, status: 90 });
  });

  it("on promotion the columns set view-only are dropped (never sent) and the screen recomposed", async () => {
    const r = rig({ canSave: false });
    r.saver.load({ a: 100, b: 100 }, 0);
    r.saver.change("a", 400);
    r.setCan(true);
    r.saver.promoted();
    expect(r.screen).toEqual({ a: 100, b: 100 });
    r.saver.change("b", 90);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent).toEqual([set({ b: 90 })]);
  });

  it("a column set view-only is never sent, even by a save made before the promotion is handled", async () => {
    const r = rig({ canSave: false });
    r.saver.load({ a: 100, b: 100 }, 0);
    r.saver.change("b", 90);   // view-only
    r.setCan(true);            // may save now; promoted() not yet called
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent).toEqual([set({ a: 150 })]);
  });

  it("P3: demoted across the wait, then re-promoted — the change made as a controller is saved (the promotion schedules it); a view-only change is dropped", async () => {
    const r = rig();
    r.saver.load({ a: 100, b: 100 }, 0);
    r.saver.change("a", 150);       // as a controller
    r.setCan(false);
    await vi.advanceTimersByTimeAsync(WAIT); // the wait ends while demoted: nothing sent
    expect(r.sent).toEqual([]);
    r.saver.change("b", 90);         // view-only
    r.setCan(true);
    r.saver.promoted();
    expect(r.screen).toEqual({ a: 150, b: 100 });
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent).toEqual([set({ a: 150 })]);
  });

  it("P3b: demoted during a flight with another save waiting, then re-promoted — the waiting column is saved", async () => {
    const r = rig();
    r.saver.load({ a: 100 }, 0);
    r.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    r.saver.change("b", 90);
    await vi.advanceTimersByTimeAsync(WAIT); // waits behind a
    r.setCan(false);
    r.answer();
    await tick();
    expect(r.sent.length).toBe(1);   // b not sent while demoted
    r.setCan(true);
    r.saver.promoted();
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(r.sent[1]).toEqual(set({ b: 90 }));
  });

  it("flush and dispose send whenever there are unsaved columns, timer or not; dispose's refusal is said after close; nothing is scheduled after", async () => {
    const r = rig();
    r.saver.load({ a: 100 }, 0);
    r.saver.change("a", 150);
    r.setCan(false);
    await vi.advanceTimersByTimeAsync(WAIT); // no timer left, column still unsaved
    r.setCan(true);
    void r.saver.flush();
    await tick();
    expect(r.sent).toEqual([set({ a: 150 })]);
    r.answer({ ok: false, reason: "R" });
    await tick();
    r.saver.dispose(); // still unsaved: sent at once
    await tick();
    expect(r.sent.length).toBe(2);
    r.answer({ ok: false, reason: "R" });
    await tick();
    expect(r.notSaved).toHaveBeenLastCalledWith(columnWidthNotSavedMessage("R"), true);
    r.saver.change("b", 80);
    await vi.advanceTimersByTimeAsync(WAIT * 2);
    expect(r.sent.length).toBe(2);
  });

  it("regression: leaving with nothing unsaved writes nothing", async () => {
    const r = rig();
    r.saver.dispose();
    await vi.advanceTimersByTimeAsync(WAIT * 2);
    expect(r.sent).toEqual([]);
  });
});

describe("REV-38 — saveLibraryColumnWidths and readLibraryColumnWidths", () => {
  function client(o: { rpc?: { data: unknown; error: unknown }; read?: { data: unknown; error: unknown }; write?: { data: unknown; error: unknown } }) {
    const calls: Array<[string, ...unknown[]]> = [];
    const sb = {
      rpc(fn: string, args: unknown) { calls.push(["rpc", fn, args]); return Promise.resolve(o.rpc ?? { data: null, error: null }); },
      from(t: string) {
        let mode = "select";
        const b = {
          select(c: string) { calls.push([`${mode}.select`, t, c]); if (mode === "update") return Promise.resolve(o.write ?? { data: null, error: null }); return b; },
          update(p: unknown) { mode = "update"; calls.push(["update", t, p]); return b; },
          eq(c: string, v: unknown) { calls.push(["eq", c, v]); return b; },
          maybeSingle() { return Promise.resolve(o.read ?? { data: null, error: null }); },
        };
        return b;
      },
    } as unknown as SupabaseClient;
    return { sb, calls };
  }
  const changes = set({ title: 210 }, ["old"]);

  it("after 20261271: one RPC with only the changes; the committed map and version answered", async () => {
    const { sb, calls } = client({ rpc: { data: [{ column_widths: { title: 210, keep: 90 }, column_widths_rev: "7" }], error: null } });
    expect(await saveLibraryColumnWidths(sb, "lib-1", changes, "u-1")).toEqual({ ok: true, widths: { title: 210, keep: 90 }, rev: 7 });
    expect(calls).toEqual([["rpc", "save_library_column_widths", { p_library: "lib-1", p_set: { title: 210 }, p_reset: ["old"] }]]);
  });

  it("the function's refusal is a reason in plain words, and nothing falls back to a direct write", async () => {
    const { sb, calls } = client({ rpc: { data: null, error: { message: "Only an Admin or a Document Controller of this workspace can save the column widths of this library.", code: "42501", details: "", hint: "" } } });
    const a = await saveLibraryColumnWidths(sb, "lib-1", changes, "u-1");
    expect(a.ok).toBe(false);
    expect((a as { reason: string }).reason).not.toMatch(/nothing was changed/i);
    expect(calls.length).toBe(1);
  });

  it("before 20261271 (PGRST202 / 42883): re-reads the row and writes that map with the changes on top, reading the committed row back (no version)", async () => {
    for (const code of ["PGRST202", "42883"]) {
      const { sb, calls } = client({
        rpc: { data: null, error: { message: "Could not find the function", code, details: "", hint: "" } },
        read: { data: { column_widths: { title: 150, keep: 90, old: 70 } }, error: null },
        write: { data: [{ id: "lib-1", column_widths: { title: 210, keep: 90 } }], error: null },
      });
      expect(await saveLibraryColumnWidths(sb, "lib-1", changes, "u-1"), code).toEqual({ ok: true, widths: { title: 210, keep: 90 }, rev: null });
      expect(calls.slice(1)).toEqual([
        ["select.select", "libraries", "column_widths"], ["eq", "id", "lib-1"],
        ["update", "libraries", { column_widths: { title: 210, keep: 90 }, updated_by: "u-1" }], ["eq", "id", "lib-1"], ["update.select", "libraries", "id, column_widths"],
      ]);
    }
  });

  it("before 20261271: a refused whole-map write (zero rows) or a failed re-read is a reason, never a save", async () => {
    const missing = { data: null, error: { message: "Could not find the function", code: "PGRST202", details: "", hint: "" } };
    const refused = client({ rpc: missing, read: { data: { column_widths: {} }, error: null }, write: { data: [], error: null } });
    expect(await saveLibraryColumnWidths(refused.sb, "lib-1", changes, "u-1")).toEqual({ ok: false, reason: NOT_MATCHED_REASON });
    const unread = client({ rpc: missing, read: { data: null, error: { message: "permission denied for table libraries", code: "42501" } } });
    const a = await saveLibraryColumnWidths(unread.sb, "lib-1", changes, "u-1");
    expect(a.ok).toBe(false);
    expect(unread.calls.some((c) => c[0] === "update")).toBe(false);
  });

  it("readLibraryColumnWidths: the map with its version; null before 20261271 (the column missing) or with no version", async () => {
    expect(await readLibraryColumnWidths(client({ read: { data: { column_widths: { a: 100, bad: "x" }, column_widths_rev: 3 }, error: null } }).sb, "lib-1")).toEqual({ widths: { a: 100 }, rev: 3 });
    expect(await readLibraryColumnWidths(client({ read: { data: null, error: { message: "column libraries.column_widths_rev does not exist", code: "42703" } } }).sb, "lib-1")).toBeNull();
    expect(await readLibraryColumnWidths(client({ read: { data: { column_widths: {} }, error: null } }).sb, "lib-1")).toBeNull();
  });

  it("revOf / widthsOf / applyColumnWidthChanges / composeColumnWidths / columnWidthsKey; the drag bounds match the database's", () => {
    expect(revOf(3)).toBe(3); expect(revOf("12")).toBe(12); expect(revOf(undefined)).toBeNull(); expect(revOf("x")).toBeNull();
    expect(widthsOf({ a: 1, b: "2", c: null })).toEqual({ a: 1 }); expect(widthsOf([1])).toEqual({}); expect(widthsOf(null)).toEqual({});
    expect(applyColumnWidthChanges({ a: 1, b: 2 }, set({ c: 3 }, ["a"]))).toEqual({ b: 2, c: 3 });
    expect(composeColumnWidths({ a: 1, b: 2 }, new Map([["a", 5], ["b", null]]), {}, null)).toEqual({ a: 5 });
    expect(composeColumnWidths({ a: 1 }, new Map(), { a: 9 }, "a")).toEqual({ a: 9 });
    expect(columnWidthsKey({ a: 1, b: 2 })).toBe(columnWidthsKey({ b: 2, a: 1 }));
    expect([COLUMN_WIDTH_MIN, COLUMN_WIDTH_MAX]).toEqual([50, 5000]);
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261271_dc_rev38_column_widths_merge.sql"), "utf8");
    expect(sql).toContain(`IF v_num < ${COLUMN_WIDTH_MIN} OR v_num > ${COLUMN_WIDTH_MAX} THEN`);
  });
});

describe("REV-38 — the handle: a press is a drag or not; a drag never sorts", () => {
  it("a press that does not move past the threshold is not a drag, and the header click after it is not swallowed (anyone else's click sorts at once)", () => {
    const g = createResizeHandleGesture();
    g.down(100);
    expect(g.move(100 + RESIZE_DRAG_THRESHOLD_PX - 1)).toBe(false);
    expect(g.up()).toBe(false);
    expect(g.headerClick()).toBe(false);
  });

  it("a drag that ends in the header has that click swallowed, once", () => {
    const g = createResizeHandleGesture();
    g.down(100);
    expect(g.move(100 + RESIZE_DRAG_THRESHOLD_PX)).toBe(true);
    expect(g.up()).toBe(true);
    expect(g.headerClick()).toBe(true);
    expect(g.headerClick()).toBe(false);
  });

  it("a drag that ends outside the header (no click follows) does not swallow the next real header click", async () => {
    const g = createResizeHandleGesture();
    g.down(100); g.move(200); g.up();
    await vi.advanceTimersByTimeAsync(1);
    expect(g.headerClick()).toBe(false);
  });

  it("no sort timer anywhere: the gesture neither sorts nor schedules a sort, and the page has no delayed sort", () => {
    const lib = readFileSync(join(process.cwd(), "lib/libraryColumnWidths.ts"), "utf8");
    const gesture = lib.slice(lib.indexOf("export function createResizeHandleGesture"));
    expect(gesture).not.toMatch(/sort/i);
    expect(lib).not.toMatch(/HANDLE_CLICK_SORT_DELAY_MS|handleClick/);
    const page = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
    expect(page).not.toMatch(/resizeGesture\.handleClick/);
  });
});

describe("REV-38 — the library page wiring", () => {
  const page = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
  const between = (from: string, to: string) => {
    const i = page.indexOf(from);
    expect(i, from).toBeGreaterThan(-1);
    const j = page.indexOf(to, i + from.length);
    expect(j, to).toBeGreaterThan(i);
    return page.slice(i, j);
  };

  it("the drag's end is a change only when the press moved and the width changed; otherwise it settles", () => {
    const onUp = between("const onUp = () => {", "document.addEventListener(\"pointermove\"");
    expect(onUp).toMatch(/resizingRef\.current = null;[\s\S]*const moved = resizeGesture\.up\(\);/);
    expect(onUp).toMatch(/if \(moved && lastWidth !== current\.startWidth\) saver\.change\(current\.key, lastWidth\);\s*else saver\.settle\(\);/);
    const onMove = between("const onMove = (ev: PointerEvent) => {", "const onUp = () => {");
    expect(onMove).toMatch(/if \(!resizeGesture\.move\(ev\.clientX\)\) return;/);
    // a drag is clamped to the bounds the database holds a saved width to
    expect(onMove).toContain("Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, Math.round(current.startWidth + ev.clientX - current.startX)))");
  });

  it("the reset is a change only when the column differed from its default", () => {
    const reset = between("const handleResizeReset = useCallback(", "}, [colWidths, getDefaultColWidth, widthSaverRef]);");
    expect(reset).toMatch(/if \(w === undefined \|\| w === getDefaultColWidth\(colKey\)\) return;/);
    expect(reset).toContain("widthSaverRef.current.change(colKey, null);");
  });

  it("the saver is the hook, gated on the controller tier, declared before the library load; the load and the live-sync go through it", () => {
    expect(page).toContain("const canSaveColumnWidths = activeRole !== null && isControllerPrincipal({ role: activeRole, roles });");
    const hookAt = page.indexOf("const widthSaverRef = useLibraryColumnWidths({");
    const loadAt = page.indexOf("const cacheKey = `mfg-os:lib:${libraryId}:${activeOrgId}`;");
    expect(hookAt).toBeGreaterThan(-1);
    expect(hookAt).toBeLessThan(loadAt);
    expect(between("const widthSaverRef = useLibraryColumnWidths({", "});")).toMatch(/canSave: canSaveColumnWidths,[\s\S]*dragging: \(\) => resizingRef\.current\?\.key \?\? null,/);
    expect(page).toMatch(/notSaved: \(message, afterClose\) => \{[\s\S]{0,120}appAlert\([\s\S]{0,80}setError\(message\)/);
    expect(page).toContain("if (widthSaverRef.current) widthSaverRef.current.load(widthsOf(parsed.colWidths), null);");
    expect(page).toContain("if (widthSaverRef.current) widthSaverRef.current.load(widthsOf(widths), revOf((data as { column_widths_rev?: unknown }).column_widths_rev));");
    expect(page).toMatch(/void readLibraryColumnWidths\(supabase, libraryId\)\.then\(\(v\) => \{\s*if \(alive && v\) widthSaverRef\.current\?\.load\(v\.widths, v\.rev\);/);
    const sync = between("// Live-sync column_widths", "return () => { supabase.removeChannel(channel); };");
    expect(sync).toContain("if (widthSaverRef.current) widthSaverRef.current.remote(widthsOf(next), revOf(row?.column_widths_rev));");
    expect(sync).toContain("else if (!resizingRef.current) setColWidths(next);");
  });

  it("the handle is offered to everyone and says 'applies to this view only' to a person whose width is not saved; each group's click is as on the base; a drag's header click is swallowed", () => {
    const handle = between("{/* Right-edge resize handle", "</th>");
    expect(handle).not.toMatch(/\{isController && \(/);
    expect(handle).toContain("onPointerDown={(e) => handleResizeStart(e, colKey)}");
    expect(handle).toMatch(/title=\{canSaveColumnWidths[\s\S]*COLUMN_WIDTH_VIEW_ONLY_TITLE\} · drag to resize`\}/);
    // a person who may save: a click stops here (nothing), a double-click resets
    expect(handle).toContain("onDoubleClick={canSaveColumnWidths ? (e) => handleResizeReset(e, colKey) : undefined}");
    // anyone else: no click handler (it goes on to the header and sorts at once), no double-click reset
    expect(handle).toContain("onClick={canSaveColumnWidths ? (e) => e.stopPropagation() : undefined}");
    expect(handle).toContain("touchAction: \"none\"");
    expect(COLUMN_WIDTH_VIEW_ONLY_TITLE).toBe("Column width applies to this view only");
    const th = between("key={colKey}\n                                className={`relative px-2", "<div className=\"flex items-center gap-1 min-w-0 pr-2\">");
    expect(th).toMatch(/if \(resizeGesture\.headerClick\(\)\) return;\s*handleSort\(colKey\);/);
  });
});
