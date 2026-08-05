"use client";

// components/knowledge/SemanticIndexPanel.tsx — the meaning index, stated plainly.
//
// Two things this panel exists to prevent:
//
//   1. A workspace believing semantic search is running when it isn't. That
//      produces answers that are quietly worse with no way to find out why —
//      the single most corrosive failure a retrieval system can have.
//      Its mirror image is just as bad and shipped here first: telling a
//      Claude user they need an OpenAI key, as though the chat provider
//      decided who may embed. It doesn't. The embeddings key is its own key.
//   2. A cost surprise. Embedding a library spends the user's own money on
//      their own key. It's a button they press, never a background job that
//      shows up on a bill.
//
// The panel is deliberately unglamorous: how many passages carry meaning
// vectors, what it costs to finish, and a button. Building runs in the
// BROWSER as a loop of small server batches — free-tier hosting kills long
// requests, and every committed batch is permanent, so an interrupted build
// resumes exactly where it stopped.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Brain, Loader2, AlertTriangle, Check, Square } from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { semanticStatus, buildSemanticIndex, type SemanticProgress } from "@/lib/knowledge";

/** Rough, deliberately rounded UP so nobody is surprised by their provider's
 *  invoice. Embedding rates are a fraction of chat rates at every provider;
 *  this is a floor-of-magnitude estimate, not a quote. */
const CENTS_PER_1K_PASSAGES = 1;

export default function SemanticIndexPanel({ orgId, libraryId, isController }: {
  orgId: string;
  libraryId: string;
  isController: boolean;
}) {
  const { showToast } = useToast();
  const key = `${orgId}:${libraryId}`;
  const [state, setState] = useState<{
    key: string; status: SemanticProgress | null; unavailable: string | null;
  }>({ key: "", status: null, unavailable: null });
  const [building, setBuilding] = useState(false);
  const [needsKey, setNeedsKey] = useState<string | null>(null);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const status = await semanticStatus(orgId, libraryId);
      setState({ key, status, unavailable: null });
    } catch (e) {
      // A missing migration is the common case and is a setup state, not an
      // error to shout about. Anything else is worth showing.
      const message = e instanceof Error ? e.message : "Couldn't read the meaning index.";
      setState({ key, status: null, unavailable: message });
    }
  }, [orgId, libraryId, key]);

  useEffect(() => { void load(); }, [load]);

  const ready = state.key === key;
  const status = ready ? state.status : null;
  const unavailable = ready ? state.unavailable : null;

  const build = async () => {
    setBuilding(true);
    stopRef.current = false;
    try {
      const final = await buildSemanticIndex(
        orgId, libraryId,
        (p) => setState((s) => ({ ...s, key, status: p, unavailable: null })),
        () => stopRef.current,
      );
      if (final.error) showToast({ type: "error", title: final.error });
      else if (final.done) showToast({ type: "success", title: "Meaning index complete." });
      else if (stopRef.current) {
        showToast({ type: "success", title: `Stopped — ${final.remaining} passage(s) left. Resume any time.` });
      }
    } catch (e) {
      const message = (e as Error).message;
      // 412 = no embeddings key. That's a setup step, not a failure — show it
      // where the user is looking rather than as a toast they'll dismiss.
      if (/embeddings key/i.test(message)) setNeedsKey(message);
      else showToast({ type: "error", title: message });
    } finally {
      setBuilding(false);
      void load();
    }
  };

  if (unavailable) {
    // Only the migration case is worth a visible strip; anything else means
    // this library simply has nothing indexed yet.
    if (!/migration/i.test(unavailable)) return null;
    return (
      <div className="mt-4 rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-4 py-3 text-[11px] text-amber-900 dark:text-amber-200 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
        <span><b>Meaning-based search is waiting on a database migration:</b> {unavailable}</span>
      </div>
    );
  }
  if (!status || status.total === 0) return null;

  const covered = status.coveredNow ?? 0;
  const pct = status.total > 0 ? Math.round((covered / status.total) * 100) : 0;
  const complete = status.remaining === 0;
  const estCents = Math.ceil((status.remaining / 1000) * CENTS_PER_1K_PASSAGES);

  return (
    <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
            <Brain className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-xs font-black text-[var(--color-text)]">Meaning-based search</div>
            <div className="text-[10px] text-[var(--color-text-muted)]">
              Finds &ldquo;pipe supports&rdquo; in a standard that says &ldquo;hanger and support details&rdquo;.
              Keyword search still handles exact tags, and always will.
            </div>
          </div>
        </div>
        {isController && !complete && (
          building ? (
            <Button size="sm" variant="secondary" onClick={() => { stopRef.current = true; }}>
              <Square className="w-3.5 h-3.5" /> Stop
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void build()}>
              <Brain className="w-3.5 h-3.5" /> Build index
              {estCents > 0 && <span className="opacity-70"> (~{estCents}¢)</span>}
            </Button>
          )
        )}
      </div>

      <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        {building && <Loader2 className="w-3 h-3 animate-spin" />}
        {complete && <Check className="w-3 h-3 text-emerald-600" />}
        <span>
          <b className="text-[var(--color-text)]">{covered.toLocaleString()}</b> of{" "}
          {status.total.toLocaleString()} passages carry meaning vectors ({pct}%).
        </span>
      </div>

      {needsKey && (
        <div className="mt-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200">
          {needsKey}
        </div>
      )}

      {!complete && !needsKey && (
        <p className="mt-1 text-[10px] text-[var(--color-text-faint)]">
          {covered === 0
            ? "Not built yet — questions use keyword search alone, which is exactly what this library did before."
            : "Partly built — questions already use both, and the remaining passages are keyword-only until this finishes."}
          {" "}Needs an embeddings key, which is separate from your chat key — add one under
          AI settings. Claude keeps answering the questions either way.
        </p>
      )}
    </div>
  );
}
