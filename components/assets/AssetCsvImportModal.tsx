"use client";

// AssetCsvImportModal — the master equipment list door: paste a CSV, map
// its columns, preview exactly what lands where, then import.
//
// Same 3-step shape as CsvImportModal for documents. Maps to the canonical
// Asset fields plus asset_type lookup by name, AND the codebook identity
// (BR-4 / AREA-7): a unit column (codebook code or name) files each row
// into its operating area, a site-code column decodes the unit when no unit
// column is given, and the code is derived once the unit is known. A tag
// already in the registry is skipped or updated — the choice is the user's,
// counted before anything is written (BR-6). The plan is the pure
// lib/assetCategorize.ts planAssetImport.

import React, { useEffect, useMemo, useState } from "react";
import {
  X, KeyRound, Loader2, AlertTriangle, CheckCircle2, Upload, ChevronRight, ArrowLeft,
} from "lucide-react";
import {
  createAsset, updateAsset, listAssetTypes, findAssetsByTagKeys, listAssetIdentities, type Asset, type AssetType,
} from "@/lib/assets";
import { loadCodebook, tagKey, EMPTY_CODEBOOK, type Codebook } from "@/lib/codebook";
import { planAssetImport, type ImportMode, type ImportPlan, type ImportRowInput } from "@/lib/assetCategorize";
import { translatePostgresError } from "@/lib/inputValidation";
import { supabase } from "@/lib/supabase";

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
  { key: "unit", label: "Operating unit (code or name)", match: ["unit", "area", "operating"] },
  { key: "code", label: "Site code", match: ["site code", "sitecode", "site_code", "code"] },
] as Array<{ key: string; label: string; required?: boolean; match?: string[] }>;

type Step = "paste" | "map" | "preview" | "done";

interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  /** Rows written into an operating area. */
  filed: number;
  /** CB-10: rows that landed WITHOUT the site code they would have carried
   *  (another asset already carries it — one site code is one asset). */
  codeless: Array<{ row: number; tag: string; code: string }>;
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
  const [book, setBook] = useState<Codebook>(EMPTY_CODEBOOK);
  const [existing, setExisting] = useState<Map<string, Pick<Asset, "id" | "unit_code" | "code">> | null>(null);
  // CB-10: site code → the registry asset carrying it (archived included).
  const [codeHolders, setCodeHolders] = useState<Map<string, { id: string; tag: string }>>(new Map());
  // A workbook's rows carry their real sheet row numbers (title blocks and
  // blank rows counted); a pasted CSV's are its line numbers.
  const [rowNumbers, setRowNumbers] = useState<number[] | null>(null);
  const [mode, setMode] = useState<ImportMode>("create_only");
  // The spreadsheet door: an .xlsx / .xls / .csv read server-side by
  // lib/xlsxData.ts parseWorkbook (POST /api/assets/parse-workbook).
  const [workbook, setWorkbook] = useState<{ fileName: string; b64: string; sheetNames: string[]; sheetName: string } | null>(null);

  useEffect(() => {
    if (!isOpen || !orgId) return;
    void listAssetTypes(orgId).then(setTypes).catch(() => { /* ignore */ });
    void loadCodebook(orgId).then(setBook).catch(() => { /* no codebook → no opinion */ });
  }, [isOpen, orgId]);

  const inputs: ImportRowInput[] = useMemo(() => {
    const headerIndex: Record<string, number> = {};
    for (let i = 0; i < headers.length; i++) headerIndex[headers[i]] = i;
    const pick = (r: string[], k: string): string | undefined => {
      const h = mapping[k];
      if (!h) return undefined;
      return r[headerIndex[h]] ?? undefined;
    };
    return rows.map((r, rIdx) => ({
      row: rowNumbers?.[rIdx] ?? rIdx + 2,
      tag: pick(r, "tag")?.trim() ?? "",
      description: pick(r, "description"),
      location: pick(r, "location"),
      typeName: pick(r, "type"),
      unit: pick(r, "unit"),
      code: pick(r, "code"),
    }));
  }, [rows, headers, mapping, rowNumbers]);

  const plan: ImportPlan | null = useMemo(
    () => (existing ? planAssetImport(inputs, { book, types, existing, mode, codeHolders }) : null),
    [existing, inputs, book, types, mode, codeHolders]);

  if (!isOpen) return null;

  // Headers + rows from either door, then the same column suggestion.
  const applyTable = (hdr: string[], data: string[][], sheetRowNumbers: number[] | null = null) => {
    setHeaders(hdr);
    setRows(data);
    setRowNumbers(sheetRowNumbers && sheetRowNumbers.length === data.length ? sheetRowNumbers : null);
    const suggested: Record<string, string> = {};
    const used = new Set<string>();
    const wordsOf = (f: (typeof CANONICAL_FIELDS)[number]) => [f.key.toLowerCase(), ...(f.match ?? [])];
    // Exact header names first ("Site code", "Unit"), then containment in
    // field order — so "Unit Code" files as the unit, not as a site code.
    for (const pass of ["exact", "contains"] as const) {
      for (const f of CANONICAL_FIELDS) {
        if (suggested[f.key]) continue;
        const match = hdr.find((h) => !used.has(h) && wordsOf(f).some((w) =>
          pass === "exact" ? h.toLowerCase() === w : h.toLowerCase().includes(w)));
        if (match) { suggested[f.key] = match; used.add(match); }
      }
    }
    setMapping(suggested);
    setStep("map");
  };

  const parseCsv = () => {
    setError(null);
    const lines = raw.trim().split(/\r?\n/);
    if (lines.length < 2) { setError("Need a header row plus at least one data row."); return; }
    setWorkbook(null);
    applyTable(splitLine(lines[0]).map((h) => h.trim()), lines.slice(1).map(splitLine));
  };

  const readWorkbook = async (fileName: string, b64: string, sheet?: string) => {
    setBusy(true); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/assets/parse-workbook", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ orgId, fileBase64: b64, fileName, sheet }),
      });
      const json = await res.json().catch(() => ({})) as { error?: string; headers?: string[]; rows?: string[][]; rowNumbers?: number[]; sheetNames?: string[]; sheetName?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const hdr = json.headers ?? [];
      const data = json.rows ?? [];
      if (hdr.length === 0 || data.length === 0) throw new Error("No header row and data rows were found in that sheet.");
      setWorkbook({ fileName, b64, sheetNames: json.sheetNames ?? [], sheetName: json.sheetName ?? "" });
      applyTable(hdr, data, Array.isArray(json.rowNumbers) ? json.rowNumbers : null);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const pickWorkbook = async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    await readWorkbook(file.name, btoa(binary));
  };

  const goPreview = async () => {
    for (const f of CANONICAL_FIELDS) {
      if (f.required && !mapping[f.key]) { setError(`"${f.label}" is required`); return; }
    }
    setError(null);
    setBusy(true);
    try {
      // BR-6: count what already exists BEFORE anything is written; CB-10:
      // and which site codes are already carried, so a derived code that
      // collides is dropped in the preview instead of failing the row.
      const [found, identities] = await Promise.all([
        findAssetsByTagKeys(orgId, inputs.map((r) => tagKey(r.tag))),
        listAssetIdentities(orgId),
      ]);
      const holders = new Map<string, { id: string; tag: string }>();
      for (const a of identities) {
        const c = (a.code ?? "").trim() ? a.code! : null;
        if (c && !holders.has(c)) holders.set(c, { id: a.id, tag: a.tag });
      }
      setCodeHolders(holders);
      setExisting(found);
      setStep("preview");
    } catch (e) {
      setError(`Could not check which tags already exist — ${(e as Error).message}`);
    } finally { setBusy(false); }
  };

  const commit = async () => {
    if (!plan) return;
    setBusy(true); setError(null);
    const failed: Array<{ row: number; reason: string }> = [];
    const codeless: ImportResult["codeless"] = plan.rows
      .filter((p) => (p.action === "create" || p.action === "update") && p.codeDropped)
      .map((p) => ({ row: p.row, tag: p.tag, code: p.codeDropped! }));
    let created = 0, updated = 0, filed = 0;
    for (const p of plan.rows) {
      if (p.action === "error") { failed.push({ row: p.row, reason: p.error ?? "Not importable" }); continue; }
      if (p.action === "skip") continue;
      try {
        // CB-10: a code that became taken since the preview (another import,
        // the Bridge) never costs the row — the asset lands without it.
        if (p.action === "create") {
          const made = await createAsset({
            orgId, tag: p.tag,
            description: p.patch.description ?? undefined,
            location: p.patch.location ?? undefined,
            typeId: p.patch.type_id ?? undefined,
            unitCode: p.patch.unit_code ?? undefined,
            code: p.patch.code ?? undefined,
            codeOptional: true,
            createdBy: actorUserId,
          });
          if (p.patch.code && !made.code) codeless.push({ row: p.row, tag: p.tag, code: p.patch.code });
          created += 1;
        } else if (p.existingId) {
          const { codeDropped } = await updateAsset(p.existingId, p.patch, actorUserId, { codeOptional: true });
          if (codeDropped) codeless.push({ row: p.row, tag: p.tag, code: codeDropped });
          updated += 1;
        }
        if (p.unitCode) filed += 1;
      } catch (e) {
        // BR-6: plain language, never a raw constraint name.
        const f = translatePostgresError(e, { entity: "asset", field: "tag" });
        failed.push({ row: p.row, reason: `${f.heading} — ${f.message}` });
      }
    }
    setResult({ created, updated, skipped: plan.skipped, filed, codeless, failed });
    setStep("done");
    setBusy(false);
    if (created + updated > 0) onImported?.(created + updated);
  };

  const unitName = (code: string | null) => (code ? (book.units.find((u) => u.code === code)?.label ?? null) : null);

  return (
    <div className="fixed inset-0 z-[400] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 rounded-lg bg-purple-100 text-purple-700"><KeyRound className="w-5 h-5" /></div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Import a master equipment list</div>
            <div className="text-xs text-[var(--color-text-muted)]">CSV or spreadsheet — type, description, location, operating unit and site code; existing tags can be updated.</div>
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
                placeholder={`tag,type,description,location\nP-101,Pump,Crude charge pump,Unit 100\nV-201,Vessel,Reflux drum,Unit 200`}
                rows={10}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-mono"
              />
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-[var(--color-text-muted)]">or</span>
                <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] font-bold cursor-pointer hover:bg-[var(--color-surface-2)]">
                  <Upload className="w-3.5 h-3.5" /> Upload a spreadsheet (.xlsx, .xls, .csv)
                  <input type="file" className="hidden" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickWorkbook(f); e.target.value = ""; }} />
                </label>
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              </div>
              <div className="text-[10px] text-[var(--color-text-muted)]">First row = headers. The <code>type</code> column matches an existing asset-type by name (case-insensitive); unmatched types are left blank. A <code>unit</code> column (Site Codebook code or name) files each row into its operating area; a <code>site code</code> column (2030.22) works too — the unit is read from it.</div>
            </div>
          )}

          {step === "map" && (
            <div className="space-y-3">
              <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Map columns</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                Detected {rows.length} data row{rows.length === 1 ? "" : "s"} · {headers.length} columns{workbook ? <> · from <b>{workbook.fileName}</b></> : null}.
              </div>
              {workbook && workbook.sheetNames.length > 1 && (
                <label className="flex items-center gap-2 text-[11px]">
                  <span className="font-bold">Sheet</span>
                  <select value={workbook.sheetName} disabled={busy}
                    onChange={(e) => void readWorkbook(workbook.fileName, workbook.b64, e.target.value)}
                    className="px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                    {workbook.sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              )}
              <div className="space-y-2">
                {CANONICAL_FIELDS.map((f) => (
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

          {step === "preview" && plan && (
            <div className="space-y-3">
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-text)] space-y-1">
                <div>
                  <b>{rows.length}</b> row{rows.length === 1 ? "" : "s"} · <b>{plan.creates}</b> new
                  {plan.existing > 0 && <> · <b>{plan.existing}</b> already in the registry</>}
                  {plan.updates > 0 && <> (<b>{plan.updates}</b> will be updated)</>}
                  {plan.skipped > 0 && <> · <b>{plan.skipped}</b> skipped</>}
                  {plan.errors > 0 && <> · <b className="text-rose-700">{plan.errors}</b> can&apos;t be imported</>}
                </div>
                <div>
                  <b>{plan.filed}</b> land in an operating area{book.units.length === 0 ? " (no units in the Site Codebook yet — rows import unassigned)" : ""}.
                </div>
                {plan.codesDropped > 0 && (
                  <div className="text-amber-800">
                    <b>{plan.codesDropped}</b> land without a site code — another asset (or an earlier row) already carries the code; one site code is one asset. See the row notes.
                  </div>
                )}
                {plan.existing > 0 && (
                  <div className="flex items-center gap-3 pt-1">
                    <span className="font-bold">Rows whose tag already exists:</span>
                    <label className="inline-flex items-center gap-1">
                      <input type="radio" checked={mode === "create_only"} onChange={() => setMode("create_only")} /> Skip them (create new only)
                    </label>
                    <label className="inline-flex items-center gap-1">
                      <input type="radio" checked={mode === "create_and_update"} onChange={() => setMode("create_and_update")} /> Update them from this file
                    </label>
                  </div>
                )}
              </div>
              <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Preview (first 50)</div>
              <div className="rounded-lg border border-[var(--color-border)] overflow-auto">
                <table className="w-full text-[11px]">
                  <thead className="bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
                    <tr>
                      {["Row", "Tag", "Action", "Operating area", "Site code", "Notes"].map((h) => (
                        <th key={h} className="text-left px-2 py-1.5 font-black text-[var(--color-text)] uppercase tracking-wider text-[10px]">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {plan.rows.slice(0, 50).map((p) => (
                      <tr key={p.row} className={p.action === "error" ? "bg-rose-50/60" : undefined}>
                        <td className="px-2 py-1.5 text-[var(--color-text-faint)]">{p.row}</td>
                        <td className="px-2 py-1.5 font-mono font-bold text-[var(--color-text)]">{p.tag || "—"}</td>
                        <td className="px-2 py-1.5 font-bold">
                          {p.action === "create" ? "Create" : p.action === "update" ? "Update" : p.action === "skip" ? "Skip" : "Can't import"}
                        </td>
                        <td className="px-2 py-1.5">
                          {p.unitCode
                            ? <><span className="font-mono font-black text-purple-700">{p.unitCode}</span>{unitName(p.unitCode) ? ` ${unitName(p.unitCode)}` : " (not in the codebook)"}</>
                            : <span className="text-amber-700">unassigned</span>}
                        </td>
                        <td className="px-2 py-1.5 font-mono">{p.code ?? ""}</td>
                        <td className="px-2 py-1.5 text-[var(--color-text-muted)]">{p.error ?? p.notes.join(" ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {plan.rows.length > 50 && <div className="text-[10px] text-[var(--color-text-muted)] mt-1">+ {plan.rows.length - 50} more row{plan.rows.length - 50 === 1 ? "" : "s"}.</div>}
            </div>
          )}

          {step === "done" && result && (
            <div className="space-y-2">
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  Created <b>{result.created}</b> · updated <b>{result.updated}</b>{result.skipped > 0 ? <> · skipped <b>{result.skipped}</b></> : null}
                  {" "}— <b>{result.filed}</b> filed to an operating area.
                </span>
              </div>
              {result.codeless.length > 0 && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
                  <div className="font-bold flex items-center gap-1.5 mb-1"><AlertTriangle className="w-4 h-4" /> {result.codeless.length} landed without a site code</div>
                  <div className="mb-1">Another asset already carries the code (one site code is one asset). Give each its own code — they are listed under Identity review.</div>
                  <ul className="ml-5 list-disc space-y-0.5">
                    {result.codeless.slice(0, 8).map((c, i) => (
                      <li key={i}>Row {c.row}: {c.tag} — {c.code}</li>
                    ))}
                    {result.codeless.length > 8 && <li className="italic">+{result.codeless.length - 8} more</li>}
                  </ul>
                </div>
              )}
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

        <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between gap-2">
          {step !== "paste" && step !== "done" && (
            <button onClick={() => setStep(step === "preview" ? "map" : "paste")} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
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
              <button onClick={() => void goPreview()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold disabled:opacity-50">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Preview <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
            {step === "preview" && plan && (
              <button onClick={() => void commit()} disabled={busy || plan.creates + plan.updates === 0} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold disabled:opacity-50">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {busy ? "Importing…" : `Create ${plan.creates}${plan.updates > 0 ? ` · update ${plan.updates}` : ""}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
