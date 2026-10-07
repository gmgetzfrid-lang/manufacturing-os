"use client";

// SourceDriftBanner — "the source revision has moved" (drafting-flow HAND-7).
//
// A drafting request raised against a controlled drawing captures the
// revision the requester was looking at: metadata.source_document.version_id
// (and, for a request raised from several sheets, each entry of
// metadata.source_documents — GAP-8), stamped server-side by
// /api/tickets/create. This banner reads each source document's LIVE
// current_version_id and says so when the register has moved on since the
// request was raised — so a drafter never drafts a redline made on Rev 3 over
// a Rev 4 nobody told them about.
//
// It claims only what it can back: a document it cannot read (a failed read,
// a document the viewer cannot see, one no longer in the workspace) and a
// ticket that captured no version (every row before DF-P2, or a requester who
// saw a revision that was no longer current) say nothing — never "current",
// never "moved". The comparison is lib/sourceDocRef.ts revDrift, by version
// id when both sides carry one.
//
// Mounted by the ticket page (drafting-flow DF-P9, one line); it reads
// nothing but the source documents' rows.

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { parseSourceDocuments, revDrift, type SourceDocRef } from "@/lib/sourceDocRef";

export interface SourceDrift {
  ref: SourceDocRef;
  currentRev: string | null;
}

/** The source documents whose register revision has moved since the request
 *  was raised. Pure: `live` is what the documents table answered, by id. */
export function driftedSources(
  refs: SourceDocRef[],
  live: Map<string, { currentVersionId: string | null; rev: string | null }>,
): SourceDrift[] {
  const out: SourceDrift[] = [];
  for (const ref of refs) {
    const doc = live.get(ref.id);
    if (!doc) continue;
    // Version ids decide when the request captured one; a historical row
    // (no version id) is judged by its rev label, as the source card does.
    const drift = revDrift(
      { versionId: ref.versionId, rev: ref.rev },
      { versionId: doc.currentVersionId, rev: doc.rev },
    );
    if (drift === "drifted") out.push({ ref, currentRev: doc.rev });
  }
  return out;
}

export default function SourceDriftBanner({
  metadata, orgId,
}: {
  metadata: Record<string, unknown> | null | undefined;
  orgId: string | null | undefined;
}) {
  const refs = useMemo(() => parseSourceDocuments(metadata), [metadata]);
  const key = refs.map((r) => `${r.id}:${r.versionId ?? ""}:${r.rev ?? ""}`).join("|");
  const [drifts, setDrifts] = useState<SourceDrift[]>([]);

  useEffect(() => {
    let alive = true;
    setDrifts([]);
    if (!orgId || refs.length === 0) return;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from("documents")
          .select("id, rev, current_version_id")
          .eq("org_id", orgId)
          .in("id", refs.map((r) => r.id));
        // A failed read proves nothing: say nothing.
        if (!alive || error) return;
        const live = new Map<string, { currentVersionId: string | null; rev: string | null }>();
        for (const d of (data ?? []) as Array<{ id: string; rev: string | null; current_version_id: string | null }>) {
          live.set(d.id, { currentVersionId: d.current_version_id ?? null, rev: d.rev ?? null });
        }
        setDrifts(driftedSources(refs, live));
      } catch { /* a thrown read says nothing too */ }
    })();
    return () => { alive = false; };
    // `key` carries everything `refs` holds that the read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, key]);

  if (drifts.length === 0) return null;
  return (
    <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 flex items-start gap-2 text-amber-900">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="text-xs leading-relaxed">
        <div className="font-bold">The source revision has moved since this request was raised</div>
        {drifts.map(({ ref, currentRev }) => (
          <div key={ref.id}>
            {ref.documentNumber || ref.title || "Source document"} was Rev {ref.rev || "?"} when the request was raised;
            the register is now at Rev {currentRev || "?"}. Check the drafting base before working from the attached markup.
          </div>
        ))}
      </div>
    </div>
  );
}
