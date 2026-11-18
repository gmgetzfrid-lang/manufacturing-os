"use client";

import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from "react";
import { X, CheckCircle, AlertCircle, Info, Bell } from "lucide-react";
import { CornerPortal, useDockAllowances, DOCK_PRIORITY } from "@/components/ui/CornerDock";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
  /** Two toasts with the same key inside COALESCE_WINDOW_MS are one card
   *  with a count (RT-11 / OS-4). Defaults to the toast's own content —
   *  type, title and message — so a repeat of the same message coalesces;
   *  a producer that knows its event (kind + resource) passes that. */
  coalesceKey?: string;
  /** One optional button on the card (TAX-9: the burst summary's "Open
   *  notifications"). Clicking it runs `onClick` and dismisses the card. It
   *  is not part of the coalesce key; a merge keeps the newest arrival's. */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Shown extends Toast {
  key: string;
  /** How many arrivals this card stands for. */
  count: number;
  /** When the last of them arrived. */
  at: number;
  /** Whether the arrivals merged into this card said different things (a
   *  producer key, not the content key). The card shows the newest words. */
  varied: boolean;
}

interface ToastContextValue {
  showToast: (props: Omit<Toast, "id">) => void;
}

/** Identical toasts arriving within this window coalesce into one card. */
export const COALESCE_WINDOW_MS = 10_000;

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function toastCoalesceKey(t: Pick<Toast, "type" | "title" | "message" | "coalesceKey">): string {
  return t.coalesceKey ?? `${t.type}\u0000${t.title}\u0000${t.message ?? ""}`;
}

/** The newest `allowance` toasts are the ones within the visible stack. */
/** A coalesce merge (RT-11 / OS-4 refinement, notifications N13): the card
 *  moves to the newest place with its count raised, and shows the NEWEST
 *  arrival's words, tone and action — a producer key that joins differently
 *  worded rows about one event never hides the newer row behind the first.
 *  Under the content key (type, title, message) every arrival is word-for-word
 *  the same, so such a card reads exactly as before. */
export function mergeToast(
  same: Shown,
  next: Pick<Toast, "type" | "title" | "message" | "duration" | "action">,
  at: number,
): Shown {
  const varied = same.varied || same.type !== next.type || same.title !== next.title || (same.message ?? "") !== (next.message ?? "");
  return {
    ...same,
    type: next.type,
    title: next.title,
    message: next.message,
    duration: next.duration,
    action: next.action,
    count: same.count + 1,
    at,
    varied,
  };
}

/** The count badge's tooltip: "identical" only when every merged arrival
 *  said the same thing. */
export function toastCountTitle(t: Pick<Shown, "count" | "varied">): string {
  return t.varied ? `${t.count} updates — showing the newest` : `${t.count} identical messages`;
}

