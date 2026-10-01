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
//   - Parked documents are left alone (ING-6 / ING-8, intelligence Round G
//     I-02b). A document whose back-off is in force (`vision_retry_after` in
//     the future: a failed batch's, or a refused vision retry's) is not even
//     read — the engine would answer 409 and do nothing. Every back-off the
//     engine holds carries its reason in `error`, so a future stamp with no
//     reason (a row the drawing rebuild reset, which nulls `error` and keeps
//     the stamp) holds nothing back and IS read. A document that carries a
//     reason (`error`) or a lapsed stamp is tried once per state per tab: on
//     its row the message promises another try "while an Admin or Doc
//     Control member has the app open", and this is that try. If the row is
//     unchanged on the next poll (a keyless park answers 409 and writes
//     nothing), it is not POSTed again until something moves it. That try
//     can itself move the row — the engine re-stamps a keyless park whose
//     stamp is half an hour old — so a parked row is POSTed at most twice
//     per tab per state change, and every other open tab sees the re-stamp
//     as a new state and tries it once more.
//   - The card shows only when a batch made progress — never just because a
//     document was attempted, so a dismissed card stays dismissed while the
//     queue holds only parked or busy documents. It never passes `retryNow`:
//     that is a person's Resume on the library page (ING-8).

import React, { useEffect, useRef, useState } from "react";
import { Loader2, X, BookOpenText, CheckCircle2, Eye, Minus } from "lucide-react";
import { CornerPortal } from "@/components/ui/CornerDock";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { ingestKnowledgeDocument, isIngestActive } from "@/lib/knowledge";
import { isUploading, onUploadActivity } from "@/lib/uploadActivity";

const POLL_MS = 120_000;

interface QueuedRow {
  id: string;
  name: string;
  pages_indexed?: number | null;
  error?: string | null;
  vision_retry_after?: string | null;
}

/** A row that carries a reason or a stamp: a failed batch (ING-8) or a park
 *  (ING-6) whose back-off has lapsed, or a keyless park (stamped at once). */
const isParked = (d: QueuedRow) => !!d.error || !!d.vision_retry_after;
/** The row's parked state — a new failure, park or stamp is a new state. */
const parkedState = (d: QueuedRow) => `${d.error ?? ""}|${d.vision_retry_after ?? ""}`;
const isMissingStampColumn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42703" || /vision_retry_after/.test(e.message ?? ""));

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
  const { activeOrgId, hasAnyRole } = useRole();
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  const isController = hasAnyRole(["Admin", "DocCtrl"]);
  const [state, setState] = useState<DriveState | null>(null);
  const [hidden, setHidden] = useState(false);
  // Minimized: indexing keeps running, but the card collapses to a small
  // pill so it stops sitting on top of every other bottom-corner surface.
  // Sticky across drain passes — new work must NOT re-expand a card the
  // user deliberately tucked away.
  const [minimized, setMinimized] = useState(false);
  const runningRef = useRef(false);
  // Parked rows this tab already tried, by the state it tried them in.
  const parkedTriedRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (!activeOrgId || !isController) return;
    let alive = true;

    // A back-off in force (a future stamp WITH its reason) is left out by the
    // query itself, and work with no stamp comes first (as the cron drain
    // orders it).
    const readQueue = async (): Promise<QueuedRow[]> => {
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase
        .from("knowledge_documents")
        .select("id, name, status, pages_indexed, page_count, error, vision_retry_after")
        .eq("org_id", activeOrgId)
        .in("status", ["pending", "stale", "indexing"])
        .or(`vision_retry_after.is.null,vision_retry_after.lte.${nowIso},error.is.null`)
        .order("vision_retry_after", { ascending: true, nullsFirst: true })
        .order("created_at", { ascending: true })
        .limit(50);
      if (!isMissingStampColumn(error)) return (data ?? []) as QueuedRow[];
      // A database without 20261122 has no back-off to leave out.
      const legacy = await supabase
        .from("knowledge_documents")
        .select("id, name, status, pages_indexed, page_count, error")
        .eq("org_id", activeOrgId)
        .in("status", ["pending", "stale", "indexing"])
        .order("created_at", { ascending: true })
        .limit(50);
      return (legacy.data ?? []) as QueuedRow[];
    };

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
        let sawProgress = false;
        for (;;) {
          if (!alive) return;
          // Re-checked between documents, not just at the top: a batch that
          // starts mid-drain must not have to wait out a long document.
          if (isUploading()) break;
          const queue = (await readQueue())
            .filter((d) => !attempted.has(d.id) && !isIngestActive(d.id))
            .filter((d) => !isParked(d) || parkedTriedRef.current.get(d.id) !== parkedState(d));
          const next = queue[0];
          if (!next) break;
          attempted.add(next.id);
          if (isParked(next)) parkedTriedRef.current.set(next.id, parkedState(next));
          else parkedTriedRef.current.delete(next.id);
          // The card comes up only once this document's batch moved: pages
          // indexed past where the row stood, or pages read by AI vision (a
          // vision retry reads pages without moving the resume point).
          const startIndexed = Number(next.pages_indexed ?? 0);
          let shown = false;
          try {
            await ingestKnowledgeDocument(next.id, (indexed, total, progress) => {
              if (!alive) return;
              const visionPages = progress?.visionPages ?? 0;
              if (!shown && indexed <= startIndexed && visionPages === 0) return;
              if (!shown) {
                shown = true;
                sawProgress = true;
                setHidden(false);
              }
              setState({
                phase: "working", docName: next.name, indexed, total,
                queued: queue.length - 1,
                visionPages,
                visionSkipReason: progress?.visionSkipReason ?? null,
                finished,
              });
            });
            if (shown) finished++;
          } catch { /* the reason is on the row (or answered 409); move on */ }
        }
        if (alive && sawProgress) {
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
