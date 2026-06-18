"use client";

// Customizable home dashboard — a real, dependency-free dynamic grid.
//
// Layout is a 12-column CSS grid (grid-auto-flow: row dense), so each widget
// spans `w` columns × `h` row-units and the browser dense-packs them. This
// supports full-width banners, tall narrow sidebars, wide-short tiles, squares
// — any 2D shape.
//
// In "Customize" mode you can:
//   • DRAG a widget to reorder; the grid reflows live (array-order is the
//     packing order).
//   • Drag the bottom-right CORNER HANDLE to resize in 2D: horizontal drag snaps
//     `w` to the measured column width, vertical drag snaps `h` to the row-unit
//     height. Sizes are clamped to each widget's catalog min/max. The change is
//     live while dragging and persisted on release.
//
// On mobile (container narrower than MD_BREAKPOINT) every widget collapses to
// full width (w is ignored) while keeping its height.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGrid, Pencil, Check, Plus, Loader2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import type { DashboardConfig, DashboardWidget, WidgetType, DocControlSettings } from "@/lib/dashboard/types";
import {
  loadDashboardConfig, saveDashboardConfig, newWidgetId,
  GRID_COLS, clampW, clampH,
} from "@/lib/dashboard/config";
import { WIDGET_CATALOG } from "./widgets";
import WidgetFrame from "./WidgetFrame";
import AddWidgetModal from "./AddWidgetModal";
import LibrarySettingsModal from "./LibrarySettingsModal";

// Grid geometry. ROW_UNIT is the height of one `h` unit; GAP is the grid gap.
const ROW_UNIT = 84; // px — matches grid-auto-rows
const GAP = 16; // px — matches gap-4
const MD_BREAKPOINT = 768; // below this, collapse to single column

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

interface ResizeState {
  id: string;
  w: number;
  h: number;
}

