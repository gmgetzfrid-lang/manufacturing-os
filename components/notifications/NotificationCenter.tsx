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
import { X } from "lucide-react";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useTicketNotifications } from "@/hooks/useTicketNotifications";
import { AttentionFeed, type AttnFilter } from "@/components/cockpit/AttentionFeed";
import { buildNeeds, needsFacts } from "@/components/cockpit/needsYou";
import { heroPrimary, heroQuiet } from "@/components/ui/PageHero";

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

  const needs = buildNeeds(items);
  const nf = needsFacts(needs);
  const leadRow = needs[0];
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
        aria-modal={isOpen ? "true" : undefined}
        aria-hidden={isOpen ? undefined : true}
        inert={!isOpen}
        aria-label="Notification center"
        className={`fixed top-0 right-0 bottom-0 z-[241] w-[480px] max-w-[94vw] bg-[var(--color-canvas)] border-l border-[var(--color-border-strong)] shadow-[-30px_0_60px_-30px_rgb(0_0_0/0.6)] flex flex-col transition-transform duration-500 ${
          isOpen ? "translate-x-0" : "translate-x-[110%]"
        }`}
        style={{ transitionTimingFunction: "var(--ease-spring)" }}
      >
        <div className="px-5 pt-4 pb-4 shrink-0 border-b border-[var(--color-border-strong)]">
          <div className="flex items-center gap-2">
            <div className="text-[14px] font-medium text-[var(--color-text-muted)]">Notifications</div>
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
              className="w-9 h-9 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <h2 className="mt-1 font-display text-[30px] leading-[1.05] font-semibold tracking-[-0.01em] text-[var(--color-text)]">{answer}</h2>
          {counts.all > 0 && (
            <dl className="mt-3 flex border-t border-[var(--color-border-strong)] pt-2.5">
              {[
                { label: "Overdue", value: nf.overdue, bad: nf.overdue > 0 },
                { label: "Waiting on you", value: nf.yourTurn, bad: false },
                { label: "Updates", value: nf.news, bad: false },
              ].map((f, i) => (
                <div key={f.label} className={`pr-5 ${i ? "pl-5 border-l border-[var(--color-border-strong)]" : ""}`}>
                  <dt className="text-[13px] text-[var(--color-text-muted)]">{f.label}</dt>
                  <dd className={`font-display text-[24px] leading-none mt-1 font-semibold tabular-nums ${f.bad ? "text-[var(--state-overdue)]" : "text-[var(--color-text)]"}`}>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {leadRow && (
            <Link href={leadRow.link} onClick={() => { if (leadRow.notificationId) void markRead(leadRow.notificationId).catch(() => {}); onClose(); }}
              className={`mt-4 ${heroPrimary}`}>
              {counts.all === 1 ? "Open it" : "Open the first one"}
            </Link>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto bg-[var(--color-surface)]">
          {loadError && (
            <p role="alert" className="mx-4 mt-3 border-l-[3px] border-[var(--state-overdue)] pl-2.5 text-[14px] text-[var(--state-overdue)]">
              Some of this couldn&apos;t load, so the list may be missing items: {loadError}
            </p>
          )}
          {loading && items.length === 0 ? (
            <div className="p-4"><LoadingBlock what="notifications" rows={4} /></div>
          ) : (
            <div className="pt-1">
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
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border-strong)] shrink-0 pb-[calc(12px+env(safe-area-inset-bottom))]">
          <Link href="/inbox" onClick={onClose} className={heroQuiet}>Open the full inbox</Link>
        </div>
      </aside>
    </>,
    document.body,
  );
}
