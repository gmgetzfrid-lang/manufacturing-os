"use client";

// CornerDock — ONE bottom-right corner for every floating surface.
//
// Toasts, the upload indicator, the knowledge-index card and the backup card
// each used to pin themselves to `fixed bottom right` (or left) independently,
// so they rendered on top of each other and whichever mounted last won. The
// dock is a single fixed column; widgets portal their cards into it and stack
// with a gap instead of overlapping.
//
// The contract (notifications Round G, N7 CORNER — report 06 + RT-11/OS-4):
//
//   - Two slots. `jobs` (backup, knowledge indexing, uploads) is pinned
//     nearest the corner; `transient` (toasts) stacks above it. Inside a slot
//     a widget's place is its explicit `priority` (lower = nearer the
//     corner), never the order it happened to mount in (STACK-9).
//   - A visible cap. At most DOCK_VISIBLE_CAP cards show at once, jobs first
//     (one place is kept for messages while any are waiting); the rest
//     collapse into one "+N more" card that expands the dock in place, and —
//     when messages are among them — opens the notification center. A widget
//     asks how many of its cards it may show with `useDockAllowance` (RT-11,
//     OS-4, STACK-9). The column is height-bounded and scrolls, so nothing
//     can ever render above the viewport.
//   - Its own layer, two bands (lib/zLayers.ts). The dock is portaled to
//     document.body. At rest it sits at `Z.dock`, where the old dock sat:
//     over the page and its drawers, under every modal, drawer-overlay and
//     dialog from the 300 band up — so no overlay gets a card over its own
//     buttons. A modal that starts an upload raises it with `useDockRaise`
//     while open: the dock then sits at `Z.dockRaised`, above every modal,
//     backdrop and dialog, so that modal no longer paints over the cards
//     reporting its upload (STACK-10, STACK-14).
//   - It moves out of the way. A page's bottom bar declares its height in
//     `--dock-bottom` and the dock sits above it; a full-height right-edge
//     drawer declares its width with `useOccupyRightRail` and the dock moves
//     left of it when there is room (STACK-7, STACK-11). While raised, the
//     dock's cards take clicks over modals, so a raising modal declares its
//     action row with `useDockAvoid` (as does the shared `ModalFooter`, for
//     a dialog opened over it), and while the dock's cards would cover that
//     row the dock sits above it — the modal that starts an upload keeps its
//     own "Upload All" / "Stop upload" reachable (STACK-10).
//   - On a phone it is one pill. Below the `sm` breakpoint the dock collapses
//     to a single summary pill that expands on tap (STACK-7). The pill names
//     the most urgent card (and says it to a screen reader); while it is
//     folded, toasts and finished upload cards still expire on their own
//     time, so a "Saved" toast does not become a pill that never leaves.
//   - No duplicate corner. A widget finds the dock through this module's
//     store, so a widget that mounted before the dock (the toast provider
//     sits outside the auth gate) moves into it the moment it appears; the
//     fallback corner renders only after a tick confirms there is no dock
//     at all (STACK-5).
//
// CornerPortal degrades gracefully: on pages where the dock isn't mounted
// (public routes), it falls back to its own fixed positioning, so a widget
// never disappears just because the shell isn't there.

import React, { useEffect, useId, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, Loader2, AlertCircle, Bell, CheckCircle2 } from "lucide-react";
import { Z } from "@/lib/zLayers";

const DOCK_ID = "corner-dock";
const CENTRE_DOCK_ID = "centre-dock";

/** Cards visible at once — toasts and job cards together. */
export const DOCK_VISIBLE_CAP = 4;
/** Narrower than this and a right-rail drawer leaves no room beside it: the
 *  dock stays at the edge (over the drawer) instead of being pushed off. */
export const DOCK_MIN_ROOM_PX = 340;
/** The phone breakpoint (Tailwind `sm` is 640px). */
export const DOCK_MOBILE_QUERY = "(max-width: 639px)";

export type DockSlot = "jobs" | "transient";
export type DockTone = "busy" | "error" | "ok" | "info";
export interface DockSummary { label: string; tone: DockTone }

/** Job priorities — lower sits nearer the corner. */
export const DOCK_PRIORITY = { backup: 10, knowledge: 20, upload: 30, toast: 10 } as const;

interface Entry {
  slot: DockSlot;
  priority: number;
  count: number;
  seq: number;
  summary: DockSummary | null;
  touched: number;
}

export interface DockEntryInput {
  id: string;
  slot: DockSlot;
  priority: number;
  count: number;
  seq: number;
}

