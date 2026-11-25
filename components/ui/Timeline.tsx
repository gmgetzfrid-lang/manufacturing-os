"use client";

// Timeline - a history read top to bottom: newest first, grouped by day
// ("Today", "Yesterday", "Mon, Nov 23"), each entry a dot colored by what
// happened (with the word, never color alone), what it was, and who did it
// as a small avatar instead of their email on every line. For change logs,
// activity and audit trails (docs/design-rules.md, section 18).

import React from "react";
import UserAvatar from "@/components/ui/UserAvatar";

export type TimelineTone = "good" | "warn" | "bad" | "info" | "muted";

export interface TimelineItem {
  id: string;
  /** When it happened (ms or ISO). */
  at: number | string;
  /** What kind of thing happened, one word or two ("Added", "Removed"). */
  kind: string;
  tone?: TimelineTone;
  /** What it was about. */
  title: React.ReactNode;
  /** Why, or more detail, quieter under it. */
  detail?: React.ReactNode;
  /** Who did it. */
  who?: { uid?: string | null; name?: string | null; email?: string | null } | null;
}

const DOT: Record<TimelineTone, string> = {
  good: "bg-[var(--state-released)]",
  warn: "bg-[var(--state-held)]",
  bad: "bg-[var(--state-overdue)]",
  // Blue, not the accent: the accent only means "you can act here" (C1).
  info: "bg-[var(--state-locked)]",
  muted: "bg-[var(--color-text-faint)]",
};

const ms = (t: number | string) => (typeof t === "number" ? t : Date.parse(t));

function dayLabel(t: number, tz?: string): string {
  const key = (x: number) => new Date(x).toLocaleDateString("en-CA", { timeZone: tz });
  const today = key(Date.now());
  const yesterday = key(Date.now() - 86_400_000);
  const k = key(t);
  if (k === today) return "Today";
  if (k === yesterday) return "Yesterday";
  return new Date(t).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

export default function Timeline({ items, tz, max, className = "" }: {
  items: TimelineItem[];
  /** The plant's time zone, for the day groups and times. */
  tz?: string;
  /** Show at most this many (newest first). */
  max?: number;
  className?: string;
}) {
  const sorted = [...items].sort((a, b) => ms(b.at) - ms(a.at)).slice(0, max ?? items.length);
  const groups: Array<{ day: string; rows: TimelineItem[] }> = [];
  for (const it of sorted) {
    const d = dayLabel(ms(it.at), tz);
    const g = groups[groups.length - 1];
    if (g && g.day === d) g.rows.push(it); else groups.push({ day: d, rows: [it] });
  }
  return (
    <div className={`grid gap-4 ${className}`}>
      {groups.map((g) => (
        <section key={g.day} aria-label={g.day}>
          <h4 className="mb-1.5 text-caption font-medium text-[var(--color-text-muted)]">{g.day}</h4>
          <ol className="grid gap-2.5">
            {g.rows.map((it) => (
              <li key={it.id} className="grid grid-cols-[12px_1fr_auto] items-start gap-x-3">
                <span aria-hidden className={`mt-1.5 w-2 h-2 rounded-full ${DOT[it.tone ?? "muted"]}`} />
                <div className="min-w-0">
                  <div className="text-body text-[var(--color-text)] break-words"><span className="font-medium">{it.kind}</span> {it.title}</div>
                  {it.detail && <div className="text-caption text-[var(--color-text-muted)] break-words">{it.detail}</div>}
                </div>
                <div className="flex items-center gap-2 text-caption text-[var(--color-text-muted)] tabular-nums whitespace-nowrap">
                  {new Date(ms(it.at)).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}
                  {it.who && (it.who.name || it.who.email) && <UserAvatar uid={it.who.uid} name={it.who.name} email={it.who.email} size={20} title={it.who.name || it.who.email || undefined} />}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
