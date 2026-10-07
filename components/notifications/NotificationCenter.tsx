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
// and keeps that layer until it closes. Opened there, every row and the inbox
// link lead away from the page that owns the running upload, and a client-side
// navigation meets no leave-page prompt — so while an upload is in flight such
// a link asks first (`confirmLeaveDuringUploads`) and is followed only on yes.
// The question is asked INSIDE the panel, never in a dialog of its own: the
// raising modal under the center may close (and abort its upload) on an
// Escape that reaches `window` (MetadataStagingModal does), so the center
// must be the one that answers that Escape ("Stay") and stops it there.
//
// Accessible (NEDGE-5): a labelled modal dialog that takes focus when it
// opens and gives it back to the opener when it closes; inert while closed.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import Link from "next/link";
import { X, BellRing, Inbox } from "lucide-react";
import { useTicketNotifications, type AttentionCounts, type AttentionSection } from "@/hooks/useTicketNotifications";
import { AttentionFeed, type AttnFilter } from "@/components/cockpit/AttentionFeed";
import { isDockRaised, useOccupyRightRail } from "@/components/ui/CornerDock";
import { Button } from "@/components/ui/Button";
import { supabase } from "@/lib/supabase";
import { hasUploadsInFlight } from "@/lib/uploadActivity";
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

/** Scoped "mark read" (TAX-1): marks the rows the view lists, as a checked
 *  write — a refused update throws, and the panel says so; never a silent
 *  success. "Refused" includes an update row-level security filters down to
 *  fewer rows than were listed (no error, rows unchanged): the write reads
 *  back the ids it changed and throws when any is missing. (lib/inAppNotifications
 *  `markManyRead`, which this replaced here, does not read the error; it is
 *  not this package's file.) */
export async function markTheseRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .in("id", ids)
    .select("id");
  if (error) throw new Error(error.message || "The update was refused.");
  const changed = new Set(((data as Array<{ id: string }> | null) ?? []).map((r) => r.id));
  const missed = ids.filter((id) => !changed.has(id)).length;
  if (missed > 0) throw new Error(`The update changed ${ids.length - missed} of ${ids.length} notifications.`);
}

/** What a failed "mark read" says in the panel. */
export const MARK_READ_FAILED = "Couldn't mark these notifications read. They are still listed here — try again in a moment.";

/** The leave question's words (the wording of UpdatePill's
 *  `confirmReloadDuringUploads`). */
export const LEAVE_QUESTION = {
  title: "An upload is still running",
  message: "Opening this leaves the page that is running the upload, which stops the upload in progress. Files that already finished are saved; the rest will need uploading again.",
  confirmLabel: "Leave anyway",
  cancelLabel: "Stay",
} as const;
export type LeaveQuestion = typeof LEAVE_QUESTION;

/** RT-11 (review fix): opened above an upload modal, a row or the inbox link
 *  navigates away from the page running the upload, which ends it — and a
 *  client-side navigation never meets the browser's leave-page prompt. So
 *  while one is in flight, ask first. `ask` is the panel's own inline
 *  question (third review fix: not the app's dialog host, whose Escape goes
 *  on to the raising modal's `window` listener and aborts the upload). */
