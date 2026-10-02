"use client";

// NotificationCenter — the answer to "the badge says 10 and I can't find them."
//
// One right-hand slide-over, openable from EVERY count in the app — sidebar
// badges, the Command Deck "Needs you" / "Action" stats, the bell — showing
// exactly the items those counts are counting. It consumes the SAME
// useTicketNotifications hook the badges do, so the list can never disagree
// with the number that opened it: click a 10, see the 10.
//
// A sidebar badge opens it SCOPED to its own section (TAX-1 / TRAIL-3,
// notifications Round G N3): the "3" on Documents opens Documents' three, the
// header says "3 items in Documents" — the badge's own count, read from the
// same tally (sectionCounts) — and an empty scope names the section. Every
// other opener (the bell's "See all", the Command Deck, the corner dock's
// "+N more") opens it unscoped.
//
// Inside: the cockpit's AttentionFeed (filters, mark-read, deep links per
// item), so every row is a doorway to the thing that needs you.
//
// Layers (RT-11): at rest the panel sits at 240 / 241, under every modal. The
// one way it can be opened while a modal is up is the corner dock's "+N more"
// doorway while the dock is raised over a modal that started an upload — so
// when it is opened while the dock is raised, it opens at `Z.dialog`, above
// that modal (and under the raised dock, which then moves left of the panel),
// and keeps that layer until it closes.
//
// Accessible (NEDGE-5): a labelled modal dialog that takes focus when it
// opens and gives it back to the opener when it closes; inert while closed.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { X, BellRing, Inbox } from "lucide-react";
import { useTicketNotifications, type AttentionCounts, type AttentionSection } from "@/hooks/useTicketNotifications";
import { AttentionFeed, type AttnFilter } from "@/components/cockpit/AttentionFeed";
import { isDockRaised, useOccupyRightRail } from "@/components/ui/CornerDock";
import { markManyRead } from "@/lib/inAppNotifications";
import { Z } from "@/lib/zLayers";

/** The section names a scoped header says — the Sidebar rows' labels. */
export const SECTION_LABELS: Record<AttentionSection, string> = {
  documents: "Documents",
  projects: "Projects",
  requests: "Drafting Requests",
};

