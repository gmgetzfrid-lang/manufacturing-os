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
//
// Round G (I-02): the price is the ledger's own (lib/ai/pricing, per model,
// over the library's real text — SEM-13); coverage is defined against the
// passages search can return (SEM-5); a library holding two embedding models,
// or a build that would create one, is said out loud (SEM-1 / SEM-3);
// passages the provider refused are listed, not left to stall the build
// (SEM-4); the background build says who pays and why it is waiting
// (SEM-11); and a controller can keep the index current as documents arrive
// (SEM-8).

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Brain, Loader2, AlertTriangle, Check, Square, RefreshCw } from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { appConfirm } from "@/components/providers/DialogProvider";
import { Button } from "@/components/ui/Button";
import {
  semanticStatus, buildSemanticIndex, resetSemanticIndex, retryFailedPassages,
  setKeepIndexCurrent, releaseBackgroundBuild, acceptAiAgreement,
  type SemanticProgress, type AgreementRequiredError,
} from "@/lib/knowledge";

/** A dollar figure a person can read: cents under a dollar, never "$0.00"
 *  for a real (tiny) cost. */
export function formatEmbedCost(usd: number): string {
  if (!(usd > 0)) return "";
  if (usd < 0.01) return "under 1¢";
  if (usd < 1) return `~${Math.ceil(usd * 100)}¢`;
  return `~$${usd.toFixed(2)}`;
}

