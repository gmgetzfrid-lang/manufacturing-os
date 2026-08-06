"use client";

// KnowledgeIndexIndicator — the app-shell background driver for knowledge
// indexing, plus its floating progress pill.
//
// Indexing is client-driven by design (bounded server batches fit the
// platform's function window), but the loop used to live inside the library
// page — navigate away and a 900-page standard simply stopped, days from
// done, waiting for someone to reopen the tab. This component lives in the
// protected layout: as long as the app is open ANYWHERE, the org's queued
// documents (pending / stale / mid-index) keep draining, vision pages
// included, on the signed-in controller's own key exactly as if they were
// watching the library page.
//
// Guardrails:
//   - Controllers only (Admin / DocCtrl) — the same bar the ingest API holds.
//   - One driver per document per tab (lib/knowledge's active-ingest set),
//     so this never races a library page's own loop.
//   - Each queued document gets ONE attempt per drain pass — a failing PDF is
//     marked errored server-side and skipped, never retried in a hot loop.
//   - Re-checks the queue every POLL_MS, so documents added from any page
//     (uploads, linked sources, rev-ups going stale) start without a visit
//     to the knowledge library.

import React, { useEffect, useRef, useState } from "react";
import { Loader2, X, BookOpenText, CheckCircle2, Eye, Minus } from "lucide-react";
import { CornerPortal } from "@/components/ui/CornerDock";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { ingestKnowledgeDocument, isIngestActive } from "@/lib/knowledge";
import { isUploading, onUploadActivity } from "@/lib/uploadActivity";

const POLL_MS = 120_000;

interface DriveState {
  phase: "working" | "done";
  docName: string;
  indexed: number;
  total: number | null;
  queued: number;
  visionPages: number;
  visionSkipReason: string | null;
  finished: number;
}

