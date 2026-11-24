"use client";

// NotificationBell: the bell in the top bar and its drop-down.
//
// It shows the SAME feed as the sidebar badge and the Inbox (via
// useTicketNotifications), so the count and the items always match.
//
// The badge follows one set of rules:
//   * a red number only for what waits on your decision (capped at 99+, so
//     its shape holds); it is pinned to the bell's top corner and grows
//     to the left, the bell never moves
//   * no decisions but news since you last looked: a small dot instead
//     ("something changed"); never a number and a dot together
//   * the dot clears the moment you open the bell (or the panel, or the
//     Inbox) and comes back only when something newer arrives
//   * while the feed reloads the number holds; it never flashes to 0

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { useTicketNotifications } from "@/hooks/useTicketNotifications";
import { useNotificationCenter } from "@/components/notifications/NotificationCenter";
import { useNotificationsSeen } from "@/components/notifications/seen";
import { badgeText } from "@/lib/badge";
import { friendlyError } from "@/lib/friendlyError";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { buildNeeds, needsFacts } from "@/components/cockpit/needsYou";
import NeedsTable, { isNewSince } from "@/components/cockpit/NeedsTable";
import { rowBtn, link } from "@/components/cockpit/ui";

interface NotificationBellProps {
  collapsed?: boolean;
  variant?: "sidebar" | "header";
}

/** A small labelled figure in the drop-down's summary line; zeros muted. */
function Fact({ label, value, bad = false }: { label: string; value: number; bad?: boolean }) {
  const tone = value === 0 ? "text-[var(--color-text-faint)]" : bad ? "font-medium text-[var(--state-overdue-text)]" : "font-medium text-[var(--color-text)]";
  return (
    <div className="inline-flex items-baseline gap-1.5">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className={`tabular-nums ${tone}`}>{value.toLocaleString()}</dd>
    </div>
  );
}

