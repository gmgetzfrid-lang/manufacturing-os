"use client";

// NotificationBell — header bell icon + dropdown drawer.
//
// Renders the SAME unified attention feed as the sidebar badge and the /inbox
// cockpit (via useTicketNotifications), so the count and the items always match
// across all three surfaces. The feed merges action-required tickets, unread
// ticket activity, and unread in-app notification rows.

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Bell, Check, CheckCheck, Loader2, MessageSquare, AlertOctagon, GitBranch,
  Briefcase, FileSignature, Lock, UserPlus, FileText, ListChecks, MailPlus, ClipboardList,
} from "lucide-react";
import { useTicketNotifications, type AttentionItem } from "@/hooks/useTicketNotifications";

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  ticket: ClipboardList,
  ticket_comment: MessageSquare,
  ticket_mention: MessageSquare,
  ticket_status: FileText,
  ticket_assigned: UserPlus,
  checkout_conflict: AlertOctagon,
  checkout_handoff: Lock,
  checkout_message: MessageSquare,
  revision_published_over_checkout: GitBranch,
  project_member: Briefcase,
  project_status: Briefcase,
  hold_opened: AlertOctagon,
  hold_released: Check,
  markup_request: FileSignature,
  doc_superseded: GitBranch,
  task_overdue_digest: ListChecks,
  request_pending_approval: MailPlus,
};

interface NotificationBellProps {
  collapsed?: boolean;
  variant?: "sidebar" | "header";
}

export default function NotificationBell({ collapsed, variant = "sidebar" }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { items, count, loading, markRead, markAllRead } = useTicketNotifications();
  const isHeader = variant === "header";
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

  // Only notification ROWS can be "marked read"; ticket items are live and clear
  // themselves when the underlying work is done.
  const hasNotifRows = useMemo(() => items.some((i) => i.source === "notification"), [items]);

  const onItemClick = async (item: AttentionItem) => {
    if (item.notificationId) {
      try { await markRead(item.notificationId); } catch { /* swallow */ }
    }
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      {isHeader ? (
        <button
          onClick={() => setOpen((v) => !v)}
          title={unread > 0 ? `${unread} need${unread === 1 ? "s" : ""} attention` : "Notifications"}
          className={`relative w-9 h-9 inline-flex items-center justify-center rounded-full transition-all ${
            open ? "bg-slate-900 text-white" : "bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)]"
          }`}
        >
          <Bell className="w-4 h-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-orange-500 text-white text-[10px] font-black ring-2 ring-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          title={unread > 0 ? `${unread} need attention` : "Notifications"}
          className={`relative w-full flex items-center px-3 py-2.5 rounded-lg transition-all group ${open ? "bg-slate-800 text-white" : "hover:bg-slate-800 hover:text-white"}`}
        >
          <Bell className={`w-5 h-5 ${collapsed ? "" : "mr-3"} text-slate-300 group-hover:text-white`} />
          {!collapsed && <span className="text-sm font-medium">Notifications</span>}
          {unread > 0 && (
            <span className={`${collapsed ? "absolute top-1 right-1" : "ml-auto"} inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-orange-500 text-white text-[10px] font-black`}>
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      )}

      {open && (
        <div className={`${isHeader ? "absolute right-0 top-full mt-2 origin-top-right" : "absolute left-full ml-2 bottom-0"} w-96 max-h-[70vh] bg-[var(--color-surface)] text-[var(--color-text)] rounded-xl shadow-lg border border-[var(--color-border)] ring-1 ring-black/5 z-[90] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150`}>
            <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between bg-[var(--color-surface-2)]">
              <div>
                <div className="text-sm font-black text-[var(--color-text)]">Notifications</div>
                <div className="text-[10px] text-[var(--color-text-muted)]">{unread > 0 ? `${unread} need${unread === 1 ? "s" : ""} attention` : "All caught up"}</div>
              </div>
              <div className="flex items-center gap-3">
                {hasNotifRows && (
                  <button
                    onClick={async () => { await markAllRead(); }}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  >
                    <CheckCheck className="w-3.5 h-3.5" /> Mark all read
                  </button>
                )}
                <Link href="/settings/notifications" onClick={() => setOpen(false)} className="text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                  Settings
                </Link>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-text-faint)]" /></div>
              ) : items.length === 0 ? (
                <div className="py-10 text-center text-xs italic text-[var(--color-text-faint)]">You&rsquo;re all caught up.</div>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {items.map((item) => {
                    const Icon = KIND_ICON[item.kind] ?? Bell;
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
