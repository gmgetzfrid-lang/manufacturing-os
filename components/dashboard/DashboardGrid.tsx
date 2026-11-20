"use client";

// Customizable home dashboard — a real, free-form 12-column grid.
//
// Every widget owns an explicit (x, y) origin and a (w, h) span, so it can live
// ANYWHERE on the 12-col grid. In "Customize" mode the user can:
//
//   • DRAG a widget anywhere. It follows the cursor (a lifted "ghost"), a dashed
//     PLACEHOLDER shows exactly where it will land, and the rest of the layout
//     re-flows live. On release it snaps to the placeholder.
//   • RESIZE from the bottom-right corner in 2D (snaps to columns / row-units,
//     clamped to each widget's catalog min/max).
//
// The grid uses VERTICAL COMPACTION: after any move / resize / removal widgets
// float straight up to fill empty rows, so there are never holes (see
// lib/dashboard/layout.ts). In edit mode a faint perforated grid is drawn behind
// everything so placement is obvious.
//
// On mobile (container narrower than MD_BREAKPOINT) widgets stack to a single
// readable column (drag/resize off); their relative order follows (y, x).

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import SetupChecklist from "@/components/onboarding/SetupChecklist";
import { Pencil, Check, Plus, Move, LayoutGrid } from "lucide-react";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { useTicketNotifications } from "@/hooks/useTicketNotifications";
import { splitRef, shortDate } from "@/components/cockpit/CommandDeck";
import HomeStrips from "@/components/cockpit/HomeStrips";
import type { DashboardConfig, DashboardWidget, WidgetType } from "@/lib/dashboard/types";
import {
  loadDashboardConfig, saveDashboardConfig, newWidgetId, GRID_COLS,
} from "@/lib/dashboard/config";
import { moveElement, resizeElement, firstFreeSlot, bottomRow, justifyLayout } from "@/lib/dashboard/layout";
import { WIDGET_CATALOG } from "./widgets";
import WidgetFrame from "./WidgetFrame";
import AddWidgetModal from "./AddWidgetModal";
import WidgetSettingsModal from "./WidgetSettingsModal";

// Grid geometry. ROW_UNIT is the height of one `h` unit; GAP is the grid gap.
const ROW_UNIT = 84; // px — matches gridAutoRows
const GAP = 16; // px — matches gap-4
const MD_BREAKPOINT = 768; // below this, collapse to a single column

// Live drag state: the cursor delta (for the ghost) + the snapped target slot
// (for the placeholder).
interface DragState {
  id: string;
  dx: number; dy: number;
  x: number; y: number; w: number; h: number;
}
interface ResizeState { id: string; w: number; h: number; }

// Local-time snapshots for the header (see the hydration note in the
// component). Plain value-returning getters: strings compare by value, so
// useSyncExternalStore sees a stable snapshot within the same minute/day.
const subscribeNever = () => () => {};
const greetingNow = () => {
  const hour = new Date().getHours();
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
};
const dateLineNow = () =>
  new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