export interface DockAllocation {
  visible: Record<string, number>;
  hidden: number;
  /** How many of the hidden cards are messages (the transient slot). */
  hiddenTransient: number;
  total: number;
}

/**
 * Who gets the visible places. Jobs first (by priority, then arrival), then
 * messages; while any message is waiting one place is kept for it, so a
 * 40-file upload cannot hide every error toast. Pure — pinned by tests.
 */
export function allocateDock(entries: DockEntryInput[], cap: number): DockAllocation {
  const order = (a: DockEntryInput, b: DockEntryInput) => a.priority - b.priority || a.seq - b.seq;
  const jobs = entries.filter((e) => e.slot === "jobs" && e.count > 0).sort(order);
  const transient = entries.filter((e) => e.slot === "transient" && e.count > 0).sort(order);
  const transientTotal = transient.reduce((n, e) => n + e.count, 0);
  const total = transientTotal + jobs.reduce((n, e) => n + e.count, 0);
  const visible: Record<string, number> = {};
  for (const e of entries) visible[e.id] = 0;
  let left = Math.max(0, cap);
  let jobsLeft = Math.max(0, left - (transientTotal > 0 ? 1 : 0));
  for (const e of jobs) {
    const n = Math.min(e.count, jobsLeft);
    visible[e.id] = n;
    jobsLeft -= n;
    left -= n;
  }
  let hiddenTransient = 0;
  for (const e of transient) {
    const n = Math.min(e.count, left);
    visible[e.id] = n;
    left -= n;
    hiddenTransient += e.count - n;
  }
  const shown = Object.values(visible).reduce((n, v) => n + v, 0);
  return { visible, hidden: total - shown, hiddenTransient, total };
}

// ── The store ───────────────────────────────────────────────────────────────
// Module level, so a widget mounted anywhere (the toast provider wraps the
// auth gate; the dock lives inside it) shares one truth.

const entries = new Map<string, Entry>();
const targets: Record<DockSlot, HTMLElement | null> = { jobs: null, transient: null };
const centreTargets: Record<CentreSlot, HTMLElement | null> = { chip: null, toasts: null };
const centreCounts = new Map<string, { slot: CentreSlot; count: number }>();
const rails = new Map<string, number>();
const listeners = new Set<() => void>();
let seq = 0;
let touch = 0;
let version = 0;
let docks = 0;
let expanded = false;
let mobileOpen = false;
/** The fewest cards the expanded column has held since it was opened. */
let expandedFloor = 0;
let cache: { version: number; mobile: boolean; alloc: DockAllocation; timed: DockAllocation } | null = null;
/** The same, for a widget whose live count the store does not hold yet. */
let ownCache: { version: number; mobile: boolean; byKey: Map<string, { alloc: DockAllocation; timed: DockAllocation }> } | null = null;
/** Declared modal action rows the dock keeps clear of, by registration. */
const avoids = new Map<string, DockAvoidRect>();
/** Open modals that start uploads the dock reports (`useDockRaise`). */
const raises = new Set<string>();
/** The dock's own cards, measured: their union's width and natural height. */
let dockContent = { w: 0, h: 0 };
/** The page bottom bar's height (`useDockBottomInset`), in px. */
let bottomBarPx = 0;

