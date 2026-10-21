"use client";

// WidgetFrame — the shared shell every dashboard widget renders inside.
//
// Visual: the Command Deck's "console" flare — ambient tone-tinted corner
// glows, a vivid gradient top-rule, a glowing gradient icon badge, depth.
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
// `bare` widgets (the Command Deck) supply their OWN hero shell; the frame
// only floats the edit affordances over them.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { GripVertical, X, Settings2, ChevronRight, RotateCw, Maximize2, Minimize2 } from "lucide-react";
import type { DashboardWidget } from "@/lib/dashboard/types";
import { WIDGET_CATALOG, toneGradient, toneWash, toneGlow } from "./widgets";
import { WidgetContextProvider, timeAgo, type WidgetCtx } from "./kit";

interface Props {
  widget: DashboardWidget;
  editing: boolean;
  onRemove: () => void;
  onOpenSettings: () => void;
  onUpdateSettings: (patch: Record<string, unknown>) => void;
}

const AUTO_REFRESH_MS = 5 * 60_000;

export default function WidgetFrame({ widget, editing, onRemove, onOpenSettings, onUpdateSettings }: Props) {
  const meta = WIDGET_CATALOG[widget.type];
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const loadedAtRef = useRef<number | null>(null);

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
    widget, refreshKey, refresh, reportLoaded, updateSettings: onUpdateSettings, expanded: false,
  }), [widget, refreshKey, refresh, reportLoaded, onUpdateSettings]);
  const expandedCtx = useMemo<WidgetCtx>(() => ({ ...ctx, expanded: true }), [ctx]);

  if (!meta) return null;
  const Icon = meta.icon;
  const Body = meta.Body;
  const title = (typeof widget.settings?.title === "string" && widget.settings.title.trim()) || meta.title;

  // ── Bare widgets bring their own shell (e.g. the Command Deck hero) ──
  if (meta.bare) {
    return (
      <WidgetContextProvider value={ctx}>
        <div className="group/widget relative h-full">
          <div className={editing ? "h-full pointer-events-none" : "h-full"}>
            <Body widget={widget} />
          </div>
          {editing && (
            <>
              <GripVertical className="absolute top-3 left-3 z-20 w-4 h-4 text-white/70 drop-shadow pointer-events-none" />
              <div data-no-drag className="absolute top-3 right-3 z-20 flex items-center gap-1">
                <button type="button" onClick={onRemove} title="Remove widget"
                  className="p-1.5 rounded-lg bg-black/40 backdrop-blur text-white/80 hover:text-white hover:bg-black/60 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </>
          )}
        </div>
      </WidgetContextProvider>
    );
  }

  const [glowA, glowB] = toneGlow(meta.tone);
  const iconBtn = "p-2 sm:p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors";

  const header = (isExpanded: boolean) => (
    <div className="flex items-center gap-3 shrink-0">
      <span className={`relative inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${toneGradient(meta.tone)} text-white shadow-lg ring-1 ring-white/20 shrink-0`}>
        <span aria-hidden className={`pointer-events-none absolute -inset-1 rounded-2xl blur-md opacity-50 bg-gradient-to-br ${toneGradient(meta.tone)}`} />
        <Icon className="relative w-5 h-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-black text-[var(--color-text)] tracking-tight truncate">{title}</h3>
        <p className="text-[11px] text-[var(--color-text-muted)] truncate">{meta.description}</p>
      </div>
      {!editing && (
        <div className="shrink-0 flex items-center gap-0.5 opacity-70 group-hover/widget:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
          <button type="button" onClick={refresh} className={iconBtn}
            title={loadedAt ? `Refresh — updated ${timeAgo(loadedAt) === "now" ? "just now" : `${timeAgo(loadedAt)} ago`}` : "Refresh"}>
            <RotateCw className={`w-3.5 h-3.5 ${spinning ? "animate-spin" : ""}`} />
          </button>
          <button type="button" onClick={onOpenSettings} className={iconBtn} title="Widget settings — rename, filters…">
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <button type="button" onClick={() => setExpanded((v) => !v)} className={iconBtn}
            title={isExpanded ? "Back to the dashboard (Esc)" : "Expand — work in it full-size"}>
            {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <Link href={meta.href} title={meta.cta}
            className="ml-0.5 inline-flex items-center gap-1 pl-2 pr-1.5 py-2 sm:py-1.5 rounded-lg text-[11px] font-bold text-[var(--color-text-muted)] border border-transparent hover:border-[var(--color-border)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-2)] transition-all">
            Open
            <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover/widget:translate-x-0.5" />
          </Link>
        </div>
      )}
    </div>
  );

  return (
    <WidgetContextProvider value={ctx}>
      <div
        className={`group/widget relative flex flex-col h-full rounded-2xl border overflow-hidden transition-all duration-300 bg-[var(--color-surface)] ${
          editing
            ? "border-dashed border-[var(--color-accent)] shadow-sm"
            // View mode: no hard border — the card FLOATS on the canvas. No
            // hover translate: cards jumping as the wheel sweeps across them
            // read as a scroll glitch.
            : "border-transparent ring-1 ring-slate-900/[0.05] dark:ring-white/[0.07] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-8px_rgba(15,23,42,0.10)] hover:shadow-[0_2px_4px_rgba(15,23,42,0.05),0_16px_40px_-8px_rgba(15,23,42,0.16)] hover:ring-slate-900/[0.09] dark:hover:ring-white/[0.12]"
        }`}
      >
        <div aria-hidden className={`pointer-events-none absolute -top-16 -right-12 w-40 h-40 rounded-full blur-3xl ${glowA} opacity-20 group-hover/widget:opacity-60 transition-opacity duration-500`} />
        <div aria-hidden className={`pointer-events-none absolute -bottom-20 -left-12 w-40 h-40 rounded-full blur-3xl ${glowB} opacity-0 group-hover/widget:opacity-45 transition-opacity duration-500`} />
        <div className={`pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b ${toneWash(meta.tone)} to-transparent`} />
        <div aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r ${toneGradient(meta.tone)} opacity-90`} />

        {editing && (
          <>
            <GripVertical className="absolute top-4 left-2 w-4 h-4 text-[var(--color-text-muted)]/60 z-10 pointer-events-none" />
            <div data-no-drag className="absolute top-2 right-2 flex items-center gap-1.5 z-10 rounded-xl bg-[var(--color-surface)]/85 backdrop-blur border border-[var(--color-border)] px-0.5 py-0.5">
              <button type="button" onClick={onOpenSettings} title="Widget settings"
                className="p-2.5 sm:p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
                <Settings2 className="w-4 h-4" />
              </button>
              <button type="button" onClick={onRemove} title="Remove widget"
                className="p-2.5 sm:p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </>
        )}

        <div className={`relative flex-1 min-h-0 flex flex-col p-5 ${editing ? "pl-7 pr-16" : ""}`}>
          {header(false)}
          {/* While expanded, the full-size copy is the live one — the tile
              doesn't fetch the same data twice. */}
          {expanded ? (
            <button type="button" onClick={() => setExpanded(false)}
              className="mt-3 flex-1 min-h-0 grid place-items-center rounded-xl border border-dashed border-[var(--color-border)] text-[12px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">
              Open in the expanded view — click to bring it back here
            </button>
          ) : (
            <div className={`flex-1 min-h-0 flex flex-col ${editing ? "pointer-events-none opacity-90" : ""}`}>
              <Body widget={widget} />
            </div>
          )}
        </div>
      </div>

      {expanded && typeof document !== "undefined" && createPortal(
        <WidgetContextProvider value={expandedCtx}>
          <div className="fixed inset-0 z-[200] flex items-stretch justify-center p-2 sm:p-6 lg:p-10">
            <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setExpanded(false)} />
            <div role="dialog" aria-label={title}
              className="group/widget relative w-full max-w-6xl flex flex-col rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl overflow-hidden">
              <div aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r ${toneGradient(meta.tone)}`} />
              <div className="relative flex-1 min-h-0 flex flex-col p-5 sm:p-6">
                {header(true)}
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
