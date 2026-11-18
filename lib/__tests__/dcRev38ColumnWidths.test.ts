// document-control REV-38 (DEC-90) — a library's shared column widths.
//
// A controller's resize or reset is saved ~500 ms after it ends, through a
// checked write (`.select("id")`), and a save that does not land is said in
// plain words while the width stays as dragged; anyone else resizes for this
// view only and nothing is written; the live-sync never fights the person's
// own drag, their waiting / in-flight save, or the echo of their own save.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COLUMN_WIDTH_SAVE_DEBOUNCE_MS,
  COLUMN_WIDTH_VIEW_ONLY_TITLE,
  columnWidthNotSavedMessage,
  columnWidthsKey,
  createColumnWidthSaver,
  saveLibraryColumnWidths,
  type ColumnWidthSaveAnswer,
  type ColumnWidths,
} from "@/lib/libraryColumnWidths";
import { NOT_MATCHED_REASON } from "@/lib/checkedWriteReason";

function harness(opts: { canSave: boolean; answer?: ColumnWidthSaveAnswer | (() => Promise<ColumnWidthSaveAnswer>) }) {
  let widths: ColumnWidths = { title: 150 };
  const write = vi.fn(async (_w: ColumnWidths): Promise<ColumnWidthSaveAnswer> => {
    const a = opts.answer ?? { ok: true };
    return typeof a === "function" ? a() : a;
  });
  const notSaved = vi.fn();
  const saver = createColumnWidthSaver({
    canSave: () => opts.canSave,
    current: () => widths,
    write,
    notSaved,
  });
  return {
    saver, write, notSaved,
    set(next: ColumnWidths) { widths = next; },
    get widths() { return widths; },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("REV-38 — a controller's width is saved, debounced and checked", () => {
  it("one save ~500 ms after the drag ends, carrying the widths as they are when it fires", async () => {
    const h = harness({ canSave: true });
    h.set({ title: 220 });
    expect(h.saver.schedule()).toBe(true);
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS - 1);
    expect(h.write).not.toHaveBeenCalled();
    // a second drag inside the wait restarts it: still one save, the newest widths
    h.set({ title: 240, rev: 80 });
    h.saver.schedule();
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS - 1);
    expect(h.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith({ title: 240, rev: 80 });
    expect(h.notSaved).not.toHaveBeenCalled();
    expect(COLUMN_WIDTH_SAVE_DEBOUNCE_MS).toBe(500);
  });

  it("the reset double-click saves too (the page schedules after it; a drag then a reset is one save of the reset widths)", async () => {
    const h = harness({ canSave: true });
    h.set({ title: 300, rev: 90 });
    h.saver.schedule(); // drag end
    await vi.advanceTimersByTimeAsync(200);
    h.set({ rev: 90 }); // reset title → default (key removed)
    h.saver.schedule(); // the reset
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith({ rev: 90 });
  });

  it("a refused save is said in plain words — never 'nothing was changed' — and the width stays as dragged", async () => {
    const h = harness({ canSave: true, answer: { ok: false, reason: NOT_MATCHED_REASON } });
    h.set({ title: 260 });
    h.saver.schedule();
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS);
    expect(h.notSaved).toHaveBeenCalledTimes(1);
    const [message, afterClose] = h.notSaved.mock.calls[0];
    expect(message).toBe(columnWidthNotSavedMessage(NOT_MATCHED_REASON));
    expect(message).toMatch(/not saved for everyone — it still applies to this view/);
    expect(message).not.toMatch(/nothing was changed/i);
    expect(afterClose).toBe(false);
    expect(h.widths).toEqual({ title: 260 });
  });

  it("a write that throws is said too, never swallowed", async () => {
    const h = harness({ canSave: true, answer: async () => { throw new Error("boom"); } });
    h.saver.schedule();
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS);
    expect(h.notSaved).toHaveBeenCalledWith(columnWidthNotSavedMessage("boom"), false);
  });

  it("leaving the library sends a waiting save at once, and its refusal is marked afterClose", async () => {
    const h = harness({ canSave: true, answer: { ok: false, reason: "R" } });
    h.set({ title: 199 });
    h.saver.schedule();
    h.saver.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.write).toHaveBeenCalledWith({ title: 199 });
    expect(h.notSaved).toHaveBeenCalledWith(columnWidthNotSavedMessage("R"), true);
    // closed: nothing more is scheduled, nothing sent twice
    expect(h.saver.schedule()).toBe(false);
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS * 2);
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it("regression: leaving with no waiting save writes nothing", async () => {
    const h = harness({ canSave: true });
    h.saver.dispose();
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS * 2);
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe("REV-38 — a person who may not save resizes for this view only", () => {
  it("no write is attempted, after a drag or a reset, however long they wait or when they leave", async () => {
    const h = harness({ canSave: false });
    h.set({ title: 400 });
    expect(h.saver.schedule()).toBe(false);
    expect(h.saver.schedule()).toBe(false);
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS * 4);
    h.saver.dispose();
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.notSaved).not.toHaveBeenCalled();
    expect(h.widths).toEqual({ title: 400 });
  });

  it("…and still sees a controller's saved width when they are not dragging", () => {
    const h = harness({ canSave: false });
    expect(h.saver.acceptRemote({ title: 500 }, false)).toBe(true);
    expect(h.saver.acceptRemote({ title: 500 }, true)).toBe(false);
  });
});

