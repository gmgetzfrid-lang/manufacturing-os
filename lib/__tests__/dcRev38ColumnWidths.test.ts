// document-control REV-38 (DEC-90) — a library's shared column widths.
//
// A controller's change (a drag that changed a width, a reset of a column
// that differed from its default) is saved ~500 ms later through a checked
// write (`.select("id")`); a save that does not land is said in plain words
// while the width stays as dragged; anyone else resizes for this view only
// and nothing is written. Per-column last-writer-wins (the integrator's
// ruling at the F6 review): every stored map is taken, this tab's unsaved
// columns and the column under its drag stay, a save sends the latest known
// stored map with this tab's columns on top, and the echo of its own save
// clears what that save carried. The handle: a click sorts, a drag never.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COLUMN_WIDTH_SAVE_DEBOUNCE_MS,
  COLUMN_WIDTH_VIEW_ONLY_TITLE,
  HANDLE_CLICK_SORT_DELAY_MS,
  RESIZE_DRAG_THRESHOLD_PX,
  columnWidthNotSavedMessage,
  columnWidthsKey,
  composeColumnWidths,
  createColumnWidthSaver,
  createResizeHandleGesture,
  saveLibraryColumnWidths,
  type ColumnWidthSaveAnswer,
  type ColumnWidths,
} from "@/lib/libraryColumnWidths";
import { NOT_MATCHED_REASON } from "@/lib/checkedWriteReason";

const WAIT = COLUMN_WIDTH_SAVE_DEBOUNCE_MS;

function harness(opts: { canSave: boolean; answer?: ColumnWidthSaveAnswer | (() => Promise<ColumnWidthSaveAnswer>) }) {
  let screen: ColumnWidths = {};
  let dragging: string | null = null;
  const write = vi.fn(async (_w: ColumnWidths): Promise<ColumnWidthSaveAnswer> => {
    const a = opts.answer ?? { ok: true };
    return typeof a === "function" ? a() : a;
  });
  const notSaved = vi.fn();
  const saver = createColumnWidthSaver({
    canSave: () => opts.canSave,
    write,
    notSaved,
    apply: (update) => { screen = update(screen); },
    dragging: () => dragging,
  });
  return {
    saver, write, notSaved,
    get screen() { return screen; },
    /** The page's own drag: the column follows the pointer on the screen. */
    drag(col: string, w: number) { dragging = col; screen = { ...screen, [col]: w }; },
    release() { dragging = null; },
  };
}

