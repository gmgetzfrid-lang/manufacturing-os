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

const up = vi.hoisted(() => ({ listeners: new Set<(e: unknown) => void>(), uploadToPath: vi.fn() }));
const nav = vi.hoisted(() => ({ push: vi.fn() }));
const bk = vi.hoisted(() => ({ publish: (() => {}) as (p: unknown) => void }));
vi.mock("@/lib/storage", () => ({
  subscribeUploads: (cb: (e: unknown) => void) => { up.listeners.add(cb); return () => { up.listeners.delete(cb); }; },
  uploadToPath: up.uploadToPath,
}));
// The real BackupIndicator, fed by hand (STACK-10 review: a running backup
// card over the staging grid). The staging modal's title-block pass reads
// nothing here.
vi.mock("@/lib/clientBackup", () => ({
  subscribeBackup: (fn: (p: unknown) => void) => { bk.publish = fn; fn(null); return () => { bk.publish = () => {}; }; },
  cancelBackup: () => {},
  dismissBackup: () => bk.publish(null),
}));
vi.mock("@/lib/titleBlock", () => ({ readTitleBlock: async () => ({ confidence: 0 }) }));
vi.mock("@/lib/assets", () => ({
  createPhotoRecord: vi.fn(async () => undefined),
  parseCapturedAtFromFilename: () => null,
  invalidateAssetCache: () => {},
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("from=graph"),
  usePathname: () => "/projects/p1",
  useRouter: () => ({ push: nav.push }),
}));

import {
  CornerDock, CornerPortal, CentreDock, CentrePortal, allocateDock, rightRailOffset, pickSummary, pillLabel,
  dockAvoidOffset, __resetDockForTests, DOCK_VISIBLE_CAP, DOCK_MIN_ROOM_PX, NOTIFICATION_CENTER_RAIL_PX,
} from "@/components/ui/CornerDock";
import { ToastProvider, useToast, toastCoalesceKey, visibleToasts, COALESCE_WINDOW_MS } from "@/components/providers/ToastProvider";
import UploadIndicator, { pickVisibleUploads } from "@/components/providers/UploadIndicator";
import UndoToastHost from "@/components/projects/UndoToastHost";
import BackToGraphChip from "@/components/graph/BackToGraphChip";
import StagingTray from "@/components/documents/StagingTray";
import MetadataStagingModal from "@/components/documents/MetadataStagingModal";
import AssetPhotoUploader from "@/components/assets/AssetPhotoUploader";
import BackupIndicator from "@/components/providers/BackupIndicator";
import { Z, Z_SCALE } from "@/lib/zLayers";
import RailProbe, { AvoidProbe, ModalProbe, RaisingModalProbe, AssetEditorProbe } from "./cornerDockRailProbe";

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

