"use client";

// The attention feed: everything that needs you, as the "Needs you" table:
// late rows first with a red edge, a status and a date on each, the row
// opens it, and a mark-read button on news. Underline tabs pick all / your
// turn / updates (plain counts); quiet chips narrow to one kind (mentions,
// documents, requests, checkouts). The SAME unified items the sidebar badge
// and the header bell count.
//
// Used on the Inbox, as the dashboard's "Notifications" widget, and in the
// notification panel. Behavior is identical in all three.

import React from "react";
import { Loader2, CheckCheck } from "lucide-react";
import type { AttentionItem } from "@/hooks/useTicketNotifications";
import { buildNeeds } from "./needsYou";
import NeedsTable from "./NeedsTable";
import { sheet, rowBtn } from "./ui";

export type AttnFilter = "all" | "action" | "unread";

export interface AttentionFeedProps {
  items: AttentionItem[];
  counts: { all: number; action: number; unread: number };
  filter: AttnFilter;
  onFilter: (f: AttnFilter) => void;
  onMarkRead: (id: string) => void;
  onMarkAll: () => void;
  markingAll: boolean;
  /** Inside something already white (a widget, the notification panel): no
   *  sheet of its own, and it runs edge to edge (its rows carry their own
   *  side padding). */
  plain?: boolean;
  /** When the person last opened their notifications: news after it reads
   *  as new. */
  seenAt?: number | null;
}

const KIND_GROUPS: Array<{ key: string; label: string; match: (k: string) => boolean }> = [
  { key: "mentions", label: "Mentions and comments", match: (k) => k.includes("mention") || k.includes("comment") || k.includes("message") },
  { key: "documents", label: "Documents and revisions", match: (k) => k.includes("rev") || k.includes("version") || k.includes("doc") || k.includes("review") || k.includes("ack") || k.includes("effective") || k.includes("retention") || k.includes("transmittal") },
  { key: "requests", label: "Requests", match: (k) => k.includes("ticket") || k.includes("assign") || k.includes("approval") || k.includes("engineer") || k.includes("markup") },
  { key: "locks", label: "Checkouts and holds", match: (k) => k.includes("checkout") || k.includes("lock") || k.includes("hold") || k.includes("conflict") },
];

/** A filter chip while it is the filter: a quiet edge in the current
 *  color, never a fill. */
const tagOn = "!bg-[var(--color-surface)] !border-[var(--color-current)] !text-[var(--color-text)]";

function groupOf(kind: string): string {
  const k = kind.toLowerCase();
  for (const g of KIND_GROUPS) if (g.match(k)) return g.key;
  return "other";
}

export function AttentionFeed({ items, counts, filter, onFilter, onMarkRead, onMarkAll, markingAll, plain = false, seenAt }: AttentionFeedProps) {
  const [visibleCount, setVisibleCount] = React.useState(30);
  // Second axis: filter by WHAT the notification is about. A DocCtrl drowning
  // in publish fan-out can isolate their mentions in one step.
  const [group, setGroup] = React.useState<string>("all");
  const grouped = React.useMemo(() => (group === "all" ? items : items.filter((i) => groupOf(String(i.kind)) === group)), [items, group]);
  const rows = React.useMemo(() => buildNeeds(grouped), [grouped]);
  // Fresh page window whenever either filter changes: a stale offset from a
  // longer list must not hide the top of a shorter one.
  React.useEffect(() => { setVisibleCount(30); }, [filter, group]);
  const TABS: Array<{ key: AttnFilter; label: string; n: number }> = [
    { key: "all", label: "All", n: counts.all },
    { key: "action", label: "Your turn", n: counts.action },
    { key: "unread", label: "Updates", n: counts.unread },
  ];
  const groupCounts = KIND_GROUPS.map((g) => ({ ...g, n: items.filter((i) => groupOf(String(i.kind)) === g.key).length }));

  const bar = (
    <div className={`flex items-end gap-x-3 flex-wrap shadow-[inset_0_-1px_0_var(--color-border)] ${plain ? "px-4" : "mb-3"}`}>
      <div role="tablist" aria-label="Show" className="flex items-end gap-5 min-w-0">
        {TABS.map((t) => {
          const on = filter === t.key;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => onFilter(t.key)}
              className={`inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 border-b-2 text-[15px] transition-colors ${on
                ? "border-[var(--color-current)] font-semibold text-[var(--color-text)]"
                : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              {t.label}
              <span className={`text-[13px] font-normal tabular-nums ${t.n === 0 ? "text-[var(--color-text-faint)]" : "text-[var(--color-text-muted)]"}`}>{t.n}</span>
            </button>
          );
        })}
      </div>
      <div className="flex-1" />
      {counts.unread > 0 && (
        <div className="flex items-center gap-2 pb-1.5">
          <button type="button" onClick={onMarkAll} disabled={markingAll} title="Mark all updates read. Items waiting on you stay until you open them." className={rowBtn}>
            {markingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCheck className="w-3.5 h-3.5" />}
            <span className="max-sm:sr-only">Mark updates read</span>
          </button>
        </div>
      )}
    </div>
  );

  // What it's about: one tap narrows the list to that kind, again shows all.
  const kinds = groupCounts.filter((g) => g.n > 0 || g.key === group);
  const chips = counts.all > 0 && kinds.length > 1 ? (
    <div role="group" aria-label="About" className={`flex flex-wrap items-center gap-1.5 ${plain ? "px-4 py-2.5 border-b border-[var(--color-border)]" : "mb-3"}`}>
      <button type="button" aria-pressed={group === "all"} onClick={() => setGroup("all")} className={`ui-tag ${group === "all" ? tagOn : ""}`}>Everything</button>
      {kinds.map((g) => {
        const on = group === g.key;
        return (
          <button key={g.key} type="button" aria-pressed={on} onClick={() => setGroup(on ? "all" : g.key)} className={`ui-tag ${on ? tagOn : ""}`}>
            {g.label} <span className="font-sans font-normal tabular-nums text-[var(--color-text-muted)]">{g.n}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  const body = counts.all === 0 ? (
    <p className="px-4 py-4 text-[15px] text-[var(--color-text-muted)]">Nothing needs you right now.</p>
  ) : rows.length === 0 ? (
    <p className="px-4 py-4 text-[15px] text-[var(--color-text-muted)]">
      Nothing here.{" "}
      <button type="button" onClick={() => { onFilter("all"); setGroup("all"); }} className="font-semibold text-[var(--color-accent-text)] hover:underline underline-offset-2">Show everything</button>
    </p>
  ) : (
    <>
      <NeedsTable rows={rows} limit={visibleCount} seenAt={seenAt}
        onOpen={(r) => { if (r.notificationId) onMarkRead(r.notificationId); }}
        onMarkRead={(r) => { if (r.notificationId) onMarkRead(r.notificationId); }} />
      {rows.length > visibleCount && (
        <div className="border-t border-[var(--color-border)] px-4 py-2.5">
          <button type="button" onClick={() => setVisibleCount((v) => v + 30)} className="text-[14px] font-semibold text-[var(--color-accent-text)] hover:underline underline-offset-2">
            Show {Math.min(30, rows.length - visibleCount)} more ({rows.length - visibleCount} not shown)
          </button>
        </div>
      )}
    </>
  );

  if (plain) {
    return (
      <div className="min-w-0">
        {bar}
        {chips}
        {body}
      </div>
    );
  }
  return (
    <div className="min-w-0">
      {bar}
      {chips}
      <div className={sheet}>{body}</div>
    </div>
  );
}
