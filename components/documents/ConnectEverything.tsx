"use client";

// components/documents/ConnectEverything.tsx — the one button.
//
// Units, a read library watching the drawing libraries, reading, the
// registry, the links: one press runs them all. The server does a bounded
// pass; the browser reads the queued drawings with the caller's own AI key
// in between (three at a time, like the knowledge page) and presses again
// until nothing is left in flight. Progress is five lines, not seven
// screens.

import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Clock, AlertCircle, Sparkles, X } from "lucide-react";
import { estatePost } from "@/lib/estate/client";
import { ingestKnowledgeDocument } from "@/lib/knowledge";
import { readDrawing, pendingDrawings, undoRun as undoRunCall, newRunId } from "@/lib/drawingCensusClient";
import type { ConnectStatus } from "@/lib/estate/connectServer";
import type { ConnectPlan } from "@/lib/estate/connectPlan";

const MAX_PASSES = 40;

type Bulk = { done: number; total: number; equipment: number; removed: number; added: number; created: number; failed: number; current: string | null; finished: boolean; lastError: string | null };
type UndoResult = Awaited<ReturnType<typeof undoRunCall>>;

export function useConnectEverything(orgId: string | null, onDone?: () => void) {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ done: number; total: number; visionPages: number; reusedPages: number; visionSkip: string | null } | null>(null);
  const stop = useRef(false);
  /** Reading every drawing with the person's model, sheet by sheet. */
  const [bulk, setBulk] = useState<Bulk | null>(null);
  /** The preview shown before anything runs. */
  const [plan, setPlan] = useState<ConnectPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  /** The run in progress or just finished — what Undo puts back. */
  const [runId, setRunId] = useState<string | null>(null);
  const [journaled, setJournaled] = useState(true);
  const [undo, setUndo] = useState<{ busy: boolean; result: UndoResult | null; error: string | null } | null>(null);
  const libsRef = useRef<string[] | undefined>(undefined);
  const onDoneRef = useRef(onDone); useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  /** Step 1: show what would be sent to AI. Nothing runs. */
  const openPreview = async (libraryIds?: string[]) => {
    if (!orgId) return;
    setPlanLoading(true); setError(null);
    try { setPlan(await estatePost<ConnectPlan>("/api/estate/connect", { orgId, action: "plan", libraryIds })); }
    catch (e) { setError((e as Error).message); }
    finally { setPlanLoading(false); }
  };
  const closePreview = () => setPlan(null);

  /** Step 2: the person pressed Start with these libraries. */
  const start = async (libraryIds: string[]) => {
    setPlan(null);
    const id = newRunId();
    setRunId(id); setJournaled(true); setUndo(null); setBulk(null);
    libsRef.current = libraryIds;
    await run({ runId: id, libraryIds });
    if (!stop.current) await readAll({ runId: id, libraryIds, consented: true });
  };

  const run = async (opts: { visionAllPages?: boolean; rereadAll?: boolean; runId?: string; libraryIds?: string[] } = {}) => {
    if (!orgId || running) return;
    const rid = opts.runId ?? runId ?? newRunId();
    const libraryIds = opts.libraryIds ?? libsRef.current;
    if (!runId && !opts.runId) setRunId(rid);
    stop.current = false; setRunning(true); setError(null); setReading(null);
    try {
      for (let pass = 0; pass < MAX_PASSES && !stop.current; pass++) {
        // Options apply on the first pass; later passes only continue. The
        // libraries and the run id go every time.
        const body = { orgId, runId: rid, libraryIds, ...(pass === 0 ? { visionAllPages: opts.visionAllPages, rereadAll: opts.rereadAll } : {}) };
        const st = await estatePost<ConnectStatus>("/api/estate/connect", body);
        setStatus(st);
        if (!st.more) break;
        if (st.queuedIds.length) {
          // Read in the browser on the caller's key, three at a time.
          const ids = [...st.queuedIds];
          let done = 0, visionPages = 0, reusedPages = 0; let visionSkip: string | null = null;
          const perDoc = new Map<string, number>();
          const perDocReused = new Map<string, number>();
          const report = () => setReading({ done, total: st.queued, visionPages: [...perDoc.values()].reduce((a, b) => a + b, visionPages), reusedPages: [...perDocReused.values()].reduce((a, b) => a + b, reusedPages), visionSkip });
          report();
          const worker = async () => {
            for (;;) {
              const id = ids.shift();
              if (!id || stop.current) return;
              try {
                await ingestKnowledgeDocument(id, (_i, _t, progress) => {
                  if (!progress) return;
                  perDoc.set(id, progress.visionPages ?? 0);
                  perDocReused.set(id, progress.reusedPages ?? 0);
                  if (progress.visionSkipReason) visionSkip = progress.visionSkipReason;
                  report();
                });
              } catch { /* marked on the row; move on */ }
              visionPages += perDoc.get(id) ?? 0; perDoc.delete(id);
              reusedPages += perDocReused.get(id) ?? 0; perDocReused.delete(id);
              done++; report();
            }
          };
          await Promise.all([worker(), worker(), worker()]);
        }
      }
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); setReading(null); onDoneRef.current?.(); }
  };

  /** Read drawings with the person's model. From the preview the person has
   *  already seen and agreed; on its own it asks first. */
  const readAll = async (opts: { runId?: string; libraryIds?: string[]; consented?: boolean } = {}) => {
    if (!orgId) return;
    const libraryIds = opts.libraryIds ?? libsRef.current;
    let list: Awaited<ReturnType<typeof pendingDrawings>>;
    try { list = await pendingDrawings(orgId, libraryIds); } catch (e) { setError((e as Error).message); return; }
    const todo = list.pending;
    if (!todo.length) { setBulk({ done: 0, total: 0, equipment: 0, removed: 0, added: 0, created: 0, failed: 0, current: null, finished: true, lastError: null }); return; }
    if (!opts.consented) {
      const pagesDue = list.pagesDue ?? todo.length;
      const ok = window.confirm(`Read ${pagesDue} sheet${pagesDue === 1 ? "" : "s"} in ${todo.length} drawing${todo.length === 1 ? "" : "s"} with your AI model?\n\nOnly sheets not yet read in full are read - sheets already read are left as they are. Each sheet is read zoomed-in, region by region, and its equipment tags are corrected. Billed to your key under your monthly cap. You can stop at any time, and undo the run afterwards.`);
      if (!ok) return;
    }
    const rid = opts.runId ?? newRunId();
    setRunId(rid); setUndo(null);
    stop.current = false; setRunning(true);
    const st: Bulk = { done: 0, total: todo.length, equipment: 0, removed: 0, added: 0, created: 0, failed: 0, current: null, finished: false, lastError: null };
    setBulk({ ...st });
    const queue = [...todo];
    const worker = async () => {
      for (;;) {
        if (stop.current) return;
        const next = queue.shift(); if (!next) return;
        st.current = next.name; setBulk({ ...st });
        try {
          const r = await readDrawing(orgId, { knowledgeDocumentId: next.knowledgeDocumentId }, undefined, { runId: rid, runLabel: `Read ${todo.length} drawing${todo.length === 1 ? "" : "s"} with AI` }, next.pages);
          st.equipment += r.equipment.length;
          st.removed += r.correction?.removed.length ?? 0;
          st.added += r.correction?.added.length ?? 0;
          st.created += r.correction?.createdAssets ?? 0;
          if (!r.journaled) setJournaled(false);
        } catch (e) {
          st.failed++; st.lastError = (e as Error).message;
          // Out of budget or no key: every next sheet would fail the same way.
          if (/budget|key|agreement/i.test(st.lastError)) { stop.current = true; }
        }
        st.done++; setBulk({ ...st });
      }
    };
    await Promise.all([worker(), worker()]);
    st.current = null; st.finished = true; setBulk({ ...st });
    setRunning(false);
    onDoneRef.current?.();
  };

  const undoLast = async () => {
    if (!orgId || !runId) return;
    if (!window.confirm("Undo this run?\n\nEquipment columns, links and readings go back to how they were before it. Registry items it created are removed unless someone has since added photos, files, notes or edits to them. Anything a person changed after the run is left alone.")) return;
    setUndo({ busy: true, result: null, error: null });
    try { setUndo({ busy: false, result: await undoRunCall(orgId, runId), error: null }); onDoneRef.current?.(); }
    catch (e) { setUndo({ busy: false, result: null, error: (e as Error).message }); }
  };

  /** "Read new drawings automatically", on the caller's model, capped. */
  const setAutoRead = async (on: boolean, monthlyPages: number) => {
    if (!orgId || !status) return;
    setError(null);
    try {
      const r = await estatePost<{ on: boolean; monthlyPages: number; used: number }>("/api/estate/connect", { orgId, action: "autoRead", libraryId: status.readLibraryId, on, monthlyPages });
      setStatus((s) => s ? { ...s, ai: { ...s.ai, autoRead: { ...s.ai.autoRead, on: r.on, monthlyPages: r.monthlyPages, used: r.used, mine: r.on ? true : s.ai.autoRead.mine } } } : s);
    } catch (e) { setError((e as Error).message); }
  };

  const cancel = () => { stop.current = true; };
  return { status, running, error, reading, run, cancel, bulk, readAll, plan, planLoading, openPreview, closePreview, start, runId, journaled, undo, undoLast, setAutoRead };
}

