"use client";

// NotificationBell — header bell icon + dropdown drawer.
//
// Renders the SAME unified attention feed as the sidebar badge and the /inbox
// cockpit (via useTicketNotifications), so the count and the items always match
// across all three surfaces. The feed merges action-required tickets, unread
// ticket activity, and unread in-app notification rows.
//
// Accessible (NEDGE-5, notifications Round G N3): the trigger is named
// "Notifications, N need attention" (the count span is decorative), says it
// opens a dialog and whether it is open; a polite live region announces the
// count when it changes; the drawer is a labelled dialog that takes focus
// when it opens and hands it back to the bell when it closes (Escape, as
// before, closes it). Two counts, two words (RT-9): "need attention" is
// everything in the feed; "need action" is the part only doing the work
// clears — "Mark notifications read" clears notification rows, never that.
// The icon per kind is the registry's (components/notifications/kindIcon.ts).

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { useTicketNotifications, type AttentionItem } from "@/hooks/useTicketNotifications";
import { useNotificationCenter } from "@/components/notifications/NotificationCenter";
import { iconForKind } from "@/components/notifications/kindIcon";

interface NotificationBellProps {
  /** The header bell is the only bell (TopBar). The prop is kept so the
   *  mount reads as it always did; the never-mounted sidebar variant is gone. */
  variant?: "header";
}

/** The trigger's accessible name — the number lives here, not in the badge. */
export function bellLabel(attention: number): string {
  return attention > 0 ? `Notifications, ${attention} need${attention === 1 ? "s" : ""} attention` : "Notifications";
}

/** What the live region says: the count, in the drawer header's two words
 *  (RT-9) — "need attention" is everything in the feed, "need action" the
 *  part only doing the work clears. The things counted are "items", as the
 *  sidebar badge and the center say: a request in the feed is not a
 *  notification, and "Mark notifications read" never clears it (integrator
 *  fix — the region used to call every item a "notification"). */
export function bellAnnouncement(attention: number, action: number): string {
  if (attention <= 0) return "Nothing needs attention";
  return `${attention} item${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention${action > 0 ? `, ${action} need${action === 1 ? "s" : ""} action` : ""}`;
}

export default function NotificationBell(_props: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const { items, count, counts, actionRequiredCount, loading, markRead, markAllRead } = useTicketNotifications();
  const { open: openCenter } = useNotificationCenter();
  const unread = count;

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

  // Focus (NEDGE-5 dw3): opening moves focus into the dialog; closing hands
  // it back to the bell — only when focus has nowhere better to be (it was in
  // the dialog that just went away, or nowhere). A click elsewhere keeps the
  // focus it gave.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus({ preventScroll: true });
    const trigger = triggerRef.current;
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body) trigger?.focus({ preventScroll: true });
    };
  }, [open]);

  // Only notification ROWS can be "marked read"; ticket items are live and clear
  // themselves when the underlying work is done.
  const hasNotifRows = useMemo(() => items.some((i) => i.source === "notification"), [items]);
  // What "Mark notifications read" leaves behind (RT-9): the requests in the
  // feed, which clear when the work is done or the request is opened.
  const remaining = counts.all - counts.notifications;

  const onItemClick = async (item: AttentionItem) => {
    if (item.notificationId) {
      try { await markRead(item.notificationId); } catch { /* swallow */ }
    }
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={bellLabel(unread)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        title={unread > 0 ? `${unread} need${unread === 1 ? "s" : ""} attention` : "Notifications"}
        className={`relative w-9 h-9 inline-flex items-center justify-center rounded-full transition-all ${
          open ? "bg-slate-900 text-white" : "bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)]"
        }`}
      >
        <Bell className="w-4 h-4" aria-hidden />
        {unread > 0 && (
          <span aria-hidden className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-orange-500 text-white text-[10px] font-black ring-2 ring-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {/* The one polite live region for the count (NEDGE-5 dw2): a new
          notification changes it and is said once. Silent while loading. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-bell-live>
        {loading ? "" : bellAnnouncement(unread, actionRequiredCount)}
      </span>

      {open && (
        <div
          ref={dialogRef}
          id={dialogId}
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          className="absolute right-0 top-full mt-2 origin-top-right w-96 max-h-[70vh] bg-[var(--color-surface)] text-[var(--color-text)] rounded-xl shadow-lg border border-[var(--color-border)] ring-1 ring-black/5 z-[90] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150 outline-none"
        >
            <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between bg-[var(--color-surface-2)]">
              <div>
                <div className="text-sm font-black text-[var(--color-text)]">Notifications</div>
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  {unread > 0 ? `${unread} need${unread === 1 ? "s" : ""} attention` : "All caught up"}
                  {actionRequiredCount > 0 && (
                    <span className="ml-1.5 font-black text-orange-600" data-bell-action>
                      · {actionRequiredCount} need{actionRequiredCount === 1 ? "s" : ""} action
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {hasNotifRows && (
                  <button
                    type="button"
                    onClick={async () => { await markAllRead(); }}
                    title={remaining > 0
                      ? `Marks the ${counts.notifications} notification${counts.notifications === 1 ? "" : "s"} read. ${remaining} request${remaining === 1 ? " stays" : "s stay"} until the work is done or the request is opened.`
                      : `Marks the ${counts.notifications} notification${counts.notifications === 1 ? "" : "s"} read.`}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  >
                    <CheckCheck className="w-3.5 h-3.5" aria-hidden /> Mark notifications read
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { setOpen(false); openCenter("all"); }}
                  className="text-[11px] font-bold text-[var(--color-accent)] hover:underline"
                  title="Open the full notification center — filters, mark read, everything in one panel"
                >
                  See all
                </button>
                <Link href="/settings/notifications" onClick={() => setOpen(false)} className="text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                  Settings
                </Link>
              </div>
            </div>
            {/* RT-9: what "Mark notifications read" cannot clear, said in place. */}
            {remaining > 0 && (
              <div className="px-4 py-1.5 border-b border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]" data-bell-remaining>
                {remaining} request{remaining === 1 ? "" : "s"} in this list {remaining === 1 ? "clears" : "clear"} when the work is done or the request is opened — marking notifications read leaves {remaining === 1 ? "it" : "them"}.
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-text-faint)]" aria-label="Loading" /></div>
              ) : items.length === 0 ? (
                <div className="py-10 text-center text-xs italic text-[var(--color-text-faint)]">You&rsquo;re all caught up.</div>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {items.map((item) => {
                    const Icon = iconForKind(String(item.kind));
                    const tone = item.actionRequired ? "bg-orange-50 text-orange-700 border-orange-200" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]";
                    return (
                      <li key={item.key}>
                        <Link href={item.link} onClick={() => void onItemClick(item)}>
                          <div className={`px-4 py-3 flex items-start gap-3 ${item.actionRequired ? "bg-orange-50/30" : ""} hover:bg-[var(--color-surface-2)] cursor-pointer`}>
                            <div className={`shrink-0 w-8 h-8 rounded-lg border flex items-center justify-center ${tone}`}>
                              <Icon className="w-4 h-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-bold text-[var(--color-text)] truncate">{item.title}</div>
                              {item.subtitle && <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 line-clamp-2">{item.subtitle}</div>}
                              <div className="text-[10px] text-[var(--color-text-faint)] mt-1 flex items-center gap-2">
                                {item.actionRequired && <span className="font-black uppercase tracking-wider text-orange-600">Action needed</span>}
                                <time dateTime={item.when}>{formatTime(item.when)}</time>
                              </div>
                            </div>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}
