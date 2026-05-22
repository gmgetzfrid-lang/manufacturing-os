"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { X, Sparkles, Plus } from "lucide-react";
import type { DocumentRecord, MetadataFieldDefinition, MetadataValue } from "@/types/schema";
import CheckoutStatusCell from "./CheckoutStatusCell";

function TagInput({
  values,
  label,
  disabled,
  onChange,
}: {
  values: string[];
  label: string;
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addPill = () => {
    const v = input.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput("");
    inputRef.current?.focus();
  };

  const removePill = (pill: string) => onChange(values.filter((x) => x !== pill));

  return (
    <div
      className={`mt-1 w-full rounded-lg border px-2 py-2 text-sm ${
        disabled ? "bg-slate-50 border-slate-200" : "bg-white border-slate-300 focus-within:ring-2 focus-within:ring-blue-500"
      }`}
    >
      <div className="flex flex-wrap gap-1.5">
        {values.map((pill) => (
          <span
            key={pill}
            className="inline-flex items-center gap-1 text-[11px] font-bold bg-blue-50 text-blue-800 border border-blue-200 px-2 py-0.5 rounded-full"
          >
            {pill}
            {!disabled && (
              <button
                type="button"
                onClick={() => removePill(pill)}
                className="text-blue-300 hover:text-red-500 transition-colors"
                title={`Remove ${pill}`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
          </span>
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
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addPill();
              }
            }}
            placeholder={`Add ${label}…`}
            className="flex-1 min-w-0 text-[12px] px-2 py-1 rounded-md border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
          />
          {input.trim() && (
            <button
              type="button"
              onClick={addPill}
              className="shrink-0 p-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors"
              title="Add"
            >
              <Plus className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function normalizeValue(value: unknown, type: MetadataFieldDefinition["type"]): MetadataValue {
  if (type === "number") {
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  if (type === "boolean") return Boolean(value);
  if (type === "multi" || type === "tags") {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === "string") {
      return value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    }
    return [];
  }
  if (type === "date") {
    if (!value) return null;
    return String(value);
  }
  return value == null ? null : String(value);
}

export default function MetadataEditor(props: {
  isOpen: boolean;
  onClose: () => void;
  document: DocumentRecord | null;
  columns: MetadataFieldDefinition[];
  userRole?: string | null;
  currentUserId?: string;
  currentUserEmail?: string;
  onCheckout?: (doc: DocumentRecord) => void;
  onSave: (next: { metadata: Record<string, MetadataValue> }) => Promise<void>;
}) {
  const { isOpen, onClose, document, columns, onSave, userRole, currentUserId, currentUserEmail, onCheckout } = props;
  
  const canEdit = userRole === 'Admin' || userRole === 'DocCtrl';

  const initialMetadata = useMemo(() => {
    return (document?.metadata ?? {}) as Record<string, MetadataValue>;
  }, [document]);

  const [draft, setDraft] = useState<Record<string, MetadataValue>>(initialMetadata);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(initialMetadata);
  }, [initialMetadata, isOpen]);

  if (!isOpen || !document) return null;

  const applyIngestion = () => {
    if (!canEdit) return;
    const extracted = document.ingestion?.extractedFields ?? {};
    const next = { ...draft } as Record<string, MetadataValue>;
    for (const key of Object.keys(extracted)) {
      next[key] = extracted[key] as MetadataValue;
    }
    setDraft(next);
  };

  const updateField = (key: string, type: MetadataFieldDefinition["type"], value: unknown) => {
    if (!canEdit) return;
    setDraft((prev) => ({ ...prev, [key]: normalizeValue(value, type) }));
  };

  const save = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      await onSave({ metadata: draft });
      onClose();
    } finally {
      setSaving(false);
    }
  };

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
          <option value="">Select...</option>
          {(col.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
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

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <div className="text-sm font-bold text-slate-900">Metadata</div>
              <div className="text-xs text-slate-500">{document.documentNumber || document.title || "Document"}</div>
            </div>
            
            {/* CHECKOUT STATUS IN HEADER */}
            {onCheckout && (
              <div className="pl-4 border-l border-slate-200">
                <CheckoutStatusCell 
                  docRecord={document} 
                  currentUserId={currentUserId}
                  currentUserEmail={currentUserEmail} 
                  userRole={userRole} 
                  onCheckout={onCheckout}
                />
              </div>
            )}
          </div>
          
          <button
            onClick={onClose}
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
          >
            <X className="h-4 w-4 text-slate-600" />
          </button>
        </div>

        <div className="p-6">
          {canEdit && document.ingestion?.extractedFields && Object.keys(document.ingestion.extractedFields).length > 0 && (
            <button
              onClick={applyIngestion}
              className="mb-4 inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700"
            >
              <Sparkles className="h-4 w-4" />
              Apply extracted metadata
            </button>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {columns.map((col) => (
              <div key={col.key}>
                {col.type !== "boolean" && (
                  <label className="text-xs font-bold text-slate-600">
                    {col.label}
                    {col.required ? " *" : ""}
                  </label>
                )}
                {renderField(col)}
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
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
              className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-bold hover:bg-slate-800"
            >
              {saving ? "Saving..." : "Save metadata"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
