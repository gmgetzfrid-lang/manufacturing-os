"use client";

// components/documents/RunsPanel.tsx — the AI runs that changed drawings,
// newest first, each with Undo. Admin and Doc Control.

import React, { useEffect, useState } from "react";
import { History, Loader2, Undo2 } from "lucide-react";
import { estatePost } from "@/lib/estate/client";
import { undoRun } from "@/lib/drawingCensusClient";
import type { RunSummary } from "@/lib/estate/runJournal";

export default function RunsPanel({ orgId, onUndone }: { orgId: string; onUndone?: () => void }) {
  const [state, setState] = useState<{ runs: RunSummary[]; available: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    estatePost<{ runs: RunSummary[]; available: boolean }>("/api/estate/runs", { orgId, action: "list" })
      .then((r) => { if (alive) setState(r); }).catch(() => { if (alive) setState({ runs: [], available: false }); });
    return () => { alive = false; };
  }, [orgId, tick]);
  if (!state) return null;
  if (!state.available) return <div className="text-[11px] text-amber-700">AI runs are not recorded yet, so they cannot be undone. Apply migration 20261021_ai_boundary_runs.sql.</div>;
  if (!state.runs.length) return null;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-2.5 space-y-1.5">
      <div className="text-[11px] font-black uppercase tracking-wide text-[var(--color-text-muted)] inline-flex items-center gap-1"><History className="w-3 h-3" /> AI runs on drawings</div>
      {note && <div className="text-[11px] text-emerald-700">{note}</div>}
      <ul className="space-y-1">
        {state.runs.map((r) => (
          <li key={r.runId} className="flex items-center gap-2 text-xs">
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate">{r.label ?? "AI run"}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">{new Date(r.at).toLocaleString()} · {r.by ?? "someone"} · {r.drawings} drawing{r.drawings === 1 ? "" : "s"} changed</div>
            </div>
            {r.undone
              ? <span className="text-[11px] text-[var(--color-text-muted)]">undone</span>
              : <button disabled={!!busy} onClick={() => {
                  if (!window.confirm(`Undo "${r.label ?? "this run"}"? Equipment columns, links and readings go back to how they were before it. Registry items it created are removed unless someone has since added to them. Anything a person changed later is left alone.`)) return;
                  setBusy(r.runId);
                  void undoRun(orgId, r.runId)
                    .then((u) => { setNote(`Undone: ${u.drawings} drawings put back, ${u.assetsRemoved} registry items removed${u.skipped.length ? `, ${u.skipped.length} left as a person changed them since` : ""}.`); setTick((t) => t + 1); onUndone?.(); })
                    .catch((e) => setNote((e as Error).message))
                    .finally(() => setBusy(null));
                }} className="shrink-0 rounded-full border border-rose-300 bg-rose-50 text-rose-700 px-2 py-0.5 text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-50">
                  {busy === r.runId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />} Undo
                </button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
