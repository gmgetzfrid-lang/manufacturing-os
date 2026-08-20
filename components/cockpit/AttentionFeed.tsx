"use client";

// ─── ATTENTION FEED ────────────────────────────────────────────────────────
// The notifications, reimagined: color-coded by type, action items flagged and
// pulled to the eye, relative timestamps, one-tap mark-read on notification
// rows, a filter, and "mark all read". The SAME unified items the sidebar
// badge + header bell show — just made to actually work as a surface.
//
// Extracted verbatim from /inbox so it can be reused both on the cockpit page
// and as the dashboard's "Needs You" widget. Behavior is identical in both.

import React from "react";
import Link from "next/link";
import {
  Bell, Loader2, AlertTriangle, MessageSquare, Flag, ChevronRight,
  Send, Zap, ClipboardList, AtSign, GitBranch, Layers, Lock, AlertOctagon,
  FileSignature, CheckCheck, Briefcase,
} from "lucide-react";
import type { AttentionItem } from "@/hooks/useTicketNotifications";
import { formatAgo } from "@/components/cockpit/CommandDeck";

export type AttnFilter = "all" | "action" | "unread";

const FEED_TONES: Record<string, string> = {
  orange: "bg-orange-50 text-[var(--color-accent)] border-orange-200",
  blue: "bg-blue-50 text-blue-600 border-blue-200",
  indigo: "bg-indigo-50 text-indigo-600 border-indigo-200",
  violet: "bg-violet-50 text-violet-600 border-violet-200",
  rose: "bg-rose-50 text-rose-600 border-rose-200",
  amber: "bg-amber-50 text-amber-600 border-amber-200",
  emerald: "bg-emerald-50 text-emerald-600 border-emerald-200",
  slate: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]",
};

function attentionVisual(item: AttentionItem): { Icon: React.ComponentType<{ className?: string }>; tone: string } {
  if (item.actionRequired) return { Icon: Zap, tone: "orange" };
  const k = String(item.kind).toLowerCase();
  if (k.includes("reminder")) return { Icon: Bell, tone: "amber" };
  if (k.includes("mention")) return { Icon: AtSign, tone: "violet" };
  if (k.includes("comment") || k.includes("message")) return { Icon: MessageSquare, tone: "blue" };
  if (k.includes("conflict")) return { Icon: AlertTriangle, tone: "amber" };
  if (k.includes("checkout") || k.includes("lock")) return { Icon: Lock, tone: "indigo" };
  if (k.includes("markup")) return { Icon: FileSignature, tone: "violet" };
  if (k.includes("hold")) return { Icon: AlertOctagon, tone: "rose" };
  if (k.includes("milestone")) return { Icon: Flag, tone: "emerald" };
  if (k.includes("rev") || k.includes("revision") || k.includes("version")) return { Icon: GitBranch, tone: "blue" };
  if (k.includes("transmittal")) return { Icon: Send, tone: "blue" };
  if (k.includes("approval") || k.includes("request") || k.includes("assign")) return { Icon: Briefcase, tone: "orange" };
  if (k.includes("equipment") || k.includes("asset")) return { Icon: Layers, tone: "amber" };
  return { Icon: Bell, tone: "slate" };
}

export interface AttentionFeedProps {
  items: AttentionItem[];
  counts: { all: number; action: number; unread: number };
  filter: AttnFilter;
  onFilter: (f: AttnFilter) => void;
  onMarkRead: (id: string) => void;
  onMarkAll: () => void;
  markingAll: boolean;
}

const KIND_GROUPS: Array<{ key: string; label: string; match: (k: string) => boolean }> = [
  { key: "mentions", label: "Mentions & comments", match: (k) => k.includes("mention") || k.includes("comment") || k.includes("message") },
  { key: "documents", label: "Documents & revisions", match: (k) => k.includes("rev") || k.includes("version") || k.includes("doc") || k.includes("review") || k.includes("ack") || k.includes("effective") || k.includes("retention") || k.includes("transmittal") },
  { key: "requests", label: "Requests", match: (k) => k.includes("ticket") || k.includes("assign") || k.includes("approval") || k.includes("engineer") || k.includes("markup") },
  { key: "locks", label: "Checkouts & holds", match: (k) => k.includes("checkout") || k.includes("lock") || k.includes("hold") || k.includes("conflict") },
];

function groupOf(kind: string): string {
  const k = kind.toLowerCase();
  for (const g of KIND_GROUPS) if (g.match(k)) return g.key;
  return "other";
}

