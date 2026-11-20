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
            <div className="pt-[6vh] sm:pt-[8vh] max-w-2xl mx-auto animate-rise">
              {/* The one big line on an empty chat: what you can do here. */}
              <h2 className="flex items-center gap-3 font-display text-[30px] sm:text-[38px] leading-[1.05] font-semibold tracking-[-0.01em] text-[var(--color-text)]">
                <span aria-hidden className="ui-icon-tile is-solid !w-12 !h-12 !rounded-lg"><Icon className="w-6 h-6" /></span>
                {scope === "library" ? "Ask the library" : scope === "tools" ? "Ask the system" : "Ask the internet"}
              </h2>
              <p className="mt-2 text-[15px] text-[var(--color-text-muted)]">
                {meta.hint}{scope !== "internet" ? " It reads only documents cleared for AI." : ""}
              </p>
              {emptyNote && (
                // A warning is a row with its status on the edge.
                <p className="relative mt-4 pl-4 py-1 flex items-start gap-2 text-[14px] font-semibold text-[var(--color-text)]">
                  <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-held)]" />
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-held)]" /> {emptyNote}
                </p>
              )}
              <h3 className="mt-7 mb-2 font-display text-[17px] font-semibold text-[var(--color-heading)]">Try one of these</h3>
              <div className="flex flex-col divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {EXAMPLES[scope].map((e) => (
                  <button key={e} onClick={() => onExample(e)}
                    className="group -mx-2 px-2 flex items-center gap-3 py-3 text-left text-[15px] text-[var(--color-text)] rounded-md hover:bg-[var(--color-accent-soft)] transition-colors">
                    <span aria-hidden className="ui-icon-tile is-sm"><Icon className="w-4 h-4" /></span>
                    <span className="flex-1">{e}</span>
                    <ArrowDown className="w-4 h-4 -rotate-90 shrink-0 text-[var(--color-text-faint)] group-hover:text-[var(--color-accent-text)] group-hover:translate-x-0.5 transition-transform" />
                  </button>
                ))}
              </div>
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
          className="absolute left-1/2 -translate-x-1/2 bottom-3 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] shadow-lg hover:bg-[var(--color-surface-2)] transition-colors animate-pop">
          <ArrowDown className="w-3.5 h-3.5" /> Latest
        </button>
      )}
    </div>
  );
}