export default function DashboardGrid() {
  const { uid, userEmail, hasAnyRole } = useRole();
  const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);

  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsWidget, setSettingsWidget] = useState<DashboardWidget | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Live size override while a corner-resize is in progress (not yet persisted).
  const [resizing, setResizing] = useState<ResizeState | null>(null);

  // Measured container width drives column-width math for snapping + the mobile
  // collapse. Updated from a ResizeObserver callback (not synchronously in the
  // effect body) so we don't trip react-hooks/set-state-in-effect.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);

  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      // setState inside the observer callback is an async event, allowed by lint.
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

  const mutate = useCallback((next: DashboardConfig) => {
    setConfig(next);
    if (uid) void saveDashboardConfig(uid, next);
  }, [uid]);

  const isMobile = gridWidth > 0 && gridWidth < MD_BREAKPOINT;
  // Effective column width (px) for snapping during resize.
  const colWidth = gridWidth > 0 ? (gridWidth - GAP * (GRID_COLS - 1)) / GRID_COLS : 0;

  const addWidget = (type: WidgetType) => {
    if (!config) return;
    const meta = WIDGET_CATALOG[type];
    const widget: DashboardWidget = { id: newWidgetId(), type, w: meta.defaultW, h: meta.defaultH, settings: {} };
    mutate({ ...config, widgets: [...config.widgets, widget] });
  };
  const removeWidget = (id: string) => {
    if (!config) return;
    mutate({ ...config, widgets: config.widgets.filter((w) => w.id !== id) });
  };
  const saveSettings = (id: string, settings: DocControlSettings) => {
    if (!config) return;
    mutate({ ...config, widgets: config.widgets.map((w) => w.id === id ? { ...w, settings } : w) });
    setSettingsWidget(null);
  };
  const reorder = useCallback((from: number, to: number) => {
    setConfig((prev) => {
      if (!prev || from === to || from < 0 || to < 0 || from >= prev.widgets.length || to >= prev.widgets.length) return prev;
      const next = { ...prev, widgets: arrayMove(prev.widgets, from, to) };
      if (uid) void saveDashboardConfig(uid, next);
      return next;
    });
  }, [uid]);

  // ── 2D corner resize via pointer events ───────────────────────────────────
  // Everything the move/end handlers need is captured on this ref at start, so
  // the handlers don't depend on stale closures. `last` tracks the most recent
  // snapped size, committed to persistence on release.
  const resizePointer = useRef<{
    id: string; startX: number; startY: number; startW: number; startH: number;
    minW: number; minH: number; maxW: number; unitW: number; unitH: number;
    last: { w: number; h: number };
  } | null>(null);

  const onResizeStart = (e: React.PointerEvent, widget: DashboardWidget) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const meta = WIDGET_CATALOG[widget.type];
    resizePointer.current = {
      id: widget.id,
      startX: e.clientX,
      startY: e.clientY,
      startW: widget.w,
      startH: widget.h,
      minW: meta?.minW ?? 1,
      minH: meta?.minH ?? 1,
      maxW: meta?.maxW ?? GRID_COLS,
      unitW: colWidth + GAP,
      unitH: ROW_UNIT + GAP,
      last: { w: widget.w, h: widget.h },
    };
    setResizing({ id: widget.id, w: widget.w, h: widget.h });
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const rp = resizePointer.current;
    if (!rp) return;
    const dw = rp.unitW > 0 ? Math.round((e.clientX - rp.startX) / rp.unitW) : 0;
    const dh = rp.unitH > 0 ? Math.round((e.clientY - rp.startY) / rp.unitH) : 0;
    const nextW = Math.max(rp.minW, Math.min(rp.maxW, clampW(rp.startW + dw)));
    const nextH = Math.max(rp.minH, clampH(rp.startH + dh));
    rp.last = { w: nextW, h: nextH };
    setResizing((prev) => (prev && prev.w === nextW && prev.h === nextH ? prev : { id: rp.id, w: nextW, h: nextH }));
  };

  const onResizeEnd = (e: React.PointerEvent) => {
    const rp = resizePointer.current;
    if (!rp) return;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    const { id, last } = rp;
    resizePointer.current = null;
    setResizing(null);
    setConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev, widgets: prev.widgets.map((w) => w.id === id ? { ...w, w: last.w, h: last.h } : w) };
      if (uid) void saveDashboardConfig(uid, next);
      return next;
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

  // Per-widget effective span (apply live resize override + mobile collapse).
  const spanOf = (widget: DashboardWidget): { w: number; h: number } => {
    const live = resizing && resizing.id === widget.id ? resizing : widget;
    return { w: isMobile ? GRID_COLS : live.w, h: live.h };
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--color-accent)] text-white shrink-0">
            <LayoutGrid className="w-5 h-5" />
          </span>
          <div>
            <h1 className="text-xl font-black text-[var(--color-text)]">Dashboard</h1>
            <p className="text-xs text-[var(--color-text-muted)]">
              {editing
                ? "Drag to rearrange · drag a corner to resize · ＋ to add"
                : userEmail ? `Welcome back, ${userEmail}` : "Your workspace at a glance"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => { setEditing((v) => !v); setResizing(null); setDragIndex(null); }}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors ${
            editing
              ? "bg-[var(--color-accent)] text-white hover:opacity-90"
              : "bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-canvas)]"
          }`}
        >
          {editing ? <><Check className="w-4 h-4" /> Done</> : <><Pencil className="w-4 h-4" /> Customize</>}
        </button>
      </div>

      {/* The 12-column dynamic grid. */}
      <div
        ref={gridRef}
        className="grid gap-4"
        style={{
          gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
          gridAutoRows: `${ROW_UNIT}px`,
          gridAutoFlow: "row dense",
        }}
      >
        {config.widgets.map((widget, index) => {
          const { w, h } = spanOf(widget);
          const isResizingThis = resizing?.id === widget.id;
          const isDraggingThis = dragIndex === index;
          return (
            <div
              key={widget.id}
              className={`relative min-w-0 transition-[opacity] ${isDraggingThis ? "opacity-40" : ""}`}
              style={{ gridColumn: `span ${w}`, gridRow: `span ${h}` }}
              draggable={editing && !resizing}
              onDragStart={(e) => {
                if (!editing) return;
                setDragIndex(index);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!editing || dragIndex === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                // Live reflow: as the dragged tile crosses another, swap order.
                if (dragIndex !== index) {
                  reorder(dragIndex, index);
                  setDragIndex(index);
                }
              }}
              onDrop={(e) => { if (editing) e.preventDefault(); setDragIndex(null); }}
              onDragEnd={() => setDragIndex(null)}
            >
              <WidgetFrame
                widget={widget}
                editing={editing}
                onRemove={() => removeWidget(widget.id)}
                onOpenSettings={() => setSettingsWidget(widget)}
              />

              {/* Corner resize handle (bottom-right). Pointer-driven 2D resize. */}
              {editing && (
                <div
                  role="button"
                  aria-label={`Resize widget (${w} by ${h})`}
                  tabIndex={-1}
                  onPointerDown={(e) => onResizeStart(e, widget)}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeEnd}
                  onPointerCancel={onResizeEnd}
                  onDragStart={(e) => e.preventDefault()}
                  className={`absolute -bottom-1 -right-1 w-6 h-6 z-20 cursor-nwse-resize touch-none flex items-end justify-end p-1 ${isResizingThis ? "scale-110" : ""}`}
                  title="Drag to resize"
                >
                  <span className="block w-4 h-4 rounded-br-lg rounded-tl-sm bg-[var(--color-accent)] shadow-md border border-white/60" style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }} />
                </div>
              )}

              {/* Live size badge while resizing. */}
              {isResizingThis && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 px-2 py-0.5 rounded-md bg-[var(--color-accent)] text-white text-[11px] font-black tabular-nums shadow pointer-events-none">
                  {w} × {h}
                </div>
              )}
            </div>
          );
        })}

        {/* Add tile — always present so empty space invites customization. It
            spans a small footprint and reflows with the dense grid. */}
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          style={{ gridColumn: `span ${isMobile ? GRID_COLS : 3}`, gridRow: "span 2" }}
          className="min-w-0 rounded-2xl border-2 border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors flex flex-col items-center justify-center gap-2"
        >
          <Plus className="w-6 h-6" />
          <span className="text-sm font-bold">Add widget</span>
        </button>
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
  );
}
