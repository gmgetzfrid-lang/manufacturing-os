"use client";

// components/assets/EstatePanel.tsx — everything the estate knows about one
// piece of equipment, through the same find service every search uses:
// the sheets it is drawn on, the text that mentions it, what is tagged or
// filed to it, and the work in flight around it.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonText } from "@/components/ui/Skeleton";
import { findEstate } from "@/lib/find/client";
import type { FindResponse } from "@/lib/find/types";
import { EntityStrip, RelationChips, PageHits, ActivityPanel, CoverageLine } from "@/components/find/FindPanels";
import { FileTypeIcon } from "@/components/documents/fileGraphIcons";
import { fileTypeOf } from "@/lib/fileFinder/fileTypes";

export default function EstatePanel({ orgId, assetId, tag }: { orgId: string; assetId: string; tag: string }) {
  // Keyed by what was asked, so a stale answer is never shown for a new tag
  // and no state is reset synchronously inside the effect.
  const key = `${orgId}|${assetId}|${tag}`;
  const [state, setState] = useState<{ key: string; res: FindResponse | null; error: unknown }>({ key: "", res: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    findEstate({ orgId, query: tag, scope: { assetId }, limit: 60 })
      .then((r) => { if (alive) setState({ key, res: r, error: null }); })
      .catch((e) => { if (alive) setState({ key, res: null, error: e ?? true }); });
    return () => { alive = false; };
  }, [orgId, assetId, tag, key, attempt]);
  const res = state.key === key ? state.res : null;
  const error = state.key === key ? state.error : null;

  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1 mb-3 min-h-8">
        <h2 className="font-display text-section leading-tight font-semibold text-[var(--color-text)]">Across the estate</h2>
        <span className="flex-1" />
        <Link href={`/documents/graph?q=${encodeURIComponent(tag)}`} className="text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Explore on the map</Link>
      </div>
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4 space-y-6">
        {!!error && <ErrorNote compact error={error} title="Couldn't look across the estate." onRetry={() => setAttempt((n) => n + 1)} />}
        {!res && !error && <SkeletonText lines={4} />}
        {res && (
          <>
            <EntityStrip entities={res.entities} />
            {res.groups.map((g) => (
              <div key={g.key}>
                <div className="text-body font-medium text-[var(--color-text)] mb-1.5 flex items-center gap-2">{g.label} <span className="ui-count">{g.ids.length}</span></div>
                {/* Up to 8 rows: space between them, no ruled lines. */}
                <ul className="grid gap-3">
                  {g.ids.slice(0, 8).map((id) => {
                    const r = res.results.find((x) => x.id === id)!;
                    return (
                      <li key={id}>
                        <Link href={r.href} className="flex items-center gap-2 hover:underline">
                          <FileTypeIcon type={fileTypeOf(r.name)} className="w-4 h-4 shrink-0" />
                          <span className="text-body font-medium text-[var(--color-accent-text)] truncate">{r.name}</span>
                          <span className="text-body text-[var(--color-text-muted)] truncate">{[r.libraryName, ...r.path].filter(Boolean).join(" / ")}</span>
                        </Link>
                        <RelationChips relations={r.relations} />
                        <PageHits pages={r.pages} />
                      </li>
                    );
                  })}
                </ul>
                {g.ids.length > 8 && <div className="text-body text-[var(--color-text-muted)] mt-1">And {g.ids.length - 8} more on the map.</div>}
              </div>
            ))}
            {res.results.length === 0 && <div className="text-body text-[var(--color-text-muted)]">Nothing in the estate is linked to {tag} yet. Reading its drawings (Intelligence, Knowledge) is what makes these links.</div>}
            <div>
              <div className="text-body font-medium text-[var(--color-text)] mb-1">Happening now</div>
              <ActivityPanel activity={res.activity} />
            </div>
            <CoverageLine coverage={res.coverage} />
          </>
        )}
      </div>
    </section>
  );
}