interface CenterCtx {
  /** Open the center, optionally pre-filtered ("action") and optionally
   *  scoped to one sidebar section. With no section it opens unscoped — a
   *  scope never outlives the badge that asked for it. */
  open: (filter?: AttnFilter, section?: AttentionSection | null) => void;
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
  const [section, setSection] = useState<AttentionSection | null>(null);
  // Opened while the corner dock is raised over an upload modal → above it.
  const [aboveModal, setAboveModal] = useState(false);
  const open = useCallback((f?: AttnFilter, s?: AttentionSection | null) => {
    if (f) setFilter(f);
    setSection(s ?? null);
    setAboveModal(isDockRaised());
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  return (
    <NotificationCenterContext.Provider value={{ open, close, isOpen }}>
      {children}
      <CenterPanel
        isOpen={isOpen}
        onClose={close}
        filter={filter}
        onFilter={setFilter}
        section={section}
        onClearSection={() => setSection(null)}
        aboveModal={aboveModal}
      />
    </NotificationCenterContext.Provider>
  );
}

/** The header line: the number the opener showed, and where it came from.
 *  Scoped, it is the section badge's count ("3 items in Documents"); unscoped
 *  under "All", the bell's. A filter is named when one is on. */
export function centerHeadline(n: number, section: AttentionSection | null, filter: AttnFilter): string {
  const s = n === 1 ? "" : "s";
  const where = section ? ` in ${SECTION_LABELS[section]}` : "";
  if (filter === "action") return `${n} item${s}${where} need${n === 1 ? "s" : ""} action`;
  if (filter === "activity") return `${n} activity item${s}${where}`;
  if (n === 0) return section ? `Nothing in ${SECTION_LABELS[section]} needs your attention.` : "You're all caught up.";
  return section ? `${n} item${s}${where}` : `${n} item${s} — everything the bell counts.`;
}

function CenterPanel({
  isOpen, onClose, filter, onFilter, section, onClearSection, aboveModal,
}: {
  isOpen: boolean;
  onClose: () => void;
  filter: AttnFilter;
  onFilter: (f: AttnFilter) => void;
  section: AttentionSection | null;
  onClearSection: () => void;
  aboveModal: boolean;
}) {
  const { items, counts, sectionCounts, markRead, markAllRead, loading } = useTicketNotifications();
  const [markingAll, setMarkingAll] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  // Opened above a raising modal, the panel is a rail above the raise: the
  // raised dock moves left of it instead of covering its rows (RT-11).
  useOccupyRightRail(panelRef, isOpen && aboveModal, true);

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

  // Focus (NEDGE-5): opening moves focus into the panel; closing returns it
  // to whatever opened it, when that is still on the page and focus has
  // nowhere better to be (it was inside the panel, or nowhere).
  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement;
    const panel = panelRef.current;
    panel?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || (panel?.contains(active) ?? false);
      if (lost && opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus({ preventScroll: true });
      } else if (lost && active instanceof HTMLElement && panel?.contains(active)) {
        active.blur();
      }
    };
  }, [isOpen]);

  // Scoped, the list is the section's items and the counts are the section
  // badge's own tally (sectionCounts) — the number that opened it.
  const scoped = useMemo(() => (section ? items.filter((i) => i.section === section) : items), [items, section]);
  const scopedNotificationIds = useMemo(
    () => (section ? scoped.flatMap((i) => (i.notificationId ? [i.notificationId] : [])) : []),
    [scoped, section],
  );
  const viewCounts: AttentionCounts = section
    ? {
        all: sectionCounts[section].total,
        action: sectionCounts[section].actionRequired,
        activity: sectionCounts[section].total - sectionCounts[section].actionRequired,
        notifications: scopedNotificationIds.length,
      }
    : counts;

  const handleMarkAll = useCallback(async () => {
    setMarkingAll(true);
    try {
      // Scoped, "mark read" clears the rows this view lists — never the
      // other sections' (the button says so).
      if (section) await markManyRead(scopedNotificationIds);
      else await markAllRead();
    } catch { /* best-effort */ } finally { setMarkingAll(false); }
  }, [markAllRead, section, scopedNotificationIds]);

  if (typeof document === "undefined") return null;

  // counts come from the hook — the same numbers every badge shows (TAX-7).
  const filtered = filter === "action"
    ? scoped.filter((i) => i.actionRequired)
    : filter === "activity"
      ? scoped.filter((i) => !i.actionRequired)
      : scoped;
  const shown = filter === "action" ? viewCounts.action : filter === "activity" ? viewCounts.activity : viewCounts.all;
  // Above a raising modal, both layers take the dialog band (RT-11); the
  // classes keep the resting 240 / 241.
  const layer = aboveModal ? { zIndex: Z.dialog } : undefined;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden
        data-center-backdrop
        style={layer}
        className={`fixed inset-0 z-[240] bg-slate-900/30 backdrop-blur-[2px] transition-opacity duration-300 motion-reduce:transition-none ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      />
      {/* Panel */}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={section ? `Notification center — ${SECTION_LABELS[section]}` : "Notification center"}
        tabIndex={-1}
        inert={!isOpen}
        data-center-panel
        className={`fixed top-0 right-0 bottom-0 z-[241] w-[480px] max-w-[94vw] bg-[var(--color-surface)] border-l border-[var(--color-border)] shadow-2xl flex flex-col transition-transform duration-500 motion-reduce:transition-none outline-none ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        style={{ transitionTimingFunction: "var(--ease-spring)", ...layer }}
      >
        <div className="px-4 py-3.5 border-b border-[var(--color-border)] flex items-center gap-3 shrink-0 bg-[var(--color-surface-2)]">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--color-accent)] text-white shadow-lg shadow-orange-500/25 shrink-0">
            <BellRing className="w-4.5 h-4.5" aria-hidden />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">
              {section ? `Needs your attention in ${SECTION_LABELS[section]}` : "Needs your attention"}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]" data-center-headline>
              {centerHeadline(shown, section, filter)}
            </div>
            {section && (
              <button
                type="button"
                onClick={onClearSection}
                className="mt-0.5 text-[11px] font-bold text-[var(--color-accent)] hover:underline"
              >
                Show every section ({counts.all})
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close the notification center"
            className="p-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
          >
            <X className="w-4 h-4" aria-hidden />
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
              counts={viewCounts}
              filter={filter}
              onFilter={onFilter}
              onMarkRead={(id) => { void markRead(id); }}
              onMarkAll={handleMarkAll}
              markingAll={markingAll}
              scopeLabel={section ? SECTION_LABELS[section] : undefined}
            />
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-[var(--color-border)] shrink-0 bg-[var(--color-surface-2)]">
          <Link
            href="/inbox"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
          >
            <Inbox className="w-3.5 h-3.5" aria-hidden /> Open the full inbox cockpit
          </Link>
        </div>
      </aside>
    </>,
    document.body,
  );
}
