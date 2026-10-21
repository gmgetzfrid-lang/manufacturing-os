"use client";

// Shared building blocks for dashboard widget bodies.
//
// The frame hands every body a WidgetContext: its own settings (and a way to
// change them in place — a tab picked inside the widget sticks), a refresh
// signal (the ⟳ button, a 5-minute timer, coming back to the tab), and
// whether it is showing in the expanded full-size view. useWidgetData ties a
// body's fetch to that signal and keeps the last result on screen while it
// refreshes, so a refresh never flashes the card back to a skeleton.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import type { DashboardWidget } from "@/lib/dashboard/types";

export interface WidgetCtx {
  widget: DashboardWidget;
  /** Bumps on every refresh request. */
  refreshKey: number;
  refresh: () => void;
  /** A body reports each completed load (drives "updated 2m ago"). */
  reportLoaded: () => void;
  /** Merge into this widget's saved settings. */
  updateSettings: (patch: Record<string, unknown>) => void;
  /** Rendering inside the expanded (full-size) view. */
  expanded: boolean;
}

const Ctx = createContext<WidgetCtx | null>(null);
export const WidgetContextProvider = Ctx.Provider;

const NOOP_CTX: WidgetCtx = {
  widget: { id: "none", type: "inbox", x: 0, y: 0, w: 1, h: 1 },
  refreshKey: 0, refresh: () => {}, reportLoaded: () => {}, updateSettings: () => {}, expanded: false,
};

export function useWidget(): WidgetCtx {
  return useContext(Ctx) ?? NOOP_CTX;
}

/** A setting of this widget, falling back to `fallback`. */
export function useSetting<T>(key: string, fallback: T): [T, (v: T) => void] {
  const { widget, updateSettings } = useWidget();
  const raw = (widget.settings ?? {})[key];
  const value = (raw === undefined || raw === null ? fallback : raw) as T;
  return [value, (v: T) => updateSettings({ [key]: v })];
}

// In-memory, per-widget state shared by every rendering of the same widget —
// the tile and its expanded view are two mounts of one body, and where you
// were (a folder, the answer you're reading) must carry across. Lives for the
// page session; nothing is saved.
const sessionStore = new Map<string, unknown>();

export function useSessionState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const { widget } = useWidget();
  const full = `${widget.id}:${key}`;
  const [v, setV] = useState<T>(() => (sessionStore.has(full) ? (sessionStore.get(full) as T) : initial));
  const set = useCallback((next: T | ((prev: T) => T)) => {
    setV((prev) => {
      const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      sessionStore.set(full, value);
      return value;
    });
  }, [full]);
  return [v, set];
}

/** Fetch for a widget body. Re-runs when the org/user changes, when the
 *  widget is refreshed, and when any of `deps` changes. Keeps showing the
 *  previous data while a refresh is in flight. */
export function useWidgetData<T>(
  run: (orgId: string, uid: string | null) => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; loading: boolean; refreshing: boolean } {
  const { activeOrgId, uid } = useRole();
  const { refreshKey, reportLoaded } = useWidget();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const runRef = useRef(run);
  const reportRef = useRef(reportLoaded);
  // Declared before the fetch effect, so it runs first in the same commit.
  useEffect(() => { runRef.current = run; reportRef.current = reportLoaded; });
  const depKey = JSON.stringify(deps);
  useEffect(() => {
    let alive = true;
    if (!activeOrgId) return;
    void Promise.resolve().then(() => { if (alive) setRefreshing(true); });
    runRef.current(activeOrgId, uid)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { /* keep what's on screen */ })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
        setRefreshing(false);
        reportRef.current();
      });
    return () => { alive = false; };
  }, [activeOrgId, uid, refreshKey, depKey]);
  return { data, loading: loading && data === null, refreshing };
}

// ─── layout constants ─────────────────────────────────────────────
/** A body root that fills the widget's height so content can flex/scroll. */
export const FILL = "mt-3 flex-1 min-h-0 flex flex-col";
// NOTE: no `overscroll-contain` here — it turns every widget into a wheel
// trap: page scrolling DIES whenever the cursor happens to be over a card.
export const SCROLL = "flex-1 min-h-0 overflow-y-auto pr-1 -mr-1";

export function BodyShell({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 text-sm text-[var(--color-text-muted)]">{children}</div>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="mt-3 flex-1 min-h-0 space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-8 rounded-lg bg-[var(--color-surface-2)] animate-pulse" />
      ))}
    </div>
  );
}

/** Honest empty-state for a chart slot. */
export function Quiet({ label }: { label: string }) {
  return <div className="text-[11px] text-[var(--color-text-faint)] italic py-1.5">{label}</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-[4rem] grid place-items-center text-center px-4 text-[12px] text-[var(--color-text-muted)]">
      <div>{children}</div>
    </div>
  );
}

/** Segmented tabs inside a widget. Counts are optional. */
export function Tabs<T extends string>({ value, onChange, options, className = "" }: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; count?: number }>;
  className?: string;
}) {
  return (
    <div role="tablist" className={`flex items-center gap-1 overflow-x-auto no-scrollbar ${className}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} role="tab" aria-selected={on} type="button" onClick={() => onChange(o.value)}
            className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${
              on
                ? "bg-[var(--color-text)] text-[var(--color-surface)]"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
            }`}>
            {o.label}
            {o.count !== undefined && (
              <span className={`tabular-nums text-[10px] px-1 rounded ${on ? "bg-white/20" : "bg-[var(--color-surface-2)]"}`}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Inline search / quick-jump field. `live` fires onChange as you type. */
export function SearchField({ value, onChange, onSubmit, placeholder, title, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  placeholder: string;
  title?: string;
  autoFocus?: boolean;
}) {
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); const v = value.trim(); if (v && onSubmit) onSubmit(v); }}
      className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 px-2 py-1 focus-within:border-[var(--color-accent)] focus-within:bg-[var(--color-surface)] transition-colors"
      title={title}
    >
      <Search className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
      <input
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none"
      />
    </form>
  );
}

/** Debounced copy of a value (live search without a query per keystroke). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ─── data helpers ─────────────────────────────────────────────────
export async function headCount(build: () => Promise<{ count: number | null }>): Promise<number> {
  try { return (await build()).count ?? 0; } catch { return 0; }
}

/** Timestamps from `table.column` in the last `days` days. Best-effort. */
export async function fetchRecentDates(table: string, orgId: string, days = 14, column = "created_at"): Promise<string[]> {
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data } = await supabase.from(table).select(column).eq("org_id", orgId).gte(column, since).limit(4000);
    return ((data ?? []) as unknown as Array<Record<string, string | null>>).map((r) => r[column]).filter(Boolean) as string[];
  } catch { return []; }
}

/** Split a 14-day date set into this week vs the week before. */
export function weekSplit(dates: string[]): { cur: number; prev: number } {
  const now = Date.now();
  let cur = 0, prev = 0;
  for (const d of dates) {
    const age = now - new Date(d).getTime();
    if (age <= 7 * 86_400_000) cur++;
    else if (age <= 14 * 86_400_000) prev++;
  }
  return { cur, prev };
}

export function timeAgo(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "";
  const t = typeof iso === "number" ? iso : new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);