export default function DashboardGrid() {
  const { uid, userEmail, hasAnyRole } = useRole();
  const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);
  // What waits on you: the same feed as the bell and the sidebar badge, so
  // the band's answer never disagrees with them.
  const { count: attnCount, items: attnItems, loading: attnLoading, loadError: attnError } = useTicketNotifications();

  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsWidget, setSettingsWidget] = useState<DashboardWidget | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resizing, setResizing] = useState<ResizeState | null>(null);

  // Greeting + date are LOCAL-TIME values. The page is statically
  // prerendered, so computing them during render bakes in the build
  // machine's clock and mismatches the browser at hydration (React #418).
  // useSyncExternalStore: deterministic server snapshot, browser value after.
  const greeting = useSyncExternalStore(subscribeNever, greetingNow, () => "Welcome back");
  const dateLine = useSyncExternalStore(subscribeNever, dateLineNow, () => "");

  const [gridWidth, setGridWidth] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);

  // CALLBACK ref, not ref+effect: the old []-deps effect ran once during the
  // loading-spinner commit — before the grid div existed — found null, and
  // never re-ran. gridWidth stayed 0 forever, isMobile stayed false, and
  // PHONES GOT THE DESKTOP 12-COLUMN GRID: every widget a ~60px sliver.
  // A callback ref fires when the node actually mounts (and React runs it
  // before paint), so the first painted layout is already the right branch.
  const gridRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    setGridWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width ?? 0;
        setGridWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
      });
      ro.observe(el);
      roRef.current = ro;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    if (!uid) return;
    loadDashboardConfig(uid).then((cfg) => {
      if (alive) { setConfig(cfg); setLoaded(true); }
    });
    return () => { alive = false; };
  }, [uid]);

  // The layout is always kept on this device; say so when the account copy
  // didn't save (it then won't follow you to another device).
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const persist = useCallback((next: DashboardConfig) => {
    if (uid) void saveDashboardConfig(uid, next).then(setSaveErr);
  }, [uid]);

  const mutate = useCallback((next: DashboardConfig) => {
    setConfig(next);
    persist(next);
  }, [persist]);

  const isMobile = gridWidth > 0 && gridWidth < MD_BREAKPOINT;
  const colWidth = gridWidth > 0 ? (gridWidth - GAP * (GRID_COLS - 1)) / GRID_COLS : 0;

  // VIEW mode always shows a fill-to-the-edges layout: widgets slide left and
  // stretch into trailing empty cells (capped by each type's max span), so
  // rows land flush on the grid edge instead of leaving dead cells — the
  // "widgets in jail" fix. Render-only: the user's true grid (what edit mode
  // shows and drags) is untouched.
  const displayWidgets = useMemo(() => {
    if (!config) return [];
    if (editing) return config.widgets;
    return justifyLayout(config.widgets, GRID_COLS, (w) => WIDGET_CATALOG[w.type]?.maxW ?? GRID_COLS);
  }, [config, editing]);

  // Edit-mode "Tidy": persist the same justify pass, so one click turns a
  // gappy hand-arranged grid into a flush one the user can keep tweaking.
  const tidyLayout = () => {
    if (!config) return;
    mutate({ ...config, widgets: justifyLayout(config.widgets, GRID_COLS, (w) => WIDGET_CATALOG[w.type]?.maxW ?? GRID_COLS) });
  };

  const addWidget = (type: WidgetType) => {
    if (!config) return;
    const meta = WIDGET_CATALOG[type];
    const { x, y } = firstFreeSlot(config.widgets, meta.defaultW, meta.defaultH, GRID_COLS);
    const widget: DashboardWidget = { id: newWidgetId(), type, x, y, w: meta.defaultW, h: meta.defaultH, settings: {} };
    mutate({ ...config, widgets: [...config.widgets, widget] });
  };
  const removeWidget = (id: string) => {
    if (!config) return;
    // Drop it, then compact upward so the gap it left closes.
    const remaining = config.widgets.filter((w) => w.id !== id);
    mutate({ ...config, widgets: reflow(remaining) });
  };
  const saveSettings = (id: string, settings: Record<string, unknown>) => {
    if (!config) return;
    mutate({ ...config, widgets: config.widgets.map((w) => w.id === id ? { ...w, settings } : w) });
    setSettingsWidget(null);
  };
  // A change made INSIDE a widget (a tab, a library switch) sticks: merged
  // into that widget's settings and saved, from the freshest config.
  const updateWidgetSettings = useCallback((id: string, patch: Record<string, unknown>) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev, widgets: prev.widgets.map((w) => w.id === id ? { ...w, settings: { ...(w.settings ?? {}), ...patch } } : w) };
      persist(next);
      return next;
    });
  }, [persist]);

  // ── Drag (pointer-driven, with ghost + placeholder) ───────────────────────
  const dragPointer = useRef<{
    id: string; startX: number; startY: number; origX: number; origY: number;
    w: number; h: number; unitW: number; unitH: number;
    base: DashboardWidget[]; last: DashboardWidget[];
  } | null>(null);

  const onWidgetPointerDown = (e: React.PointerEvent, widget: DashboardWidget) => {
    if (!editing || isMobile || !config) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return; // controls / resize handle
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragPointer.current = {
      id: widget.id, startX: e.clientX, startY: e.clientY, origX: widget.x, origY: widget.y,
      w: widget.w, h: widget.h, unitW: colWidth + GAP, unitH: ROW_UNIT + GAP,
      base: config.widgets, last: config.widgets,
    };
    setDrag({ id: widget.id, dx: 0, dy: 0, x: widget.x, y: widget.y, w: widget.w, h: widget.h });
  };

  const onWidgetPointerMove = (e: React.PointerEvent) => {
    const d = dragPointer.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const tx = d.origX + (d.unitW > 0 ? Math.round(dx / d.unitW) : 0);
    const ty = d.origY + (d.unitH > 0 ? Math.round(dy / d.unitH) : 0);
    const next = moveElement(d.base, d.id, tx, ty, GRID_COLS);
    d.last = next;
    const m = next.find((w) => w.id === d.id)!;
    // Render others at their re-flowed slots, but keep the dragged tile pinned to
    // its ORIGIN cell so the translate(dx,dy) ghost tracks the cursor cleanly.
    const rendered = next.map((w) => (w.id === d.id ? { ...w, x: d.origX, y: d.origY } : w));
    setConfig((prev) => (prev ? { ...prev, widgets: rendered } : prev));
    setDrag({ id: d.id, dx, dy, x: m.x, y: m.y, w: m.w, h: m.h });
  };

  const onWidgetPointerUp = (e: React.PointerEvent) => {
    const d = dragPointer.current;
    if (!d) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    const final = d.last;
    dragPointer.current = null;
    setDrag(null);
    setConfig((prev) => {
      if (!prev) return prev;
      const nextCfg = { ...prev, widgets: final };
      persist(nextCfg);
      return nextCfg;
    });
  };

  // ── Resize (pointer-driven, 2D corner) ────────────────────────────────────
  const resizePointer = useRef<{
    id: string; startX: number; startY: number; startW: number; startH: number;
    minW: number; minH: number; maxW: number; unitW: number; unitH: number;
    base: DashboardWidget[]; last: DashboardWidget[];
  } | null>(null);

  const onResizeStart = (e: React.PointerEvent, widget: DashboardWidget) => {
    if (!config) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const meta = WIDGET_CATALOG[widget.type];
    resizePointer.current = {
      id: widget.id, startX: e.clientX, startY: e.clientY, startW: widget.w, startH: widget.h,
      minW: meta?.minW ?? 1, minH: meta?.minH ?? 1, maxW: meta?.maxW ?? GRID_COLS,
      unitW: colWidth + GAP, unitH: ROW_UNIT + GAP, base: config.widgets, last: config.widgets,
    };
    setResizing({ id: widget.id, w: widget.w, h: widget.h });
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const rp = resizePointer.current;
    if (!rp) return;
    const dw = rp.unitW > 0 ? Math.round((e.clientX - rp.startX) / rp.unitW) : 0;
    const dh = rp.unitH > 0 ? Math.round((e.clientY - rp.startY) / rp.unitH) : 0;
    const nextW = Math.max(rp.minW, Math.min(rp.maxW, rp.startW + dw));
    const nextH = Math.max(rp.minH, rp.startH + dh);
    const next = resizeElement(rp.base, rp.id, nextW, nextH, GRID_COLS);
    rp.last = next;
    const m = next.find((w) => w.id === rp.id)!;
    setConfig((prev) => (prev ? { ...prev, widgets: next } : prev));
    setResizing({ id: rp.id, w: m.w, h: m.h });
  };

  const onResizeEnd = (e: React.PointerEvent) => {
    const rp = resizePointer.current;
    if (!rp) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    const final = rp.last;
    resizePointer.current = null;
    setResizing(null);
    setConfig((prev) => {
      if (!prev) return prev;
      const nextCfg = { ...prev, widgets: final };
      persist(nextCfg);
      return nextCfg;
    });
  };

  const firstName = (() => {
    const raw = (userEmail ?? "").split("@")[0];
    const head = raw.split(/[._-]/)[0];
    return head ? head.charAt(0).toUpperCase() + head.slice(1) : "";
  })();

  // ── The band: the date, the answer, the one thing named, "Open it". ──
  const lead = attnItems.find((i) => i.actionRequired) ?? attnItems[0];
  const answer = attnError && attnCount === 0
    ? "Couldn't check what needs you."
    : attnLoading && attnCount === 0
      ? `${greeting}${firstName ? `, ${firstName}` : ""}.`
      : attnCount > 0
        ? `${attnCount} ${attnCount === 1 ? "thing needs" : "things need"} you.`
        : "Nothing needs you right now.";
  const leadLine = (() => {
    if (attnError && attnCount === 0) return <>The list of what waits on you didn&apos;t load: {attnError}</>;
    if (!lead) return attnLoading ? null : <>No requests, reviews or alerts are waiting on you.</>;
    const since = lead.when ? shortDate(lead.when) : "";
    if (lead.source === "ticket") {
      const [ref, name] = splitRef(lead.title);
      return (
        <>
          {lead.subtitle} on <span className="text-white font-semibold">{ref ?? name}</span>
          {ref && name ? <span> ({name})</span> : null}.
          {lead.actionRequired && since ? ` No change since ${since}.` : ""}
        </>
      );
    }
    return (
      <>
        <span className="text-white font-semibold">{lead.title}</span>
        {lead.subtitle ? <span>. {lead.subtitle}</span> : null}
        {since ? <span> · {since}</span> : null}
      </>
    );
  })();

  const band = (
    <PageHero
      kicker={<>{dateLine || "Home"}{dateLine ? <span className="max-sm:hidden"> · {greeting}</span> : null}</>}
      title={answer}
      sub={leadLine}
      tools={loaded && config ? (
        <>
          <button type="button" onClick={() => setAddOpen(true)} className={heroQuiet} aria-label="Add widget">
            <Plus className="w-4 h-4" /><span className="max-sm:hidden">Add widget</span>
          </button>
          <button
            type="button"
            onClick={() => { setEditing((v) => !v); setResizing(null); setDrag(null); }}
            aria-pressed={editing}
            className={editing
              ? "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-[10px] bg-white text-[13px] font-bold text-[var(--color-ink)] hover:bg-[var(--color-ink-fg)] transition-colors"
              : heroQuiet}
          >
            {editing ? <><Check className="w-4 h-4" /> Done</> : <><Pencil className="w-4 h-4" /><span className="max-sm:hidden">Customize</span><span className="sr-only sm:hidden">Customize</span></>}
          </button>
        </>
      ) : undefined}
      primary={lead && !editing ? <Link href={lead.link} className={heroPrimary}>Open it</Link> : undefined}
    >
      {(editing || saveErr) && (
        <div className="space-y-2">
          {editing && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-[var(--color-ink-text)]">
              <span className="min-w-0 flex-1">
                {isMobile
                  // Phones can't drag or resize; telling them to reads as broken.
                  ? "Customizing. Arrange and resize on a larger screen. Changes save as you go."
                  : "Customizing. Drag a card to move it, its corner to resize. Changes save as you go."}
              </span>
              <button type="button" onClick={tidyLayout} className={heroQuiet}
                title="Close every gap: slide widgets together and stretch rows to the edges">
                <LayoutGrid className="w-4 h-4" /> Tidy layout
              </button>
            </div>
          )}
          {saveErr && <p role="alert" className="text-[13px] text-amber-300">Your layout is saved on this device only. The account copy didn&apos;t save: {saveErr}</p>}
        </div>
      )}
    </PageHero>
  );

  if (!loaded || !config) {
    return (
      <PageShell width="full">
        <div className="mx-auto max-w-[1720px]">
          <h1 className="sr-only">Home</h1>
          {band}
          <PageBody>
            <Card><LoadingBlock what="your Home" rows={6} className="border-0 p-0" /></Card>
          </PageBody>
        </div>
      </PageShell>
    );
  }

  const existingTypes = config.widgets.map((w) => w.type);
  const occupiedRows = bottomRow(config.widgets);
  // A few spare rows in edit mode give obvious empty space to drop into.
  const backdropRows = editing ? occupiedRows + 3 : occupiedRows;
  const addSlot = firstFreeSlot(config.widgets, 3, 2, GRID_COLS);

  // Outside of Customize, a "Needs you" card that heads the layout sits on
  // its own at content height, right under the band, with your libraries and
  // projects below it; the rest of the grid follows.
  const deck = !editing ? displayWidgets.find((w) => w.type === "commandDeck" && w.y === 0) : undefined;
  const pinned = deck && displayWidgets.every((w) => w.id === deck.id || w.y >= deck.y + deck.h) ? deck : undefined;
  const gridWidgets = pinned
    ? displayWidgets.filter((w) => w.id !== pinned.id).map((w) => ({ ...w, y: w.y - pinned.h }))
    : displayWidgets;
  const frame = (widget: DashboardWidget) => (
    <WidgetFrame
      widget={widget}
      editing={editing}
      onRemove={() => removeWidget(widget.id)}
      onOpenSettings={() => setSettingsWidget(widget)}
      onUpdateSettings={(patch) => updateWidgetSettings(widget.id, patch)}
    />
  );

  return (
    <PageShell width="full">
      <div className="mx-auto max-w-[1720px]">
      <h1 className="sr-only">Home</h1>
      {band}
      <PageBody>
      {pinned && (
        <>
          <div style={{ animation: "rise 0.45s var(--ease-fluid) both" }}>{frame(pinned)}</div>
          <HomeStrips />
        </>
      )}

      {/* Stable measuring wrapper — keeps the ResizeObserver attached across the
          mobile/desktop swap so the breakpoint stays live. */}
      <div ref={gridRef} className="relative">
      {isMobile ? (
        // ── Mobile: single readable column, ordered by (y, x) ──
        <div className="flex flex-col gap-4">
          {[...gridWidgets]
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map((widget, idx) => (
              // DEFINITE height (not minHeight): the WidgetFrame body relies on
              // an h-full/flex-1/min-h-0 chain for its internal scroll areas,
              // and percentage heights against a min-height-only parent resolve
              // inconsistently across browsers — the card's overflow-hidden
              // then clips half the widget. A real height (with a comfortable
              // phone floor) makes every widget fully visible and scrollable.
              <div key={widget.id} style={{ height: Math.max(widget.h * ROW_UNIT + (widget.h - 1) * GAP, 300) }} className="relative min-w-0">
                <div className="h-full" style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(idx, 10) * 45}ms` }}>
                  {frame(widget)}
                </div>
              </div>
            ))}
          {editing && (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              style={{ minHeight: 2 * ROW_UNIT + GAP }}
              className="min-w-0 rounded-2xl border-2 border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors flex flex-col items-center justify-center gap-2"
            >
              <Plus className="w-6 h-6" />
              <span className="text-[13px] font-bold">Add widget</span>
            </button>
          )}
        </div>
      ) : (
        // ── Desktop: the free-form 12-column grid ──
        <div
          className="relative grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
            gridAutoRows: `${ROW_UNIT}px`,
          }}
        >
          {/* Perforated grid backdrop (edit mode) — shows every droppable cell. */}
          {editing &&
            Array.from({ length: backdropRows }).map((_, r) =>
              Array.from({ length: GRID_COLS }).map((__, c) => (
                <div
                  key={`bg-${r}-${c}`}
                  aria-hidden
                  style={{ gridColumn: `${c + 1} / span 1`, gridRow: `${r + 1} / span 1`, zIndex: 0 }}
                  className="rounded-lg border border-dashed border-[var(--color-border)]/70 bg-[var(--color-surface-2)]/25 pointer-events-none"
                />
              )),
            )}

          {/* Drop placeholder — where the dragged widget will land. */}
          {drag && (
            <div
              aria-hidden
              style={{ gridColumn: `${drag.x + 1} / span ${drag.w}`, gridRow: `${drag.y + 1} / span ${drag.h}`, zIndex: 5 }}
              className="rounded-2xl border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] pointer-events-none transition-all"
            />
          )}

          {gridWidgets.map((widget, idx) => {
            const isDragging = drag?.id === widget.id;
            const isResizingThis = resizing?.id === widget.id;
            const liveW = isResizingThis ? resizing!.w : widget.w;
            const liveH = isResizingThis ? resizing!.h : widget.h;
            return (
              <div
                key={widget.id}
                onPointerDown={(e) => onWidgetPointerDown(e, widget)}
                onPointerMove={onWidgetPointerMove}
                onPointerUp={onWidgetPointerUp}
                onPointerCancel={onWidgetPointerUp}
                style={{
                  gridColumn: `${widget.x + 1} / span ${liveW}`,
                  gridRow: `${widget.y + 1} / span ${liveH}`,
                  transform: isDragging ? `translate(${drag!.dx}px, ${drag!.dy}px)` : undefined,
                  zIndex: isDragging ? 30 : 10,
                  cursor: editing && !isResizingThis ? (isDragging ? "grabbing" : "grab") : undefined,
                }}
                className={`group/tile relative min-w-0 ${isDragging ? "scale-[1.02] shadow-2xl shadow-slate-900/30 rounded-2xl" : ""} ${
                  (drag && !isDragging) || (resizing && !isResizingThis) ? "transition-[grid-column,grid-row] duration-150" : ""
                }`}
              >
                {/* Entrance stagger lives on an inner wrapper so its transform
                    can never fight the drag translate on the tile itself. */}
                <div className="h-full" style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(idx, 10) * 45}ms` }}>
                  {frame(widget)}
                </div>

                {/* Corner resize handle (bottom-right). */}
                {editing && (
                  <div
                    role="button"
                    data-no-drag
                    aria-label={`Resize widget (${liveW} by ${liveH})`}
                    tabIndex={-1}
                    onPointerDown={(e) => onResizeStart(e, widget)}
                    onPointerMove={onResizeMove}
                    onPointerUp={onResizeEnd}
                    onPointerCancel={onResizeEnd}
                    className={`absolute -bottom-1 -right-1 w-6 h-6 z-20 cursor-nwse-resize touch-none flex items-end justify-end p-1 ${isResizingThis ? "scale-110" : ""}`}
                    title="Drag to resize"
                  >
                    <span className="block w-4 h-4 rounded-br-lg rounded-tl-sm bg-[var(--color-surface-2)] shadow-md border border-white/60" style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }} />
                  </div>
                )}

                {/* Live size badge while resizing. */}
                {isResizingThis && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 px-2 py-0.5 rounded-md bg-[var(--color-surface-2)] text-[var(--color-text)] text-[11px] font-black tabular-nums shadow pointer-events-none">
                    {liveW} × {liveH}
                  </div>
                )}

                {/* Drag hint chip (edit mode, idle). */}
                {editing && !isDragging && !isResizingThis && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-1.5 py-0.5 rounded-md bg-black/35 backdrop-blur text-white/90 text-[11px] font-bold inline-flex items-center gap-1 opacity-0 group-hover/tile:opacity-100 transition-opacity pointer-events-none">
                    <Move className="w-3 h-3" /> drag
                  </div>
                )}
              </div>
            );
          })}

          {/* Add tile — edit mode only (the band's Add button covers view
              mode); sits in the first free slot, inviting customization. */}
          {editing && (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              style={{ gridColumn: `${addSlot.x + 1} / span 3`, gridRow: `${addSlot.y + 1} / span 2`, zIndex: 10 }}
              className="min-w-0 rounded-2xl border-2 border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors flex flex-col items-center justify-center gap-2"
            >
              <Plus className="w-6 h-6" />
              <span className="text-[13px] font-bold">Add widget</span>
            </button>
          )}
        </div>
      )}
      </div>

      {/* Libraries and projects follow the work when nothing heads the grid. */}
      {!pinned && !editing && <HomeStrips />}

      {/* Setting up a new workspace (admins; hides itself once done or closed): after the work. */}
      <SetupChecklist />
      </PageBody>

      <AddWidgetModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        existingTypes={existingTypes}
        isAdmin={isAdmin}
        onAdd={(type) => addWidget(type)}
      />
      {settingsWidget && (
        <WidgetSettingsModal
          key={settingsWidget.id}
          widget={config.widgets.find((w) => w.id === settingsWidget.id) ?? settingsWidget}
          onClose={() => setSettingsWidget(null)}
          onSave={(settings) => saveSettings(settingsWidget.id, settings)}
        />
      )}
      </div>
    </PageShell>
  );
}

// Compact a widget list upward (used after a removal). Pure; returns a new list.
function reflow(widgets: DashboardWidget[]): DashboardWidget[] {
  if (widgets.length === 0) return widgets;
  // moveElement with a no-op move re-runs vertical compaction over the whole set.
  return moveElement(widgets, widgets[0].id, widgets[0].x, widgets[0].y, GRID_COLS);
}
