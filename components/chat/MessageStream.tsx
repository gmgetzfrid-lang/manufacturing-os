"use client";

// MessageStream — the conversation, scrolled the way people read answers:
//   • while a question runs, the thread stays put and a ghost turn shows the
//     live status line and the answer as it streams;
//   • when the answer lands, the START of it is brought into view (not the
//     footer), unless the reader has scrolled away — then a "latest" pill;
//   • auto-follow while pinned to the bottom, hands-off the moment you
//     scroll up.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { StreamingAnswer } from "@/components/knowledge/answer/AnswerExperience";
import type { ChatMessage, ChatScope } from "@/lib/chatClient";
import { EXAMPLES } from "./shared";
import { SkeletonText } from "@/components/ui/Skeleton";

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

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scrollerRef} onScroll={onScroll} data-chat-scroller className="h-full overflow-y-auto px-4 sm:px-6">
        {/* Wide enough for the answer + proof columns side by side; the
            question bubble and prose still cap themselves narrower. */}
        <div className="mx-auto max-w-5xl pt-4 pb-6">
          {empty && loading ? (
            <div className="pt-6 max-w-3xl mx-auto"><SkeletonText lines={5} /></div>
          ) : empty ? (
            <div className="pt-[6vh] sm:pt-[8vh] max-w-2xl mx-auto animate-rise">
              {/* The one line on an empty chat: what you can do here. (How
                  answers are sourced is said once, under the box.) */}
              <h2 className="font-display text-title leading-tight font-semibold text-[var(--color-text)]">
                {scope === "library" ? "Ask the library." : scope === "tools" ? "Ask the system." : "Ask the internet."}
              </h2>
              {scope !== "internet" && (
                <p className="mt-1.5 text-reading text-[var(--color-text-muted)]">It reads only documents cleared for AI.</p>
              )}
              {emptyNote && (
                <p className="mt-4 text-body text-[var(--color-text)]">
                  <span className="ui-pill is-warn mr-2">Can&apos;t ask yet</span>{emptyNote}
                </p>
              )}
              <h3 className="mt-8 mb-2 text-body font-medium text-[var(--color-text-muted)]">Try one of these</h3>
              {/* Three suggestions: space between them, no ruled lines. */}
              <div className="flex flex-col gap-1">
                {EXAMPLES[scope].map((e) => (
                  <button key={e} type="button" onClick={() => onExample(e)} disabled={!!emptyNote}
                    className="group -mx-2 px-2 flex items-center gap-3 py-2.5 pointer-coarse:min-h-11 text-left text-reading text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-2)] disabled:opacity-60 disabled:hover:bg-transparent transition-colors">
                    <span className="flex-1">{e}</span>
                    <ArrowRight aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)] group-hover:text-[var(--color-accent-text)] transition-colors" />
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
          className="absolute left-1/2 -translate-x-1/2 bottom-3 inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] ui-float hover:bg-[var(--color-surface-2)] transition-colors animate-pop">
          <ArrowDown className="w-3.5 h-3.5" /> Latest
        </button>
      )}
    </div>
  );
}
