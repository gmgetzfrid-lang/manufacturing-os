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

import React, { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { appAlert } from "@/components/providers/DialogProvider";
import { createPortal } from "react-dom";
import Link from "next/link";
import { X, BellRing, Inbox } from "lucide-react";
import LoadingBlock from "@/components/ui/LoadingBlock";
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

const subscribeNever = () => () => {};

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
  const { items, markRead, markAllRead, loading, loadError } = useTicketNotifications();
  const [markingAll, setMarkingAll] = useState(false);
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);

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
    try { await markAllRead(); }
    catch (e) { void appAlert({ title: "Couldn't mark them read", message: (e as Error).message, tone: "danger" }); }
    finally { setMarkingAll(false); }
  }, [markAllRead]);

  // News clears once you've seen it: when you close this after opening it.
  // Decisions stay until you act on them (markAllRead skips those).
  const seen = React.useRef(false);
  useEffect(() => {
    if (isOpen) { seen.current = true; return; }
    if (!seen.current) return;
    seen.current = false;
    void markAllRead().catch((e: unknown) => console.warn("[notifications] clearing seen news failed; the bell keeps them", e));
  }, [isOpen, markAllRead]);

  // Only after hydration: the server renders nothing here, so the first
  // client pass must too (a portal on that pass made React hydrate the panel
  // against the toast stack and report a mismatch).
  if (!mounted) return null;

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

  const lead = items.find((i) => i.actionRequired) ?? items[0];
  const answer = loading && items.length === 0
    ? "Notifications"
    : counts.all === 0 ? "All caught up." : `${counts.all} ${counts.all === 1 ? "thing needs" : "things need"} you.`;

  return createPortal(
    <>
      {/* The page behind dims, so the panel is the one thing in front. */}
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-[240] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] transition-opacity duration-300 ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Notification center"
        className={`fixed top-0 sm:top-3.5 right-0 sm:right-3.5 bottom-0 z-[241] w-[480px] max-w-[94vw] bg-[var(--color-surface)] rounded-l-[20px] sm:rounded-[20px] sm:rounded-b-none shadow-[-30px_0_60px_-30px_rgb(0_0_0/0.6)] flex flex-col transition-transform duration-500 ${
          isOpen ? "translate-x-0" : "translate-x-[110%]"
        }`}
        style={{ transitionTimingFunction: "var(--ease-spring)" }}
      >
        <div className="px-5 sm:px-6 pt-5 pb-4 shrink-0">
          <div className="flex items-center gap-2">
            <BellRing className="w-3.5 h-3.5 text-[var(--color-text-muted)]" aria-hidden />
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Notifications</div>
            <div className="flex-1" />
            <button
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
              className="w-9 h-9 grid place-items-center rounded-[10px] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <h2 className="mt-3 text-[30px] sm:text-[36px] leading-[1.05] font-black tracking-[-0.03em] text-[var(--color-text)]">{answer}</h2>
          {counts.all > 0 && (
            <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">
              {`${counts.action > 0 ? `${counts.action} waiting on you` : ""}${counts.action > 0 && counts.unread > 0 ? " · " : ""}${counts.unread > 0 ? `${counts.unread} new` : ""}`}
            </p>
          )}
          {lead && (
            <Link href={lead.link} onClick={() => { if (lead.notificationId) void markRead(lead.notificationId).catch(() => {}); onClose(); }}
              className="mt-4 inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[14px] font-extrabold hover:bg-[var(--color-accent-hover)] shadow-[0_12px_24px_-12px_var(--color-accent)] transition-colors">
              {counts.all === 1 ? "Open it" : lead.actionRequired ? "Open the first one" : "Open the newest"}
            </Link>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 pb-4 border-t border-[var(--color-border)] pt-3">
          {loadError && (
            <p role="alert" className="mb-3 text-[13px] text-rose-800 dark:text-rose-300">
              Some of this couldn&apos;t load, so the list may be missing items: {loadError}
            </p>
          )}
          {loading && items.length === 0 ? (
            <LoadingBlock what="notifications" rows={4} />
          ) : (
            <AttentionFeed
              plain
              items={filtered}
              counts={counts}
              filter={filter}
              onFilter={onFilter}
              onMarkRead={(id) => { void markRead(id).catch((e: unknown) => appAlert({ title: "Couldn't mark it read", message: e instanceof Error ? e.message : String(e), tone: "danger" })); }}
              onMarkAll={handleMarkAll}
              markingAll={markingAll}
            />
          )}
        </div>

        <div className="px-5 sm:px-6 py-3 border-t border-[var(--color-border)] shrink-0 pb-[calc(12px+env(safe-area-inset-bottom))]">
          <Link
            href="/inbox"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 text-[13px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
          >
            <Inbox className="w-3.5 h-3.5" /> Open the full inbox
          </Link>
        </div>
      </aside>
    </>,
    document.body,
  );
}