export default function KnowledgeIndexIndicator() {
  const { activeOrgId, activeRole } = useRole();
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";
  const [state, setState] = useState<DriveState | null>(null);
  const [hidden, setHidden] = useState(false);
  // Minimized: indexing keeps running, but the card collapses to a small
  // pill so it stops sitting on top of every other bottom-corner surface.
  // Sticky across drain passes — new work must NOT re-expand a card the
  // user deliberately tucked away.
  const [minimized, setMinimized] = useState(false);
  const runningRef = useRef(false);

  useEffect(() => {
    if (!activeOrgId || !isController) return;
    let alive = true;

    const drain = async () => {
      if (runningRef.current) return;
      // Uploads are foreground work with someone watching. Indexing yields:
      // both compete for the same connections and the same database, and an
      // upload crawling behind a 900-page standard reads as a hang.
      if (isUploading()) return;
      runningRef.current = true;
      try {
        const attempted = new Set<string>();
        let finished = 0;
        let sawWork = false;
        for (;;) {
          if (!alive) return;
          // Re-checked between documents, not just at the top: a batch that
          // starts mid-drain must not have to wait out a long document.
          if (isUploading()) break;
          const { data } = await supabase
            .from("knowledge_documents")
            .select("id, name, status, pages_indexed, page_count")
            .eq("org_id", activeOrgId)
            .in("status", ["pending", "stale", "indexing"])
            .order("created_at", { ascending: true })
            .limit(50);
          const queue = ((data ?? []) as Array<{ id: string; name: string }>)
            .filter((d) => !attempted.has(d.id) && !isIngestActive(d.id));
          const next = queue[0];
          if (!next) break;
          attempted.add(next.id);
          sawWork = true;
          setHidden(false);
          setState({
            phase: "working", docName: next.name, indexed: 0, total: null,
            queued: queue.length - 1, visionPages: 0, visionSkipReason: null, finished,
          });
          try {
            await ingestKnowledgeDocument(next.id, (indexed, total, progress) => {
              if (!alive) return;
              setState({
                phase: "working", docName: next.name, indexed, total,
                queued: queue.length - 1,
                visionPages: progress?.visionPages ?? 0,
                visionSkipReason: progress?.visionSkipReason ?? null,
                finished,
              });
            });
            finished++;
          } catch { /* row is marked errored server-side; move on */ }
        }
        if (alive && sawWork) {
          setState((s) => s ? { ...s, phase: "done", finished } : null);
        }
      } finally {
        runningRef.current = false;
      }
    };

    void drain();
    const t = setInterval(() => { void drain(); }, POLL_MS);
    // Resume promptly once uploading stops, rather than waiting out the poll.
    const off = onUploadActivity((busy) => { if (!busy) void drain(); });
    return () => { alive = false; clearInterval(t); off(); };
  }, [activeOrgId, isController]);

  if (!state || hidden) return null;
  const working = state.phase === "working";

  // Minimized: a small pill in the corner — progress at a glance, one click
  // to bring the card back, and the rest of the corner free for other
  // surfaces. Indexing continues regardless.
  if (minimized) {
    const pctLabel = state.total ? `${Math.min(100, Math.round((state.indexed / state.total) * 100))}%` : "…";
    return (
      <CornerPortal>
        <button
          onClick={() => setMinimized(false)}
          title={working ? `Indexing ${state.docName} — click to expand` : "Indexing caught up — click to expand"}
          className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg px-3 py-1.5 text-[11px] font-black text-[var(--color-text)] hover:shadow-xl transition-shadow"
        >
          {working
            ? <><Loader2 className="w-3.5 h-3.5 animate-spin text-violet-600" /> Indexing {pctLabel}</>
            : <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Indexed</>}
        </button>
      </CornerPortal>
    );
  }

  return (
    <CornerPortal>
    <div className="pointer-events-auto w-[330px] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl p-3.5 animate-in slide-in-from-bottom-4">
      <div className="flex items-center gap-2">
        {working
          ? <BookOpenText className="w-4 h-4 text-violet-600 shrink-0" />
          : <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
        <span className="text-xs font-black text-[var(--color-text)] flex-1 truncate">
          {working ? "Indexing knowledge in the background" : "Knowledge indexing caught up"}
        </span>
        <button onClick={() => setMinimized(true)} className="p-1 rounded hover:bg-[var(--color-surface-2)] shrink-0" title="Minimize — indexing keeps running">
          <Minus className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
        </button>
        {working
          ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-text-muted)] shrink-0" />
          : (
            <button onClick={() => setHidden(true)} className="p-1 rounded hover:bg-[var(--color-surface-2)] shrink-0" title="Dismiss">
              <X className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
            </button>
          )}
      </div>
      {working ? (
        <div className="mt-1.5 space-y-1">
          <div className="text-[11px] text-[var(--color-text-muted)] truncate" title={state.docName}>
            {state.docName}
            {state.total ? ` — page ${state.indexed} of ${state.total}` : ""}
            {state.queued > 0 ? ` · ${state.queued} more queued` : ""}
          </div>
          {state.total !== null && state.total > 0 && (
            <div className="h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
              <div
                className="h-full bg-violet-500 transition-all"
                style={{ width: `${Math.min(100, Math.round((state.indexed / state.total) * 100))}%` }}
              />
            </div>
          )}
          {state.visionPages > 0 && (
            <div className="text-[10px] text-violet-700 flex items-center gap-1">
              <Eye className="w-3 h-3" /> {state.visionPages} page{state.visionPages === 1 ? "" : "s"} read by AI vision
            </div>
          )}
          {state.visionSkipReason && (
            <div className="text-[10px] text-amber-700">{state.visionSkipReason}</div>
          )}
          <div className="text-[10px] text-[var(--color-text-faint)]">
            Keeps going anywhere in the app — only closing the tab pauses it.
          </div>
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
          {state.finished} document{state.finished === 1 ? "" : "s"} indexed.
        </div>
      )}
    </div>
    </CornerPortal>
  );
}
