"use client";

// Composer — the floating prompt card. Controls at rest: attach, Sources
// (where answers come from, web included), Answer (shape + Reasoning
// Skills), send — the same controls as every other place to ask. Enter sends, Shift+Enter breaks a line. Attachments
// ride as pills above the text; drop or paste an image and it lands there.
// Grows to about eight lines, then scrolls inside, so the page never jumps.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Paperclip, Send, Square, SlidersHorizontal, X, Image as ImageIcon, FileText, Loader2, Check,
} from "lucide-react";
import { SourcesMenu, AnswerMenu, SkillHint } from "./AskControls";
import type { AnswerSkill } from "@/lib/answerSkills";
import type { ChatScope, ChatAttachment } from "@/lib/chatClient";
import type { KnowledgeLibrary } from "@/lib/knowledge";
import { SCOPE_META, fmtBytes } from "./shared";
import type { AnswerMode } from "@/lib/answerModes";

export interface PendingAttachment {
  localId: string;
  att: ChatAttachment | null;      // null while uploading
  name: string;
  size: number;
  kind: "image" | "pdf";
  percent: number;
  error?: string;
  previewUrl?: string;             // object URL for images
}

export default function Composer({
  value, onChange, onSend, onStop, busy,
  scope, libraryId, libraries, onScopeChange, scopeLocked,
  attachments, onAddFiles, onRemoveAttachment,
  instructionsActive, instructionCount, onToggleInstructions,
  disabledReason, autoFocus, webOn = false, onToggleWeb, answerMode = null, onAnswerMode,
  skills, pickedSkills, onPickSkills,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  scope: ChatScope;
  libraryId: string | null;
  libraries: KnowledgeLibrary[];
  /** Picking a scope on an existing conversation starts a new one. */
  onScopeChange: (scope: ChatScope, libraryId: string | null) => void;
  scopeLocked: boolean;
  attachments: PendingAttachment[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (localId: string) => void;
  instructionsActive: boolean;
  instructionCount: number;
  onToggleInstructions: () => void;
  /** When set, the composer explains why asking is off instead of a placeholder. */
  disabledReason?: string | null;
  autoFocus?: boolean;
  /** Library questions: may this one also search the internet? */
  webOn?: boolean;
  onToggleWeb?: () => void;
  /** The answer's shape, picked before asking; null = Auto. */
  answerMode?: AnswerMode | null;
  onAnswerMode?: (m: AnswerMode | null) => void;
  /** The workspace's Reasoning Skills, and the ones picked for this question. */
  skills?: AnswerSkill[] | null;
  pickedSkills?: string[] | null;
  onPickSkills?: (ids: string[] | null) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Auto-grow: measure, cap at ~8 lines, then scroll inside.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    const max = 8 * 24 + 16;
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }, [value]);


  const canSend = !busy && value.trim().length > 0 && !disabledReason && attachments.every((a) => a.att !== null || a.error);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) { e.preventDefault(); onAddFiles(files); }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onAddFiles(files);
  }, [onAddFiles]);

  const meta = SCOPE_META[scope];

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`relative rounded-2xl border bg-[var(--color-surface)] shadow-[0_12px_40px_-18px_rgba(2,6,23,0.45)] transition-colors ${dragging
        ? "border-[var(--color-accent-ring)] ring-2 ring-[var(--color-accent-ring)]/40"
        : "border-[var(--color-border-strong)] focus-within:border-[var(--color-accent-ring)]"}`}
    >
      {dragging && (
        <div className="absolute inset-0 z-10 rounded-2xl bg-[var(--color-accent-soft)]/80 flex items-center justify-center text-sm font-black text-[var(--color-accent)] pointer-events-none">
          Drop an image or PDF — context for this question only
        </div>
      )}

      {attachments.length > 0 && (
        <div className="px-3 pt-3 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <div key={a.localId} title={a.error ?? `${a.name} · ${fmtBytes(a.size)}`}
              className={`inline-flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-lg border text-[11px] font-bold max-w-[240px] ${a.error
                ? "border-rose-300 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300"
                : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]"}`}>
              {a.kind === "image" && a.previewUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={a.previewUrl} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
                : a.kind === "image"
                  ? <ImageIcon className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
                  : <FileText className="w-4 h-4 shrink-0 text-rose-600" />}
              <span className="truncate">{a.name}</span>
              {a.att === null && !a.error
                ? <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><Loader2 className="w-3 h-3 animate-spin" />{Math.round(a.percent)}%</span>
                : a.att && <Check className="w-3 h-3 text-emerald-600 shrink-0" />}
              <button onClick={() => onRemoveAttachment(a.localId)} className="p-0.5 rounded hover:bg-[var(--color-surface)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]" title="Remove">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        rows={1}
        autoFocus={autoFocus}
        placeholder={disabledReason ?? meta.placeholder}
        disabled={!!disabledReason}
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-6 text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none disabled:opacity-60"
      />

      {scope === "library" && (
        <div className="px-4 pb-1"><SkillHint skills={skills ?? null} picked={pickedSkills ?? null} question={value} answerMode={answerMode} /></div>
      )}

      <div className="flex items-center gap-1 px-2 pb-2">
        <input ref={fileRef} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
          onChange={(e) => { onAddFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} title="Attach an image or PDF (context for this question only)"
          className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
          <Paperclip className="w-4 h-4" />
        </button>

        <SourcesMenu scope={scope} libraryId={libraryId} libraries={libraries} onScopeChange={onScopeChange}
          scopeLocked={scopeLocked} webOn={webOn} onToggleWeb={onToggleWeb ?? (() => undefined)} />

        {scope === "library" && onAnswerMode && (
          <AnswerMenu answerMode={answerMode} onAnswerMode={onAnswerMode} skills={skills ?? null}
            picked={pickedSkills ?? null} onPick={onPickSkills ?? (() => undefined)} question={value}
            instructionCount={instructionCount} onOpenInstructions={onToggleInstructions} />
        )}

        <span className="flex-1" />

        {instructionsActive && (
          <button onClick={onToggleInstructions} title="Instructions apply to this conversation"
            className="h-8 inline-flex items-center gap-1 px-2 rounded-lg text-[11px] font-black border border-violet-300 dark:border-violet-800 text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/30">
            <SlidersHorizontal className="w-3.5 h-3.5" /> {instructionCount}
          </button>
        )}

        {busy ? (
          <button onClick={onStop} title="Stop"
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg bg-[var(--color-text)] text-[var(--color-surface)] hover:opacity-90 transition-opacity">
            <Square className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button onClick={onSend} disabled={!canSend} title="Send (Enter)"
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-35 disabled:cursor-not-allowed transition-colors">
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
