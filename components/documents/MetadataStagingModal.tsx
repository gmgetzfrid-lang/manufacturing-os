"use client";

// MetadataStagingModal — pre-upload metadata staging grid.
//
// Drop / pick files → this modal opens BEFORE any bytes get uploaded.
// User reviews / edits metadata for each file in a table, then clicks
// "Upload All" which kicks off the actual R2 upload + document inserts.
//
// Filename hints are pre-populated by lib/filenameParser so most files
// only need a quick review, not field-by-field entry.
//
// Bulk-apply controls at the top let the user set status / type / unit
// for every selected row at once — critical when uploading 50 files
// at the same time.

import React, { useEffect, useMemo, useState } from "react";
import {
  X, Upload, AlertTriangle, CheckCircle2, Loader2, Wand2,
  FileText, Copy, Trash2, Info,
} from "lucide-react";
import { parseFilename, detectBulkHints, type ParsedFilename } from "@/lib/filenameParser";

export interface CustomColumnDef {
  key: string;
  label: string;
  type: "text" | "select" | "number" | "date";
  required?: boolean;
  options?: string[];
}

export interface StagedItem {
  id: string;
  file: File;
  documentNumber: string;
  title: string;
  rev: string;
  status: string;
  customFields: Record<string, string>;
  hints: ParsedFilename["hints"];
}

interface MetadataStagingModalProps {
  isOpen: boolean;
  files: File[];
  customColumns?: CustomColumnDef[];
  defaultStatus?: string;
  statusOptions?: string[];
  onCancel: () => void;
  onSubmit: (items: StagedItem[]) => Promise<void>;
}

const DEFAULT_STATUS_OPTIONS = ["Draft", "In Review", "Issued", "IFC", "Superseded"];

