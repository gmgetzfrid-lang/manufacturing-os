"use client";

// CsvImportModal — bulk-create document records from a pasted CSV.
//
// Three steps:
//   1. Paste / drop a CSV. We parse on the client (no upload yet).
//   2. Map columns → library fields. Auto-suggest based on header name
//      (case-insensitive contains). Required: documentNumber + title.
//   3. Preview the first 10 rows + total count. Confirm to commit.
//
// Each row becomes an entry in `documents` with status='Draft' and no
// file attached. Use the standard upload flow afterwards to attach
// PDFs. Useful for backfilling legacy registers or pre-populating
// a library structure before files exist.

import React, { useMemo, useState } from "react";
import {
  X, FileText, Loader2, AlertTriangle, CheckCircle2, Upload, ChevronRight, ArrowLeft,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { computeUniquenessKey } from "@/lib/uniqueness";
import type { LibraryConfig } from "@/types/schema";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  library: LibraryConfig;
  orgId: string;
  collectionId?: string | null;
  actorUserId: string;
  onImported?: (count: number) => void;
}

// Canonical fields the modal will offer; custom columns come from the library.
const CANONICAL_FIELDS = [
  { key: "documentNumber", label: "Document Number *", required: true },
  { key: "title", label: "Title *", required: true },
  { key: "rev", label: "Revision" },
  { key: "status", label: "Status" },
];

type Step = "paste" | "map" | "preview" | "done";

interface ImportResult {
  ok: number;
  failed: Array<{ row: number; reason: string }>;
}

