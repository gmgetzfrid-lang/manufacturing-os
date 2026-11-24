"use client";

// The "Needs you" table: what it is, what to do, its status and its date,
// one row each, late rows first with a red edge. The whole row opens it and
// the item's name is a link (keyboards and screen readers); a request or
// document number copies with one click. Rows that came in since you last
// looked read in bold and say "New"; the ones you have seen say "Update".
// In a narrow box (a phone, the notification panel) each row becomes a
// card: the number and the status, the name, then what to do and the date.

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { CopyId } from "@/components/ui/CopyId";
import { transitionPush, onTransitionClick } from "@/lib/viewTransition";
import type { NeedsRow } from "./needsYou";
import { sheet, thead, th, rowHover, iconBtn, StatusTag, LateEdge, humanDate, humanTime } from "./ui";

function dateWords(r: NeedsRow): string {
  if (r.due) return `Due ${humanDate(r.due)}`;
  if (!r.since) return "";
  const d = new Date(r.since);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today ${humanTime(r.since)}`;
  return `Since ${humanDate(r.since)}`;
}

/** Came in after the person last opened their notifications. */
export function isNewSince(r: NeedsRow, seenAt: number | null | undefined): boolean {
  if (seenAt == null || !r.since) return false;
  const t = new Date(r.since).getTime();
  return Number.isFinite(t) && t > seenAt;
}

function Status({ r, fresh }: { r: NeedsRow; fresh: boolean }) {
  if (r.overdue) return <StatusTag tone="overdue">Overdue</StatusTag>;
  if (r.dueSoon) return <StatusTag tone="held">Due soon</StatusTag>;
  if (r.yourTurn) return <StatusTag tone="neutral">Your turn</StatusTag>;
  return fresh ? <StatusTag tone="neutral">New</StatusTag> : <StatusTag tone="muted">Update</StatusTag>;
}

export default function NeedsTable({
  rows, limit, onOpen, onMarkRead, label = "Needs you", seenAt,
}: {
  rows: NeedsRow[];
  /** Show only the first N (the rest are a "Show all" away). */
  limit?: number;
  /** Called when a row is opened (e.g. to mark its notification read). */
  onOpen?: (r: NeedsRow) => void;
  /** Adds a mark-read icon button to notification rows. */
  onMarkRead?: (r: NeedsRow) => void;
  /** The table's accessible name. */
  label?: string;
  /** When the person last opened their notifications (ms): news after it
   *  reads as new. Unset: no row is called new. */
  seenAt?: number | null;
}) {
  const router = useRouter();
  const shown = limit ? rows.slice(0, limit) : rows;
  // Opening a row is a move from the list into the item: a view transition.
  const open = (r: NeedsRow) => { onOpen?.(r); transitionPush(router, r.link); };
  const hasMark = !!onMarkRead && shown.some((r) => r.notificationId);

  const name = (r: NeedsRow, fresh: boolean, cls = "") => (
    <Link href={r.link} onClick={(e) => { e.stopPropagation(); onOpen?.(r); onTransitionClick(e, () => router.push(r.link)); }}
      className={`min-w-0 truncate text-[var(--color-text)] hover:text-[var(--color-accent-text)] hover:underline underline-offset-2 ${fresh || r.yourTurn || !r.ref ? "font-medium" : ""} ${cls}`}>
      {r.name}
    </Link>
  );
  const markBtn = (r: NeedsRow, cls: string) => onMarkRead && r.notificationId ? (
    <button type="button" onClick={(e) => { e.stopPropagation(); onMarkRead(r); }} aria-label={`Mark read: ${r.name}`} title="Mark read" className={cls}>
      <CheckCheck className="w-4 h-4" />
    </button>
  ) : null;

  return (
    <div className="@container">
      {/* Wide: a ruled table. */}
      <table className="hidden @[44rem]:table w-full text-body" aria-label={label}>
        <thead className={thead}>
          <tr>
            <th className={th}>Item</th>
            <th className={th}>What to do</th>
            <th className={th}>Status</th>
            <th className={th}>Date</th>
            {hasMark && <th className={`${th} w-1`}><span className="sr-only">Mark read</span></th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {shown.map((r) => {
            const fresh = !r.yourTurn && isNewSince(r, seenAt);
            return (
              <tr key={r.key} className={rowHover} onClick={() => open(r)}>
                <td className="relative px-4 py-3 max-w-[26rem]">
                  {r.overdue && <LateEdge />}
                  <span className="flex items-baseline gap-0.5 min-w-0">
                    {r.ref && <CopyId value={r.ref} label="number" className="shrink-0" />}
                    {name(r, fresh)}
                  </span>
                </td>
                <td className="px-4 py-3 text-[var(--color-text-muted)] max-w-[24rem]"><div className="truncate">{r.todo}</div></td>
                <td className="px-4 py-3"><Status r={r} fresh={fresh} /></td>
                <td className={`px-4 py-3 whitespace-nowrap tabular-nums ${r.overdue ? "text-[var(--state-overdue-text)] font-medium" : "text-[var(--color-text-muted)]"}`}>{dateWords(r)}</td>
                {hasMark && <td className="px-2 py-1.5 text-right">{markBtn(r, iconBtn)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Narrow: a card per row. */}
      <ul className="@[44rem]:hidden divide-y divide-[var(--color-border)]" aria-label={label}>
        {shown.map((r) => {
          const fresh = !r.yourTurn && isNewSince(r, seenAt);
          return (
            <li key={r.key} className="relative flex items-stretch">
              {r.overdue && <LateEdge />}
              <div onClick={() => open(r)} className="min-w-0 flex-1 px-4 py-3 cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="min-w-0 flex-1 flex items-baseline gap-2 text-reading">
                    {r.ref ? <CopyId value={r.ref} label="number" className="min-w-0" /> : name(r, fresh)}
                  </span>
                  <span className="shrink-0"><Status r={r} fresh={fresh} /></span>
                </div>
                {r.ref && <div className="mt-0.5 flex min-w-0 text-reading">{name(r, fresh)}</div>}
                <div className="mt-0.5 flex items-baseline gap-3 min-w-0 text-body text-[var(--color-text-muted)]">
                  <span className="min-w-0 flex-1 truncate">{r.todo}</span>
                  <span className={`shrink-0 tabular-nums ${r.overdue ? "text-[var(--state-overdue-text)] font-semibold" : ""}`}>{dateWords(r)}</span>
                </div>
              </div>
              {markBtn(r, "shrink-0 w-11 grid place-items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors")}
            </li>
          );
        })}
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
