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
  FileText, Copy, Trash2, Info, KeyRound,
} from "lucide-react";
import { parseFilename, detectBulkHints, type ParsedFilename } from "@/lib/filenameParser";
import { computeUniquenessKey } from "@/lib/uniqueness";

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
  /** Opens the parent's column-add wizard. When this completes, the
   *  parent should refresh customColumns; the modal will pick up the
   *  new column via its prop. */
  onAddColumn?: () => void;
  /** Library's current uniqueness-tuple config. Default (undefined/[]) =
   *  ['documentNumber']. The modal uses this to warn when a batch would
   *  produce duplicate keys before the DB rejects on insert. */
  uniquenessKeys?: string[];
  /** One-click fix: add a "Sheet" column to the library and add it to
   *  the uniqueness tuple. Surfaced as a banner action when the modal
   *  detects same-doc-number-multiple-files. */
  onAddSheetAndUseForUniqueness?: () => Promise<void>;
}

const DEFAULT_STATUS_OPTIONS = ["Draft", "In Review", "Issued", "IFC", "Superseded"];

export default function MetadataStagingModal({
  isOpen, files, customColumns = [], defaultStatus = "Issued",
  statusOptions = DEFAULT_STATUS_OPTIONS,
  onCancel, onSubmit, onAddColumn,
  uniquenessKeys, onAddSheetAndUseForUniqueness,
}: MetadataStagingModalProps) {
  const [fixingUniqueness, setFixingUniqueness] = useState(false);
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

  // Initialize staged items when the modal opens. After that the rows
  // are user-editable; we don't blow them away when customColumns
  // changes (e.g. user clicks "Add Sheet" mid-staging — that should
  // ADD the column to existing rows, not reset them).
  useEffect(() => {
    if (!isOpen) return;
    const next: StagedItem[] = files.map((file, idx) => {
      const parsed = parseFilename(file.name);
      const customFields: Record<string, string> = {};
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

    const detected = detectBulkHints(next.map((it) => parseFilename(it.file.name)));
    if (detected.commonUnit) setBulkUnit(detected.commonUnit);
    if (detected.commonType) setBulkType(detected.commonType);
    setError(null);
    // Intentionally ONLY runs on open. Adding customColumns to the
    // deps would wipe in-progress user edits whenever a column was
    // added mid-staging. See secondary effect below for the
    // post-add fill.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, files, defaultStatus]);

  // Secondary: when customColumns CHANGES mid-staging (e.g. user
  // clicked "Add Sheet + use for uniqueness"), back-fill the new
  // column's parsed hint into each existing row WITHOUT wiping any
  // other user edits.
  useEffect(() => {
    if (!isOpen || items.length === 0) return;
    setItems((prev) => prev.map((it) => {
      const parsed = parseFilename(it.file.name);
      const customFields = { ...it.customFields };
      let changed = false;
      if (parsed.hints.sheet) {
        const sheetCol = customColumns.find((c) =>
          /sheet/i.test(c.key) && !canonicalKeys.has(c.key)
        );
        if (sheetCol && !customFields[sheetCol.key]) {
          customFields[sheetCol.key] = parsed.hints.sheet;
          changed = true;
        }
      }
      if (parsed.hints.type) {
        const typeCol = customColumns.find((c) =>
          (/type/i.test(c.key) || /type/i.test(c.label)) && !canonicalKeys.has(c.key)
        );
        if (typeCol && !customFields[typeCol.key]) {
          customFields[typeCol.key] = parsed.hints.type;
          changed = true;
        }
      }
      if (parsed.hints.unit) {
        const unitCol = customColumns.find((c) =>
          (/unit/i.test(c.key) || /area/i.test(c.key)) && !canonicalKeys.has(c.key)
        );
        if (unitCol && !customFields[unitCol.key]) {
          customFields[unitCol.key] = parsed.hints.unit;
          changed = true;
        }
      }
      return changed ? { ...it, customFields } : it;
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customColumns]);

  // Modal is informational. Parser + filename fallback in the DB
  // write produces a valid row from any file, so there's nothing the
  // user has to type. No required-field blocking, no duplicate
  // blocking — if the user wants to edit a row, they can; otherwise
  // they hit Upload All and go.
  const validation: Array<{ rowId: string; field: string; msg: string }> = [];

  // ── Predictive uniqueness check ───────────────────────────────────
  // Compute the DB uniqueness_key each row WOULD produce. If two rows
  // share one, the DB will reject the insert. We surface that here
  // with a banner that suggests a one-click fix (add a Sheet column +
  // include it in the uniqueness tuple), so the user doesn't have to
  // play whack-a-mole with the constraint error.
  const collisionPreview = useMemo(() => {
    const seen = new Map<string, number>();
    for (const it of items) {
      const key = computeUniquenessKey(
        {
          documentNumber: it.documentNumber || undefined,
          title: it.title || undefined,
          rev: it.rev || undefined,
          status: it.status || undefined,
          customFields: it.customFields,
        },
        uniquenessKeys,
      );
      if (!key) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    let collidingRows = 0;
    let exampleKey: string | null = null;
    for (const [k, n] of seen) {
      if (n > 1) {
        collidingRows += n;
        if (!exampleKey) exampleKey = k;
      }
    }
    return { collidingRows, exampleKey };
  }, [items, uniquenessKeys]);

  const hasSheetColumn = customColumns.some(
    (c) => /sheet/i.test(c.key) || /sheet/i.test(c.label),
  );
  const sheetInUniqueness = (uniquenessKeys ?? []).some((k) => /sheet/i.test(k));

  // Last-resort disambiguator: when the parser produces the same
  // doc_number for files that are actually different (no sheet
  // pattern, no rev pattern, just similar names), suffix the
  // collisions with -2, -3, … so each row gets a unique key.
  const autoSuffixDuplicates = () => {
    setItems((prev) => {
      const counts = new Map<string, number>();
      return prev.map((it) => {
        const base = it.documentNumber.trim().toLowerCase();
        if (!base) return it;
        const n = (counts.get(base) ?? 0) + 1;
        counts.set(base, n);
        if (n === 1) return it; // first occurrence keeps its number
        return { ...it, documentNumber: `${it.documentNumber}-${n}` };
      });
    });
  };

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

        {/* Predictive uniqueness banner — only when a collision will actually
            hit the DB constraint */}
        {collisionPreview.collidingRows >= 2 && (
          <div className="px-6 py-3 bg-amber-50 border-b border-amber-200 shrink-0">
            <div className="flex items-start gap-2">
              <KeyRound className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-black text-amber-900">
                  {collisionPreview.collidingRows} files share the same uniqueness key
                </div>
                <div className="text-[11px] text-amber-800 mt-0.5">
                  The library treats these as the same document, so the upload will fail. Two ways to fix it:
                  {" • "}
                  {sheetInUniqueness
                    ? "Fill in a different Sheet value on each row."
                    : hasSheetColumn
                    ? "Tick Sheet for uniqueness (button →)."
                    : "Add a Sheet column + uniqueness (button →) if your files are sheets of the same doc."}
                  {" • Or auto-suffix the colliding doc numbers (button →) if your files are genuinely different and just have similar numbers."}
                </div>
              </div>
              <div className="shrink-0 flex flex-col items-stretch gap-1.5">
                {onAddSheetAndUseForUniqueness && !sheetInUniqueness && (
                  <button
                    onClick={async () => {
                      setFixingUniqueness(true);
                      try { await onAddSheetAndUseForUniqueness(); }
                      finally { setFixingUniqueness(false); }
                    }}
                    disabled={fixingUniqueness}
                    className="inline-flex items-center justify-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-50"
                  >
                    {fixingUniqueness ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
                    {hasSheetColumn ? "Use Sheet for uniqueness" : "Add Sheet + use for uniqueness"}
                  </button>
                )}
                <button
                  onClick={autoSuffixDuplicates}
                  className="inline-flex items-center justify-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-white border border-amber-300 text-amber-800 hover:bg-amber-50"
                  title="Append -2, -3, … to colliding doc numbers so each row is unique. Use when the files are genuinely different and just have similar parsed numbers."
                >
                  Auto-suffix duplicates
                </button>
              </div>
            </div>
          </div>
        )}

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
            {onAddColumn && (
              <button
                onClick={onAddColumn}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-slate-900 text-white hover:bg-slate-800"
                title="Add a new column to this library — opens the column wizard without closing the upload."
              >
                + Add Column
              </button>
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
