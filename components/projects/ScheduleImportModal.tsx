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
// Flow: drop or pick file → parse → preview rows → confirm import.
// The parse happens entirely in the browser; nothing leaves the
// client until the user clicks "Import N milestones".
//
// Replaces the previous "paste a CSV blob into a textarea and hope
// you picked the right source" UX, which fell over on the most
// common case: a direct export from MS Project.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Upload, FileUp, X, Loader2, CheckCircle2, AlertTriangle,
  FileText, Calendar as CalIcon, ChevronRight,
  Columns3, ArrowRight, Link2,
} from "lucide-react";
import { parseScheduleFileFromBytes, reconstructHierarchyFromOutline, dropPlaceholderLeaves, type ParseResult, type ScheduleFormat } from "@/lib/scheduleParsers";
import { importMilestonesFromParsed } from "@/lib/milestones";
import type { MilestoneSource } from "@/types/schema";
import { supabase } from "@/lib/supabase";

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
  "msproject-mpp": "Microsoft Project · MPP (binary)",
  "msproject-mpx": "Microsoft Project · MPX",
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
  const [importResult, setImportResult] = useState<{ inserted: number; updated: number; skipped: number; errors: string[] } | null>(null);
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
    setFilename(file.name);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const result = parseScheduleFileFromBytes(file.name, bytes);

      // MPP: ship to the server route for binary conversion. Pure-JS
      // can't parse OLE2 compound binaries client-side.
      if (result.format === "msproject-mpp") {
        const converted = await convertMppOnServer(file.name, buf);
        setParseResult(converted);
      } else {
        setParseResult(result);
      }
    } catch (e) {
      setParseResult({
        format: "unknown",
        rows: [],
        warnings: [`Couldn't read the file: ${(e as Error).message}`],
      });
    } finally { setParsing(false); }
  }, []);

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

  const submit = useCallback(async () => {
    if (!parseResult || parseResult.rows.length === 0) return;
    setImporting(true);
    try {
      const shaped = parseResult.rows.map(applyColConfig);
      const res = await importMilestonesFromParsed({
        orgId, projectId,
        source: FORMAT_TO_SOURCE[parseResult.format],
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
          weight: r.weight,
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
      setImportResult(res);
      // Only auto-close when at least one row was actually INSERTED
      // into this project. Pure-update results (which happen when
      // the same .mpp gets re-imported into a project that already
      // owns those external_refs) leave the panel open so the user
      // can verify what landed. Caught a real bug where users
      // re-imported into a fresh project and saw nothing because
      // every row was an update to a different project's rows.
      const cleanWin = res.errors.length === 0 && res.inserted > 0;
      if (cleanWin) {
        setTimeout(() => onDone(), 800);
      }
    } finally { setImporting(false); }
  }, [parseResult, orgId, projectId, userId, userName, onDone, applyColConfig]);

  const canSubmit = !!parseResult && parseResult.rows.length > 0 && !importing;
  const previewRows = parseResult?.rows.slice(0, 8) ?? [];
  const moreCount = (parseResult?.rows.length ?? 0) - previewRows.length;

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-indigo-50 via-white to-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-md shadow-indigo-900/30">
              <Upload className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h2 className="font-black text-slate-900">Import schedule</h2>
              <div className="text-[11px] text-slate-600 inline-flex items-center gap-1.5">
                <span>Importing into</span>
                <span className="font-bold text-slate-900 truncate max-w-[200px]">{projectName ?? `Project ${projectId.slice(0,8)}`}</span>
                {projectStatus && projectStatus !== "active" && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-rose-100 text-rose-800 border border-rose-200">
                    <AlertTriangle className="w-2.5 h-2.5" /> {projectStatus}
                  </span>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-200 text-slate-500">
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
                  ? "border-indigo-500 bg-indigo-50/60 scale-[1.01]"
                  : "border-slate-300 bg-slate-50/40 hover:border-indigo-400 hover:bg-indigo-50/30"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".xml,.xer,.csv,.txt,.mpp,.mpx,application/xml,text/xml,text/csv,text/plain,application/vnd.ms-project"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
              />
              {parsing ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                  <div className="text-sm font-bold text-slate-700">Reading {filename}…</div>
                </div>
              ) : (
                <>
                  <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center mb-3 border border-indigo-200/60">
                    <FileUp className="w-8 h-8 text-indigo-600" />
                  </div>
                  <div className="text-base font-black text-slate-900">Drop your schedule here</div>
                  <div className="text-sm text-slate-600 mt-1">or click to pick a file</div>
                  <div className="mt-4 flex items-center justify-center gap-2 flex-wrap">
                    <FormatBadge label=".xml" hint="MS Project / P6 XML" />
                    <FormatBadge label=".xer" hint="Primavera P6 native" />
                    <FormatBadge label=".mpx" hint="Legacy MS Project" />
                    <FormatBadge label=".csv" hint="Direct export or generic" />
                  </div>
                  <div className="mt-2 text-[10px] text-slate-500">
                    .mpp is supported with a one-time export step — drop it to see how.
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              {/* File header strip */}
              <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                <div className="w-9 h-9 rounded-lg bg-white border border-slate-200 flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4 text-slate-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-slate-900 truncate">{filename}</div>
                  <div className="text-[11px] text-slate-500">{FORMAT_LABEL[parseResult.format]} · {parseResult.rows.length} milestone{parseResult.rows.length === 1 ? "" : "s"} found</div>
                </div>
                <button
                  onClick={() => { setParseResult(null); setFilename(null); setImportResult(null); }}
                  className="text-[11px] font-bold text-slate-500 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-200"
                  disabled={importing}
                >
                  Choose another
                </button>
              </div>

              {/* .mpp that isn't a true 1:1 conversion shows ONLY the XML-export
                  guide — never partial/approximate task data. (Server discards
                  anything but a full-fidelity remote conversion.) */}
              {parseResult.format === "msproject-mpp" && parseResult.rows.length === 0 && (
                <MppGuide filename={filename ?? ""} />
              )}

              {/* Warnings — always show when we have rows OR when the
                  format isn't the MPP-no-rows case the guide covers. */}
              {!(parseResult.format === "msproject-mpp" && parseResult.rows.length === 0) && parseResult.warnings.length > 0 && (
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
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Columns3 className="w-3.5 h-3.5 text-slate-500" />
                    <span className="text-xs font-black text-slate-800">{detectedColumns.length} extra column{detectedColumns.length === 1 ? "" : "s"} detected</span>
                  </div>
                  <p className="text-[11px] text-slate-500 mb-2.5">Rename, drop, or map any of these to a built-in field before importing. Everything else is kept on each task as a custom field.</p>
                  <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                    {detectedColumns.map((k) => {
                      const cfg = colConfig[k] ?? { include: true, rename: k, mapTo: "" };
                      return (
                        <div key={k} className={`flex items-center gap-2 ${cfg.include ? "" : "opacity-50"}`}>
                          <input type="checkbox" checked={cfg.include} onChange={(e) => setColConfig((p) => ({ ...p, [k]: { ...cfg, include: e.target.checked } }))} className="w-3.5 h-3.5 accent-indigo-600 shrink-0" title="Include this column" />
                          <span className="font-mono text-[11px] text-slate-500 w-28 truncate shrink-0" title={k}>{k}</span>
                          <ArrowRight className="w-3 h-3 text-slate-300 shrink-0" />
                          <input
                            value={cfg.rename}
                            onChange={(e) => setColConfig((p) => ({ ...p, [k]: { ...cfg, rename: e.target.value } }))}
                            disabled={!cfg.include || !!cfg.mapTo}
                            placeholder={k}
                            className="flex-1 min-w-0 h-7 px-2 rounded-md border border-slate-200 text-xs disabled:bg-slate-50 disabled:text-slate-400"
                          />
                          <select
                            value={cfg.mapTo}
                            onChange={(e) => setColConfig((p) => ({ ...p, [k]: { ...cfg, mapTo: e.target.value } }))}
                            disabled={!cfg.include}
                            className="h-7 px-1.5 rounded-md border border-slate-200 text-[11px] bg-white shrink-0"
                          >
                            <option value="">Keep as field</option>
                            <option value="responsibleParty">→ Resource / responsible</option>
                            <option value="responsibleOrg">→ Department / org</option>
                            <option value="location">→ Location / area</option>
                            <option value="workOrderRef">→ Work order</option>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Preview table */}
              {parseResult.rows.length > 0 && (
                <div className="rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-black uppercase tracking-widest text-slate-600">
                    Preview · first {previewRows.length} {moreCount > 0 ? `of ${parseResult.rows.length}` : "row" + (previewRows.length === 1 ? "" : "s")}
                  </div>
                  <table className="w-full text-xs">
                    <thead className="bg-white border-b border-slate-200 text-[10px] font-black uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-1.5">Task</th>
                        <th className="text-left px-3 py-1.5 w-32">Due</th>
                        <th className="text-left px-3 py-1.5 w-16">Parent</th>
                        <th className="text-left px-3 py-1.5 w-12">Lvl</th>
                        <th className="text-left px-3 py-1.5 w-16">% done</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {previewRows.map((r, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5">
                            <div className="font-bold text-slate-900 truncate flex items-center gap-1">
                              {r.isSummary && <span className="text-[9px] font-black bg-indigo-100 text-indigo-700 px-1 rounded shrink-0">SUM</span>}
                              <span className="truncate">{r.name}</span>
                              {(r.dependsOnExternalRefs?.length ?? 0) > 0 && (
                                <span
                                  className="inline-flex items-center gap-0.5 text-[9px] font-black bg-indigo-50 text-indigo-600 px-1 rounded shrink-0"
                                  title={`${r.dependsOnExternalRefs!.length} predecessor link${r.dependsOnExternalRefs!.length === 1 ? "" : "s"} from the source schedule`}
                                >
                                  <Link2 className="w-2.5 h-2.5" />{r.dependsOnExternalRefs!.length}
                                </span>
                              )}
                            </div>
                            {r.externalRef && <div className="text-[10px] font-mono text-slate-400 truncate">{r.externalRef}</div>}
                          </td>
                          <td className="px-3 py-1.5 text-slate-700">
                            <CalIcon className="inline w-3 h-3 mr-1 text-slate-400" />
                            {humanDate(r.plannedAt)}
                          </td>
                          <td className="px-3 py-1.5 text-[10px] font-mono text-slate-600 truncate">
                            {r.parentExternalRef ? r.parentExternalRef.split(":")[1] : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-slate-700 font-mono">{r.outlineLevel ?? <span className="text-slate-300">—</span>}</td>
                          <td className="px-3 py-1.5 text-slate-700 font-mono">{r.percentComplete != null ? `${Math.round(r.percentComplete)}%` : <span className="text-slate-300">—</span>}</td>
                        </tr>
                      ))}
                      {moreCount > 0 && (
                        <tr><td colSpan={5} className="px-3 py-1.5 text-[11px] text-slate-500 italic">+{moreCount} more row{moreCount === 1 ? "" : "s"} will be imported.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Import result */}
              {importResult && (
                <div className={`rounded-xl p-3 border ${importResult.errors.length > 0 ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}>
                  <div className="flex items-center gap-2 font-bold text-sm">
                    {importResult.errors.length > 0
                      ? <><AlertTriangle className="w-4 h-4 text-rose-600" /> Imported with errors</>
                      : <><CheckCircle2 className="w-4 h-4 text-emerald-600" /> Imported successfully</>
                    }
                  </div>
                  <div className="mt-1 text-xs space-y-0.5">
                    <div>Inserted: <b>{importResult.inserted}</b></div>
                    <div>Updated: <b>{importResult.updated}</b></div>
                    {importResult.skipped > 0 && <div>Skipped: <b>{importResult.skipped}</b></div>}
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
          <div className="text-[11px] text-slate-500 italic">
            One-way import. We never write back to your PM tool. Re-importing the same file upserts rows with stable IDs.
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Close</button>
          {parseResult && parseResult.rows.length > 0 && !importResult && (
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg shadow-sm disabled:opacity-40"
            >
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              Import {parseResult.rows.length} milestone{parseResult.rows.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function FormatBadge({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="inline-flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-md bg-white border border-slate-200">
      <span className="text-[11px] font-mono font-black text-slate-700">{label}</span>
      <span className="text-[9px] text-slate-500">{hint}</span>
    </div>
  );
}

/** Find the value of the first custom field whose label matches a
 *  pattern. Used to lift headline pills (WO#, contractor, location)
 *  out of the generic attributes bag while staying org-agnostic. */
function pickField(fields: Record<string, string> | undefined, pattern: RegExp): string | null {
  if (!fields) return null;
  for (const [key, val] of Object.entries(fields)) {
    if (pattern.test(key) && val && String(val).trim()) return String(val).trim();
  }
  return null;
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

// MppGuide — shown when a dropped .mpp can't be read at full fidelity in the
// browser/Vercel. Leads with the XML export, which is the zero-infrastructure
// path to a true 1:1 import (it carries every dependency, resource, exact date,
// and the full hierarchy) and works on a plain Vercel deploy. The server-side
// converter is offered second, for teams that can host Java and want to drag
// .mpp files directly.
function MppGuide({ filename }: { filename: string }) {
  const RENDER_DEPLOY = "https://render.com/deploy?repo=https://github.com/gmgetzfrid-lang/manufacturing-os";
  return (
    <div className="rounded-xl border border-indigo-300 bg-indigo-50/60 overflow-hidden">
      <div className="px-4 py-3 bg-gradient-to-r from-indigo-100 to-indigo-50 border-b border-indigo-200 flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-lg bg-white border border-indigo-300 flex items-center justify-center shrink-0">
          <FileText className="w-4 h-4 text-indigo-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-black text-indigo-900">One quick step for a perfect 1:1 import</div>
          <div className="text-[11px] text-indigo-800/80">
            A binary <code className="font-mono">.mpp</code> can&apos;t be read losslessly in the browser, but MS Project&apos;s
            XML export can — it carries every date, dependency, resource, and phase. Takes ~15 seconds, no setup.
          </div>
        </div>
      </div>
      <div className="p-4 space-y-3">
        {/* Primary path: XML export — zero infrastructure, true 1:1. */}
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3">
          <div className="text-xs font-black text-emerald-900 uppercase tracking-widest mb-2">Recommended · no setup, exact copy</div>
          <ol className="space-y-1.5 text-xs text-emerald-900/90">
            <Step n={1}>
              Open <code className="font-mono bg-white px-1.5 py-0.5 rounded border border-emerald-200 text-[10px]">{filename || "your schedule"}</code> in Microsoft Project.
            </Step>
            <Step n={2}>
              <b>File → Save As</b> (or <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-emerald-200">F12</kbd>) → choose <b>XML Format (*.xml)</b> and save.
            </Step>
            <Step n={3}>
              Drag that new <code className="font-mono bg-white px-1.5 py-0.5 rounded border border-emerald-200 text-[10px]">.xml</code> file right here. It imports with all dependencies, resources, and exact dates.
            </Step>
          </ol>
        </div>

        {/* Secondary: server-side converter for teams that can host Java. */}
        <details className="rounded-lg border border-slate-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1 list-none">
            <ChevronRight className="w-3 h-3" />
            Want to drop <code className="font-mono">.mpp</code> directly (no export step)? Run the converter
          </summary>
          <div className="px-3 pb-3 space-y-2">
            <p className="text-[11px] text-slate-600 leading-relaxed">
              Reading <code className="font-mono">.mpp</code> binaries needs the Java-based MPXJ engine, which Vercel can&apos;t run.
              You can host it as a small free service and point the app at it — then <code className="font-mono">.mpp</code> files
              import directly at full fidelity. This is optional and requires a host that runs containers/Java.
            </p>
            <ol className="space-y-1.5 text-xs text-slate-700">
              <Step n={1}>
                <a href={RENDER_DEPLOY} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-700 hover:bg-slate-800 text-white font-bold shadow-sm">
                  Deploy the converter to Render <ChevronRight className="w-3 h-3" />
                </a>
                <span className="ml-1 text-slate-500">free tier</span>
              </Step>
              <Step n={2}>
                Add its URL (and token) to your app env as{" "}
                <code className="font-mono bg-slate-50 px-1 rounded border border-slate-200 text-[10px]">MPP_CONVERTER_URL</code> /{" "}
                <code className="font-mono bg-slate-50 px-1 rounded border border-slate-200 text-[10px]">MPP_CONVERTER_TOKEN</code>, then redeploy.
              </Step>
            </ol>
            <p className="text-[10px] text-slate-500 italic">
              Full instructions (incl. a one-image self-hosted option) are in <code className="font-mono">docs/SELF_HOST_DOCKER.md</code> and <code className="font-mono">docs/ENABLE_MPP_IMPORT.md</code>.
            </p>
          </div>
        </details>
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

// ─── MPP server conversion ─────────────────────────────────────
// Send a raw .mpp upload to /api/schedule/convert-mpp and shape
// the response into the same ParseResult contract the rest of the
// modal expects. Falls back to the static MppGuide panel only if
// the server says "no_tasks" — meaning the native parser couldn't
// pull anything useful and the user really does need to do the
// XML conversion dance.
async function convertMppOnServer(filename: string, buf: ArrayBuffer): Promise<ParseResult> {
  let token: string | undefined;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    token = session?.access_token;
  } catch { /* swallow — request will fail with 401 below */ }

  if (!token) {
    return {
      format: "msproject-mpp",
      rows: [],
      warnings: ["Not signed in — can't reach the server-side MPP converter."],
    };
  }

  try {
    const res = await fetch("/api/schedule/convert-mpp", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${token}`,
      },
      body: buf,
    });
    const json = await res.json() as {
      ok: boolean;
      status: string;
      via?: "remote" | "native" | "tsmpp" | null;
      message?: string | null;
      projectName?: string | null;
      tasks: Array<{
        uid: number | null;
        parentUid?: number | null;
        name: string;
        start: string | null; finish: string | null;
        outlineLevel?: number | null;
        wbs?: string | null;
        isSummary?: boolean;
        percentComplete: number | null; isMilestone: boolean;
        workHours?: number | null;
        notes?: string | null;
        resources?: string | null;
        predecessors?: number[];
        fields?: Record<string, string>;
      }>;
    };

    if (!res.ok || !json.ok) {
      return {
        format: "msproject-mpp",
        rows: [],
        warnings: [],
      };
    }

    // Hard rule: NEVER show approximate .mpp data. Only a true 1:1 conversion
    // (the MPXJ converter, via="remote") is trusted enough to display. The
    // in-process reader and heuristic are partial — discard them entirely and
    // send the user to the lossless XML export, so they never look at a schedule
    // that isn't exactly their file.
    if (json.via !== "remote") {
      return { format: "msproject-mpp", rows: [], warnings: [], via: json.via ?? undefined };
    }

    const rows = json.tasks
      .map((t) => {
        const planned = t.finish ?? t.start;
        if (!t.name || !planned) return null;
        const descParts: string[] = [];
        if (t.isMilestone) descParts.push("Milestone task");
        if (t.isSummary) descParts.push("Summary (rolls up children)");

        // Build the self-describing attributes bag from every custom
        // column + resources + predecessors + notes the converter sent.
        const attributes: Record<string, string> = { ...(t.fields ?? {}) };
        if (t.resources) attributes["Resources"] = t.resources;
        if (t.predecessors && t.predecessors.length > 0) attributes["Predecessors"] = t.predecessors.join(", ");
        if (t.notes) attributes["Notes"] = t.notes;
        if (t.isMilestone) attributes["milestone"] = "1"; // internal flag → Gantt diamond

        // Light heuristics to lift headline pills out of the bag. Any
        // labeled column matching these patterns is surfaced as a
        // first-class field; it still stays in attributes too.
        const wo = pickField(t.fields, /work\s*order|^wo\b|wo\s*#|wo[_-]?num|order\s*#/i);
        const contractor = pickField(t.fields, /contractor|vendor|company/i);
        const dept = pickField(t.fields, /department|dept|discipline|craft|crew/i);
        const loc = pickField(t.fields, /location|area|unit|equipment|tag/i);

        return {
          name: t.name,
          plannedAt: planned,
          plannedStartAt: t.start ?? null,
          weight: 1,
          description: descParts.length > 0 ? descParts.join(" · ") : null,
          externalRef: t.uid != null ? `msp-uid:${t.uid}` : null,
          parentExternalRef: t.parentUid != null ? `msp-uid:${t.parentUid}` : null,
          dependsOnExternalRefs: (t.predecessors ?? []).map((uid) => `msp-uid:${uid}`),
          outlineLevel: t.outlineLevel ?? null,
          wbs: t.wbs ?? null,
          isSummary: !!t.isSummary,
          percentComplete: t.percentComplete ?? undefined,
          workOrderRef: wo,
          responsibleParty: t.resources ?? null,
          responsibleOrg: contractor ?? dept ?? null,
          responsibleKind: contractor ? "contractor" : (dept ? "employee" : null),
          location: loc,
          durationHours: t.workHours ?? null,
          attributes,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // The MPXJ converter (Server.java) nulls a task's parent when that
    // parent is the project-summary row (MS Project ID 0), which
    // orphans every top-level phase — they come back with parentUid
    // null and render flat. The converter still reports correct
    // outline levels, so rebuild the parent links from those. This
    // only fills gaps; deeper parent links the converter got right are
    // left alone. Fixes the "hierarchy severed at the top" import bug.
    reconstructHierarchyFromOutline(rows);

    // Drop MS Project's "<New Task>" placeholder rows (unnamed leaves).
    const cleaned = dropPlaceholderLeaves(rows);
    const finalRows = cleaned.rows;

    const warnings: string[] = [];
    // Make it unmistakable which parser produced this — ends the "is my
    // We only reach here for a true 1:1 conversion (via="remote"); partial
    // reads were already discarded above. Confirm the full-fidelity import.
    warnings.push("✓ Parsed via your MPXJ converter — full fidelity (dependencies, resources, exact dates).");
    if (cleaned.dropped > 0) {
      warnings.push(`${cleaned.dropped} unnamed "<New Task>" placeholder row${cleaned.dropped === 1 ? "" : "s"} dropped.`);
    }

    return {
      format: "msproject-mpp",
      rows: finalRows,
      warnings,
      via: json.via ?? undefined,
    };
  } catch {
    return {
      format: "msproject-mpp",
      rows: [],
      warnings: [],
    };
  }
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
      <div className="grid grid-cols-4 gap-2 text-[11px]">
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
            <li>The Render MPXJ converter is running an older build. Go to your Render dashboard → mpxj-converter → <b>Manual Deploy</b> → <b>Deploy latest commit</b> → wait ~2 min for the build to finish → drop the file here again.</li>
            <li>The .mpp file is genuinely flat (an exported punch list with no outline). Verify in MS Project: <i>View → Outline → Show Outline</i>. If there&apos;s nothing to expand, the file itself has no structure.</li>
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
    tone === "ok"    ? "bg-white border-emerald-200 text-emerald-900" :
    tone === "warn"  ? "bg-white border-rose-200 text-rose-900" :
                       "bg-white border-slate-200 text-slate-700";
  return (
    <div className={`rounded-md border px-2 py-1 ${cls}`}>
      <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
      <div className="font-mono font-bold text-[12px]">{value}</div>
    </div>
  );
}
