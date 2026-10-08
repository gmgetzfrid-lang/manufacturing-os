"use client";

// ─── ATTENTION FEED ────────────────────────────────────────────────────────
// The notifications, reimagined: color-coded by type, action items flagged and
// pulled to the eye, relative timestamps, one-tap mark-read on notification
// rows, a filter, and "mark all read". The SAME unified items the sidebar
// badge + header bell show — just made to actually work as a surface.
//
// Extracted verbatim from /inbox so it can be reused both on the cockpit page
// and as the dashboard's "Needs You" widget. Behavior is identical in both.
//
// A row's icon, tone and group chip come from ONE table — lib/notificationKinds.ts
// KIND_META (notifications Round G, N3; TAX-5 / DEC-81 §1) — instead of the
// substring predicates that used to live here: the icon is the bell's
// (components/notifications/kindIcon.ts), so a row looks the same in both.
// The words (RT-9): "Action" is what needs you to do something, "Activity"
// everything else (the vocabulary note in hooks/useTicketNotifications.ts).

import React from "react";
import Link from "next/link";
import { Loader2, ChevronRight, ClipboardList, CheckCheck } from "lucide-react";
import type { AttentionItem, AttentionCounts } from "@/hooks/useTicketNotifications";
import { formatAgo } from "@/components/cockpit/CommandDeck";
import { kindMeta, type KindGroup, type KindTone } from "@/lib/notificationKinds";
import { iconForKind, type IconComponent } from "@/components/notifications/kindIcon";

// The key matches its label (TAX-7): "activity" is the feed's non-action
// items — not DB-unread; see the vocabulary note in useTicketNotifications.
export type AttnFilter = "all" | "action" | "activity";

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

/** A row's icon and tile tone. The icon is the kind's (KIND_META.icon — the
 *  bell draws the same one); the tone is the kind's (KIND_META.tone), except
 *  that an action item is always orange — it is pulled to the eye. A ticket
 *  row and a legacy kind no union declares are slate. */
export function attentionVisual(item: Pick<AttentionItem, "kind" | "actionRequired">): { Icon: IconComponent; tone: KindTone } {
  const Icon = iconForKind(String(item.kind));
  if (item.actionRequired) return { Icon, tone: "orange" };
  return { Icon, tone: kindMeta(String(item.kind))?.tone ?? "slate" };
}

export interface AttentionFeedProps {
  items: AttentionItem[];
  /** The hook's counts (useTicketNotifications().counts), never recounted here. */
  counts: AttentionCounts;
  filter: AttnFilter;
  onFilter: (f: AttnFilter) => void;
  onMarkRead: (id: string) => void;
  onMarkAll: () => void;
  markingAll: boolean;
  /** The sidebar section the list is scoped to (the Notification Center
   *  opened from a section badge): the empty state names it, and "mark
   *  read" says it clears this list's rows only. */
  scopeLabel?: string;
}

/** The group chips, in order — KIND_META.group's keys ('other' has no chip
 *  and shows under "Everything"). */
const KIND_GROUPS: Array<{ key: Exclude<KindGroup, "other">; label: string }> = [
  { key: "mentions", label: "Mentions & comments" },
  { key: "documents", label: "Documents & revisions" },
  { key: "requests", label: "Requests" },
  { key: "locks", label: "Checkouts & holds" },
];

/** A row's group: the kind's (KIND_META.group); a ticket row is a request; a
 *  legacy kind no union declares has no chip. */
export function groupOf(kind: string): KindGroup {
  if (kind === "ticket") return "requests";
  return kindMeta(kind)?.group ?? "other";
}

export function AttentionFeed({ items, counts, filter, onFilter, onMarkRead, onMarkAll, markingAll, scopeLabel }: AttentionFeedProps) {
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
    { key: "activity", label: "Activity", n: counts.activity },
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
          {/* Offered whenever the feed holds a notification row — what
              markAllRead clears, action rows included — whichever filter is
              showing: the header bell's rule. */}
          {counts.notifications > 0 && (
            <button
              type="button"
              onClick={onMarkAll}
              disabled={markingAll}
              title={scopeLabel ? `Mark the notifications in ${scopeLabel} read` : "Mark all notifications read"}
              aria-label={scopeLabel ? `Mark the notifications in ${scopeLabel} read` : "Mark all notifications read"}
              className="inline-flex items-center gap-1 px-2 h-8 sm:h-7 rounded-lg text-[11px] font-bold text-[var(--color-text-faint)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            >
              {markingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <CheckCheck className="w-3.5 h-3.5" aria-hidden />}
              <span className="hidden sm:inline">{scopeLabel ? "Mark these read" : "Mark all read"}</span>
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
          <div className="text-sm font-bold text-[var(--color-text)]">You&apos;re all caught up{scopeLabel ? ` in ${scopeLabel}` : ""}</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-1">
            {scopeLabel ? `Nothing in ${scopeLabel} needs your attention right now.` : "Nothing needs your attention right now."}
          </div>
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
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMarkRead(item.notificationId!); }}
            title="Mark read"
            aria-label={`Mark read: ${item.title}`}
            // p-2 -m-1: ~32px touch target without growing the visual — a
            // near-miss used to hit the surrounding Link and navigate away.
            className="p-2 -m-1 rounded-md text-[var(--color-text)] hover:text-emerald-600 hover:bg-emerald-50 shrink-0"
          >
            <CheckCheck className="w-4 h-4" aria-hidden />
          </button>
        ) : (
          <ChevronRight className="w-4 h-4 text-[var(--color-text)] shrink-0" aria-hidden />
        )}
      </Link>
    </li>
  );
}