/** Run `fn` with the phone breakpoint matching. */
async function onPhone(fn: () => Promise<void>) {
  const mm = vi.fn((q: string) => ({ matches: q.includes("max-width: 639px"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(window, "matchMedia", { value: mm, configurable: true, writable: true });
  try { await fn(); } finally { delete (window as { matchMedia?: unknown }).matchMedia; }
}
const viewport = (w: number, h: number) => {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
};
const rect = (left: number, top: number, right: number, bottom: number) =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() { return {}; } }) as DOMRect;

beforeEach(() => {
  __resetDockForTests();
  up.listeners.clear();
  up.uploadToPath.mockReset();
  openCenter.mockReset();
  nav.push.mockReset();
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

  it("raised over an upload modal, only the upload cards hold places: a backup card, the indexing card and toasts wait behind '+N more' (STACK-10 review)", () => {
    const list = [
      e("bk", "jobs", 10, 1, 1), e("kn", "jobs", 20, 1, 2),
      { ...e("up", "jobs", 30, 6, 3), raisable: true }, e("toasts", "transient", 10, 2, 4),
    ];
    const raised = allocateDock(list, 4, true);
    expect(raised.visible).toEqual({ bk: 0, kn: 0, up: 4, toasts: 0 });
    expect(raised).toMatchObject({ hidden: 2 + 1 + 1 + 2, hiddenTransient: 2, total: 10 });
    // At rest the same cards share the places as they always did.
    expect(allocateDock(list, 4).visible).toEqual({ bk: 1, kn: 1, up: 1, toasts: 1 });
    expect(allocateDock(list, 4, false)).toEqual(allocateDock(list, 4));
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
    // With no argument: the center's open(filter?) must not get the click
    // event as its filter (the segmented control would show nothing chosen).
    expect(openCenter).toHaveBeenCalledWith();
  });

  it("an expanded '+N more' folds back once nothing would be hidden — a later burst is capped again (N7 review)", async () => {
    // Before: the expansion stayed on until the dock was empty — expand at
    // 6 toasts, dismiss 3, and a 40-file upload rendered all 40 cards
    // (Chromium); a docked indexing card kept it on for hours.
    await mount(shell());
    await act(async () => { for (let i = 0; i < 6; i++) toastApi({ type: "info", title: `Keep ${i}`, duration: 0 }); });
    await flush();
    const button = (re: RegExp) => [...dock()!.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));
    await act(async () => { button(/more/)!.click(); });
    await flush();
    expect(button(/Show fewer/)).toBeTruthy();
    for (let i = 0; i < 3; i++) {
      await act(async () => { (dock()!.querySelector('[data-dock-slot="transient"] button[aria-label="Dismiss"]') as HTMLElement).click(); });
      await flush();
    }
    // Three left: the cap holds them all, so the expander is gone.
    expect(button(/Show fewer/)).toBeUndefined();
    await act(async () => { for (let i = 0; i < 40; i++) upload(`B${i}`); });
    await flush();
    expect(dock()!.querySelectorAll('[data-dock-slot="jobs"] .rounded-xl').length).toBe(3);
    expect(button(/more/)?.textContent).toContain("+39 more");
  });

  it("a burst bigger than the cap after the expansion folds it back too; a card or two arriving does not", async () => {
    await mount(shell());
    await act(async () => { for (let i = 0; i < 6; i++) toastApi({ type: "info", title: `Keep ${i}`, duration: 0 }); });
    await flush();
    const button = (re: RegExp) => [...dock()!.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));
    await act(async () => { button(/more/)!.click(); });
    await flush();
    await act(async () => { upload("ONE"); upload("TWO"); });
    await flush();
    expect(button(/Show fewer/)).toBeTruthy();
    expect(dock()!.querySelectorAll(".rounded-xl").length).toBe(8);
    await act(async () => { for (let i = 0; i < 40; i++) upload(`B${i}`); });
    await flush();
    expect(button(/Show fewer/)).toBeUndefined();
    expect(button(/more/)?.textContent).toMatch(/\+\d+ more/);
    expect(dock()!.querySelectorAll(".rounded-xl").length).toBe(DOCK_VISIBLE_CAP);
  });

  it("the dock is a labelled live region portaled to document.body, at rest at Z.dock (STACK-10, NEDGE-5 for N3)", async () => {
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

  it("a new toast never costs a visible one its card or its clock: two toasts 3s apart, the first goes at 5s, same node throughout (N7 review)", async () => {
    // Before: the widget registers its count in a layout effect, so the
    // first render after "Second" got the old count's places — "First"
    // dropped for one commit, came back as a new node (its slide-in
    // replayed) and its 5s restarted: Chromium had it still up at 5.5s,
    // gone at ~8s.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await mount(shell());
    const card = (t: string) => [...dock()!.querySelectorAll("h4")].find((h) => (h.textContent ?? "").startsWith(t))?.closest(".rounded-xl") ?? null;
    await act(async () => { toastApi({ type: "info", title: "First", duration: 5000 }); });
    await flush();
    const first = card("First");
    expect(first).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(3000); });
    await act(async () => { toastApi({ type: "info", title: "Second", duration: 5000 }); });
    await flush();
    expect(card("Second")).not.toBeNull();
    // The same DOM node: never unmounted, so no replayed slide-in.
    expect(card("First")).toBe(first);
    await act(async () => { vi.advanceTimersByTime(2100); });
    await flush();
    expect(card("First")).toBeNull();
    expect(card("Second")).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(3000); });
    await flush();
    expect(card("Second")).toBeNull();
  });

  it("a new upload never re-mounts the cards already showing (no replayed entrance)", async () => {
    // The lowest-ranked card is the finished one: it is the card a stale
    // allowance (n places for n+1 cards) would have dropped for a commit.
    await mount(shell());
    await act(async () => { upload("U0", "done"); upload("U1"); upload("U2"); });
    await flush();
    const node = (n: string) => [...dock()!.querySelectorAll("span")].find((x) => x.textContent === n)?.closest(".rounded-xl") ?? null;
    const u0 = node("U0.pdf");
    expect(u0).not.toBeNull();
    await act(async () => { upload("U3"); });
    await flush();
    expect(node("U0.pdf")).toBe(u0);
    expect(node("U3.pdf")).not.toBeNull();
  });

  it("a 'Done' or 'Stopped' card behind the cap clears on its own time from when it finished; a failure's clock waits until it is seen", async () => {
    // Before: finished cards behind four running transfers never started
    // their clock — after a 40-file run the corner drained Done cards four
    // at a time for ~25s.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await mount(shell());
    await act(async () => { for (let i = 0; i < 4; i++) upload(`RUN${i}`); });
    await act(async () => { upload("D1", "done"); upload("D2", "done"); upload("S1", "cancelled"); });
    await flush();
    const more = () => [...dock()!.querySelectorAll("button")].find((b) => /more/.test(b.textContent ?? ""))?.textContent ?? null;
    expect(more()).toContain("+3 more");
    await act(async () => { vi.advanceTimersByTime(2600); });
    await flush();
    expect(more()).toBeNull();
    // Five failures: four show and run their 7s; the fifth waits its turn
    // and gets its full time once it shows.
    await act(async () => { for (let i = 0; i < 4; i++) upload(`RUN${i}`, "done"); });
    await act(async () => { vi.advanceTimersByTime(2600); });
    await flush();
    await act(async () => { for (let i = 0; i < 5; i++) upload(`E${i}`, "error", { error: `reason ${i}` }); });
    await flush();
    expect(more()).toContain("+1 more");
    await act(async () => { vi.advanceTimersByTime(7100); });
    await flush();
    expect(dock()!.querySelectorAll('[data-dock-slot="jobs"] .rounded-xl').length).toBe(1);
    expect(more()).toBeNull();
    await act(async () => { vi.advanceTimersByTime(7100); });
    await flush();
    expect(dock()!.querySelectorAll('[data-dock-slot="jobs"] .rounded-xl').length).toBe(0);
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

  it("on a phone a folded toast still expires on its own time, and the pill goes with it — as a toast always did", async () => {
    // Before the review fix the folded pill stopped every clock: a 2s
    // "Saved" toast was still a pill after 4s (Chromium, 360x740), for good.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await onPhone(async () => {
      await mount(shell());
      await act(async () => { toastApi({ type: "success", title: "Saved the register", duration: 2000 }); });
      await flush();
      expect(dock()!.querySelector("[data-dock-summary]")?.textContent).toContain("Saved the register");
      await act(async () => { vi.advanceTimersByTime(2100); });
      await flush();
      expect(dock()!.querySelector("[data-dock-summary]")).toBeNull();
      // A finished upload card clears on its "Done" timing too.
      await act(async () => { upload("PH1", "done"); });
      await flush();
      expect(dock()!.querySelector("[data-dock-summary]")?.textContent).toContain("Uploads finished");
      await act(async () => { vi.advanceTimersByTime(2600); });
      await flush();
      expect(dock()!.querySelector("[data-dock-summary]")).toBeNull();
    });
  });

  it("on a phone the cap still holds the clocks: cards past the four the stack would show keep their full time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await onPhone(async () => {
      await mount(shell());
      await act(async () => { for (let i = 0; i < 6; i++) toastApi({ type: "info", title: `P${i}`, duration: 2000 }); });
      await flush();
      await act(async () => { vi.advanceTimersByTime(2100); });
      await flush();
      // The newest four expired; P0 and P1 have not started their time yet.
      const pill = dock()!.querySelector("[data-dock-summary]") as HTMLElement;
      expect(pill).not.toBeNull();
      expect(pill.getAttribute("aria-label")).toBe("P1 — 2 updates, show");
      await act(async () => { vi.advanceTimersByTime(2100); });
      await flush();
      expect(dock()!.querySelector("[data-dock-summary]")).toBeNull();
    });
  });

  it("the pill's accessible name carries what it shows, and a folded failure is said (role=alert)", async () => {
    await onPhone(async () => {
      await mount(shell());
      await act(async () => { upload("PHF", "error", { error: "connection reset" }); toastApi({ type: "info", title: "Doc revised", duration: 0 }); });
      await flush();
      const pill = dock()!.querySelector("[data-dock-summary]") as HTMLElement;
      expect(pill.getAttribute("aria-label")).toBe("1 upload failed — 2 updates, show");
      const said = dock()!.querySelector("[data-dock-announce]") as HTMLElement;
      expect(said.getAttribute("role")).toBe("alert");
      expect(said.textContent).toBe("1 upload failed");
      expect(said.className).toContain("sr-only");
      expect(pillLabel(null, 1)).toBe("Updates — 1 update, show");
      // Opened, the cards (and the error's own text) are in the page; the
      // mirror goes.
      await act(async () => { pill.click(); });
      await flush();
      expect(dock()!.querySelector("[data-dock-announce]")).toBeNull();
      expect(text()).toContain("connection reset");
    });
  });
});

