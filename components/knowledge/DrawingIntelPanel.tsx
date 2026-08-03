"use client";

// Drawing intelligence — the deterministic panel under a P&ID/drawing
// library. Everything here is COMPUTED from extracted tags, never guessed
// by a model: the equipment census by category, the drawing-reference audit
// (what resolves in-library vs what's referenced but missing), the CSV
// register export, and the "give me X and I can do more" suggestions.

import React, { useEffect, useState } from "react";
import {
  DraftingCompass, Loader2, Download, RefreshCw, ChevronDown, ChevronRight,
  Lightbulb, AlertTriangle, Eye, FileText, Stethoscope, Link2, ArrowRight,
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
  const [showScope, setShowScope] = useState(false);
  const [showOneWay, setShowOneWay] = useState(false);
  const [showOpc, setShowOpc] = useState(false);
  const [showSheets, setShowSheets] = useState(false);

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
  // No tags and no refs = not a drawing set; the panel stays neutral (it's
  // probably a scanned prose library that needs vision indexing).
  const isDrawingSet = census.totalDistinct > 0 || audit.totalRefs > 0;
  const outOfScopeRefs = audit.outOfScope.reduce((a, o) => a + o.count, 0);

  const rebuild = async () => {
    const ok = await appConfirm({
      title: "Rebuild the index?",
      message:
        "Every document re-reads from scratch — text, tags, and titles. Do this once after " +
        "upgrading, or when indexing missed things. Indexing runs on this page; keep it open.",
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
            <div className="text-xs font-black text-[var(--color-text)]">
              {isDrawingSet ? "Drawing intelligence" : "Library health"}
            </div>
            <div className="text-[10px] text-[var(--color-text-muted)]">
              {isDrawingSet
                ? "Computed from every sheet's extracted tags — counts you can trust, not AI guesses."
                : "What indexing actually got out of these documents."}
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
            {audit.missingInSeries.length > 0 && (
              <span className="text-rose-600 font-bold">{audit.missingInSeries.length} sheets missing from this set</span>
            )}
            {outOfScopeRefs > 0 && (
              <span title={audit.outOfScope.map((o) => `${o.series} ×${o.count}`).join(", ")}>
                <b className="text-[var(--color-text)]">{outOfScopeRefs}</b> point to other units
              </span>
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

      {/* ── Gaps in the set you loaded — the actionable bucket ─────────── */}
      {audit.missingInSeries.length > 0 && (
        <div className="mb-2">
          <button onClick={() => setShowMissing((s) => !s)}
            className="inline-flex items-center gap-1 text-[11px] font-black text-rose-600 hover:underline">
            {showMissing ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <AlertTriangle className="w-3.5 h-3.5" />
            {audit.missingInSeries.length} sheet(s) in this set are referenced but not loaded
          </button>
          {showMissing && (
            <ul className="mt-1.5 rounded-xl border border-rose-200 dark:border-rose-900 divide-y divide-rose-100 dark:divide-rose-900/50 overflow-hidden">
              {audit.missingInSeries.slice(0, 25).map((m) => (
                <li key={m.ref} className="px-3 py-1.5 text-[11px] flex items-start gap-2">
                  <span className="font-mono font-black text-[var(--color-text)] shrink-0">{m.ref}</span>
                  <span className="text-[var(--color-text-muted)]">
                    referenced {m.count}× by {m.referencedBy.join("; ")}
                  </span>
                </li>
              ))}
              {audit.missingInSeries.length > 25 && (
                <li className="px-3 py-1.5 text-[11px] italic text-[var(--color-text-muted)]">
                  …and {audit.missingInSeries.length - 25} more
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* ── Battery limits — expected, and explicitly NOT broken ───────── */}
      {audit.outOfScope.length > 0 && (
        <div className="mb-2">
          <button onClick={() => setShowScope((s) => !s)}
            className="inline-flex items-center gap-1 text-[11px] font-black text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            {showScope ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Link2 className="w-3.5 h-3.5" />
            {outOfScopeRefs} connector(s) leave this set for {audit.outOfScope.length} other series
          </button>
          {showScope && (
            <div className="mt-1.5 rounded-xl border border-[var(--color-border)] overflow-hidden">
              <p className="px-3 py-2 text-[10px] text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                These are <b>not broken</b>. This set ends at its battery limits and those units
                weren&apos;t loaded. Add the sheets in a series below and its connectors join the audit —
                the widened set will then have its own outward connectors, which is normal.
              </p>
              <ul className="divide-y divide-[var(--color-border)] max-h-48 overflow-y-auto">
                {audit.outOfScope.slice(0, 20).map((o) => (
                  <li key={o.series} className="px-3 py-1.5 text-[11px] flex items-start gap-2">
                    <span className="shrink-0 w-36 min-w-0">
                      <span className="block font-mono font-black text-[var(--color-text)] truncate" title={o.series}>{o.series}</span>
                      {o.unitName && (
                        <span className="block text-[10px] text-sky-700 dark:text-sky-400 truncate" title={o.unitName}>{o.unitName}</span>
                      )}
                    </span>
                    <span className="text-[var(--color-text-muted)] flex-1 truncate" title={o.refs.join(", ")}>
                      {o.refs.slice(0, 6).join(", ")}{o.refs.length > 6 ? ` …+${o.refs.length - 6}` : ""}
                    </span>
                    <span className="shrink-0 tabular-nums font-bold text-[var(--color-text)]">{o.count}×</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── One-way links between sheets that are BOTH here ────────────── */}
      {audit.oneWay.length > 0 && (
        <div className="mb-2">
          <button onClick={() => setShowOneWay((s) => !s)}
            className="inline-flex items-center gap-1 text-[11px] font-black text-amber-600 hover:underline">
            {showOneWay ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <AlertTriangle className="w-3.5 h-3.5" />
            {audit.oneWay.length} one-way connector(s) inside this set
          </button>
          {showOneWay && (
            <div className="mt-1.5 rounded-xl border border-amber-300 dark:border-amber-800 overflow-hidden">
              <p className="px-3 py-2 text-[10px] text-amber-900 dark:text-amber-200 border-b border-amber-200 dark:border-amber-900">
                Both sheets are loaded, but the reference only runs one way. Continuation notes are
                sometimes legitimately one-way — this is where genuine drafting misses hide.
              </p>
              <ul className="divide-y divide-[var(--color-border)] max-h-48 overflow-y-auto">
                {audit.oneWay.slice(0, 25).map((o, i) => (
                  <li key={i} className="px-3 py-1.5 text-[11px] flex items-center gap-2">
                    <span className="font-bold text-[var(--color-text)] truncate flex-1" title={o.from}>{o.from}</span>
                    <ArrowRight className="w-3 h-3 shrink-0 text-amber-600" />
                    <span className="font-bold text-[var(--color-text)] truncate flex-1" title={o.to}>{o.to}</span>
                    <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{o.count}×</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── Connector boxes that never come back ───────────────────────── */}
      {(intel.opcUnreturned?.length ?? 0) > 0 && (
        <div className="mb-2">
          <button onClick={() => setShowOpc((s) => !s)}
            className="inline-flex items-center gap-1 text-[11px] font-black text-amber-600 hover:underline">
            {showOpc ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <AlertTriangle className="w-3.5 h-3.5" />
            {intel.opcUnreturned!.length} connector box(es) missing on their continuation sheet
          </button>
          {showOpc && (
            <div className="mt-1.5 rounded-xl border border-amber-300 dark:border-amber-800 overflow-hidden">
              <p className="px-3 py-2 text-[10px] text-amber-900 dark:text-amber-200 border-b border-amber-200 dark:border-amber-900">
                The numbered box at the page edge should reappear on the sheet it points to — that
                number is how connectors pair, verified by stream name and equipment. These didn&apos;t.
                Best-effort: box numbers come from AI-read sheets, so a missed transcription can show
                up here too.
              </p>
              <ul className="divide-y divide-[var(--color-border)] max-h-48 overflow-y-auto">
                {intel.opcUnreturned!.map((o, i) => (
                  <li key={i} className="px-3 py-1.5 text-[11px] flex items-start gap-2">
                    <span className="shrink-0 font-mono font-black text-[var(--color-text)] px-1.5 rounded border border-[var(--color-border)]">{o.box}</span>
                    <span className="min-w-0 text-[var(--color-text-muted)]">
                      <span className="font-bold text-[var(--color-text)]">{o.from}</span>
                      {" → "}
                      <span className="font-bold text-[var(--color-text)]">{o.to}</span>
                      <span className="block truncate" title={o.line}>{o.line}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── Per-sheet readout: facts, not theories ─────────────────────── */}
      {(intel.sheets?.length ?? 0) > 0 && (
        <div className="mb-2">
          <button onClick={() => setShowSheets((s) => !s)}
            className="inline-flex items-center gap-1 text-[11px] font-black text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            {showSheets ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Stethoscope className="w-3.5 h-3.5" />
            What each document produced ({intel.sheets!.length})
          </button>
          {showSheets && (
            <div className="mt-1.5 rounded-xl border border-[var(--color-border)] overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 px-3 py-1.5 bg-[var(--color-surface-2)] text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                <span>Document</span><span className="text-right">Pages</span>
                <span className="text-right">Text</span><span className="text-right">Tags</span>
                <span className="text-right">How read</span>
              </div>
              <ul className="divide-y divide-[var(--color-border)] max-h-64 overflow-y-auto">
                {intel.sheets!.map((s) => {
                  const badge =
                    s.verdict === "vision" ? { label: "AI vision", cls: "text-sky-700 dark:text-sky-400", Icon: Eye }
                    : s.verdict === "text" ? { label: "Text layer", cls: "text-emerald-700 dark:text-emerald-400", Icon: FileText }
                    : s.verdict === "text-no-tags" ? { label: "Text, no tags", cls: "text-amber-600", Icon: AlertTriangle }
                    : s.verdict === "empty" ? { label: "Nothing read", cls: "text-rose-600", Icon: AlertTriangle }
                    : s.verdict === "error" ? { label: "Error", cls: "text-rose-600", Icon: AlertTriangle }
                    : { label: "Indexing…", cls: "text-[var(--color-text-muted)]", Icon: Loader2 };
                  const B = badge.Icon;
                  return (
                    <li key={s.id} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 px-3 py-1.5 text-[11px] items-center">
                      <span className="min-w-0">
                        <span className="block truncate font-bold text-[var(--color-text)]" title={s.error ?? s.name}>{s.name}</span>
                        {s.declared && (
                          <span className="block truncate font-mono text-[9px] text-[var(--color-text-muted)]"
                            title="Read from this sheet's own title block">
                            ≡ {s.declared}
                          </span>
                        )}
                      </span>
                      <span className="text-right tabular-nums text-[var(--color-text-muted)]">
                        {s.pagesIndexed}{s.pages ? `/${s.pages}` : ""}
                      </span>
                      <span className="text-right tabular-nums text-[var(--color-text-muted)]">
                        {s.chars >= 1000 ? `${Math.round(s.chars / 1000)}k` : s.chars}
                      </span>
                      <span className={`text-right tabular-nums font-black ${s.tags > 0 ? "text-[var(--color-text)]" : "text-rose-600"}`}>
                        {s.tags}
                      </span>
                      <span className={`text-right inline-flex items-center justify-end gap-1 font-black ${badge.cls}`}>
                        <B className="w-3 h-3" /> {badge.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="px-3 py-2 text-[10px] text-[var(--color-text-muted)] border-t border-[var(--color-border)]">
                <b>Text, no tags</b> on an AutoCAD export usually means SHX fonts — the title block extracts,
                the tags plot as line-work. Turn on <b>Index every page with AI vision</b> in Library AI setup
                and rebuild; those sheets flip to <b>AI vision</b> and their tags appear.
              </p>
            </div>
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
