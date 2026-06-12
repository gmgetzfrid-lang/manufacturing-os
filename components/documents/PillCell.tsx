"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X, Check, Pencil } from "lucide-react";
import AssetTagChip from "@/components/assets/AssetTagChip";

interface PillCellProps {
  values: string[];
  label: string;
  canEdit: boolean;
  onSave: (values: string[]) => Promise<void>;
  // Asset-registry integration. When provided, view-mode chips become
  // clickable: click → carousel (with photos), uploader (no photos),
  // or auto-create + uploader (no asset yet).
  orgId?: string;
  userId?: string;
  canManageAssets?: boolean;
}

export default function PillCell({
  values, label, canEdit, onSave,
  orgId, userId, canManageAssets,
}: PillCellProps) {
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
      <div className={`flex items-start gap-1 min-w-0 ${saving ? "opacity-60" : ""}`}>
        {/* Pills wrap into multiple rows AND scroll vertically within fixed height */}
        <div className="flex flex-wrap gap-1 max-h-[52px] overflow-y-auto overflow-x-hidden flex-1 min-w-0 custom-scrollbar pr-1">
          {pills.length === 0 ? (
            <span className="text-[11px] text-slate-400 italic select-none leading-5">—</span>
          ) : (
            pills.map((tag) => (
              <AssetTagChip
                key={tag}
                tag={tag}
                type={label}
                orgId={orgId}
                userId={userId}
                canManage={canManageAssets}
              />
            ))
          )}
        </div>

        {/* Always-visible edit affordance for authorized users */}
        {canEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            className="shrink-0 flex items-center gap-0.5 text-[10px] font-bold text-blue-500 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 px-1.5 py-0.5 rounded-full transition-colors mt-0.5"
            title={`Edit ${label}`}
          >
            <Plus className="w-2.5 h-2.5" />
            {pills.length === 0 ? "Add" : <Pencil className="w-2.5 h-2.5" />}
          </button>
        )}
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
            // Only Enter and Tab finalize a tag. Comma is intentionally
            // NOT a separator — many real-world equipment tags contain
            // commas (e.g. "X-31 (2030,32)") and silently splitting on
            // them creates bogus tags that then duplicate-conflict.
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (input.trim()) {
                addPill();
              } else {
                handleSave();
              }
            }
            if (e.key === "Tab" && input.trim()) { e.preventDefault(); addPill(); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); handleSave(); }
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
      <p className="text-[10px] text-slate-400">Enter to add · Esc to save · commas are kept in the tag (not separators)</p>
    </div>
  );
}
