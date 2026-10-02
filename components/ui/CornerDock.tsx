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
//   - Its own layer. The dock is portaled to document.body at `Z.dock`, a
//     band above every modal, backdrop and dialog (lib/zLayers.ts), so the
//     modal that starts an upload no longer paints over the cards reporting
//     it (STACK-10).
//   - It moves out of the way. A page's bottom bar declares its height in
//     `--dock-bottom` and the dock sits above it; a full-height right-edge
//     drawer declares its width with `useOccupyRightRail` and the dock moves
//     left of it when there is room (STACK-7, STACK-11).
//   - On a phone it is one pill. Below the `sm` breakpoint the dock collapses
//     to a single summary pill that expands on tap (STACK-7).
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
let cache: { version: number; mobile: boolean; alloc: DockAllocation } | null = null;

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

function allocation(): DockAllocation {
  const mobile = isMobile();
  if (cache && cache.version === version && cache.mobile === mobile) return cache.alloc;
  const list: DockEntryInput[] = [...entries].map(([id, e]) => ({ id, slot: e.slot, priority: e.priority, count: e.count, seq: e.seq }));
  let alloc = allocateDock(list, DOCK_VISIBLE_CAP);
  if (expanded) {
    alloc = { ...alloc, visible: Object.fromEntries(list.map((e) => [e.id, e.count])), hidden: 0, hiddenTransient: 0 };
  } else if (mobile && !mobileOpen) {
    // Collapsed to the summary pill: nothing is "within the visible stack".
    alloc = { visible: Object.fromEntries(list.map((e) => [e.id, 0])), hidden: alloc.total, hiddenTransient: 0, total: alloc.total };
  }
  cache = { version, mobile, alloc };
  return alloc;
}

function allowanceFor(id: string, count: number): number {
  if (docks === 0) return count; // no dock (public page): the old behaviour
  const e = entries.get(id);
  if (!e) return Math.min(count, DOCK_VISIBLE_CAP);
  return allocation().visible[id] ?? 0;
}

function setExpanded(v: boolean) { expanded = v; emit(); }
function setMobileOpen(v: boolean) { mobileOpen = v; emit(); }

// Stable ref callbacks (an inline ref would detach and re-attach on every
// render, and each attach notifies the store).
const setTransientTarget = (el: HTMLElement | null) => { if (targets.transient !== el) { targets.transient = el; emit(); } };
const setJobsTarget = (el: HTMLElement | null) => { if (targets.jobs !== el) { targets.jobs = el; emit(); } };
const setChipTarget = (el: HTMLElement | null) => { if (centreTargets.chip !== el) { centreTargets.chip = el; emit(); } };
const setCentreToastsTarget = (el: HTMLElement | null) => { if (centreTargets.toasts !== el) { centreTargets.toasts = el; emit(); } };

/** Test seam: forget every registration (jsdom tests share the module). */
export function __resetDockForTests() {
  entries.clear(); rails.clear(); centreCounts.clear();
  targets.jobs = targets.transient = null;
  centreTargets.chip = centreTargets.toasts = null;
  docks = 0; expanded = false; mobileOpen = false; cache = null;
  emit();
}

/**
 * How many of this widget's `count` cards may show right now. Register the
 * widget's slot and priority; the answer changes as other widgets come and
 * go, as the "+N more" card is expanded, and on a phone. With no dock
 * mounted it is always `count`.
 */
export function useDockAllowance(slot: DockSlot, priority: number, count: number, summary?: DockSummary | null): number {
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
  return useSyncExternalStore(subscribe, () => allowanceFor(id, count), () => count);
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
    const apply = () => root.style.setProperty(DOCK_BOTTOM_VAR, `${Math.round(el.getBoundingClientRect().height)}px`);
    apply();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty(DOCK_BOTTOM_VAR);
    };
  }, [ref, active]);
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
  const live = list.filter((e) => e.count > 0 && e.summary);
  const byNewest = (a: { touched: number }, b: { touched: number }) => b.touched - a.touched;
  return live.filter((e) => e.summary!.tone === "error").sort(byNewest)[0]?.summary
    ?? live.filter((e) => e.summary!.tone === "busy").sort(byNewest)[0]?.summary
    ?? live.sort(byNewest)[0]?.summary
    ?? null;
}

/** The shared target. Mount ONCE, in the protected layout. `onOpenCenter`
 *  opens the notification center from the "+N more" card; `occupiedRightPx`
 *  is a right rail the layout knows about (the open notification center). */
export interface CornerDockProps { onOpenCenter?: () => void; occupiedRightPx?: number }
export function CornerDock({ onOpenCenter, occupiedRightPx = 0 }: CornerDockProps) {
  const client = useSyncExternalStore(subscribeClient, () => true, () => false);
  const alloc = useSyncExternalStore(subscribe, allocation, allocation);
  const rail = useSyncExternalStore(subscribe, railSnapshot, () => 0);

  useLayoutEffect(() => {
    docks++;
    emit();
    // Crossing the phone breakpoint re-allocates every widget's allowance.
    let mql: MediaQueryList | null = null;
    try { mql = window.matchMedia?.(DOCK_MOBILE_QUERY) ?? null; } catch { mql = null; }
    const onChange = () => emit();
    mql?.addEventListener?.("change", onChange);
    return () => {
      mql?.removeEventListener?.("change", onChange);
      docks--;
      emit();
    };
  }, []);
  useLayoutEffect(() => {
    if (occupiedRightPx > 0) rails.set(PROP_RAIL_ID, occupiedRightPx);
    else rails.delete(PROP_RAIL_ID);
    emit();
    return () => { rails.delete(PROP_RAIL_ID); emit(); };
  }, [occupiedRightPx]);
  // Nothing left to show: fold the expander and the phone stack back up.
  useEffect(() => {
    if (alloc.total === 0 && (expanded || mobileOpen)) {
      const t = setTimeout(() => { expanded = false; mobileOpen = false; emit(); }, 0);
      return () => clearTimeout(t);
    }
  }, [alloc.total]);

  if (!client) return null;
  // Read at render: every crossing of the breakpoint emits, and a new
  // allocation re-renders the dock.
  const mobile = isMobile();
  const collapsed = mobile && !mobileOpen && alloc.total > 0;
  const summary = collapsed ? pickSummary([...entries.values()]) : null;
  const showMore = !collapsed && (alloc.hidden > 0 || (expanded && alloc.total > DOCK_VISIBLE_CAP));

  return createPortal(
    <div
      id={DOCK_ID}
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
        zIndex: Z.dock,
        right: `calc(${rail}px - 1.5rem)`,
        bottom: "calc(var(--dock-bottom, 0px) - 1.5rem)",
        maxHeight: "calc(100dvh - var(--dock-bottom, 0px) + 3rem)",
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
              onClick={onOpenCenter}
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
          aria-label={`${alloc.total} update${alloc.total === 1 ? "" : "s"} — show`}
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