function emit() {
  version++;
  for (const l of listeners) {
    try { l(); } catch { /* a bad listener must not break the dock */ }
  }
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function isMobile(): boolean {
  try { return typeof window !== "undefined" && !!window.matchMedia?.(DOCK_MOBILE_QUERY).matches; }
  catch { return false; }
}

function storeList(): DockEntryInput[] {
  return [...entries].map(([id, e]) => ({ id, slot: e.slot, priority: e.priority, count: e.count, seq: e.seq }));
}

function allocations(): { alloc: DockAllocation; timed: DockAllocation } {
  const mobile = isMobile();
  if (cache && cache.version === version && cache.mobile === mobile) return cache;
  cache = { version, mobile, ...computeAllocations(storeList(), mobile) };
  return cache;
}

function computeAllocations(list: DockEntryInput[], mobile: boolean): { alloc: DockAllocation; timed: DockAllocation } {
  let alloc = allocateDock(list, DOCK_VISIBLE_CAP);
  if (expanded) {
    alloc = { ...alloc, visible: Object.fromEntries(list.map((e) => [e.id, e.count])), hidden: 0, hiddenTransient: 0 };
  }
  // The places whose cards run their auto-dismiss clocks: the visible stack —
  // and, while a phone folds the stack into its pill, the places the stack
  // WOULD show. A folded card is not collapsed behind "+N more"; it is shown
  // in summary, and it expires on its own time as it would on a desktop.
  const timed = alloc;
  if (!expanded && mobile && !mobileOpen) {
    // Collapsed to the summary pill: no card renders.
    alloc = { visible: Object.fromEntries(list.map((e) => [e.id, 0])), hidden: alloc.total, hiddenTransient: 0, total: alloc.total };
  }
  return { alloc, timed };
}
function allocation(): DockAllocation { return allocations().alloc; }

/**
 * A widget's places, for the count it renders with NOW. A widget registers
 * its count in a layout effect, after the render that asks — so for the
 * first render after a new card the store still holds the old count. Asking
 * the store then would give n places to n+1 cards: the oldest card would
 * drop out for one commit and come back as a new node, replaying its
 * entrance and restarting its clock (N7 review). The widget's own entry is
 * answered with its live count instead; every other entry as the store has
 * it.
 */
function allowanceFor(id: string, slot: DockSlot, priority: number, count: number, which: "alloc" | "timed" = "alloc"): number {
  if (docks === 0) return count; // no dock (public page): the old behaviour
  const e = entries.get(id);
  if (e && e.count === count) return allocations()[which].visible[id] ?? 0;
  const mobile = isMobile();
  if (!ownCache || ownCache.version !== version || ownCache.mobile !== mobile) ownCache = { version, mobile, byKey: new Map() };
  const key = `${id}\u0000${count}`;
  let mine = ownCache.byKey.get(key);
  if (!mine) {
    const list = storeList().filter((x) => x.id !== id);
    list.push({ id, slot: e?.slot ?? slot, priority: e?.priority ?? priority, count, seq: e?.seq ?? seq + 1 });
    mine = computeAllocations(list, mobile);
    ownCache.byKey.set(key, mine);
  }
  return mine[which].visible[id] ?? 0;
}

function setExpanded(v: boolean) {
  expanded = v;
  expandedFloor = v ? allocation().total : 0;
  emit();
}
function setMobileOpen(v: boolean) { mobileOpen = v; emit(); }

// Stable ref callbacks (an inline ref would detach and re-attach on every
// render, and each attach notifies the store).
const setTransientTarget = (el: HTMLElement | null) => { if (targets.transient !== el) { targets.transient = el; emit(); } };
const setJobsTarget = (el: HTMLElement | null) => { if (targets.jobs !== el) { targets.jobs = el; emit(); } };
const setChipTarget = (el: HTMLElement | null) => { if (centreTargets.chip !== el) { centreTargets.chip = el; emit(); } };
const setCentreToastsTarget = (el: HTMLElement | null) => { if (centreTargets.toasts !== el) { centreTargets.toasts = el; emit(); } };

/** Test seam: forget every registration (jsdom tests share the module). */
export function __resetDockForTests() {
  entries.clear(); rails.clear(); centreCounts.clear(); avoids.clear(); raises.clear();
  targets.jobs = targets.transient = null;
  centreTargets.chip = centreTargets.toasts = null;
  docks = 0; expanded = false; expandedFloor = 0; mobileOpen = false; cache = null; ownCache = null;
  dockContent = { w: 0, h: 0 }; bottomBarPx = 0;
  emit();
}

/**
 * How many of this widget's `count` cards may show right now. Register the
 * widget's slot and priority; the answer changes as other widgets come and
 * go, as the "+N more" card is expanded, and on a phone. With no dock
 * mounted it is always `count`.
 */
export function useDockAllowance(slot: DockSlot, priority: number, count: number, summary?: DockSummary | null): number {
  return useDockAllowances(slot, priority, count, summary).shown;
}

/**
 * `useDockAllowance` for a widget whose cards expire on a timer: `shown` is
 * how many cards render; `timed` is how many run their auto-dismiss clocks.
 * They differ only while a phone folds the stack into its summary pill —
 * nothing renders, but the cards the stack would show still expire on time.
 */
export function useDockAllowances(slot: DockSlot, priority: number, count: number, summary?: DockSummary | null): { shown: number; timed: number } {
  const id = useId();
  const label = summary?.label ?? null;
  const tone = summary?.tone ?? null;
  useLayoutEffect(() => {
    const prev = entries.get(id);
    const nextSummary = label !== null && tone !== null ? { label, tone } : null;
    const changed = !prev || prev.count !== count || prev.summary?.label !== nextSummary?.label || prev.summary?.tone !== nextSummary?.tone;
    entries.set(id, {
      slot, priority, count,
      seq: prev?.seq ?? ++seq,
      summary: nextSummary,
      touched: changed ? ++touch : prev!.touched,
    });
    if (!prev || prev.slot !== slot || prev.priority !== priority || changed) emit();
  }, [id, slot, priority, count, label, tone]);
  useLayoutEffect(() => () => { entries.delete(id); emit(); }, [id]);
  const shown = useSyncExternalStore(subscribe, () => allowanceFor(id, slot, priority, count), () => count);
  const timed = useSyncExternalStore(subscribe, () => allowanceFor(id, slot, priority, count, "timed"), () => count);
  return { shown, timed };
}

/** Render children into the dock's slot (stacked by `priority`), or fall
 *  back to a fixed corner of their own when no dock exists on this page. */
export function CornerPortal({ children, slot = "transient", priority = 50 }: {
  children: React.ReactNode;
  slot?: DockSlot;
  priority?: number;
}) {
  const target = useSyncExternalStore(subscribe, () => targets[slot], () => null);
  // STACK-5: nothing on the first frame. The fallback appears only once a
  // tick has confirmed that no dock is mounted — so a widget never paints a
  // duplicate corner while the dock is a frame away, and one that mounted
  // before the dock (behind the auth gate) moves into it when it arrives.
  const [noDock, setNoDock] = useState(false);
  useEffect(() => {
    if (target) return;
    const t = setTimeout(() => setNoDock(true), 0);
    return () => clearTimeout(t);
  }, [target]);
  if (target) {
    return createPortal(
      <div data-dock-item={slot} style={{ order: priority }} className="flex flex-col items-end gap-2">{children}</div>,
      target,
    );
  }
  if (!noDock) return null;
  return (
    <div className="fixed bottom-4 right-4 flex flex-col items-end gap-2 pointer-events-none" style={{ zIndex: Z.dock }}>
      {children}
    </div>
  );
}

// ── Page bottom bars (STACK-7) ──────────────────────────────────────────────

/** The CSS variable a page's fixed bottom bar sets to its height; both docks
 *  sit above it. */
export const DOCK_BOTTOM_VAR = "--dock-bottom";

/** While `active`, declare `ref`'s element as a bottom bar the docks must
 *  clear: its height (kept current) goes into `--dock-bottom` on :root. */
export function useDockBottomInset(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      root.style.setProperty(DOCK_BOTTOM_VAR, `${h}px`);
      // The dock's modal-row check needs the same number (useDockAvoid).
      if (bottomBarPx !== h) { bottomBarPx = h; emit(); }
    };
    apply();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty(DOCK_BOTTOM_VAR);
      if (bottomBarPx !== 0) { bottomBarPx = 0; emit(); }
    };
  }, [ref, active]);
}

