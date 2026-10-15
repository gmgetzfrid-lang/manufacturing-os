"use client";

// components/thor/GhostField.tsx — a search box with ghost text.
//
// Two kinds of grey text, both from the THOR index (lib/thor/suggest.ts):
// while typing, the rest of the word or phrase sits after the caret and Tab
// (or → at the end) takes it; while empty, real example searches take turns
// as the placeholder. A mirror layer behind a transparent field draws the
// ghost exactly where the typed text ends.

import React, { useEffect, useRef, useState } from "react";

export default function GhostField({ value, onChange, onSubmit, ghost, examples, rows, className, mirrorClassName, hintClassName = "right-2 bottom-1.5", placeholder, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** The suggested rest of what is being typed ("" for none). */
  ghost: string;
  /** Example searches to cycle through while the box is empty. */
  examples: string[];
  /** Multi-line when set (Enter still searches; Shift+Enter breaks a line). */
  rows?: number;
  /** Classes for the field — padding, font and size must match the mirror's. */
  className: string;
  mirrorClassName?: string;
  /** Where the "Tab to complete" hint sits. */
  hintClassName?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [i, setI] = useState(0);
  const mirror = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (examples.length < 2 || value) return;
    const t = window.setInterval(() => setI((n) => (n + 1) % examples.length), 3500);
    return () => window.clearInterval(t);
  }, [examples.length, value]);

  const accept = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    const el = e.currentTarget;
    const atEnd = el.selectionStart === value.length && el.selectionEnd === value.length;
    if (ghost && atEnd && (e.key === "Tab" || e.key === "ArrowRight")) { e.preventDefault(); onChange(value + ghost); return true; }
    if (!value && examples.length && e.key === "Tab") { e.preventDefault(); onChange(examples[i % examples.length]); return true; }
    return false;
  };
  const keyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (accept(e)) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
  };
  const example = examples.length ? examples[i % examples.length] : "";
  const ph = example ? `Try: ${example}` : placeholder;
  // The mirror paints the background; the field above it stays see-through.
  const fieldCls = `${className.replace(/(^|\s)bg-\S+/g, " ")} relative bg-transparent`;
  const syncScroll = (e: React.UIEvent<HTMLTextAreaElement>) => { if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop; };

  return (
    <div className="relative">
      <div ref={mirror} aria-hidden className={`${className} ${mirrorClassName ?? ""} absolute inset-0 overflow-hidden pointer-events-none ${rows ? "whitespace-pre-wrap break-words" : "whitespace-pre"} border-transparent`}>
        <span className="invisible">{value}</span>
        {ghost && <span className="text-[var(--color-text-muted)] opacity-60">{ghost}</span>}
      </div>
      {rows ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={keyDown} onScroll={syncScroll} rows={rows}
          placeholder={ph} autoFocus={autoFocus} spellCheck={false} className={fieldCls} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={keyDown} placeholder={ph} autoFocus={autoFocus}
          spellCheck={false} className={fieldCls} />
      )}
      {(ghost || (!value && example)) && (
        <div className={`absolute ${hintClassName} text-[10px] text-[var(--color-text-muted)] pointer-events-none`}>
          <kbd className="rounded border border-[var(--color-border)] px-1">Tab</kbd> {ghost ? "to complete" : "for this example"}
        </div>
      )}
    </div>
  );
}
