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
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <ListFilter className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-black text-[var(--color-text)]">Shortlist — {table.rows.length} {table.rows.length === 1 ? "entry" : "entries"}{table.catalog ? ` from ${table.catalog}` : ""}</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">{table.basis}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-[var(--color-surface-2)] text-left text-[9.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
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
                    <button onClick={() => onOpen(r)} className="inline-flex items-center gap-1 font-mono font-bold text-[var(--color-accent)] hover:underline" title={`Open ${r.documentName} p.${r.page}`}>
                      {r.code} <ExternalLink className="w-3 h-3" />
                    </button>
                  ) : <span className="font-mono font-bold">{r.code}</span>}
                </td>
                {hasRating && <td className="px-3 py-1.5 whitespace-nowrap font-mono">{r.rating ?? <span className="font-sans text-[10px] text-[var(--color-text-faint)]" title="Not read from the page — check it on the entry's page">not recorded</span>}</td>}
                <td className="px-3 py-1.5 min-w-[240px]">{r.service ?? "—"}</td>
                {fieldCols.map((f) => <td key={f} className="px-3 py-1.5 whitespace-nowrap">{r.attrs[f] ?? "—"}</td>)}
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {r.matched.map((m) => (
                      <span key={`${m.how}:${m.term}`} title={m.how === "asker" ? "your word" : m.how === "company" ? "the word your documents use for it" : "a related word only"}
                        className={`rounded px-1 py-px text-[9.5px] font-bold border ${m.how === "asker" ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-900" : m.how === "company" ? "border-sky-300 bg-sky-50 text-sky-800 dark:bg-sky-950/30 dark:text-sky-200 dark:border-sky-900" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>
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
        <div className="px-4 py-2 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] space-y-0.5">
          {table.differ.length > 0 && <div><b className="text-[var(--color-text)]">Narrow it by:</b> {table.differ.map((d) => `${d.field} (${d.values.join(" / ")})`).join(" · ")}</div>}
          {table.related > 0 && <div>{table.related} more {table.related === 1 ? "entry" : "entries"} matched only on a related word — not shown.</div>}
        </div>
      )}
    </div>
  );
}
