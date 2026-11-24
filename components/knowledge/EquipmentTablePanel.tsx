"use client";

// EquipmentTablePanel — the interactive register that rides with "show me
// all equipment" answers. Grouped by category with counts; every row is a
// real extracted tag; every sheet chip opens the drawing IN the viewer with
// that tag ringed. Deterministic data from the entity index — the AI's
// prose summarizes, this enumerates.

import React, { useState } from "react";
import { ChevronRight, Crosshair, Table2, Search } from "lucide-react";
import type { EquipmentTable } from "@/lib/knowledge";

export default function EquipmentTablePanel({ table, onOpenTag }: {
  table: EquipmentTable;
  /** Open the sheet in the cited-page viewer with the tag ringed. */
  onOpenTag: (documentId: string, page: number, tag: string, documentName: string) => void;
}) {
  // First few categories open; a long tail stays folded but visible.
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(table.categories.slice(0, 3).map((c) => c.prefix)));
  const [filter, setFilter] = useState("");

  const toggle = (prefix: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(prefix)) next.delete(prefix); else next.add(prefix);
    return next;
  });

  const q = filter.trim().toUpperCase();
  const visible = table.categories
    .map((c) => ({
      ...c,
      items: q ? c.items.filter((i) => i.tag.includes(q) || (i.note ?? "").toUpperCase().includes(q)) : c.items,
    }))
    .filter((c) => c.items.length > 0);

  return (
    <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <Table2 className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
        <span className="text-body font-medium text-[var(--color-text)]">
          {table.filteredTo ? `${table.filteredTo} - ` : "Equipment register - "}
          {table.total.toLocaleString()} distinct tag{table.total === 1 ? "" : "s"}
        </span>
        {table.truncated && (
          <span className="text-body text-[var(--state-held)] font-medium">
            showing the first 400 - use the CSV export in Drawing intelligence for the full set
          </span>
        )}
        <span className="flex-1" />
        <div className="relative">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tags…"
            className="pl-6 pr-2 py-1 w-36 rounded-lg text-body font-display tabular-nums border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]" />
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="px-4 py-3 text-body text-[var(--color-text-muted)] italic">Nothing matches that filter.</p>
      ) : visible.map((cat) => {
        const expanded = open.has(cat.prefix) || !!q;
        return (
          <div key={cat.prefix} className="border-b border-[var(--color-border)] last:border-b-0">
            <button onClick={() => toggle(cat.prefix)}
              className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-[var(--color-surface-2)] transition-colors">
              <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)] ui-chevron${(expanded) ? " rotate-90" : ""}`} />
              <span className="font-display font-semibold text-[var(--color-text)] text-body w-10 shrink-0">{cat.prefix}-</span>
              <span className="text-body font-medium text-[var(--color-text)] flex-1">{cat.label}</span>
              <span className="text-body font-medium text-[var(--color-text)] tabular-nums">{cat.count}</span>
            </button>
            {expanded && (
              <div className="overflow-x-auto">
                <table className="w-full text-body">
                  <thead>
                    <tr className="text-body font-medium text-[var(--color-text-muted)] bg-[var(--color-surface-2)]">
                      <th className="text-left px-4 py-1 w-28">Tag</th>
                      <th className="text-left px-2 py-1">Context</th>
                      <th className="text-left px-2 py-1 w-64">On sheets - click to view ringed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {cat.items.map((item) => (
                      <tr key={item.tag} className="hover:bg-[var(--color-surface-2)]/60">
                        <td className="px-4 py-1.5 align-top">
                          <button
                            onClick={() => item.sheets[0] && onOpenTag(item.sheets[0].documentId, item.sheets[0].page, item.tag, item.sheets[0].documentName)}
                            className="font-display font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-hover)] transition-colors"
                            title="Open the first sheet with this tag ringed">
                            {item.tag}
                          </button>
                        </td>
                        <td className="px-2 py-1.5 align-top text-[var(--color-text-muted)]">
                          <span className="line-clamp-2">{item.note ?? "-"}</span>
                        </td>
                        <td className="px-2 py-1.5 align-top">
                          <div className="flex flex-wrap gap-1">
                            {item.sheets.map((s) => (
                              <button key={`${s.documentId}-${s.page}`}
                                onClick={() => onOpenTag(s.documentId, s.page, item.tag, s.documentName)}
                                title={`${s.documentName} - page ${s.page}, ${item.tag} ringed`}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-[var(--color-border)] dark:border-[var(--color-border)] bg-[var(--color-surface-2)] dark:bg-[var(--color-surface-2)] text-[var(--color-text)] dark:text-[var(--color-text)] font-medium hover:bg-[var(--color-surface-2)] dark:hover:bg-[var(--color-surface-2)] transition-colors">
                                <Crosshair className="w-2.5 h-2.5" />
                                <span className="truncate max-w-[9rem]">{s.documentName.replace(/\.pdf$/i, "")}</span>
                                <span className="text-[var(--color-text)]">{s.sheetLabel ?? `p.${s.page}`}</span>
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
