"use client";

// GraphLensBar — the lenses, and the views a person names and saves.
//
// GPV-10: every lens is named for what it SHOWS and produces exactly that
// (lib/graphSettings.ts GRAPH_LENSES); the row is a select below 640px so a
// phone has the control too; a filter tuned by hand still says which lens it
// is a variation of ("≈ Plant (units & equipment) — adjusted"), and a lens
// tap that would throw a hand-tuned filter away can be undone.
// GPV-11 / GAP-306: a view — the filter, the scope and the focus depth — can
// be named and saved (per org, in this browser), and its link copied: the
// URL reproduces the view.

import React from "react";
import { Bookmark, Copy, Undo2, X, Check } from "lucide-react";
import {
  GRAPH_LENSES, matchLens, type GraphLens, type GraphSettings, type SavedGraphView,
} from "@/lib/graphSettings";

export interface GraphLensBarProps {
  settings: Pick<GraphSettings, "hiddenTypes" | "showLibraryEdges" | "savedViews">;
  onLens: (lens: GraphLens) => void;
  /** Set when the last lens tap replaced a hand-tuned filter. */
  canUndo: boolean;
  onUndo: () => void;
  onApplyView: (view: SavedGraphView) => void;
  onSaveView: (name: string) => void;
  onDeleteView: (id: string) => void;
  /** Copies the current URL; resolves false when the clipboard refused. */
  onCopyLink: () => Promise<boolean>;
}

export default function GraphLensBar({
  settings, onLens, canUndo, onUndo, onApplyView, onSaveView, onDeleteView, onCopyLink,
}: GraphLensBarProps) {
  const match = matchLens(settings.hiddenTypes, settings.showLibraryEdges);
  const [viewsOpen, setViewsOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [copied, setCopied] = React.useState<"ok" | "failed" | null>(null);

  const near = match.lens && !match.exact ? match.lens : null;
  const selectValue = match.exact && match.lens ? match.lens.key : "__custom";

  return (
    <>
      {/* Phones: the same lenses as a select (GPV-10). */}
      <select
        aria-label="Lens"
        value={selectValue}
        onChange={(e) => {
          const l = GRAPH_LENSES.find((x) => x.key === e.target.value);
          if (l) onLens(l);
        }}
        className="sm:hidden px-2 py-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[10px] font-black text-[var(--color-text)] max-w-[11rem]"
      >
        {!(match.exact && match.lens) && (
          <option value="__custom" disabled>
            {near ? `≈ ${near.label} — adjusted` : "Your own filter"}
          </option>
        )}
        {GRAPH_LENSES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
      </select>

      {/* Pivot the whole map with one tap. */}
      <div role="group" aria-label="Lenses"
        className="hidden sm:flex items-center rounded-full border border-[var(--color-border-strong)] overflow-hidden">
        {GRAPH_LENSES.map((l) => {
          const active = match.exact && match.lens?.key === l.key;
          const drifted = near?.key === l.key;
          return (
            <button key={l.key}
              title={drifted ? `${l.title} — your filter is a variation of this lens (adjusted in Settings); tap to apply it exactly.` : l.title}
              aria-pressed={active}
              onClick={() => onLens(l)}
              className={`px-2.5 py-1.5 text-[10px] font-black transition-colors ${active
                ? "bg-violet-600 text-white"
                : drifted
                  ? "text-violet-700 bg-violet-50 dark:bg-violet-950/40 underline decoration-dashed underline-offset-2"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
              {drifted ? `≈ ${l.label}` : l.label}
            </button>
          );
        })}
      </div>

      {canUndo && (
        <button onClick={onUndo} title="Put back the filter you had before that lens"
          className="inline-flex items-center gap-1 px-2 py-1.5 rounded-full border border-amber-300 bg-amber-50 dark:bg-amber-950/40 text-[10px] font-black text-amber-800 dark:text-amber-200">
          <Undo2 className="w-3 h-3" /> Back to your filter
        </button>
      )}

      <div className="relative">
        <button onClick={() => setViewsOpen((v) => !v)} aria-expanded={viewsOpen}
          title="Saved views — name this view to come back to it, or copy its link"
          className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-full border text-[10px] font-black ${
            viewsOpen ? "border-violet-400 text-violet-700" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"
          }`}>
          <Bookmark className="w-3.5 h-3.5" /> Views{settings.savedViews.length > 0 ? ` · ${settings.savedViews.length}` : ""}
        </button>
        {viewsOpen && (
          <div role="dialog" aria-label="Saved views"
            className="absolute left-0 top-full mt-1 w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl p-2 space-y-2 z-30">
            {settings.savedViews.length === 0 ? (
              <div className="text-[10px] text-[var(--color-text-faint)]">No saved views yet. Name this one below.</div>
            ) : (
              <div className="space-y-0.5">
                {settings.savedViews.map((v) => (
                  <div key={v.id} className="flex items-center gap-1">
                    <button onClick={() => { onApplyView(v); setViewsOpen(false); }}
                      className="flex-1 min-w-0 text-left px-1.5 py-1 rounded-lg hover:bg-[var(--color-surface-2)] text-[11px] font-bold text-[var(--color-text)] truncate">
                      {v.name}
                      {v.scope && <span className="ml-1 text-[9px] font-normal text-[var(--color-text-faint)]">unit {v.scope.code}</span>}
                    </button>
                    <button onClick={() => onDeleteView(v.id)} aria-label={`Delete saved view ${v.name}`}
                      className="p-0.5 text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
            )}
            <form className="flex items-center gap-1"
              onSubmit={(e) => { e.preventDefault(); const n = name.trim(); if (n) { onSaveView(n); setName(""); } }}>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
                placeholder="Name this view…" aria-label="Name for this view"
                className="flex-1 min-w-0 px-2 py-1 border border-[var(--color-border-strong)] rounded-lg text-[11px] bg-[var(--color-surface)]" />
              <button type="submit" disabled={!name.trim()}
                className="px-2 py-1 rounded-lg bg-violet-600 text-white text-[10px] font-black disabled:opacity-40">Save</button>
            </form>
            <button
              onClick={() => { void onCopyLink().then((ok) => { setCopied(ok ? "ok" : "failed"); setTimeout(() => setCopied(null), 2500); }); }}
              className="w-full inline-flex items-center justify-center gap-1 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border-strong)] rounded-lg py-1">
              {copied === "ok" ? <><Check className="w-3 h-3" /> Link copied</>
                : copied === "failed" ? "Couldn't copy — the address bar holds this view's link"
                : <><Copy className="w-3 h-3" /> Copy a link to this view</>}
            </button>
            <div className="text-[9px] text-[var(--color-text-faint)] leading-snug">
              Saved views stay in this browser. The link carries the lens, focus, scope and search — anyone who opens it sees this view, within what they may read.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
