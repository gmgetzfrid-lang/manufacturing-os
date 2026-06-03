"use client";

// AssetCsvImportModal — bulk-create assets from a pasted CSV.
//
// Same 3-step shape as CsvImportModal for documents. Maps to the
// canonical Asset fields plus asset_type lookup by name.

import React, { useEffect, useMemo, useState } from "react";
import {
  X, KeyRound, Loader2, AlertTriangle, CheckCircle2, Upload, ChevronRight, ArrowLeft,
} from "lucide-react";
import { createAsset, listAssetTypes, type AssetType } from "@/lib/assets";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  orgId: string;
  actorUserId: string;
  onImported?: (count: number) => void;
}

const CANONICAL_FIELDS = [
  { key: "tag", label: "Tag *", required: true },
  { key: "description", label: "Description" },
  { key: "location", label: "Location" },
  { key: "type", label: "Type (name)" },
];

type Step = "paste" | "map" | "preview" | "done";

interface ImportResult {
  ok: number;
  failed: Array<{ row: number; reason: string }>;
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = ""; let i = 0; let inQuote = false;
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
}

export default function AssetCsvImportModal({
  isOpen, onClose, orgId, actorUserId, onImported,
}: Props) {
  const [step, setStep] = useState<Step>("paste");
  const [raw, setRaw] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [types, setTypes] = useState<AssetType[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    if (!isOpen || !orgId) return;
    void listAssetTypes(orgId).then(setTypes).catch(() => { /* ignore */ });
  }, [isOpen, orgId]);

  const typeByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of types) m.set(t.name.toLowerCase(), t.id);
    return m;
  }, [types]);

  if (!isOpen) return null;

  const parseCsv = () => {
    setError(null);
    const lines = raw.trim().split(/\r?\n/);
    if (lines.length < 2) { setError("Need a header row plus at least one data row."); return; }
    const hdr = splitLine(lines[0]).map((h) => h.trim());
    const data = lines.slice(1).map(splitLine);
    setHeaders(hdr);
    setRows(data);
    const suggested: Record<string, string> = {};
    for (const f of CANONICAL_FIELDS) {
      const match = hdr.find((h) => {
        const lh = h.toLowerCase();
        return lh === f.key.toLowerCase() || lh.includes(f.key.toLowerCase());
      });
      if (match) suggested[f.key] = match;
    }
    setMapping(suggested);
    setStep("map");
  };

  const goPreview = () => {
    for (const f of CANONICAL_FIELDS) {
      if (f.required && !mapping[f.key]) { setError(`"${f.label}" is required`); return; }
    }
    setError(null);
    setStep("preview");
  };

  const commit = async () => {
    setBusy(true); setError(null);
    const failed: Array<{ row: number; reason: string }> = [];
    let ok = 0;
    const headerIndex: Record<string, number> = {};
    for (let i = 0; i < headers.length; i++) headerIndex[headers[i]] = i;

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const r = rows[rIdx];
      try {
        const pick = (k: string): string | undefined => {
          const h = mapping[k];
          if (!h) return undefined;
          return r[headerIndex[h]] ?? undefined;
        };
        const tag = pick("tag")?.trim();
        if (!tag) { failed.push({ row: rIdx + 2, reason: "Missing tag" }); continue; }
        const description = pick("description")?.trim() || undefined;
        const location = pick("location")?.trim() || undefined;
        const typeName = pick("type")?.trim().toLowerCase();
        const typeId = typeName ? typeByName.get(typeName) : undefined;
        await createAsset({
          orgId, tag, description, location,
          typeId, createdBy: actorUserId,
        });
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
    <div className="fixed inset-0 z-[400] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-purple-100 text-purple-700"><KeyRound className="w-5 h-5" /></div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-slate-900">Import assets from CSV</div>
            <div className="text-xs text-slate-500">Bulk-create equipment tags with type, description, and location.</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-900">
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
              <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Paste CSV</label>
              <textarea
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                placeholder={`tag,type,description,location\nP-101,Pump,Crude charge pump,Unit 100\nV-201,Vessel,Reflux drum,Unit 200`}
                rows={10}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-mono"
              />
              <div className="text-[10px] text-slate-500">First row = headers. The <code>type</code> column matches an existing asset-type by name (case-insensitive); unmatched types are left blank.</div>
            </div>
          )}

          {step === "map" && (
            <div className="space-y-3">
              <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Map columns</div>
              <div className="text-[11px] text-slate-600">Detected {rows.length} data row{rows.length === 1 ? "" : "s"} · {headers.length} columns.</div>
              <div className="space-y-2">
                {CANONICAL_FIELDS.map((f) => (
                  <div key={f.key} className="flex items-center gap-2">
                    <div className="w-44 text-xs font-bold text-slate-700">{f.label}</div>
                    <select
                      value={mapping[f.key] ?? ""}
                      onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
                      className="flex-1 px-2 py-1.5 rounded border border-slate-200 bg-white text-xs"
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
              <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest mb-2">Preview (first 10)</div>
              <div className="rounded-lg border border-slate-200 overflow-auto">
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      {CANONICAL_FIELDS.filter((f) => mapping[f.key]).map((f) => (
                        <th key={f.key} className="text-left px-2 py-1.5 font-black text-slate-700 uppercase tracking-wider text-[10px]">
                          {f.label.replace(/\*/g, "").trim()}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.slice(0, 10).map((r, i) => (
                      <tr key={i}>
                        {CANONICAL_FIELDS.filter((f) => mapping[f.key]).map((f) => {
                          const idx = headers.indexOf(mapping[f.key]);
                          return <td key={f.key} className="px-2 py-1.5 text-slate-700">{r[idx] ?? ""}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 10 && <div className="text-[10px] text-slate-500 mt-1">+ {rows.length - 10} more row{rows.length - 10 === 1 ? "" : "s"} will be imported.</div>}
            </div>
          )}

          {step === "done" && result && (
            <div className="space-y-2">
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                Created <b>{result.ok}</b> asset{result.ok === 1 ? "" : "s"}.
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
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
          {step !== "paste" && step !== "done" && (
            <button onClick={() => setStep(step === "preview" ? "map" : "paste")} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100">
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
              <button onClick={commit} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold disabled:opacity-50">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {busy ? "Importing…" : `Create ${rows.length} asset${rows.length === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
