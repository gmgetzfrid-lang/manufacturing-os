"use client";

// One ruled table for many small lists (the Inbox's "your queue"): a grey
// band names each group and its count, its rows follow (item, detail, age
// or date, an action), and a link at the end opens the rest. Late rows get
// the red edge. In a narrow box the rows stack: the item and its date, then
// the detail.

import React from "react";
import Link from "next/link";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { sheet, thead, th, LateEdge, link } from "./ui";

export interface GroupRow {
  key: string;
  item: React.ReactNode;
  detail?: React.ReactNode;
  when?: React.ReactNode;
  action?: React.ReactNode;
  late?: boolean;
}

export interface Group {
  key: string;
  title: string;
  count: number;
  help?: React.ReactNode;
  /** Kept for older callers; not drawn (the band's title is text). */
  icon?: React.ReactNode;
  /** The count's tone: late items red, waiting amber. */
  tone?: "bad" | "warn";
  rows: GroupRow[];
  more?: { href: string; label: string };
}

export default function GroupedTable({ groups, label }: { groups: Group[]; label: string }) {
  const shown = groups.filter((g) => g.rows.length > 0);
  if (shown.length === 0) return null;
  // The band names the group as text, then its count as plain figures (in
  // its state color when late or waiting).
  const bandTitle = (g: Group) => (
    <span className="inline-flex items-center gap-2">
      <span className="font-semibold text-[var(--color-text)]">{g.title}</span>
      <span className={`tabular-nums ${g.tone === "bad" ? "font-semibold text-[var(--state-overdue-text)]" : g.tone === "warn" ? "font-semibold text-[var(--state-held-text)]" : "text-[var(--color-text-muted)]"}`}>{g.count.toLocaleString()}</span>
      {g.help && <HelpTooltip>{g.help}</HelpTooltip>}
    </span>
  );
  return (
    <div className={`${sheet} @container`}>
      <table className="hidden @[44rem]:table w-full text-[15px]" aria-label={label}>
        <thead className={thead}>
          <tr>
            <th className={th}>Item</th>
            <th className={th}>Detail</th>
            <th className={th}>Age or date</th>
            <th className={`${th} w-1`}><span className="sr-only">Action</span></th>
          </tr>
        </thead>
        {shown.map((g) => (
          <tbody key={g.key} className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border-strong)]">
            <tr className="bg-[var(--color-surface-2)]">
              <th colSpan={4} scope="colgroup" className="px-4 h-10 text-left text-[14px] font-normal">{bandTitle(g)}</th>
            </tr>
            {g.rows.map((r) => (
              <tr key={r.key}>
                <td className="relative px-4 py-2.5 max-w-[22rem]">
                  {r.late && <LateEdge />}
                  <div className="truncate">{r.item}</div>
                </td>
                <td className="px-4 py-2.5 text-[var(--color-text-muted)] max-w-0 w-full"><div className="truncate">{r.detail}</div></td>
                <td className="px-4 py-2.5 whitespace-nowrap text-[14px] text-[var(--color-text-muted)] tabular-nums">{r.when}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right">{r.action}</td>
              </tr>
            ))}
            {g.more && (
              <tr>
                <td colSpan={4} className="px-4 py-2.5 text-[14px]"><Link href={g.more.href} className={link}>{g.more.label}</Link></td>
              </tr>
            )}
          </tbody>
        ))}
      </table>

      <div className="@[44rem]:hidden" role="list" aria-label={label}>
        {shown.map((g, gi) => (
          <section key={g.key} className={gi ? "border-t border-[var(--color-border-strong)]" : ""} role="listitem">
            <h3 className="px-4 h-10 flex items-center bg-[var(--color-surface-2)] text-[14px]">{bandTitle(g)}</h3>
            <ul className="divide-y divide-[var(--color-border)]">
              {g.rows.map((r) => (
                <li key={r.key} className="relative px-4 py-2.5">
                  {r.late && <LateEdge />}
                  <div className="flex items-baseline gap-3">
                    <div className="min-w-0 flex-1 truncate text-[15px]">{r.item}</div>
                    {r.when && <div className="shrink-0 text-[13px] text-[var(--color-text-muted)] tabular-nums">{r.when}</div>}
                  </div>
                  {r.detail && <div className="mt-0.5 text-[13px] text-[var(--color-text-muted)] truncate">{r.detail}</div>}
                  {r.action && <div className="mt-2">{r.action}</div>}
                </li>
              ))}
              {g.more && (
                <li className="px-4 py-2.5 text-[14px]"><Link href={g.more.href} className={link}>{g.more.label}</Link></li>
              )}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
