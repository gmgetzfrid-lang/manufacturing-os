"use client";

// NotificationCenter — the answer to "the badge says 10 and I can't find them."
//
// One right-hand slide-over, openable from EVERY count in the app — sidebar
// badges, the Command Deck "Needs you" / "Action" stats, the bell — showing
// exactly the items those counts are counting. It consumes the SAME
// useTicketNotifications hook the badges do, so the list can never disagree
// with the number that opened it: click a 10, see the 10.
//
// Inside: the cockpit's AttentionFeed (filters, mark-read, deep links per
// item), so every row is a doorway to the thing that needs you.

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { X, BellRing, Inbox } from "lucide-react";
import { useTicketNotifications } from "@/hooks/useTicketNotifications";
import { AttentionFeed, type AttnFilter } from "@/components/cockpit/AttentionFeed";

interface CenterCtx {
  /** Open the center (optionally pre-filtered, e.g. "action"). */
  open: (filter?: AttnFilter) => void;
  close: () => void;
  isOpen: boolean;
}

// Safe no-op default so surfaces that render outside the provider (previews,
// storybook-ish contexts) don't crash — their counts just aren't clickable.
const NotificationCenterContext = createContext<CenterCtx>({ open: () => {}, close: () => {}, isOpen: false });

export const useNotificationCenter = () => useContext(NotificationCenterContext);

export function NotificationCenterProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState<AttnFilter>("all");
  const open = useCallback((f?: AttnFilter) => { if (f) setFilter(f); setIsOpen(true); }, []);
  const close = useCallback(() => setIsOpen(false), []);
  return (
    <NotificationCenterContext.Provider value={{ open, close, isOpen }}>
      {children}
      <CenterPanel isOpen={isOpen} onClose={close} filter={filter} onFilter={setFilter} />
    </NotificationCenterContext.Provider>
  );
}

function CenterPanel({
  isOpen, onClose, filter, onFilter,
}: {
  isOpen: boolean;
  onClose: () => void;
  filter: AttnFilter;
  onFilter: (f: AttnFilter) => void;
}) {
  const { items, markRead, markAllRead, loading } = useTicketNotifications();
  const [markingAll, setMarkingAll] = useState(false);

  // Escape closes just the center (capture — the same trick every overlay in
  // the app uses so underlying Esc listeners don't also fire).
  useEffect(() => {
    if (!isOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => window.removeEventListener("keydown", h, { capture: true });
  }, [isOpen, onClose]);

  const handleMarkAll = useCallback(async () => {
    setMarkingAll(true);
    try { await markAllRead(); } catch { /* best-effort */ } finally { setMarkingAll(false); }
  }, [markAllRead]);

  if (typeof document === "undefined") return null;

  const counts = {
    all: items.length,
    action: items.filter((i) => i.actionRequired).length,
    unread: items.filter((i) => !i.actionRequired).length,
  };
  const filtered = filter === "action"
    ? items.filter((i) => i.actionRequired)
    : filter === "unread"
      ? items.filter((i) => !i.actionRequired)
      : items;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-[240] bg-slate-900/30 backdrop-blur-[2px] transition-opacity duration-300 ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Notification center"
        className={`fixed top-0 right-0 bottom-0 z-[241] w-[480px] max-w-[94vw] bg-[var(--color-surface)] border-l border-[var(--color-border)] shadow-2xl flex flex-col transition-transform duration-500 ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        style={{ transitionTimingFunction: "var(--ease-spring)" }}
      >
        <div className="px-4 py-3.5 border-b border-[var(--color-border)] flex items-center gap-3 shrink-0 bg-[var(--color-surface-2)]">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--color-accent)] text-white shadow-lg shadow-orange-500/25 shrink-0">
            <BellRing className="w-4.5 h-4.5" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Needs your attention</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              {counts.all === 0
                ? "You're all caught up."
                : `${counts.all} item${counts.all === 1 ? "" : "s"} — every badge in the app counts these.`}
            </div>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="p-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {loading && items.length === 0 ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-14 rounded-xl bg-[var(--color-surface-2)] animate-pulse" />
              ))}
            </div>
          ) : (
            <AttentionFeed
              items={filtered}
              counts={counts}
              filter={filter}
              onFilter={onFilter}
              onMarkRead={(id) => { void markRead(id); }}
              onMarkAll={handleMarkAll}
              markingAll={markingAll}
            />
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-[var(--color-border)] shrink-0 bg-[var(--color-surface-2)]">
          <Link
            href="/inbox"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
          >
            <Inbox className="w-3.5 h-3.5" /> Open the full inbox cockpit
          </Link>
        </div>
      </aside>
    </>,
    document.body,
  );
}
