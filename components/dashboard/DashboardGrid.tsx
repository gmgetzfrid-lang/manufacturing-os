"use client";

// Customizable Home: a control-room overview.
//
// The header answers "what needs me": the date as the kicker (no
// greeting), the answer as the title, ONE large number (overdue when
// anything is, else what waits on you) and the rest small. Under it: a new
// workspace's setup checklist (admins, until the essentials are done), the
// "Needs you" table, the libraries (wide, about 62%) beside your projects
// (narrow, about 38%), then the widgets, each a full-width section (its
// heading on the page, its content on a white sheet), top to bottom in the
// order the person chose.
//
// "Customize" arranges that order: drag a widget up or down (a dashed
// placeholder shows where it lands and the rest re-flows live), drag its
// corner to make it taller or shorter, remove it, or open its settings.
// Widgets always run the full width, so a layout saved side by side by an
// older version is shown, and edited, as one column in its own order.
// On a phone the editor can't drag; it still removes and opens settings.

import { sharedLoad, dashKey, lastLoaded } from "@/lib/warmLoads";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import SetupChecklist from "@/components/onboarding/SetupChecklist";
import { Pencil, Check, Plus, Move } from "lucide-react";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { friendlyError } from "@/lib/friendlyError";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { useTicketNotifications } from "@/hooks/useTicketNotifications";
import { buildNeeds, needsFacts } from "@/components/cockpit/needsYou";
import HomeStrips from "@/components/cockpit/HomeStrips";
import type { DashboardConfig, DashboardWidget, WidgetType } from "@/lib/dashboard/types";
import {
  loadDashboardConfig, saveDashboardConfig, newWidgetId, GRID_COLS, localDashboardConfig,
} from "@/lib/dashboard/config";
import { moveElement, resizeElement, firstFreeSlot, bottomRow } from "@/lib/dashboard/layout";
import { WIDGET_CATALOG } from "./widgets";
import WidgetFrame from "./WidgetFrame";
import AddWidgetModal from "./AddWidgetModal";
import { plainDate } from "@/lib/asks";
import WidgetSettingsModal from "./WidgetSettingsModal";

// Grid geometry. ROW_UNIT is the height of one `h` unit; GAP is the grid gap.
const ROW_UNIT = 84; // px — matches gridAutoRows
const GAP = 16; // px — matches gap-4
const MD_BREAKPOINT = 768; // below this, the editor can't drag or resize
/** Widgets that need a set height to work (a map beside a list); the rest
 *  take the height of their content, up to the height the person gave them. */
const FIXED_HEIGHT = new Set<WidgetType>(["documentControl"]);
/** The section heading row above each widget's sheet. */
const HEAD = 46;

/** One column, in reading order: every widget full width, stacked in the
 *  order it had (top to bottom, then left to right). Pure. */
function asColumn(widgets: DashboardWidget[]): DashboardWidget[] {
  let y = 0;
  return [...widgets].sort((a, b) => a.y - b.y || a.x - b.x).map((w) => {
    const out = { ...w, x: 0, w: GRID_COLS, y };
    y += w.h;
    return out;
  });
}

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
const dateLineNow = () =>
  new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