// ── Raised over an upload modal, clear of its action row (STACK-10) ─────────
// At rest the dock is under every overlay from the 300 band up (Z.dock), as
// the old dock was: a drawer, a modal or a dialog keeps every one of its
// controls, whatever the dock holds (STACK-14 — above them, a card that
// cannot be dismissed covered the asset editor's Save for a whole upload).
// A modal that starts an upload raises the dock above itself while it is
// open (`useDockRaise`), so the cards reporting that upload are not painted
// over. Raised, its cards, its "+N more" and its phone pill take clicks over
// modals; on a modal whose action row reaches the bottom-right corner — the
// bulk-upload wizard's footer on a laptop, any bottom sheet on a phone —
// they would sit on the very controls that run the upload ("Upload All",
// "Stop upload"). So a raising modal declares its action row
// (`useDockAvoid`), as does the shared `ModalFooter` (every confirm, alert
// and prompt — the dialogs that can open over a raising modal), and while
// the dock is raised and its cards, where they sit now, would overlap a
// declared row, the dock sits above the row instead. The rest of the modal
// stays as before: the cards report over it, readable.

/**
 * While `active`, this overlay starts uploads the dock reports: the dock
 * rises to `Z.dockRaised`, above every modal, until it closes. An overlay
 * that raises the dock must also declare its action row with `useDockAvoid`
 * (lib/__tests__/cornerDock.test.ts refuses one that does not).
 */
export function useDockRaise(active: boolean) {
  const id = useId();
  useLayoutEffect(() => {
    if (!active) return;
    raises.add(id);
    emit();
    return () => { raises.delete(id); emit(); };
  }, [id, active]);
}

