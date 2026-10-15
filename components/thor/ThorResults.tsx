"use client";

// components/thor/ThorResults.tsx — THOR results in the finder.
//
//   ThorResultsTable — the wide, Explorer-like list that takes the map's place
//                      when the source is THOR: sortable columns, endless
//                      scroll a page ahead of the reader.
//   ThorHitList      — a short list under the system's own results ("also on
//                      THOR"), or in their place when the system has nothing.
//   ThorFileCard     — one file: where it is (exact UNC path kept), what the
//                      indexer linked it to and how sure it was, and Open.
//   ThorViewerLayer  — the original, read locally, shown in place.

import React, { Suspense, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronRight, Copy, ExternalLink, FolderOpen, HardDrive, Loader2, X, Check, Info, Eye, FolderSearch } from "lucide-react";
import { FileTypeIcon } from "@/components/documents/fileGraphIcons";
import { fileTypeOf } from "@/lib/fileFinder/fileTypes";
import { countLabel, formatBytes, unitName, type ThorSort } from "@/lib/thor/query";
import { thorFileDetail, type ThorFile, type ThorFileDetail } from "@/lib/thor/client";
import type { ThorSearchState } from "@/hooks/useThorSearch";
import { copyText, type ThorOpener } from "./useThorOpener";
import OpenerSetup, { FolderSetup } from "./OpenerSetup";
import { explainThor, type ThorReason } from "@/lib/thor/explain";
import { launchWatched, openerInstalled, thorOpenUrl } from "@/lib/thor/opener";
import { viewKind } from "@/lib/thor/nasAccess";
import type { ThorQuery } from "@/lib/thor/query";
import type { ThorVocabulary } from "@/lib/thor/client";

const FullScreenViewer = React.lazy(() => import("@/components/viewers/FullScreenViewer"));

export const THOR_BADGE = "rounded border border-teal-300 bg-teal-50 text-teal-800 px-1 text-[10px] font-bold";

