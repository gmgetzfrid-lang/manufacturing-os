"use client";

// NotificationBell — header bell icon + dropdown drawer.
//
// Renders the SAME unified attention feed as the sidebar badge and the /inbox
// cockpit (via useTicketNotifications), so the count and the items always match
// across all three surfaces. The feed merges action-required tickets, unread
// ticket activity, and unread in-app notification rows.

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { useTicketNotifications } from "@/hooks/useTicketNotifications";
import { useNotificationCenter } from "@/components/notifications/NotificationCenter";
import { badgeText } from "@/lib/badge";
import { buildNeeds, needsFacts } from "@/components/cockpit/needsYou";
import NeedsTable from "@/components/cockpit/NeedsTable";
import { rowBtn, link } from "@/components/cockpit/ui";

interface NotificationBellProps {
  collapsed?: boolean;
  variant?: "sidebar" | "header";
}

export default function NotificationBell({ collapsed, variant = "sidebar" }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { items, count, loading, markRead, markAllRead } = useTicketNotifications();
  const { open: openCenter } = useNotificationCenter();
  const isHeader = variant === "header";
  const unread = count;
  // Red only when something is late; what waits on you is a graphite count;
  // news gets a quiet one.
  const rows = useMemo(() => buildNeeds(items), [items]);
  const facts = needsFacts(rows);
  const decisions = facts.yourTurn;
  const badgeN = decisions > 0 ? decisions : unread;
  const badgeTone = facts.overdue > 0
    ? "bg-[var(--state-overdue)] text-white"
    : decisions > 0
      ? "bg-[var(--color-text)] text-[var(--color-surface)]"
      : "bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border-strong)]";
  const [markError, setMarkError] = useState<string | null>(null);

  // Let other surfaces (e.g. the Inbox) pop the drawer open via a global event.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("mfgos:open-notifications", onOpen);
    return () => window.removeEventListener("mfgos:open-notifications", onOpen);
  }, []);

  // Robust dismissal: close on Escape, or on any pointer-down outside the bell
  // and its dropdown. Replaces the old full-screen overlay, which was nested
  // inside the TopBar's `z-30` + `backdrop-blur` stacking context and therefore
  // couldn't reliably sit above the rest of the app chrome (the nav drawer is
  // `z-[70]`, the sidebar fly-out `z-50`), so clicks there never dismissed it.
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

  const onItemOpen = async (notificationId?: string) => {
    setOpen(false);
    if (notificationId) {
      // Opening it is the point; if marking it read fails, it simply stays
      // in the list (noted for support, not put in the way).
      try { await markRead(notificationId); } catch (e) { console.warn("[bell] mark read failed", e); }
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      {isHeader ? (
        <button
          onClick={() => setOpen((v) => !v)}
          title={decisions > 0 ? `${decisions} waiting on you` : unread > 0 ? `${unread} new` : "Notifications"}
          aria-label={decisions > 0 ? `Notifications: ${decisions} waiting on you` : unread > 0 ? `Notifications: ${unread} new` : "Notifications"}
          aria-expanded={open}
          className={`relative w-9 h-9 inline-flex items-center justify-center rounded-full transition-all ${
            open ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface)] text-[var(--color-text)] shadow-[0_1px_2px_rgb(11_18_32/0.08)] hover:shadow-[var(--shadow-card)]"
          }`}
        >
          <Bell className="w-4 h-4" />
          {badgeN > 0 && (
            <span className={`absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-semibold ring-2 ring-[var(--color-surface)] ${badgeTone}`}>
              {badgeText(badgeN)}
            </span>
          )}
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          title={decisions > 0 ? `${decisions} waiting on you` : unread > 0 ? `${unread} new` : "Notifications"}
          aria-expanded={open}
          className={`relative w-full flex items-center px-3 py-2.5 rounded-lg transition-all group ${open ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : "hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"}`}
        >
          <Bell className={`w-5 h-5 ${collapsed ? "" : "mr-3"} text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]`} />
          {!collapsed && <span className="text-sm font-medium">Notifications</span>}
          {badgeN > 0 && (
            <span className={`${collapsed ? "absolute top-1 right-1" : "ml-auto"} inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-semibold ${badgeTone}`}>
              {badgeText(badgeN)}
            </span>
          )}
        </button>
      )}

      {open && (
        <div role="dialog" aria-label="Notifications" className={`${isHeader ? "absolute right-0 top-full mt-2 origin-top-right" : "absolute left-full ml-2 bottom-0"} w-[26rem] max-w-[calc(100vw-1.5rem)] max-h-[70vh] bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg border border-[var(--color-border-strong)] shadow-[0_30px_60px_-24px_rgb(11_18_32/0.55)] z-[90] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150`}>
            <div className="px-4 pt-3 pb-3 border-b border-[var(--color-border-strong)]">
              <div className="flex items-center gap-3">
                <span aria-hidden className="ui-icon-tile is-sm is-solid"><Bell className="w-4 h-4" /></span>
                <h2 className="min-w-0 flex-1 font-display text-[19px] font-semibold leading-tight">
                  {unread === 0 ? "All caught up" : `${unread} ${unread === 1 ? "thing needs" : "things need"} you`}
                </h2>
                <Link href="/settings/notifications" onClick={() => setOpen(false)} className={`text-[14px] ${link}`}>Settings</Link>
              </div>
              {unread > 0 && (
                <dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-[var(--color-text-muted)]">
                  <div className="inline-flex items-center gap-1.5"><dd className={`ui-count ${facts.overdue ? "is-bad" : ""}`}>{facts.overdue}</dd><dt>Overdue</dt></div>
                  <div className="inline-flex items-center gap-1.5"><dd className={`ui-count ${decisions ? "is-solid" : ""}`}>{decisions}</dd><dt>Waiting on you</dt></div>
                  <div className="inline-flex items-center gap-1.5"><dd className="ui-count">{facts.news}</dd><dt>Updates</dt></div>
                </dl>
              )}
              {markError && <div role="alert" className="mt-1 text-[13px] font-semibold text-[var(--state-overdue)]">{markError}</div>}
              <div className="mt-3 flex items-center gap-2">
                <button type="button" onClick={() => { setOpen(false); openCenter("all"); }} className={rowBtn} title="Open the full notification panel">See all</button>
                {hasNotifRows && (
                  <button
                    type="button"
                    title="Items waiting on your decision stay until you open them"
                    onClick={async () => { setMarkError(null); try { await markAllRead(); } catch (e) { setMarkError(`Not marked read: ${e instanceof Error ? e.message : String(e)}`); } }}
                    className={rowBtn}
                  >
                    <CheckCheck className="w-3.5 h-3.5" /> Mark all read
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="py-8 flex justify-center items-center gap-2 text-[14px] text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /> Loading notifications…</div>
              ) : items.length === 0 ? (
                <div className="px-4 py-6 text-[15px] text-[var(--color-text-muted)]">Nothing needs you. You&rsquo;re all caught up.</div>
              ) : (
                <NeedsTable rows={rows} label="Notifications" onOpen={(r) => { void onItemOpen(r.notificationId); }} />
              )}
            </div>
        </div>
      )}
    </div>
  );
}
