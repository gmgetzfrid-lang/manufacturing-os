// @vitest-environment jsdom
//
// notifications Round G, N7 CORNER (2026-10-01) — the corner dock's contract.
// Report 06 (STACK-4/5/7/9/10/11) + RT-11 / OS-4 / TAX-14. Every layout claim
// here was also observed in Chromium against the real components (a harness
// that stubs only the database and auth); these tests pin the behaviour.
//
// Regression first: every surface that lived in the corner before — toasts,
// upload cards, the indexing card, the backup card, undo toasts, the graph
// chip — still appears, is dismissible, and works, now under the cap.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const up = vi.hoisted(() => ({ listeners: new Set<(e: unknown) => void>() }));
vi.mock("@/lib/storage", () => ({
  subscribeUploads: (cb: (e: unknown) => void) => { up.listeners.add(cb); return () => { up.listeners.delete(cb); }; },
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("from=graph"),
  usePathname: () => "/projects/p1",
  useRouter: () => ({ push: vi.fn() }),
}));

import {
  CornerDock, CornerPortal, CentreDock, CentrePortal, allocateDock, rightRailOffset, pickSummary,
  __resetDockForTests, DOCK_VISIBLE_CAP, DOCK_MIN_ROOM_PX, NOTIFICATION_CENTER_RAIL_PX,
} from "@/components/ui/CornerDock";
import { ToastProvider, useToast, toastCoalesceKey, visibleToasts, COALESCE_WINDOW_MS } from "@/components/providers/ToastProvider";
import UploadIndicator, { pickVisibleUploads } from "@/components/providers/UploadIndicator";
import UndoToastHost from "@/components/projects/UndoToastHost";
import BackToGraphChip from "@/components/graph/BackToGraphChip";
import StagingTray from "@/components/documents/StagingTray";
import { Z, Z_SCALE } from "@/lib/zLayers";
import RailProbe from "./cornerDockRailProbe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emit = (e: Record<string, unknown>) => { for (const l of up.listeners) l(e); };
const upload = (id: string, status = "uploading", extra: Record<string, unknown> = {}) =>
  emit({ id, name: `${id}.pdf`, percent: 40, status, ...extra });

let host: HTMLDivElement;
let root: Root;
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const dock = () => document.getElementById("corner-dock");
const text = () => document.body.textContent ?? "";

const grabbed: { showToast: ReturnType<typeof useToast>["showToast"] } = { showToast: () => {} };
function Grab() {
  const { showToast } = useToast();
  React.useEffect(() => { grabbed.showToast = showToast; }, [showToast]);
  return null;
}
const toastApi = (t: Parameters<ReturnType<typeof useToast>["showToast"]>[0]) => grabbed.showToast(t);

async function mount(el: React.ReactNode) {
  await act(async () => { root.render(el as React.ReactElement); });
  await flush();
}
const shell = (...children: React.ReactNode[]) =>
  React.createElement(ToastProvider, null,
    React.createElement(CornerDock, { onOpenCenter: openCenter }),
    React.createElement(Grab),
    React.createElement(UploadIndicator),
    ...children);
const openCenter = vi.fn();

beforeEach(() => {
  __resetDockForTests();
  up.listeners.clear();
  openCenter.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.style.removeProperty("--dock-bottom");
  vi.useRealTimers();
});