/** A write whose answer the test releases. */
function heldWrites() {
  const pending: Array<(a: ColumnWidthSaveAnswer) => void> = [];
  return { answer: () => new Promise<ColumnWidthSaveAnswer>((r) => { pending.push(r); }), release: (a: ColumnWidthSaveAnswer = { ok: true }) => pending.shift()!(a), get waiting() { return pending.length; } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("REV-38 — a controller's width is saved, debounced and checked", () => {
  it("one save ~500 ms after the last change, carrying the stored map with this tab's columns on top", async () => {
    const h = harness({ canSave: true });
    h.saver.load({ title: 150, rev: 60 });
    expect(h.saver.change("title", 220)).toBe(true);
    expect(h.screen).toEqual({ title: 220, rev: 60 });
    await vi.advanceTimersByTimeAsync(WAIT - 1);
    expect(h.write).not.toHaveBeenCalled();
    h.saver.change("rev", 80); // a second drag inside the wait restarts it
    await vi.advanceTimersByTimeAsync(WAIT - 1);
    expect(h.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith({ title: 220, rev: 80 });
    expect(h.notSaved).not.toHaveBeenCalled();
    expect(WAIT).toBe(500);
  });

  it("a reset saves too: the column leaves the map", async () => {
    const h = harness({ canSave: true });
    h.saver.load({ title: 300, rev: 90 });
    expect(h.saver.change("title", null)).toBe(true);
    expect(h.screen).toEqual({ rev: 90 });
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).toHaveBeenCalledWith({ rev: 90 });
  });

  it("no change, no save: a width equal to the column's own, or a reset of a column with none", async () => {
    const h = harness({ canSave: true });
    h.saver.load({ title: 150 });
    expect(h.saver.change("title", 150)).toBe(false);
    expect(h.saver.change("rev", null)).toBe(false);
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    expect(h.write).not.toHaveBeenCalled();
  });

  it("a refused save is said in plain words — never 'nothing was changed' — the width stays as dragged and the next save carries it again", async () => {
    let answer: ColumnWidthSaveAnswer = { ok: false, reason: NOT_MATCHED_REASON };
    const h = harness({ canSave: true, answer: async () => answer });
    h.saver.load({ title: 150, rev: 60 });
    h.saver.change("title", 260);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.notSaved).toHaveBeenCalledTimes(1);
    const [message, afterClose] = h.notSaved.mock.calls[0];
    expect(message).toBe(columnWidthNotSavedMessage(NOT_MATCHED_REASON));
    expect(message).toMatch(/not saved for everyone — it still applies to this view/);
    expect(message).not.toMatch(/nothing was changed/i);
    expect(afterClose).toBe(false);
    expect(h.screen).toEqual({ title: 260, rev: 60 });
    // another controller's save of another column arrives: title stays as dragged
    h.saver.remote({ title: 150, rev: 75 });
    expect(h.screen).toEqual({ title: 260, rev: 75 });
    answer = { ok: true };
    h.saver.change("rev", 99);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).toHaveBeenLastCalledWith({ title: 260, rev: 99 });
  });

  it("a write that throws is said too, never swallowed", async () => {
    const h = harness({ canSave: true, answer: async () => { throw new Error("boom"); } });
    h.saver.change("title", 200);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.notSaved).toHaveBeenCalledWith(columnWidthNotSavedMessage("boom"), false);
  });

  it("flush sends a waiting save at once (the tab hidden / pagehide path); with none waiting it writes nothing", async () => {
    const h = harness({ canSave: true });
    await h.saver.flush();
    expect(h.write).not.toHaveBeenCalled();
    h.saver.change("title", 199);
    await h.saver.flush();
    expect(h.write).toHaveBeenCalledWith({ title: 199 });
    await vi.advanceTimersByTimeAsync(WAIT * 2);
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it("leaving the library sends a waiting save at once, and its refusal is marked afterClose; nothing is scheduled after", async () => {
    const h = harness({ canSave: true, answer: { ok: false, reason: "R" } });
    h.saver.change("title", 199);
    h.saver.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledWith({ title: 199 });
    expect(h.notSaved).toHaveBeenCalledWith(columnWidthNotSavedMessage("R"), true);
    h.saver.change("title", 250);
    await vi.advanceTimersByTimeAsync(WAIT * 2);
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it("regression: leaving with no waiting save writes nothing", async () => {
    const h = harness({ canSave: true });
    h.saver.dispose();
    await vi.advanceTimersByTimeAsync(WAIT * 2);
    expect(h.write).not.toHaveBeenCalled();
  });

  it("this tab's saves go one at a time, in order: a save asked for while one is in flight is sent when it answers, with the newest widths", async () => {
    const held = heldWrites();
    const h = harness({ canSave: true, answer: held.answer });
    h.saver.change("a", 110);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).toHaveBeenCalledTimes(1);
    h.saver.change("a", 120);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).toHaveBeenCalledTimes(1); // still in flight: not sent alongside
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.write).toHaveBeenLastCalledWith({ a: 120 });
    held.release();
  });
});

describe("REV-38 — a person who may not save resizes for this view only", () => {
  it("no write is attempted, after a drag or a reset, however long they wait or when they leave", async () => {
    const h = harness({ canSave: false });
    h.saver.load({ title: 150, rev: 60 });
    expect(h.saver.change("title", 400)).toBe(true);
    expect(h.saver.change("rev", null)).toBe(true);
    await vi.advanceTimersByTimeAsync(WAIT * 4);
    await h.saver.flush();
    h.saver.dispose();
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.notSaved).not.toHaveBeenCalled();
    expect(h.screen).toEqual({ title: 400 });
  });

  it("…sees a controller's save of the other columns, and keeps their own on the columns they set", () => {
    const h = harness({ canSave: false });
    h.saver.load({ title: 150, rev: 60 });
    h.saver.change("title", 400);
    h.saver.remote({ title: 500, rev: 70, status: 90 });
    expect(h.screen).toEqual({ title: 400, rev: 70, status: 90 });
  });
});

