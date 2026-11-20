"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X, Check, Pencil } from "lucide-react";
import AssetTagChip from "@/components/assets/AssetTagChip";

/** Tags shown before "+N". */
const SHOWN = 4;

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
  const [showAll, setShowAll] = useState(false);
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
        {/* Compact text tags, a few at a time: the first four, then "+N". */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0 flex-1 min-w-0 pr-1">
          {pills.length === 0 ? (
            <span className="text-[14px] text-[var(--color-text-faint)] select-none leading-6">-</span>
          ) : (
            <>
              {(showAll ? pills : pills.slice(0, SHOWN)).map((tag) => (
                <AssetTagChip
                  key={tag}
                  tag={tag}
                  type={label}
                  orgId={orgId}
                  userId={userId}
                  canManage={canManageAssets}
                />
              ))}
              {pills.length > SHOWN && (
                <button type="button" onClick={(e) => { e.stopPropagation(); setShowAll((v) => !v); }}
                  title={showAll ? "Show fewer" : pills.slice(SHOWN).join(", ")}
                  aria-label={showAll ? "Show fewer" : `Show ${pills.length - SHOWN} more ${label}`}
                  className="h-6 px-1.5 rounded text-[13px] font-semibold tabular-nums text-[var(--color-text-muted)] bg-[var(--color-surface-2)] hover:text-[var(--color-text)]">
                  {showAll ? "Less" : `+${pills.length - SHOWN}`}
                </button>
              )}
            </>
          )}
        </div>

        {/* Edit, for people who may: an icon button that shows on the row's hover. */}
        {canEdit && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            className="shrink-0 w-6 h-6 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            title={pills.length === 0 ? `Add ${label}` : `Edit ${label}`}
            aria-label={pills.length === 0 ? `Add ${label}` : `Edit ${label}`}
          >
            {pills.length === 0 ? <Plus className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
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
              className="inline-flex items-center gap-1 font-display text-[14px] font-semibold tabular-nums bg-[var(--color-surface-2)] text-[var(--color-text)] pl-2 pr-1 h-6 rounded"
            >
              {pill}
              <button
                type="button"
                onClick={() => removePill(pill)}
                aria-label={`Remove ${pill}`}
                className="w-5 h-5 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface)] transition-colors"
              >
                <X className="w-3 h-3" />
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
          className="flex-1 min-w-0 h-8 text-[14px] px-2 rounded-md border border-[var(--color-border-strong)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]"
        />
        {input.trim() && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); addPill(); }}
            aria-label={`Add ${input.trim()}`}
            className="shrink-0 w-8 h-8 grid place-items-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] rounded-md transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleSave(); }}
          className="shrink-0 h-8 px-2.5 inline-flex items-center gap-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[13px] font-semibold text-[var(--color-text)] transition-colors"
        >
          <Check className="w-3.5 h-3.5" /> Done
        </button>
      </div>
      <p className="text-[13px] text-[var(--color-text-muted)]">Enter adds a tag, Esc saves. Commas stay in the tag.</p>
    </div>
  );
}