describe("allocateDock — the cap and the priority (STACK-9, RT-11, OS-4)", () => {
  const e = (id: string, slot: "jobs" | "transient", priority: number, count: number, seq = 0) => ({ id, slot, priority, count, seq });

  it("40 uploads never exceed the cap: 4 visible, the other 36 counted for '+N more'", () => {
    const a = allocateDock([e("up", "jobs", 30, 40)], DOCK_VISIBLE_CAP);
    expect(DOCK_VISIBLE_CAP).toBe(4);
    expect(a.visible.up).toBe(4);
    expect(a.hidden).toBe(36);
    expect(a.hiddenTransient).toBe(0);
  });

  it("jobs are placed by priority (backup, indexing, uploads), never by mount order", () => {
    const a = allocateDock([e("up", "jobs", 30, 5, 1), e("kn", "jobs", 20, 1, 2), e("bk", "jobs", 10, 1, 3)], 4);
    expect(a.visible).toEqual({ up: 2, kn: 1, bk: 1 });
  });

  it("while a message waits, one place is kept for it — a 40-file upload cannot hide every error toast", () => {
    const a = allocateDock([e("up", "jobs", 30, 40), e("kn", "jobs", 20, 1), e("toasts", "transient", 10, 24)], 4);
    expect(a.visible).toEqual({ up: 2, kn: 1, toasts: 1 });
    expect(a.hidden).toBe(38 + 23);
    expect(a.hiddenTransient).toBe(23);
  });

  it("with no jobs the messages take every place; nothing at all hides nothing", () => {
    expect(allocateDock([e("t", "transient", 10, 6)], 4)).toMatchObject({ visible: { t: 4 }, hidden: 2, hiddenTransient: 2 });
    expect(allocateDock([], 4)).toMatchObject({ hidden: 0, total: 0 });
  });

  it("the phone pill names the most urgent card: an error, then a running job, then the newest", () => {
    const s = (label: string, tone: "busy" | "error" | "ok" | "info", touched: number) => ({ summary: { label, tone }, touched, count: 1 });
    expect(pickSummary([s("Saved", "ok", 3), s("Uploading 2 files", "busy", 1), s("1 upload failed", "error", 2)])?.label).toBe("1 upload failed");
    expect(pickSummary([s("Saved", "ok", 3), s("Uploading 2 files", "busy", 1)])?.label).toBe("Uploading 2 files");
    expect(pickSummary([s("Saved", "ok", 3), s("Older", "info", 1)])?.label).toBe("Saved");
  });
});

describe("the dock renders the cap, the expander and the center doorway", () => {
  it("40 upload events render at most DOCK_VISIBLE_CAP cards and a '+36 more' expander that shows them all, scrollable", async () => {
    await mount(shell());
    await act(async () => { for (let i = 0; i < 40; i++) upload(`F${i}`); });
    await flush();
    const cards = () => dock()!.querySelectorAll('[data-dock-slot="jobs"] .rounded-xl');
    expect(cards().length).toBe(4);
    expect(text()).toContain("+36 more");
    // No messages hidden → no "Notifications" doorway.
    expect(text()).not.toContain("Notifications");
    const more = [...dock()!.querySelectorAll("button")].find((b) => /more/.test(b.textContent ?? ""))!;
    await act(async () => { more.click(); });
    await flush();
    expect(cards().length).toBe(40);
    expect(text()).toContain("Show fewer");
    // The column is height-bounded and scrolls — it can never run off the top.
    expect(dock()!.className).toContain("overflow-y-auto");
    expect(dock()!.style.maxHeight).toContain("100dvh");
  });

  it("hidden messages offer the notification center from the '+N more' card", async () => {
    await mount(shell());
    await act(async () => { for (let i = 0; i < 6; i++) toastApi({ type: "info", title: `Doc ${i} revised` }); });
    await flush();
    expect(dock()!.querySelectorAll('[data-dock-slot="transient"] .rounded-xl').length).toBe(4);
    expect(text()).toContain("+2 more");
    const center = [...dock()!.querySelectorAll("button")].find((b) => /Notifications/.test(b.textContent ?? ""))!;
    await act(async () => { center.click(); });
    expect(openCenter).toHaveBeenCalledTimes(1);
  });

  it("the dock is a labelled live region portaled to document.body at Z.dock (STACK-10, NEDGE-5 for N3)", async () => {
    await mount(shell());
    const d = dock()!;
    expect(d.parentElement).toBe(document.body);
    expect(host.contains(d)).toBe(false);
    expect(d.getAttribute("role")).toBe("region");
    expect(d.getAttribute("aria-live")).toBe("polite");
    expect(d.getAttribute("aria-relevant")).toBe("additions");
    expect(Number(d.style.zIndex)).toBe(Z.dock);
  });

  it("jobs sit nearest the corner, messages above them (column-reverse: first child at the bottom)", async () => {
    await mount(shell());
    await act(async () => { upload("A"); toastApi({ type: "info", title: "Hello" }); });
    await flush();
    const d = dock()!;
    expect(d.className).toContain("flex-col-reverse");
    const slots = [...d.children].filter((c) => c.hasAttribute("data-dock-slot")).map((c) => c.getAttribute("data-dock-slot"));
    expect(slots).toEqual(["jobs", "transient"]);
  });
});

