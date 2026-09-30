"use client";

// ScheduleImportModal — drag-drop file upload with format auto-detection
// for project-schedule imports.
//
// What it accepts (no manual "what format is this?" selector — we sniff):
//
//   * Microsoft Project XML  (.xml — Save As → XML)
//   * Primavera P6 XML       (.xml — Export to XML)
//   * Primavera P6 XER       (.xer — Export to XER, tab-delimited)
//   * Microsoft Project CSV  (.csv — direct export, with "Task Name" header)
//   * Generic CSV            (.csv — our own headered shape)
//
// Binary .mpp and legacy .mpx are REFUSED by design — the sniffer still
// detects them precisely so the refusal can name the file and demand the
// XML export (File → Save As → XML), which imports as a true 1:1 copy.
//
// Flow: drop or pick file → parse → preview rows → confirm import.
// The parse happens entirely in the browser; nothing leaves the
// client until the user clicks "Import N milestones".

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Upload, FileUp, X, Loader2, CheckCircle2, AlertTriangle,
  FileText, Calendar as CalIcon,
  Columns3, ArrowRight, Link2,
} from "lucide-react";
import { parseScheduleFileFromBytes, SCHEDULE_IMPORT_LIMITS, type ParseResult, type ParseOptions, type ScheduleFormat, type DateConvention } from "@/lib/scheduleParsers";
import { importMilestonesFromParsed, type ImportResult, type ImportPlan } from "@/lib/milestones";
import type { MilestoneSource } from "@/types/schema";
import { Select } from "@/components/ui/Field";
import Spinner from "@/components/ui/Spinner";

interface Props {
  orgId: string;
  projectId: string;
  /** The project we're writing into. Surfaced in the modal header
   *  so users can't be confused about target — fixed a real bug
   *  where 325 rows landed on a cancelled project the user wasn't
   *  even looking at. */
  projectName?: string;
  projectStatus?: string;
  userId: string;
  userName?: string;
  onClose: () => void;
  onDone: () => void;
}

const FORMAT_LABEL: Record<ScheduleFormat, string> = {
  "msproject-xml": "Microsoft Project · XML",
  "msproject-mpp": "Microsoft Project · MPP (not accepted — export XML)",
  "msproject-mpx": "Microsoft Project · MPX (not accepted — export XML)",
  "p6-xml":        "Primavera P6 · XML",
  "p6-xer":        "Primavera P6 · XER",
  "msproject-csv": "Microsoft Project · CSV",
  "generic-csv":   "Generic CSV",
  "unknown":       "Unknown format",
};

type ImportSource = Exclude<MilestoneSource, "manual">;
const FORMAT_TO_SOURCE: Record<ScheduleFormat, ImportSource> = {
  "msproject-xml": "msproject",
  "msproject-mpp": "msproject",
  "msproject-mpx": "msproject",
  "p6-xml":        "p6",
  "p6-xer":        "p6",
  "msproject-csv": "msproject",
  "generic-csv":   "csv",
  "unknown":       "csv",
};

