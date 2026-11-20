"use client";

// Turns — one question, one answer, rendered the way a chat reads:
//   • the question as a soft bubble, with its attachments; once it scrolls
//     out of view a ONE-LINE pill of it stays pinned at the top while the
//     answer scrolls (a full multi-line bubble pinned there ate the page);
//   • the answer flat, no bubble, read like a document — the library's
//     answer with its sources, or the controller's answer with its
//     proposals and the steps it took drawn as one connected path.
// Everything the two old surfaces showed is here, assigned a layer: inline
// for what needs a decision, collapsed for what's about one answer.

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown, ShieldAlert, ArrowUpRight, AlertTriangle, Check, Loader2,
  Globe, History, Image as ImageIcon, FileText, RotateCcw,
} from "lucide-react";
import type { ChatMessage, ChatAttachment, AssistantPayload } from "@/lib/chatClient";
import { attachmentUrl } from "@/lib/chatClient";
import { parseNeedPrompt, type KnowledgeAnswer, type KnowledgeCitation } from "@/lib/knowledge";
import { describeTool, type PendingAction, type RunStep } from "@/lib/orchestratorClient";
import AssistantAnswer from "@/components/assistant/AssistantAnswer";
import {
  AnswerExperience, AnswerFeedback, ClarifyCard, NeedCard, CitationChips, AnswerView, type DocLink,
} from "@/components/knowledge/answer/AnswerExperience";
import { relativeTime, fmtBytes } from "./shared";

// ── User turn ─────────────────────────────────────────────────────────────

export function UserTurn({ m, mine, onOpenAttachment }: {
  m: ChatMessage; mine: boolean; onOpenAttachment: (a: ChatAttachment) => void;
}) {
  const focus = (m.payload as { focus?: string[] } | null)?.focus;
  const inputs = (m.payload as { inputs?: string } | null)?.inputs;
  const bubbleRef = useRef<HTMLDivElement>(null);
  // "Stuck" = the full bubble has scrolled out ABOVE the stream. Observed
  // against the stream's own scroller so the app header doesn't count.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = bubbleRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const root = el.closest("[data-chat-scroller]");
    const io = new IntersectionObserver(([e]) => {
      const rootTop = e.rootBounds?.top ?? 0;
      setStuck(!e.isIntersecting && e.boundingClientRect.bottom <= rootTop + 4);
    }, { root, threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const who = mine ? "You" : (m.userName ?? "Someone").split("@")[0];
  return (
    <>
    <div ref={bubbleRef} className="py-2">
      <div className="flex justify-end">
        {/* Your own question is charcoal; a teammate's sits on the warm
            fill, so a shared conversation shows who asked what. */}
        <div className={`max-w-[85%] rounded-2xl rounded-tr-md px-4 py-2.5 ${mine
          ? "bg-[var(--color-ink)] shadow-[var(--shadow-card)]"
          : "bg-[var(--color-surface-2)]"}`}>
          <div className={`text-[14.5px] font-medium whitespace-pre-wrap leading-relaxed ${mine ? "text-[var(--color-ink-fg)]" : "text-[var(--color-text)]"}`}>{m.content}</div>
          {(focus?.length || inputs) ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {[...(focus ?? []), ...(inputs ? [inputs] : [])].map((f) => (
                <span key={f} className={`text-[11.5px] font-bold px-1.5 py-0.5 rounded-md border ${mine
                  ? "border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-[var(--color-ink-fg)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)]"}`}>{f}</span>
              ))}
            </div>
          ) : null}
          {m.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {m.attachments.map((a) => <AttachmentCard key={a.id || a.path} a={a} onOpen={() => onOpenAttachment(a)} />)}
            </div>
          )}
          <div className={`mt-1 text-[11px] text-right ${mine ? "text-[color-mix(in_srgb,var(--color-ink-fg)_62%,transparent)]" : "text-[var(--color-text-muted)]"}`}>
            {who} · {relativeTime(m.createdAt)}
          </div>
        </div>
      </div>
    </div>
    {/* Zero-height sticky anchor: when the bubble is gone, a one-line pill
        of the question floats at the top of the stream over the answer.
        Tap it to jump back to the full question. */}
    <div className="sticky top-0 z-10 h-0 overflow-visible">
      {stuck && (
        <div className="flex justify-end pt-1.5 pr-1">
          <button
            onClick={() => bubbleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            title="Back to the question"
            className="max-w-[70%] inline-flex items-center gap-2 h-8 px-3 rounded-full bg-[var(--color-surface)] shadow-[var(--shadow-card)] ring-1 ring-[var(--color-border)] text-[12.5px] text-[var(--color-text)] animate-pop">
            <span className="shrink-0 text-[11px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">{who}</span>
            <span className="truncate">{m.content}</span>
          </button>
        </div>
      )}
    </div>
    </>
  );
}

export function AttachmentCard({ a, onOpen, large }: { a: ChatAttachment; onOpen: () => void; large?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (a.kind !== "image") return;
    let cancelled = false;
    void attachmentUrl(a.path).then((u) => { if (!cancelled) setUrl(u); }, () => undefined);
    return () => { cancelled = true; };
  }, [a.kind, a.path]);
  return (
    <button onClick={onOpen} title={`${a.name} · ${fmtBytes(a.size)}, for this question only`}
      className={`group relative overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)] transition-colors ${large ? "w-full" : ""}`}>
      {a.kind === "image" && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={a.name} className={large ? "w-full h-auto" : "h-20 w-28 object-cover"} />
      ) : (
        <div className={`flex items-center gap-2 px-2.5 py-2 ${large ? "" : "max-w-[200px]"}`}>
          {a.kind === "image" ? <ImageIcon className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" /> : <FileText className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />}
          <span className="text-[12px] font-bold text-[var(--color-text)] truncate">{a.name}</span>
        </div>
      )}
    </button>
  );
}