export default function SemanticIndexPanel({ orgId, libraryId, isController, onStatus }: {
  orgId: string;
  libraryId: string;
  isController: boolean;
  /** The page reads coverage too — the drift line and each answer's
   *  retrieval note (SEM-8 / SEM-12). */
  onStatus?: (status: SemanticProgress | null) => void;
}) {
  const { showToast } = useToast();
  const key = `${orgId}:${libraryId}`;
  const [state, setState] = useState<{
    key: string; status: SemanticProgress | null; unavailable: string | null;
  }>({ key: "", status: null, unavailable: null });
  const [building, setBuilding] = useState(false);
  const [needsKey, setNeedsKey] = useState<string | null>(null);
  /** The last build's outcome, pinned under the bar — toasts vanish. */
  const [buildNote, setBuildNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
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

  useEffect(() => { onStatus?.(status); }, [status, onStatus]);

  /** A first build asks for the acceptable-use agreement (428): show it,
   *  record acceptance, and go on — once. */
  const withAgreement = async <T,>(run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (e) {
      const err = e as AgreementRequiredError;
      if (!err.agreementRequired) throw e;
      const agreed = await appConfirm({
        title: "Before your first build — the ground rules",
        message: err.agreementText ??
          "Passages of your documents are sent to your embeddings provider. Never index passwords, "
          + "financial details, or personal identity information.",
        confirmLabel: "I agree",
      });
      if (!agreed) return null;
      await acceptAiAgreement(orgId);
      return run();
    }
  };

  const build = async ({ keepBuildingState = false } = {}) => {
    if (!keepBuildingState) setBuilding(true);
    setBuildNote(null);
    stopRef.current = false;
    try {
      const final = await withAgreement(() => buildSemanticIndex(
        orgId, libraryId,
        (p) => setState((s) => ({ ...s, key, status: p, unavailable: null })),
        () => stopRef.current,
      ));
      if (!final) return;
      const refusedNote = (final.failed ?? 0) > 0
        ? ` ${final.failed} passage(s) could not be embedded — listed below.`
        : "";
      if (final.error) {
        setBuildNote({ tone: "err", text: final.error });
        showToast({ type: "error", title: final.error, duration: 15000 });
      } else if (final.done) {
        const text = (final.failed ?? 0) > 0
          ? `Meaning index complete for every passage the provider accepted.${refusedNote}`
          : "Meaning index complete — every passage carries a vector.";
        setBuildNote({ tone: "ok", text });
        showToast({ type: "success", title: "Meaning index complete." });
      } else if (stopRef.current) {
        setBuildNote({ tone: "ok", text: `Stopped — ${final.remaining} passage(s) left. Resume any time.` });
        showToast({ type: "success", title: `Stopped — ${final.remaining} passage(s) left. Resume any time.` });
      } else if ((final.busy ?? 0) > 0) {
        const text = `The background build is embedding the remaining ${final.remaining} passage(s) — it continues without this tab.`;
        setBuildNote({ tone: "ok", text });
      } else {
        // Ended without finishing, erroring, or being stopped — a silent
        // no-op is the one outcome that must never pass without comment.
        const text = `Build ended early — ${final.remaining} passage(s) still lack vectors. Try again; if it repeats, tell your admin.`;
        setBuildNote({ tone: "err", text });
        showToast({ type: "warning", title: text, duration: 15000 });
      }
      if (final.backgroundNote) showToast({ type: "warning", title: final.backgroundNote, duration: 15000 });
    } catch (e) {
      const message = (e as Error).message;
      // 412 = no embeddings key. That's a setup step, not a failure — show it
      // where the user is looking rather than as a toast they'll dismiss.
      if (/embeddings key/i.test(message)) setNeedsKey(message);
      else setBuildNote({ tone: "err", text: message });
    } finally {
      setBuilding(false);
      void load();
    }
  };

  const model = status?.connection?.model ?? null;
  const fullCost = formatEmbedCost(status?.estimate?.fullUsd ?? 0);
  const remainingCost = formatEmbedCost(status?.estimate?.remainingUsd ?? 0);
  const estimateNote = status?.estimate?.placeholderRate
    ? " (estimate — this provider's rate in the app is a conservative placeholder)"
    : " (estimate)";

  const rebuild = async () => {
    // A rebuild is the rebuilder's: another member's background consent is
    // ended first (the route does it), and the dialog says so beforehand.
    const others = status?.background && !status.background.mine ? status.background : null;
    const ok = await appConfirm({
      title: "Rebuild the meaning index?",
      message:
        `This clears all ${status?.total.toLocaleString()} passages' vectors and re-embeds every one on your key`
        + (model ? ` with ${model}` : "")
        + (fullCost ? ` — ${fullCost}${estimateNote}` : "")
        + ". Vectors from one embedding model are never reused by another, so switching models always means a rebuild. "
        + (others
          ? (others.standing
            ? "It also ends another member's consent to keep this index current on their key — the rebuild is paid by you, and they can turn it back on afterwards. "
            : "It also stops the background build running on another member's key — the rebuild is paid by you. ")
          : "")
        + "Do it after ingestion or the embedding model changes, so older documents are indexed the same way as new ones. "
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
      setBuildNote({ tone: "err", text: (e as Error).message });
      setBuilding(false);
    }
  };

  const act = async (run: () => Promise<unknown>, done: string) => {
    try {
      const out = await withAgreement(run);
      if (out === null) return;
      showToast({ type: "success", title: done });
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally {
      void load();
    }
  };

  // A panel that renders NOTHING is indistinguishable from a feature that was
  // never built — and this one used to disappear in three different ways: on
  // any non-migration error, and whenever the library had no passages at all.
  //
  // That second case is the one that matters. A library of AutoCAD SHX
  // exports indexes to almost nothing until image reading is switched on, so
  // total is 0, so the panel vanished — exactly when the person needed it to
  // explain itself. Say the state out loud instead, and name the fix.
  const strip = (tone: "warn" | "muted", body: React.ReactNode) => (
    <div className={`mt-4 rounded-2xl border px-4 py-3 text-[11px] flex items-start gap-2 ${
      tone === "warn"
        ? "border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200"
        : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"}`}>
      {tone === "warn"
        ? <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
        : <Brain className="w-4 h-4 shrink-0 mt-0.5 opacity-60" />}
      <span className="min-w-0">{body}</span>
    </div>
  );

  if (unavailable) {
    return /migration/i.test(unavailable)
      ? strip("warn", <><b>Meaning-based search is waiting on a database migration:</b> {unavailable}</>)
      : strip("warn", <><b>Meaning-based search couldn&apos;t report its status:</b> {unavailable}</>);
  }
  if (!status) return strip("muted", "Checking the meaning index…");
  if (status.total === 0) {
    return strip("muted", (
      <>
        <b className="text-[var(--color-text)]">Meaning-based search has nothing to index yet.</b>{" "}
        This library has no indexed passages. If the documents are already uploaded, they were
        read as having almost no text — the usual cause is an AutoCAD export drawn with SHX fonts,
        or a scan, where every tag is line-work rather than text. Turn on{" "}
        <b>&ldquo;Text doesn&apos;t extract from these files — index every page as an image&rdquo;</b> in
        Library AI setup, run <b>Re-index all</b> in the Documents header, then come back here.
      </>
    ));
  }

  const covered = status.coveredNow ?? 0;
  const pct = status.total > 0 ? Math.round((covered / status.total) * 100) : 0;
  const complete = status.remaining === 0;
  const failed = status.failed ?? 0;
  const conflict = status.conflict ?? null;
  const bg = status.background ?? null;
  const canRelease = !!bg && (isController || bg.mine);

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
        {isController && (
          building ? (
            <Button size="sm" variant="secondary" onClick={() => { stopRef.current = true; }}>
              <Square className="w-3.5 h-3.5" /> Stop
            </Button>
          ) : complete || conflict || status.mixed ? (
            // A finished index is not a permanent one. Chunking changes when
            // ingestion improves and models get swapped; without this the
            // upgrade would reach only documents added afterwards and the
            // library would sit half-indexed under two regimes with nothing
            // on screen saying so. A model conflict or a mixed index has only
            // this way forward: Build would mix two vector spaces.
            <Button size="sm" variant="secondary" onClick={() => void rebuild()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rebuild index
              {fullCost && <span className="opacity-70"> ({fullCost})</span>}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void build()}>
              <Brain className="w-3.5 h-3.5" /> Build index
              {remainingCost && <span className="opacity-70"> ({remainingCost})</span>}
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
        {complete && !status.mixed && <Check className="w-3 h-3 text-emerald-600" />}
        <span>
          <b className="text-[var(--color-text)]">{covered.toLocaleString()}</b> of{" "}
          {status.total.toLocaleString()} passages carry meaning vectors ({pct}%).
        </span>
      </div>
      <p className="mt-0.5 text-[10px] text-[var(--color-text-faint)]">
        Counted over the passages of documents that are indexed and searchable — the same passages meaning search can return.
        {status.estimate && (isController || bg?.mine) && (
          <> Prices are for {status.estimate.model}{estimateNote}, from the same rates the usage ledger bills.</>
        )}
      </p>

      {status.mixed && (
        <div className="mt-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200">
          <b>This index mixes embedding models</b> ({Object.entries(status.models ?? {}).map(([m, n]) => `${m}: ${n.toLocaleString()}`).join(" · ")}).
          Vectors from different models can&apos;t be compared, so meaning search is off for this library until it is rebuilt under one model.
          {isController ? " Rebuild index re-embeds every passage with your current setting." : " An Admin or Doc Control can rebuild it."}
        </div>
      )}
      {!status.mixed && conflict && isController && (
        <div className="mt-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200">
          {conflict}
        </div>
      )}

      {building && status.rateLimited && (
        <div className="mt-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200">
          <b>Provider rate limit — pacing, not stopped.</b> Your embeddings account is on a free
          tier (Voyage without a payment method: 3 calls and 10K tokens per minute), so the build
          continues in small batches about once a minute. Leave this page open and it will finish.
          Adding a payment method at your provider unlocks full speed — your free trial tokens
          still apply.
        </div>
      )}

      {buildNote && (
        <div className={`mt-2 rounded-xl border px-3 py-2 text-[11px] ${
          buildNote.tone === "ok"
            ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-200"
            : "border-rose-300 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-950/20 text-rose-800 dark:text-rose-200"}`}>
          {buildNote.text}
        </div>
      )}

      {failed > 0 && (
        <div className="mt-2 rounded-xl border border-rose-300 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-950/20 px-3 py-2 text-[11px] text-rose-800 dark:text-rose-200">
          <b>{failed.toLocaleString()} passage{failed === 1 ? "" : "s"} could not be embedded</b> — the provider refused
          {failed === 1 ? " it" : " them"} every time, so the build skips {failed === 1 ? "it" : "them"} and the rest of the
          library is still built. {failed === 1 ? "It is" : "They are"} found by keyword search only.
          {(status.failedSamples ?? []).length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {(status.failedSamples ?? []).map((s, i) => (
                <li key={i}>
                  {s.documentName.replace(/\.pdf$/i, "")} · p.{s.page}
                  {s.error ? <span className="opacity-80"> — {s.error.slice(0, 160)}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {isController && !building && (
            <button className="mt-1.5 font-black underline"
              onClick={() => void act(() => retryFailedPassages(orgId, libraryId), "Queued the refused passages for another try.")}>
              Try them again
            </button>
          )}
        </div>
      )}

      {bg && (
        <div className="mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
          <b className="text-[var(--color-text)]">
            {bg.standing ? "Kept current in the background" : "Background build"}
          </b>{" "}
          — runs on {bg.mine ? "your" : "another member's"} embeddings key and monthly cap
          {bg.lastDrainAt ? `, last run ${new Date(bg.lastDrainAt).toLocaleString()}` : ""}.
          {bg.blockedUntil && new Date(bg.blockedUntil).getTime() > Date.now() && (
            <span className="block mt-0.5 text-amber-800 dark:text-amber-300 font-bold">
              Waiting until {new Date(bg.blockedUntil).toLocaleString()} —{" "}
              {bg.blockedReason === "cap" ? "the monthly AI budget is reached; it resets on the 1st"
                : bg.blockedReason === "model_conflict" ? "the payer's embedding model no longer matches this index"
                : bg.blockedReason === "agreement" ? "the payer has not accepted the current AI agreement"
                : "the last runs failed"}
              {bg.lastError ? `: ${bg.lastError.slice(0, 200)}` : "."}
            </span>
          )}
          {canRelease && !building && (
            <button className="ml-1 font-black underline"
              onClick={() => void act(() => releaseBackgroundBuild(orgId, libraryId), "Background build stopped.")}>
              Stop it
            </button>
          )}
        </div>
      )}

      {isController && !building && !status.mixed && (
        <label className="mt-2 flex items-start gap-2 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
          <input type="checkbox" className="accent-violet-600 w-3.5 h-3.5 mt-0.5"
            checked={!!bg?.standing && bg.mine}
            onChange={(e) => void act(
              () => setKeepIndexCurrent(orgId, libraryId, e.target.checked),
              e.target.checked ? "This library's meaning index will be kept current." : "No longer kept current in the background.",
            )} />
          <span>
            <b className="text-[var(--color-text)]">Keep this index current as documents are added</b> — new passages are
            embedded in the background on your embeddings key, within your monthly cap. Without it, passages added after a
            build stay keyword-only until someone builds again.
          </span>
        </label>
      )}

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
