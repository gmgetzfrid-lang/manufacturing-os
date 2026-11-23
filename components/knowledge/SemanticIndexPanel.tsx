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
import { SkeletonText } from "@/components/ui/Skeleton";
import { friendlyError } from "@/lib/friendlyError";
import { Brain, Loader2, Square, RefreshCw } from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { appConfirm } from "@/components/providers/DialogProvider";
import { Button } from "@/components/ui/Button";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { Section, sheet } from "@/components/admin/kit";
import { StatusTag } from "@/components/documents/StatusTag";
import { Note, Cells, Bar } from "@/components/knowledge/panelKit";
import {
  semanticStatus, buildSemanticIndex, resetSemanticIndex, type SemanticProgress,
} from "@/lib/knowledge";

/** Rough, deliberately rounded UP so nobody is surprised by their provider's
 *  invoice. Embedding rates are a fraction of chat rates at every provider;
 *  this is a floor-of-magnitude estimate, not a quote. */
const CENTS_PER_1K_PASSAGES = 1;

/** Other panels showing the same library's meaning index (the Health panel)
 *  listen for this, so the two never show different numbers. */
export const MEANING_PROGRESS_EVENT = "knowledge:meaning-progress";
function announce(libraryId: string, p: SemanticProgress | null) {
  if (!p || p.countUnavailable || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MEANING_PROGRESS_EVENT, { detail: { libraryId, chunks: p.total, embedded: p.coveredNow } }));
}

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
  /** The last build's outcome, pinned under the bar — toasts vanish. */
  const [buildNote, setBuildNote] = useState<{ tone: "ok" | "info" | "err"; text: string } | null>(null);
  const stopRef = useRef(false);
  /** Last numbers that were actually read — shown while the database is too
   *  busy to count, instead of an error or a zero. */
  const lastGood = useRef<SemanticProgress | null>(null);
  const [recountTick, setRecountTick] = useState(0);

  const load = useCallback(async () => {
    const prior = lastGood.current;
    try {
      const status = await semanticStatus(orgId, libraryId, prior);
      if (status.countUnavailable) {
        // Busy and nothing known yet: say "counting", look again shortly.
        setState({ key, status: prior, unavailable: null });
        setTimeout(() => setRecountTick((n) => n + 1), 20_000);
        return;
      }
      if (!status.busy) lastGood.current = status;
      setState({ key, status, unavailable: null });
      announce(libraryId, status);
    } catch (e) {
      // A gateway hiccup is weather: keep what's on screen, look again soon.
      if ((e as { transient?: boolean }).transient) {
        setState({ key, status: prior, unavailable: null });
        setTimeout(() => setRecountTick((n) => n + 1), 20_000);
        return;
      }
      // A missing migration is the common case and is a setup state, not an
      // error to shout about. Anything else is worth showing.
      const message = e instanceof Error ? e.message : "Couldn't read the meaning index.";
      setState({ key, status: null, unavailable: message });
    }
  }, [orgId, libraryId, key]);

  useEffect(() => { void load(); }, [load, recountTick]);

  const ready = state.key === key;
  const status = ready ? state.status : null;
  const unavailable = ready ? state.unavailable : null;

  const build = async ({ keepBuildingState = false } = {}) => {
    if (!keepBuildingState) setBuilding(true);
    setBuildNote(null);
    stopRef.current = false;
    try {
      const final = await buildSemanticIndex(
        orgId, libraryId,
        (p) => {
          if (!p.estimated && !p.countUnavailable) lastGood.current = p;
          setState((s) => ({ ...s, key, status: p, unavailable: null }));
          announce(libraryId, p);
        },
        () => stopRef.current,
        lastGood.current ?? status,
      );
      if (final.error) {
        setBuildNote({ tone: "err", text: final.error });
      } else if (final.done) {
        setBuildNote({ tone: "ok", text: "Meaning index complete: every passage carries a vector." });
        showToast({ type: "success", title: "Meaning index complete." });
      } else if (final.paused) {
        setBuildNote({
          tone: "info",
          text: "Paused while the database catches up. Everything built is saved and the build carries on in the background; "
            + "press Build index to drive it from this tab again.",
        });
      } else if (stopRef.current) {
        setBuildNote({ tone: "ok", text: `Stopped with ${final.remaining.toLocaleString()} passage${final.remaining === 1 ? "" : "s"} left. Resume any time; nothing built is lost.` });
      } else {
        // Ended without finishing, erroring, or being stopped — a silent
        // no-op is the one outcome that must never pass without comment.
        setBuildNote({ tone: "info", text: `Paused with ${final.remaining.toLocaleString()} passage${final.remaining === 1 ? "" : "s"} to go. Everything built is saved; press Build index to continue.` });
      }
    } catch (e) {
      const message = friendlyError(e);
      // 412 = no embeddings key. That's a setup step, not a failure — show it
      // where the user is looking rather than as a toast they'll dismiss.
      if (/embeddings key/i.test(message)) setNeedsKey(message);
      else setBuildNote({ tone: "err", text: message });
    } finally {
      setBuilding(false);
      void load();
    }
  };

  const rebuild = async () => {
    const ok = await appConfirm({
      title: "Rebuild the meaning index?",
      message:
        `This clears all ${status?.total.toLocaleString()} vectors and re-embeds every passage `
        + `on your key - roughly ${fullCents}¢. Do it after ingestion or the embedding model `
        + "changes, so older documents are indexed the same way as new ones. "
        + "Meaning-based search is degraded until the rebuild finishes; keyword search is unaffected.",
      confirmLabel: "Rebuild",
    });
    if (!ok) return;
    setBuildNote(null);
    setBuilding(true);
    try {
      await resetSemanticIndex(orgId, libraryId);
      await load();
      await build({ keepBuildingState: true });
    } catch (e) {
      setBuildNote({ tone: "err", text: friendlyError(e) });
      setBuilding(false);
    }
  };

  // A panel that renders NOTHING is indistinguishable from a feature that was
  // never built. It used to disappear on any non-migration error and
  // whenever the library had no passages at all (a library of AutoCAD SHX
  // exports indexes to almost nothing until image reading is on). Say the
  // state out loud instead, and name the fix.
  const help = (
    <span className="font-sans font-normal text-[14px] leading-snug"><HelpTooltip>
      Finds &ldquo;pipe supports&rdquo; in a standard that says &ldquo;hanger and support details&rdquo;. Keyword search still handles exact tags. Building it uses your embeddings key, which is separate from your chat key (AI settings).
    </HelpTooltip></span>
  );
  const shell = (tag: React.ReactNode, body: React.ReactNode, action?: React.ReactNode) => (
    <Section label={<span className="inline-flex items-center gap-2.5">Meaning-based search {tag}{help}</span>} action={action}>
      <div className={`${sheet} px-4 sm:px-5 py-4`}>{body}</div>
    </Section>
  );

  if (unavailable) {
    return shell(
      <StatusTag tone="warn">{/migration/i.test(unavailable) ? "Not set up" : "Unknown"}</StatusTag>,
      <Note tone="warn" title={/migration/i.test(unavailable) ? "Waiting on a database migration." : "Couldn't read the meaning index."}>{unavailable}</Note>,
    );
  }
  if (!status) return shell(null, <div><p className="sr-only">Counting the meaning index</p><SkeletonText lines={2} /></div>);
  if (status.total === 0) {
    return shell(
      <StatusTag tone="none">Nothing to index</StatusTag>,
      <Note tone="none" title="This library has no indexed passages yet.">
        Uploaded documents read as almost no text are usually AutoCAD exports with SHX fonts, or scans. Turn on &ldquo;These are CAD exports or scans&rdquo; in Library AI setup, re-index the documents, then come back here.
      </Note>,
    );
  }

  const covered = status.coveredNow ?? 0;
  const pct = status.total > 0 ? Math.round((covered / status.total) * 100) : 0;
  const complete = status.remaining === 0;
  const estCents = Math.ceil((status.remaining / 1000) * CENTS_PER_1K_PASSAGES);
  const fullCents = Math.ceil((status.total / 1000) * CENTS_PER_1K_PASSAGES);

  const action = isController ? (
    building ? (
      <Button size="sm" variant="secondary" className="!h-9 !text-[14px]" onClick={() => { stopRef.current = true; }}>
        <Square className="w-3.5 h-3.5" /> Stop
      </Button>
    ) : complete ? (
      // A finished index is not a permanent one. Chunking changes when
      // ingestion improves and models get swapped; without this the
      // upgrade would reach only documents added afterwards and the
      // library would sit half-indexed under two regimes with nothing
      // on screen saying so.
      <Button size="sm" variant="secondary" className="!h-9 !text-[14px]" onClick={() => void rebuild()}>
        <RefreshCw className="w-4 h-4" /> Rebuild index
      </Button>
    ) : (
      <Button size="sm" variant="secondary" className="!h-9 !text-[14px]" onClick={() => void build()}>
        <Brain className="w-4 h-4" /> Build index
      </Button>
    )
  ) : undefined;

  const tag = complete ? <StatusTag tone="good">Complete</StatusTag>
    : building ? <StatusTag tone="warn">Building</StatusTag>
    : covered === 0 ? <StatusTag tone="none">Not built</StatusTag>
    : <StatusTag tone="warn">Partly built</StatusTag>;

  return (
    <Section label={<span className="inline-flex items-center gap-2.5">Meaning-based search {tag}{help}</span>} action={action}>
      <div className={`${sheet} overflow-hidden`}>
        <Cells cells={[
          { label: "Passages with meaning", value: <>{status.estimated ? "≈ " : ""}{covered.toLocaleString()}<span className="text-[var(--color-text-muted)] font-medium text-[18px]"> of {status.total.toLocaleString()}</span></> },
          { label: "Built", value: `${pct}%`, tone: complete ? "good" : undefined },
          { label: "Left to build", value: status.remaining.toLocaleString() },
          complete
            ? { label: "To rebuild, about", value: fullCents > 0 ? `${fullCents}¢` : "-", hint: "On your embeddings key" }
            : { label: "To finish, about", value: estCents > 0 ? `${estCents}¢` : "-", hint: "On your embeddings key" },
        ]} />
        <div className="px-4 sm:px-5 pb-4">
          <Bar segments={[{ key: "built", value: covered, color: "var(--color-main)" }]} total={status.total} label={`${pct}% built`} />
          <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
            {building && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {building && status.busy ? "Database busy: pausing a moment, nothing lost."
              : complete ? "Every passage carries a vector."
              : covered === 0 ? "Not built yet. Questions use keyword search alone."
              : "Partly built. The rest are keyword-only until this finishes."}
          </p>
        </div>

        {((building && status.rateLimited) || buildNote || needsKey) && (
          <div className="border-t border-[var(--color-border)] px-4 sm:px-5 py-3 space-y-2.5">
            {building && status.rateLimited && (
              <Note tone="warn" title="Provider rate limit: pacing, not stopped.">
                Your embeddings account is on a free tier, so the build runs in small batches about once a minute. Leave this page open and it will finish; a payment method at your provider unlocks full speed.
              </Note>
            )}
            {buildNote && <Note tone={buildNote.tone === "ok" ? "good" : buildNote.tone === "err" ? "bad" : "none"}>{buildNote.text}</Note>}
            {needsKey && <Note tone="warn" title="Needs an embeddings key.">{needsKey}</Note>}
          </div>
        )}
      </div>
    </Section>
  );
}
