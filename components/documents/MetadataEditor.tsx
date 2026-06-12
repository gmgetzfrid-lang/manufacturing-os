"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { X, Zap, Plus, FileText } from "lucide-react";
import type { DocumentRecord, MetadataFieldDefinition, MetadataValue } from "@/types/schema";
import CheckoutStatusCell from "./CheckoutStatusCell";
import AssetTagChip from "@/components/assets/AssetTagChip";

const DOCUMENT_STATUSES = ["Draft", "Issued", "Superseded", "Void", "Archived", "Locked"];

// ── Inline pill editor used for tags/multi columns ──────────────────────────
function TagInput({
  values,
  label,
  disabled,
  onChange,
  orgId,
  userId,
  canManageAssets,
}: {
  values: string[];
  label: string;
  disabled?: boolean;
  onChange: (next: string[]) => void;
  orgId?: string;
  userId?: string;
  canManageAssets?: boolean;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addPill = () => {
    const v = input.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput("");
    inputRef.current?.focus();
  };

  return (
    <div
      className={`mt-1 w-full rounded-lg border px-2 py-2 text-sm ${
        disabled
          ? "bg-slate-50 border-slate-200"
          : "bg-white border-slate-300 focus-within:ring-2 focus-within:ring-blue-500"
      }`}
    >
      <div className="flex flex-wrap gap-1.5 min-h-[20px] items-start">
        {values.map((pill) => (
          <div key={pill} className="inline-flex items-center gap-0.5">
            {/* Asset-registry-aware chip — clickable to view/add photos */}
            <AssetTagChip
              tag={pill}
              type={label}
              orgId={orgId}
              userId={userId}
              canManage={canManageAssets}
            />
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== pill))}
                title="Remove tag"
                className="ml-0.5 -mb-1 p-0.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        {values.length === 0 && disabled && <span className="text-slate-400 text-xs">—</span>}
      </div>
      {!disabled && (
        <div className="flex items-center gap-1 mt-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Only Enter / Tab finalize a tag. Comma is part of the
              // tag (e.g. "X-31 (2030,32)" is a valid equipment label).
              if (e.key === "Enter") { e.preventDefault(); addPill(); }
              if (e.key === "Tab" && input.trim()) { e.preventDefault(); addPill(); }
            }}
            placeholder={`Add ${label}…`}
            className="flex-1 min-w-0 text-[12px] px-2 py-1 rounded-md border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
          />
          {input.trim() && (
            <button
              type="button"
              onClick={addPill}
              className="shrink-0 p-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors"
            >
              <Plus className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
      {!disabled && <p className="text-[10px] text-slate-400 mt-1">Enter to add — commas stay in the tag</p>}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalizeValue(value: unknown, type: MetadataFieldDefinition["type"]): MetadataValue {
  if (type === "number") { const n = Number(value); return Number.isNaN(n) ? null : n; }
  if (type === "boolean") return Boolean(value);
  if (type === "multi" || type === "tags") {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
    return [];
  }
  if (type === "date") return value ? String(value) : null;
  return value == null ? null : String(value);
}

// ── Props ─────────────────────────────────────────────────────────────────────
export interface MetadataEditorSavePayload {
  metadata: Record<string, MetadataValue>;
  core?: {
    title?: string;
    documentNumber?: string;
    rev?: string;
    status?: string;
  };
}

export default function MetadataEditor(props: {
  isOpen: boolean;
  onClose: () => void;
  document: DocumentRecord | null;
  columns: MetadataFieldDefinition[];
  userRole?: string | null;
  currentUserId?: string;
  currentUserEmail?: string;
  /** Active org id — required for asset-tag chips to be clickable. */
  orgId?: string;
  onCheckout?: (doc: DocumentRecord) => void;
  onSave: (payload: MetadataEditorSavePayload) => Promise<void>;
}) {
  const { isOpen, onClose, document, columns, onSave, userRole, currentUserId, currentUserEmail, orgId, onCheckout } = props;
  // Roles that can create assets / upload photos
  const canManageAssets = userRole === "Admin" || userRole === "Manager" || userRole === "Supervisor"
    || (userRole?.includes("Engineer") ?? false) || userRole === "Drafter" || userRole === "DocCtrl";

  // Only Admin and DocCtrl can edit
  const canEdit = userRole === "Admin" || userRole === "DocCtrl";

  // ── Core fields state ───────────────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [rev, setRev] = useState("");
  const [status, setStatus] = useState("");

  // ── Custom metadata state ───────────────────────────────────────────────────
  const initialMetadata = useMemo(
    () => (document?.metadata ?? {}) as Record<string, MetadataValue>,
    [document]
  );
  const [draft, setDraft] = useState<Record<string, MetadataValue>>(initialMetadata);
  const [saving, setSaving] = useState(false);

  // Sync when document or open state changes
  useEffect(() => {
    if (!document) return;
    setTitle(document.title ?? document.name ?? "");
    setDocumentNumber(document.documentNumber ?? "");
    setRev(document.rev ?? "");
    setStatus(document.status ?? "");
    setDraft((document.metadata ?? {}) as Record<string, MetadataValue>);
  }, [document, isOpen]);

  if (!isOpen || !document) return null;

  const applyIngestion = () => {
    if (!canEdit) return;
    const extracted = document.ingestion?.extractedFields ?? {};
    setDraft((prev) => ({ ...prev, ...extracted } as Record<string, MetadataValue>));
  };

  const updateField = (key: string, type: MetadataFieldDefinition["type"], value: unknown) => {
    if (!canEdit) return;
    setDraft((prev) => ({ ...prev, [key]: normalizeValue(value, type) }));
  };

  const save = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      await onSave({
        metadata: draft,
        core: { title, documentNumber, rev, status },
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // ── Field renderer ────────────────────────────────────────────────────────
  const renderField = (col: MetadataFieldDefinition) => {
    const value = draft[col.key];

    if (col.type === "select") {
      return (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => updateField(col.key, col.type, e.target.value)}
          disabled={!canEdit}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500"
        >
          <option value="">Select…</option>
          {(col.options ?? []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );
    }

    if (col.type === "multi" || col.type === "tags") {
      const list = Array.isArray(value)
        ? value
        : typeof value === "string"
        ? value.split(",").map((v) => v.trim()).filter(Boolean)
        : [];
      return (
        <TagInput
          values={list}
          label={col.pillGroupLabel || col.label || "tag"}
          disabled={!canEdit}
          onChange={(next) => updateField(col.key, col.type, next)}
          orgId={orgId}
          userId={currentUserId}
          canManageAssets={canManageAssets}
        />
      );
    }

    if (col.type === "boolean") {
      return (
        <label className="mt-2 inline-flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => updateField(col.key, col.type, e.target.checked)}
            disabled={!canEdit}
            className="h-4 w-4"
          />
          {col.label}
        </label>
      );
    }

    if (col.type === "number") {
      return (
        <input
          type="number"
          value={value == null ? "" : String(value)}
          onChange={(e) => updateField(col.key, col.type, e.target.value)}
          disabled={!canEdit}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500"
        />
      );
    }

    if (col.type === "date") {
      return (
        <input
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => updateField(col.key, col.type, e.target.value)}
          disabled={!canEdit}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500"
        />
      );
    }

    if (col.type === "link") {
      return (
        <input
          type="url"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => updateField(col.key, col.type, e.target.value)}
          disabled={!canEdit}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500"
          placeholder={canEdit ? "https://" : ""}
        />
      );
    }

    return (
      <input
        value={value == null ? "" : String(value)}
        onChange={(e) => updateField(col.key, col.type, e.target.value)}
        disabled={!canEdit}
        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500"
      />
    );
  };

  const fieldClass = "mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500";

  return (
    <div className="fixed inset-0 z-[90] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4 min-w-0">
            <div className="min-w-0">
              <div className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                Metadata Editor
              </div>
              <div className="text-xs text-slate-500 truncate">{document.documentNumber || document.title || "Document"}</div>
            </div>
            {onCheckout && (
              <div className="pl-4 border-l border-slate-200 shrink-0">
                <CheckoutStatusCell
                  docRecord={document}
                  currentUserId={currentUserId}
                  currentUserEmail={currentUserEmail}
                  userRole={userRole}
                  onCheckout={onCheckout}
                />
              </div>
            )}
            {!canEdit && (
              <span className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full shrink-0">
                View only
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 shrink-0"
          >
            <X className="h-4 w-4 text-slate-600" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Ingestion banner */}
          {canEdit && document.ingestion?.extractedFields && Object.keys(document.ingestion.extractedFields).length > 0 && (
            <button
              onClick={applyIngestion}
              className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700"
            >
              <Zap className="h-4 w-4" /> Apply extracted metadata
            </button>
          )}

          {/* ── CORE FIELDS ─────────────────────────────────────────────── */}
          <div>
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Document</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-600">Title</label>
                <input
                  value={title}
                  onChange={(e) => canEdit && setTitle(e.target.value)}
                  disabled={!canEdit}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600">Document Number</label>
                <input
                  value={documentNumber}
                  onChange={(e) => canEdit && setDocumentNumber(e.target.value)}
                  disabled={!canEdit}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600">Revision</label>
                <input
                  value={rev}
                  onChange={(e) => canEdit && setRev(e.target.value)}
                  disabled={!canEdit}
                  className={fieldClass}
                  placeholder="e.g. A, 0, 1"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600">Status</label>
                <select
                  value={status}
                  onChange={(e) => canEdit && setStatus(e.target.value)}
                  disabled={!canEdit}
                  className={fieldClass}
                >
                  <option value="">Select…</option>
                  {DOCUMENT_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* ── CUSTOM COLUMNS ───────────────────────────────────────────── */}
          {columns.length > 0 && (
            <div>
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Custom Fields</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {columns.map((col) => (
                  <div key={col.key} className={col.type === "tags" || col.type === "multi" ? "md:col-span-2" : ""}>
                    {col.type !== "boolean" && (
                      <label className="text-xs font-bold text-slate-600">
                        {col.label}{col.required ? " *" : ""}
                      </label>
                    )}
                    {renderField(col)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {columns.length === 0 && (
            <div className="text-center py-6 text-slate-400 text-sm italic border border-dashed border-slate-200 rounded-xl">
              No custom columns defined for this library yet.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50"
          >
            {canEdit ? "Cancel" : "Close"}
          </button>
          {canEdit && (
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
