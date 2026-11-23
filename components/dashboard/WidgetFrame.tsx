"use client";

// WidgetFrame — the shared shell every dashboard widget renders inside.
//
// Visual: a section, not a card. Its name is a heading on the grey panel with
// its tools on the right; its content sits on one white sheet below.
//
// Behaviour every widget gets for free:
//   • ⟳ refresh (plus every 5 minutes, and on coming back to the tab after a
//     minute away), with "updated 2m ago" on hover
//   • ⚙ settings — any time, not only while customizing (rename, filters,
//     which library…)
//   • ⤢ expand — the same widget full-size over the dashboard, for real work
//     (browse a library, read a full answer) without leaving the page
//   • its own title, when the person renamed this instance
//
// `bare` widgets (the Command Deck) supply their own heading and sheet; the
// frame only adds the edit controls over them.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { GripVertical, X, Settings2, RotateCw, Maximize2 } from "lucide-react";
import type { DashboardWidget } from "@/lib/dashboard/types";
import { friendlyError } from "@/lib/friendlyError";
import { WIDGET_CATALOG } from "./widgets";
import { WidgetContextProvider, timeAgo, type WidgetCtx } from "./kit";

interface Props {
  widget: DashboardWidget;
  editing: boolean;
  /** In the page: a set height, or a cap on the content's height. Without
   *  it the frame fills its parent (a cell of the editor's grid). */
  size?: { height?: number; maxHeight?: number };
  onRemove: () => void;
  onOpenSettings: () => void;
  onUpdateSettings: (patch: Record<string, unknown>) => void;
}

const AUTO_REFRESH_MS = 5 * 60_000;