export default function DashboardGrid() {
  const { uid, hasAnyRole } = useRole();
  const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);
  // What waits on you: the same feed as the bell and the sidebar badge, so
  // the header's answer never disagrees with them.
  const { count: attnCount, items: attnItems, loading: attnLoading, loadError: attnError } = useTicketNotifications();
  const needs = useMemo(() => buildNeeds(attnItems), [attnItems]);
  const facts = needsFacts(needs);

  // The layout read for this visit; until it answers, the one last read
  // (at sign-in, or Home opened before, or this device's copy), so Home
  // opens with its widgets in place and changes only if the account's
  // layout changed elsewhere.
  const [ownConfig, setOwnConfig] = useState<DashboardConfig | null>(null);
  const kept = useMemo(() => {
    if (!uid || ownConfig) return null;
    const cfg = lastLoaded<DashboardConfig>(dashKey(uid)) ?? localDashboardConfig(uid);
    return cfg && cfg.widgets.length ? { ...cfg, widgets: asColumn(cfg.widgets) } : null;
  }, [uid, ownConfig]);
  const config = ownConfig ?? kept;
  const loaded = !!config;
  const keptRef = useRef<DashboardConfig | null>(null);
  useEffect(() => { keptRef.current = kept; }, [kept]);
  // Changes start from what's on screen, even while the read is on its way.
  const setConfig = useCallback((next: DashboardConfig | null | ((prev: DashboardConfig | null) => DashboardConfig | null)) => {
    setOwnConfig((prev) => (typeof next === "function" ? next(prev ?? keptRef.current) : next));
  }, []);
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsWidget, setSettingsWidget] = useState<DashboardWidget | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resizing, setResizing] = useState<ResizeState | null>(null);

  // The date is a LOCAL-TIME value. The page is statically prerendered, so
  // computing it during render bakes in the build machine's clock and
  // mismatches the browser at hydration (React #418).
  // useSyncExternalStore: deterministic server snapshot, browser value after.
  const dateLine = useSyncExternalStore(subscribeNever, dateLineNow, () => "");

  const [gridWidth, setGridWidth] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);

  // CALLBACK ref, not ref+effect: an effect would run once during the
  // loading commit, before the wrapper exists, and never again. A callback
  // ref fires when the node actually mounts (before paint), so the first
  // painted layout is already the right branch.
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
    // The layout sign-in already asked for, when it did.
    sharedLoad(dashKey(uid), () => loadDashboardConfig(uid), { maxAgeMs: 5000 }).then((cfg) => {
      // Shown, and edited, as one full-width column in its own order. The
      // stored layout only changes when the person changes something.
      if (alive) setConfig((prev) => {
        const next = { ...cfg, widgets: asColumn(cfg.widgets) };
        // The same layout as on screen: keep it (widgets don't re-mount).
        return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
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

  const addWidget = (type: WidgetType) => {
    if (!config) return;
    const meta = WIDGET_CATALOG[type];
    // Full width, at the bottom.
    const widget: DashboardWidget = { id: newWidgetId(), type, x: 0, y: bottomRow(config.widgets), w: GRID_COLS, h: meta.defaultH, settings: {} };
    mutate({ ...config, widgets: [...config.widgets, widget] });
  };
  const removeWidget = (id: string) => {
    if (!config) return;
    // Drop it, then close the gap it left.
    mutate({ ...config, widgets: asColumn(config.widgets.filter((w) => w.id !== id)) });
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
    const dy = e.clientY - d.startY;
    const ty = d.origY + (d.unitH > 0 ? Math.round(dy / d.unitH) : 0);
    // Full width: only up and down.
    const next = moveElement(d.base, d.id, 0, Math.max(0, ty), GRID_COLS);
    d.last = next;
    const m = next.find((w) => w.id === d.id)!;
    // Render others at their re-flowed slots, but keep the dragged one pinned
    // to its ORIGIN cell so the translate ghost tracks the cursor cleanly.
    const rendered = next.map((w) => (w.id === d.id ? { ...w, x: d.origX, y: d.origY } : w));
    setConfig((prev) => (prev ? { ...prev, widgets: rendered } : prev));
    setDrag({ id: d.id, dx: 0, dy, x: m.x, y: m.y, w: m.w, h: m.h });
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

  // ── Resize (pointer-driven: the bottom edge sets the height) ──────────────
  const resizePointer = useRef<{
    id: string; startY: number; startH: number;
    minH: number; unitH: number;
    base: DashboardWidget[]; last: DashboardWidget[];
  } | null>(null);

  const onResizeStart = (e: React.PointerEvent, widget: DashboardWidget) => {
    if (!config) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const meta = WIDGET_CATALOG[widget.type];
    resizePointer.current = {
      id: widget.id, startY: e.clientY, startH: widget.h,
      minH: meta?.minH ?? 1, unitH: ROW_UNIT + GAP, base: config.widgets, last: config.widgets,
    };
    setResizing({ id: widget.id, w: widget.w, h: widget.h });
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const rp = resizePointer.current;
    if (!rp) return;
    const dh = rp.unitH > 0 ? Math.round((e.clientY - rp.startY) / rp.unitH) : 0;
    const nextH = Math.max(rp.minH, rp.startH + dh);
    const next = resizeElement(rp.base, rp.id, GRID_COLS, nextH, GRID_COLS);
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

  // ── The header: the answer, the counts behind it, the one thing named. ──
  const lead = needs[0];
  const failed = !!attnError && attnCount === 0;
  const answer = failed
    ? "Couldn't check what needs you."
    : attnLoading && attnCount === 0
      ? "Home"
      : attnCount > 0
        ? `${attnCount.toLocaleString()} ${attnCount === 1 ? "thing needs" : "things need"} you.`
        : "Nothing needs you right now.";
  const sub = (() => {
    if (failed) return <>The list of what waits on you didn&apos;t load. {friendlyError(attnError)}</>;
    if (!lead) return attnLoading ? null : "No requests, reviews or alerts are waiting on you.";
    const todo = lead.todo && !/^[A-Z]{2}/.test(lead.todo) ? lead.todo.charAt(0).toLowerCase() + lead.todo.slice(1) : lead.todo;
    // When it has a date, say it: "overdue since Nov 12", "due Nov 29".
    const when = lead.due ? (lead.overdue ? `, overdue since ${plainDate(lead.due)}` : `, due ${plainDate(lead.due)}`) : "";
    return <>First up: {lead.ref ? <span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{lead.ref} </span> : null}<span className="text-[var(--color-text)]">{lead.name}</span>{todo ? `, ${todo}` : ""}{when}.</>;
  })();
  const showFacts = !failed && !(attnLoading && attnCount === 0);

  const band = (
    <PageHero
      kicker={dateLine || "Home"}
      title={answer}
      sub={sub}
      // One large number: what is late when anything is, else what waits
      // on you. The others small; zeros muted.
      facts={showFacts ? [
        { label: "Overdue", value: facts.overdue, tone: facts.overdue > 0 ? "bad" : undefined, hero: facts.overdue > 0 },
        { label: "Waiting on you", value: facts.yourTurn, hero: facts.overdue === 0 && facts.yourTurn > 0 },
        { label: "Due this week", value: facts.dueSoon, tone: facts.dueSoon > 0 ? "warn" : undefined },
      ] : undefined}
      factsHero={showFacts && facts.overdue + facts.yourTurn > 0 ? "auto" : "none"}
      tools={loaded && config ? (
        <>
          <button type="button" onClick={() => setAddOpen(true)} className={heroQuiet} aria-label="Add widget">
            <Plus className="w-4 h-4" /><span className="max-sm:hidden">Add widget</span>
          </button>
          {!editing && (
            <button type="button" onClick={() => { setEditing(true); setResizing(null); setDrag(null); }} aria-pressed={false} className={heroQuiet} aria-label="Customize">
              <Pencil className="w-4 h-4" /><span className="max-sm:hidden">Customize</span>
            </button>
          )}
        </>
      ) : undefined}
      primary={editing
        ? <button type="button" onClick={() => { setEditing(false); setResizing(null); setDrag(null); }} aria-pressed className={heroPrimary}><Check className="w-4 h-4" /> Done</button>
        : lead ? <Link href={lead.link} className={heroPrimary}>{attnCount === 1 ? "Open it" : "Open the first one"}</Link> : undefined}
    >
      {(editing || saveErr) && (
        <div className="space-y-1.5 text-body">
          {editing && (
            <p className="text-[var(--color-text-muted)]">
              {isMobile
                // Phones can't drag or resize; telling them to reads as broken.
                ? "Remove widgets or change their settings here. Move and resize them on a larger screen. Changes save as you go."
                : "Drag a widget to move it, its bottom corner to change its height. Changes save as you go."}
            </p>
          )}
          {saveErr && <p role="alert" className="font-medium text-[var(--state-held-text)]">Your layout is saved on this device only, so it won&apos;t follow you to another one. {friendlyError(saveErr)}</p>}
        </div>
      )}
    </PageHero>
  );

  if (!loaded || !config) {
    return (
      <PageShell width="full">
        <div className="mx-auto max-w-[1720px]">
          {band}
          <PageBody>
            <SkeletonRows rows={5} cols={2} what="your Home" />
          </PageBody>
        </div>
      </PageShell>
    );
  }

  const existingTypes = config.widgets.map((w) => w.type);
  const ordered = [...config.widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  const occupiedRows = bottomRow(config.widgets);
  // A few spare rows in edit mode give obvious empty space to drop into.
  const backdropRows = occupiedRows + 3;
  const addSlot = firstFreeSlot(config.widgets, GRID_COLS, 2, GRID_COLS);
  const heightOf = (w: DashboardWidget) => w.h * ROW_UNIT + (w.h - 1) * GAP;

  const frame = (widget: DashboardWidget, size?: { height?: number; maxHeight?: number }) => (
    <WidgetFrame
      widget={widget}
      editing={editing}
      size={size}
      onRemove={() => removeWidget(widget.id)}
      onOpenSettings={() => setSettingsWidget(widget)}
      onUpdateSettings={(patch) => updateWidgetSettings(widget.id, patch)}
    />
  );

  // A widget in the page: full width, its content's height up to the height
  // it was given (or exactly that, for the ones that need it).
  const section = (w: DashboardWidget) => {
    const meta = WIDGET_CATALOG[w.type];
    if (!meta) return null;
    if (meta.bare) return <div key={w.id}>{frame(w)}</div>;
    const h = heightOf(w) + HEAD;
    // On a phone the list and the map stack, so it takes their height.
    return FIXED_HEIGHT.has(w.type) && !isMobile
      ? <div key={w.id} style={{ height: h }}>{frame(w)}</div>
      : <div key={w.id}>{frame(w, { maxHeight: Math.max(h, isMobile ? 720 : 340) })}</div>;
  };

  // "Needs you" at the top is followed by your libraries and projects; if
  // something else leads, those come after the widgets.
  const deckLeads = ordered[0]?.type === "commandDeck";

  return (
    <PageShell width="full">
      <div className="mx-auto max-w-[1720px]">
      {band}
      <PageBody>
      {/* A new workspace (admins): the checklist first, step 1 already
          done; it hides itself once the essentials are in. */}
      {!editing && <SetupChecklist />}
      {/* Stable measuring wrapper: keeps the ResizeObserver attached across
          view and edit, so the phone breakpoint stays live. */}
      <div ref={gridRef} className="relative">
      {!editing ? (
        <div className="space-y-8">
          {ordered.map((w, i) => (
            <React.Fragment key={w.id}>
              {section(w)}
              {i === 0 && deckLeads && <HomeStrips />}
            </React.Fragment>
          ))}
          {!deckLeads && <HomeStrips />}
        </div>
      ) : isMobile ? (
        // ── Phone editor: one column, remove and settings only ──
        <div className="flex flex-col gap-4">
          {ordered.map((widget) => (
            <div key={widget.id} style={{ height: Math.max(heightOf(widget), 300) }} className="relative min-w-0">
              {frame(widget)}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="min-w-0 h-24 rounded-lg border-2 border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors flex flex-col items-center justify-center gap-1"
          >
            <Plus className="w-5 h-5" />
            <span className="text-body font-medium">Add widget</span>
          </button>
        </div>
      ) : (
        // ── Desktop editor: one full-width column on the grid's rows ──
        <div
          className="relative grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
            gridAutoRows: `${ROW_UNIT}px`,
          }}
        >
          {/* Ruled rows behind everything: each one a place to drop into. */}
          {Array.from({ length: backdropRows }).map((_, r) => (
            <div
              key={`bg-${r}`}
              aria-hidden
              style={{ gridColumn: `1 / span ${GRID_COLS}`, gridRow: `${r + 1} / span 1`, zIndex: 0 }}
              className="rounded-md border border-dashed border-[var(--color-border-strong)]/70 pointer-events-none"
            />
          ))}

          {/* Drop placeholder: where the dragged widget will land. */}
          {drag && (
            <div
              aria-hidden
              style={{ gridColumn: `1 / span ${GRID_COLS}`, gridRow: `${drag.y + 1} / span ${drag.h}`, zIndex: 5 }}
              className="rounded-lg border-2 border-dashed border-[var(--color-text-faint)] bg-[var(--color-surface-2)] pointer-events-none transition-all"
            />
          )}

          {ordered.map((widget) => {
            const isDragging = drag?.id === widget.id;
            const isResizingThis = resizing?.id === widget.id;
            const liveH = isResizingThis ? resizing!.h : widget.h;
            return (
              <div
                key={widget.id}
                onPointerDown={(e) => onWidgetPointerDown(e, widget)}
                onPointerMove={onWidgetPointerMove}
                onPointerUp={onWidgetPointerUp}
                onPointerCancel={onWidgetPointerUp}
                style={{
                  gridColumn: `1 / span ${GRID_COLS}`,
                  gridRow: `${widget.y + 1} / span ${liveH}`,
                  transform: isDragging ? `translate(0px, ${drag!.dy}px)` : undefined,
                  zIndex: isDragging ? 30 : 10,
                  cursor: !isResizingThis ? (isDragging ? "grabbing" : "grab") : undefined,
                }}
                className={`group/tile relative min-w-0 ${isDragging ? "ui-float rounded-panel" : ""} ${
                  (drag && !isDragging) || (resizing && !isResizingThis) ? "transition-[grid-row] duration-150" : ""
                }`}
              >
                {frame(widget)}

                {/* Bottom-right handle: drag it to change the height. */}
                <div
                  role="button"
                  data-no-drag
                  aria-label={`Resize widget (${liveH} rows tall)`}
                  tabIndex={-1}
                  onPointerDown={(e) => onResizeStart(e, widget)}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeEnd}
                  onPointerCancel={onResizeEnd}
                  className={`absolute -bottom-1 -right-1 w-6 h-6 z-20 cursor-ns-resize touch-none flex items-end justify-end p-1 ${isResizingThis ? "scale-110" : ""}`}
                  title="Drag to change the height"
                >
                  <span className="block w-4 h-4 rounded-br-md rounded-tl-sm bg-[var(--color-text-faint)]" style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }} />
                </div>

                {/* Live height while resizing. */}
                {isResizingThis && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 px-2 py-0.5 rounded-md bg-[var(--color-text)] text-[var(--color-surface)] text-body font-medium tabular-nums pointer-events-none">
                    {liveH} rows tall
                  </div>
                )}

                {/* Drag hint (idle). */}
                {!isDragging && !isResizingThis && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-2 py-0.5 rounded-md bg-[var(--color-text)] text-[var(--color-surface)] text-body font-medium inline-flex items-center gap-1 opacity-0 group-hover/tile:opacity-100 transition-opacity pointer-events-none">
                    <Move className="w-3.5 h-3.5" /> Drag to move
                  </div>
                )}
              </div>
            );
          })}

          {/* Add: the first free row, inviting another widget. */}
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            style={{ gridColumn: `1 / span ${GRID_COLS}`, gridRow: `${addSlot.y + 1} / span 1`, zIndex: 10 }}
            className="min-w-0 rounded-lg border-2 border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5" />
            <span className="text-body font-medium">Add widget</span>
          </button>
        </div>
      )}
      </div>
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
