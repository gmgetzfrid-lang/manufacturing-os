"use client";

// Composer — the floating prompt card. Controls at rest: attach, Sources
// (where answers come from, web included), Answer (shape + Reasoning
// Skills), send — the same controls as every other place to ask. Enter
// sends, Shift+Enter breaks a line.
//
// Every state is designed:
//   rest      quiet box, a hint as an example, Send quiet (nothing to send)
//   focus     the app's focus ring outside the box; the border never changes
//   has text  Send wakes up as the one filled button
//   growing   the text grows upward to about eight lines, then scrolls
//             inside; the toolbar row stays where it is
//   files     dropped, pasted or picked files upload inside the box, each
//             with its own progress ring and an inline Try again
//   answering Send turns into Stop in the same place, same size

import React, { useEffect, useRef } from "react";
import {
  Paperclip, Send, Square, SlidersHorizontal, X, Image as ImageIcon, FileText, Check,
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
      className={`ui-field-box relative rounded-xl border bg-[var(--color-surface)] border-[var(--color-border-control)] ${drag.ring}`}
    >
      {drag.over && (
        <div className="absolute inset-0 z-10 rounded-xl bg-[var(--color-surface-2)] flex flex-col items-center justify-center text-reading font-medium text-[var(--color-text)] pointer-events-none">
          {drag.say}
          <span className="text-body font-normal text-[var(--color-text-muted)]">Images and PDFs, for this question only</span>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="px-3 pt-3 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <div key={a.localId} title={a.error ?? `${a.name} · ${fmtBytes(a.size)}`}
              className={`relative inline-flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-md border text-body font-semibold max-w-[300px] overflow-hidden ${a.error
                ? "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--state-overdue)]"
                : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]"}`}>
              {a.error && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
              {a.file
                ? <FileThumb file={a.file} size={32} />
                : a.kind === "image" && a.previewUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={a.previewUrl} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                  : a.kind === "image"
                    ? <ImageIcon aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />
                    : <FileText aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />}
              <span className="min-w-0 flex flex-col leading-tight">
                <span className="truncate">{a.name}</span>
                <span className={`truncate font-normal text-caption ${a.error ? "" : "text-[var(--color-text-muted)]"}`}>
                  {a.error ? (a.retryable ? "Didn't upload" : a.error) : fmtBytes(a.size)}
                </span>
              </span>
              {a.att === null && !a.error
                ? <ProgressRing percent={a.percent} />
                : a.att && <Check aria-label="Uploaded" className="w-3.5 h-3.5 text-[var(--state-released)] shrink-0" />}
              {a.error && a.retryable && a.file && onRetryAttachment && (
                <button type="button" onClick={() => onRetryAttachment(a.localId)} className="shrink-0 h-7 pointer-coarse:h-9 px-2 rounded-md text-[var(--color-accent-text)] hover:underline underline-offset-2 font-medium">
                  Try again
                </button>
              )}
              <button type="button" onClick={() => onRemoveAttachment(a.localId)} className="w-6 h-6 pointer-coarse:w-9 pointer-coarse:h-9 grid place-items-center rounded-md hover:bg-[var(--color-surface)] text-[var(--color-text-faint)] hover:text-[var(--color-text)] shrink-0" title="Remove" aria-label={`Remove ${a.name}`}>
                <X className="w-3.5 h-3.5" />
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
        aria-label="Your question"
        enterKeyHint="send"
        className="ui-field-bare block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-reading leading-6 text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] disabled:opacity-60"
      />

      {scope === "library" && (
        <div className="px-4 pb-1"><SkillHint skills={skills ?? null} picked={pickedSkills ?? null} question={value} answerMode={answerMode} /></div>
      )}

      <div className="flex items-center gap-1 px-2 pb-2">
        <input ref={fileRef} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
          onChange={(e) => { onAddFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <button type="button" onClick={() => fileRef.current?.click()} title="Attach an image or PDF (for this question only)" aria-label="Attach a file"
          className="h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
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
          <button type="button" onClick={onToggleInstructions} title="Instructions apply to this conversation" aria-label={`${instructionCount} instructions apply`}
            className="h-8 pointer-coarse:h-11 inline-flex items-center gap-1 px-2 rounded-lg text-body font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <SlidersHorizontal className="w-3.5 h-3.5" /> {instructionCount}
          </button>
        )}

        {/* One button, one place: Send (quiet until there's something to
            send, then the chat's one filled button), and Stop while it
            answers, at the same size. */}
        {busy ? (
          <button type="button" onClick={onStop} title="Stop answering" aria-label="Stop answering"
            className="shrink-0 h-9 pointer-coarse:h-11 max-sm:w-9 max-sm:pointer-coarse:w-11 sm:min-w-[5.5rem] inline-flex items-center justify-center gap-2 sm:px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
            <span aria-hidden className="relative grid place-items-center w-5 h-5">
              <span className="absolute inset-0 rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-text)] animate-spin motion-reduce:animate-none" />
              <Square className="w-2.5 h-2.5 fill-current" />
            </span>
            <span className="max-sm:sr-only">Stop</span>
          </button>
        ) : (
          <button type="button" onClick={onSend} disabled={!canSend} title="Send (Enter)" aria-label="Send"
            className={`shrink-0 h-9 pointer-coarse:h-11 max-sm:w-9 max-sm:pointer-coarse:w-11 sm:min-w-[5.5rem] inline-flex items-center justify-center gap-2 sm:px-3.5 rounded-lg border text-body font-semibold transition-colors disabled:cursor-not-allowed ${canSend
              ? "border-transparent bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
              : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-faint)]"}`}>
            <Send className="w-4 h-4" /><span className="max-sm:sr-only">Send</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Honest upload progress: a small ring that fills with the percent sent. */
function ProgressRing({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent));
  const r = 7, c = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-1 text-caption tabular-nums text-[var(--color-text-muted)] shrink-0"
      role="progressbar" aria-label="Uploading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="-rotate-90">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--color-border-strong)" strokeWidth="2" />
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--color-text)" strokeWidth="2" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} style={{ transition: "stroke-dashoffset 150ms ease-out" }} />
      </svg>
      {Math.round(p)}%
    </span>
  );
}
