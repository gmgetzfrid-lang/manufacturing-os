"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X, Check, Pencil } from "lucide-react";
import AssetTagChip from "@/components/assets/AssetTagChip";

/** Pill slots in a cell: up to four tags; with more, three and a "+N"
 *  pill, so the cell stays two tidy rows of two. */
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
  // The "+N" list: where it opens (fixed, under the +N pill), or null.
  const [allAt, setAllAt] = useState<{ top: number; left: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
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

  // The full list closes on Escape, on its ×, on the +N pill again, or on a
  // click outside it (a pill's own quick look or uploader doesn't count).
  useEffect(() => {
    if (!allAt) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || listRef.current?.contains(t) || moreRef.current?.contains(t) || t.closest('[role="dialog"]')) return;
      setAllAt(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setAllAt(null); moreRef.current?.focus(); } };
    const onScroll = (e: Event) => { if (!listRef.current?.contains(e.target as Node)) setAllAt(null); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [allAt]);

  const openAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (allAt) { setAllAt(null); return; }
    const r = moreRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 320;
    setAllAt({
      top: Math.min(r.bottom + 6, window.innerHeight - 220),
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
    });
  };

  const chip = (tag: string) => (
    <AssetTagChip
      key={tag}
      tag={tag}
      type={label}
      orgId={orgId}
      userId={userId}
      canManage={canManageAssets}
    />
  );

  // ── VIEW MODE ────────────────────────────────────────────────────────────────
  if (!editing) {
    return (
      <div className={`relative flex items-center min-w-0 ${saving ? "opacity-60" : ""}`}>
        {/* Pills in tidy rows, four slots at most, the last a "+N" pill that
            opens the whole list. Each pill opens its equipment; its camera
            opens the photos or adds them. */}
        <div className="flex flex-wrap items-center content-center gap-1 flex-1 min-w-0">
          {pills.length === 0 ? (
            <span className="text-[14px] text-[var(--color-text-faint)] select-none leading-6">-</span>
          ) : (
            <>
              {pills.slice(0, pills.length > SHOWN ? SHOWN - 1 : SHOWN).map(chip)}
              {pills.length > SHOWN && (
                <button type="button" ref={moreRef} onClick={openAll}
                  title={`All ${pills.length} ${label}`}
                  aria-label={`Show all ${pills.length} ${label}`}
                  aria-expanded={!!allAt}
                  aria-haspopup="dialog"
                  className={`ui-tag is-more tabular-nums ${allAt ? "!bg-[var(--color-main)] !text-white !border-[var(--color-main)]" : ""}`}>
                  +{pills.length - (SHOWN - 1)}
                </button>
              )}
            </>
          )}
        </div>

        {/* Edit, for people who may: an icon button at the cell's right edge
            that shows on the row's hover (always on a touchscreen). It takes
            no room from the pills. */}
        {canEdit && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 grid place-items-center rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-sm text-[var(--color-text-muted)] hover:text-[var(--color-main)] hover:bg-[var(--color-accent-soft)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
            title={pills.length === 0 ? `Add ${label}` : `Edit ${label}`}
            aria-label={pills.length === 0 ? `Add ${label}` : `Edit ${label}`}
          >
            {pills.length === 0 ? <Plus className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
          </button>
        )}

        {allAt && typeof document !== "undefined" && createPortal(
          <div
            ref={listRef}
            role="dialog"
            aria-label={`All ${label}`}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            style={{ top: allAt.top, left: allAt.left, width: 320 }}
            className="fixed z-[600] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-xl p-3 max-h-[60vh] overflow-y-auto"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="font-display text-[15px] font-semibold text-[var(--color-heading)]">{label}</span>
              <span className="ui-count">{pills.length}</span>
              <button type="button" onClick={() => setAllAt(null)} aria-label="Close the list"
                className="ml-auto w-7 h-7 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {pills.map(chip)}
            </div>
          </div>,
          document.body,
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
              className="ui-tag tabular-nums !pr-0.5"
            >
              {pill}
              <button
                type="button"
                onClick={() => removePill(pill)}
                aria-label={`Remove ${pill}`}
                className="w-5 h-5 grid place-items-center rounded hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface)] transition-colors"
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