function raisedSnapshot(): boolean { return raises.size > 0; }

/** A declared row, in viewport px. */
export interface DockAvoidRect { top: number; bottom: number; left: number; right: number }
/** What the dock's position depends on, in px. */
export interface DockGeometry {
  viewportW: number;
  viewportH: number;
  /** The right rail the dock already moves left of (STACK-11). */
  rail: number;
  /** The page bottom bar's height (STACK-7). */
  bottomBar: number;
  /** The dock's cards: the width and the natural height of their union. */
  contentW: number;
  contentH: number;
}
/** The cards' inset from the viewport's (or the rail's) edge: bottom-4 / right-4. */
export const DOCK_INSET_PX = 16;
/** The gap kept between a declared row and the dock's lowest card. */
export const DOCK_AVOID_GAP_PX = 8;
/** With less room than this above a row the dock cannot sit there; it stays. */
export const DOCK_AVOID_MIN_ROOM_PX = 72;

/**
 * The dock's bottom offset (what `--dock-bottom` would be) so its cards clear
 * every declared row they would otherwise overlap — or 0 when none is in the
 * way and the dock stays where it is. A row elsewhere on the screen (a
 * centred dialog's footer on a desktop, left of the cards) moves nothing.
 * Pure — pinned by tests.
 */
export function dockAvoidOffset(g: DockGeometry, rows: DockAvoidRect[]): number {
  if (g.contentW <= 0 || g.contentH <= 0) return 0;
  const right = g.viewportW - g.rail - DOCK_INSET_PX;
  const left = right - g.contentW;
  let offset = g.bottomBar;
  let moved = false;
  // A lift can bring the cards onto another row higher up: settle, bounded.
  for (let pass = 0; pass <= rows.length; pass++) {
    const bottom = g.viewportH - offset - DOCK_INSET_PX;
    const top = bottom - g.contentH;
    let need = offset;
    for (const r of rows) {
      if (r.right - r.left <= 0 || r.bottom - r.top <= 0) continue;
      if (!(r.left < right && r.right > left && r.top < bottom && r.bottom > top)) continue;
      if (r.top - DOCK_AVOID_GAP_PX < DOCK_AVOID_MIN_ROOM_PX) continue;
      need = Math.max(need, Math.ceil(g.viewportH - r.top + DOCK_AVOID_GAP_PX - DOCK_INSET_PX));
    }
    if (need === offset) break;
    offset = need;
    moved = true;
  }
  return moved ? offset : 0;
}

/**
 * While `active`, declare `ref`'s element as a modal action row the dock's
 * cards must not cover (STACK-10). Its rect is kept current: on resize, on
 * any scroll (a scrolling overlay moves its modal), when the row or its
 * panel changes size, and when an entrance animation settles.
 */
export function useDockAvoid(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  const id = useId();
  useLayoutEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next = { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
      const prev = avoids.get(id);
      if (!prev || prev.top !== next.top || prev.bottom !== next.bottom || prev.left !== next.left || prev.right !== next.right) {
        avoids.set(id, next);
        emit();
      }
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    if (el.parentElement) ro?.observe(el.parentElement);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    document.addEventListener("animationend", measure, true);
    document.addEventListener("transitionend", measure, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      document.removeEventListener("animationend", measure, true);
      document.removeEventListener("transitionend", measure, true);
      avoids.delete(id);
      emit();
    };
  }, [id, active, ref]);
}

function avoidSnapshot(): number {
  // At rest the dock is under every declared overlay: nothing to keep clear of.
  if (avoids.size === 0 || raises.size === 0 || typeof window === "undefined") return 0;
  return dockAvoidOffset({
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    rail: railSnapshot(),
    bottomBar: bottomBarPx,
    contentW: dockContent.w,
    contentH: dockContent.h,
  }, [...avoids.values()]);
}

/** Measure the dock's cards (the union of its children's rects) — their
 *  natural size: a clamped, scrolling column still reports every card. */
function measureDockContent(box: HTMLElement) {
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
  for (const c of Array.from(box.children)) {
    if (c.hasAttribute("data-dock-announce")) continue; // visually hidden
    const rect = c.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    l = Math.min(l, rect.left); r = Math.max(r, rect.right);
    t = Math.min(t, rect.top); b = Math.max(b, rect.bottom);
  }
  const next = r > l && b > t ? { w: Math.round(r - l), h: Math.round(b - t) } : { w: 0, h: 0 };
  if (next.w !== dockContent.w || next.h !== dockContent.h) { dockContent = next; emit(); }
}