export function ConnectButton({ running, onClick, disabled, className = "" }: { running: boolean; onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <button onClick={onClick} disabled={running || disabled} title="Units, drawings read, equipment registry and links - all of it, with sensible defaults. Safe to press again."
      className={`rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] px-2.5 py-1 inline-flex items-center gap-1 font-bold disabled:opacity-60 ${className}`}>
      {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} {running ? "Connecting…" : "Connect everything"}
    </button>
  );
}

export function ConnectProgress({ status, running, error, reading, onCancel, onClose, onRun, bulk, onReadAll, undoBox, onAutoRead }: {
  status: ConnectStatus | null; running: boolean; error: string | null; reading: { done: number; total: number; visionPages: number; reusedPages: number; visionSkip: string | null } | null;
  onCancel: () => void; onClose: () => void;
  /** Run again with options: read every page with vision, or re-read everything. */
  onRun?: (opts: { visionAllPages?: boolean; rereadAll?: boolean }) => void;
  bulk?: { done: number; total: number; equipment: number; removed: number; added: number; created: number; failed: number; current: string | null; finished: boolean; lastError: string | null } | null;
  onReadAll?: () => void;
  /** Undo the run just finished. */
  undoBox?: React.ReactNode;
  onAutoRead?: (on: boolean, monthlyPages: number) => void;
}) {
  if (!status && !running && !error && !bulk) return null;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/95 px-3 py-2 text-xs shadow-md space-y-1.5 max-w-md">
      <div className="flex items-center justify-between gap-2">
        <div className="font-black inline-flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)]" /> {running ? "Connecting the estate" : error ? "Stopped" : status?.more ? "Paused - press again to continue" : "Connected"}</div>
        {running ? <button onClick={onCancel} className="text-[11px] opacity-70 hover:opacity-100">stop</button> : <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>}
      </div>
      {error && <div className="text-red-700">{error}</div>}
      {!status && running && <div className="text-[var(--color-text-muted)] inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Looking at units, libraries and drawings…</div>}
      {status && (
        <ol className="space-y-1">
          {status.steps.map((s) => {
            const I = s.state === "done" ? CheckCircle2 : s.state === "working" ? Loader2 : s.state === "waiting" ? Clock : AlertCircle;
            const tone = s.state === "done" ? "text-emerald-600" : s.state === "working" ? "text-sky-600 animate-spin" : s.state === "waiting" ? "text-[var(--color-text-faint)]" : "text-rose-600";
            const detail = s.key === "index" && reading && running ? `${s.detail} · reading in this browser: ${reading.done} of ${reading.total}${reading.visionPages ? ` · ${reading.visionPages} page${reading.visionPages === 1 ? "" : "s"} read with AI vision` : ""}${reading.reusedPages ? ` · ${reading.reusedPages} reused from earlier reads (not billed)` : ""}` : s.detail;
            return (
              <li key={s.key} className="flex items-start gap-1.5">
                <I className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${tone}`} />
                <div className="min-w-0"><span className="font-bold">{s.title}</span> <span className="text-[var(--color-text-muted)]">· {detail}</span></div>
              </li>
            );
          })}
        </ol>
      )}
      {reading?.visionSkip && running && <div className="text-[11px] text-amber-700">{reading.visionSkip}</div>}
      {bulk && (
        <div className="rounded-md border border-violet-200 bg-violet-50/60 dark:bg-violet-950/20 px-2 py-1.5 text-[11px] space-y-0.5">
          <div className="font-bold inline-flex items-center gap-1">{!bulk.finished ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3 text-emerald-600" />} Drawings read with your AI model: {bulk.done} of {bulk.total}</div>
          {bulk.current && <div className="text-[var(--color-text-muted)] truncate">Now: {bulk.current}</div>}
          <div className="text-[var(--color-text-muted)]">{bulk.equipment} equipment callouts found · {bulk.added} tags put on drawings · {bulk.removed} wrong tags taken off · {bulk.created} new in the registry{bulk.failed ? ` · ${bulk.failed} failed` : ""}</div>
          {bulk.lastError && <div className="text-red-700">{bulk.lastError}</div>}
          {bulk.finished && bulk.total === 0 && <div>Every drawing is already read this way.</div>}
        </div>
      )}
      {!running && undoBox}
      {status && (
        <div className="text-[11px] text-[var(--color-text-muted)] border-t border-[var(--color-border)] pt-1.5 space-y-1">
          <div>
            {status.ai.hasKey
              ? <>AI vision is on your key ({status.ai.provider}{status.ai.model ? ` · ${status.ai.model}` : ""}): pages with no usable text layer are read by vision as they come up.</>
              : <>No AI key on your account, so pages with no text layer (scans, CAD text plotted as lines) stay unread. Add one in Intelligence › Setup and press again.</>}
          </div>
          {!running && onRun && (
            <div className="flex flex-wrap gap-1">
              <label className="inline-flex items-center gap-1 cursor-pointer" title="For sheets whose tags are drawn as lines: every page goes through AI vision. Costs per page on your key.">
                <input type="checkbox" checked={status.ai.visionAllPages} disabled={!status.ai.hasKey} onChange={(e) => onRun({ visionAllPages: e.target.checked })} className="w-3.5 h-3.5 accent-[var(--color-accent)]" />
                Read every page with AI vision
              </label>
              {onReadAll && <button onClick={onReadAll} disabled={!status.ai.hasKey} className="rounded-full border border-violet-300 bg-violet-50 text-violet-800 px-2 py-0.5 font-semibold hover:bg-violet-100 disabled:opacity-50">Read all drawings with AI</button>}
            </div>
          )}
          {!running && onAutoRead && <AutoReadSwitch auto={status.ai.autoRead} hasKey={status.ai.hasKey} onChange={onAutoRead} />}
          {!running && !status.more && <div>Search a tag now. {status.ai.autoRead.on ? "New drawings are read and tagged on their own." : "New drawings are picked up nightly, or press the button again."}</div>}
        </div>
      )}
    </div>
  );
}

/** "Undo this run", with what it put back. */
export function UndoRunBox({ runId, journaled, undo, onUndo }: {
  runId: string | null; journaled: boolean;
  undo: { busy: boolean; result: { drawings: number; columnsRestored: number; edgesRestored: number; edgesRemoved: number; assetsRemoved: number; assetsKept: string[]; readingsRestored: number; skipped: string[] } | null; error: string | null } | null;
  onUndo: () => void;
}) {
  if (!runId) return null;
  if (!journaled) return <div className="text-[11px] text-amber-700">Undo is not available for this run: apply migration 20261021_ai_boundary_runs.sql to record runs.</div>;
  const r = undo?.result;
  return (
    <div className="text-[11px] space-y-0.5">
      {!r && <button onClick={onUndo} disabled={undo?.busy} className="rounded-full border border-rose-300 bg-rose-50 text-rose-700 px-2 py-0.5 font-semibold hover:bg-rose-100 disabled:opacity-50 inline-flex items-center gap-1">{undo?.busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Undo this run</button>}
      {undo?.error && <div className="text-red-700">{undo.error}</div>}
      {r && <div className="text-emerald-700">Undone: {r.drawings} drawing{r.drawings === 1 ? "" : "s"} put back · {r.columnsRestored} equipment columns · {r.edgesRestored + r.edgesRemoved} links · {r.readingsRestored} readings · {r.assetsRemoved} registry items removed{r.assetsKept.length ? ` · kept ${r.assetsKept.join(", ")} (someone added to them)` : ""}{r.skipped.length ? ` · ${r.skipped.length} left as a person changed them since` : ""}.</div>}
    </div>
  );
}

/** New drawings read by the drawing reader as they arrive, on the sponsor's
 *  model, never more than the monthly page cap. */
function AutoReadSwitch({ auto, hasKey, onChange }: { auto: ConnectStatus["ai"]["autoRead"]; hasKey: boolean; onChange: (on: boolean, monthlyPages: number) => void }) {
  const [cap, setCap] = useState(String(auto.monthlyPages));
  const capNum = Math.max(1, Math.min(100_000, Number(cap) || auto.monthlyPages));
  return (
    <div className="rounded-md border border-[var(--color-border)] px-2 py-1.5 space-y-1">
      <label className="flex items-center gap-1.5 cursor-pointer font-semibold text-[var(--color-text)]" title="Every page of a new drawing is read by the drawing reader (the same one as Read with AI) and its equipment tagged. Every automatic change can be undone from Undo a run.">
        <input type="checkbox" checked={auto.on} disabled={!hasKey && !auto.on} onChange={(e) => onChange(e.target.checked, capNum)} className="w-3.5 h-3.5 accent-[var(--color-accent)]" />
        Read new drawings automatically
      </label>
      <div className="flex flex-wrap items-center gap-1">
        up to
        <input value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))} onBlur={() => { if (auto.on && capNum !== auto.monthlyPages) onChange(true, capNum); }} inputMode="numeric" className="w-14 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[11px]" />
        pages a month · {auto.used} used this month
      </div>
      <div>
        {auto.on
          ? <>On {auto.mine ? "your" : `${auto.sponsorName ?? "a colleague"}'s`} AI key{auto.mine ? "" : " - switching it off and on moves it to yours"}. Past the cap, new sheets wait in “Read all drawings with AI”.</>
          : hasKey ? <>Off. New sheets are indexed from their text and wait for “Read all drawings with AI”.</> : <>Needs your AI key (Intelligence › Setup).</>}
      </div>
    </div>
  );
}
