"use client";

// MessageStream — the conversation, scrolled the way people read answers:
//   • while a question runs, the thread stays put and a ghost turn shows the
//     live status line and the answer as it streams;
//   • when the answer lands, the START of it is brought into view (not the
//     footer), unless the reader has scrolled away — then a "latest" pill;
//   • auto-follow while pinned to the bottom, hands-off the moment you
//     scroll up.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, AlertTriangle } from "lucide-react";
import { StreamingAnswer } from "@/components/knowledge/answer/AnswerExperience";
import type { ChatMessage, ChatScope } from "@/lib/chatClient";
import { EXAMPLES, SCOPE_META } from "./shared";
import LoadingBlock from "@/components/ui/LoadingBlock";

export interface StreamingState {
  status: string;
  draft: string;
  /** The question being answered — rendered as a pending user bubble. */
  question: string;
  attachmentsCount: number;
}

export default function MessageStream({
  messages, streaming, scope, renderUser, renderAssistant, onExample, emptyNote, loading = false,
}: {
  messages: ChatMessage[];
  streaming: StreamingState | null;
  scope: ChatScope;
  renderUser: (m: ChatMessage) => React.ReactNode;
  renderAssistant: (m: ChatMessage, isLast: boolean) => React.ReactNode;
  onExample: (q: string) => void;
  emptyNote?: string | null;
  /** A conversation is being opened: show that, not the empty state. */
  loading?: boolean;
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
          {empty && loading ? (
            <div className="pt-6 max-w-3xl mx-auto"><LoadingBlock what="the conversation" rows={5} /></div>
          ) : empty ? (
            <div className="pt-[8vh] sm:pt-[10vh] max-w-2xl mx-auto animate-rise">
              <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text-muted)]">
                <Icon className="w-3.5 h-3.5" aria-hidden /> {meta.label}
              </div>
              {/* The one big line on an empty chat: what you can do here. */}
              <h2 className="mt-3 text-[34px] sm:text-[44px] leading-[1.03] font-black tracking-[-0.03em] text-[var(--color-text)]">
                {scope === "library" ? "Ask the library." : scope === "tools" ? "Ask the system." : "Ask the internet."}
              </h2>
              <p className="mt-3 text-[14px] sm:text-[15px] text-[var(--color-text-muted)]">{meta.hint}</p>
              {emptyNote && (
                <p className="mt-3 flex items-start gap-2 text-[13.5px] font-semibold text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" /> {emptyNote}
                </p>
              )}
              <div className="mt-6 text-[13px] font-semibold text-[var(--color-text-muted)]">Try</div>
              <div className="mt-2 flex flex-col divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {EXAMPLES[scope].map((e) => (
                  <button key={e} onClick={() => onExample(e)}
                    className="group flex items-center gap-3 py-3 text-left text-[14.5px] font-semibold text-[var(--color-text)] transition-colors">
                    <span className="flex-1 group-hover:underline decoration-[var(--color-border-strong)] underline-offset-4">{e}</span>
                    <ArrowDown className="w-4 h-4 -rotate-90 text-[var(--color-text-faint)] group-hover:text-[var(--color-text)] group-hover:translate-x-0.5 transition-transform" />
                  </button>
                ))}
              </div>
              {scope !== "internet" && (
                <p className="mt-4 text-[12px] text-[var(--color-text-muted)]">
                  It reads only documents cleared for AI.
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
                <div className="pb-6 animate-rise">
                  {/* No raw text typing out: the answer card's own shape,
                      filled in stage by stage as complete lines arrive. */}
                  <StreamingAnswer status={streaming.status} draft={streaming.draft} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {!atBottom && !empty && (
        <button onClick={jump}
          className="absolute left-1/2 -translate-x-1/2 bottom-3 inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full bg-[var(--color-ink)] text-[12.5px] font-bold text-[var(--color-ink-fg)] shadow-lg hover:opacity-90 transition-opacity animate-pop">
          <ArrowDown className="w-3.5 h-3.5" /> Latest
        </button>
      )}
    </div>
  );
}
