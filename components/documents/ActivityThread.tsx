"use client";
import { useToast } from "@/components/providers/ToastProvider";

// ActivityThread — the unified per-document collaboration feed.
//
// Shows chat, system events, hand-off notes, proposals, "is this the
// latest?" questions with replies, and markup-request pointers all in
// one chronological list. Composer at the bottom lets the user pick
// what kind of message to send.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Send, Zap, HelpCircle, FileSignature, CheckCircle2, Loader2, Pencil } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useDraft } from "@/hooks/useDraft";
import {
  type ActivityMessage,
  type ActivityKind,
  listActivity,
  postChat,
  postProposal,
  askIsLatest,
  answerQuestion,
  resolveMessage,
} from "@/lib/activityThread";

interface ActivityThreadProps {
  orgId: string;
  documentId: string;
  /** Active lock id, when there is one. Used for new messages so they
   *  attach to the current checkout. */
  currentLockId?: string | null;
  /**
   * Episode scoping — the thread belongs to the checkout, not the document:
   *   string    → show + post into THAT live episode only
   *   null      → no active checkout: thread is empty and composing is
   *               disabled (a new checkout opens a fresh thread; old ones
   *               live in the checkout history)
   *   undefined → legacy document-scoped feed (pre-migration environments)
   */
  episodeId?: string | null;
  /** Display number of the live episode ("Checkout #3"). */
  episodeSeq?: number | null;
  currentUserId: string;
  currentUserName: string;
  /** Open the existing markup-request modal. The parent controls it
   *  so the modal stays where it lives today. */
  onRequestMarkup?: () => void;
}

const KIND_LABEL: Record<ActivityKind, string> = {
  chat: "Chat",
  system: "System",
  handoff: "Handoff",
  proposal: "Proposal",
  question: "Question",
  answer: "Reply",
  markup_ref: "Markup",
};