export default function WidgetFrame({ widget, editing, size, onRemove, onOpenSettings, onUpdateSettings }: Props) {
  const meta = WIDGET_CATALOG[widget.type];
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // A body's failed load, said on the card instead of an empty-looking body.
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadedAtRef = useRef<number | null>(null);
  const reportError = useCallback((m: string | null) => { setLoadError(m); if (m) setSpinning(false); }, []);

  const refresh = useCallback(() => { setSpinning(true); setRefreshKey((k) => k + 1); }, []);
  const reportLoaded = useCallback(() => {
    const now = Date.now();
    loadedAtRef.current = now;
    setLoadedAt(now);
    setSpinning(false);
  }, []);

  // Stay current on its own: a timer, and a catch-up when the tab comes back.
  useEffect(() => {
    const t = setInterval(() => setRefreshKey((k) => k + 1), AUTO_REFRESH_MS);
    const onVis = () => {
      if (document.visibilityState === "visible" && loadedAtRef.current && Date.now() - loadedAtRef.current > 60_000) {
        setRefreshKey((k) => k + 1);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const ctx = useMemo<WidgetCtx>(() => ({
    widget, refreshKey, refresh, reportLoaded, reportError, updateSettings: onUpdateSettings, expanded: false, editing,
  }), [widget, refreshKey, refresh, reportLoaded, reportError, onUpdateSettings, editing]);
  const expandedCtx = useMemo<WidgetCtx>(() => ({ ...ctx, expanded: true }), [ctx]);

  if (!meta) return null;
  const Body = meta.Body;
  const title = (typeof widget.settings?.title === "string" && widget.settings.title.trim()) || meta.title;

  // ── Bare widgets bring their own heading and sheet (the Command Deck) ──
  if (meta.bare) {
    return (
      <WidgetContextProvider value={ctx}>
        <div className={`group/widget relative h-full ${editing ? "rounded-panel outline-2 outline-dashed outline-offset-4 outline-[var(--color-border-strong)]" : ""}`}>
          <div className={editing ? "h-full pointer-events-none" : "h-full"}>
            <Body widget={widget} />
          </div>
          {editing && (
            <div data-no-drag className="absolute top-0 right-0 z-20 h-9 flex items-center gap-1">
              <GripVertical className="w-4 h-4 mx-1 text-[var(--color-text-muted)]" aria-hidden />
              <button type="button" onClick={onRemove} title="Remove widget" aria-label="Remove widget"
                className="w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] hover:bg-[var(--color-surface)] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </WidgetContextProvider>
    );
  }

  const iconBtn = "w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors";

  // The section's name is a heading on the page, as text (its description
  // rides along as a tooltip); the tools sit on the right.
  const header = (isExpanded: boolean) => (
    <div className={`flex items-center gap-2 shrink-0 min-h-9 ${isExpanded ? "" : "mb-3"}`}>
      {editing && <GripVertical className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" aria-hidden />}
      <h2 title={meta.description} className="min-w-0 flex-1 truncate font-display text-section font-semibold text-[var(--color-text)]">{title}</h2>
      {editing ? (
        <div data-no-drag className="shrink-0 flex items-center gap-1">
          <button type="button" onClick={onOpenSettings} title="Widget settings" aria-label="Widget settings" className={iconBtn}>
            <Settings2 className="w-4 h-4" />
          </button>
          <button type="button" onClick={onRemove} title="Remove widget" aria-label="Remove widget"
            className={`${iconBtn} hover:!text-[var(--state-overdue-text)]`}>
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="shrink-0 flex items-center gap-0.5">
          <button type="button" onClick={refresh} className={iconBtn} aria-label="Refresh"
            title={loadedAt ? `Refresh (updated ${timeAgo(loadedAt) === "now" ? "just now" : `${timeAgo(loadedAt)} ago`})` : "Refresh"}>
            <RotateCw className={`w-4 h-4 ${spinning ? "animate-spin" : ""}`} />
          </button>
          <button type="button" onClick={onOpenSettings} className={iconBtn} aria-label="Widget settings" title="Widget settings: rename, filters">
            <Settings2 className="w-4 h-4" />
          </button>
          {!isExpanded && (
            <button type="button" onClick={() => setExpanded(true)} className={iconBtn} aria-label="Expand" title="Work in it full size">
              <Maximize2 className="w-4 h-4" />
            </button>
          )}
          <Link href={meta.href} aria-label={meta.cta} title={meta.cta}
            className="ml-2 text-[14px] font-semibold text-[var(--color-accent-text)] hover:underline underline-offset-2">
            Open
          </Link>
          {isExpanded && (
            <button type="button" onClick={() => setExpanded(false)} className={`${iconBtn} ml-1`} aria-label="Close" title="Close (Esc)">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
  const errorLine = loadError ? (
    <p role="alert" className="mb-3 flex flex-wrap items-baseline gap-x-2 text-[14px]">
      <span className="font-semibold text-[var(--state-overdue-text)]">This didn&apos;t load.</span>
      <span className="text-[var(--color-text-muted)]">{friendlyError(loadError)}</span>
      <button type="button" onClick={refresh} className="font-semibold text-[var(--color-accent-text)] hover:underline underline-offset-2">Try again</button>
    </p>
  ) : null;

  return (
    <WidgetContextProvider value={ctx}>
      <section
        aria-label={title}
        style={size}
        className={`group/widget relative flex flex-col min-w-0 ${size ? "" : "h-full"} ${
          editing ? "rounded-panel outline-2 outline-dashed outline-offset-4 outline-[var(--color-border-strong)]" : ""}`}
      >
        {header(false)}
        <div className="relative flex-1 min-h-0 flex flex-col rounded-panel border border-[var(--color-border)] bg-[var(--color-surface)] p-4 overflow-hidden">
          {!expanded && errorLine}
          {/* While expanded, the full-size copy is the live one: the tile
              doesn't fetch the same data twice. */}
          {expanded ? (
            <button type="button" onClick={() => setExpanded(false)}
              className="flex-1 min-h-[6rem] grid place-items-center rounded-md text-[14px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              Open full size. Select to bring it back here.
            </button>
          ) : (
            <div className={`flex-1 min-h-0 flex flex-col ${editing ? "pointer-events-none" : ""}`}>
              <Body widget={widget} />
            </div>
          )}
        </div>
      </section>

      {expanded && typeof document !== "undefined" && createPortal(
        <WidgetContextProvider value={expandedCtx}>
          <div className="fixed inset-0 z-[200] flex items-stretch justify-center p-2 sm:p-6 lg:p-10">
            <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)]" onClick={() => setExpanded(false)} />
            <div role="dialog" aria-modal="true" aria-label={title}
              className="group/widget relative w-full max-w-6xl flex flex-col rounded-panel bg-[var(--color-canvas)] ui-float ui-float-in overflow-hidden">
              <div className="px-4 sm:px-5 pt-3 pb-3 border-b border-[var(--color-border-strong)]">{header(true)}</div>
              <div className="relative flex-1 min-h-0 flex flex-col p-4 sm:p-5 bg-[var(--color-surface)]">
                {errorLine}
                <div className="flex-1 min-h-0 flex flex-col">
                  <Body widget={widget} />
                </div>
              </div>
            </div>
          </div>
        </WidgetContextProvider>,
        document.body,
      )}
    </WidgetContextProvider>
  );
}