describe("toasts: cap, coalesce, timers that start only when visible (RT-11 / OS-4) — and every toast still works", () => {
  it("a single toast appears, is announced, dismissible with an accessible X, and auto-dismisses after its duration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await mount(shell());
    await act(async () => { toastApi({ type: "success", title: "Saved the register", duration: 5000 }); });
    await flush();
    expect(text()).toContain("Saved the register");
    expect(dock()!.querySelector('[role="status"]')).not.toBeNull();
    expect(dock()!.querySelector('button[aria-label="Dismiss"]')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(5100); });
    await flush();
    expect(text()).not.toContain("Saved the register");
  });

  it("the X removes a toast at once; an error toast is role=alert", async () => {
    await mount(shell());
    await act(async () => { toastApi({ type: "error", title: "Export failed", duration: 0 }); });
    await flush();
    const card = dock()!.querySelector('[role="alert"]');
    expect(card?.textContent).toContain("Export failed");
    await act(async () => { (card!.querySelector('button[aria-label="Dismiss"]') as HTMLElement).click(); });
    await flush();
    expect(text()).not.toContain("Export failed");
  });

  it("ten identical toasts within the window are one card with a count", async () => {
    await mount(shell());
    await act(async () => { for (let i = 0; i < 10; i++) toastApi({ type: "info", title: "Nudge from Pat", message: "Please review", duration: 6000 }); });
    await flush();
    const titles = [...dock()!.querySelectorAll("h4")].filter((h) => (h.textContent ?? "").startsWith("Nudge from Pat"));
    expect(titles.length).toBe(1);
    expect(titles[0].textContent).toContain("×10");
  });

  it("a producer's own key coalesces different wording about one event; different content stays separate", () => {
    expect(toastCoalesceKey({ type: "info", title: "A", coalesceKey: "doc_superseded:d1" }))
      .toBe(toastCoalesceKey({ type: "info", title: "B", coalesceKey: "doc_superseded:d1" }));
    expect(toastCoalesceKey({ type: "info", title: "A" })).not.toBe(toastCoalesceKey({ type: "info", title: "A", message: "x" }));
    expect(COALESCE_WINDOW_MS).toBe(10_000);
    expect(visibleToasts([1, 2, 3, 4, 5, 6], 4)).toEqual([3, 4, 5, 6]);
    expect(visibleToasts([1, 2], 0)).toEqual([]);
  });

  it("a toast collapsed into '+N more' keeps its full time: its timer starts only when it becomes visible", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await mount(shell());
    await act(async () => { for (let i = 0; i < 6; i++) toastApi({ type: "info", title: `T${i}`, duration: 5000 }); });
    await flush();
    // T0 and T1 are hidden (the newest four show).
    expect(text()).not.toContain("T0");
    await act(async () => { vi.advanceTimersByTime(4000); });
    await flush();
    // Expand: everything is within the stack now — T0 shows, with a fresh 5s.
    const more = [...dock()!.querySelectorAll("button")].find((b) => /more/.test(b.textContent ?? ""))!;
    await act(async () => { more.click(); });
    await flush();
    expect(text()).toContain("T0");
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    // T2..T5 ran 6s and are gone; T0/T1 have run 2s of their 5.
    expect(text()).not.toContain("T5");
    expect(text()).toContain("T0");
    await act(async () => { vi.advanceTimersByTime(3500); });
    await flush();
    expect(text()).not.toContain("T0");
  });

  it("on a page with no dock (public routes) a toast still shows, in its own corner, after a tick", async () => {
    await mount(React.createElement(ToastProvider, null, React.createElement(Grab)));
    await act(async () => { toastApi({ type: "info", title: "Public page toast", duration: 0 }); });
    await flush();
    expect(text()).toContain("Public page toast");
    expect(dock()).toBeNull();
  });
});