// ── Assistant turn ────────────────────────────────────────────────────────

export interface ActionState {
  approved: string[];
  outcomes: Record<string, { ok: boolean; note: string }>;
  executing?: string | null;
}

export function AssistantTurn({
  m, isLast, onCite, onOpenDoc, onOpenTag, onClarify, onNeed, onConfirm, actions, onRetry, onRated, onRethink, onAttach,
}: {
  m: ChatMessage;
  isLast: boolean;
  onCite: (c: KnowledgeCitation) => void;
  onOpenDoc: (d: DocLink) => void;
  onOpenTag: (documentId: string, page: number, tag: string, documentName: string) => void;
  onClarify: (question: string, focus: string[]) => void;
  onNeed: (question: string, values: string, focus?: string[], priorInputs?: string) => void;
  /** Re-ask the same question, optionally reshaped as another answer mode. */
  onRethink: (question: string, answerMode?: "answer" | "compliance" | "explore" | "deviation") => void;
  /** Add files to the next question (the "settle this" drop zone). */
  onAttach: (files: File[]) => void;
  onConfirm: (m: ChatMessage, a: PendingAction) => void;
  actions: ActionState;
  onRetry: (question: string) => void;
  onRated: (rating: 1 | -1 | 0) => void;
}) {
  const payload = (m.payload ?? null) as AssistantPayload | null;
  const question = payload?.question ?? "";

  if (m.status === "error") {
    return (
      // Said in place, where the answer would have been.
      <div role="alert" className="flex items-start gap-2.5 flex-wrap">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
        <div className="min-w-0 flex-1 basis-60">
          <div className="text-[14.5px] font-bold text-rose-800 dark:text-rose-300">No answer this time.</div>
          <div className="text-[13.5px] text-[var(--color-text-muted)]">{m.error ?? "The question didn't get an answer."}</div>
        </div>
        {isLast && question && (
          <button onClick={() => onRetry(question)} className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)]">
            <RotateCcw className="w-4 h-4" /> Ask again
          </button>
        )}
      </div>
    );
  }

  if (!payload) {
    return <p className="text-[14.5px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap">{m.content}</p>;
  }

  if (payload.kind === "tools") return (
    <ToolsTurn m={m} payload={payload} actions={actions} onConfirm={onConfirm} latest={isLast} />
  );

  // ── Library / internet ──
  const answer: KnowledgeAnswer = { ...payload, answer: payload.answer ?? m.content };
  const replayed = (payload as { replayedFrom?: { userName: string | null; createdAt: string } }).replayedFrom;
  const need = answer.answer ? parseNeedPrompt(answer.answer) : null;

  if (answer.clarification) {
    return isLast ? (
      <ClarifyCard prompt={answer.clarification.question} options={answer.clarification.options}
        onAnswer={(focus) => onClarify(question, focus)} />
    ) : (
      <p className="text-[13px] text-[var(--color-text-muted)]">Asked which parts to cover: {answer.clarification.options.join(", ")}.</p>
    );
  }
  if (need) {
    const priorInputs = (m.payload as { inputs?: string } | null)?.inputs;
    return isLast ? (
      <NeedCard prompt={need} onProvide={(values) => onNeed(question, values, undefined, priorInputs)} />
    ) : (
      <p className="text-[13px] text-[var(--color-text-muted)]">Needed a value: {need}</p>
    );
  }

  if (answer.mode === "internet") {
    return (
      <article className="max-w-3xl">
        <div className="mb-4 flex items-center gap-x-3 gap-y-1 flex-wrap">
          <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Internet answer</span>
          <span className="inline-flex items-center gap-1 text-[12px] font-bold text-amber-700 dark:text-amber-400">
            <Globe className="w-3.5 h-3.5 shrink-0" />
            {answer.liveWeb ? "From a live web search" : "From the model's general knowledge"}, not your controlled documents
          </span>
        </div>
        <AnswerView answer={answer.answer} citations={answer.citations} onCite={onCite} />
        <CitationChips citations={answer.citations} onOpen={onCite} />
        <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
          {answer.provider} · {answer.model} · not a controlled source. Check it before you rely on it.
        </p>
      </article>
    );
  }

  return (
    <div>
      {replayed && (
        <p className="mb-4 flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
          <History className="w-4 h-4 shrink-0" />
          <span><b className="font-bold text-[var(--color-text)]">Reused from the team&apos;s record:</b> answered for {(replayed.userName ?? "someone").split("@")[0]} on {new Date(replayed.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}. No new AI run.</span>
        </p>
      )}
      <AnswerExperience question={question} answer={answer} showQuestion={false}
        latest={isLast && !replayed}
        onCite={onCite} onOpenDoc={onOpenDoc} onOpenTag={onOpenTag}
        onFollowup={isLast && question && !replayed
          ? (value) => onNeed(question, value, undefined, (m.payload as { inputs?: string } | null)?.inputs)
          : undefined}
        onRethink={question && !replayed ? (mode) => onRethink(question, mode) : undefined}
        onAttach={onAttach} />
      {answer.questionId && !replayed && (
        <RatedFeedback questionId={answer.questionId} onRated={onRated} question={question}
          citations={answer.citations.flatMap((c) => c.documentName && typeof c.page === "number" ? [{ documentName: c.documentName, page: c.page }] : [])} />
      )}
    </div>
  );
}

