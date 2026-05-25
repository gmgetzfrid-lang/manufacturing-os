"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X, Check } from "lucide-react";
import AssetTag from "@/components/ui/AssetTag";

interface PillCellProps {
  values: string[];
  label: string;
  canEdit: boolean;
  onSave: (values: string[]) => Promise<void>;
}

export default function PillCell({ values, label, canEdit, onSave }: PillCellProps) {
  const [editing, setEditing] = useState(false);
  const [pills, setPills] = useState<string[]>(values);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) setPills(values);
  }, [values, editing]);

  const addPill = useCallback(() => {
    const v = input.trim();
    if (v && !pills.includes(v)) setPills((p) => [...p, v]);
    setInput("");
    inputRef.current?.focus();
  }, [input, pills]);

  const removePill = useCallback((pill: string) => {
    setPills((p) => p.filter((x) => x !== pill));
  }, []);

  const handleSave = useCallback(async () => {
    setEditing(false);
    setSaving(true);
    try {
      await onSave(pills);
    } finally {
      setSaving(false);
    }
  }, [pills, onSave]);

  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleSave();
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [editing, handleSave]);

  useEffect(() => {
    if (editing) requestAnimationFrame(() => inputRef.current?.focus());
  }, [editing]);

  // ── VIEW MODE ────────────────────────────────────────────────────────────────
  if (!editing) {
    return (
      <div
        onClick={canEdit ? (e) => { e.stopPropagation(); setEditing(true); } : undefined}
        className={`relative rounded transition-all ${saving ? "opacity-60" : ""} ${
          canEdit ? "cursor-pointer group -mx-1 px-1 py-0.5 hover:ring-1 hover:ring-blue-200 hover:bg-blue-50/40" : ""
        }`}
        title={canEdit ? `Click to edit ${label}` : undefined}
      >
        {/* Single-row horizontal scroll */}
        <div className="flex flex-nowrap gap-1 overflow-x-auto scrollbar-none">
          {pills.length === 0 ? (
            canEdit ? (
              <span className="text-[11px] text-slate-300 italic select-none leading-5">+ Add {label}</span>
            ) : (
              <span className="text-slate-400 text-xs">—</span>
            )
          ) : (
            pills.map((tag) => <AssetTag key={tag} tag={tag} type={label} />)
          )}
        </div>
      </div>
    );
  }

  // ── EDIT MODE ─────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      onClick={(e) => e.stopPropagation()}
      className="flex flex-col gap-2 min-w-[220px] py-1 animate-in fade-in duration-100"
    >
      {pills.length > 0 && (
        <div className="flex flex-wrap gap-1 max-h-[80px] overflow-y-auto">
          {pills.map((pill) => (
            <span
              key={pill}
              className="inline-flex items-center gap-1 text-[11px] font-bold bg-blue-50 text-blue-800 border border-blue-200 px-2 py-0.5 rounded-full"
            >
              {pill}
              <button
                onClick={() => removePill(pill)}
                className="text-blue-300 hover:text-red-500 transition-colors ml-0.5"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); input.trim() ? addPill() : handleSave(); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); handleSave(); }
            if (e.key === ",") { e.preventDefault(); addPill(); }
          }}
          placeholder={`Add ${label}…`}
          className="flex-1 min-w-0 text-[11px] px-2 py-1.5 rounded-lg border border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white text-slate-800 placeholder-slate-400"
        />
        {input.trim() && (
          <button
            onClick={(e) => { e.stopPropagation(); addPill(); }}
            className="shrink-0 p-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
          >
            <Plus className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); handleSave(); }}
          className="shrink-0 p-1.5 bg-slate-900 hover:bg-slate-700 text-white rounded-lg transition-colors"
          title="Done"
        >
          <Check className="w-3 h-3" />
        </button>
      </div>
      <p className="text-[10px] text-slate-400">Enter or , to add · Esc to save</p>
    </div>
  );
}
