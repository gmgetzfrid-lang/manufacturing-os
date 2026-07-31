"use client";

// Drawing intelligence — the deterministic panel under a P&ID/drawing
// library. Everything here is COMPUTED from extracted tags, never guessed
// by a model: the equipment census by category, the drawing-reference audit
// (what resolves in-library vs what's referenced but missing), the CSV
// register export, and the "give me X and I can do more" suggestions.

import React, { useEffect, useState } from "react";
import {
  DraftingCompass, Loader2, Download, RefreshCw, ChevronDown, ChevronRight,
  Lightbulb, AlertTriangle,
} from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { appConfirm } from "@/components/providers/DialogProvider";
import { Button } from "@/components/ui/Button";
import {
  getDrawingIntel, rebuildDrawingIndex, downloadEquipmentRegister,
  type DrawingIntel,
} from "@/lib/knowledge";

export default function DrawingIntelPanel({ orgId, libraryId, isController, refreshKey, onRebuilt }: {
  orgId: string;
  libraryId: string;
  isController: boolean;
  /** Bump when documents finish indexing so the panel refetches. */
  refreshKey: number;
  onRebuilt: () => void;
}) {
  const { showToast } = useToast();
  const [intel, setIntel] = useState<DrawingIntel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"rebuild" | "export" | null>(null);
  const [showMissing, setShowMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDrawingIntel(orgId, libraryId)
      .then((i) => { if (!cancelled) { setIntel(i); setLoadError(null); } })
      .catch((e) => { if (!cancelled) setLoadError((e as Error).message); });
    return () => { cancelled = true; };
  }, [orgId, libraryId, refreshKey]);

  // A missing migration must be VISIBLE, not a silently absent panel —
  // otherwise "why is there no census" is undiagnosable from the UI.
  if (loadError) {
    if (!/migration/i.test(loadError)) return null;
    return (
      <div className="mt-4 rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-4 py-3 text-[11px] text-amber-900 dark:text-amber-200 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
        <span><b>Drawing intelligence is waiting on a database migration:</b> {loadError}</span>
      </div>
    );
  }
  if (!intel) return null;
  const { census, audit, suggestions } = intel;
  // Nothing extracted and nothing to suggest = not a drawing library; stay out
  // of the way.
  if (census.totalDistinct === 0 && audit.totalRefs === 0 && suggestions.length === 0) return null;

  const rebuild = async () => {
    const ok = await appConfirm({
      title: "Rebuild the index?",
      message:
        "Every document re-reads from scratch — text chunks AND drawing tags. Do this once after " +
        "upgrading (documents indexed before drawing intelligence existed have no tags yet). " +
        "Indexing runs on this page; keep it open.",
      confirmLabel: "Rebuild",
    });
    if (!ok) return;
    setBusy("rebuild");
    try {
      const res = await rebuildDrawingIndex(orgId, libraryId);
      showToast({ type: "success", title: `${res.docs} document(s) queued — indexing starts now.` });
      onRebuilt();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const exportCsv = async () => {
    setBusy("export");
    try {
      await downloadEquipmentRegister(orgId, libraryId);
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  return (
    <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center">
            <DraftingCompass className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-xs font-black text-[var(--color-text)]">Drawing intelligence</div>
            <div className="text-[10px] text-[var(--color-text-muted)]">
              Computed from every sheet&apos;s extracted tags — counts you can trust, not AI guesses.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {census.totalDistinct > 0 && (
            <Button size="sm" variant="secondary" onClick={() => void exportCsv()} disabled={busy !== null}>
              {busy === "export" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Equipment register (CSV)
            </Button>
          )}
          {isController && (
            <Button size="sm" variant="secondary" onClick={() => void rebuild()} disabled={busy !== null}>
              {busy === "rebuild" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Rebuild index
            </Button>
          )}
        </div>
      </div>

      {census.totalDistinct > 0 && (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-text-muted)] mb-2">
            <span><b className="text-[var(--color-text)]">{intel.sheetCount}</b> sheets</span>
            <span><b className="text-[var(--color-text)]">{census.totalDistinct}</b> distinct equipment tags</span>
            <span><b className="text-[var(--color-text)]">{audit.resolved}</b> cross-refs resolve in-library</span>
            {audit.missing.length > 0 && (
              <span className="text-rose-600 font-bold">{audit.missing.length} referenced sheets missing</span>
            )}
          </div>
          <div className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden mb-2">
            {census.categories.slice(0, 10).map((c) => (
              <div key={c.prefix} className="px-3 py-1.5 flex items-center gap-2 text-[11px]">
                <span className="w-10 shrink-0 font-mono font-black text-orange-600">{c.prefix}-</span>
                <span className={`flex-1 font-bold ${c.known ? "text-[var(--color-text)]" : "text-amber-600"}`}>
                  {c.label}
                </span>
                <span className="text-[var(--color-text-muted)]" title={c.sample.join(", ")}>
                  {c.sample.slice(0, 3).join(", ")}{c.distinctTags > 3 ? "…" : ""}
                </span>
                <span className="w-10 text-right font-black text-[var(--color-text)] tabular-nums">{c.distinctTags}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {audit.missing.length > 0 && (
        <div className="mb-2">
          <button onClick={() => setShowMissing((s) => !s)}
            className="inline-flex items-center gap-1 text-[11px] font-black text-rose-600 hover:underline">
            {showMissing ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <AlertTriangle className="w-3.5 h-3.5" />
            {audit.missing.length} drawing number(s) referenced but not in this library
          </button>
          {showMissing && (
            <ul className="mt-1.5 rounded-xl border border-rose-200 dark:border-rose-900 divide-y divide-rose-100 dark:divide-rose-900/50 overflow-hidden">
              {audit.missing.slice(0, 25).map((m) => (
                <li key={m.ref} className="px-3 py-1.5 text-[11px] flex items-start gap-2">
                  <span className="font-mono font-black text-[var(--color-text)] shrink-0">{m.ref}</span>
                  <span className="text-[var(--color-text-muted)]">
                    referenced {m.count}× by {m.referencedBy.join("; ")}
                  </span>
                </li>
              ))}
              {audit.missing.length > 25 && (
                <li className="px-3 py-1.5 text-[11px] italic text-[var(--color-text-muted)]">
                  …and {audit.missing.length - 25} more
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {suggestions.map((s, i) => (
        <div key={i} className="mt-1.5 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200 flex items-start gap-2">
          <Lightbulb className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600" />
          <span>{s}</span>
        </div>
      ))}
    </div>
  );
}