describe("REV-38 — per-column last-writer-wins: the interleavings", () => {
  it("a stored map that arrives while this tab's save WAITS is taken at once for the other columns, and the save carries it", async () => {
    const h = harness({ canSave: true });
    h.saver.load({ a: 100, b: 100 });
    h.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT / 2);
    h.saver.remote({ a: 100, b: 300 }); // another controller's save
    expect(h.screen).toEqual({ a: 150, b: 300 });
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).toHaveBeenCalledWith({ a: 150, b: 300 });
  });

  it("a stored map that arrives while this tab's save is IN FLIGHT is not dropped: this tab's next save carries it (the stale writer no longer wins)", async () => {
    const held = heldWrites();
    const h = harness({ canSave: true, answer: held.answer });
    h.saver.load({ a: 100, b: 100 });
    h.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).toHaveBeenLastCalledWith({ a: 150, b: 100 });
    h.saver.remote({ a: 150, b: 100 }); // this tab's echo (it committed)
    h.saver.remote({ a: 150, b: 300 }); // then the other controller's later save
    expect(h.screen).toEqual({ a: 150, b: 300 });
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    h.saver.change("a", 170);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).toHaveBeenLastCalledWith({ a: 170, b: 300 });
    held.release();
  });

  it("…and before this tab's echo the other columns move at once while this tab's column stays", async () => {
    const held = heldWrites();
    const h = harness({ canSave: true, answer: held.answer });
    h.saver.load({ a: 100, b: 100 });
    h.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    h.saver.remote({ a: 100, b: 300 });
    expect(h.screen).toEqual({ a: 150, b: 300 });
    held.release();
  });

  it("the limit, as recorded: a save of another tab that commits while this tab's save is in flight is overwritten on the columns this tab did not touch (the write replaces the whole map — REV-39)", async () => {
    const held = heldWrites();
    const h = harness({ canSave: true, answer: held.answer });
    h.saver.load({ a: 100, b: 100 });
    h.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT); // payload { a: 150, b: 100 } composed and sent
    h.saver.remote({ a: 100, b: 300 }); // committed before this tab's write …
    h.saver.remote({ a: 150, b: 100 }); // … which then landed over it
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.screen).toEqual({ a: 150, b: 100 });
  });

  it("a stored map that arrives DURING a drag never moves the dragged column; the other columns move at once; the drag's end saves over the newest map", async () => {
    const h = harness({ canSave: true });
    h.saver.load({ a: 100, b: 100 });
    h.drag("a", 180);
    h.saver.remote({ a: 120, b: 300 });
    expect(h.screen).toEqual({ a: 180, b: 300 });
    h.drag("a", 200);
    h.release();
    expect(h.saver.change("a", 200)).toBe(true);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).toHaveBeenCalledWith({ a: 200, b: 300 });
  });

  it("a press that changed nothing settles the held column to the stored width that arrived meanwhile", () => {
    const h = harness({ canSave: true });
    h.saver.load({ a: 100 });
    h.drag("a", 100);
    h.saver.remote({ a: 140 });
    expect(h.screen).toEqual({ a: 100 });
    h.release();
    h.saver.settle();
    expect(h.screen).toEqual({ a: 140 });
  });

  it("the echo of this tab's own save is not a jump, and clears what it carried: a later save by someone else on that column is taken", async () => {
    const h = harness({ canSave: true });
    h.saver.load({ a: 100, b: 100 });
    h.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    h.saver.remote({ b: 100, a: 150 }); // the echo, keys in another order
    expect(h.screen).toEqual({ a: 150, b: 100 });
    h.saver.remote({ a: 999, b: 100 });
    expect(h.screen).toEqual({ a: 999, b: 100 });
  });

  it("an echo does not clear a column changed again since it was sent", async () => {
    const held = heldWrites();
    const h = harness({ canSave: true, answer: held.answer });
    h.saver.load({ a: 100 });
    h.saver.change("a", 150);
    await vi.advanceTimersByTimeAsync(WAIT);
    h.saver.change("a", 170);
    h.saver.remote({ a: 150 }); // the first save's echo
    expect(h.screen).toEqual({ a: 170 });
    h.saver.remote({ a: 400 }); // still this tab's: a stays
    expect(h.screen).toEqual({ a: 170 });
    held.release();
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).toHaveBeenLastCalledWith({ a: 170 });
    held.release();
  });

  it("a fresh load after the cached view never wipes a resize made from the cached view, and the save carries both", async () => {
    const h = harness({ canSave: true });
    h.saver.load({ a: 100 }); // the session cache
    h.saver.change("a", 150);
    h.saver.load({ a: 120, b: 90 }); // the fresh row
    expect(h.screen).toEqual({ a: 150, b: 90 });
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(h.write).toHaveBeenCalledWith({ a: 150, b: 90 });
  });

  it("a refused save leaves no echo waiting: the stored map keeps arriving, this tab's column kept", async () => {
    const h = harness({ canSave: true, answer: { ok: false, reason: "R" } });
    h.saver.load({ a: 100 });
    h.saver.change("a", 222);
    await vi.advanceTimersByTimeAsync(WAIT);
    h.saver.remote({ a: 300, b: 40 }); // taken as stored; this tab's column stays as dragged
    expect(h.screen).toEqual({ a: 222, b: 40 });
  });

  it("composeColumnWidths: stored, dirty on top (null removes), the dragged column as the screen has it", () => {
    expect(composeColumnWidths({ a: 1, b: 2 }, new Map([["a", 5], ["b", null]]), {}, null)).toEqual({ a: 5 });
    expect(composeColumnWidths({ a: 1 }, new Map(), { a: 9 }, "a")).toEqual({ a: 9 });
    expect(composeColumnWidths({ a: 1 }, new Map(), {}, "a")).toEqual({});
  });

  it("columnWidthsKey ignores key order", () => {
    expect(columnWidthsKey({ a: 1, b: 2 })).toBe(columnWidthsKey({ b: 2, a: 1 }));
    expect(columnWidthsKey({ a: 1 })).not.toBe(columnWidthsKey({ a: 2 }));
    expect(columnWidthsKey(null)).toBe(columnWidthsKey({}));
  });
});

