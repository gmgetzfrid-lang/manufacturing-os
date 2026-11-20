"use client";

// CandidateTablePanel — the shortlist behind a "which … should I use"
// answer: every entry the catalog filter kept, with the fields its catalog
// prints, and what would narrow it further. Each entry opens its page.

import React from "react";
import { ListFilter, ExternalLink } from "lucide-react";
import type { CandidateTable } from "@/lib/knowledge";

export default function CandidateTablePanel({ table, onOpen }: {
  table: CandidateTable;
  onOpen?: (row: CandidateTable["rows"][number]) => void;
}) {
  // Extra columns: the printed fields the shortlist differs on.
  const fieldCols = table.differ.map((d) => d.field).filter((f) => !/^rating$/i.test(f)).slice(0, 4);
  const hasRating = table.rows.some((r) => r.rating);
  return (
    // A plain section under the answer: a label, the table on hairlines.
    <section className="pt-4 border-t border-[var(--color-border)]">
      <div className="flex items-center gap-2 flex-wrap pb-1">
        <ListFilter className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
        <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">Shortlist</span>
        <span className="text-[14px] font-bold text-[var(--color-text)]">{table.rows.length} {table.rows.length === 1 ? "entry" : "entries"}{table.catalog ? ` from ${table.catalog}` : ""}</span>
      </div>
      <p className="pb-2 text-[12.5px] text-[var(--color-text-muted)]">{table.basis}</p>
      {/* Wide: it scrolls sideways, and the fade at the edge says so. */}
      <div className="overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)] pr-6">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-y border-[var(--color-border)] text-left text-[13px] font-semibold text-[var(--color-text-muted)]">
              <th className="px-3 py-1.5">Code</th>
              {hasRating && <th className="px-3 py-1.5">Rating</th>}
              <th className="px-3 py-1.5">For</th>
              {fieldCols.map((f) => <th key={f} className="px-3 py-1.5">{f}</th>)}
              <th className="px-3 py-1.5">Matched on</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={`${r.documentId}:${r.code}:${r.page}`} className="border-t border-[var(--color-border)] align-top">
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {onOpen && r.fileKey ? (
                    <button onClick={() => onOpen(r)} className="inline-flex items-center gap-1 font-mono font-bold text-[var(--color-text)] underline decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-text)]" title={`Open ${r.documentName} p.${r.page}`}>
                      {r.code} <ExternalLink className="w-3 h-3" />
                    </button>
                  ) : <span className="font-mono font-bold">{r.code}</span>}
                </td>
                {hasRating && <td className="px-3 py-1.5 whitespace-nowrap font-mono">{r.rating ?? <span className="font-sans text-[11px] text-[var(--color-text-faint)]" title="Not read from the page - check it on the entry's page">not recorded</span>}</td>}
                <td className="px-3 py-1.5 min-w-[240px]">{r.service ?? "-"}</td>
                {fieldCols.map((f) => <td key={f} className="px-3 py-1.5 whitespace-nowrap">{r.attrs[f] ?? "-"}</td>)}
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {r.matched.map((m) => (
                      <span key={`${m.how}:${m.term}`} title={m.how === "asker" ? "your word" : m.how === "company" ? "the word your documents use for it" : "a related word only"}
                        className={`rounded px-1 py-px text-[11px] font-bold border ${m.how === "asker" ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-900" : m.how === "company" ? "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)] dark:bg-[var(--color-surface-2)] dark:text-[var(--color-text)] dark:border-[var(--color-border)]" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>
                        {m.term}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(table.differ.length > 0 || table.related > 0) && (
        <div className="pt-2.5 border-t border-[var(--color-border)] text-[12.5px] text-[var(--color-text-muted)] space-y-0.5">
          {table.differ.length > 0 && <div><b className="text-[var(--color-text)]">Narrow it by:</b> {table.differ.map((d) => `${d.field} (${d.values.join(" / ")})`).join(" · ")}</div>}
          {table.related > 0 && <div>{table.related} more {table.related === 1 ? "entry" : "entries"} matched only on a related word - not shown.</div>}
        </div>
      )}
    </section>
  );
}