describe("REV-38 — the live-sync does not fight the person", () => {
  it("nothing is taken during their own drag", () => {
    const h = harness({ canSave: true });
    expect(h.saver.acceptRemote({ title: 111 }, true)).toBe(false);
    expect(h.saver.acceptRemote({ title: 111 }, false)).toBe(true);
  });

  it("nothing is taken while their save waits or is in flight", async () => {
    let release: (a: ColumnWidthSaveAnswer) => void = () => {};
    const h = harness({ canSave: true, answer: () => new Promise<ColumnWidthSaveAnswer>((r) => { release = r; }) });
    h.set({ title: 222 });
    h.saver.schedule();
    expect(h.saver.acceptRemote({ title: 150 }, false)).toBe(false); // waiting
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.saver.acceptRemote({ title: 150 }, false)).toBe(false); // in flight
    release({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.saver.acceptRemote({ title: 150 }, false)).toBe(true); // settled: another's save is taken
  });

  it("the echo of their own save is not taken back (even after they moved on), and a later save by someone else is", async () => {
    const h = harness({ canSave: true });
    h.set({ rev: 80, title: 222 });
    h.saver.schedule();
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS);
    // the echo arrives with the keys in another order
    expect(h.saver.acceptRemote({ title: 222, rev: 80 }, false)).toBe(false);
    // a second identical echo (another column's UPDATE on the row) is then taken — it equals the screen
    expect(h.saver.acceptRemote({ title: 222, rev: 80 }, false)).toBe(true);
    expect(h.saver.acceptRemote({ title: 333 }, false)).toBe(true);
  });

  it("a refused save leaves no echo waiting: the row's next UPDATE is taken", async () => {
    const h = harness({ canSave: true, answer: { ok: false, reason: "R" } });
    h.set({ title: 222 });
    h.saver.schedule();
    await vi.advanceTimersByTimeAsync(COLUMN_WIDTH_SAVE_DEBOUNCE_MS);
    expect(h.saver.acceptRemote({ title: 222 }, false)).toBe(true);
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

describe("REV-38 — the library page wiring", () => {
  const page = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
  const between = (from: string, to: string) => {
    const i = page.indexOf(from);
    expect(i, from).toBeGreaterThan(-1);
    const j = page.indexOf(to, i + from.length);
    expect(j, to).toBeGreaterThan(i);
    return page.slice(i, j);
  };

  it("the drag's end and the reset both ask the saver (it decides who may save)", () => {
    const onUp = between("const onUp = () => {", "document.addEventListener(\"pointermove\"");
    expect(onUp).toMatch(/resizingRef\.current = null;[\s\S]*widthSaverRef\.current\?\.schedule\(\);/);
    const reset = between("const handleResizeReset = useCallback(", "}, []);");
    expect(reset).toContain("widthSaverRef.current?.schedule();");
  });

  it("the saver is gated on the controller tier (isControllerPrincipal) and writes through saveLibraryColumnWidths", () => {
    expect(page).toContain("const canSaveColumnWidths = !!principal && isControllerPrincipal(principal);");
    expect(page).toMatch(/canSave: \(\) => widthSaverLiveRef\.current\.canSave/);
    expect(page).toMatch(/write: \(widths\) => saveLibraryColumnWidths\(supabase, libraryId, widths,/);
    expect(page).toMatch(/notSaved: \(message, afterClose\) => \{[\s\S]{0,120}appAlert\([\s\S]{0,80}setError\(message\)/);
    expect(page).toMatch(/return \(\) => \{\s*saver\.dispose\(\);/);
  });

  it("the live-sync asks acceptRemote with the drag state (resizingRef kept)", () => {
    const sync = between("// Live-sync column_widths", "return () => { supabase.removeChannel(channel); };");
    expect(sync).toContain("const resizing = !!resizingRef.current;");
    expect(sync).toContain("acceptRemote(next, resizing)");
    expect(sync).toMatch(/if \(take\) setColWidths\(next\);/);
  });

  it("the handle is offered to everyone, and says 'applies to this view only' to a person whose width is not saved", () => {
    const handle = between("{/* Right-edge resize handle", "</th>");
    expect(handle).not.toMatch(/\{isController && \(/);
    expect(handle).toContain("onPointerDown={(e) => handleResizeStart(e, colKey)}");
    expect(handle).toMatch(/title=\{canSaveColumnWidths[\s\S]*COLUMN_WIDTH_VIEW_ONLY_TITLE/);
    expect(COLUMN_WIDTH_VIEW_ONLY_TITLE).toBe("Column width applies to this view only");
  });
});
