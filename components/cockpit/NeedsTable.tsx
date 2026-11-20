"use client";

// The "Needs you" table: what it is, what to do, its status and its date,
// one row each, late rows first with a red edge. The whole row opens it; the
// one button at its end does the same for keyboards and screen readers. In a
// narrow box (a phone, the notification panel) it turns into stacked rows:
// the item and its status, then what to do and the date.

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";
import type { NeedsRow } from "./needsYou";
import { sheet, thead, th, rowHover, rowBtn, StatusTag, LateEdge, humanDate, humanTime } from "./ui";

function dateWords(r: NeedsRow): string {
  if (r.due) return `Due ${humanDate(r.due)}`;
  if (!r.since) return "";
  const d = new Date(r.since);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today ${humanTime(r.since)}`;
  return `Since ${humanDate(r.since)}`;
}

function Status({ r }: { r: NeedsRow }) {
  if (r.overdue) return <StatusTag tone="overdue">Overdue</StatusTag>;
  if (r.dueSoon) return <StatusTag tone="held">Due soon</StatusTag>;
  if (r.yourTurn) return <span className="text-[13px] font-semibold text-[var(--color-text)] whitespace-nowrap">Your turn</span>;
  return <span className="text-[13px] text-[var(--color-text-muted)] whitespace-nowrap">Update</span>;
}

function Item({ r }: { r: NeedsRow }) {
  return (
    <>
      {r.ref && <span className="font-display font-semibold tabular-nums text-[var(--color-text)] mr-2">{r.ref}</span>}
      <span className={r.ref ? "text-[var(--color-text)]" : "font-semibold text-[var(--color-text)]"}>{r.name}</span>
    </>
  );
}

export default function NeedsTable({
  rows, limit, onOpen, onMarkRead, actionLabel = "Open", label = "Needs you",
}: {
  rows: NeedsRow[];
  /** Show only the first N (the rest are a "Show all" away). */
  limit?: number;
  /** Called when a row is opened (e.g. to mark its notification read). */
  onOpen?: (r: NeedsRow) => void;
  /** Adds a mark-read icon button to notification rows. */
  onMarkRead?: (r: NeedsRow) => void;
  actionLabel?: string;
  /** The table's accessible name. */
  label?: string;
}) {
  const router = useRouter();
  const shown = limit ? rows.slice(0, limit) : rows;
  const open = (r: NeedsRow) => { onOpen?.(r); router.push(r.link); };

  return (
    <div className="@container">
      {/* Wide: a ruled table. */}
      <table className="hidden @[44rem]:table w-full text-[15px]" aria-label={label}>
        <thead className={thead}>
          <tr>
            <th className={th}>Item</th>
            <th className={th}>What to do</th>
            <th className={th}>Status</th>
            <th className={th}>Date</th>
            <th className={`${th} w-1`}><span className="sr-only">Action</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {shown.map((r) => (
            <tr key={r.key} className={rowHover} onClick={() => open(r)}>
              <td className="relative px-4 py-3 max-w-[22rem]">
                {r.overdue && <LateEdge />}
                <div className="truncate"><Item r={r} /></div>
              </td>
              <td className="px-4 py-3 text-[var(--color-text-muted)] max-w-[24rem]"><div className="truncate">{r.todo}</div></td>
              <td className="px-4 py-3"><Status r={r} /></td>
              <td className={`px-4 py-3 whitespace-nowrap tabular-nums ${r.overdue ? "text-[var(--state-overdue)] font-semibold" : "text-[var(--color-text-muted)]"}`}>{dateWords(r)}</td>
              <td className="px-4 py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                <span className="inline-flex items-center gap-1">
                  {onMarkRead && r.notificationId && (
                    <button type="button" onClick={() => onMarkRead(r)} aria-label={`Mark read: ${r.name}`} title="Mark read"
                      className="w-8 h-8 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                      <CheckCheck className="w-4 h-4" />
                    </button>
                  )}
                  <Link href={r.link} onClick={() => onOpen?.(r)} className={rowBtn} aria-label={`${actionLabel}: ${r.ref ? `${r.ref} ` : ""}${r.name}`}>{actionLabel}</Link>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Narrow: stacked rows, each one a link. */}
      <ul className="@[44rem]:hidden divide-y divide-[var(--color-border)]" aria-label={label}>
        {shown.map((r) => (
          <li key={r.key} className="relative flex items-stretch">
            {r.overdue && <LateEdge />}
            <Link href={r.link} onClick={() => onOpen?.(r)} className="min-w-0 flex-1 block px-4 py-3 hover:bg-[var(--color-surface-2)] transition-colors">
              <span className="flex items-baseline gap-3 min-w-0">
                <span className="min-w-0 flex-1 truncate text-[15px]"><Item r={r} /></span>
                <span className="shrink-0"><Status r={r} /></span>
              </span>
              <span className="mt-0.5 flex items-baseline gap-3 min-w-0 text-[13px] text-[var(--color-text-muted)]">
                <span className="min-w-0 flex-1 truncate">{r.todo}</span>
                <span className={`shrink-0 tabular-nums ${r.overdue ? "text-[var(--state-overdue)] font-semibold" : ""}`}>{dateWords(r)}</span>
              </span>
            </Link>
            {onMarkRead && r.notificationId && (
              <button type="button" onClick={() => onMarkRead(r)} aria-label={`Mark read: ${r.name}`} title="Mark read"
                className="shrink-0 w-11 grid place-items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                <CheckCheck className="w-4 h-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The table on its own white sheet. */
export function NeedsSheet(props: React.ComponentProps<typeof NeedsTable> & { footer?: React.ReactNode }) {
  const { footer, ...rest } = props;
  return (
    <div className={sheet}>
      <NeedsTable {...rest} />
      {footer}
    </div>
  );
}