export async function confirmLeaveDuringUploads(deps: {
  inFlight?: () => boolean;
  ask: (q: LeaveQuestion) => Promise<boolean>;
}): Promise<boolean> {
  if (!(deps.inFlight ?? hasUploadsInFlight)()) return true;
  return deps.ask(LEAVE_QUESTION);
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
  const [markError, setMarkError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  // The confirmed link's own click, replayed after "Leave anyway".
  const followingRef = useRef(false);
  // The leave question (RT-11), asked inside the panel: while it is up the
  // rest of the panel is inert, and `answerRef` holds its answer.
  const [leaveAsked, setLeaveAsked] = useState(false);
  const answerRef = useRef<((ok: boolean) => void) | null>(null);
  const askLeave = useCallback((): Promise<boolean> => new Promise<boolean>((resolve) => {
    answerRef.current?.(false);
    answerRef.current = (ok) => { answerRef.current = null; resolve(ok); };
    setLeaveAsked(true);
  }), []);
  // Answered by a person (a button, Escape): the question leaves the page
  // first, so a replayed click lands on a panel that is no longer inert.
  const answerLeave = useCallback((ok: boolean) => {
    const answer = answerRef.current;
    if (!answer) return;
    flushSync(() => setLeaveAsked(false));
    answer(ok);
  }, []);
  // Closed (or unmounted) with the question up: the answer is "Stay".
  useEffect(() => {
    if (isOpen || !answerRef.current) return;
    const answer = answerRef.current;
    setLeaveAsked(false);
    answer(false);
  }, [isOpen]);
  useEffect(() => () => { answerRef.current?.(false); }, []);
  // Opened above a raising modal, the panel is a rail above the raise: the
  // raised dock moves left of it instead of covering its rows (RT-11).
  useOccupyRightRail(panelRef, isOpen && aboveModal, true);

  // Escape closes just the center (capture — the same trick every overlay in
  // the app uses so underlying Esc listeners don't also fire). While the
  // leave question is up, Escape answers it ("Stay") and goes no further: the
  // center stays open, and a raising modal's `window` listener under it
  // (MetadataStagingModal's Escape closes the modal and aborts its upload)
  // never hears the key (third review fix). An Escape inside another dialog
  // above the center (an app dialog opened over it) is that dialog's to
  // answer on `document` (Modal's convention); once it has, the key stops
  // there too, so nothing under the center acts on it as well.
  useEffect(() => {
    if (!isOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (answerRef.current) {
        e.stopPropagation();
        answerLeave(false);
        return;
      }
      const at = e.target instanceof Element && e.target !== document.body ? e.target : document.activeElement;
      const dialog = at?.closest('[role="dialog"], [role="alertdialog"]');
      const panel = panelRef.current;
      if (dialog && panel && dialog !== panel && !panel.contains(dialog)) {
        // Added during this dispatch, so it runs after every `document`
        // listener already there (the dialog's), before any `window` one.
        const stopAfterDialog = (ev: Event) => { if (ev === e) ev.stopPropagation(); };
        document.addEventListener("keydown", stopAfterDialog);
        setTimeout(() => document.removeEventListener("keydown", stopAfterDialog), 0);
        return;
      }
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => window.removeEventListener("keydown", h, { capture: true });
  }, [isOpen, onClose, answerLeave]);

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

  // A failure line belongs to the view it was raised in.
  useEffect(() => { setMarkError(null); }, [isOpen, section]);

  const handleMarkAll = useCallback(async () => {
    setMarkingAll(true);
    setMarkError(null);
    try {
      // Scoped, "mark read" clears the rows this view lists — never the
      // other sections' (the button says so).
      if (section) await markTheseRead(scopedNotificationIds);
      else await markAllRead();
    } catch (e) {
      console.warn("[NotificationCenter] mark read failed", e);
      setMarkError(MARK_READ_FAILED);
    } finally { setMarkingAll(false); }
  }, [markAllRead, section, scopedNotificationIds]);

  // RT-11 (review fix): above an upload modal, a link in the panel asks
  // before it leaves while an upload is in flight. Capture phase, so the
  // link's own handler (mark read, close) runs only when it is followed.
  const guardLeave = useCallback((e: React.MouseEvent) => {
    if (followingRef.current || !aboveModal || e.defaultPrevented) return;
    // a new tab or window leaves this page alone
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    const link = target?.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement)) return;
    // a control inside a row (its "mark read") never navigates
    const control = target?.closest("button");
    if (control && link.contains(control)) return;
    if (!hasUploadsInFlight()) return;
    e.preventDefault();
    e.stopPropagation();
    void confirmLeaveDuringUploads({ ask: askLeave }).then((ok) => {
      // Closed meanwhile (the panel is inert): nothing to follow.
      if (!link.isConnected || link.closest("[inert]")) return;
      // "Stay": back to the row that asked.
      if (!ok) { link.focus({ preventScroll: true }); return; }
      followingRef.current = true;
      try { link.click(); } finally { followingRef.current = false; }
    });
  }, [aboveModal, askLeave]);

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
        onClickCapture={guardLeave}
      >
        <div inert={leaveAsked} className="px-4 py-3.5 border-b border-[var(--color-border)] flex items-center gap-3 shrink-0 bg-[var(--color-surface-2)]">
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

        <div inert={leaveAsked} className="flex-1 min-h-0 overflow-y-auto p-4">
          {markError && (
            <div role="alert" data-center-mark-error className="mb-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-[12px] font-bold text-red-700 dark:text-red-300">
              {markError}
            </div>
          )}
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

        <div inert={leaveAsked} className="px-4 py-2.5 border-t border-[var(--color-border)] shrink-0 bg-[var(--color-surface-2)]">
          <Link
            href="/inbox"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
          >
            <Inbox className="w-3.5 h-3.5" aria-hidden /> Open the full inbox cockpit
          </Link>
        </div>

        {/* The leave question (RT-11), inside the panel and over its rows
            (last in the panel, so it paints above them with no layer of its
            own). Its Escape is the center's: "Stay". */}
        {leaveAsked && (
          <div data-center-leave-question className="absolute inset-0 flex items-center justify-center p-4 bg-slate-900/40">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="center-leave-question-title"
              aria-describedby="center-leave-question-message"
              className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] p-5 shadow-2xl"
            >
              <h2 id="center-leave-question-title" className="text-sm font-black">{LEAVE_QUESTION.title}</h2>
              <p id="center-leave-question-message" className="mt-1 text-sm text-[var(--color-text-muted)]">{LEAVE_QUESTION.message}</p>
              <div className="mt-4 flex justify-end gap-2">
                <Button type="button" variant="secondary" autoFocus onClick={() => answerLeave(false)}>
                  {LEAVE_QUESTION.cancelLabel}
                </Button>
                <Button type="button" variant="danger" onClick={() => answerLeave(true)}>
                  {LEAVE_QUESTION.confirmLabel}
                </Button>
              </div>
            </div>
          </div>
        )}
      </aside>
    </>,
    document.body,
  );
}