export default function ActivityThread({
  orgId, documentId, currentLockId, episodeId, episodeSeq, currentUserId, currentUserName, onRequestMarkup,
}: ActivityThreadProps) {
  const { showToast } = useToast();
  const [messages, setMessages] = useState<ActivityMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [composerKind, setComposerKind] = useState<"chat" | "proposal">("chat");
  const [composer, setComposer] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // A half-written message survives a reload (one draft per checkout thread).
  useDraft<string>(typeof episodeId === "string" ? `thread:${documentId}:${episodeId}` : null, composer, setComposer, (v) => !v.trim());
  const [proposalTitle, setProposalTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // No live episode → composing is off; the next checkout opens a new thread.
  const composingDisabled = episodeId === null;

  // Fetch + realtime subscribe, scoped to the live episode when one exists.
  useEffect(() => {
    if (!orgId || !documentId) return;
    let alive = true;

    const fetchAll = async () => {
      if (episodeId === null) {
        // Idle document: the live thread is empty by definition. Past
        // threads are sealed in the checkout history.
        if (alive) { setMessages([]); setLoading(false); }
        return;
      }
      try {
        const list = await listActivity(
          orgId,
          documentId,
          episodeId === undefined ? undefined : { episodeId },
        );
        if (!alive) return;
        setMessages(list);
        setLoadErr(null);
        setLoading(false);
        // Defer scroll to next frame so the DOM has updated.
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
        });
      } catch (e) {
        console.error("[ActivityThread] fetch failed", e);
        if (alive) { setLoadErr((e as Error)?.message || "try again"); setLoading(false); }
      }
    };

    fetchAll();
    const channel = supabase
      .channel(`activity-${documentId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "checkout_messages", filter: `document_id=eq.${documentId}` },
        () => { if (alive) fetchAll(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [orgId, documentId, episodeId]);

  const repliesByParent = useMemo(() => {
    const map = new Map<string, ActivityMessage[]>();
    for (const m of messages) {
      if (m.kind === "answer" && m.parentMessageId) {
        const list = map.get(m.parentMessageId) || [];
        list.push(m);
        map.set(m.parentMessageId, list);
      }
    }
    return map;
  }, [messages]);

  // Skip answers in the top-level pass — they render under their parent.
  const topLevel = useMemo(
    () => messages.filter((m) => m.kind !== "answer"),
    [messages],
  );

  // Optimistically show a just-posted message immediately. The realtime
  // fetchAll replaces the whole list with the canonical rows when it fires, so
  // this also makes posting feel instant even if realtime is delayed/disabled.
  const appendLocal = (msg: ActivityMessage | null) => {
    if (!msg) return;
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  // New messages always carry the live episode when we know it; undefined
  // lets the lib auto-resolve (legacy mode).
  const episodeForPost = typeof episodeId === "string" ? episodeId : undefined;

  const send = async () => {
    if (busy || composingDisabled) return;
    const text = composer.trim();
    if (!text) return;
    setBusy(true);
    try {
      let msg: ActivityMessage | null;
      if (composerKind === "proposal") {
        msg = await postProposal({
          orgId, documentId, lockId: currentLockId ?? null, episodeId: episodeForPost,
          userId: currentUserId, userName: currentUserName,
          text, title: proposalTitle.trim() || undefined,
        });
        setProposalTitle("");
      } else {
        msg = await postChat({
          orgId, documentId, lockId: currentLockId ?? null, episodeId: episodeForPost,
          userId: currentUserId, userName: currentUserName,
          text,
        });
      }
      setComposer("");
      appendLocal(msg);
    } catch (e) {
      console.error(e);
      showToast({ type: "error", title: "It didn't send", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const askLatest = async () => {
    if (composingDisabled) return;
    setBusy(true);
    try {
      appendLocal(await askIsLatest({
        orgId, documentId, lockId: currentLockId ?? null, episodeId: episodeForPost,
        userId: currentUserId, userName: currentUserName,
      }));
    } catch (e) {
      console.error(e);
      showToast({ type: "error", title: "The question didn't send", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async (parentId: string) => {
    const text = replyText.trim();
    if (!text || busy || composingDisabled) return;
    setBusy(true);
    try {
      const msg = await answerQuestion({
        orgId, documentId, lockId: currentLockId ?? null, episodeId: episodeForPost,
        userId: currentUserId, userName: currentUserName,
        parentMessageId: parentId, text,
      });
      setReplyText("");
      setReplyingTo(null);
      appendLocal(msg);
    } catch (e) {
      console.error(e);
      showToast({ type: "error", title: "Couldn't post reply", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const markResolved = async (id: string) => {
    try {
      await resolveMessage(id, currentUserId);
    } catch (e) {
      console.error(e);
      showToast({ type: "error", title: "Couldn't mark it resolved", message: (e as Error).message });
    }
  };

  return (
    <div className="w-full md:w-96 bg-[var(--color-surface)] flex flex-col h-[400px] md:h-auto">
      <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] sticky top-0 z-10">
        <h3 className="text-sm font-bold text-[var(--color-text)] flex items-center">
          <MessageSquare className="w-4 h-4 mr-2 text-[var(--color-text-muted)]" />
          {typeof episodeId === "string" && episodeSeq ? `Checkout #${episodeSeq} - Activity` : "Activity"}
          {messages.length > 0 && (
            <span className="ml-2 text-[13px] font-bold text-[var(--color-text-faint)]">{messages.length}</span>
          )}
        </h3>
      </div>

      {/* Action shortcuts */}
      {!composingDisabled && (
        <div className="px-3 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-1.5 bg-[var(--color-surface-2)]">
          <button
            onClick={askLatest}
            disabled={busy}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-bold bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            title="Post a quick &ldquo;is this the latest?&rdquo; question"
          >
            <HelpCircle className="w-3 h-3" /> Is this latest?
          </button>
          {onRequestMarkup && (
            <button
              onClick={onRequestMarkup}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-bold bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              title="Open the markup request form"
            >
              <FileSignature className="w-3 h-3" /> Request markup
            </button>
          )}
          <button
            onClick={() => setComposerKind((k) => k === "proposal" ? "chat" : "proposal")}
            aria-pressed={composerKind === "proposal"}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-bold border ${
              composerKind === "proposal"
                ? "bg-[var(--color-text)] border-[var(--color-text)] text-[var(--color-surface)]"
                : "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            }`}
            title="Post a proactive proposal/draft for the team"
          >
            <Zap className="w-3 h-3" /> {composerKind === "proposal" ? "Cancel proposal" : "Post proposal"}
          </button>
        </div>
      )}

      {/* Feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 bg-[var(--color-surface-2)]/30">
        {loading ? (
          <div className="text-center text-[var(--color-text-faint)] text-[13px] mt-10">
            <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading the thread…
          </div>
        ) : loadErr ? (
          <div role="alert" className="text-center text-[var(--state-overdue)] text-[13px] mt-10 px-4">
            Couldn&apos;t load the thread: {loadErr}
          </div>
        ) : composingDisabled ? (
          <div className="text-center text-[var(--color-text-faint)] text-[13px] mt-10 px-4">
            No checkout open. The next checkout starts a new thread. Past ones are in the checkout history.
          </div>
        ) : topLevel.length === 0 ? (
          <div className="text-center text-[var(--color-text-faint)] text-[13px] mt-10">
            No activity yet. Start by leaving a note for the team.
          </div>
        ) : (
          topLevel.map((m) => (
            <MessageRow
              key={m.id}
              msg={m}
              meIsAuthor={m.userId === currentUserId}
              replies={repliesByParent.get(m.id) || []}
              onReply={() => { setReplyingTo(m.id); setReplyText(""); }}
              onMarkResolved={() => markResolved(m.id)}
              isReplying={replyingTo === m.id}
              replyText={replyText}
              onReplyText={setReplyText}
              onSendReply={() => sendReply(m.id)}
              busy={busy}
            />
          ))
        )}
      </div>

      {/* Composer */}
      <div className="p-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] space-y-2">
        {composingDisabled && (
          <div className="text-[13px] text-[var(--color-text-faint)] text-center">
            Check the document out to start a new thread.
          </div>
        )}
        {!composingDisabled && composerKind === "proposal" && (
          <input
            value={proposalTitle}
            onChange={(e) => setProposalTitle(e.target.value)}
            placeholder="Proposal title (optional)"
            className="w-full px-3 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px] focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
          />
        )}
        <div className="relative">
          <textarea
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={composerKind === "proposal" ? 3 : 1}
            disabled={composingDisabled}
            placeholder={
              composingDisabled
                ? "No active checkout"
                : composerKind === "proposal"
                ? "Sketch your proposal here. Team can react in the thread."
                : "Message the team…"
            }
            className={`w-full pl-3 pr-10 py-2 rounded-2xl border text-[13px] outline-none focus:ring-2 resize-none disabled:bg-[var(--color-surface-2)] disabled:cursor-not-allowed ${
              composerKind === "proposal"
                ? "border-[var(--color-border-strong)] bg-[var(--color-surface)] focus:ring-[var(--color-accent-ring)]"
                : "border-[var(--color-border)] bg-[var(--color-surface-2)] focus:ring-[var(--color-accent-ring)]"
            }`}
          />
          <button
            onClick={send}
            disabled={!composer.trim() || busy || composingDisabled}
            aria-label={composerKind === "proposal" ? "Post proposal" : "Send message"}
            className={`absolute right-1.5 ${composerKind === "proposal" ? "bottom-1.5" : "top-1/2 -translate-y-1/2"} p-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50`}
            title={composerKind === "proposal" ? "Post proposal" : "Send message"}
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          </button>
        </div>
      </div>
    </div>
  );
}

interface MessageRowProps {
  msg: ActivityMessage;
  meIsAuthor: boolean;
  replies: ActivityMessage[];
  onReply: () => void;
  onMarkResolved: () => void;
  isReplying: boolean;
  replyText: string;
  onReplyText: (v: string) => void;
  onSendReply: () => void;
  busy: boolean;
}

function MessageRow({ msg, meIsAuthor, replies, onReply, onMarkResolved, isReplying, replyText, onReplyText, onSendReply, busy }: MessageRowProps) {
  if (msg.kind === "system") {
    return (
      <div className="text-center">
        <span className="inline-block px-3 py-1 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-muted)] text-[13px] italic border border-[var(--color-border)]">
          {msg.text}
        </span>
      </div>
    );
  }

  if (msg.kind === "handoff") {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
        <div className="text-[13px] font-semibold text-[var(--color-text)] flex items-center gap-1 mb-1">
          <Pencil className="w-3 h-3" /> Handoff · {msg.userName}
        </div>
        <div className="text-[13px] text-[var(--color-text)] whitespace-pre-wrap">{msg.text}</div>
        <div className="text-[13px] text-[var(--color-text-muted)] mt-1.5">{formatTime(msg.createdAt)}</div>
      </div>
    );
  }

  if (msg.kind === "proposal") {
    const title = (msg.metadata?.title as string | undefined) || "Proposal";
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="text-[13px] font-semibold text-[var(--color-text-muted)] flex items-center gap-1 mb-1">
          <Zap className="w-3 h-3" /> Proposal · {msg.userName}
        </div>
        <div className="text-[13px] font-bold text-[var(--color-text)] mb-1">{title}</div>
        <div className="text-[13px] text-[var(--color-text)] whitespace-pre-wrap">{msg.text}</div>
        <div className="text-[13px] text-[var(--color-text-muted)] mt-1.5">{formatTime(msg.createdAt)}</div>
      </div>
    );
  }

  if (msg.kind === "question") {
    return (
      <div className="rounded-lg border border-[var(--color-border)] border-l-2 border-l-[var(--state-held)] bg-[var(--color-surface)] p-3">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[13px] font-semibold text-[var(--state-held)] flex items-center gap-1">
            <HelpCircle className="w-3 h-3" /> Question · {msg.userName}
          </div>
          {msg.resolvedAt ? (
            <span className="inline-flex items-center gap-1 text-[13px] font-bold text-[var(--state-released)]">
              <CheckCircle2 className="w-3 h-3" /> Resolved
            </span>
          ) : (
            <button onClick={onMarkResolved} className="text-[13px] font-bold text-[var(--color-text)] hover:underline">
              Mark resolved
            </button>
          )}
        </div>
        <div className="text-[13px] text-[var(--color-text)]">{msg.text}</div>
        {replies.length > 0 && (
          <div className="mt-2 space-y-1.5 border-l-2 border-[var(--color-border)] pl-3">
            {replies.map((r) => (
              <div key={r.id} className="text-[13px]">
                <span className="font-bold text-[var(--color-text)]">{r.userName}: </span>
                <span className="text-[var(--color-text)]">{r.text}</span>
              </div>
            ))}
          </div>
        )}
        {!msg.resolvedAt && (
          isReplying ? (
            <div className="mt-2 flex gap-1.5">
              <input
                value={replyText}
                onChange={(e) => onReplyText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onSendReply(); }}
                autoFocus
                placeholder="Reply…"
                className="flex-1 px-2 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px]"
              />
              <button
                onClick={onSendReply}
                disabled={!replyText.trim() || busy}
                className="px-2 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] text-[13px] font-bold disabled:opacity-50"
              >Send</button>
            </div>
          ) : (
            <button onClick={onReply} className="mt-2 text-[13px] font-bold text-[var(--color-text)] hover:underline">
              Reply
            </button>
          )
        )}
        <div className="text-[13px] text-[var(--color-text-muted)] mt-1.5">{formatTime(msg.createdAt)}</div>
      </div>
    );
  }

  if (msg.kind === "markup_ref") {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
        <div className="text-[13px] font-semibold text-[var(--color-text)] flex items-center gap-1 mb-1">
          <FileSignature className="w-3 h-3" /> Markup request · {msg.userName}
        </div>
        <div className="text-[13px] text-[var(--color-text)]">{msg.text}</div>
        <div className="text-[13px] text-[var(--color-text-muted)] mt-1.5">{formatTime(msg.createdAt)}</div>
      </div>
    );
  }

  // chat (default)
  return (
    <div className={`flex flex-col ${meIsAuthor ? "items-end" : "items-start"}`}>
      <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-[13px] ${
        meIsAuthor ? "bg-[var(--color-surface-2)] text-[var(--color-text)] rounded-br-sm" : "bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] rounded-bl-sm shadow-sm"
      }`}>
        {!meIsAuthor && <div className="font-bold text-[13px] mb-0.5 opacity-70">{msg.userName}</div>}
        <div className="whitespace-pre-wrap">{msg.text}</div>
      </div>
      <div className="text-[13px] text-[var(--color-text-faint)] mt-0.5">{formatTime(msg.createdAt)}</div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

// Reference the enum so unused-imports lint stays quiet without dropping
// the type-only KIND_LABEL map (kept as documentation of valid kinds).
void KIND_LABEL;