/** Thumbs — the same AnswerFeedback, with the verdict surfaced so the shell
 *  can settle a conversation on a thumbs-up. */
function RatedFeedback({ questionId, onRated, question, citations }: {
  questionId: string; onRated: (r: 1 | -1 | 0) => void;
  question?: string; citations?: Array<{ documentName: string; page: number }>;
}) {
  return <AnswerFeedback key={questionId} questionId={questionId} onRated={onRated} question={question} citations={citations} />;
}

const ORANGE_BTN = "inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-extrabold hover:bg-[var(--color-accent-hover)] shadow-[0_10px_20px_-12px_var(--color-accent)] disabled:opacity-50 transition-colors";
const INK_BTN = "inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--color-text)] text-[var(--color-surface)] text-[13px] font-bold hover:opacity-90 disabled:opacity-50 transition-opacity";
const QUIET_BTN = "inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] transition-colors";

function ToolsTurn({ m, payload, actions, onConfirm, latest }: {
  m: ChatMessage;
  payload: Extract<AssistantPayload, { kind: "tools" }>;
  actions: ActionState;
  onConfirm: (m: ChatMessage, a: PendingAction) => void;
  /** The newest turn: its first waiting proposal is the one orange. */
  latest: boolean;
}) {
  const [showTrace, setShowTrace] = useState(false);
  const steps = payload.steps ?? [];
  const pending = payload.pending ?? [];
  const firstOpen = latest
    ? pending.find((a) => !a.href && !actions.approved.includes(a.fingerprint))?.fingerprint
    : undefined;
  return (
    <div className="max-w-3xl space-y-6">
      <AssistantAnswer answer={payload.answer ?? m.content} mentionedDocs={payload.mentionedDocs} />

      {pending.length > 0 && (
        <div className="space-y-5">
          {pending.map((action) => (
            <PendingCard
              key={action.fingerprint}
              action={action}
              done={actions.approved.includes(action.fingerprint)}
              outcome={actions.outcomes[action.fingerprint]}
              busy={actions.executing === action.fingerprint}
              onConfirm={() => onConfirm(m, action)}
              primary={action.fingerprint === firstOpen}
            />
          ))}
        </div>
      )}

      {(steps.length > 0 || payload.stoppedBecause) && (
        // What it actually did: the steps as one connected path. Folded to
        // a row of dots until opened.
        <section className="pt-3 border-t border-[var(--color-border)]">
          <button
            onClick={() => setShowTrace((s) => !s)} aria-expanded={showTrace}
            className="group w-full flex items-center gap-x-3 gap-y-1 flex-wrap text-left"
          >
            <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]">
              {steps.length} {steps.length === 1 ? "step" : "steps"} it took
            </span>
            {!showTrace && steps.length > 0 && (
              <span aria-hidden className="flex items-center">
                {steps.slice(0, 12).map((s, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span className="w-3 h-0.5 bg-[var(--color-border-strong)]" />}
                    <span className={`w-2.5 h-2.5 rounded-full ${s.error ? "bg-rose-500" : "bg-[var(--color-text)]"}`} />
                  </React.Fragment>
                ))}
              </span>
            )}
            {payload.stoppedBecause && (
              <span className="text-[12px] font-bold text-amber-700 dark:text-amber-400">Stopped early: {payload.stoppedBecause}</span>
            )}
            <span className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-faint)]">
              {payload.model}
              <ChevronDown className={`h-4 w-4 transition-transform ${showTrace ? "rotate-180" : ""}`} />
            </span>
          </button>
          {showTrace && (
            <ol className="mt-4">
              {steps.map((s, i) => <StepView key={i} step={s} n={i + 1} last={i === steps.length - 1} />)}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

function StepView({ step, n, last }: { step: RunStep; n: number; last: boolean }) {
  const [open, setOpen] = useState(false);
  const params = Object.entries(step.parameters ?? {})
    .map(([k, v]) => `${k}: ${String(v)}`).join(", ");
  return (
    <li className="relative pl-9 pb-4 last:pb-0">
      {!last && <span aria-hidden className="absolute left-[11px] top-6 bottom-0 w-0.5 bg-[var(--color-border)]" />}
      <span className={`absolute left-0 top-0 w-6 h-6 rounded-full border-2 bg-[var(--color-surface)] grid place-items-center font-mono text-[11px] font-bold ${step.error
        ? "border-rose-500 text-rose-700 dark:text-rose-300"
        : "border-[var(--color-text)] text-[var(--color-text)]"}`}>{n}</span>
      {step.error ? (
        <div className="text-[14px] leading-snug">
          <span className="font-bold text-[var(--color-text)]">{describeTool(step.tool)}</span>
          {params && <span className="text-[var(--color-text-muted)]">: {params}</span>}
          <p className="mt-0.5 text-[13px] font-semibold text-rose-700 dark:text-rose-400">Didn&apos;t work: {step.error}</p>
        </div>
      ) : (
        <>
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="group text-left text-[14px] leading-snug">
            <span className="font-bold text-[var(--color-text)] group-hover:underline">{describeTool(step.tool)}</span>
            {params && <span className="text-[var(--color-text-muted)]">: {params}</span>}
            <span className="ml-2 text-[12px] font-bold text-[var(--color-text-faint)] group-hover:text-[var(--color-text)]">{open ? "Hide result" : "Show result"}</span>
          </button>
          {open && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-[var(--color-surface-2)] p-2.5 text-[12px] text-[var(--color-text-muted)]">
              {JSON.stringify(step.result, null, 2)}
            </pre>
          )}
        </>
      )}
    </li>
  );
}

function PendingCard({ action, done, outcome, busy, onConfirm, primary }: {
  action: PendingAction; done: boolean;
  outcome?: { ok: boolean; note: string };
  busy: boolean; onConfirm: () => void;
  /** The one orange on the screen: the first proposal still waiting. */
  primary: boolean;
}) {
  return (
    <section className="space-y-2">
      <div className={`flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.14em] ${done
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-amber-700 dark:text-amber-400"}`}>
        {done ? <Check className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
        {done ? "Ran with your OK" : "Needs your OK before it runs"}
      </div>
      <p className="text-[15px] font-semibold leading-snug text-[var(--color-text)]">{action.summary}</p>
      {outcome && !outcome.ok && (
        <p role="alert" className="text-[13px] font-semibold text-rose-700 dark:text-rose-400">It didn&apos;t run: {outcome.note}</p>
      )}
      <div className="flex items-center gap-2">
        {done ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-emerald-700 dark:text-emerald-400">
            <Check className="h-4 w-4" /> Done{outcome?.note && outcome.note !== "done" ? `: ${outcome.note}` : ""}
          </span>
        ) : action.href ? (
          // Handed off rather than executed: the real flow enforces guards
          // this assistant must not shortcut.
          <Link href={action.href} className={QUIET_BTN}>
            Open and continue there <ArrowUpRight className="h-4 w-4" />
          </Link>
        ) : (
          <button onClick={onConfirm} disabled={busy} className={primary ? ORANGE_BTN : INK_BTN}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {busy ? "Running…" : "Confirm and run"}
          </button>
        )}
      </div>
    </section>
  );
}
