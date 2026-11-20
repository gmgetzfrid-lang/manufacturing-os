"use client";

// Composer — the floating prompt card. Controls at rest: attach, Sources
// (where answers come from, web included), Answer (shape + Reasoning
// Skills), send — the same controls as every other place to ask. Enter sends, Shift+Enter breaks a line. Attachments
// ride as pills above the text; drop or paste an image and it lands there.
// Grows to about eight lines, then scrolls inside, so the page never jumps.

import React, { useEffect, useRef } from "react";
import {
  Paperclip, Send, Square, SlidersHorizontal, X, Image as ImageIcon, FileText, Loader2, Check,
} from "lucide-react";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { useIsMobile } from "@/hooks/useIsMobile";
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
  /** The picked file, kept so a failed upload can try again with it. */
  file?: File;
  /** The upload failed (not a file the chat can't take): Try again helps. */
  retryable?: boolean;
}

export default function Composer({
  value, onChange, onSend, onStop, busy,
  scope, libraryId, libraries, onScopeChange, scopeLocked,
  attachments, onAddFiles, onRemoveAttachment, onRetryAttachment,
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
  onRetryAttachment?: (localId: string) => void;
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
  const drag = useFileDrag(onAddFiles, busy);
  const isMobile = useIsMobile();
  const placeholder = disabledReason ?? (isMobile ? SCOPE_META[scope].short : SCOPE_META[scope].placeholder);

  // Auto-grow: measure, cap at ~8 lines, then scroll inside. Measured again
  // when the box changes width (a first measure taken before the layout
  // settled left a phone's empty box several lines tall).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const measure = () => {
      ta.style.height = "0px";
      const max = 8 * 24 + 16;
      // An empty box is as tall as its hint, so a hint that wraps on a
      // phone is never cut off under the controls.
      let h = ta.scrollHeight;
      if (!ta.value && ta.placeholder) {
        ta.value = ta.placeholder;
        h = ta.scrollHeight;
        ta.value = "";
      }
      ta.style.height = `${Math.min(h, max)}px`;
      ta.style.overflowY = h > max ? "auto" : "hidden";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let w = ta.clientWidth;
    const ro = new ResizeObserver(() => { if (ta.clientWidth !== w) { w = ta.clientWidth; measure(); } });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [value, placeholder]);


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

  return (
    <div
      {...drag.bind}
      className={`relative rounded-lg border bg-[var(--color-surface)] transition-colors border-[var(--color-border-strong)] focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent-ring)]/30 ${drag.ring}`}
    >
      {drag.over && (
        <div className="absolute inset-0 z-10 rounded-lg bg-[var(--color-surface-2)] flex flex-col items-center justify-center text-[15px] font-semibold text-[var(--color-text)] pointer-events-none">
          {drag.say}
          <span className="text-[13px] font-normal text-[var(--color-text-muted)]">Images and PDFs, for this question only</span>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="px-3 pt-3 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <div key={a.localId} title={a.error ?? `${a.name} · ${fmtBytes(a.size)}`}
              className={`relative inline-flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-md border text-[13px] font-semibold max-w-[300px] overflow-hidden ${a.error
                ? "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--state-overdue)]"
                : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]"}`}>
              {a.error && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
              {a.file
                ? <FileThumb file={a.file} size={32} />
                : a.kind === "image" && a.previewUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={a.previewUrl} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                  : a.kind === "image"
                    ? <ImageIcon className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
                    : <FileText className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />}
              <span className="min-w-0 flex flex-col leading-tight">
                <span className="truncate">{a.name}</span>
                <span className={`truncate font-normal text-[12px] ${a.error ? "" : "text-[var(--color-text-muted)]"}`}>
                  {a.error ? (a.retryable ? "Didn't upload" : a.error) : fmtBytes(a.size)}
                </span>
              </span>
              {a.att === null && !a.error
                ? <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] shrink-0"><Loader2 className="w-3 h-3 animate-spin" />{Math.round(a.percent)}%</span>
                : a.att && <Check className="w-3.5 h-3.5 text-[var(--state-released)] shrink-0" />}
              {a.error && a.retryable && a.file && onRetryAttachment && (
                <button type="button" onClick={() => onRetryAttachment(a.localId)} className="shrink-0 h-7 px-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] font-semibold">
                  Try again
                </button>
              )}
              <button type="button" onClick={() => onRemoveAttachment(a.localId)} className="p-0.5 rounded hover:bg-[var(--color-surface)] text-[var(--color-text-faint)] hover:text-[var(--color-text)] shrink-0" title="Remove" aria-label={`Remove ${a.name}`}>
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
        placeholder={placeholder}
        disabled={!!disabledReason}
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-6 text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none disabled:opacity-60"
      />

      {scope === "library" && (
        <div className="px-4 pb-1"><SkillHint skills={skills ?? null} picked={pickedSkills ?? null} question={value} answerMode={answerMode} /></div>
      )}

      <div className="flex items-center gap-1 px-2 pb-2">
        <input ref={fileRef} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
          onChange={(e) => { onAddFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} title="Attach an image or PDF (for this question only)" aria-label="Attach a file"
          className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
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
            className="h-8 inline-flex items-center gap-1 px-2 rounded-md text-[13px] font-semibold border border-[var(--color-border-strong)] text-[var(--color-text)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]">
            <SlidersHorizontal className="w-3.5 h-3.5" /> {instructionCount}
          </button>
        )}

        {busy ? (
          <button onClick={onStop} title="Stop" aria-label="Stop"
            className="shrink-0 h-9 max-sm:w-9 inline-flex items-center justify-center gap-1.5 sm:px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
            <Square className="w-3.5 h-3.5" /><span className="max-sm:sr-only">Stop</span>
          </button>
        ) : (
          // The one filled button on the chat.
          <button onClick={onSend} disabled={!canSend} title="Send (Enter)" aria-label="Send"
            className="shrink-0 h-9 max-sm:w-9 inline-flex items-center justify-center gap-1.5 sm:px-3.5 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[14px] font-semibold hover:bg-[var(--color-accent-hover)] shadow-[0_1px_0_rgb(0_0_0/0.12)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            <Send className="w-4 h-4" /><span className="max-sm:sr-only">Send</span>
          </button>
        )}
      </div>
    </div>
  );
}
