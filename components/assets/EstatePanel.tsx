"use client";

// components/assets/EstatePanel.tsx — everything the estate knows about one
// piece of equipment, through the same find service every search uses:
// the sheets it is drawn on, the text that mentions it, what is tagged or
// filed to it, and the work in flight around it.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Waypoints, Activity } from "lucide-react";
import { findEstate } from "@/lib/find/client";
import type { FindResponse } from "@/lib/find/types";
import { EntityStrip, RelationChips, PageHits, ActivityPanel, CoverageLine } from "@/components/find/FindPanels";
import { FileTypeIcon } from "@/components/documents/fileGraphIcons";
import { fileTypeOf } from "@/lib/fileFinder/fileTypes";

export default function EstatePanel({ orgId, assetId, tag }: { orgId: string; assetId: string; tag: string }) {
  // Keyed by what was asked, so a stale answer is never shown for a new tag
  // and no state is reset synchronously inside the effect.
  const key = `${orgId}|${assetId}|${tag}`;
  const [state, setState] = useState<{ key: string; res: FindResponse | null; error: string | null }>({ key: "", res: null, error: null });
  useEffect(() => {
    let alive = true;
    findEstate({ orgId, query: tag, scope: { assetId }, limit: 60 })
      .then((r) => { if (alive) setState({ key, res: r, error: null }); })
      .catch((e) => { if (alive) setState({ key, res: null, error: (e as Error).message }); });
    return () => { alive = false; };
  }, [orgId, assetId, tag, key]);
  const res = state.key === key ? state.res : null;
  const error = state.key === key ? state.error : null;

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden mb-5">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
        <div className="text-sm font-black text-[var(--color-text)] inline-flex items-center gap-2"><Waypoints className="w-4 h-4 text-sky-600" /> Across the estate</div>
        <Link href={`/documents/graph?q=${encodeURIComponent(tag)}`} className="text-xs font-bold text-[var(--color-accent)] hover:underline">Explore on the map →</Link>
      </div>
      <div className="p-4 space-y-4">
        {error && <div className="text-xs text-red-700">{error}</div>}
        {!res && !error && <div className="text-xs text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Looking across drawings, text, folders and work in flight…</div>}
        {res && (
          <>
            <EntityStrip entities={res.entities} />
            {res.groups.map((g) => (
              <div key={g.key}>
                <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-1">{g.label} · {g.ids.length}</div>
                <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
                  {g.ids.slice(0, 8).map((id) => {
                    const r = res.results.find((x) => x.id === id)!;
                    return (
                      <li key={id} className="px-3 py-2">
                        <Link href={r.href} className="flex items-center gap-2 hover:underline">
                          <FileTypeIcon type={fileTypeOf(r.name)} className="w-4 h-4 shrink-0" />
                          <span className="text-sm font-semibold truncate">{r.name}</span>
                          <span className="text-[11px] text-[var(--color-text-muted)] truncate">{[r.libraryName, ...r.path].filter(Boolean).join(" / ")}</span>
                        </Link>
                        <RelationChips relations={r.relations} />
                        <PageHits pages={r.pages} />
                      </li>
                    );
                  })}
                </ul>
                {g.ids.length > 8 && <div className="text-[11px] text-[var(--color-text-muted)] mt-1">…and {g.ids.length - 8} more on the map.</div>}
              </div>
            ))}
            {res.results.length === 0 && <div className="text-xs text-[var(--color-text-muted)]">Nothing in the estate is linked to {tag} yet. Reading its drawings (Intelligence › Knowledge) is what creates these links.</div>}
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-1 inline-flex items-center gap-1"><Activity className="w-3 h-3" /> Happening now</div>
              <ActivityPanel activity={res.activity} />
            </div>
            <CoverageLine coverage={res.coverage} />
          </>
        )}
      </div>
    </div>
  );
}