export function AttentionFeed({ items, counts, filter, onFilter, onMarkRead, onMarkAll, markingAll }: AttentionFeedProps) {
  const [visibleCount, setVisibleCount] = React.useState(30);
  // Second axis: filter by WHAT the notification is about. A DocCtrl drowning
  // in publish fan-out can isolate their mentions in one tap.
  const [group, setGroup] = React.useState<string>("all");
  const grouped = group === "all" ? items : items.filter((i) => groupOf(String(i.kind)) === group);
  // Fresh page window whenever either filter axis changes — a stale offset
  // from a longer list must not hide the top of a shorter one.
  React.useEffect(() => { setVisibleCount(30); }, [filter, group]);
  const FILTERS: Array<{ key: AttnFilter; label: string; n: number }> = [
    { key: "all", label: "All", n: counts.all },
    { key: "action", label: "Action", n: counts.action },
    { key: "unread", label: "Activity", n: counts.unread },
  ];

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <ClipboardList className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-black text-[var(--color-text)]">Needs your attention</span>
        {counts.all > 0 && (
          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-orange-500 text-[var(--color-text)] text-xs font-black">{counts.all}</span>
        )}
        {/* One fixed-width segmented pill + Mark-all — everything else lives
            on its own WRAPPING chip row below. The old layout packed the
            group chips into this same non-wrapping row: at phone width the
            card's overflow-hidden clipped them (and often Mark-all) clean
            off screen, untappable. */}
        <div className="ml-auto flex items-center gap-2 flex-wrap min-w-0">
          {/* Segmented filter */}
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)]">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => onFilter(f.key)}
                className={`inline-flex items-center gap-1 px-2 h-8 sm:h-6 rounded-md text-[11px] font-bold transition-colors ${
                  filter === f.key ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {f.label}
                <span className={`text-[10px] ${filter === f.key ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"}`}>{f.n}</span>
              </button>
            ))}
          </div>
          {counts.unread > 0 && (
            <button
              onClick={onMarkAll}
              disabled={markingAll}
              title="Mark all notifications read"
              className="inline-flex items-center gap-1 px-2 h-8 sm:h-7 rounded-lg text-[11px] font-bold text-[var(--color-text-faint)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            >
              {markingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCheck className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">Mark all read</span>
            </button>
          )}
        </div>
      </div>

      {/* Kind-group chips — their own wrapping row, so every chip stays
          visible and tappable at any width. */}
      {counts.all > 0 && (
        <div className="px-4 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setGroup("all")}
            className={`px-2.5 py-1.5 sm:py-1 rounded-full text-[10px] font-bold ${group === "all" ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
          >
            Everything
          </button>
          {KIND_GROUPS.map((g) => {
            const n = items.filter((i) => groupOf(String(i.kind)) === g.key).length;
            // Keep the ACTIVE group's chip visible even at zero — otherwise the
            // only affordance showing (and clearing) the filter disappears.
            if (n === 0 && group !== g.key) return null;
            return (
              <button
                key={g.key}
                onClick={() => setGroup(group === g.key ? "all" : g.key)}
                className={`px-2.5 py-1.5 sm:py-1 rounded-full text-[10px] font-bold ${group === g.key ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
              >
                {g.label} · {n}
              </button>
            );
          })}
        </div>
      )}

      {counts.all === 0 ? (
        <div className="px-4 py-10 text-center">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center mb-3">
            <CheckCheck className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
          </div>
          <div className="text-sm font-bold text-[var(--color-text)]">You&apos;re all caught up</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-1">Nothing needs your attention right now.</div>
        </div>
      ) : grouped.length === 0 ? (
        <div className="px-4 py-10 text-center text-xs text-[var(--color-text-muted)] italic">Nothing in this filter.</div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] max-h-[28rem] overflow-y-auto">
          {grouped.slice(0, visibleCount).map((item) => (
            <AttentionRow key={item.key} item={item} onMarkRead={onMarkRead} />
          ))}
          {grouped.length > visibleCount && (
            <button
              onClick={() => setVisibleCount((v) => v + 30)}
              className="w-full py-2 text-xs font-bold text-[var(--color-accent)] hover:underline"
            >
              Show {Math.min(30, grouped.length - visibleCount)} more ({grouped.length - visibleCount} hidden)
            </button>
          )}
        </ul>
      )}
    </div>
  );
}

function AttentionRow({ item, onMarkRead }: { item: AttentionItem; onMarkRead: (id: string) => void }) {
  const { Icon, tone } = attentionVisual(item);
  return (
    <li className="relative group">
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${item.actionRequired ? "bg-orange-400" : "bg-transparent group-hover:bg-[var(--color-border-strong)]"}`} />
      <Link
        href={item.link}
        onClick={() => { if (item.notificationId) onMarkRead(item.notificationId); }}
        className="flex items-center gap-3 pl-4 pr-3 py-2.5 hover:bg-[var(--color-canvas)]"
      >
        <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${FEED_TONES[tone] ?? FEED_TONES.slate}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-[var(--color-text)] truncate">{item.title}</div>
          <div className={`text-[11px] font-semibold truncate ${item.actionRequired ? "text-orange-700" : "text-[var(--color-text-muted)]"}`}>
            {item.subtitle || "New activity"}
          </div>
        </div>
        {item.actionRequired && (
          <span className="text-[9px] font-black uppercase tracking-wider text-[var(--color-accent)] bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5 shrink-0">Action</span>
        )}
        <span className="text-[10px] text-[var(--color-text-muted)] shrink-0 tabular-nums">{formatAgo(item.when || undefined)}</span>
        {item.notificationId ? (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMarkRead(item.notificationId!); }}
            title="Mark read"
            // p-2 -m-1: ~32px touch target without growing the visual — a
            // near-miss used to hit the surrounding Link and navigate away.
            className="p-2 -m-1 rounded-md text-[var(--color-text)] hover:text-emerald-600 hover:bg-emerald-50 shrink-0"
          >
            <CheckCheck className="w-4 h-4" />
          </button>
        ) : (
          <ChevronRight className="w-4 h-4 text-[var(--color-text)] shrink-0" />
        )}
      </Link>
    </li>
  );
}