describe("REV-38 — saveLibraryColumnWidths is a checked write", () => {
  function client(answer: { data: unknown; error: unknown }) {
    const calls: Record<string, unknown[]> = {};
    const builder = {
      update(p: unknown) { calls.update = [p]; return builder; },
      eq(c: string, v: unknown) { calls.eq = [c, v]; return builder; },
      select(c: string) { calls.select = [c]; return Promise.resolve(answer); },
    };
    const sb = { from(t: string) { calls.from = [t]; return builder; } } as unknown as SupabaseClient;
    return { sb, calls };
  }

  it("writes column_widths and updated_by on the library row, reading the matched id back", async () => {
    const { sb, calls } = client({ data: [{ id: "lib-1" }], error: null });
    const a = await saveLibraryColumnWidths(sb, "lib-1", { title: 210 }, "u-1");
    expect(a).toEqual({ ok: true });
    expect(calls).toEqual({ from: ["libraries"], update: [{ column_widths: { title: 210 }, updated_by: "u-1" }], eq: ["id", "lib-1"], select: ["id"] });
  });

  it("zero rows matched is a refusal with its reason, never a save", async () => {
    const { sb } = client({ data: [], error: null });
    expect(await saveLibraryColumnWidths(sb, "lib-1", { title: 210 }, "u-1")).toEqual({ ok: false, reason: NOT_MATCHED_REASON });
  });

  it("a database error is a reason in plain words, not 'nothing was changed'", async () => {
    const { sb } = client({ data: null, error: { message: "permission denied for table libraries", code: "42501", details: "", hint: "" } });
    const a = await saveLibraryColumnWidths(sb, "lib-1", { title: 210 }, "u-1");
    expect(a.ok).toBe(false);
    expect((a as { reason: string }).reason).not.toMatch(/nothing was changed/i);
    expect((a as { reason: string }).reason.length).toBeGreaterThan(0);
  });
});

