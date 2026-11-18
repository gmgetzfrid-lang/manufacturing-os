// @vitest-environment jsdom
//
// document-control REV-38 (F6 review items 5 and 7) — useLibraryColumnWidths,
// the library page's saver, rendered: who may save is read from the CURRENT
// render (the effect that keeps the saver's view of the page current), one
// saver per library (a change of library sends the waiting save for the
// library it was made on, and the new library gets its own saver; a render
// for the same library keeps the wait), and a waiting save is sent — best
// effort — when the tab is hidden or the page is being unloaded.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COLUMN_WIDTH_SAVE_DEBOUNCE_MS,
  useLibraryColumnWidths,
  type ColumnWidthSaver,
  type ColumnWidths,
} from "@/lib/libraryColumnWidths";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WAIT = COLUMN_WIDTH_SAVE_DEBOUNCE_MS;

function fakeClient(answer: () => { data: unknown; error: unknown } = () => ({ data: [{ id: "x" }], error: null })) {
  const writes: Array<{ id: unknown; widths: unknown }> = [];
  const sb = {
    from() {
      let patch: { column_widths?: unknown } = {};
      let id: unknown;
      const b = {
        update(p: { column_widths?: unknown }) { patch = p; return b; },
        eq(_c: string, v: unknown) { id = v; return b; },
        select() { writes.push({ id, widths: patch.column_widths }); return Promise.resolve(answer()); },
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { sb, writes };
}

let host: HTMLDivElement;
let root: Root;
/** What the probe last rendered, set from an effect. */
const seen: { saver: { current: ColumnWidthSaver | null }; screen: ColumnWidths } = { saver: { current: null }, screen: {} };

type Props = { libraryId: string; canSave: boolean; client: SupabaseClient; notSaved?: (m: string, a: boolean) => void; extra?: number };
function Probe(props: Props) {
  const [widths, setWidths] = useState<ColumnWidths>({});
  const ref = useLibraryColumnWidths({
    libraryId: props.libraryId,
    canSave: props.canSave,
    uid: "u-1",
    client: props.client,
    setColWidths: setWidths,
    dragging: () => null,
    notSaved: props.notSaved ?? (() => {}),
  });
  useEffect(() => { seen.saver = ref; seen.screen = widths; });
  return React.createElement("span", null, String(props.extra ?? 0));
}
async function render(p: Props) { await act(async () => { root.render(React.createElement(Probe, p)); }); }

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.useRealTimers();
});

describe("useLibraryColumnWidths — the saver reads the current render", () => {
  it("who may save follows the render: no write while canSave is false; a write once it is true", async () => {
    const { sb, writes } = fakeClient();
    await render({ libraryId: "lib-1", canSave: false, client: sb });
    await act(async () => { seen.saver.current!.change("a", 150); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT * 2); });
    expect(writes).toEqual([]);
    expect(seen.screen).toEqual({ a: 150 }); // still resized for this view
    await render({ libraryId: "lib-1", canSave: true, client: sb });
    // F6 second review item 4: the column set view-only is dropped on
    // becoming one who may save — the screen recomposed, never sent
    expect(seen.screen).toEqual({});
    await act(async () => { seen.saver.current!.change("b", 90); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT); });
    expect(writes).toEqual([{ id: "lib-1", widths: { b: 90 } }]);
  });

  it("a render for the same library keeps the saver and its wait (no early write)", async () => {
    const { sb, writes } = fakeClient();
    await render({ libraryId: "lib-1", canSave: true, client: sb });
    const first = seen.saver.current;
    await act(async () => { first!.change("a", 150); });
    await render({ libraryId: "lib-1", canSave: true, client: sb, extra: 1 });
    expect(seen.saver.current).toBe(first);
    expect(writes).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT); });
    expect(writes).toEqual([{ id: "lib-1", widths: { a: 150 } }]);
  });

  it("a change of library sends the waiting save to the library it was made on, at once; the new library gets its own saver", async () => {
    const { sb, writes } = fakeClient();
    await render({ libraryId: "lib-1", canSave: true, client: sb });
    const first = seen.saver.current;
    await act(async () => { first!.change("a", 150); });
    await render({ libraryId: "lib-2", canSave: true, client: sb });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(writes).toEqual([{ id: "lib-1", widths: { a: 150 } }]);
    expect(seen.saver.current).not.toBe(first);
    await act(async () => { seen.saver.current!.load({}); seen.saver.current!.change("c", 70); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT); });
    expect(writes[1]).toEqual({ id: "lib-2", widths: { c: 70 } });
  });

  it("unmounting sends the waiting save; its refusal is said with afterClose", async () => {
    const { sb, writes } = fakeClient(() => ({ data: [], error: null }));
    const notSaved = vi.fn();
    await render({ libraryId: "lib-1", canSave: true, client: sb, notSaved });
    await act(async () => { seen.saver.current!.change("a", 150); });
    act(() => root.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(writes).toEqual([{ id: "lib-1", widths: { a: 150 } }]);
    expect(notSaved).toHaveBeenCalledWith(expect.stringMatching(/not saved for everyone/), true);
    root = createRoot(host); // for afterEach
  });
});

describe("useLibraryColumnWidths — a waiting save on tab close (best effort)", () => {
  it("pagehide sends the waiting save at once", async () => {
    const { sb, writes } = fakeClient();
    await render({ libraryId: "lib-1", canSave: true, client: sb });
    await act(async () => { seen.saver.current!.change("a", 150); });
    await act(async () => { window.dispatchEvent(new Event("pagehide")); await vi.advanceTimersByTimeAsync(0); });
    expect(writes).toEqual([{ id: "lib-1", widths: { a: 150 } }]);
  });

  it("the tab becoming hidden sends it; becoming visible does not", async () => {
    const { sb, writes } = fakeClient();
    await render({ libraryId: "lib-1", canSave: true, client: sb });
    await act(async () => { seen.saver.current!.change("a", 150); });
    const state = vi.spyOn(document, "visibilityState", "get");
    state.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(writes).toEqual([]);
    state.mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(writes).toEqual([{ id: "lib-1", widths: { a: 150 } }]);
    state.mockRestore();
  });

  it("with no waiting save, tab close writes nothing; the listeners go with the library", async () => {
    const { sb, writes } = fakeClient();
    await render({ libraryId: "lib-1", canSave: true, client: sb });
    await act(async () => { window.dispatchEvent(new Event("pagehide")); await vi.advanceTimersByTimeAsync(0); });
    expect(writes).toEqual([]);
    const removed = vi.spyOn(window, "removeEventListener");
    act(() => root.unmount());
    expect(removed.mock.calls.some(([t]) => t === "pagehide")).toBe(true);
    removed.mockRestore();
    root = createRoot(host);
  });
});