export default function MetadataStagingModal({
  isOpen, files, customColumns = [], defaultStatus = "Issued",
  statusOptions = DEFAULT_STATUS_OPTIONS,
  onCancel, onSubmit,
}: MetadataStagingModalProps) {
  const [items, setItems] = useState<StagedItem[]>([]);
  const [bulkType, setBulkType] = useState("");
  const [bulkUnit, setBulkUnit] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect when the user has defined library columns that map to the
  // canonical document fields (number / title / rev). When they exist,
  // we hide the hardcoded column and route the user's custom column's
  // input straight to the canonical field — so they only see ONE input
  // per concept (e.g. their "No." column instead of "No." + "Document #").
  const canonical = useMemo(() => {
    const find = (re: RegExp) =>
      customColumns.find((c) => re.test((c.label || "").trim()) || re.test((c.key || "").trim()));
    return {
      docNumber: find(/^(doc(ument)?[\s_-]*(#|number|no\.?|num)?|number|no\.?|#|num)$/i),
      title: find(/^(title|name|description|desc)$/i),
      rev: find(/^(rev(ision)?)$/i),
      status: find(/^status$/i),
    };
  }, [customColumns]);
  const canonicalKeys = useMemo(() => new Set(
    [canonical.docNumber?.key, canonical.title?.key, canonical.rev?.key, canonical.status?.key].filter(Boolean) as string[]
  ), [canonical]);

  // Initialize staged items from incoming files
  useEffect(() => {
    if (!isOpen) return;
    const next: StagedItem[] = files.map((file, idx) => {
      const parsed = parseFilename(file.name);
      const customFields: Record<string, string> = {};
      // Pre-populate hint columns (type / unit / sheet) only if the
      // matched column ISN'T already mapped to a canonical field.
      if (parsed.hints.type) {
        const typeCol = customColumns.find((c) =>
          (/type/i.test(c.key) || /type/i.test(c.label)) && !canonicalKeys.has(c.key)
        );
        if (typeCol) customFields[typeCol.key] = parsed.hints.type;
      }
      if (parsed.hints.unit) {
        const unitCol = customColumns.find((c) =>
          (/unit/i.test(c.key) || /area/i.test(c.key)) && !canonicalKeys.has(c.key)
        );
        if (unitCol) customFields[unitCol.key] = parsed.hints.unit;
      }
      if (parsed.hints.sheet) {
        const sheetCol = customColumns.find((c) =>
          /sheet/i.test(c.key) && !canonicalKeys.has(c.key)
        );
        if (sheetCol) customFields[sheetCol.key] = parsed.hints.sheet;
      }
      return {
        id: `staged-${idx}-${file.name}`,
        file,
        documentNumber: parsed.documentNumber,
        title: parsed.title,
        rev: parsed.rev,
        status: defaultStatus,
        customFields,
        hints: parsed.hints,
      };
    });
    setItems(next);

    // Pre-fill bulk hints if filenames are consistent
    const detected = detectBulkHints(next.map((it) => parseFilename(it.file.name)));
    if (detected.commonUnit) setBulkUnit(detected.commonUnit);
    if (detected.commonType) setBulkType(detected.commonType);
    setError(null);
  }, [isOpen, files, customColumns, defaultStatus, canonicalKeys]);

  // Modal is informational. Parser + filename fallback in the DB
  // write produces a valid row from any file, so there's nothing the
  // user has to type. No required-field blocking, no duplicate
  // blocking — if the user wants to edit a row, they can; otherwise
  // they hit Upload All and go.
  const validation: Array<{ rowId: string; field: string; msg: string }> = [];

  // ── Per-row mutators ───────────────────────────────────────────
  const updateRow = (id: string, patch: Partial<StagedItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };
  const updateCustomField = (id: string, key: string, value: string) => {
    setItems((prev) => prev.map((it) =>
      it.id === id ? { ...it, customFields: { ...it.customFields, [key]: value } } : it
    ));
  };
  const removeRow = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  };
  const duplicateRow = (id: string) => {
    const src = items.find((it) => it.id === id);
    if (!src) return;
    const copyItem: StagedItem = { ...src, id: src.id + "-copy-" + Date.now(), customFields: { ...src.customFields } };
    setItems((prev) => [...prev, copyItem]);
  };

  // ── Bulk operations ────────────────────────────────────────────
  const applyBulkStatus = () => {
    if (!bulkStatus) return;
    setItems((prev) => prev.map((it) => ({ ...it, status: bulkStatus })));
  };
  const applyBulkType = () => {
    if (!bulkType) return;
    const typeCol = customColumns.find((c) =>
      (/type/i.test(c.key) || /type/i.test(c.label)) && !canonicalKeys.has(c.key)
    );
    if (!typeCol) return;
    setItems((prev) => prev.map((it) => ({
      ...it, customFields: { ...it.customFields, [typeCol.key]: bulkType }
    })));
  };
  const applyBulkUnit = () => {
    if (!bulkUnit) return;
    const unitCol = customColumns.find((c) =>
      (/unit/i.test(c.key) || /area/i.test(c.key)) && !canonicalKeys.has(c.key)
    );
    if (!unitCol) return;
    setItems((prev) => prev.map((it) => ({
      ...it, customFields: { ...it.customFields, [unitCol.key]: bulkUnit }
    })));
  };

  // ── Submit ─────────────────────────────────────────────────────
  const submit = async () => {
    setError(null);
    if (items.length === 0) {
      setError("No files to upload.");
      return;
    }
    setSubmitting(true);
    try {
      // Strip canonical-mapped custom-field keys before handing off so
      // the parent doesn't save the same value into both the canonical
      // column AND the metadata JSONB.
      const cleaned = items.map((it) => {
        if (canonicalKeys.size === 0) return it;
        const customFields = { ...it.customFields };
        for (const k of canonicalKeys) delete customFields[k];
        return { ...it, customFields };
      });
      await onSubmit(cleaned);
    } catch (e) {
      setError((e as Error).message || "Upload failed.");
      setSubmitting(false);
    }
    // Parent closes modal on success
  };

  if (!isOpen) return null;

  const typeCol = customColumns.find((c) =>
    (/type/i.test(c.key) || /type/i.test(c.label)) && !canonicalKeys.has(c.key)
  );
  const unitCol = customColumns.find((c) =>
    (/unit/i.test(c.key) || /area/i.test(c.key)) && !canonicalKeys.has(c.key)
  );

  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-6xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-8 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg"><Upload className="w-5 h-5 text-blue-700" /></div>
            <div>
              <div className="text-sm font-black text-slate-900">Review metadata before uploading</div>
              <div className="text-xs text-slate-500">{items.length} file{items.length === 1 ? "" : "s"} ready. Confirm or edit each row, then upload.</div>
            </div>
          </div>
          <button onClick={onCancel} disabled={submitting} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-900">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Bulk-apply row */}
        <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-1">
              <Wand2 className="w-3 h-3" /> Apply to all:
            </span>
            <div className="inline-flex items-center gap-1.5">
              <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} className="text-xs border border-slate-300 rounded-md px-2 py-1 bg-white">
                <option value="">Status...</option>
                {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button onClick={applyBulkStatus} disabled={!bulkStatus} className="text-[10px] font-bold px-2 py-1 rounded-md bg-slate-200 hover:bg-slate-300 text-slate-700 disabled:opacity-40">Apply</button>
            </div>
            {typeCol && (
              <div className="inline-flex items-center gap-1.5">
                <input value={bulkType} onChange={(e) => setBulkType(e.target.value)} placeholder={typeCol.label} className="text-xs border border-slate-300 rounded-md px-2 py-1 bg-white w-32" />
                <button onClick={applyBulkType} disabled={!bulkType} className="text-[10px] font-bold px-2 py-1 rounded-md bg-slate-200 hover:bg-slate-300 text-slate-700 disabled:opacity-40">Apply</button>
              </div>
            )}
            {unitCol && (
              <div className="inline-flex items-center gap-1.5">
                <input value={bulkUnit} onChange={(e) => setBulkUnit(e.target.value)} placeholder={unitCol.label} className="text-xs border border-slate-300 rounded-md px-2 py-1 bg-white w-24" />
                <button onClick={applyBulkUnit} disabled={!bulkUnit} className="text-[10px] font-bold px-2 py-1 rounded-md bg-slate-200 hover:bg-slate-300 text-slate-700 disabled:opacity-40">Apply</button>
              </div>
            )}
            <div className="ml-auto flex items-center gap-1.5 text-[10px] text-slate-500">
              <Info className="w-3 h-3" />
              <span>Filename hints auto-detected. Edit any cell directly.</span>
            </div>
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
              <tr>
                <th className="text-left px-3 py-2 text-[10px] font-black text-slate-600 uppercase tracking-wider w-8"></th>
                <th className="text-left px-3 py-2 text-[10px] font-black text-slate-600 uppercase tracking-wider">File</th>
                {!canonical.docNumber && (
                  <th className="text-left px-3 py-2 text-[10px] font-black text-slate-600 uppercase tracking-wider">Document #</th>
                )}
                {!canonical.title && (
                  <th className="text-left px-3 py-2 text-[10px] font-black text-slate-600 uppercase tracking-wider">Title</th>
                )}
                {!canonical.rev && (
                  <th className="text-left px-3 py-2 text-[10px] font-black text-slate-600 uppercase tracking-wider w-16">Rev</th>
                )}
                {!canonical.status && (
                  <th className="text-left px-3 py-2 text-[10px] font-black text-slate-600 uppercase tracking-wider w-32">Status</th>
                )}
                {customColumns.map((c) => (
                  <th key={c.key} className="text-left px-3 py-2 text-[10px] font-black text-slate-600 uppercase tracking-wider">
                    {c.label}{c.required && " *"}
                  </th>
                ))}
                <th className="px-2 py-2 w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((it) => {
                const rowErrors = validation.filter((e) => e.rowId === it.id);
                const errFor = (field: string) => rowErrors.find((e) => e.field === field)?.msg;
                return (
                  <tr key={it.id} className={rowErrors.length ? "bg-red-50/40" : "hover:bg-slate-50"}>
                    <td className="px-3 py-1.5">
                      <FileText className="w-3.5 h-3.5 text-slate-400" />
                    </td>
                    <td className="px-3 py-1.5 max-w-[16ch]">
                      <div className="text-[11px] text-slate-700 font-mono truncate" title={it.file.name}>{it.file.name}</div>
                      <div className="text-[9px] text-slate-400">{formatBytes(it.file.size)}</div>
                    </td>
                    {!canonical.docNumber && (
                      <td className="px-3 py-1.5">
                        <Cell
                          value={it.documentNumber}
                          onChange={(v) => updateRow(it.id, { documentNumber: v })}
                          error={errFor("documentNumber")}
                          widthClass="w-40"
                        />
                      </td>
                    )}
                    {!canonical.title && (
                      <td className="px-3 py-1.5">
                        <Cell
                          value={it.title}
                          onChange={(v) => updateRow(it.id, { title: v })}
                          error={errFor("title")}
                          widthClass="w-60"
                        />
                      </td>
                    )}
                    {!canonical.rev && (
                      <td className="px-3 py-1.5">
                        <Cell
                          value={it.rev}
                          onChange={(v) => updateRow(it.id, { rev: v })}
                          widthClass="w-12"
                          center
                        />
                      </td>
                    )}
                    {!canonical.status && (
                      <td className="px-3 py-1.5">
                        <select
                          value={it.status}
                          onChange={(e) => updateRow(it.id, { status: e.target.value })}
                          className="w-full text-[11px] border border-slate-200 rounded-md px-1.5 py-1 bg-white"
                        >
                          {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                    )}
                    {customColumns.map((c) => {
                      // Canonical-mapped custom columns: route input to the
                      // canonical field instead of customFields so the value
                      // doesn't get saved in two places.
                      const isDocNum = canonical.docNumber?.key === c.key;
                      const isTitle = canonical.title?.key === c.key;
                      const isRev = canonical.rev?.key === c.key;
                      const isStatus = canonical.status?.key === c.key;
                      const value = isDocNum ? it.documentNumber
                        : isTitle ? it.title
                        : isRev ? it.rev
                        : isStatus ? it.status
                        : (it.customFields[c.key] || "");
                      const onChange = isDocNum ? (v: string) => updateRow(it.id, { documentNumber: v })
                        : isTitle ? (v: string) => updateRow(it.id, { title: v })
                        : isRev ? (v: string) => updateRow(it.id, { rev: v })
                        : isStatus ? (v: string) => updateRow(it.id, { status: v })
                        : (v: string) => updateCustomField(it.id, c.key, v);
                      // For the canonical Status column, ALWAYS render a
                      // select using the library's status options — even if
                      // the user defined the column as text. A status field
                      // should never be a free-form text box.
                      const renderAsStatusSelect = isStatus;
                      return (
                        <td key={c.key} className="px-3 py-1.5">
                          {renderAsStatusSelect ? (
                            <select
                              value={value}
                              onChange={(e) => onChange(e.target.value)}
                              className="w-full text-[11px] border border-slate-200 rounded-md px-1.5 py-1 bg-white"
                            >
                              {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                            </select>
                          ) : c.type === "select" && c.options ? (
                            <select
                              value={value}
                              onChange={(e) => onChange(e.target.value)}
                              className={`w-full text-[11px] border rounded-md px-1.5 py-1 bg-white ${errFor(c.key) ? "border-red-400" : "border-slate-200"}`}
                            >
                              <option value=""></option>
                              {c.options.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : (
                            <Cell
                              value={value}
                              onChange={onChange}
                              error={errFor(c.key)}
                              widthClass={isTitle ? "w-60" : isDocNum ? "w-40" : isRev ? "w-12" : "w-28"}
                              center={isRev}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <button onClick={() => duplicateRow(it.id)} title="Duplicate row" className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded">
                          <Copy className="w-3 h-3" />
                        </button>
                        <button onClick={() => removeRow(it.id)} title="Remove from batch" className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td
                    colSpan={
                      2 // icon + file
                      + (canonical.docNumber ? 0 : 1)
                      + (canonical.title ? 0 : 1)
                      + (canonical.rev ? 0 : 1)
                      + (canonical.status ? 0 : 1)
                      + customColumns.length
                      + 1 // actions
                    }
                    className="text-center text-slate-400 py-12 text-xs"
                  >
                    No files staged.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Error + actions */}
        {error && (
          <div className="px-6 py-3 bg-red-50 border-t border-red-200 text-xs text-red-700 flex items-start gap-2 shrink-0">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
          <div className="text-[11px] text-slate-500">
            {items.length} file{items.length === 1 ? "" : "s"} · {formatBytes(items.reduce((s, i) => s + i.file.size, 0))} total
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onCancel} disabled={submitting} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
            <button onClick={submit} disabled={submitting || items.length === 0} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-black text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 shadow">
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {submitting ? "Uploading…" : "Upload All"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Editable cell with optional error highlight
function Cell({
  value, onChange, error, widthClass, center,
}: {
  value: string; onChange: (v: string) => void;
  error?: string; widthClass?: string; center?: boolean;
}) {
  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${widthClass || "w-full"} text-[11px] border rounded-md px-1.5 py-1 bg-white ${error ? "border-red-400 ring-1 ring-red-200" : "border-slate-200"} ${center ? "text-center" : ""}`}
      />
      {error && (
        <span className="absolute right-1 top-1 text-[8px] font-black text-red-600 uppercase">{error}</span>
      )}
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