// ── STACK-10 / STACK-14: two bands, and never on a modal's action row ───────

describe("STACK-10 / STACK-14 — at rest the dock is under every overlay; an upload modal raises it", () => {
  // Chromium before this fix (the reviewer's harness, the asset editor's
  // classes): with the dock always above every overlay, the editor's Save
  // was covered at 1280x800, 1440x900 and 1920x1080 by one toast or by one
  // running upload card — which has no Dismiss. On b9cdfdc it was reachable.

  it("at rest the dock is at Z.dock, under the z-400 asset editor: a running upload card never sits over its Save", async () => {
    await mount(shell(React.createElement(AssetEditorProbe)));
    await act(async () => { upload("P-101-photo"); toastApi({ type: "success", title: "Asset saved", duration: 0 }); });
    await flush();
    expect(text()).toContain("P-101-photo.pdf");
    expect(dock()!.getAttribute("data-dock-raised")).toBeNull();
    const drawer = document.querySelector("[data-test-drawer]") as HTMLElement;
    const drawerZ = Number(/z-\[(\d+)\]/.exec(drawer.className)![1]);
    expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
    expect(Number(dock()!.style.zIndex)).toBeLessThan(drawerZ);
    // The probe carries the real editor's classes (admin/assets/page.tsx).
    const page = readFileSync(resolve("app/(protected)/admin/assets/page.tsx"), "utf8");
    expect(page).toContain('<div className="fixed inset-0 z-[400] flex" onClick={onClose}>');
    expect(page).toContain("relative ml-auto w-full max-w-xl");
  });

  it("a modal that started an upload raises the dock only while an upload card shows: none yet, at rest; a card, raised; cleared or closed, back at rest", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const tree = (open: boolean) => shell(open ? React.createElement(RaisingModalProbe, { key: "m" }) : null);
    await mount(tree(true));
    // Raised by the modal, but nothing to report: the dock stays under it.
    expect(dock()!.getAttribute("data-dock-raised")).toBeNull();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
    await act(async () => { upload("F1"); });
    await flush();
    expect(dock()!.getAttribute("data-dock-raised")).toBe("1");
    expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised);
    // The card finishes and clears (2.5s): the modal is still open, the dock drops.
    await act(async () => { upload("F1", "done"); });
    await act(async () => { vi.advanceTimersByTime(2600); });
    await flush();
    expect(text()).not.toContain("F1.pdf");
    expect(dock()!.getAttribute("data-dock-raised")).toBeNull();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
    await act(async () => { upload("F2"); });
    await flush();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised);
    await mount(tree(false));
    expect(dock()!.getAttribute("data-dock-raised")).toBeNull();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
  });

  /** The layer an element paints in: the nearest inline z-index up its tree
   *  (the overlays and the dock set theirs from lib/zLayers). Both the dock
   *  and the modals sit in the root stacking context, so a card can cover a
   *  control only from a higher layer. */
  const layerOf = (el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const z = (n as HTMLElement).style?.zIndex;
      if (z) return Number(z);
    }
    return 0;
  };
  const jobsSlot = () => dock()!.querySelector('[data-dock-slot="jobs"]')!;
  const transientSlot = () => dock()!.querySelector('[data-dock-slot="transient"]')!;
  const runningBackup = { phase: "files", filesDone: 120, filesTotal: 900, bytesDone: 4e8, bytesTotal: 3e9, part: 1, currentPath: "orgs/o1/docs/P-101.pdf", errors: [] };

  it("the staging wizard before Upload All: a running backup card and a toast stay under it, so the last row's Remove / Duplicate / Status are never covered; Upload All raises only the upload cards (N7 review)", async () => {
    // Chromium, the review's probe (real MetadataStagingModal, 40 staged
    // files, grid scrolled to its end, no upload): with the dock raised on
    // open, the last row's "Remove from batch", "Duplicate row" and Status
    // were hit at 0 of 3 points at 1280x800, 1366x768 and 1440x900 under a
    // backup card or one toast. On b9cdfdc, 3 of 3 at every size.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const files = Array.from({ length: 40 }, (_, i) => new File(["x"], `A-${100 + i}.pdf`));
    const noColumns: never[] = [];
    let fail!: (e: Error) => void;
    const onSubmit = vi.fn(() => new Promise<void>((_, reject) => {
      fail = reject;
      for (let i = 0; i < 6; i++) upload(`A-${100 + i}`);
    }));
    await mount(shell(
      React.createElement(BackupIndicator),
      // A stable column list, as the library page passes: the modal's
      // back-fill effect runs whenever the array's identity changes.
      React.createElement(MetadataStagingModal, { isOpen: true, files, customColumns: noColumns, onCancel: () => {}, onSubmit }),
    ));
    await act(async () => { bk.publish(runningBackup); toastApi({ type: "info", title: "Jane mentioned you on P-101", duration: 0 }); });
    await flush();
    // Before any upload: at rest, under the modal — the cards show there
    // (dimmed behind its backdrop, as on b9cdfdc) and cover nothing.
    expect(dock()!.getAttribute("data-dock-raised")).toBeNull();
    expect(dock()!.getAttribute("data-dock-avoiding")).toBeNull();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
    expect(jobsSlot().textContent).toContain("Backup — file 121 of 900");
    expect(transientSlot().textContent).toContain("Jane mentioned you on P-101");
    const removes = document.querySelectorAll('button[title="Remove from batch"]');
    const dups = document.querySelectorAll('button[title="Duplicate row"]');
    expect(removes.length).toBe(40);
    const lastRow = removes[removes.length - 1].closest("tr")!;
    for (const control of [removes[removes.length - 1], dups[dups.length - 1], lastRow.querySelector("select")!]) {
      expect(layerOf(control)).toBe(Z.metadataStagingModal);
      expect(layerOf(control)).toBeGreaterThan(Number(dock()!.style.zIndex));
    }
    // Minimizing the backup changes nothing: the pill is under the modal too.
    await act(async () => { (jobsSlot().querySelector('button[title^="Minimize"]') as HTMLElement).click(); });
    await flush();
    expect(jobsSlot().textContent).toContain("Backup 13%");
    expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
    // An upload started somewhere else is not this modal's: still at rest.
    await act(async () => { upload("ELSEWHERE"); });
    await flush();
    expect(jobsSlot().textContent).toContain("ELSEWHERE.pdf");
    expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
    await act(async () => { upload("ELSEWHERE", "done"); });
    await act(async () => { vi.advanceTimersByTime(2600); });
    await flush();
    expect(jobsSlot().textContent).not.toContain("ELSEWHERE.pdf");

    // Upload All: the dock rises over the modal with the upload cards only.
    const uploadAll = [...document.querySelectorAll("button")].find((b) => b.textContent === "Upload All")!;
    await act(async () => { uploadAll.click(); });
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(dock()!.getAttribute("data-dock-raised")).toBe("1");
    expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised);
    // All four places go to upload cards (at rest one would be kept for the toast).
    expect([...jobsSlot().querySelectorAll(".rounded-xl")].filter((c) => /A-10\d\.pdf40%/.test(c.textContent ?? ""))).toHaveLength(4);
    expect(jobsSlot().textContent).not.toContain("Backup");
    expect(transientSlot().children.length).toBe(0);
    const more = [...dock()!.querySelectorAll("button")].find((b) => /more/.test(b.textContent ?? ""))!;
    expect(more.textContent).toContain("+4 more"); // 2 uploads past the cap, the backup, the toast

    // The run ends with a failure: the modal stays open with it, and the
    // failed card reports over the modal until it clears — then the dock is
    // back at rest, under the modal, with the backup and the toast.
    await act(async () => {
      for (let i = 0; i < 5; i++) upload(`A-${100 + i}`, "done");
      upload("A-105", "error", { error: "Network error" });
      fail(new Error("Uploaded 5 of 6."));
    });
    await flush();
    expect(text()).toContain("Uploaded 5 of 6.");
    expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised);
    expect(jobsSlot().textContent).toContain("Network error");
    await act(async () => { vi.advanceTimersByTime(7100); });
    await flush();
    expect(jobsSlot().textContent).not.toContain("A-105.pdf");
    expect(jobsSlot().textContent).not.toContain("Network error");
    expect(document.querySelectorAll('button[title="Remove from batch"]').length).toBe(40);
    expect(dock()!.getAttribute("data-dock-raised")).toBeNull();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
    expect(jobsSlot().textContent).toContain("Backup 13%");
    expect(transientSlot().textContent).toContain("Jane mentioned you on P-101");
  });

  it("raised, a failed run's cards clear in one 7s window — twelve failures over the staging wizard leave the dock at rest within 7.5s, not four at a time (N7 fourth review)", async () => {
    // Chromium, the fourth review's probe (real MetadataStagingModal, 40
    // files, all 12 transfers failing): a failure's clock waited until it
    // held one of the four places, so the raised dock covered the last
    // row's Remove and Status for 21s — ceil(12/4) x 7s; 70s for 40
    // failures. On b9cdfdc every failure cleared 7s after its event.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const files = Array.from({ length: 40 }, (_, i) => new File(["x"], `B-${100 + i}.pdf`));
    const noColumns: never[] = [];
    let fail!: (e: Error) => void;
    const onSubmit = vi.fn(() => new Promise<void>((_, reject) => {
      fail = reject;
      for (let i = 0; i < 12; i++) upload(`B-${100 + i}`);
    }));
    await mount(shell(
      React.createElement(MetadataStagingModal, { isOpen: true, files, customColumns: noColumns, onCancel: () => {}, onSubmit }),
    ));
    const uploadAll = [...document.querySelectorAll("button")].find((b) => b.textContent === "Upload All")!;
    await act(async () => { uploadAll.click(); });
    await flush();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised);
    // The network drops: every transfer fails, the modal stays open with them.
    await act(async () => {
      for (let i = 0; i < 12; i++) upload(`B-${100 + i}`, "error", { error: "Network error" });
      fail(new Error("Uploaded 0 of 12."));
    });
    await flush();
    expect(text()).toContain("Uploaded 0 of 12.");
    expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised);
    expect(jobsSlot().querySelectorAll(".rounded-xl")).toHaveLength(4);
    const more = () => [...dock()!.querySelectorAll("button")].find((b) => /more/.test(b.textContent ?? ""))?.textContent ?? null;
    expect(more()).toContain("+8 more");
    // Not yet: a failure still gets its full 7s.
    await act(async () => { vi.advanceTimersByTime(6500); });
    await flush();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised);
    // One window: by 7.5s every failure has cleared, the dock is back at
    // rest, and the last row's controls are above it again.
    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(jobsSlot().querySelectorAll(".rounded-xl")).toHaveLength(0);
    expect(more()).toBeNull();
    expect(dock()!.getAttribute("data-dock-raised")).toBeNull();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
    const removes = document.querySelectorAll('button[title="Remove from batch"]');
    expect(removes.length).toBe(40);
    const lastRow = removes[removes.length - 1].closest("tr")!;
    for (const control of [removes[removes.length - 1], lastRow.querySelector("select")!]) {
      expect(layerOf(control)).toBeGreaterThan(Number(dock()!.style.zIndex));
    }
  });

  it("at rest the cap still holds a failure's clock until it is seen — the raised rule does not leak to an upload no modal started", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    // A modal is open that started no upload (it raises nothing): six
    // failures from elsewhere drain four, then two, as before.
    await mount(shell(React.createElement(ModalProbe)));
    await act(async () => { for (let i = 0; i < 6; i++) upload(`E${i}`, "error", { error: `reason ${i}` }); });
    await flush();
    expect(dock()!.getAttribute("data-dock-raised")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(7100); });
    await flush();
    expect(jobsSlot().querySelectorAll(".rounded-xl")).toHaveLength(2);
    await act(async () => { vi.advanceTimersByTime(7100); });
    await flush();
    expect(jobsSlot().querySelectorAll(".rounded-xl")).toHaveLength(0);
  });

  it("the photo uploader: staged photos and a backup card leave the dock under it; Upload raises it with the upload card only", async () => {
    const created: string[] = [];
    Object.defineProperty(URL, "createObjectURL", { value: (f: File) => { created.push(f.name); return `blob:${f.name}`; }, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true });
    up.uploadToPath.mockImplementation(() => { upload("IMG_1"); return new Promise(() => {}); });
    const asset = { id: "a1", org_id: "o1", tag: "P-101" } as unknown as React.ComponentProps<typeof AssetPhotoUploader>["asset"];
    try {
      await mount(shell(
        React.createElement(BackupIndicator),
        React.createElement(AssetPhotoUploader, { isOpen: true, asset, userId: "u1", onClose: () => {}, onUploaded: () => {} }),
      ));
      await act(async () => { bk.publish(runningBackup); });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [new File(["x"], "IMG_1.jpg", { type: "image/jpeg" })], configurable: true });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
      await flush();
      expect(created).toEqual(["IMG_1.jpg"]);
      expect(dock()!.getAttribute("data-dock-raised")).toBeNull();
      expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
      const uploadButton = [...document.querySelectorAll("button")].find((b) => /Upload 1 photo/.test(b.textContent ?? ""))!;
      expect(layerOf(uploadButton)).toBe(Z.assetPhotoUploader);
      // A staged photo is not an upload: its remove X stays above the dock.
      const photoX = [...document.querySelectorAll("button")].find((b) => b.parentElement?.className === "shrink-0" && b.className.includes("hover:text-red-600"));
      expect(photoX).toBeDefined();
      expect(layerOf(photoX!)).toBeGreaterThan(Number(dock()!.style.zIndex));
      await act(async () => { uploadButton.click(); });
      await flush();
      expect(up.uploadToPath).toHaveBeenCalledTimes(1);
      expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised);
      expect(jobsSlot().textContent).toContain("IMG_1.pdf");
      expect(jobsSlot().textContent).not.toContain("Backup");
    } finally {
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
      delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });

  it("raised, the '+N more' still expands to everything and stays open while the cap would hide something (fold-back reads the capped allocation, not the total)", async () => {
    await mount(shell(React.createElement(RaisingModalProbe), React.createElement(BackupIndicator)));
    await act(async () => { bk.publish(runningBackup); toastApi({ type: "info", title: "Saved", duration: 0 }); upload("F1"); });
    await flush();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised);
    const button = (re: RegExp) => [...dock()!.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));
    expect(button(/more/)!.textContent).toContain("+2 more");
    // Three cards in all — under the cap — yet the raised dock hides two:
    // the expansion must not fold straight back.
    await act(async () => { button(/more/)!.click(); });
    await flush(6);
    expect(jobsSlot().textContent).toContain("Backup");
    expect(transientSlot().textContent).toContain("Saved");
    // A fourth card arrives: four in all, still under the cap — but the
    // raised dock would still hide two, so the expansion holds.
    await act(async () => { upload("F2"); });
    await flush(6);
    expect(jobsSlot().textContent).toContain("Backup");
    expect(jobsSlot().textContent).toContain("F2.pdf");
    expect(button(/Show fewer/)).toBeDefined();
    await act(async () => { button(/Show fewer/)!.click(); });
    await flush();
    expect(jobsSlot().textContent).not.toContain("Backup");
  });

  it("raised, the '+N more' offers no 'Notifications' doorway, and an open center's rail does not move the dock onto the modal; at rest both come back (N7 fourth review)", async () => {
    // Chromium, the fourth review's probe: the raised dock's doorway opened
    // the z-241 center under the z-300 staging modal (invisible), and its
    // 480px rail moved the cards from x 976-1264 to x 496-784 at 1280x800,
    // over the middle of the staging grid, until the hidden center closed.
    viewport(1280, 800);
    const tree = (raising: boolean) => React.createElement(ToastProvider, null,
      React.createElement(CornerDock, { onOpenCenter: openCenter, occupiedRightPx: NOTIFICATION_CENTER_RAIL_PX }),
      React.createElement(Grab),
      React.createElement(UploadIndicator),
      raising ? React.createElement(RaisingModalProbe, { key: "m" }) : null);
    await mount(tree(true));
    await act(async () => {
      for (let i = 0; i < 6; i++) toastApi({ type: "info", title: `Doc ${i} revised`, duration: 0 });
      for (let i = 0; i < 6; i++) upload(`U${i}`);
    });
    await flush();
    expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised);
    const button = (re: RegExp) => [...dock()!.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));
    // Six toasts wait behind "+N more" — yet no doorway to a center the
    // modal would hide.
    expect(button(/more/)!.textContent).toContain("+8 more");
    expect(button(/Notifications/)).toBeUndefined();
    // The center is open under the modal: the raised dock stays at the edge.
    expect(dock()!.style.right).toBe("calc(0px - 1.5rem)");
    // At rest (the modal gone), the doorway and the rail are back.
    await mount(tree(false));
    expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
    expect(dock()!.style.right).toBe("calc(480px - 1.5rem)");
    await act(async () => { button(/Notifications/)!.click(); });
    expect(openCenter).toHaveBeenCalledWith();
  });

  it("an overlay that raises the dock must declare its action row: every useDockRaise caller also calls useDockAvoid", () => {
    const files = ["app", "components", "hooks", "lib"].flatMap((d) => walk(resolve(d)))
      .filter((f) => !f.endsWith("components/ui/CornerDock.tsx"));
    const raisers = files.filter((f) => /useDockRaise\(/.test(readFileSync(f, "utf8")));
    expect(raisers.map((f) => f.replace(resolve(".") + "/", "")).sort()).toEqual([
      "components/assets/AssetPhotoUploader.tsx",
      "components/documents/CustomizeNodeModal.tsx",
      "components/documents/MetadataStagingModal.tsx",
    ]);
    for (const f of raisers) expect(readFileSync(f, "utf8")).toMatch(/useDockAvoid\(/);
    // Never raised on open alone: before any upload the dock belongs under
    // the modal (N7 review — it covered the staging grid's last rows).
    for (const f of raisers) expect(readFileSync(f, "utf8")).not.toMatch(/useDockRaise\(\s*(isOpen|open|true)\s*\)/);
  });
});

