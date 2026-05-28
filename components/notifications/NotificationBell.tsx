"use client";

// NotificationBell — header bell icon + dropdown drawer for the in-app
// notification inbox. Sits in the sidebar above the user card.
//
// Reads from the notifications table via lib/inAppNotifications.
// Realtime-subscribed so new notifications append live + the unread
// count badge updates without a refresh.

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bell, Check, CheckCheck, Loader2, MessageSquare, AlertOctagon, GitBranch, Briefcase, FileSignature, Lock, UserPlus, FileText } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  type NotificationRow,
  type NotificationKind,
  listMyNotifications,
  markRead,
  markAllRead,
} from "@/lib/inAppNotifications";

const KIND_ICON: Record<NotificationKind, React.ComponentType<{ className?: string }>> = {
  ticket_comment: MessageSquare,
  ticket_mention: MessageSquare,
  ticket_status: FileText,
  ticket_assigned: UserPlus,
  checkout_conflict: AlertOctagon,
  checkout_handoff: Lock,
  checkout_message: MessageSquare,
  project_member: Briefcase,
  project_status: Briefcase,
  hold_opened: AlertOctagon,
  hold_released: Check,
  markup_request: FileSignature,
  doc_superseded: GitBranch,
};

const KIND_TONE: Record<NotificationKind, string> = {
  ticket_comment: "bg-slate-50 text-slate-600 border-slate-200",
  ticket_mention: "bg-amber-50 text-amber-700 border-amber-200",
  ticket_status: "bg-blue-50 text-blue-700 border-blue-200",
  ticket_assigned: "bg-indigo-50 text-indigo-700 border-indigo-200",
  checkout_conflict: "bg-rose-50 text-rose-700 border-rose-200",
  checkout_handoff: "bg-indigo-50 text-indigo-700 border-indigo-200",
  checkout_message: "bg-slate-50 text-slate-600 border-slate-200",
  project_member: "bg-indigo-50 text-indigo-700 border-indigo-200",
  project_status: "bg-blue-50 text-blue-700 border-blue-200",
  hold_opened: "bg-rose-50 text-rose-700 border-rose-200",
  hold_released: "bg-emerald-50 text-emerald-700 border-emerald-200",
  markup_request: "bg-violet-50 text-violet-700 border-violet-200",
  doc_superseded: "bg-amber-50 text-amber-700 border-amber-200",
};

interface NotificationBellProps {
  userId: string;
  /** Force-collapsed sidebar layout (icon-only) vs expanded (icon + label). */
  collapsed?: boolean;
}

export default function NotificationBell({ userId, collapsed }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);

  const unread = useMemo(() => rows.filter((r) => !r.readAt).length, [rows]);

  const refresh = async () => {
    try {
      const list = await listMyNotifications({ limit: 50 });
      setRows(list);
    } catch (e) {
      console.warn("[NotificationBell] list failed", e);
    } finally {
      setLoading(false);
    }
  };

  // Initial load + realtime subscription on the recipient's own rows.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setLoading(true);
    void refresh().then(() => { if (!alive) return; });

    const channel = supabase
      .channel(`notifs-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        () => { if (alive) void refresh(); },
      )
      .subscribe();
    return () => { alive = false; supabase.removeChannel(channel); };
  }, [userId]);

  const onRowClick = async (row: NotificationRow) => {
    if (!row.readAt) {
      try { await markRead(row.id); } catch { /* swallow */ }
    }
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}
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

      {open && (
        <>
          {/* click-outside backdrop */}
          <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} />
          <div className="absolute left-full ml-2 bottom-0 w-96 max-h-[70vh] bg-white rounded-2xl shadow-2xl border border-slate-200 z-[90] flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <div className="text-sm font-black text-slate-900">Notifications</div>
                <div className="text-[10px] text-slate-500">{unread > 0 ? `${unread} unread` : "All caught up"}</div>
              </div>
              <div className="flex items-center gap-3">
                {unread > 0 && (
                  <button
                    onClick={async () => { await markAllRead(); void refresh(); }}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 hover:text-slate-900"
                  >
                    <CheckCheck className="w-3.5 h-3.5" /> Mark all read
                  </button>
                )}
                <Link
                  href="/settings/notifications"
                  onClick={() => setOpen(false)}
                  className="text-[11px] font-bold text-slate-500 hover:text-slate-900"
                >
                  Settings
                </Link>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
              ) : rows.length === 0 ? (
                <div className="py-10 text-center text-xs italic text-slate-400">No notifications yet.</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {rows.map((r) => {
                    const Icon = KIND_ICON[r.kind] ?? Bell;
                    const tone = KIND_TONE[r.kind] ?? "bg-slate-50 text-slate-600 border-slate-200";
                    const inner = (
                      <div className={`px-4 py-3 flex items-start gap-3 ${r.readAt ? "" : "bg-blue-50/40"} hover:bg-slate-50 cursor-pointer`}>
                        <div className={`shrink-0 w-8 h-8 rounded-lg border flex items-center justify-center ${tone}`}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-bold text-slate-900 truncate">{r.title}</div>
                          {r.body && <div className="text-[11px] text-slate-600 mt-0.5 line-clamp-2">{r.body}</div>}
                          <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-2">
                            {r.actorName && <span className="font-medium text-slate-500">{r.actorName}</span>}
                            <time dateTime={r.createdAt}>{formatTime(r.createdAt)}</time>
                          </div>
                        </div>
                        {!r.readAt && (
                          <button
                            title="Mark as read"
                            onClick={async (e) => { e.preventDefault(); e.stopPropagation(); await markRead(r.id); void refresh(); }}
                            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    );
                    return (
                      <li key={r.id}>
                        {r.link ? (
                          <Link href={r.link} onClick={() => void onRowClick(r)}>
                            {inner}
                          </Link>
                        ) : (
                          <div onClick={() => void onRowClick(r)}>{inner}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </>
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