export default function NotificationBell({ collapsed, variant = "sidebar" }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { items, count, loading, markRead, markAllRead } = useTicketNotifications();
  const { open: openCenter } = useNotificationCenter();
  const { seenAt, markSeen } = useNotificationsSeen();
  // What counted as new while this drop-down is open (taken as it opens,
  // before the bell is marked seen).
  const [listSeen, setListSeen] = useState<number>(0);
  const isHeader = variant === "header";
  const rows = useMemo(() => buildNeeds(items), [items]);
  const facts = needsFacts(rows);

  // The number is only what waits on a decision. While the feed reloads it
  // holds its last value instead of dropping to 0 and back.
  const [held, setHeld] = useState(0);
  if (!loading && held !== facts.yourTurn) setHeld(facts.yourTurn);
  const decisions = loading ? Math.max(held, facts.yourTurn) : facts.yourTurn;
  const changed = decisions === 0 && rows.some((r) => !r.yourTurn && isNewSince(r, seenAt ?? 0));
  const [markError, setMarkError] = useState<string | null>(null);

  const show = React.useCallback(() => {
    setListSeen(seenAt ?? 0);
    markSeen();
    setOpen(true);
  }, [seenAt, markSeen]);

  // Let other surfaces (e.g. the Inbox) pop the drawer open via a global event.
  useEffect(() => {
    const onOpen = () => show();
    window.addEventListener("mfgos:open-notifications", onOpen);
    return () => window.removeEventListener("mfgos:open-notifications", onOpen);
  }, [show]);

  // Close on Escape, or on any pointer-down outside the bell and its
  // drop-down (the top bar's stacking context can't hold a full-screen
  // overlay above the rest of the chrome).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Only notification ROWS can be "marked read"; ticket items are live and clear
  // themselves when the underlying work is done.
  const hasNotifRows = useMemo(() => items.some((i) => i.source === "notification"), [items]);
  const [markingAll, setMarkingAll] = useState(false);

  const onItemOpen = async (notificationId?: string) => {
    setOpen(false);
    if (notificationId) {
      // Opening it is the point; if marking it read fails, it simply stays
      // in the list (noted for support, not put in the way).
      try { await markRead(notificationId); } catch (e) { console.warn("[bell] mark read failed", e); }
    }
  };

  const said = decisions > 0
    ? `${decisions.toLocaleString()} waiting on you`
    : changed ? "Something new" : count > 0 ? `${count.toLocaleString()} to look at` : "Nothing new";
  const badge = decisions > 0
    ? <span key={decisions} className={`ui-badge absolute ${isHeader ? "-top-0.5 -right-0.5 ring-2 ring-[var(--color-canvas)]" : collapsed ? "top-1 right-1" : "right-3 top-1/2 -translate-y-1/2"}`}>{badgeText(decisions)}</span>
    : changed
      ? <span aria-hidden className={`absolute w-2 h-2 rounded-full bg-[var(--color-current)] ${isHeader ? "top-1.5 right-1.5 ring-2 ring-[var(--color-canvas)]" : collapsed ? "top-2 right-2" : "right-4 top-1/2 -translate-y-1/2"}`} />
      : null;

  return (
    <div className="relative" ref={containerRef}>
      {isHeader ? (
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : show())}
          title={`Notifications: ${said.toLowerCase()}`}
          aria-label={`Notifications: ${said.toLowerCase()}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={`relative w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-full transition-colors ${
            open ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
          }`}
        >
          <Bell className="w-4 h-4" />
          {badge}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : show())}
          title={`Notifications: ${said.toLowerCase()}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={`relative w-full flex items-center px-3 py-2.5 rounded-lg transition-colors group ${open ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : "hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"}`}
        >
          <Bell className={`w-5 h-5 ${collapsed ? "" : "mr-3"} text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]`} />
          {!collapsed && <span className="text-sm font-medium">Notifications</span>}
          {badge}
        </button>
      )}

      {open && (
        <div role="dialog" aria-label="Notifications" className={`${isHeader ? "absolute right-0 top-full mt-2 origin-top-right" : "absolute left-full ml-2 bottom-0 origin-bottom-left"} w-[26rem] max-w-[calc(100vw-1.5rem)] max-h-[70vh] bg-[var(--color-surface)] text-[var(--color-text)] rounded-panel border border-[var(--color-border)] ui-float ui-float-in z-[90] flex flex-col overflow-hidden`}>
            <div className="px-4 pt-3 pb-3 border-b border-[var(--color-border)]">
              <div className="flex items-baseline gap-3">
                <h2 className="min-w-0 flex-1 font-display text-section font-semibold">
                  {count === 0 ? "All caught up." : `${count.toLocaleString()} ${count === 1 ? "thing needs" : "things need"} you.`}
                </h2>
                <Link href="/settings/notifications" onClick={() => setOpen(false)} className={`text-body ${link}`}>Settings</Link>
              </div>
              {count > 0 && (
                <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-body">
                  <Fact label="Overdue" value={facts.overdue} bad />
                  <Fact label="Waiting on you" value={facts.yourTurn} />
                  <Fact label="Updates" value={facts.news} />
                </dl>
              )}
              {markError && <p role="alert" className="mt-1.5 text-body font-medium text-[var(--state-overdue-text)]">{markError}</p>}
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading && items.length === 0 ? (
                <SkeletonRows rows={4} cols={1} what="notifications" sheet={false} />
              ) : items.length === 0 ? (
                <p className="px-4 py-5 text-reading text-[var(--color-text-muted)]">Nothing needs you.</p>
              ) : (
                <NeedsTable rows={rows} label="Notifications" seenAt={listSeen} onOpen={(r) => { void onItemOpen(r.notificationId); }} />
              )}
            </div>
            <div className="px-4 py-2.5 border-t border-[var(--color-border)] flex items-center gap-3">
              {hasNotifRows && (
                <button
                  type="button"
                  title="Items waiting on your decision stay until you open them"
                  disabled={markingAll}
                  onClick={async () => {
                    setMarkError(null); setMarkingAll(true);
                    try { await markAllRead(); } catch (e) { setMarkError(`Not marked read. ${friendlyError(e)}`); } finally { setMarkingAll(false); }
                  }}
                  className={rowBtn}
                >
                  {markingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCheck className="w-3.5 h-3.5" />} Mark updates read
                </button>
              )}
              <div className="flex-1" />
              <button type="button" onClick={() => { setOpen(false); openCenter("all"); }} className={`text-body font-medium ${link}`}>See all</button>
            </div>
        </div>
      )}
    </div>
  );
}
