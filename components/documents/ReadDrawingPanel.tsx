"use client";

// components/documents/ReadDrawingPanel.tsx — "Read with AI" on one sheet.
//
// The sheet is read the way the chat reads it (your own model, the sheet in
// zoomed tiles), and the answer is shown as the drawing actually is:
// equipment callouts, instruments, and what only an off-sheet arrow names.
// Wrong tags the old reading put on the drawing are taken back and listed.

import React, { useState } from "react";
import { Loader2, Sparkles, Cpu, Gauge, ArrowRightLeft, CheckCircle2, XCircle } from "lucide-react";
import { readDrawing, newRunId, undoRun, type CensusRun } from "@/lib/drawingCensusClient";

export default function ReadDrawingPanel({ orgId, documentId, onDone }: { orgId: string; documentId: string; onDone?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [run, setRun] = useState<{ id: string; r: CensusRun; runId: string } | null>(null);
  const [undone, setUndone] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  const [error, setError] = useState<{ id: string; msg: string } | null>(null);
  const [showInst, setShowInst] = useState(false);
  const go = async () => {
    setBusy("Reading the sheet with your AI model…"); setError(null); setRun(null); setUndone({ busy: false, note: null });
    const runId = newRunId();
    try {
      const r = await readDrawing(orgId, { documentId }, (p, n) => setBusy(n > 1 ? `Reading page ${p} of ${n}…` : "Reading the sheet with your AI model…"), { runId, runLabel: "Read one drawing with AI" });
      setRun({ id: documentId, r, runId });
      onDone?.();
    } catch (e) { setError({ id: documentId, msg: (e as Error).message }); }
    finally { setBusy(null); }
  };
  const r = run?.id === documentId ? run.r : null;
  const err = error?.id === documentId ? error.msg : null;
  return (
    <div className="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs space-y-1.5">
      <div className="flex items-center gap-2">
        <button onClick={() => void go()} disabled={!!busy} className="rounded-md bg-violet-600 text-white px-2 py-1 font-bold inline-flex items-center gap-1 disabled:opacity-60">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} {r ? "Read again with AI" : "Read with AI"}
        </button>
        <span className="text-[11px] text-[var(--color-text-muted)]">{busy ?? "Your model reads the sheet in zoomed tiles and fixes its equipment tags."}</span>
      </div>
      {err && <div className="text-red-700">{err}</div>}
      {r && (
        <>
          <div>
            <div className="font-bold inline-flex items-center gap-1"><Cpu className="w-3.5 h-3.5 text-emerald-600" /> {r.equipment.length} equipment on this sheet</div>
            <ul className="mt-0.5 space-y-0.5">
              {r.equipment.map((e) => (
                <li key={e.tag}><span className="font-mono font-bold">{e.tag}</span>{e.code ? <span className="text-[var(--color-text-muted)]"> ({e.code})</span> : null}{e.name ? <span className="text-[var(--color-text-muted)]"> · {e.name}</span> : null}</li>
              ))}
            </ul>
          </div>
          <div>
            <button onClick={() => setShowInst((v) => !v)} className="font-bold inline-flex items-center gap-1 hover:underline"><Gauge className="w-3.5 h-3.5 text-sky-600" /> {r.instruments.length} instruments</button>
            {showInst && <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-muted)]">{r.instruments.join("  ")}</div>}
          </div>
          {r.offSheet.length > 0 && (
            <div className="text-[11px] text-[var(--color-text-muted)] inline-flex items-start gap-1"><ArrowRightLeft className="w-3.5 h-3.5 mt-px shrink-0" /> On other sheets, named only by an arrow here: <span className="font-mono">{r.offSheet.map((o) => o.tag).join(", ")}</span></div>
          )}
          {r.correction && (
            <div className="border-t border-[var(--color-border)] pt-1.5 space-y-0.5">
              {r.correction.removed.length > 0 && <div className="inline-flex items-start gap-1 text-red-700"><XCircle className="w-3.5 h-3.5 mt-px shrink-0" /> Taken off this drawing (not on the sheet): <span className="font-mono">{r.correction.removed.join(", ")}</span></div>}
              {r.correction.added.length > 0 && <div className="inline-flex items-start gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5 mt-px shrink-0" /> Put on this drawing: <span className="font-mono">{r.correction.added.join(", ")}</span>{r.correction.createdAssets ? ` · ${r.correction.createdAssets} new in the registry` : ""}</div>}
              {!r.correction.removed.length && !r.correction.added.length && <div className="text-[var(--color-text-muted)]">The drawing&apos;s equipment tags already matched the sheet.</div>}
              {r.correction.described > 0 && <div className="text-[var(--color-text-muted)]">{r.correction.described} registry item{r.correction.described === 1 ? "" : "s"} given the name and design data printed in their callout.</div>}
            </div>
          )}
          <div className="border-t border-[var(--color-border)] pt-1.5">
            {!r.journaled
              ? <span className="text-[11px] text-amber-700">Undo is not available: apply migration 20261021_ai_boundary_runs.sql to record reads.</span>
              : undone.note
                ? <span className="text-[11px] text-emerald-700">{undone.note}</span>
                : <button disabled={undone.busy} onClick={() => {
                    if (!run || !window.confirm("Undo this read? The drawing's tags, links and reading go back to how they were.")) return;
                    setUndone({ busy: true, note: null });
                    void undoRun(orgId, run.runId)
                      .then((u) => { setUndone({ busy: false, note: `Undone: ${u.columnsRestored} column, ${u.edgesRestored + u.edgesRemoved} links, ${u.readingsRestored} readings put back, ${u.assetsRemoved} registry items removed.` }); onDone?.(); })
                      .catch((e) => setUndone({ busy: false, note: (e as Error).message }));
                  }} className="rounded-full border border-rose-300 bg-rose-50 text-rose-700 px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50">Undo this read</button>}
          </div>
        </>
      )}
    </div>
  );
}