// ── Right rail (STACK-11) ───────────────────────────────────────────────────

/**
 * A full-height right-edge drawer declares the width it occupies while open;
 * the dock moves to its left when the viewport leaves room for a card.
 */
export function useOccupyRightRail(ref: React.RefObject<HTMLElement | null>, open: boolean) {
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (rails.get(id) !== w) { rails.set(id, w); emit(); }
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      rails.delete(id);
      emit();
    };
  }, [id, open, ref]);
}

/** The notification center's panel width — `w-[480px]` at
 *  components/notifications/NotificationCenter.tsx (another package's file:
 *  the layout passes its open state instead of the panel declaring the rail
 *  itself; lib/__tests__/cornerDock.test.ts pins the number to that class). */
export const NOTIFICATION_CENTER_RAIL_PX = 480;
const PROP_RAIL_ID = "corner-dock:prop";

/** The dock's right offset (px) for the drawers open now. */
export function rightRailOffset(viewportWidth: number, widths: number[]): number {
  const w = widths.length ? Math.max(...widths) : 0;
  return w > 0 && viewportWidth - w >= DOCK_MIN_ROOM_PX ? w : 0;
}

function railSnapshot(): number {
  return rightRailOffset(typeof window === "undefined" ? 0 : window.innerWidth, [...rails.values()]);
}

function subscribeClient() { return () => {}; }

// ── The dock ────────────────────────────────────────────────────────────────

/** The pill a phone shows instead of the stack: the most urgent card's
 *  summary — an error first, then a running job, then the newest. */
export function pickSummary(list: Array<{ summary: DockSummary | null; touched: number; count: number }>): DockSummary | null {
  return pickSummaryEntry(list)?.summary ?? null;
}
function pickSummaryEntry<T extends { summary: DockSummary | null; touched: number; count: number }>(list: T[]): T | null {
  const live = list.filter((e) => e.count > 0 && e.summary);
  const byNewest = (a: { touched: number }, b: { touched: number }) => b.touched - a.touched;
  return live.filter((e) => e.summary!.tone === "error").sort(byNewest)[0]
    ?? live.filter((e) => e.summary!.tone === "busy").sort(byNewest)[0]
    ?? live.sort(byNewest)[0]
    ?? null;
}

/** The phone pill's accessible name: what the pill shows, then the count.
 *  The visible summary (an error first) is never replaced by a bare count. */
export function pillLabel(summary: DockSummary | null, total: number): string {
  return `${summary?.label ?? "Updates"} — ${total} update${total === 1 ? "" : "s"}, show`;
}

/** The shared target. Mount ONCE, in the protected layout. `onOpenCenter`
 *  opens the notification center from the "+N more" card; `occupiedRightPx`
 *  is a right rail the layout knows about (the open notification center). */