describe("STACK-5 — no duplicate corner, and a widget mounted before the dock moves into it", () => {
  it("the toast provider mounts BEFORE the dock (the auth gate); its toast lands in the dock once the dock appears", async () => {
    // Before: CornerPortal resolved the dock once, from a setTimeout(0) with
    // [] deps — behind the auth gate the dock was absent then, so every toast
    // rendered in the fallback corner for the life of the tab, on top of the
    // upload and indexing cards (observed in Chromium: 13 824 px² overlap).
    function Gate({ ready }: { ready: boolean }) {
      return ready ? React.createElement(React.Fragment, null, React.createElement(CornerDock), React.createElement(UploadIndicator)) : null;
    }
    const tree = (ready: boolean) => React.createElement(ToastProvider, null, React.createElement(Grab), React.createElement(Gate, { ready }));
    await mount(tree(false));
    await act(async () => { toastApi({ type: "info", title: "Early toast", duration: 0 }); });
    await flush();
    await mount(tree(true));
    await act(async () => { upload("U1"); });
    await flush();
    const t = [...document.querySelectorAll("h4")].find((h) => h.textContent === "Early toast")!;
    expect(t.closest("#corner-dock")).not.toBeNull();
    expect([...document.querySelectorAll("span")].find((s) => s.textContent === "U1.pdf")!.closest("#corner-dock")).not.toBeNull();
  });

  it("with the dock mounted, a widget that appears never commits a fallback corner, not even for a frame", async () => {
    await mount(shell());
    let outside = false;
    const mo = new MutationObserver(() => {
      const s = [...document.querySelectorAll("span")].find((x) => x.textContent === "LATE.pdf");
      if (s && !s.closest("#corner-dock")) outside = true;
    });
    mo.observe(document.body, { childList: true, subtree: true });
    await act(async () => { upload("LATE"); });
    await flush();
    mo.disconnect();
    expect(outside).toBe(false);
    expect([...document.querySelectorAll("span")].find((x) => x.textContent === "LATE.pdf")).toBeTruthy();
  });

  it("CornerPortal renders nothing on its first frame when no dock is registered yet", async () => {
    await act(async () => { root.render(React.createElement(CornerPortal, null, React.createElement("b", null, "probe"))); });
    expect(host.textContent).toBe("");
    await flush();
    expect(document.body.textContent).toContain("probe");
  });
});

describe("STACK-11 — a right-edge drawer moves the dock to its left", () => {
  it("rightRailOffset shifts by the widest open drawer, and stays at the edge when no card would fit beside it", () => {
    expect(rightRailOffset(1280, [720])).toBe(720);
    expect(rightRailOffset(1280, [600, 720])).toBe(720);
    expect(rightRailOffset(1280, [])).toBe(0);
    expect(rightRailOffset(390, [359])).toBe(0);
    expect(DOCK_MIN_ROOM_PX).toBe(340);
  });

  it("an open drawer's width moves the dock's right offset; closing it puts the dock back", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    const Drawer = RailProbe;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 720, height: 800 } as DOMRect);
    await mount(shell(React.createElement(Drawer, { open: true, key: "d" })));
    expect(dock()!.style.right).toBe("calc(720px - 1.5rem)");
    await mount(shell(React.createElement(Drawer, { open: false, key: "d" })));
    expect(dock()!.style.right).toBe("calc(0px - 1.5rem)");
    spy.mockRestore();
  });

  it("the open notification center is a rail too: the layout passes it, and the width matches the panel's class", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    expect(readFileSync(resolve("components/notifications/NotificationCenter.tsx"), "utf8")).toContain(`w-[${NOTIFICATION_CENTER_RAIL_PX}px]`);
    await mount(React.createElement(ToastProvider, null, React.createElement(CornerDock, { occupiedRightPx: NOTIFICATION_CENTER_RAIL_PX })));
    expect(dock()!.style.right).toBe("calc(480px - 1.5rem)");
    await mount(React.createElement(ToastProvider, null, React.createElement(CornerDock, { occupiedRightPx: 0 })));
    expect(dock()!.style.right).toBe("calc(0px - 1.5rem)");
  });

  it("InspectorDrawer and HistoryDrawer declare the rail while open", () => {
    const insp = readFileSync(resolve("components/documents/InspectorDrawer.tsx"), "utf8");
    expect(insp).toContain("useOccupyRightRail(panelRef, isOpen);");
    expect(insp).toContain("ref={panelRef}");
    const hist = readFileSync(resolve("components/documents/HistoryDrawer.tsx"), "utf8");
    expect(hist).toContain("useOccupyRightRail(panelRef, isOpen);");
  });
});

