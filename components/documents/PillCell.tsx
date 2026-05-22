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

  // Sync external values when not editing
  useEffect(() => {
    if (!editing) setPills(values);
  }, [values, editing]);

  const addPill = useCallback(() => {
    const v = input.trim();
    if (v && !pills.includes(v)) {
      setPills((p) => [...p, v]);
    }
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

  // Close on outside click
  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleSave();
      }
    };
    // Use capture phase so we handle clicks before table row click handler
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [editing, handleSave]);

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [editing]);

  if (!editing) {
    return (
      <div
        onClick={
          canEdit
            ? (e) => {
                e.stopPropagation();
                setEditing(true);
              }
            : undefined
        }
        className={`flex flex-wrap gap-1 min-h-[26px] rounded transition-all ${
          canEdit
            ? "cursor-pointer hover:ring-1 hover:ring-blue-200 hover:bg-blue-50/40 -mx-1 px-1 py-0.5"
            : ""
        } ${saving ? "opacity-60" : ""}`}
        title={canEdit ? `Click to edit ${label}` : undefined}
      >
        {pills.length === 0 ? (
          canEdit ? (
            <span className="text-[11px] text-slate-300 italic select-none">+ Add {label}</span>
          ) : (
            <span className="text-slate-400 text-xs">—</span>
          )
        ) : (
          pills.map((tag) => <AssetTag key={tag} tag={tag} type={label} />)
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onClick={(e) => e.stopPropagation()}
      className="flex flex-col gap-2 min-w-[200px] py-1 animate-in fade-in duration-100"
    >
      {/* Existing pills with remove buttons */}
      {pills.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {pills.map((pill) => (
            <span
              key={pill}
              className="inline-flex items-center gap-1 text-[11px] font-bold bg-blue-50 text-blue-800 border border-blue-200 px-2 py-0.5 rounded-full"
            >
              {pill}
              <button
                onClick={() => removePill(pill)}
                className="text-blue-300 hover:text-red-500 transition-colors ml-0.5"
                title={`Remove ${pill}`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (input.trim()) addPill();
              else handleSave();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              handleSave();
            }
            // Comma as separator
            if (e.key === ",") {
              e.preventDefault();
              addPill();
            }
          }}
          placeholder={`Add ${label}…`}
          className="flex-1 min-w-0 text-[11px] px-2 py-1.5 rounded-lg border border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white text-slate-800 placeholder-slate-400"
        />
        {input.trim() && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              addPill();
            }}
            className="shrink-0 p-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
            title="Add tag"
          >
            <Plus className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleSave();
          }}
          className="shrink-0 p-1.5 bg-slate-900 hover:bg-slate-700 text-white rounded-lg transition-colors"
          title="Done (Enter)"
        >
          <Check className="w-3 h-3" />
        </button>
      </div>
      <p className="text-[10px] text-slate-400">Enter or comma to add · Esc to save</p>
    </div>
  );
}