describe("REV-38 — the handle: a click sorts, a drag never does", () => {
  it("a press with no movement, then a click on the handle, sorts once after the double-click window", async () => {
    const g = createResizeHandleGesture();
    const sort = vi.fn();
    g.down(100);
    expect(g.move(100 + RESIZE_DRAG_THRESHOLD_PX - 1)).toBe(false);
    expect(g.up()).toBe(false);
    g.handleClick(1, sort);
    expect(sort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HANDLE_CLICK_SORT_DELAY_MS);
    expect(sort).toHaveBeenCalledTimes(1);
    expect(g.headerClick()).toBe(false); // a header click after a click sorts as before
  });

  it("the reset double-click does not sort", async () => {
    const g = createResizeHandleGesture();
    const sort = vi.fn();
    g.down(100); g.up(); g.handleClick(1, sort);
    g.down(100); g.up(); g.handleClick(2, sort);
    await vi.advanceTimersByTimeAsync(HANDLE_CLICK_SORT_DELAY_MS * 2);
    expect(sort).not.toHaveBeenCalled();
  });

  it("a drag that ends on the handle does not sort; one that ends elsewhere in the header has its header click swallowed, once", async () => {
    const g = createResizeHandleGesture();
    const sort = vi.fn();
    g.down(100);
    expect(g.move(100 + RESIZE_DRAG_THRESHOLD_PX)).toBe(true);
    expect(g.up()).toBe(true);
    g.handleClick(1, sort);
    await vi.advanceTimersByTimeAsync(HANDLE_CLICK_SORT_DELAY_MS);
    expect(sort).not.toHaveBeenCalled();
    g.down(100); g.move(160); g.up();
    expect(g.headerClick()).toBe(true);
    expect(g.headerClick()).toBe(false);
  });

  it("a drag that ends outside the header (no click follows) does not swallow the next real header click", async () => {
    const g = createResizeHandleGesture();
    g.down(100); g.move(200); g.up();
    await vi.advanceTimersByTimeAsync(1);
    expect(g.headerClick()).toBe(false);
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
    expect(page).toContain("if (widthSaverRef.current) widthSaverRef.current.load(parsed.colWidths ?? {});");
    expect(page).toContain("if (widthSaverRef.current) widthSaverRef.current.load(widths);");
    const sync = between("// Live-sync column_widths", "return () => { supabase.removeChannel(channel); };");
    expect(sync).toContain("if (widthSaverRef.current) widthSaverRef.current.remote(next);");
    expect(sync).toContain("else if (!resizingRef.current) setColWidths(next);");
  });

  it("the handle is offered to everyone, says 'applies to this view only' to a person whose width is not saved, and a click on it sorts while a drag's header click is swallowed", () => {
    const handle = between("{/* Right-edge resize handle", "</th>");
    expect(handle).not.toMatch(/\{isController && \(/);
    expect(handle).toContain("onPointerDown={(e) => handleResizeStart(e, colKey)}");
    expect(handle).toMatch(/title=\{canSaveColumnWidths[\s\S]*COLUMN_WIDTH_VIEW_ONLY_TITLE/);
    expect(handle).toMatch(/resizeGesture\.handleClick\(e\.detail, \(\) => handleSort\(colKey\)\);/);
    expect(handle).toContain("touchAction: \"none\"");
    expect(COLUMN_WIDTH_VIEW_ONLY_TITLE).toBe("Column width applies to this view only");
    const th = between("key={colKey}\n                                className={`relative px-2", "<div className=\"flex items-center gap-1 min-w-0 pr-2\">");
    expect(th).toMatch(/if \(resizeGesture\.headerClick\(\)\) return;\s*handleSort\(colKey\);/);
  });
});