describe("STACK-7 — the page's bottom bar, card widths, and the phone pill", () => {
  it("StagingTray declares its height in --dock-bottom while mounted and clears it when it goes", async () => {
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 360, height: 46 } as DOMRect);
    const docs = [{ id: "d1", name: "Doc 1", documentNumber: "P-101" }] as never[];
    await mount(shell(React.createElement(StagingTray, { docs, onRemove: () => {}, onClear: () => {}, onOpen: () => {}, key: "t" })));
    expect(document.documentElement.style.getPropertyValue("--dock-bottom")).toBe("46px");
    expect(dock()!.style.bottom).toBe("calc(var(--dock-bottom, 0px) - 1.5rem)");
    await mount(shell(React.createElement(StagingTray, { docs: [], onRemove: () => {}, onClear: () => {}, onOpen: () => {}, key: "t" })));
    expect(document.documentElement.style.getPropertyValue("--dock-bottom")).toBe("");
    spy.mockRestore();
  });

  it("cards clamp to the viewport: toasts, upload, indexing and backup cards carry a min(…, 100vw-2rem) width", () => {
    const src = (p: string) => readFileSync(resolve(p), "utf8");
    expect(src("components/providers/ToastProvider.tsx")).toContain("w-[min(20rem,calc(100vw-2rem))]");
    expect(src("components/providers/UploadIndicator.tsx")).toContain("w-[min(18rem,calc(100vw-2rem))]");
    expect(src("components/providers/KnowledgeIndexIndicator.tsx")).toContain("w-[min(330px,calc(100vw-2rem))]");
    expect(src("components/providers/BackupIndicator.tsx")).toContain("w-[min(340px,calc(100vw-2rem))]");
    expect(src("components/providers/ToastProvider.tsx")).not.toMatch(/\bw-80\b/);
    expect(src("components/providers/UploadIndicator.tsx")).not.toMatch(/\bw-72\b/);
  });

  it("on a phone the dock is one summary pill; a tap expands it and Hide folds it back", async () => {
    const mm = vi.fn((q: string) => ({ matches: q.includes("max-width: 639px"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    Object.defineProperty(window, "matchMedia", { value: mm, configurable: true, writable: true });
    try {
      await mount(shell());
      await act(async () => { upload("PHONE"); toastApi({ type: "success", title: "Saved the register", duration: 0 }); });
      await flush();
      const pill = dock()!.querySelector("[data-dock-summary]") as HTMLElement;
      expect(pill).not.toBeNull();
      expect(pill.textContent).toContain("Uploading 1 file");
      expect(pill.textContent).toContain("2");
      expect(text()).not.toContain("Saved the register");
      await act(async () => { pill.click(); });
      await flush();
      expect(text()).toContain("Saved the register");
      expect(text()).toContain("PHONE.pdf");
      const hide = [...dock()!.querySelectorAll("button")].find((b) => /Hide/.test(b.textContent ?? ""))!;
      await act(async () => { hide.click(); });
      await flush();
      expect(dock()!.querySelector("[data-dock-summary]")).not.toBeNull();
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });
});

describe("STACK-4 — one bottom-centre dock: the undo stack sits above the graph chip, each on its own layer", () => {
  it("both portal into the centre dock; the chip present lifts the undo slot; layers are the old ones (40 / 280)", async () => {
    await mount(React.createElement(React.Fragment, null,
      React.createElement(CentreDock),
      React.createElement(BackToGraphChip),
      React.createElement(UndoToastHost as unknown as React.FC<Record<string, unknown>>, { toasts: [{ id: 1, message: "Moved 3 tasks", tone: "success" }], onUndo: () => {}, onDismiss: () => {} }),
    ));
    const cd = document.getElementById("centre-dock")!;
    expect(cd.parentElement).toBe(document.body);
    const chipSlot = cd.querySelector('[data-centre-slot="chip"]') as HTMLElement;
    const toastSlot = cd.querySelector('[data-centre-slot="toasts"]') as HTMLElement;
    expect(chipSlot.textContent).toContain("Back to graph");
    expect(toastSlot.textContent).toContain("Moved 3 tasks");
    expect(Number(chipSlot.style.zIndex)).toBe(Z.pageChip);
    expect(Number(toastSlot.style.zIndex)).toBe(Z.undoToast);
    expect(Z.pageChip).toBe(40);
    expect(Z.undoToast).toBe(280);
    expect(cd.getAttribute("data-chip")).toBe("1");
    expect(toastSlot.style.bottom).toContain("3.5rem");
    expect(chipSlot.querySelector("button")!.className).toContain("pointer-events-auto");
  });

  it("without the chip the undo slot sits at the old 1rem; without a centre dock the host falls back to its own fixed box", async () => {
    await mount(React.createElement(React.Fragment, null,
      React.createElement(CentreDock),
      React.createElement(UndoToastHost as unknown as React.FC<Record<string, unknown>>, { toasts: [], onUndo: () => {}, onDismiss: () => {} }),
    ));
    const toastSlot = document.querySelector('[data-centre-slot="toasts"]') as HTMLElement;
    expect(toastSlot.style.bottom).toBe("calc(var(--dock-bottom, 0px) + 1rem)");
    // The A11Y-6 live region stays mounted (empty) inside the slot.
    expect(toastSlot.querySelector('[aria-live="polite"]')).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(React.createElement(CentrePortal as unknown as React.FC<{ slot: string; children?: React.ReactNode }>, { slot: "toasts" }, React.createElement("i", null, "alone"))); });
    const fb = [...host.querySelectorAll("div")].find((d) => d.textContent === "alone")!;
    expect(fb.className).toContain("fixed bottom-4 left-1/2");
    expect(Number(fb.style.zIndex)).toBe(Z.undoToast);
  });
});

describe("pickVisibleUploads — a failure's reason is never the card collapsed behind the cap", () => {
  it("failures first, then running transfers, then finished; shown in start order", () => {
    const list = [
      { id: "a", status: "done" as const, _t: 1 },
      { id: "b", status: "uploading" as const, _t: 2 },
      { id: "c", status: "error" as const, _t: 3 },
      { id: "d", status: "cancelled" as const, _t: 4 },
      { id: "e", status: "uploading" as const, _t: 5 },
    ];
    expect(pickVisibleUploads(list, 2).map((u) => u.id)).toEqual(["c", "e"]);
    expect(pickVisibleUploads(list, 3).map((u) => u.id)).toEqual(["b", "c", "e"]);
    expect(pickVisibleUploads(list, 0)).toEqual([]);
    expect(pickVisibleUploads(list, 9)).toHaveLength(5);
  });
});

// ── lib/zLayers — one module owns every layer number (TAX-14 dw4, STACK-10) ──

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

describe("lib/zLayers — the scale", () => {
  const files = ["app", "components", "hooks", "lib"].flatMap((d) => walk(resolve(d)));
  const found = new Map<number, string[]>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const patterns = [/(?<![\w-])z-\[(\d+)\]/g, /(?<![\w[-])z-(\d+)(?![\w\]])/g, /zIndex\s*[=:]\s*\{?\s*(\d+)/g, /zIndex:\s*\w+\s*\?\s*(\d+)\s*:\s*(\d+)/g];
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        for (const g of m.slice(1)) {
          if (g === undefined) continue;
          const n = Number(g);
          found.set(n, [...(found.get(n) ?? []), f.replace(resolve(".") + "/", "")]);
        }
      }
    }
  }

  it("every z-index value in app/, components/, hooks/ and lib/ is one lib/zLayers.ts lists — a new layer is decided there", () => {
    const unlisted = [...found.keys()].filter((n) => !Z_SCALE.includes(n));
    expect(unlisted.map((n) => `${n} (${found.get(n)!.slice(0, 3).join(", ")}) — add it to Z_SCALE in lib/zLayers.ts`)).toEqual([]);
  });

  it("the dock is strictly above every modal, backdrop and dialog band, and below only the hover preview and print", () => {
    const above = [...found.keys()].filter((n) => n >= Z.dock);
    expect(above.sort((a, b) => a - b)).toEqual([Z.hoverPreview, Z.print]);
    expect(Z.dock).toBeGreaterThan(Z.dialog);
    expect(Z.dock).toBeGreaterThan(Z.assetPhotoUploader);
    expect(Z.dock).toBeGreaterThan(Z.customizeNodeModal);
    expect(Z.dock).toBeGreaterThan(Z.metadataStagingModal);
    expect(Z.hoverPreview).toBeGreaterThan(Z.dock);
  });

  it("no overlay is renumbered: the layers read from the module keep the values they had (the old order is pinned)", () => {
    expect({
      pageChip: Z.pageChip, undoToast: Z.undoToast, metadataStagingModal: Z.metadataStagingModal,
      customizeNodeModal: Z.customizeNodeModal, assetPhotoUploader: Z.assetPhotoUploader, dialog: Z.dialog,
      hoverPreview: Z.hoverPreview, print: Z.print,
    }).toEqual({
      pageChip: 40, undoToast: 280, metadataStagingModal: 300, customizeNodeModal: 400, assetPhotoUploader: 510,
      dialog: 700, hoverPreview: 800, print: 9999,
    });
    // The relative order of every pair the corner contract touches.
    const order = [Z.pageChip, 60 /* InspectorDrawer */, 70 /* HistoryDrawer */, 241 /* NotificationCenter */, Z.undoToast,
      Z.metadataStagingModal, Z.customizeNodeModal, Z.assetPhotoUploader, Z.dialog, Z.dock, Z.hoverPreview, Z.print];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(Z_SCALE).toEqual([...Z_SCALE].sort((a, b) => a - b));
  });

  it("the three upload-starting modals read their layer from the module, and nothing else in them moved", () => {
    const src = (p: string) => readFileSync(resolve(p), "utf8");
    const staging = src("components/documents/MetadataStagingModal.tsx");
    expect(staging).toContain('style={{ zIndex: Z.metadataStagingModal }}');
    expect(staging).not.toContain("z-[300]");
    const asset = src("components/assets/AssetPhotoUploader.tsx");
    expect(asset).toContain("style={{ zIndex: Z.assetPhotoUploader }}");
    expect(asset).not.toContain("z-[510]");
    const cover = src("components/documents/CustomizeNodeModal.tsx");
    expect(cover).toContain("style={{ zIndex: Z.customizeNodeModal }}");
    expect(cover).not.toContain("z-[400]");
    // The DialogHost (appConfirm) and the hover preview keep their numbers.
    expect(src("components/providers/DialogProvider.tsx")).toContain("zIndex={700}");
    expect(src("components/documents/DocHoverPreview.tsx")).toContain("z-[800]");
  });

  it("the old fixed corners are gone: BackupIndicator no longer pins bottom-left, the undo host and chip no longer pin bottom-centre", () => {
    const src = (p: string) => readFileSync(resolve(p), "utf8");
    expect(src("components/providers/BackupIndicator.tsx")).not.toMatch(/fixed bottom-5 left-5/);
    expect(src("components/providers/BackupIndicator.tsx")).toContain('<CornerPortal slot="jobs" priority={DOCK_PRIORITY.backup}>');
    expect(src("components/projects/UndoToastHost.tsx")).not.toMatch(/fixed bottom-4 left-1\/2/);
    expect(src("components/graph/BackToGraphChip.tsx")).not.toMatch(/fixed bottom-4 left-1\/2/);
  });
});

