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
        setLoading(false);
        // Defer scroll to next frame so the DOM has updated.
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
        });
      } catch (e) {
        console.error("[ActivityThread] fetch failed", e);
        if (alive) setLoading(false);
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
      showToast({ type: "error", title: "Failed to post", message: (e as Error).message });
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
      showToast({ type: "error", title: "Action failed", message: (e as Error).message });
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
    }
  };

  return (
    <div className="w-full md:w-96 bg-white flex flex-col h-[400px] md:h-auto">
      <div className="px-4 py-3 border-b border-slate-200 bg-white sticky top-0 z-10">
        <h3 className="text-sm font-bold text-slate-900 flex items-center">
          <MessageSquare className="w-4 h-4 mr-2 text-slate-500" />
          {typeof episodeId === "string" && episodeSeq ? `Checkout #${episodeSeq} — Activity` : "Activity"}
          {messages.length > 0 && (
            <span className="ml-2 text-[10px] font-bold text-slate-400">{messages.length}</span>
          )}
        </h3>
        <div className="text-[10px] text-slate-500 mt-0.5">
          {composingDisabled
            ? "Each checkout gets its own thread. Past threads live in the checkout history."
            : "Chat, hand-offs, proposals, and version questions for this checkout."}
        </div>
      </div>

      {/* Action shortcuts */}
      {!composingDisabled && (
        <div className="px-3 py-2 border-b border-slate-100 flex flex-wrap items-center gap-1.5 bg-slate-50">
          <button
            onClick={askLatest}
            disabled={busy}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold bg-white border border-amber-300 text-amber-800 hover:bg-amber-50 disabled:opacity-50"
            title="Post a quick &ldquo;is this the latest?&rdquo; question"
          >
            <HelpCircle className="w-3 h-3" /> Is this latest?
          </button>
          {onRequestMarkup && (
            <button
              onClick={onRequestMarkup}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold bg-white border border-violet-300 text-violet-800 hover:bg-violet-50"
              title="Open the markup request form"
            >
              <FileSignature className="w-3 h-3" /> Request markup
            </button>
          )}
          <button
            onClick={() => setComposerKind((k) => k === "proposal" ? "chat" : "proposal")}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold border ${
              composerKind === "proposal"
                ? "bg-emerald-100 border-emerald-400 text-emerald-900"
                : "bg-white border-emerald-300 text-emerald-800 hover:bg-emerald-50"
            }`}
            title="Post a proactive proposal/draft for the team"
          >
            <Zap className="w-3 h-3" /> {composerKind === "proposal" ? "Cancel proposal" : "Post proposal"}
          </button>
        </div>
      )}

      {/* Feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 bg-slate-50/30">
        {loading ? (
          <div className="text-center text-slate-400 text-xs mt-10">
            <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
          </div>
        ) : composingDisabled ? (
          <div className="text-center text-slate-400 text-xs mt-10 px-4">
            No active checkout. Checking the document out opens a fresh thread —
            previous checkout conversations are in the history panel.
          </div>
        ) : topLevel.length === 0 ? (
          <div className="text-center text-slate-400 text-xs mt-10">
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
      <div className="p-3 border-t border-slate-200 bg-white space-y-2">
        {composingDisabled && (
          <div className="text-[10px] text-slate-400 text-center">
            Check the document out to start a new thread.
          </div>
        )}
        {!composingDisabled && composerKind === "proposal" && (
          <input
            value={proposalTitle}
            onChange={(e) => setProposalTitle(e.target.value)}
            placeholder="Proposal title (optional)"
            className="w-full px-3 py-1.5 rounded-md border border-emerald-200 bg-emerald-50/40 text-xs focus:ring-2 focus:ring-emerald-500 outline-none"
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
            className={`w-full pl-3 pr-10 py-2 rounded-2xl border text-xs outline-none focus:ring-2 resize-none disabled:bg-slate-100 disabled:cursor-not-allowed ${
              composerKind === "proposal"
                ? "border-emerald-300 bg-emerald-50/40 focus:ring-emerald-500"
                : "border-slate-200 bg-slate-50 focus:ring-blue-500"
            }`}
          />
          <button
            onClick={send}
            disabled={!composer.trim() || busy || composingDisabled}
            className={`absolute right-1.5 ${composerKind === "proposal" ? "bottom-1.5" : "top-1/2 -translate-y-1/2"} p-1.5 rounded-full text-white disabled:opacity-50 ${
              composerKind === "proposal" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-blue-600 hover:bg-blue-500"
            }`}
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
        <span className="inline-block px-3 py-1 rounded-full bg-slate-100 text-slate-500 text-[11px] italic border border-slate-200">
          {msg.text}
        </span>
      </div>
    );
  }

  if (msg.kind === "handoff") {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
        <div className="text-[10px] font-black text-blue-700 uppercase tracking-widest flex items-center gap-1 mb-1">
          <Pencil className="w-3 h-3" /> Handoff · {msg.userName}
        </div>
        <div className="text-xs text-slate-800 whitespace-pre-wrap">{msg.text}</div>
        <div className="text-[10px] text-slate-500 mt-1.5">{formatTime(msg.createdAt)}</div>
      </div>
    );
  }

  if (msg.kind === "proposal") {
    const title = (msg.metadata?.title as string | undefined) || "Proposal";
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
        <div className="text-[10px] font-black text-emerald-700 uppercase tracking-widest flex items-center gap-1 mb-1">
          <Zap className="w-3 h-3" /> Proposal · {msg.userName}
        </div>
        <div className="text-xs font-bold text-slate-900 mb-1">{title}</div>
        <div className="text-xs text-slate-800 whitespace-pre-wrap">{msg.text}</div>
        <div className="text-[10px] text-slate-500 mt-1.5">{formatTime(msg.createdAt)}</div>
      </div>
    );
  }

  if (msg.kind === "question") {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] font-black text-amber-800 uppercase tracking-widest flex items-center gap-1">
            <HelpCircle className="w-3 h-3" /> Question · {msg.userName}
          </div>
          {msg.resolvedAt ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700">
              <CheckCircle2 className="w-3 h-3" /> Resolved
            </span>
          ) : (
            <button onClick={onMarkResolved} className="text-[10px] font-bold text-amber-700 hover:underline">
              Mark resolved
            </button>
          )}
        </div>
        <div className="text-xs text-slate-800">{msg.text}</div>
        {replies.length > 0 && (
          <div className="mt-2 space-y-1.5 border-l-2 border-amber-200 pl-3">
            {replies.map((r) => (
              <div key={r.id} className="text-xs">
                <span className="font-bold text-slate-700">{r.userName}: </span>
                <span className="text-slate-800">{r.text}</span>
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
                className="flex-1 px-2 py-1 rounded-md border border-amber-300 bg-white text-xs"
              />
              <button
                onClick={onSendReply}
                disabled={!replyText.trim() || busy}
                className="px-2 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-bold disabled:opacity-50"
              >Send</button>
            </div>
          ) : (
            <button onClick={onReply} className="mt-2 text-[10px] font-bold text-amber-700 hover:underline">
              Reply
            </button>
          )
        )}
        <div className="text-[10px] text-slate-500 mt-1.5">{formatTime(msg.createdAt)}</div>
      </div>
    );
  }

  if (msg.kind === "markup_ref") {
    return (
      <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
        <div className="text-[10px] font-black text-violet-700 uppercase tracking-widest flex items-center gap-1 mb-1">
          <FileSignature className="w-3 h-3" /> Markup request · {msg.userName}
        </div>
        <div className="text-xs text-slate-800">{msg.text}</div>
        <div className="text-[10px] text-slate-500 mt-1.5">{formatTime(msg.createdAt)}</div>
      </div>
    );
  }

  // chat (default)
  return (
    <div className={`flex flex-col ${meIsAuthor ? "items-end" : "items-start"}`}>
      <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs ${
        meIsAuthor ? "bg-blue-600 text-white rounded-br-sm" : "bg-white border border-slate-200 text-slate-700 rounded-bl-sm shadow-sm"
      }`}>
        {!meIsAuthor && <div className="font-bold text-[10px] mb-0.5 opacity-70">{msg.userName}</div>}
        <div className="whitespace-pre-wrap">{msg.text}</div>
      </div>
      <div className="text-[9px] text-slate-400 mt-0.5">{formatTime(msg.createdAt)}</div>
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