export default function ScheduleImportModal({
  orgId, projectId, projectName, projectStatus, userId, userName, onClose, onDone,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  // The raw bytes are kept so the file can be re-parsed with an answer to a
  // question the parser asked (date order, which project) without a re-drop.
  const bytesRef = useRef<Uint8Array | null>(null);
  const [parseOpts, setParseOpts] = useState<ParseOptions>({});
  // GAP-403: the merge plan is shown BEFORE anything is written; progress
  // that the file would change is only overwritten on explicit opt-in.
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [overwriteProgress, setOverwriteProgress] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; phase: "rows" | "structure" } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Per-column review config: include/exclude, rename, or map to a first-class
  // field. Lets the user shape ANY ingested column before the final import.
  const [colConfig, setColConfig] = useState<Record<string, { include: boolean; rename: string; mapTo: string }>>({});

  // Internal render hints we don't surface as user-editable columns.
  const INTERNAL_KEYS = useMemo(() => new Set(["milestone"]), []);

  // Union of every custom column the parser captured across all rows.
  const detectedColumns = useMemo(() => {
    if (!parseResult) return [] as string[];
    const keys = new Set<string>();
    for (const r of parseResult.rows) {
      if (r.attributes) for (const k of Object.keys(r.attributes)) if (!INTERNAL_KEYS.has(k)) keys.add(k);
    }
    return Array.from(keys);
  }, [parseResult, INTERNAL_KEYS]);

  // A reviewed plan describes one exact change set: any change to the column
  // review (include / rename / map-to), the file, its reading or the
  // progress opt-in invalidates it, so the user reviews again before "Import
  // N changes" can write (GAP-403 acceptance 2). The token also retires a dry
  // run still in flight: its answer describes inputs that no longer hold, so
  // it is dropped instead of being shown as the plan.
  const planToken = useRef(0);
  const invalidatePlan = useCallback(() => {
    planToken.current++;
    setPlan(null);
  }, []);
  const updateColumn = useCallback((k: string, cfg: { include: boolean; rename: string; mapTo: string }) => {
    setColConfig((p) => ({ ...p, [k]: cfg }));
    invalidatePlan();
  }, [invalidatePlan]);

  // Seed/refresh config whenever a new file is parsed.
  useEffect(() => {
    setColConfig((prev) => {
      const next: Record<string, { include: boolean; rename: string; mapTo: string }> = {};
      for (const k of detectedColumns) next[k] = prev[k] ?? { include: true, rename: k, mapTo: "" };
      return next;
    });
  }, [detectedColumns]);

  const handleFile = useCallback(async (file: File) => {
    setParsing(true);
    setParseResult(null);
    setImportResult(null);
    invalidatePlan();
    setParseOpts({});
    setFilename(file.name);
    try {
      // Size cap (PT SCH-14): refused with the limit named, never decoded.
      if (file.size > SCHEDULE_IMPORT_LIMITS.maxBytes) {
        bytesRef.current = null;
        setParseResult({
          format: "unknown", rows: [],
          warnings: [`"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB; the import limit is ${SCHEDULE_IMPORT_LIMITS.maxBytes / 1048576} MB per file. Export a smaller schedule (for example one phase) or trim unused columns.`],
        });
        return;
      }
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      bytesRef.current = bytes;
      setParseResult(parseScheduleFileFromBytes(file.name, bytes));
    } catch (e) {
      setParseResult({
        format: "unknown",
        rows: [],
        warnings: [`Couldn't read the file: ${(e as Error).message}`],
      });
    } finally { setParsing(false); }
  }, [invalidatePlan]);

  // Re-parse the same bytes with an answer (date order / project choice).
  const reparse = useCallback((patch: ParseOptions) => {
    const bytes = bytesRef.current;
    if (!bytes || !filename) return;
    const next = { ...parseOpts, ...patch };
    setParseOpts(next);
    invalidatePlan();
    setImportResult(null);
    setParseResult(parseScheduleFileFromBytes(filename, bytes, next));
  }, [filename, parseOpts, invalidatePlan]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  }, [handleFile]);

  // Apply the user's column review (include / rename / map-to-field) to one row.
  const applyColConfig = useCallback((r: ParseResult["rows"][number]): ParseResult["rows"][number] => {
    if (!r.attributes) return r;
    const out: Record<string, unknown> = { ...r };
    const newAttrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.attributes)) {
      if (INTERNAL_KEYS.has(k)) { newAttrs[k] = String(v); continue; } // keep internal flags
      const cfg = colConfig[k];
      if (cfg && !cfg.include) continue;                 // dropped
      if (cfg && cfg.mapTo) { out[cfg.mapTo] = v; continue; } // promoted to a first-class field
      newAttrs[(cfg?.rename || k).trim() || k] = String(v); // kept (possibly renamed)
    }
    out.attributes = Object.keys(newAttrs).length > 0 ? newAttrs : undefined;
    return out as unknown as ParseResult["rows"][number];
  }, [colConfig, INTERNAL_KEYS]);

  const overRowCap = (parseResult?.rows.length ?? 0) > SCHEDULE_IMPORT_LIMITS.maxRows;

  /** One import call, shared by the plan (dryRun) and the write. */
  const runImport = useCallback(async (dryRun: boolean) => {
    if (!parseResult || parseResult.rows.length === 0) return null;
    const shaped = parseResult.rows.map(applyColConfig);
    const controller = dryRun ? null : new AbortController();
    abortRef.current = controller;
    return importMilestonesFromParsed({
        orgId, projectId,
        source: FORMAT_TO_SOURCE[parseResult.format],
        dryRun,
        overwriteProgress,
        signal: controller?.signal,
        onProgress: dryRun ? undefined : setProgress,
        // CRITICAL: pass through every hierarchy + duration field
        // the parser captured. Previous code dropped these on the
        // floor — the importer then wrote rows with no parent_id,
        // no planned_start_at, no outline_level, no wbs, no
        // is_summary, so the Execution view rendered flat
        // single-day pills no matter what the .mpp contained.
        rows: shaped.map((r) => ({
          name: r.name,
          plannedAt: r.plannedAt,
          plannedStartAt: r.plannedStartAt,
          startHasTime: r.startHasTime,
          weight: r.weight,
          // Source progress (MS Project %Complete / P6 physical % / CSV %): the
          // importer derives status + percent_complete from it so a
          // partially-done schedule keeps its progress instead of resetting.
          percentComplete: r.percentComplete,
          description: r.description,
          externalRef: r.externalRef,
          parentExternalRef: r.parentExternalRef,
          dependsOnExternalRefs: r.dependsOnExternalRefs,
          outlineLevel: r.outlineLevel,
          wbs: r.wbs,
          isSummary: r.isSummary,
          workOrderRef: r.workOrderRef,
          responsibleParty: r.responsibleParty,
          responsibleKind: r.responsibleKind,
          responsibleOrg: r.responsibleOrg,
          location: r.location,
          durationHours: r.durationHours,
          attributes: r.attributes,
        })),
        createdBy: userId,
        createdByName: userName,
      });
  }, [parseResult, orgId, projectId, userId, userName, applyColConfig, overwriteProgress]);

  // Step 1: the reviewable diff. Nothing is written. While it runs the
  // column review is locked; an answer that arrives after the inputs changed
  // anyway ("Choose another") is stale and dropped.
  const review = useCallback(async () => {
    if (overRowCap) return;
    const token = ++planToken.current;
    setPlanning(true);
    try {
      const res = await runImport(true);
      if (token !== planToken.current) return;
      if (res?.plan) setPlan(res.plan);
      if (res && res.errors.length > 0) setImportResult(res);
    } finally { setPlanning(false); }
  }, [runImport, overRowCap]);

  // Step 2: apply the reviewed plan, with progress and cancel.
  const submit = useCallback(async () => {
    if (!plan || overRowCap) return;
    setImporting(true);
    setProgress(null);
    try {
      const res = await runImport(false);
      if (!res) return;
      setImportResult(res);
      // Only auto-close when at least one row was actually INSERTED
      // into this project. Pure-update results (which happen when
      // the same .mpp gets re-imported into a project that already
      // owns those external_refs) leave the panel open so the user
      // can verify what landed. Caught a real bug where users
      // re-imported into a fresh project and saw nothing because
      // every row was an update to a different project's rows.
      const cleanWin = res.errors.length === 0 && res.inserted > 0 && !res.cancelled;
      if (cleanWin) {
        setTimeout(() => onDone(), 800);
      }
    } finally { setImporting(false); abortRef.current = null; }
  }, [plan, runImport, onDone, overRowCap]);

  const cancelImport = useCallback(() => { abortRef.current?.abort(); }, []);

  const canReview = !!parseResult && parseResult.rows.length > 0 && !importing && !planning && !overRowCap;
  const canSubmit = canReview && !!plan;
  const previewRows = parseResult?.rows.slice(0, 8) ?? [];
  const moreCount = (parseResult?.rows.length ?? 0) - previewRows.length;

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-3xl bg-[var(--color-surface)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh] animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between bg-gradient-to-r from-[var(--color-accent-soft)] via-white to-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--color-accent)] flex items-center justify-center shadow-md">
              <Upload className="w-5 h-5 text-[var(--color-accent-fg)]" />
            </div>
            <div className="min-w-0">
              <h2 className="font-black text-[var(--color-text)]">Import schedule</h2>
              <div className="text-[11px] text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
                <span>Importing into</span>
                <span className="font-bold text-[var(--color-text)] truncate max-w-[200px]">{projectName ?? `Project ${projectId.slice(0,8)}`}</span>
                {projectStatus && projectStatus !== "active" && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-rose-100 text-rose-800 border border-rose-200">
                    <AlertTriangle className="w-2.5 h-2.5" /> {projectStatus}
                  </span>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-200 text-[var(--color-text-muted)] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Drop zone OR results */}
          {!parseResult ? (
            <div
              onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click(); }}
              className={`relative border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all ${
                dragOver
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/60 scale-[1.01]"
                  : "border-[var(--color-border-strong)] bg-slate-50/40 hover:border-[var(--color-accent-ring)] hover:bg-[var(--color-accent-soft)]/30"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".xml,.xer,.csv,.txt,application/xml,text/xml,text/csv,text/plain"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
              />
              {parsing ? (
                <div className="flex flex-col items-center gap-2">
                  <Spinner size="lg" />
                  <div className="text-sm font-bold text-[var(--color-text)]">Reading {filename}…</div>
                </div>
              ) : (
                <>
                  <div className="w-16 h-16 mx-auto rounded-2xl bg-[var(--color-accent-soft)] flex items-center justify-center mb-3 border border-[var(--color-accent-ring)]/40">
                    <FileUp className="w-8 h-8 text-[var(--color-accent)]" />
                  </div>
                  <div className="text-base font-black text-[var(--color-text)]">Drop your schedule here</div>
                  <div className="text-sm text-[var(--color-text-muted)] mt-1">or click to pick a file</div>
                  <div className="mt-4 flex items-center justify-center gap-2 flex-wrap">
                    <FormatBadge label=".xml" hint="MS Project / P6 XML" />
                    <FormatBadge label=".xer" hint="Primavera P6 native" />
                    <FormatBadge label=".csv" hint="Direct export or generic" />
                  </div>
                  <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                    Have a .mpp or .mpx? Export XML first — in MS Project: File → Save As → XML Format.
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              {/* File header strip */}
              <div className="flex items-center gap-3 p-3 bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border)]">
                <div className="w-9 h-9 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4 text-[var(--color-text-muted)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-[var(--color-text)] truncate">{filename}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">{FORMAT_LABEL[parseResult.format]} · {parseResult.rows.length} milestone{parseResult.rows.length === 1 ? "" : "s"} found</div>
                </div>
                <button
                  onClick={() => { setParseResult(null); setFilename(null); setImportResult(null); invalidatePlan(); }}
                  className="text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded hover:bg-slate-200 transition-colors"
                  disabled={importing}
                >
                  Choose another
                </button>
              </div>

              {/* Refused MS Project formats show ONLY the XML-export guide —
                  the system never reads approximate .mpp/.mpx data. */}
              {(parseResult.format === "msproject-mpp" || parseResult.format === "msproject-mpx") && (
                <XmlExportGuide filename={filename ?? ""} format={parseResult.format} />
              )}

              {/* Warnings — for everything except the refused-format case,
                  which the guide above covers. */}
              {parseResult.format !== "msproject-mpp" && parseResult.format !== "msproject-mpx" && parseResult.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <div className="font-bold flex items-center gap-1.5 mb-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> {parseResult.warnings.length} note{parseResult.warnings.length === 1 ? "" : "s"} from the parser
                  </div>
                  <ul className="ml-5 list-disc space-y-0.5">
                    {parseResult.warnings.slice(0, 4).map((w, i) => <li key={i}>{w}</li>)}
                    {parseResult.warnings.length > 4 && <li className="italic text-amber-800/70">+{parseResult.warnings.length - 4} more…</li>}
                  </ul>
                </div>
              )}

              {/* Parse-quality stats — surface hierarchy + duration
                  coverage so the user knows what made it through. */}
              {parseResult.rows.length > 0 && (
                <ParseQualityStats result={parseResult} />
              )}

              {/* Column review — every extra column the parser captured, so the
                  user can rename, drop, or promote it to a first-class field
                  before the final import. Fully dynamic: works with whatever
                  columns the source happened to have. */}
              {parseResult.rows.length > 0 && detectedColumns.length > 0 && (
                <div className="rounded-xl border border-[var(--color-border)] p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Columns3 className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                    <span className="text-xs font-black text-[var(--color-text)]">{detectedColumns.length} extra column{detectedColumns.length === 1 ? "" : "s"} detected</span>
                  </div>
                  <p className="text-[11px] text-[var(--color-text-muted)] mb-2.5">Rename, drop, or map any of these to a built-in field before importing. Everything else is kept on each task as a custom field.{planning ? " Locked while the review runs." : ""}</p>
                  <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                    {detectedColumns.map((k) => {
                      const cfg = colConfig[k] ?? { include: true, rename: k, mapTo: "" };
                      return (
                        <div key={k} className={`flex items-center gap-2 ${cfg.include ? "" : "opacity-50"}`}>
                          <input type="checkbox" checked={cfg.include} onChange={(e) => updateColumn(k, { ...cfg, include: e.target.checked })} disabled={planning} className="w-3.5 h-3.5 accent-[var(--color-accent)] shrink-0" title="Include this column" />
                          <span className="font-mono text-[11px] text-[var(--color-text-muted)] w-28 truncate shrink-0" title={k}>{k}</span>
                          <ArrowRight className="w-3 h-3 text-slate-300 shrink-0" />
                          <input
                            value={cfg.rename}
                            onChange={(e) => updateColumn(k, { ...cfg, rename: e.target.value })}
                            disabled={planning || !cfg.include || !!cfg.mapTo}
                            placeholder={k}
                            className="flex-1 min-w-0 h-7 px-2 rounded-md border border-[var(--color-border)] text-xs disabled:bg-[var(--color-surface-2)] disabled:text-[var(--color-text-faint)]"
                          />
                          <Select
                            value={cfg.mapTo}
                            onChange={(e) => updateColumn(k, { ...cfg, mapTo: e.target.value })}
                            disabled={planning || !cfg.include}
                            className="shrink-0"
                          >
                            <option value="">Keep as field</option>
                            <option value="responsibleParty">→ Resource / responsible</option>
                            <option value="responsibleOrg">→ Department / org</option>
                            <option value="location">→ Location / area</option>
                            <option value="workOrderRef">→ Work order</option>
                          </Select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Questions the parser asked — answered once, applied to every row. */}
              {parseResult.needsDateConvention && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
                  <div className="font-bold">How should dates in this file be read?</div>
                  <div>Every slash date (e.g. <span className="font-mono">{parseResult.dates?.sample}</span>) could be day/month or month/day. Nothing is imported until you choose; the choice applies to the whole file.</div>
                  <div className="flex items-center gap-4">
                    {(["mdy", "dmy"] as DateConvention[]).map((c) => (
                      <label key={c} className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input type="radio" name="date-convention" checked={parseOpts.dateConvention === c} onChange={() => reparse({ dateConvention: c })} className="accent-[var(--color-accent)]" />
                        {c === "mdy" ? "Month / day / year (US)" : "Day / month / year"}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {parseResult.needsProjectChoice && parseResult.projects && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
                  <div className="font-bold">This file holds {parseResult.projects.length} projects — which one is this?</div>
                  <div>They are never merged into one board. Pick the project whose activities belong here.</div>
                  <Select value={parseOpts.projectId ?? ""} onChange={(e) => reparse({ projectId: e.target.value || null })}>
                    <option value="">Choose a project…</option>
                    {parseResult.projects.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.rows} row{p.rows === 1 ? "" : "s"}</option>)}
                  </Select>
                </div>
              )}
              {!parseResult.needsProjectChoice && parseResult.projects && parseResult.projects.length > 1 && parseResult.selectedProjectId && (
                <div className="text-[11px] text-[var(--color-text-muted)]">Importing project <b>{parseResult.projects.find((p) => p.id === parseResult.selectedProjectId)?.name}</b> only ({parseResult.projects.length} in the file).</div>
              )}
              {parseResult.rows.length > 0 && (parseResult.keyColumn || parseResult.dates?.convention) && (
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {parseResult.keyColumn && <>Re-imports match rows on <b>{parseResult.keyColumn}</b>. </>}
                  {parseResult.dates?.convention && <>Dates read as <b>{parseResult.dates.convention === "dmy" ? "day/month/year" : "month/day/year"}</b> ({parseResult.dates.decidedBy === "user" ? "your choice" : `fixed by the file: ${parseResult.dates.sample}`}).</>}
                </div>
              )}
              {overRowCap && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
                  This file has <b>{parseResult.rows.length.toLocaleString()}</b> rows; the import limit is <b>{SCHEDULE_IMPORT_LIMITS.maxRows.toLocaleString()}</b> rows per file. Split the schedule (for example by phase) and import the parts separately.
                </div>
              )}

              {/* The reviewable diff (GAP-403): what this import would do, before it writes. */}
              {plan && !importResult && (
                <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-2">
                  <div className="text-xs font-black text-[var(--color-text)]">What this import will do</div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                    <StatCell label="Added"        value={`${plan.added}`}     tone={plan.added > 0 ? "ok" : "muted"} />
                    <StatCell label="Changed"      value={`${plan.changed}`}   tone={plan.changed > 0 ? "ok" : "muted"} />
                    <StatCell label="Unchanged"    value={`${plan.unchanged}`} tone="muted" />
                    <StatCell label="Not in file"  value={`${plan.notInFile}`} tone={plan.notInFile > 0 ? "warn" : "muted"} />
                  </div>
                  {plan.notInFile > 0 && (
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      {plan.notInFile} task{plan.notInFile === 1 ? " is" : "s are"} on the board but not in this file ({plan.notInFileNames.slice(0, 5).join(", ")}{plan.notInFile > 5 ? ", …" : ""}). They are left as they are — an import never deletes.
                    </div>
                  )}
                  {plan.rekeyed > 0 && (
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      {rekeyedSummary(plan)}
                    </div>
                  )}
                  {(plan.positionAdopted ?? 0) > 0 && (
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      {positionAdoptedSummary(plan)}
                    </div>
                  )}
                  {(plan.positionRepeated ?? 0) > 0 && (
                    <div className="text-[11px] text-amber-900">
                      {positionRepeatedSummary(plan)}
                    </div>
                  )}
                  {plan.structure.rows > 0 && (
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      Structure changes on {plan.structure.rows} task{plan.structure.rows === 1 ? "" : "s"}: {structureSummary(plan.structure)}. The file&apos;s parents and finish-to-start links replace the board&apos;s for the tasks it carries — including links added here.
                    </div>
                  )}
                  {plan.localProgressAtRisk.length > 0 && (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-[11px] text-amber-900 space-y-1.5">
                      <div className="font-bold flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> {plan.localProgressAtRisk.length} task{plan.localProgressAtRisk.length === 1 ? " has" : "s have"} progress on the board that differs from this file — {overwriteProgress ? "the file's value will replace it" : "kept as it is on the board"}</div>
                      <ul className="ml-5 list-disc">
                        {plan.localProgressAtRisk.slice(0, 5).map((r) => <li key={r.id}>{r.name}: {progressChangeLabel(r.localPercent, r.filePercent ?? 0)} ({r.localStatus.replace("_", " ")} on the board)</li>)}
                        {plan.localProgressAtRisk.length > 5 && <li className="italic">+{plan.localProgressAtRisk.length - 5} more…</li>}
                      </ul>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer font-bold">
                        <input type="checkbox" checked={overwriteProgress} onChange={(e) => { setOverwriteProgress(e.target.checked); invalidatePlan(); }} className="accent-amber-600" />
                        Take the file&apos;s progress for these tasks
                      </label>
                    </div>
                  )}
                </div>
              )}

              {/* Progress + cancel while writing */}
              {importing && progress && (
                <div className="rounded-xl border border-[var(--color-border)] p-3 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span>{progress.phase === "rows" ? "Writing rows" : "Wiring structure"} · {progress.done} / {progress.total}</span>
                    <button onClick={cancelImport} className="font-bold text-rose-700 hover:underline">Cancel</button>
                  </div>
                  <div className="h-1.5 rounded bg-[var(--color-surface-2)] overflow-hidden"><div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></div>
                </div>
              )}

              {/* Preview table */}
              {parseResult.rows.length > 0 && (
                <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
                  <div className="px-3 py-2 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">
                    Preview · first {previewRows.length} {moreCount > 0 ? `of ${parseResult.rows.length}` : "row" + (previewRows.length === 1 ? "" : "s")}
                  </div>
                  <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-xs">
                    <thead className="bg-[var(--color-surface)] border-b border-[var(--color-border)] text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                      <tr>
                        <th className="text-left px-3 py-1.5">Task</th>
                        <th className="text-left px-3 py-1.5 w-32">Due</th>
                        <th className="text-left px-3 py-1.5 w-16">Parent</th>
                        <th className="text-left px-3 py-1.5 w-12">Lvl</th>
                        <th className="text-left px-3 py-1.5 w-16">% done</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-border)]">
                      {previewRows.map((r, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5">
                            <div className="font-bold text-[var(--color-text)] truncate flex items-center gap-1">
                              {r.isSummary && <span className="text-[9px] font-black bg-[var(--color-accent-soft)] text-[var(--color-accent)] px-1 rounded shrink-0">SUM</span>}
                              <span className="truncate">{r.name}</span>
                              {(r.dependsOnExternalRefs?.length ?? 0) > 0 && (
                                <span
                                  className="inline-flex items-center gap-0.5 text-[9px] font-black bg-[var(--color-accent-soft)] text-[var(--color-accent)] px-1 rounded shrink-0"
                                  title={`${r.dependsOnExternalRefs!.length} predecessor link${r.dependsOnExternalRefs!.length === 1 ? "" : "s"} from the source schedule`}
                                >
                                  <Link2 className="w-2.5 h-2.5" />{r.dependsOnExternalRefs!.length}
                                </span>
                              )}
                            </div>
                            {r.externalRef && <div className="text-[10px] font-mono text-[var(--color-text-faint)] truncate">{r.externalRef}</div>}
                          </td>
                          <td className="px-3 py-1.5 text-[var(--color-text)]">
                            <CalIcon className="inline w-3 h-3 mr-1 text-[var(--color-text-faint)]" />
                            {humanDate(r.plannedAt)}
                          </td>
                          <td className="px-3 py-1.5 text-[10px] font-mono text-[var(--color-text-muted)] truncate">
                            {r.parentExternalRef ? r.parentExternalRef.split(":")[1] : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-[var(--color-text)] font-mono">{r.outlineLevel ?? <span className="text-slate-300">—</span>}</td>
                          <td className="px-3 py-1.5 text-[var(--color-text)] font-mono">{r.percentComplete != null ? `${Math.round(r.percentComplete)}%` : <span className="text-slate-300">—</span>}</td>
                        </tr>
                      ))}
                      {moreCount > 0 && (
                        <tr><td colSpan={5} className="px-3 py-1.5 text-[11px] text-[var(--color-text-muted)] italic">+{moreCount} more row{moreCount === 1 ? "" : "s"} will be imported.</td></tr>
                      )}
                    </tbody>
                  </table>
                  </div>
                </div>
              )}

              {/* Import result */}
              {importResult && (
                <div className={`rounded-xl p-3 border ${importResult.errors.length > 0 ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}>
                  <div className="flex items-center gap-2 font-bold text-sm">
                    {importResult.cancelled
                      ? <><AlertTriangle className="w-4 h-4 text-rose-600" /> Import cancelled</>
                      : importResult.errors.length > 0
                      ? <><AlertTriangle className="w-4 h-4 text-rose-600" /> Imported with errors</>
                      : <><CheckCircle2 className="w-4 h-4 text-emerald-600" /> Imported successfully</>
                    }
                  </div>
                  <div className="mt-1 text-xs space-y-0.5">
                    <div>Inserted: <b>{importResult.inserted}</b></div>
                    <div>Updated: <b>{importResult.updated}</b></div>
                    {importResult.skipped > 0 && <div>Skipped: <b>{importResult.skipped}</b></div>}
                    {parseResult.dates?.convention && <div>Dates read as <b>{parseResult.dates.convention === "dmy" ? "day/month/year" : "month/day/year"}</b> ({parseResult.dates.decidedBy === "user" ? "your choice" : `fixed by the file: ${parseResult.dates.sample}`}).</div>}
                    {parseResult.keyColumn && <div>Rows matched on <b>{parseResult.keyColumn}</b>.</div>}
                    {importResult.batchId && <div className="text-[10px] font-mono text-[var(--color-text-faint)]">batch {importResult.batchId}</div>}
                    {importResult.errors.length > 0 && (
                      <div className="text-rose-700">
                        {importResult.errors.length} error{importResult.errors.length === 1 ? "" : "s"}:
                        <ul className="ml-5 list-disc">{importResult.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}</ul>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Tip strip — always visible. */}
          <div className="text-[11px] text-[var(--color-text-muted)] italic">
            One-way import. We never write back to your PM tool. Re-importing matches rows on their source id, shows what would change first, and never erases progress recorded here unless you say so.
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5 transition-colors">Close</button>
          {parseResult && parseResult.rows.length > 0 && !importResult && !plan && (
            <button
              onClick={review}
              disabled={!canReview}
              className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-4 py-2 rounded-lg shadow-sm disabled:opacity-40 transition-colors"
            >
              {planning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Columns3 className="w-4 h-4" />}
              Review changes
            </button>
          )}
          {parseResult && parseResult.rows.length > 0 && !importResult && plan && (
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-4 py-2 rounded-lg shadow-sm disabled:opacity-40 transition-colors"
            >
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              Import {planChangeCount(plan)} change{planChangeCount(plan) === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Rows the import will write: added, changed, and rows whose only change is
 *  structure (parent / links) — the button never reads "0 changes" when the
 *  structure pass will rewrite links. */
export function planChangeCount(plan: ImportPlan): number {
  return plan.added + plan.changed + plan.structure.onlyStructure + plan.rekeyedOnly;
}

/** Rows imported earlier that this import re-keys: they keep their id,
 *  progress and history (PT SCH-3). */
export function rekeyedSummary(plan: Pick<ImportPlan, "rekeyed">): string {
  const n = plan.rekeyed;
  return `${n} task${n === 1 ? "" : "s"} imported earlier will be re-keyed — ${n === 1 ? "it keeps its" : "they keep their"} progress and history. A task matched on its earlier content key matches on name and dates exactly: if its name or dates changed in the file, it is added, and the earlier one is listed as not in this file.`;
}

/** Position-keyed rows adopted by their unique name — every one named, so
 *  each adoption is seen before anything is written (PT SCH-3). */
export function positionAdoptedSummary(plan: Pick<ImportPlan, "positionAdopted" | "positionAdoptedNames">): string {
  const n = plan.positionAdopted;
  const more = n - plan.positionAdoptedNames.length;
  return `${n} task${n === 1 ? "" : "s"} imported earlier by row position ${n === 1 ? "is" : "are"} matched by name — each name occurs once on the board and once in this file — and ${n === 1 ? "keeps its" : "keep their"} progress; the planned dates are taken from the file: ${plan.positionAdoptedNames.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
}

/** Position-keyed rows whose name repeats: kept, never matched (PT SCH-3). */
export function positionRepeatedSummary(plan: Pick<ImportPlan, "positionRepeated" | "positionRepeatedNames">): string {
  const n = plan.positionRepeated;
  const names = Array.from(new Set(plan.positionRepeatedNames)).join(", ");
  return n === 1
    ? `1 task repeats a name (${names}) — its earlier row is kept, not matched; review before importing. This file's tasks of that name are added.`
    : `${n} tasks repeat a name (${names}) — their earlier rows are kept, not matched; review before importing. This file's tasks of those names are added.`;
}

/** "60% → 80%" / "60% → 0%" — the direction the file would move progress. */
export function progressChangeLabel(board: number, file: number): string {
  return `${board}% on the board → ${file}% in the file (${file > board ? "higher" : file < board ? "lower" : "same %, different status"})`;
}

export function structureSummary(s: ImportPlan["structure"]): string {
  const parts: string[] = [];
  if (s.parents > 0) parts.push(`${s.parents} parent${s.parents === 1 ? "" : "s"} changed`);
  if (s.linksAdded > 0) parts.push(`${s.linksAdded} link${s.linksAdded === 1 ? "" : "s"} added`);
  if (s.linksRemoved > 0) parts.push(`${s.linksRemoved} link${s.linksRemoved === 1 ? "" : "s"} removed`);
  return parts.join(", ");
}

function FormatBadge({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="inline-flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)]">
      <span className="text-[11px] font-mono font-black text-[var(--color-text)]">{label}</span>
      <span className="text-[9px] text-[var(--color-text-muted)]">{hint}</span>
    </div>
  );
}

function humanDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    // Schedule dates are stored as wall-clock-as-UTC, so render them in UTC —
    // otherwise the preview shows a different day than the source file for any
    // viewer west of UTC, which reads as "the import got the dates wrong".
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  } catch { return iso; }
}

// XmlExportGuide — shown when a refused MS Project format (.mpp binary or
// legacy .mpx) is dropped. The system does not read these formats, on purpose:
// only MS Project's own XML export is a lossless 1:1 copy (every date,
// dependency, resource, and the full hierarchy). This panel demands exactly
// that, with the precise steps.
function XmlExportGuide({ filename, format }: { filename: string; format: "msproject-mpp" | "msproject-mpx" }) {
  const ext = format === "msproject-mpp" ? ".mpp" : ".mpx";
  return (
    <div className="rounded-xl border border-[var(--color-accent-ring)]/50 bg-[var(--color-accent-soft)]/60 overflow-hidden">
      <div className="px-4 py-3 bg-gradient-to-r from-[var(--color-accent-soft)] to-[var(--color-accent-soft)]/40 border-b border-[var(--color-accent-ring)]/40 flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-lg bg-[var(--color-surface)] border border-[var(--color-accent-ring)]/50 flex items-center justify-center shrink-0">
          <FileText className="w-4 h-4 text-[var(--color-accent)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-black text-[var(--color-text)]">This file needs to be exported as XML first</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">
            <code className="font-mono">{ext}</code> files are not accepted — only MS Project&apos;s XML export is a
            guaranteed exact copy of your schedule. The export takes ~15 seconds.
          </div>
        </div>
      </div>
      <div className="p-4">
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3">
          <div className="text-xs font-black text-emerald-900 uppercase tracking-widest mb-2">Exact copy · no setup</div>
          <ol className="space-y-1.5 text-xs text-emerald-900/90">
            <Step n={1}>
              Open <code className="font-mono bg-[var(--color-surface)] px-1.5 py-0.5 rounded border border-emerald-200 text-[10px]">{filename || "your schedule"}</code> in Microsoft Project.
            </Step>
            <Step n={2}>
              <b>File → Save As</b> (or <kbd className="font-mono bg-[var(--color-surface)] px-1.5 py-0.5 rounded border border-emerald-200">F12</kbd>) → choose <b>XML Format (*.xml)</b> and save.
            </Step>
            <Step n={3}>
              Drag that new <code className="font-mono bg-[var(--color-surface)] px-1.5 py-0.5 rounded border border-emerald-200 text-[10px]">.xml</code> file right here. It imports with all dependencies, resources, and exact dates.
            </Step>
          </ol>
        </div>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="shrink-0 w-5 h-5 rounded-full bg-amber-600 text-white text-[10px] font-black flex items-center justify-center mt-0.5">{n}</span>
      <span className="flex-1">{children}</span>
    </li>
  );
}

// ─── Parse-quality stats ───────────────────────────────────────
// Surfaces what the parser actually extracted vs what's missing —
// hierarchy, durations, summary flags — so the user knows whether
// the import is going to render with sub-tasks and multi-day spans
// or come in flat. Shows a loud warning + actionable fix list when
// hierarchy is missing.

function ParseQualityStats({ result }: { result: ParseResult }) {
  const total = result.rows.length;
  const withParent  = result.rows.filter((r) => r.parentExternalRef).length;
  const withStart   = result.rows.filter((r) => r.plannedStartAt).length;
  const summaries   = result.rows.filter((r) => r.isSummary).length;
  const withWbs     = result.rows.filter((r) => r.wbs).length;
  const noHierarchy = withParent === 0 && summaries === 0;
  const noDurations = withStart === 0;

  return (
    <div className={`rounded-xl border p-3 space-y-2 ${
      noHierarchy ? "bg-rose-50 border-rose-200" : "bg-emerald-50 border-emerald-200"
    }`}>
      <div className="flex items-center gap-2">
        {noHierarchy
          ? <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
          : <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
        }
        <div className={`text-sm font-bold ${noHierarchy ? "text-rose-900" : "text-emerald-900"}`}>
          {noHierarchy
            ? "Hierarchy NOT detected"
            : `Hierarchy detected — ${summaries} summary parent${summaries === 1 ? "" : "s"}, ${withParent} sub-task${withParent === 1 ? "" : "s"}`}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
        <StatCell label="Total tasks"      value={`${total}`}            tone={total > 0 ? "ok" : "warn"} />
        <StatCell label="With parent"      value={`${withParent} / ${total}`} tone={withParent  > 0 ? "ok" : "warn"} />
        <StatCell label="With start date"  value={`${withStart} / ${total}`}  tone={withStart   > 0 ? "ok" : "warn"} />
        <StatCell label="WBS codes"        value={`${withWbs} / ${total}`}    tone={withWbs     > 0 ? "ok" : "muted"} />
      </div>
      {noHierarchy && (
        <div className="text-[11px] text-rose-900 mt-1 space-y-1">
          <div className="font-bold">Without parent/child structure, sub-tasks won&apos;t render as accordions and tasks won&apos;t group under phases.</div>
          <div>Most common causes:</div>
          <ol className="ml-4 list-decimal space-y-0.5">
            <li>The source file is genuinely flat (an exported punch list with no outline). Verify in your PM tool — in MS Project: <i>View → Outline → Show Outline</i>. If there&apos;s nothing to expand, the file itself has no structure.</li>
            <li>A CSV export dropped the outline columns. Re-export as XML (MS Project: File → Save As → XML) or P6 XML/XER, which always carry the hierarchy.</li>
          </ol>
        </div>
      )}
      {!noHierarchy && noDurations && (
        <div className="text-[11px] text-emerald-900 mt-1">
          Note: most rows don&apos;t carry start dates — only finish. Tasks will render as single-day on their finish date. Use the per-task <b>Set duration</b> action in the Execution view to expand the ones that take multiple days.
        </div>
      )}
    </div>
  );
}

function StatCell({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "muted" }) {
  const cls =
    tone === "ok"    ? "bg-[var(--color-surface)] border-emerald-200 text-emerald-900" :
    tone === "warn"  ? "bg-[var(--color-surface)] border-rose-200 text-rose-900" :
                       "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text)]";
  return (
    <div className={`rounded-md border px-2 py-1 ${cls}`}>
      <div className="text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">{label}</div>
      <div className="font-mono font-bold text-[12px]">{value}</div>
    </div>
  );
}