describe("STACK-10 — raised, the dock keeps clear of an open modal's action row", () => {
  // Chromium before this fix (bulk-upload wizard, 40 files, 6 uploads):
  // "Upload All" covered at 1280x800 / 1366x768 / 1440x900, "Stop upload"
  // partly covered, and on a phone the pill sat on "Upload All".
  const desk = { viewportW: 1366, viewportH: 768, rail: 0, bottomBar: 0, contentW: 288, contentH: 286 };
  const footer = { left: 107, right: 1259, top: 670, bottom: 730 };

  it("dockAvoidOffset lifts the cards above a row they would cover — just above it, never onto it", () => {
    const off = dockAvoidOffset(desk, [footer]);
    expect(off).toBe(768 - 670 + 8 - 16);
    // The lowest card's bottom edge is 8px above the row.
    expect(desk.viewportH - off - 16).toBe(footer.top - 8);
    // Phone bottom sheet (390x844): the 180x31 pill over its footer.
    expect(dockAvoidOffset({ viewportW: 390, viewportH: 844, rail: 0, bottomBar: 0, contentW: 180, contentH: 31 },
      [{ left: 0, right: 390, top: 790, bottom: 844 }])).toBe(844 - 790 + 8 - 16);
  });

  it("a row the cards would not touch moves nothing: a centred dialog left of them, a row above them, no cards at all", () => {
    expect(dockAvoidOffset(desk, [{ left: 459, right: 907, top: 420, bottom: 480 }])).toBe(0);
    expect(dockAvoidOffset(desk, [{ left: 0, right: 1366, top: 100, bottom: 160 }])).toBe(0);
    expect(dockAvoidOffset({ ...desk, contentW: 0, contentH: 0 }, [footer])).toBe(0);
    // A phone's centred dialog: its footer is mid-screen, the pill at the bottom.
    expect(dockAvoidOffset({ viewportW: 390, viewportH: 844, rail: 0, bottomBar: 0, contentW: 180, contentH: 31 },
      [{ left: 16, right: 374, top: 450, bottom: 510 }])).toBe(0);
    // A row with no room above it for a card: the dock stays (never a sliver).
    expect(dockAvoidOffset({ ...desk, contentH: 760 }, [{ left: 0, right: 1366, top: 40, bottom: 90 }])).toBe(0);
  });

  it("the page bottom bar is the floor, and a lift that lands on a second row settles above both", () => {
    expect(dockAvoidOffset({ ...desk, bottomBar: 120 }, [footer])).toBe(0); // already above it
    const two = [footer, { left: 900, right: 1366, top: 560, bottom: 650 }];
    expect(dockAvoidOffset({ ...desk, contentH: 100 }, two)).toBe(768 - 560 + 8 - 16);
  });

  function mockLayout(footerRect: DOMRect, cards: DOMRect) {
    return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches("[data-dock-slot]") && this.children.length > 0) return cards;
      if (this.matches("[data-dock-summary]")) return cards;
      if (this.matches("[data-test-row]") || this.className.includes("rounded-b-2xl")) return footerRect;
      return rect(0, 0, 0, 0);
    });
  }

  it("a raising modal's ModalFooter declares its row: six upload cards lift the dock above it while the modal is open, and it comes back when it closes", async () => {
    viewport(1366, 768);
    const spy = mockLayout(rect(107, 670, 1259, 730), rect(1062, 466, 1350, 752));
    const modal = (open: boolean) => open
      ? React.createElement(RaisingModalProbe, { key: "m" })
      : null;
    try {
      await mount(shell(modal(true)));
      expect(dock()!.style.bottom).toBe("calc(var(--dock-bottom, 0px) - 1.5rem)"); // nothing to cover yet
      await act(async () => { for (let i = 0; i < 6; i++) upload(`F${i}`); });
      await flush();
      expect(dock()!.getAttribute("data-dock-avoiding")).toBe("1");
      expect(dock()!.style.bottom).toBe("calc(90px - 1.5rem)");
      expect(dock()!.style.maxHeight).toBe("calc(100dvh - 90px + 3rem)");
      expect(Number(dock()!.style.zIndex)).toBe(Z.dockRaised); // above the modal
      await mount(shell(modal(false)));
      expect(dock()!.getAttribute("data-dock-avoiding")).toBeNull();
      expect(dock()!.style.bottom).toBe("calc(var(--dock-bottom, 0px) - 1.5rem)");
      expect(Number(dock()!.style.zIndex)).toBe(Z.dock);
    } finally { spy.mockRestore(); }
  });

  it("a dialog on its own (appConfirm's ModalFooter, no upload modal open) leaves the dock at rest, under it — not lifted", async () => {
    viewport(1366, 768);
    const spy = mockLayout(rect(107, 670, 1259, 730), rect(1062, 466, 1350, 752));
    try {
      await mount(shell(React.createElement(ModalProbe)));
      await act(async () => { for (let i = 0; i < 6; i++) upload(`F${i}`); });
      await flush();
      expect(dock()!.getAttribute("data-dock-raised")).toBeNull();
      expect(dock()!.getAttribute("data-dock-avoiding")).toBeNull();
      expect(dock()!.style.bottom).toBe("calc(var(--dock-bottom, 0px) - 1.5rem)");
      expect(Number(dock()!.style.zIndex)).toBeLessThan(400); // the shared Modal's default layer
    } finally { spy.mockRestore(); }
  });

  it("on a phone the folded pill sits above a bottom sheet's footer instead of on it", async () => {
    viewport(390, 844);
    const spy = mockLayout(rect(0, 790, 390, 844), rect(194, 797, 374, 828));
    try {
      await onPhone(async () => {
        await mount(shell(React.createElement(AvoidProbe)));
        await act(async () => { toastApi({ type: "error", title: "Server unreachable", duration: 0 }); upload("S1"); upload("S2"); });
        await flush();
        const pill = dock()!.querySelector("[data-dock-summary]")!;
        expect(pill).not.toBeNull();
        // Raised for the upload, the pill speaks for it — not for the toast
        // waiting behind it (at rest an error would lead).
        expect(pill.getAttribute("aria-label")).toBe("Uploading 2 files — 3 updates, show");
        expect(dock()!.style.bottom).toBe(`calc(${844 - 790 + 8 - 16}px - 1.5rem)`);
      });
    } finally { spy.mockRestore(); }
  });

  it("the three upload-starting modals raise the dock and declare their action rows, and the shared ModalFooter declares its row", () => {
    const src = (p: string) => readFileSync(resolve(p), "utf8");
    const staging = src("components/documents/MetadataStagingModal.tsx");
    expect(staging).toContain("useDockRaise(isOpen && startedUpload);");
    // Latched when Upload All starts a run, cleared by every open.
    expect(staging).toMatch(/setSubmitting\(true\);\s*setStopping\(false\);\s*setStartedUpload\(true\);/);
    expect(staging).toMatch(/setSubmitting\(false\);\s*setStopping\(false\);\s*setStartedUpload\(false\);\s*\/\/ SECOND PASS/);
    expect(src("components/assets/AssetPhotoUploader.tsx")).toContain('useDockRaise(isOpen && (submitting || pending.some((p) => p.status !== "pending")));');
    const coverSrc = src("components/documents/CustomizeNodeModal.tsx");
    expect(coverSrc).toContain("useDockRaise(open && startedUpload);");
    expect(coverSrc.match(/setStartedUpload\(true\);\s*set(Bg)?Uploading\(true\);/g)).toHaveLength(2);
    expect(src("components/providers/UploadIndicator.tsx")).toContain("{ raisable: true });");
    expect(src("components/ui/Modal.tsx")).not.toContain("useDockRaise");
    expect(staging).toContain("useDockAvoid(footerRef, isOpen);");
    expect(staging).toMatch(/<div ref=\{footerRef\}[^>]*>\s*<div className="text-\[11px\][^"]*">\s*\{items\.length\} file/);
    const asset = src("components/assets/AssetPhotoUploader.tsx");
    expect(asset).toContain("useDockAvoid(footerRef, isOpen);");
    expect(asset).toContain("<div ref={footerRef}");
    const cover = src("components/documents/CustomizeNodeModal.tsx");
    expect(cover).toContain("useDockAvoid(footerRef, open);");
    expect(cover).toContain("<div ref={footerRef}");
    const modal = src("components/ui/Modal.tsx");
    const foot = modal.slice(modal.indexOf("export function ModalFooter"));
    expect(foot).toContain("useDockAvoid(ref, true);");
    expect(foot).toContain("ref={ref}");
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

  it("through the centre dock, Undo and Dismiss on an undo toast and the 'Back to graph' chip still work", async () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    const t = { id: 7, message: "Moved 3 tasks", tone: "success", undo: () => {} };
    await mount(React.createElement(React.Fragment, null,
      React.createElement(CentreDock),
      React.createElement(BackToGraphChip),
      React.createElement(UndoToastHost as unknown as React.FC<Record<string, unknown>>, { toasts: [t], onUndo, onDismiss }),
    ));
    const toastSlot = document.querySelector('[data-centre-slot="toasts"]') as HTMLElement;
    const chipSlot = document.querySelector('[data-centre-slot="chip"]') as HTMLElement;
    // Rendered through CentrePortal, inside the slots — not a fallback box.
    expect(host.textContent).toBe("");
    const undo = [...toastSlot.querySelectorAll("button")].find((b) => /Undo/.test(b.textContent ?? ""))!;
    expect(undo).toBeTruthy();
    await act(async () => { undo.click(); });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledWith(t);
    await act(async () => { (toastSlot.querySelector('button[aria-label="Dismiss"]') as HTMLElement).click(); });
    expect(onDismiss).toHaveBeenCalledWith(7);
    const chip = [...chipSlot.querySelectorAll("button")].find((b) => /Back to graph/.test(b.textContent ?? ""))!;
    await act(async () => { chip.click(); });
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith("/graph");
    // Each clickable sits in a pointer-events-auto box inside the slot's
    // pointer-events-none column.
    expect(undo.closest(".pointer-events-auto")).not.toBeNull();
    expect(chip.className).toContain("pointer-events-auto");
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
    const patterns = [/(?<![\w-])z-\[(\d+)\]/g, /(?<![\w[-])z-(\d+)(?![\w\]])/g, /zIndex\s*[=:]\s*\{?\s*(\d+)/g, /zIndex:\s*\w+\s*\?\s*(\d+)\s*:\s*(\d+)/g, /z-index:\s*(\d+)/g];
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
    // A stylesheet's `z-index:` is read too (the print cover in globals.css).
    expect(found.get(9999) ?? []).toContain("app/globals.css");
  });

  it("at rest the dock is under every overlay from the 300 band up and over everything below it — the old dock's place", () => {
    // The old dock was z-[300], first in <main>: every 300-band overlay after
    // it (and every one above) painted over it; everything under 300 did not.
    // So the dock must be the only layer between the undo toasts and the
    // 300 band: a 291-299 overlay would sit over the resting dock and under
    // the old one (N7 fourth review — the old assertions here could not
    // fail). Every value in use and every value the scale lists is read.
    const values = [...new Set([...found.keys(), ...Z_SCALE])].filter((n) => n !== Z.dock && n !== Z.dockRaised);
    expect(values.filter((n) => n > Z.undoToast && n < 300)).toEqual([]);
    expect(values.every((n) => n <= Z.undoToast || n >= 300)).toBe(true);
    expect(values).toContain(300);
    expect(values).toContain(Z.undoToast);
    expect(Z.dock).toBeGreaterThan(Z.undoToast);
    expect(Z.dock).toBeLessThan(Z.metadataStagingModal);
    // No literal claims the resting band: nothing ties with the dock.
    expect(found.get(Z.dock) ?? []).toEqual([]);
  });

  it("raised, the dock is strictly above every modal, backdrop and dialog band, and below only the hover preview and print", () => {
    const above = [...found.keys()].filter((n) => n >= Z.dockRaised);
    expect(above.sort((a, b) => a - b)).toEqual([Z.hoverPreview, Z.print]);
    expect(Z.dockRaised).toBeGreaterThan(Z.dialog);
    expect(Z.dockRaised).toBeGreaterThan(Z.assetPhotoUploader);
    expect(Z.dockRaised).toBeGreaterThan(Z.customizeNodeModal);
    expect(Z.dockRaised).toBeGreaterThan(Z.metadataStagingModal);
    expect(Z.hoverPreview).toBeGreaterThan(Z.dockRaised);
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
    const order = [Z.pageChip, 60 /* InspectorDrawer */, 70 /* HistoryDrawer */, 241 /* NotificationCenter */, Z.undoToast, Z.dock,
      Z.metadataStagingModal, Z.customizeNodeModal, Z.assetPhotoUploader, Z.dialog, Z.dockRaised, Z.hoverPreview, Z.print];
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
