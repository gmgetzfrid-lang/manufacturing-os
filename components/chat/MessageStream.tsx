"use client";

// MessageStream — the conversation, scrolled the way people read answers:
//   • while a question runs, the thread stays put and a ghost turn shows the
//     live status line and the answer as it streams;
//   • when the answer lands, the START of it is brought into view (not the
//     footer), unless the reader has scrolled away — then a "latest" pill;
//   • auto-follow while pinned to the bottom, hands-off the moment you
//     scroll up.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Loader2, Sparkles } from "lucide-react";
import type { ChatMessage, ChatScope } from "@/lib/chatClient";
import { EXAMPLES, SCOPE_META } from "./shared";

export interface StreamingState {
  status: string;
  draft: string;
  /** The question being answered — rendered as a pending user bubble. */
  question: string;
  attachmentsCount: number;
}

export default function MessageStream({
  messages, streaming, scope, renderUser, renderAssistant, onExample, emptyNote,
}: {
  messages: ChatMessage[];
  streaming: StreamingState | null;
  scope: ChatScope;
  renderUser: (m: ChatMessage) => React.ReactNode;
  renderAssistant: (m: ChatMessage, isLast: boolean) => React.ReactNode;
  onExample: (q: string) => void;
  emptyNote?: string | null;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const lastAssistantId = useRef<string | null>(null);
  const wasStreaming = useRef(false);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(gap < 80);
  }, []);

  // A new question: go to the bottom so the pending turn is in view. Keyed
  // on the question alone — every streamed delta must NOT drag the reader
  // back down if they scrolled up to re-read.
  const activeQuestion = streaming?.question ?? null;
  useEffect(() => {
    if (!activeQuestion) return;
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    wasStreaming.current = true;
  }, [activeQuestion]);

  // Follow the stream only while pinned to the bottom.
  const draftLength = streaming?.draft.length ?? 0;
  const statusText = streaming?.status ?? "";
  useEffect(() => {
    if (!activeQuestion || !atBottom) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [draftLength, statusText, activeQuestion, atBottom]);

  // Opening a long conversation lands at the top: measure once the turns
  // are in, so the "Latest" pill tells the truth without a first scroll.
  useEffect(() => {
    const raf = requestAnimationFrame(onScroll);
    return () => cancelAnimationFrame(raf);
  }, [messages.length, onScroll]);

  // The answer landed: anchor its START at the top of the viewport.
  useLayoutEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last || last.id === lastAssistantId.current) return;
    const fresh = wasStreaming.current;
    lastAssistantId.current = last.id;
    if (!fresh) return;
    wasStreaming.current = false;
    const el = scrollerRef.current;
    const node = el?.querySelector<HTMLElement>(`[data-turn="${last.id}"]`);
    if (!el || !node) return;
    // Leave room for the one-line question pill that pins above it.
    const top = node.offsetTop - 48;
    el.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [messages]);

  const jump = () => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const empty = messages.length === 0 && !streaming;
  const meta = SCOPE_META[scope];
  const Icon = meta.icon;

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scrollerRef} onScroll={onScroll} data-chat-scroller className="h-full overflow-y-auto px-4 sm:px-6">
        {/* Wide enough for the answer + proof columns side by side; the
            question bubble and prose still cap themselves narrower. */}
        <div className="mx-auto max-w-5xl pt-4 pb-6">
          {empty ? (
            <div className="pt-[12vh] text-center animate-rise">
              <div className="mx-auto w-12 h-12 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center shadow-lg">
                <Icon className="w-6 h-6 text-white" />
              </div>
              <h2 className="mt-4 text-lg font-black text-[var(--color-text)]">{meta.label}</h2>
              <p className="mt-1 text-xs text-[var(--color-text-muted)] max-w-md mx-auto">{meta.hint}</p>
              {emptyNote && <p className="mt-2 text-[11px] font-bold text-amber-700 dark:text-amber-400 max-w-md mx-auto">{emptyNote}</p>}
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {EXAMPLES[scope].map((e) => (
                  <button key={e} onClick={() => onExample(e)}
                    className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-bold text-[var(--color-text)] hover:border-[var(--color-accent-ring)] hover:bg-[var(--color-accent-soft)] transition-colors">
                    {e}
                  </button>
                ))}
              </div>
              {scope !== "internet" && (
                <p className="mt-6 text-[10px] text-[var(--color-text-faint)]">
                  It only reads documents approved for indexing. Anything excluded from AI stays invisible to it.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {messages.map((m, i) => {
                const isLast = i === messages.length - 1 && !streaming;
                return m.role === "user" ? (
                  <React.Fragment key={m.id}>{renderUser(m)}</React.Fragment>
                ) : (
                  <div key={m.id} data-turn={m.id} className="pb-6 animate-rise">
                    {renderAssistant(m, isLast)}
                  </div>
                );
              })}
              {streaming && (
                <div className="pb-6">
                  <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 animate-rise">
                    <div className="flex items-center gap-2 text-xs font-black text-[var(--color-text)]">
                      <Loader2 className="w-4 h-4 text-orange-600 animate-spin shrink-0" />
                      {streaming.status || "Working"}
                      <span className="text-[var(--color-text-faint)]">…</span>
                    </div>
                    {streaming.draft && (
                      <div className="mt-3 pt-3 border-t border-dashed border-[var(--color-border)]">
                        <div className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.18em] text-[var(--color-text-faint)] mb-1.5">
                          <Sparkles className="w-3 h-3" /> Drafting
                        </div>
                        <div className="text-sm text-[var(--color-text-muted)] whitespace-pre-wrap leading-relaxed">
                          {/* The trailing Evidence block is highlight data for
                              the citations, not prose — never stream it. */}
                          {streaming.draft.split(/\n\s*(?:#{1,4}\s*)?\*{0,2}Evidence:?\*{0,2}:?\s*(?:\n|$)/i)[0]}
                          <span className="inline-block w-1.5 h-4 ml-0.5 align-text-bottom bg-orange-500/70 animate-pulse rounded-sm" />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {!atBottom && !empty && (
        <button onClick={jump}
          className="absolute left-1/2 -translate-x-1/2 bottom-3 inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[11px] font-black text-[var(--color-text)] shadow-lg hover:border-[var(--color-accent-ring)] transition-colors animate-pop">
          <ArrowDown className="w-3.5 h-3.5" /> Latest
        </button>
      )}
    </div>
  );
}