describe("the protected layout mounts the docks first", () => {
  it("CornerDock (with the center doorway) and CentreDock lead the shell; every indicator and the graph chip stay mounted", () => {
    const src = readFileSync(resolve("app/(protected)/layout.tsx"), "utf8");
    const main = src.slice(src.indexOf('<main className="flex-1 overflow-auto relative">'));
    const at = (s: string) => main.indexOf(s);
    const dockTag = "<CornerDock onOpenCenter={openCenter} occupiedRightPx={centerOpen ? NOTIFICATION_CENTER_RAIL_PX : 0} />";
    expect(at(dockTag)).toBeGreaterThan(0);
    expect(at(dockTag)).toBeLessThan(at("<CentreDock />"));
    for (const s of ["<UploadIndicator />", "<BackupIndicator />", "<KnowledgeIndexIndicator />", "<BackToGraphChip />", "<NotificationListener />", "<UpdatePill />", "<DialogHost />"]) {
      expect(at(s)).toBeGreaterThan(at("<CentreDock />"));
    }
    expect(src).toContain("const { open: openCenter, isOpen: centerOpen } = useNotificationCenter();");
  });

  it("no global CSS changed for the dock (scoped classes and inline layer styles only)", () => {
    const css = readFileSync(resolve("app/globals.css"), "utf8");
    expect(css).not.toMatch(/corner-dock|centre-dock|--dock-bottom/);
  });
});
