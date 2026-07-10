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

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, Check, Plus, Loader2, Move, Sparkles } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import type { DashboardConfig, DashboardWidget, WidgetType, DocControlSettings } from "@/lib/dashboard/types";
import {
  loadDashboardConfig, saveDashboardConfig, newWidgetId, GRID_COLS,
} from "@/lib/dashboard/config";
import { moveElement, resizeElement, firstFreeSlot, bottomRow } from "@/lib/dashboard/layout";
import { WIDGET_CATALOG } from "./widgets";
import WidgetFrame from "./WidgetFrame";
import AddWidgetModal from "./AddWidgetModal";
import LibrarySettingsModal from "./LibrarySettingsModal";

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

export default function DashboardGrid() {
  const { uid, userEmail, hasAnyRole } = useRole();
  const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);

  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsWidget, setSettingsWidget] = useState<DashboardWidget | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resizing, setResizing] = useState<ResizeState | null>(null);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);

  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setGridWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    if (!uid) return;
    loadDashboardConfig(uid).then((cfg) => {
      if (alive) { setConfig(cfg); setLoaded(true); }
    });
    return () => { alive = false; };
  }, [uid]);

  const persist = useCallback((next: DashboardConfig) => {
    if (uid) void saveDashboardConfig(uid, next);
  }, [uid]);

  const mutate = useCallback((next: DashboardConfig) => {
    setConfig(next);
    persist(next);
  }, [persist]);

  const isMobile = gridWidth > 0 && gridWidth < MD_BREAKPOINT;
  const colWidth = gridWidth > 0 ? (gridWidth - GAP * (GRID_COLS - 1)) / GRID_COLS : 0;

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
  const saveSettings = (id: string, settings: DocControlSettings) => {
    if (!config) return;
    mutate({ ...config, widgets: config.widgets.map((w) => w.id === id ? { ...w, settings } : w) });
    setSettingsWidget(null);
  };

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

  if (!loaded || !config) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-[var(--color-accent)] animate-spin" />
      </div>
    );
  }

  const existingTypes = config.widgets.map((w) => w.type);
  const occupiedRows = bottomRow(config.widgets);
  // A few spare rows in edit mode give obvious empty space to drop into.
  const backdropRows = editing ? occupiedRows + 3 : occupiedRows;
  const addSlot = firstFreeSlot(config.widgets, 3, 2, GRID_COLS);

  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = (() => {
    const raw = (userEmail ?? "").split("@")[0];
    const head = raw.split(/[._-]/)[0];
    return head ? head.charAt(0).toUpperCase() + head.slice(1) : "";
  })();
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="relative min-h-full">
      {/* Ambient light — two soft accent blooms so the canvas breathes instead
          of sitting flat. Fixed cost, pointer-transparent, theme-aware. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px] overflow-hidden">
        <div className="absolute -top-40 left-[8%] w-[34rem] h-[34rem] rounded-full blur-3xl opacity-[0.14] dark:opacity-[0.18]" style={{ background: "radial-gradient(closest-side, var(--color-accent), transparent 70%)" }} />
        <div className="absolute -top-52 right-[4%] w-[30rem] h-[30rem] rounded-full blur-3xl opacity-[0.10] dark:opacity-[0.14]" style={{ background: "radial-gradient(closest-side, var(--color-accent-2), transparent 70%)" }} />
      </div>

      <div className="relative p-4 sm:p-6 lg:px-10 max-w-[1720px] mx-auto">
      {/* Greeting hero */}
      <div className="flex items-end justify-between gap-4 mb-6 flex-wrap" style={{ animation: "rise 0.4s var(--ease-fluid) both" }}>
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-faint)]">{dateLine}</div>
          <h1 className="mt-1 text-2xl sm:text-[28px] font-black tracking-tight text-[var(--color-text)]">
            {greeting}{firstName ? <>, <span className="bg-clip-text text-transparent" style={{ backgroundImage: "var(--brand-gradient)" }}>{firstName}</span></> : ""}
          </h1>
          <p className="text-[13px] text-[var(--color-text-muted)] mt-0.5">
            {editing ? "Drag widgets anywhere · pull a corner to resize · ＋ adds more" : "Here’s your workspace at a glance."}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-bold bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" /> Add widget
          </button>
          <button
            type="button"
            onClick={() => { setEditing((v) => !v); setResizing(null); setDrag(null); }}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all shadow-sm ${
              editing
                ? "bg-[var(--color-accent)] text-white hover:opacity-90 shadow-lg shadow-orange-500/25"
                : "bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            }`}
          >
            {editing ? <><Check className="w-4 h-4" /> Done</> : <><Pencil className="w-4 h-4" /> Customize</>}
          </button>
        </div>
      </div>

      {/* Edit-mode helper strip */}
      {editing && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-dashed border-[var(--color-accent)]/50 bg-[var(--color-accent-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--color-text)]" style={{ animation: "rise 0.25s var(--ease-fluid) both" }}>
          <Sparkles className="w-4 h-4 text-[var(--color-accent)] shrink-0" />
          You’re customizing — grab any card to move it, drag the orange corner to resize, ✕ removes. Everything saves as you go.
        </div>
      )}

      {/* Stable measuring wrapper — keeps the ResizeObserver attached across the
          mobile/desktop swap so the breakpoint stays live. */}
      <div ref={gridRef} className="relative">
      {isMobile ? (
        // ── Mobile: single readable column, ordered by (y, x) ──
        <div className="flex flex-col gap-4">
          {[...config.widgets]
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map((widget, idx) => (
              <div key={widget.id} style={{ minHeight: widget.h * ROW_UNIT + (widget.h - 1) * GAP }} className="relative min-w-0">
                <div className="h-full" style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(idx, 10) * 45}ms` }}>
                  <WidgetFrame
                    widget={widget}
                    editing={editing}
                    onRemove={() => removeWidget(widget.id)}
                    onOpenSettings={() => setSettingsWidget(widget)}
                  />
                </div>
              </div>
            ))}
          {editing && (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              style={{ minHeight: 2 * ROW_UNIT + GAP }}
              className="min-w-0 rounded-2xl border-2 border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors flex flex-col items-center justify-center gap-2"
            >
              <Plus className="w-6 h-6" />
              <span className="text-sm font-bold">Add widget</span>
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
              className="rounded-2xl border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-accent)]/10 pointer-events-none transition-all"
            />
          )}

          {config.widgets.map((widget, idx) => {
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
                <WidgetFrame
                  widget={widget}
                  editing={editing}
                  onRemove={() => removeWidget(widget.id)}
                  onOpenSettings={() => setSettingsWidget(widget)}
                />
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
                    <span className="block w-4 h-4 rounded-br-lg rounded-tl-sm bg-[var(--color-accent)] shadow-md border border-white/60" style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }} />
                  </div>
                )}

                {/* Live size badge while resizing. */}
                {isResizingThis && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 px-2 py-0.5 rounded-md bg-[var(--color-accent)] text-white text-[11px] font-black tabular-nums shadow pointer-events-none">
                    {liveW} × {liveH}
                  </div>
                )}

                {/* Drag hint chip (edit mode, idle). */}
                {editing && !isDragging && !isResizingThis && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-1.5 py-0.5 rounded-md bg-black/35 backdrop-blur text-white/90 text-[10px] font-bold inline-flex items-center gap-1 opacity-0 group-hover/tile:opacity-100 transition-opacity pointer-events-none">
                    <Move className="w-3 h-3" /> drag
                  </div>
                )}
              </div>
            );
          })}

          {/* Add tile — edit mode only (the header's Add button covers view
              mode); sits in the first free slot, inviting customization. */}
          {editing && (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              style={{ gridColumn: `${addSlot.x + 1} / span 3`, gridRow: `${addSlot.y + 1} / span 2`, zIndex: 10 }}
              className="min-w-0 rounded-2xl border-2 border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors flex flex-col items-center justify-center gap-2"
            >
              <Plus className="w-6 h-6" />
              <span className="text-sm font-bold">Add widget</span>
            </button>
          )}
        </div>
      )}
      </div>

      <AddWidgetModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        existingTypes={existingTypes}
        isAdmin={isAdmin}
        onAdd={(type) => addWidget(type)}
      />
      <LibrarySettingsModal
        key={settingsWidget?.id ?? "none"}
        open={!!settingsWidget}
        widget={settingsWidget}
        onClose={() => setSettingsWidget(null)}
        onSave={(settings) => { if (settingsWidget) saveSettings(settingsWidget.id, settings); }}
      />
      </div>
    </div>
  );
}

// Compact a widget list upward (used after a removal). Pure; returns a new list.
function reflow(widgets: DashboardWidget[]): DashboardWidget[] {
  if (widgets.length === 0) return widgets;
  // moveElement with a no-op move re-runs vertical compaction over the whole set.
  return moveElement(widgets, widgets[0].id, widgets[0].x, widgets[0].y, GRID_COLS);
}