export default function CsvImportModal({
  isOpen, onClose, library, orgId, collectionId, actorUserId, onImported,
}: Props) {
  const [step, setStep] = useState<Step>("paste");
  const [raw, setRaw] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({}); // fieldKey → csvHeader
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const customColumns = useMemo(() => library.customColumns ?? [], [library.customColumns]);
  const allFields = useMemo(() => [
    ...CANONICAL_FIELDS,
    ...customColumns.map((c) => ({ key: c.key, label: c.label, required: !!c.required })),
  ], [customColumns]);

  if (!isOpen) return null;

  const parseCsv = () => {
    setError(null);
    const lines = raw.trim().split(/\r?\n/);
    if (lines.length < 2) { setError("Need a header row plus at least one data row."); return; }
    const splitLine = (line: string): string[] => {
      // Minimal CSV parser: handle quoted fields, doubled quotes as escape.
      const out: string[] = [];
      let cur = "";
      let i = 0;
      let inQuote = false;
      while (i < line.length) {
        const ch = line[i];
        if (inQuote) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 2; continue; }
          if (ch === '"') { inQuote = false; i++; continue; }
          cur += ch; i++; continue;
        } else {
          if (ch === '"') { inQuote = true; i++; continue; }
          if (ch === ",") { out.push(cur); cur = ""; i++; continue; }
          cur += ch; i++;
        }
      }
      out.push(cur);
      return out;
    };
    const hdr = splitLine(lines[0]).map((h) => h.trim());
    const data = lines.slice(1).map(splitLine);
    setHeaders(hdr);
    setRows(data);
    // Auto-suggest mapping
    const suggested: Record<string, string> = {};
    for (const f of allFields) {
      const match = hdr.find((h) => {
        const lh = h.toLowerCase();
        const lk = f.key.toLowerCase();
        const ll = f.label.toLowerCase().replace(/\*/g, "").trim();
        return lh === lk || lh === ll || lh.replace(/\s+/g, "") === lk;
      }) ?? hdr.find((h) => {
        const lh = h.toLowerCase();
        return lh.includes(f.key.toLowerCase());
      });
      if (match) suggested[f.key] = match;
    }
    setMapping(suggested);
    setStep("map");
  };

  const validateMapping = (): string | null => {
    for (const f of allFields) {
      if (f.required && !mapping[f.key]) {
        return `Field "${f.label}" is required — pick the CSV column that holds it.`;
      }
    }
    return null;
  };

  const goPreview = () => {
    const v = validateMapping();
    if (v) { setError(v); return; }
    setError(null);
    setStep("preview");
  };

  const commit = async () => {
    setBusy(true); setError(null);
    const failed: Array<{ row: number; reason: string }> = [];
    let ok = 0;
    const now = new Date().toISOString();
    const headerIndex: Record<string, number> = {};
    for (let i = 0; i < headers.length; i++) headerIndex[headers[i]] = i;

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const r = rows[rIdx];
      try {
        const pick = (fieldKey: string): string | undefined => {
          const h = mapping[fieldKey];
          if (!h) return undefined;
          return r[headerIndex[h]] ?? undefined;
        };
        const documentNumber = pick("documentNumber")?.trim();
        const title = pick("title")?.trim();
        if (!documentNumber || !title) {
          failed.push({ row: rIdx + 2, reason: "Missing required documentNumber or title" });
          continue;
        }
        const rev = pick("rev")?.trim() || "0";
        const status = pick("status")?.trim() || "Draft";
        const metadata: Record<string, unknown> = {};
        for (const c of customColumns) {
          const v = pick(c.key);
          if (v != null && v !== "") metadata[c.key] = v;
        }
        const uniquenessKey = computeUniquenessKey(
          { documentNumber, title, rev, status, customFields: metadata },
          library.uniquenessKeys,
        );
        const { error: insertErr } = await supabase.from("documents").insert({
          org_id: orgId,
          library_id: library.id,
          collection_id: collectionId ?? null,
          document_number: documentNumber,
          title,
          name: title,
          rev,
          status,
          metadata,
          uniqueness_key: uniquenessKey,
          created_at: now,
          created_by: actorUserId,
          updated_at: now,
          updated_by: actorUserId,
        });
        if (insertErr) throw insertErr;
        ok += 1;
      } catch (e) {
        failed.push({ row: rIdx + 2, reason: (e as Error).message });
      }
    }
    setResult({ ok, failed });
    setStep("done");
    setBusy(false);
    if (ok > 0) onImported?.(ok);
  };

  return (
    <div className="fixed inset-0 z-[400] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-100 text-blue-700"><FileText className="w-5 h-5" /></div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Import documents from CSV</div>
            <div className="text-xs text-[var(--color-text-muted)]">Bulk-create records (no files attached yet). Use this for backfilling legacy registers.</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {step === "paste" && (
            <div className="space-y-2">
              <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Paste CSV</label>
              <textarea
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                placeholder={`documentNumber,title,rev,status\n100-PID-001,Crude Cold Side,3,Issued\n100-PID-002,Crude Hot Side,0,Draft`}
                rows={10}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-mono"
              />
              <div className="text-[10px] text-[var(--color-text-muted)]">First row = column headers. Commas separate values; wrap a value in &quot;double quotes&quot; if it contains commas. The next step maps your columns to library fields.</div>
            </div>
          )}

          {step === "map" && (
            <div className="space-y-3">
              <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Map columns</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Detected {rows.length} data row{rows.length === 1 ? "" : "s"} across {headers.length} columns.</div>
              <div className="space-y-2">
                {allFields.map((f) => (
                  <div key={f.key} className="flex items-center gap-2">
                    <div className="w-44 text-xs font-bold text-[var(--color-text)]">{f.label}</div>
                    <select
                      value={mapping[f.key] ?? ""}
                      onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
                      className="flex-1 px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-xs"
                    >
                      <option value="">— skip —</option>
                      {headers.map((h, i) => <option key={i} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === "preview" && (
            <div>
              <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-2">Preview (first 10)</div>
              <div className="rounded-lg border border-[var(--color-border)] overflow-auto">
                <table className="w-full text-[11px]">
                  <thead className="bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
                    <tr>
                      {allFields.filter((f) => mapping[f.key]).map((f) => (
                        <th key={f.key} className="text-left px-2 py-1.5 font-black text-[var(--color-text)] uppercase tracking-wider text-[10px]">
                          {f.label.replace(/\*/g, "").trim()}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {rows.slice(0, 10).map((r, i) => (
                      <tr key={i}>
                        {allFields.filter((f) => mapping[f.key]).map((f) => {
                          const idx = headers.indexOf(mapping[f.key]);
                          return <td key={f.key} className="px-2 py-1.5 text-[var(--color-text)]">{r[idx] ?? ""}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 10 && <div className="text-[10px] text-[var(--color-text-muted)] mt-1">+ {rows.length - 10} more row{rows.length - 10 === 1 ? "" : "s"} will be imported.</div>}
            </div>
          )}

          {step === "done" && result && (
            <div className="space-y-2">
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                Imported <b>{result.ok}</b> document record{result.ok === 1 ? "" : "s"}.
              </div>
              {result.failed.length > 0 && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-800">
                  <div className="font-bold flex items-center gap-1.5 mb-1"><AlertTriangle className="w-4 h-4" /> {result.failed.length} failed</div>
                  <ul className="ml-5 list-disc space-y-0.5">
                    {result.failed.slice(0, 8).map((f, i) => (
                      <li key={i}>Row {f.row}: {f.reason}</li>
                    ))}
                    {result.failed.length > 8 && <li className="italic">+{result.failed.length - 8} more</li>}
                  </ul>
                </div>
              )}
              <div className="text-[10px] text-[var(--color-text-muted)]">No files were uploaded. Use the regular upload flow to attach PDFs to each record.</div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between gap-2">
          {step !== "paste" && step !== "done" && (
            <button
              onClick={() => setStep(step === "preview" ? "map" : "paste")}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
              {step === "done" ? "Close" : "Cancel"}
            </button>
            {step === "paste" && (
              <button onClick={parseCsv} disabled={!raw.trim()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold disabled:opacity-50">
                Continue <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
            {step === "map" && (
              <button onClick={goPreview} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold">
                Preview <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
            {step === "preview" && (
              <button onClick={commit} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold disabled:opacity-50">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {busy ? "Importing…" : `Import ${rows.length} record${rows.length === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
