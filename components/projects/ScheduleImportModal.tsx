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

import React, { useCallback, useRef, useState } from "react";
import {
  Upload, FileUp, X, Loader2, CheckCircle2, AlertTriangle,
  FileText, Calendar as CalIcon, FileWarning, ChevronRight,
} from "lucide-react";
import { parseScheduleFileFromBytes, type ParseResult, type ScheduleFormat } from "@/lib/scheduleParsers";
import { importMilestonesFromParsed } from "@/lib/milestones";
import type { MilestoneSource } from "@/types/schema";

interface Props {
  orgId: string;
  projectId: string;
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
  orgId, projectId, userId, userName, onClose, onDone,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ inserted: number; updated: number; skipped: number; errors: string[] } | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setParsing(true);
    setParseResult(null);
    setImportResult(null);
    setFilename(file.name);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const result = parseScheduleFileFromBytes(file.name, bytes);
      setParseResult(result);
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

  const submit = useCallback(async () => {
    if (!parseResult || parseResult.rows.length === 0) return;
    setImporting(true);
    try {
      const res = await importMilestonesFromParsed({
        orgId, projectId,
        source: FORMAT_TO_SOURCE[parseResult.format],
        rows: parseResult.rows.map((r) => ({
          name: r.name,
          plannedAt: r.plannedAt,
          weight: r.weight,
          description: r.description,
          externalRef: r.externalRef,
        })),
        createdBy: userId,
        createdByName: userName,
      });
      setImportResult(res);
      if (res.errors.length === 0 && (res.inserted > 0 || res.updated > 0)) {
        // Success — give the user a beat to read the result, then close.
        setTimeout(() => onDone(), 800);
      }
    } finally { setImporting(false); }
  }, [parseResult, orgId, projectId, userId, userName, onDone]);

  const canSubmit = !!parseResult && parseResult.rows.length > 0 && !importing;
  const previewRows = parseResult?.rows.slice(0, 8) ?? [];
  const moreCount = (parseResult?.rows.length ?? 0) - previewRows.length;

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-indigo-50 via-white to-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-md shadow-indigo-900/30">
              <Upload className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="font-black text-slate-900">Import schedule</h2>
              <div className="text-[11px] text-slate-600">Drop a file from MS Project, Primavera, or any CSV. We&apos;ll figure out the rest.</div>
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

              {/* MPP — dedicated "here's how to fix it" panel */}
              {parseResult.format === "msproject-mpp" && (
                <MppGuide filename={filename ?? ""} />
              )}

              {/* Warnings (suppress for MPP — the guide covers it) */}
              {parseResult.format !== "msproject-mpp" && parseResult.warnings.length > 0 && (
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

              {/* Preview table */}
              {parseResult.rows.length > 0 && (
                <div className="rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-black uppercase tracking-widest text-slate-600">
                    Preview · first {previewRows.length} {moreCount > 0 ? `of ${parseResult.rows.length}` : "row" + (previewRows.length === 1 ? "" : "s")}
                  </div>
                  <table className="w-full text-xs">
                    <thead className="bg-white border-b border-slate-200 text-[10px] font-black uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-1.5">Milestone</th>
                        <th className="text-left px-3 py-1.5 w-32">Due</th>
                        <th className="text-left px-3 py-1.5 w-20">% done</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {previewRows.map((r, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5">
                            <div className="font-bold text-slate-900 truncate">{r.name}</div>
                            {r.externalRef && <div className="text-[10px] font-mono text-slate-400 truncate">{r.externalRef}</div>}
                          </td>
                          <td className="px-3 py-1.5 text-slate-700">
                            <CalIcon className="inline w-3 h-3 mr-1 text-slate-400" />
                            {humanDate(r.plannedAt)}
                          </td>
                          <td className="px-3 py-1.5 text-slate-700 font-mono">{r.percentComplete != null ? `${Math.round(r.percentComplete)}%` : "—"}</td>
                        </tr>
                      ))}
                      {moreCount > 0 && (
                        <tr><td colSpan={3} className="px-3 py-1.5 text-[11px] text-slate-500 italic">+{moreCount} more row{moreCount === 1 ? "" : "s"} will be imported.</td></tr>
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

function humanDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch { return iso; }
}

// MppGuide — dedicated walkthrough shown when the user drops an
// .mpp file. The MPP container is a proprietary OLE2 compound
// binary format; there's no maintained pure-JS parser that handles
// modern Project versions reliably, so we don't pretend we can read
// it — but we make the conversion path so easy that the user is on
// their way in 15-30 seconds.
function MppGuide({ filename }: { filename: string }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 overflow-hidden">
      <div className="px-4 py-3 bg-gradient-to-r from-amber-100 to-amber-50 border-b border-amber-200 flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-lg bg-white border border-amber-300 flex items-center justify-center shrink-0">
          <FileWarning className="w-4 h-4 text-amber-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-black text-amber-900">.mpp is binary — quick convert to .xml</div>
          <div className="text-[11px] text-amber-800/80">
            Microsoft Project&apos;s native format is proprietary and can&apos;t be read in the browser. Save it as XML and we&apos;ll handle the rest.
          </div>
        </div>
      </div>
      <div className="p-4 space-y-3">
        <ol className="space-y-2.5 text-xs text-slate-700">
          <Step n={1}>
            Open <code className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200">{filename || "your schedule"}</code> in Microsoft Project.
          </Step>
          <Step n={2}>
            <b>File → Save As</b> (or press <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200">F12</kbd>).
          </Step>
          <Step n={3}>
            In the file-type dropdown, choose <b>XML Format (*.xml)</b>.
          </Step>
          <Step n={4}>
            Save it next to the original. Drop the new <code className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200">.xml</code> here — every task with a Finish date becomes a milestone we track.
          </Step>
        </ol>

        <details className="text-[11px] text-slate-600">
          <summary className="cursor-pointer font-bold hover:text-slate-900 inline-flex items-center gap-1">
            <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" /> Other options
          </summary>
          <div className="mt-2 ml-4 space-y-1 text-slate-600">
            <div>· <b>CSV:</b> <i>File → Save As → Text (Tab delimited)</i> or CSV. We accept either.</div>
            <div>· <b>P6 source:</b> if this schedule originated in Primavera, export the original P6 XML or XER instead — they carry more metadata than MS Project&apos;s round-trip.</div>
            <div>· <b>MPX:</b> the legacy text format. Some shops still use it for cross-tool transfer. We handle .mpx natively.</div>
          </div>
        </details>

        <div className="text-[10px] italic text-amber-800/80 border-t border-amber-200 pt-2 mt-2">
          The MPP container has been undocumented since Project 4 (1994). Open-source readers exist (Java&apos;s MPXJ, Python&apos;s mpp-parse) but no maintained pure-JavaScript one — adding a server-side conversion service is on the roadmap if XML export turns out to be too clunky for daily use.
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