const ROLE_LABEL: Record<string, string> = {
  inspection: "Inspection", drawings: "Drawings", p_and_id: "P&ID", datasheets: "Datasheets", calculations: "Calculations",
  code_documents: "Code documents", archive: "Archive", equipment_folder: "Equipment folder", equipment_category: "Equipment category",
};

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "Equipment Files › Crude Unit › 10 - VESSELS › …" — short to read; the UNC path is kept in full elsewhere. */
export function ThorLocation({ f, root = "Equipment Files", max = 4, oneLine = false }: { f: Pick<ThorFile, "folder_rel">; root?: string; max?: number; oneLine?: boolean }) {
  const segs = f.folder_rel ? f.folder_rel.split("/") : [];
  const shown = segs.length > max ? [...segs.slice(0, 2), "…", ...segs.slice(-(max - 2))] : segs;
  if (oneLine) {
    return (
      <div className="text-[11px] text-[var(--color-text-muted)] truncate" title={[root, ...segs].join(" › ")}>
        <span className="text-teal-700 font-semibold">{root}</span>{shown.map((s) => ` › ${s}`).join("")}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-0.5 text-[11px] text-[var(--color-text-muted)] min-w-0">
      <span className="text-teal-700 font-semibold">{root}</span>
      {shown.map((s, i) => (
        <React.Fragment key={i}>
          <ChevronRight className="w-3 h-3 opacity-50 shrink-0" />
          <span className="truncate max-w-[220px]" title={s}>{s}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ── The wide list ─────────────────────────────────────────────────────────

const COLS: Array<{ key: string; label: string; sort?: [ThorSort, ThorSort]; cls: string }> = [
  { key: "name", label: "Name", sort: ["name", "name"], cls: "flex-1 min-w-0" },
  { key: "equipment", label: "Equipment", cls: "w-24 hidden lg:block" },
  { key: "type", label: "Type", cls: "w-24 hidden md:block" },
  { key: "size", label: "Size", sort: ["largest", "smallest"], cls: "w-20 text-right" },
  { key: "modified", label: "Modified", sort: ["newest", "oldest"], cls: "w-28 text-right" },
];

export function ThorResultsTable({ search, sort, words = [], onSort, selectedId, onSelect, onOpen, opener, header }: {
  search: ThorSearchState; sort: ThorSort; words?: string[]; onSort: (s: ThorSort) => void;
  selectedId: string | null; onSelect: (f: ThorFile) => void; onOpen: (f: ThorFile) => void;
  opener: ThorOpener; header?: React.ReactNode;
}) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const { more } = search;
  // The next page is asked for well before the end comes into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { rootMargin: "1600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, search.rows.length]);

  return (
    <div className="absolute inset-0 flex flex-col bg-[var(--color-surface)]">
      <div className="px-4 pt-3 pb-2 border-b border-[var(--color-border)] space-y-1.5">
        {header}
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
          <HardDrive className="w-3.5 h-3.5 text-teal-700" />
          {search.searching ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Searching THOR…</span>
            : search.error ? <span className="text-red-700">{search.error}</span>
            : words.length > 0 ? (
              <span>
                <b className="text-[var(--color-text)]">{countLabel(search.full, search.fullCapped)}</b> match {words.length === 1 ? "the word" : `all ${words.length} words`}
                {search.total > search.full && <> · {countLabel(search.total - search.full, search.capped)} more rank below by how many they match</>}
                {search.tookMs != null ? ` · ${search.tookMs} ms` : ""}
              </span>
            )
            : <span><b className="text-[var(--color-text)]">{countLabel(search.total, search.capped)}</b> file{search.total === 1 ? "" : "s"} on THOR{search.tookMs != null ? ` · ${search.tookMs} ms` : ""}{search.rows.length < search.total || search.capped ? ` · showing ${search.rows.length.toLocaleString()}` : ""}</span>}
          {search.resolvedEquipment && search.resolvedEquipment.length > 0 && (
            <span className="ml-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 px-1.5" title="Equipment numbers the tag resolved to inside the unit asked about">
              equipment {search.resolvedEquipment.slice(0, 6).join(", ")}{search.resolvedEquipment.length > 6 ? "…" : ""}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-[var(--color-border)] text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] bg-[var(--color-canvas)]">
        {COLS.map((c) => {
          const active = c.sort && (sort === c.sort[0] || sort === c.sort[1]);
          return (
            <div key={c.key} className={c.cls}>
              {c.sort ? (
                <button onClick={() => onSort(c.sort![0] === c.sort![1] ? (sort === "name" ? "relevance" : "name") : sort === c.sort![0] ? c.sort![1] : c.sort![0])}
                  className={`inline-flex items-center gap-0.5 hover:text-[var(--color-text)] ${active ? "text-[var(--color-text)]" : ""}`}>
                  {c.label}{active && (sort === "smallest" || sort === "oldest" || sort === "name" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                </button>
              ) : c.label}
            </div>
          );
        })}
      </div>
      <div className="flex-1 overflow-y-auto">
        {search.rows.map((f, i) => (
          <React.Fragment key={f.file_id}>
          {words.length > 1 && i > 0 && f.matched_terms.length < words.length && search.rows[i - 1].matched_terms.length > f.matched_terms.length && (
            <div className="px-4 py-1 text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] bg-[var(--color-canvas)] border-b border-[var(--color-border)]">
              Matching {f.matched_terms.length} of {words.length} words
            </div>
          )}
          <div role="button" tabIndex={0}
            onClick={() => onSelect(f)} onDoubleClick={() => onOpen(f)}
            onKeyDown={(e) => { if (e.key === "Enter") onOpen(f); }}
            style={{ contentVisibility: "auto", containIntrinsicSize: "0 46px" }}
            className={`flex items-center gap-3 px-4 py-1.5 border-b border-[var(--color-border)]/60 cursor-default text-sm ${selectedId === f.file_id ? "bg-sky-50" : "hover:bg-[var(--color-canvas)]"}`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <FileTypeIcon type={fileTypeOf(f.filename)} className="w-4 h-4 shrink-0" />
                <span className="font-semibold truncate" title={f.filename}>{f.filename}</span>
                {opener.opening === f.file_id && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}
              </div>
              <div className="flex items-center gap-1.5 min-w-0">
                {words.length > 0 && <MatchedWords words={words} matched={f.matched_terms} />}
                <div className="min-w-0 flex-1"><ThorLocation f={f} oneLine /></div>
              </div>
            </div>
            <div className="w-24 hidden lg:block text-xs truncate font-mono" title={f.equipment_numbers.join(", ")}>{f.equipment_numbers.slice(0, 2).join(", ") || <span className="text-[var(--color-text-muted)] font-sans">—</span>}</div>
            <div className="w-24 hidden md:block text-xs truncate">{fileTypeOf(f.filename).label}</div>
            <div className="w-20 text-right text-xs tabular-nums">{formatBytes(f.size_bytes)}</div>
            <div className="w-28 text-right text-xs tabular-nums" title="Filesystem modified date">{fmtDate(f.modified_at)}</div>
          </div>
          </React.Fragment>
        ))}
        <div ref={sentinel} className="h-10 grid place-items-center text-[11px] text-[var(--color-text-muted)]">
          {search.loading && !search.searching ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading more…</span>
            : !search.searching && search.rows.length > 0 && search.done ? "End of results" : null}
        </div>
        {!search.searching && !search.error && search.rows.length === 0 && (
          <div className="p-6 text-sm text-[var(--color-text-muted)]">
            Nothing on THOR matches. Try fewer words, drop a filter, or search a tag without the unit.
          </div>
        )}
      </div>
    </div>
  );
}

/** Which of the search words a file hit — green — and which it didn't. */
function MatchedWords({ words, matched }: { words: string[]; matched: string[] }) {
  const hit = new Set(matched);
  return (
    <span className="shrink-0 inline-flex gap-0.5" title={`Matches ${matched.length} of ${words.length}: ${matched.join(", ") || "none"}`}>
      {words.map((w) => (
        <span key={w} className={`rounded px-1 text-[10px] font-semibold ${hit.has(w) ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "text-[var(--color-text-muted)] line-through opacity-60 border border-transparent"}`}>{w}</span>
      ))}
    </span>
  );
}

// ── The short list (beside the system's results) ──────────────────────────

export function ThorHitList({ search, systemEmpty, onSelect, onShowAll, selectedId }: {
  search: ThorSearchState; systemEmpty: boolean; onSelect: (f: ThorFile) => void; onShowAll: () => void; selectedId: string | null;
}) {
  if (search.searching) return <div className="text-[11px] text-[var(--color-text-muted)] inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Checking THOR…</div>;
  if (search.error) return <div className="text-[11px] text-red-700">THOR: {search.error}</div>;
  if (!search.total) return null;
  return (
    <div className={`rounded-lg border p-2.5 ${systemEmpty ? "border-teal-300 bg-teal-50/60" : "border-[var(--color-border)]"}`}>
      <div className="flex items-center gap-1.5 text-xs font-bold text-teal-900">
        <HardDrive className="w-3.5 h-3.5" />
        {systemEmpty ? `Not in the system — found ${countLabel(search.total, search.capped)} on THOR` : `Also on THOR · ${countLabel(search.total, search.capped)}`}
      </div>
      <div className="mt-1.5 space-y-1">
        {search.rows.slice(0, 8).map((f) => (
          <button key={f.file_id} onClick={() => onSelect(f)}
            className={`w-full text-left rounded-md border px-2 py-1.5 ${selectedId === f.file_id ? "border-sky-400 bg-sky-50/50" : "border-[var(--color-border)] bg-[var(--color-canvas)] hover:bg-[var(--color-surface)]"}`}>
            <div className="flex items-center gap-1.5 min-w-0">
              <FileTypeIcon type={fileTypeOf(f.filename)} className="w-4 h-4 shrink-0" />
              <span className="text-sm font-semibold truncate">{f.filename}</span>
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] flex flex-wrap gap-x-2">
              {f.unit_folder && <span>{unitName(f.unit_folder)}</span>}
              {f.equipment_numbers[0] && <span className="font-mono">{f.equipment_numbers[0]}</span>}
              <span>{formatBytes(f.size_bytes)}</span>
              <span>{fmtDate(f.modified_at)}</span>
            </div>
          </button>
        ))}
      </div>
      <button onClick={onShowAll} className="mt-2 w-full rounded-md bg-teal-700 text-white text-xs font-bold px-2 py-1.5 hover:bg-teal-800">
        See all {countLabel(search.total, search.capped)} on THOR, with filters
      </button>
    </div>
  );
}

/** How each kind of reason reads: hits green, misses struck through, requirements purple. */
const REASON_STYLE: Record<ThorReason["where"], string> = {
  name: "text-green-800",
  equipment: "text-emerald-800",
  folder: "text-teal-800",
  missing: "text-[var(--color-text-muted)] line-through decoration-1",
  required: "text-purple-800",
  backup: "text-amber-800",
};

const CHIP: Record<ThorReason["where"], string> = {
  name: "bg-green-100 text-green-900 border-green-300",
  equipment: "bg-emerald-50 text-emerald-900 border-emerald-300",
  folder: "bg-teal-50 text-teal-900 border-teal-200",
  missing: "text-[var(--color-text-muted)] line-through border-transparent",
  required: "text-purple-800 border-transparent",
  backup: "bg-amber-50 text-amber-900 border-amber-200",
};
const CHIP_HINT: Record<ThorReason["where"], string> = {
  name: "in the file name", equipment: "in its equipment's name", folder: "in its folders", missing: "not in this file", required: "", backup: "",
};

/** The reasons as one line of chips: green = file name, emerald = equipment, teal = folder, struck = missing. */
export function ReasonChips({ reasons }: { reasons: ThorReason[] }) {
  if (!reasons.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] font-semibold">
      {reasons.map((r, i) => (
        <span key={i} title={r.text} className={`rounded border px-1 ${CHIP[r.where]}`}>
          {r.word ? r.word : r.text}{r.word && r.where !== "missing" ? <span className="font-normal opacity-70"> {r.where === "name" ? "name" : r.where === "equipment" ? "equip" : "folder"}</span> : null}
        </span>
      ))}
      <span className="sr-only">{reasons.map((r) => `${r.word ?? ""} ${CHIP_HINT[r.where]}`).join(", ")}</span>
    </div>
  );
}

export function Reasons({ reasons, max = 6 }: { reasons: ThorReason[]; max?: number }) {
  if (!reasons.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[11px]">
      {reasons.slice(0, max).map((r, i) => (
        <li key={i} className={`flex items-start gap-1 ${REASON_STYLE[r.where]}`}>
          <span className="w-3 shrink-0 text-center">{r.where === "missing" ? "·" : r.where === "required" ? "✓" : "+"}</span>
          <span className="min-w-0 break-words">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ── One file ──────────────────────────────────────────────────────────────

export function ThorFileCard({ orgId, f, opener, onClose, onFolder, onEquipment, root, rootUnc, q, vocab, resolved }: {
  orgId: string; f: ThorFile; opener: ThorOpener; onClose: () => void;
  onFolder: (rel: string) => void; onEquipment: (n: string) => void; root?: string;
  /** The share, for the opener's setup file. */
  rootUnc: string; q: ThorQuery | null; vocab: ThorVocabulary | null; resolved: string[] | null;
}) {
  const [setup, setSetup] = useState<null | { action: "open" | "show"; failed: boolean }>(null);
  const [launching, setLaunching] = useState<null | "open" | "show">(null);
  /** Open in its own program (or show it in Explorer) through the one-time helper. */
  const native = (action: "open" | "show") => {
    if (!openerInstalled()) { setSetup({ action, failed: false }); return; }
    setLaunching(action);
    void launchWatched(thorOpenUrl(action, f.rel_path)).then((ok) => {
      setLaunching(null);
      if (!ok) setSetup({ action, failed: true });
    });
  };
  /** PDFs and photos show here; everything else opens in its program. */
  const canPreview = viewKind(f.ext) !== "none";
  const [loaded, setLoaded] = useState<{ id: string; d: ThorFileDetail } | null>(null);
  const detail = loaded?.id === f.file_id ? loaded.d : null;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    thorFileDetail(orgId, f).then((d) => { if (live) setLoaded({ id: f.file_id, d }); }).catch(() => undefined);
    return () => { live = false; };
  }, [orgId, f]);
  const type = fileTypeOf(f.filename);
  const problem = opener.problem?.file.file_id === f.file_id ? opener.problem : null;

  return (
    <div className="p-3 border-b border-[var(--color-border)] bg-teal-50/30 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold flex items-center gap-1.5"><FileTypeIcon type={type} className="w-4 h-4 shrink-0" /> <span className="break-all">{f.filename}</span></div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px]">
            <span className={THOR_BADGE}>THOR</span>
            <span className="rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-1">{type.label}</span>
            <span className="rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-1">{formatBytes(f.size_bytes)}</span>
            <span className="rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-1" title="Filesystem modified date, not the engineering event date">modified {fmtDate(f.modified_at)}</span>
            {f.unit_folder && <span className="rounded bg-purple-50 border border-purple-200 text-purple-800 px-1">{unitName(f.unit_folder)}</span>}
            {f.folder_role && <span className="rounded bg-orange-50 border border-orange-200 text-orange-800 px-1" title="Role of the folder it sits in, as the indexer read it">{ROLE_LABEL[f.folder_role] ?? f.folder_role} folder</span>}
            {f.observation_state !== "current" && <span className="rounded bg-amber-50 border border-amber-200 text-amber-800 px-1">{f.observation_state.replace(/_/g, " ")}</span>}
          </div>
        </div>
        <button onClick={onClose} className="shrink-0 opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
      </div>

      <ThorLocation f={f} root={root} max={8} />

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => (canPreview ? void opener.open(f) : native("open"))} disabled={opener.opening === f.file_id}
          className="inline-flex items-center gap-1 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] px-2 py-1 text-xs font-bold disabled:opacity-60"
          title={canPreview ? "Show it here, read straight from THOR" : "Open it from THOR in its own program"}>
          {opener.opening === f.file_id || launching === "open" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : canPreview ? <Eye className="w-3.5 h-3.5" /> : <ExternalLink className="w-3.5 h-3.5" />} Open
        </button>
        {canPreview && (
          <button onClick={() => native("open")} className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-semibold" title="Open it in its own program (Adobe…)">
            {launching === "open" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />} Open in program
          </button>
        )}
        <button onClick={() => native("show")} className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-semibold" title="Open File Explorer with this file selected">
          {launching === "show" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOpen className="w-3.5 h-3.5" />} Show in folder
        </button>
        <button onClick={async () => { if (await copyText(f.unc_path)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-semibold">
          {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />} Copy path
        </button>
        <button onClick={() => onFolder(f.folder_rel)} className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-semibold" title="List everything in this folder here">
          <FolderSearch className="w-3.5 h-3.5" /> List folder
        </button>
      </div>
      {launching && <div className="text-[11px] text-[var(--color-text-muted)]">Handing it to Windows… if the browser asks to open Windows PowerShell, choose Open.</div>}
      {setup && (
        <OpenerSetup root={rootUnc} failed={setup.failed} onClose={() => setSetup(null)}
          onDone={() => { const a = setup.action; setSetup(null); native(a); }} />
      )}
      {problem && (problem.reason === "no-grant" || problem.reason === "denied" || problem.reason === "unrecognised" || problem.reason === "rejected") ? (
        opener.supported ? (
          <FolderSetup root={rootUnc} onClose={opener.clearProblem} onPick={() => void opener.connectAndOpen(f)}
            error={problem.reason === "no-grant" ? null : problem.message} />
        ) : (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">This browser can&apos;t read folders — use Chrome or Edge to see THOR files here, or Open in program.</div>
        )
      ) : problem ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="flex-1">{problem.message}</div>
          <button onClick={opener.clearProblem} className="opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
        </div>
      ) : null}
      {(q?.terms.length || resolved?.length) ? (
        <div>
          <div className="text-[11px] font-bold text-[var(--color-text-muted)]">Why it came up</div>
          <Reasons reasons={explainThor(f, q, vocab, resolved)} max={12} />
        </div>
      ) : null}
      {problem && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="flex-1">
            {problem.message}
            {(problem.reason === "no-grant" || problem.reason === "denied" || problem.reason === "unrecognised") && opener.supported && (
              <button onClick={() => void opener.connect().then((g) => { if (g) void opener.open(f); }).catch((e) => alert((e as Error).message))} className="ml-1 font-bold underline">Connect THOR</button>
            )}
          </div>
          <button onClick={opener.clearProblem} className="opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
        </div>
      )}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1 font-mono text-[11px] break-all select-all" title="Exact path on the NAS">{f.unc_path}</div>

      {detail && detail.equipment.length > 0 && (
        <div>
          <div className="text-[11px] font-bold text-[var(--color-text-muted)] flex items-center gap-1">Equipment <span title="Linked by the THOR Indexer from the file's name and folders — algorithmic, not verified"><Info className="w-3 h-3" /></span></div>
          <ul className="mt-0.5 space-y-1">
            {detail.equipment.map((e) => (
              <li key={e.number} className="text-[11px]">
                <button onClick={() => onEquipment(e.number)} className="font-mono font-bold text-emerald-800 hover:underline" title="Every THOR file for this equipment">{e.number}</button>
                {e.names.length > 0 && <span> · {e.names.join(" · ")}</span>}
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  {e.link ? `linked by ${e.link.basis.split("+")[0].replace(/_/g, " ")} · ${Math.round(e.link.confidence * 100)}% indexer confidence` : "number read from the path"}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {detail && detail.families.length > 0 && (
        <div className="text-[11px]">
          <span className="font-bold text-[var(--color-text-muted)]">Drawing family </span>
          {detail.families.map((m, i) => (
            <span key={i} className="mr-2"><span className="font-mono">{m.base}</span>{m.sheet ? ` sheet ${m.sheet}` : ""}{m.revision ? ` rev ${m.revision}` : ""}</span>
          ))}
        </div>
      )}
      {detail && detail.identifiers.filter((i) => i.type !== "equipment_number").length > 0 && (
        <div className="flex flex-wrap gap-1 text-[10px]">
          {detail.identifiers.filter((i) => i.type !== "equipment_number").slice(0, 12).map((i, k) => (
            <span key={k} className="rounded bg-blue-50 border border-blue-200 text-blue-800 px-1" title={`${i.type.replace(/_/g, " ")} · from ${i.source.replace(/_/g, " ")}`}>{i.value}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── The original, shown in place ──────────────────────────────────────────

export function ThorViewerLayer({ opener, orgId, userRole, uid, userEmail }: {
  opener: ThorOpener; orgId: string; userRole?: string; uid?: string | null; userEmail?: string | null;
}) {
  const v = opener.viewing;
  if (!v) return null;
  if (v.kind === "pdf") {
    return (
      <Suspense fallback={<div className="fixed inset-0 z-50 bg-black/60 grid place-items-center text-white"><Loader2 className="w-6 h-6 animate-spin" /></div>}>
        <FullScreenViewer isOpen onClose={opener.close} url={v.url} title={v.title} docNumber="THOR" rev=""
          userRole={userRole} currentUserId={uid || undefined} currentUserEmail={userEmail || undefined} orgId={orgId} />
      </Suspense>
    );
  }
  return (
    <div className="fixed inset-0 z-[70] bg-black/85 flex flex-col" onClick={opener.close}>
      <div className="flex items-center gap-2 px-4 py-2 text-white text-sm" onClick={(e) => e.stopPropagation()}>
        <span className={THOR_BADGE}>THOR</span>
        <span className="font-semibold truncate flex-1">{v.title}</span>
        <span className="text-xs opacity-70 truncate max-w-[40%]" title={v.file.unc_path}>{v.file.unc_path}</span>
        <button onClick={opener.close} className="opacity-80 hover:opacity-100"><X className="w-5 h-5" /></button>
      </div>
      <div className="flex-1 min-h-0 grid place-items-center p-4" onClick={(e) => e.stopPropagation()}>
        {v.kind === "image"
          ? <img src={v.url} alt={v.title} className="max-w-full max-h-full object-contain" /> /* eslint-disable-line @next/next/no-img-element */
          : <pre className="w-full h-full overflow-auto rounded-lg bg-white text-slate-900 text-xs p-4 whitespace-pre-wrap">{v.text}</pre>}
      </div>
    </div>
  );
}
