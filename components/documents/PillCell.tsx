"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X, Check, Pencil } from "lucide-react";
import AssetTagChip from "@/components/assets/AssetTagChip";

/** The cell's box: exactly two rows of pills (26px each, 4px apart, 1px
 *  above and below). More than that scrolls down inside the cell, so a row
 *  with ten tags is as tall as a row with four. */
const BOX_MAX_H = 58;

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
  /** The folder filter: a tag it names comes first, ringed, so it's plain why the row is here. */
  highlight?: string;
}

export default function PillCell({
  values, label, canEdit, onSave,
  orgId, userId, canManageAssets, highlight = "",
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

  // The box: every tag, wrapped, scrolling down when there are more than
  // two rows; a soft fade at an edge where more is hidden.
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<{ above: boolean; below: boolean }>({ above: false, below: false });

  useEffect(() => {
    const el = boxRef.current;
    if (editing || !el) return;
    const check = () => {
      const above = el.scrollTop > 1;
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setMore((m) => (m.above === above && m.below === below ? m : { above, below }));
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (listRef.current) ro.observe(listRef.current);
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, [editing, pills.length]);

  // Pressing a pill must not pick up the row (rows drag into folders): the
  // row stops being draggable until the press ends.
  const holdRow = (e: React.PointerEvent) => {
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>('[draggable="true"]');
    if (!row) return;
    row.setAttribute("draggable", "false");
    const restore = () => {
      row.setAttribute("draggable", "true");
      window.removeEventListener("pointerup", restore, true);
      window.removeEventListener("pointercancel", restore, true);
    };
    window.addEventListener("pointerup", restore, true);
    window.addEventListener("pointercancel", restore, true);
  };

  const q = highlight.trim().toLowerCase();
  const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const isHit = (tag: string) => q.length > 0 && (plain(tag) === plain(q) || plain(tag.split(/[\s(]/)[0] ?? "") === plain(q) || (q.length >= 3 && !/\d/.test(q) && tag.toLowerCase().includes(q)));
  // A tag listed twice, with and without its site ID ("X-31 (2030.31)" and
  // "X-31"), shows once. What's saved stays as it is.
  const once = pills.filter((t) => !pills.some((o) => o !== t && o.toLowerCase().startsWith(`${t.toLowerCase()} (`)));
  const shown = q ? [...once.filter(isHit), ...once.filter((t) => !isHit(t))] : once;
  const chip = (tag: string) => (
    <AssetTagChip
      key={tag}
      hit={isHit(tag)}
      tag={tag}
      type={label}
      orgId={orgId}
      userId={userId}
      canManage={canManageAssets}
    />
  );

  // ── VIEW MODE ────────────────────────────────────────────────────────────────
  if (!editing) {
    const FADE = 14;
    const mask = more.above && more.below
      ? `linear-gradient(to bottom, transparent 0, #000 ${FADE}px, #000 calc(100% - ${FADE}px), transparent 100%)`
      : more.below
        ? `linear-gradient(to bottom, #000 calc(100% - ${FADE}px), transparent 100%)`
        : more.above
          ? `linear-gradient(to bottom, transparent 0, #000 ${FADE}px)`
          : undefined;
    return (
      <div className={`relative flex items-center min-w-0 ${saving ? "opacity-60" : ""}`}>
        {pills.length === 0 ? (
          <span className="text-[14px] text-[var(--color-text-faint)] select-none leading-6">-</span>
        ) : (
          // Every tag, wrapped, in a box two rows tall that scrolls down
          // (wheel, trackpad, touch) with a thin bar that shows there's
          // more. Each pill opens its equipment; its camera opens the
          // photos or adds them.
          <div
            ref={boxRef}
            role="group"
            aria-label={`${label}: ${pills.length}`}
            onPointerDown={holdRow}
            onDoubleClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden select-none [scrollbar-width:thin] [scrollbar-color:var(--color-border-strong)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--color-border-strong)]"
            style={{ maxHeight: BOX_MAX_H, ...(mask ? { maskImage: mask, WebkitMaskImage: mask } : {}) }}
          >
            <div ref={listRef} className="flex flex-wrap items-center content-start gap-1 py-px pr-1">
              {shown.map(chip)}
            </div>
          </div>
        )}

        {/* Edit, for people who may: an icon button at the cell's right edge
            that shows on the row's hover (always on a touchscreen). It takes
            no room from the pills. */}
        {canEdit && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 grid place-items-center rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-sm text-[var(--color-text-muted)] hover:text-[var(--color-main)] hover:bg-[var(--color-accent-soft)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
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
          className="flex-1 min-w-0 h-8 text-[14px] px-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]"
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
