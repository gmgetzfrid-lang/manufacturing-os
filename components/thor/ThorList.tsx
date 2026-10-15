"use client";

// components/thor/ThorList.tsx — THOR results in the finder's left panel.
//
//   ThorHitCard     — one file: name, where it is, and WHY it came up (each
//                     word and where it hit, what was required, what it lacks)
//   ThorResultList  — the ranked list, strong / partial / weak, loading the
//                     next page before the end is reached

import React, { useEffect, useRef } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { FileTypeIcon } from "@/components/documents/fileGraphIcons";
import { fileTypeOf } from "@/lib/fileFinder/fileTypes";
import { countLabel, formatBytes, type ThorQuery } from "@/lib/thor/query";
import { explainThor, STRENGTH_LABEL } from "@/lib/thor/explain";
import type { ThorFile, ThorVocabulary } from "@/lib/thor/client";
import type { ThorSearchState } from "@/hooks/useThorSearch";
import { fmtDate, ThorLocation, ReasonChips } from "./ThorResults";

const STRENGTH_STYLE = [
  "bg-slate-100 text-slate-600 border-slate-200",
  "bg-yellow-100 text-yellow-800 border-yellow-200",
  "bg-green-100 text-green-800 border-green-200",
];

export function ThorHitCard({ f, rank, q, vocab, resolved, active, onSelect, onOpen }: {
  f: ThorFile; rank: number; q: ThorQuery | null; vocab: ThorVocabulary | null; resolved: string[] | null;
  active: boolean; onSelect: () => void; onOpen: () => void;
}) {
  const words = q?.terms.length ?? 0;
  return (
    <div className={`rounded-lg border p-2.5 ${active ? "border-teal-500 bg-teal-50/50" : "border-teal-200/70 bg-[var(--color-canvas)]"}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 96px" }}>
      <div className="flex items-start gap-2">
        <button onClick={onSelect} onDoubleClick={onOpen} className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`shrink-0 w-5 h-5 rounded-full grid place-items-center text-[10px] font-extrabold text-white ${active ? "bg-teal-600" : "bg-teal-800"}`}>{rank}</span>
            {words > 0 && <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold ${STRENGTH_STYLE[f.strength] ?? STRENGTH_STYLE[0]}`}>{STRENGTH_LABEL[f.strength] ?? "Weak"}</span>}
            <FileTypeIcon type={fileTypeOf(f.filename)} className="w-4 h-4 shrink-0" />
            <span className="text-sm font-semibold truncate" title={f.filename}>{f.filename}</span>
          </div>
          <ThorLocation f={f} oneLine />
          <div className="text-[10px] text-[var(--color-text-muted)]">{fmtDate(f.modified_at)} · {formatBytes(f.size_bytes)}</div>
        </button>
        <button onClick={onOpen} className="shrink-0 rounded-md border border-[var(--color-border)] p-1 hover:bg-[var(--color-surface)]" title="Open the file">
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>
      <ReasonChips reasons={explainThor(f, q, vocab, resolved)} />
    </div>
  );
}

export function ThorResultList({ search, q, vocab, selectedId, onSelect, onOpen, onTable }: {
  search: ThorSearchState; q: ThorQuery | null; vocab: ThorVocabulary | null;
  selectedId: string | null; onSelect: (f: ThorFile) => void; onOpen: (f: ThorFile) => void; onTable: () => void;
}) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const { more } = search;
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { rootMargin: "1200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, search.rows.length]);

  if (search.searching) return <div className="text-[11px] text-[var(--color-text-muted)] inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Searching THOR…</div>;
  if (search.error) return <div className="text-[11px] text-red-700">THOR: {search.error}</div>;
  const words = q?.terms.length ?? 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        <span className="flex-1">
          {words > 0
            ? <><b className="text-[var(--color-text)]">{countLabel(search.full, search.fullCapped)}</b> hold every word · {countLabel(search.total, search.capped)} qualify</>
            : <><b className="text-[var(--color-text)]">{countLabel(search.total, search.capped)}</b> files</>}
          {search.tookMs != null && ` · ${search.tookMs} ms`}
        </span>
        <button onClick={onTable} className="font-semibold text-teal-800 hover:underline" title="All columns, sortable, across the map">Table view</button>
      </div>
      {search.rows.length === 0 && <div className="text-sm text-[var(--color-text-muted)]">Nothing on THOR matches. Try fewer words, or drop a filter.</div>}
      {search.rows.map((f, i) => (
        <React.Fragment key={f.file_id}>
          {words > 0 && i > 0 && f.strength < search.rows[i - 1].strength && (
            <div className="pt-1 text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{STRENGTH_LABEL[f.strength]} matches</div>
          )}
          <ThorHitCard f={f} rank={i + 1} q={q} vocab={vocab} resolved={search.resolvedEquipment}
            active={selectedId === f.file_id} onSelect={() => onSelect(f)} onOpen={() => onOpen(f)} />
        </React.Fragment>
      ))}
      <div ref={sentinel} className="h-6 grid place-items-center text-[11px] text-[var(--color-text-muted)]">
        {search.loading && !search.searching ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> More…</span> : search.done && search.rows.length > 0 ? "End of THOR results" : null}
      </div>
    </div>
  );
}
