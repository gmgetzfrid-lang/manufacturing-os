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
import type { ConnectStatus } from "@/lib/estate/connectServer";

const MAX_PASSES = 40;

export function useConnectEverything(orgId: string | null, onDone?: () => void) {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ done: number; total: number; visionPages: number; visionSkip: string | null } | null>(null);
  const stop = useRef(false);
  const onDoneRef = useRef(onDone); useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  const run = async (opts: { visionAllPages?: boolean; rereadAll?: boolean } = {}) => {
    if (!orgId || running) return;
    stop.current = false; setRunning(true); setError(null); setReading(null);
    try {
      for (let pass = 0; pass < MAX_PASSES && !stop.current; pass++) {
        // Options apply on the first pass; later passes only continue.
        const st = await estatePost<ConnectStatus>("/api/estate/connect", pass === 0 ? { orgId, ...opts } : { orgId });
        setStatus(st);
        if (!st.more) break;
        if (st.queuedIds.length) {
          // Read in the browser on the caller's key, three at a time.
          const ids = [...st.queuedIds];
          let done = 0, visionPages = 0; let visionSkip: string | null = null;
          const perDoc = new Map<string, number>();
          const report = () => setReading({ done, total: st.queued, visionPages: [...perDoc.values()].reduce((a, b) => a + b, visionPages), visionSkip });
          report();
          const worker = async () => {
            for (;;) {
              const id = ids.shift();
              if (!id || stop.current) return;
              try {
                await ingestKnowledgeDocument(id, (_i, _t, progress) => {
                  if (!progress) return;
                  perDoc.set(id, progress.visionPages ?? 0);
                  if (progress.visionSkipReason) visionSkip = progress.visionSkipReason;
                  report();
                });
              } catch { /* marked on the row; move on */ }
              visionPages += perDoc.get(id) ?? 0; perDoc.delete(id);
              done++; report();
            }
          };
          await Promise.all([worker(), worker(), worker()]);
        }
      }
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); setReading(null); onDoneRef.current?.(); }
  };
  const cancel = () => { stop.current = true; };
  return { status, running, error, reading, run, cancel };
}

export function ConnectButton({ running, onClick, disabled, className = "" }: { running: boolean; onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <button onClick={onClick} disabled={running || disabled} title="Units, drawings read, equipment registry and links — all of it, with sensible defaults. Safe to press again."
      className={`rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] px-2.5 py-1 inline-flex items-center gap-1 font-bold disabled:opacity-60 ${className}`}>
      {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} {running ? "Connecting…" : "Connect everything"}
    </button>
  );
}

export function ConnectProgress({ status, running, error, reading, onCancel, onClose, onRun }: {
  status: ConnectStatus | null; running: boolean; error: string | null; reading: { done: number; total: number; visionPages: number; visionSkip: string | null } | null;
  onCancel: () => void; onClose: () => void;
  /** Run again with options: read every page with vision, or re-read everything. */
  onRun?: (opts: { visionAllPages?: boolean; rereadAll?: boolean }) => void;
}) {
  if (!status && !running && !error) return null;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/95 px-3 py-2 text-xs shadow-md space-y-1.5 max-w-md">
      <div className="flex items-center justify-between gap-2">
        <div className="font-black inline-flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)]" /> {running ? "Connecting the estate" : error ? "Stopped" : status?.more ? "Paused — press again to continue" : "Connected"}</div>
        {running ? <button onClick={onCancel} className="text-[11px] opacity-70 hover:opacity-100">stop</button> : <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>}
      </div>
      {error && <div className="text-red-700">{error}</div>}
      {!status && running && <div className="text-[var(--color-text-muted)] inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Looking at units, libraries and drawings…</div>}
      {status && (
        <ol className="space-y-1">
          {status.steps.map((s) => {
            const I = s.state === "done" ? CheckCircle2 : s.state === "working" ? Loader2 : s.state === "waiting" ? Clock : AlertCircle;
            const tone = s.state === "done" ? "text-emerald-600" : s.state === "working" ? "text-sky-600 animate-spin" : s.state === "waiting" ? "text-[var(--color-text-faint)]" : "text-rose-600";
            const detail = s.key === "index" && reading && running ? `${s.detail} · reading in this browser: ${reading.done} of ${reading.total}${reading.visionPages ? ` · ${reading.visionPages} page${reading.visionPages === 1 ? "" : "s"} read with AI vision` : ""}` : s.detail;
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
              <button onClick={() => onRun({ rereadAll: true })} className="rounded-full border border-[var(--color-border)] px-2 py-0.5 font-semibold hover:bg-[var(--color-surface-2)]">Re-read all drawings</button>
            </div>
          )}
          {!running && !status.more && <div>Search a tag now. New drawings are picked up nightly, or press the button again.</div>}
        </div>
      )}
    </div>
  );
}