export interface CornerDockProps { onOpenCenter?: () => void; occupiedRightPx?: number }
export function CornerDock({ onOpenCenter, occupiedRightPx = 0 }: CornerDockProps) {
  const client = useSyncExternalStore(subscribeClient, () => true, () => false);
  const alloc = useSyncExternalStore(subscribe, allocation, allocation);
  const rail = useSyncExternalStore(subscribe, railSnapshot, () => 0);
  // Raised over a modal that starts an upload; at rest under every overlay.
  const raised = useSyncExternalStore(subscribe, raisedSnapshot, () => false);
  // Raised: above a declared modal action row when the cards would cover it.
  const avoidOffset = useSyncExternalStore(subscribe, avoidSnapshot, () => 0);
  const boxRef = React.useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    docks++;
    emit();
    // Crossing the phone breakpoint re-allocates every widget's allowance.
    let mql: MediaQueryList | null = null;
    try { mql = window.matchMedia?.(DOCK_MOBILE_QUERY) ?? null; } catch { mql = null; }
    const onChange = () => emit();
    mql?.addEventListener?.("change", onChange);
    // The viewport's size moves the modal-row check (and the rail's room).
    window.addEventListener("resize", onChange);
    return () => {
      mql?.removeEventListener?.("change", onChange);
      window.removeEventListener("resize", onChange);
      docks--;
      emit();
    };
  }, []);
  // The cards' size, for the modal-row check: after every render of the dock
  // (cards come and go through the store) and whenever a slot's content
  // changes size on its own (a toast's text wrapping, a card expanding).
  useLayoutEffect(() => {
    if (boxRef.current) measureDockContent(boxRef.current);
  });
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureDockContent(box));
    ro.observe(box);
    for (const c of Array.from(box.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [client]);
  useLayoutEffect(() => {
    if (occupiedRightPx > 0) rails.set(PROP_RAIL_ID, occupiedRightPx);
    else rails.delete(PROP_RAIL_ID);
    emit();
    return () => { rails.delete(PROP_RAIL_ID); emit(); };
  }, [occupiedRightPx]);
  // Fold the expander back once it is no longer what the person asked to
  // see: when nothing would be hidden any more (the cap holds them all), or
  // when a burst bigger than the cap arrived after it was opened — the cap
  // applies to that burst, not "everything, for as long as anything is
  // docked" (a long indexing card kept one click's expansion on for hours).
  // With nothing left at all, the phone stack folds too.
  useEffect(() => {
    if (expanded) expandedFloor = Math.min(expandedFloor, alloc.total);
    const foldExpanded = expanded && (alloc.total <= DOCK_VISIBLE_CAP || alloc.total - expandedFloor > DOCK_VISIBLE_CAP);
    const foldMobile = mobileOpen && alloc.total === 0;
    if (foldExpanded || foldMobile) {
      const t = setTimeout(() => {
        if (foldExpanded) { expanded = false; expandedFloor = 0; }
        if (foldMobile) mobileOpen = false;
        emit();
      }, 0);
      return () => clearTimeout(t);
    }
  }, [alloc.total]);

  if (!client) return null;
  // Read at render: every crossing of the breakpoint emits, and a new
  // allocation re-renders the dock.
  const mobile = isMobile();
  const collapsed = mobile && !mobileOpen && alloc.total > 0;
  const summaryEntry = collapsed ? pickSummaryEntry([...entries.values()]) : null;
  const summary = summaryEntry?.summary ?? null;
  const showMore = !collapsed && (alloc.hidden > 0 || (expanded && alloc.total > DOCK_VISIBLE_CAP));
  const lifted = avoidOffset > 0;

  return createPortal(
    <div
      ref={boxRef}
      id={DOCK_ID}
      data-dock-raised={raised ? "1" : undefined}
      data-dock-avoiding={lifted ? "1" : undefined}
      role="region"
      aria-label="Background activity and messages"
      aria-live="polite"
      aria-relevant="additions"
      className="fixed flex flex-col-reverse items-end gap-2 pointer-events-none overflow-y-auto overscroll-contain p-10"
      style={{
        // The column scrolls (it can never grow past the viewport), and a
        // scroll box clips what it holds — so the box reaches 1.5rem past
        // the viewport edges and carries 2.5rem of padding: the cards still
        // sit at the old bottom-4 / right-4 inset, and their shadows fall
        // inside the box instead of being cut off at its edge.
        // Lifted above a modal's action row, the offset takes the place of
        // the page bottom bar's (it is never lower than it). The layer:
        // under every overlay at rest; above every modal while one that
        // starts an upload is open.
        zIndex: raised ? Z.dockRaised : Z.dock,
        right: `calc(${rail}px - 1.5rem)`,
        bottom: lifted ? `calc(${avoidOffset}px - 1.5rem)` : "calc(var(--dock-bottom, 0px) - 1.5rem)",
        maxHeight: lifted ? `calc(100dvh - ${avoidOffset}px + 3rem)` : "calc(100dvh - var(--dock-bottom, 0px) + 3rem)",
        maxWidth: "calc(100vw + 3rem)",
      }}
    >
      {/* column-reverse: the first child sits at the bottom (nearest the
          corner) and an expanded, overflowing column stays anchored there,
          scrolling upward. */}
      <div
        ref={setJobsTarget}
        data-dock-slot="jobs"
        className="flex flex-col-reverse items-end gap-2 empty:hidden"
      />
      <div
        ref={setTransientTarget}
        data-dock-slot="transient"
        className="flex flex-col-reverse items-end gap-2 empty:hidden"
      />
      {showMore && (
        <div
          data-dock-more
          className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-lg px-1 py-1 text-[11px] font-black"
        >
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 hover:bg-[var(--color-surface-2)]"
            aria-expanded={expanded}
          >
            {expanded
              ? <><ChevronDown className="w-3 h-3" /> Show fewer</>
              : <><ChevronUp className="w-3 h-3" /> +{alloc.hidden} more</>}
          </button>
          {!expanded && alloc.hiddenTransient > 0 && onOpenCenter && (
            <button
              type="button"
              // No argument: the center's open(filter?) must never receive
              // the click event as its filter.
              onClick={() => onOpenCenter()}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <Bell className="w-3 h-3" /> Notifications
            </button>
          )}
        </div>
      )}
      {mobile && mobileOpen && alloc.total > 0 && (
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] shadow px-2.5 py-1 text-[10px] font-black"
        >
          <ChevronDown className="w-3 h-3" /> Hide
        </button>
      )}
      {collapsed && (
        <button
          type="button"
          data-dock-summary
          onClick={() => setMobileOpen(true)}
          className="pointer-events-auto inline-flex items-center gap-1.5 max-w-[calc(100vw-2rem)] rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-lg px-3 py-1.5 text-[11px] font-black"
          aria-label={pillLabel(summary, alloc.total)}
        >
          {summary?.tone === "busy"
            ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-accent)] shrink-0" />
            : summary?.tone === "error"
              ? <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
              : summary?.tone === "ok"
                ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                : <Bell className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />}
          <span className="truncate">{summary?.label ?? "Updates"}</span>
          {alloc.total > 1 && (
            <span className="shrink-0 rounded-full bg-[var(--color-surface-2)] px-1.5 text-[10px]">{alloc.total}</span>
          )}
          <ChevronUp className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
        </button>
      )}
      {/* Folded, no card (and no error toast's role=alert) is in the page.
          The newest summary is said here instead: re-keyed when it changes,
          so the live region hears it as new — and an error assertively. */}
      {collapsed && summary && (
        <span
          key={`${summaryEntry?.touched ?? 0}:${summary.tone}:${summary.label}`}
          data-dock-announce
          className="sr-only"
          role={summary.tone === "error" ? "alert" : undefined}
        >
          {summary.label}
        </span>
      )}
    </div>,
    document.body,
  );
}