export function visibleToasts<T>(toasts: T[], allowance: number): T[] {
  return allowance <= 0 ? [] : toasts.slice(-allowance);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Shown[]>([]);
  // Auto-dismiss timers, by toast id. A timer runs only while its card is
  // within the visible stack (RT-11): a card collapsed into "+N more" keeps
  // its full time for when it shows. A phone's folded pill is not "+N more":
  // the cards it stands for still run their time (the dock's `timed`), so a
  // toast expires on a phone as it always did.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Declared before showToast so it can be referenced from the timeout without
  // a use-before-declaration; useCallback keeps the reference stable.
  const removeToast = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(({ type, title, message, duration = 5000, coalesceKey, action }: Omit<Toast, "id">) => {
    const key = toastCoalesceKey({ type, title, message, coalesceKey });
    const now = Date.now();
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => {
      const same = prev.find((t) => t.key === key && now - t.at < COALESCE_WINDOW_MS);
      if (same) {
        // One card with a count, moved to the newest place, its time
        // restarted, showing the newest arrival's words (mergeToast).
        const timer = timers.current.get(same.id);
        if (timer) { clearTimeout(timer); timers.current.delete(same.id); }
        return [...prev.filter((t) => t.id !== same.id), mergeToast(same, { type, title, message, duration, action }, now)];
      }
      return [...prev, { id, type, title, message, duration, action, key, count: 1, at: now, varied: false }];
    });
  }, []);

  const newest = toasts[toasts.length - 1];
  const { shown: allowance, timed } = useDockAllowances(
    "transient", DOCK_PRIORITY.toast, toasts.length,
    newest ? { label: newest.title, tone: newest.type === "error" || newest.type === "warning" ? "error" : newest.type === "success" ? "ok" : "info" } : null,
  );
  const shown = visibleToasts(toasts, allowance);

  useEffect(() => {
    const now = visibleToasts(toasts, timed);
    const visible = new Set(now.map((t) => t.id));
    // Leaving the visible stack pauses (clears) a card's timer…
    for (const [id, t] of timers.current) {
      if (!visible.has(id)) { clearTimeout(t); timers.current.delete(id); }
    }
    // …and entering it starts one, for the card's full duration.
    for (const t of now) {
      if ((t.duration ?? 0) > 0 && !timers.current.has(t.id)) {
        const id = t.id;
        timers.current.set(id, setTimeout(() => removeToast(id), t.duration));
      }
    }
  }, [toasts, timed, removeToast]);

  useEffect(() => {
    const map = timers.current;
    return () => { for (const t of map.values()) clearTimeout(t); map.clear(); };
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}

      {/* Toast Container — stacks with the other corner widgets in the
          shared dock (transient slot, above the jobs); falls back to its
          own corner on public pages. Rendered only while a toast exists, so
          an empty list adds no gap to the dock. */}
      {shown.length > 0 && (
      <CornerPortal slot="transient" priority={DOCK_PRIORITY.toast}>
      <div role="status" aria-label="Messages" className="flex flex-col gap-2 pointer-events-none">
        {shown.map((toast) => (
          <div
            key={toast.id}
            role={toast.type === "error" ? "alert" : undefined}
            className="
              pointer-events-auto w-[min(20rem,calc(100vw-2rem))] p-4 rounded-xl shadow-lg border animate-in slide-in-from-right-full fade-in duration-300
              flex items-start gap-3 bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text)]
            "
          >
            <div className={`mt-0.5 shrink-0
              ${toast.type === "success" ? "text-green-600" : ""}
              ${toast.type === "error" ? "text-red-600" : ""}
              ${toast.type === "info" ? "text-blue-600" : ""}
              ${toast.type === "warning" ? "text-amber-600" : ""}
            `}>
              {toast.type === "success" && <CheckCircle className="w-5 h-5" />}
              {toast.type === "error" && <AlertCircle className="w-5 h-5" />}
              {toast.type === "info" && <Info className="w-5 h-5" />}
              {toast.type === "warning" && <Bell className="w-5 h-5" />}
            </div>

            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-bold text-[var(--color-text)]">
                {toast.title}
                {toast.count > 1 && (
                  <span className="ml-1.5 align-middle inline-flex items-center rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1.5 text-[10px] font-black text-[var(--color-text-muted)]" title={toastCountTitle(toast)}>
                    ×{toast.count}
                  </span>
                )}
              </h4>
              {toast.message && (
                <p className="text-xs text-[var(--color-text-muted)] mt-1 leading-relaxed">
                  {toast.message}
                </p>
              )}
              {toast.action && (
                <button
                  type="button"
                  onClick={() => { const run = toast.action!.onClick; removeToast(toast.id); run(); }}
                  className="mt-2 inline-flex items-center rounded-lg px-2 py-1 text-xs font-bold text-[var(--color-accent)] hover:bg-[var(--color-surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]"
                >
                  {toast.action.label}
                </button>
              )}
            </div>

            <button
              onClick={() => removeToast(toast.id)}
              aria-label="Dismiss"
              className="text-[var(--color-text-faint)] hover:text-[var(--color-text)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
      </CornerPortal>
      )}
    </ToastContext.Provider>
  );
}