// ── The bottom-centre dock (STACK-4) ────────────────────────────────────────
// Bottom-centre had two surfaces at identical coordinates: the projects undo
// toasts (z-280) and the "Back to graph" chip (z-40), unaware of each other.
// One host now coordinates them: the chip is pinned at the edge and the undo
// stack sits above it. Each slot keeps the layer its surface already had
// (lib/zLayers: Z.pageChip, Z.undoToast), so neither moves relative to any
// drawer or modal — only the overlap between the two is gone.

export type CentreSlot = "chip" | "toasts";

function centreSnapshot(slot: CentreSlot) { return centreTargets[slot]; }
function chipPresent(): boolean {
  for (const c of centreCounts.values()) if (c.slot === "chip" && c.count > 0) return true;
  return false;
}

/** The bottom-centre target. Mount ONCE, in the protected layout. */
export function CentreDock() {
  const client = useSyncExternalStore(subscribeClient, () => true, () => false);
  const lifted = useSyncExternalStore(subscribe, chipPresent, () => false);
  if (!client) return null;
  return createPortal(
    <div id={CENTRE_DOCK_ID} data-chip={lifted ? "1" : "0"}>
      <div
        ref={setChipTarget}
        data-centre-slot="chip"
        className="fixed left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none"
        style={{ zIndex: Z.pageChip, bottom: "calc(var(--dock-bottom, 0px) + 1rem)" }}
      />
      <div
        ref={setCentreToastsTarget}
        data-centre-slot="toasts"
        className="fixed left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none"
        style={{ zIndex: Z.undoToast, bottom: `calc(var(--dock-bottom, 0px) + ${lifted ? "3.5rem" : "1rem"})` }}
      />
    </div>,
    document.body,
  );
}

/** Render into a bottom-centre slot; with no centre dock, a fixed box at the
 *  slot's own coordinates and layer (the old behaviour). `count` is how many
 *  visible things the child holds (the chip's 0 or 1). The fallback renders
 *  at once — it sits exactly where the slot does, so unlike the corner there
 *  is no second place to flash (and the undo host's live region must exist
 *  before a toast lands in it, A11Y-6). */
export function CentrePortal({ slot, count = 1, children }: { slot: CentreSlot; count?: number; children: React.ReactNode }) {
  const id = useId();
  const target = useSyncExternalStore(subscribe, () => centreSnapshot(slot), () => null);
  useLayoutEffect(() => {
    centreCounts.set(id, { slot, count });
    emit();
    return () => { centreCounts.delete(id); emit(); };
  }, [id, slot, count]);
  if (target) return createPortal(children, target);
  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none"
      style={{ zIndex: slot === "chip" ? Z.pageChip : Z.undoToast }}
    >
      {children}
    </div>
  );
}
