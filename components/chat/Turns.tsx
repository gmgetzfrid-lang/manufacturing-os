"use client";

// Turns — one question, one answer, rendered the way a chat reads:
//   • the question as a soft bubble that STAYS PINNED at the top of its
//     pair while the answer below scrolls (sticky), with its attachments;
//   • the answer flat, no bubble — the library's hero/basis/sources card
//     or the controller's answer with its proposals and collapsed trace.
// Everything the two old surfaces showed is here, assigned a layer: inline
// for what needs a decision, collapsed for what's about one answer.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  Wrench, ChevronDown, ChevronRight, ShieldAlert, ArrowUpRight, AlertTriangle, Check, Loader2,
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
  return (
    <div className="sticky top-0 z-10 py-2 bg-[var(--color-canvas)]">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-[var(--color-surface-2)] border border-[var(--color-border)] px-4 py-2.5 shadow-sm">
          <div className="text-[14px] text-[var(--color-text)] whitespace-pre-wrap leading-relaxed">{m.content}</div>
          {(focus?.length || inputs) ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {focus?.map((f) => (
                <span key={f} className="text-[10px] font-black px-1.5 py-0.5 rounded-md bg-sky-100 dark:bg-sky-950/50 text-sky-800 dark:text-sky-300">{f}</span>
              ))}
              {inputs && <span className="text-[10px] font-black px-1.5 py-0.5 rounded-md bg-indigo-100 dark:bg-indigo-950/50 text-indigo-800 dark:text-indigo-300">{inputs}</span>}
            </div>
          ) : null}
          {m.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {m.attachments.map((a) => <AttachmentCard key={a.id || a.path} a={a} onOpen={() => onOpenAttachment(a)} />)}
            </div>
          )}
          <div className="mt-1 text-[10px] text-[var(--color-text-faint)] text-right">
            {mine ? "You" : (m.userName ?? "Someone").split("@")[0]} · {relativeTime(m.createdAt)}
          </div>
        </div>
      </div>
    </div>
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
    <button onClick={onOpen} title={`${a.name} · ${fmtBytes(a.size)} — context for this question only`}
      className={`group relative overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent-ring)] transition-colors ${large ? "w-full" : ""}`}>
      {a.kind === "image" && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={a.name} className={large ? "w-full h-auto" : "h-20 w-28 object-cover"} />
      ) : (
        <div className={`flex items-center gap-2 px-2.5 py-2 ${large ? "" : "max-w-[200px]"}`}>
          {a.kind === "image" ? <ImageIcon className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" /> : <FileText className="w-4 h-4 text-rose-600 shrink-0" />}
          <span className="text-[11px] font-bold text-[var(--color-text)] truncate">{a.name}</span>
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
  m, isLast, onCite, onOpenDoc, onOpenTag, onClarify, onNeed, onConfirm, actions, onRetry, onRated,
}: {
  m: ChatMessage;
  isLast: boolean;
  onCite: (c: KnowledgeCitation) => void;
  onOpenDoc: (d: DocLink) => void;
  onOpenTag: (documentId: string, page: number, tag: string, documentName: string) => void;
  onClarify: (question: string, focus: string[]) => void;
  onNeed: (question: string, values: string, focus?: string[], priorInputs?: string) => void;
  onConfirm: (m: ChatMessage, a: PendingAction) => void;
  actions: ActionState;
  onRetry: (question: string) => void;
  onRated: (rating: 1 | -1 | 0) => void;
}) {
  const payload = (m.payload ?? null) as AssistantPayload | null;
  const question = payload?.question ?? "";

  if (m.status === "error") {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-3.5 py-3 text-sm text-rose-800 dark:text-rose-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="flex-1">{m.error ?? "The question failed."}</span>
        {isLast && question && (
          <button onClick={() => onRetry(question)} className="shrink-0 inline-flex items-center gap-1 text-xs font-black hover:underline">
            <RotateCcw className="w-3.5 h-3.5" /> Retry
          </button>
        )}
      </div>
    );
  }

  if (!payload) {
    return <p className="text-sm text-[var(--color-text)] whitespace-pre-wrap">{m.content}</p>;
  }

  if (payload.kind === "tools") return (
    <ToolsTurn m={m} payload={payload} actions={actions} onConfirm={onConfirm} />
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
      <p className="text-xs text-[var(--color-text-muted)] italic">Asked which aspects to cover: {answer.clarification.options.join(", ")}.</p>
    );
  }
  if (need) {
    const priorInputs = (m.payload as { inputs?: string } | null)?.inputs;
    return isLast ? (
      <NeedCard prompt={need} onProvide={(values) => onNeed(question, values, undefined, priorInputs)} />
    ) : (
      <p className="text-xs text-[var(--color-text-muted)] italic">Needed a value: {need}</p>
    );
  }

  if (answer.mode === "internet") {
    return (
      <div className="rounded-2xl border border-sky-200 dark:border-sky-900 bg-sky-50/40 dark:bg-sky-950/10 p-4">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-bold text-sky-800 dark:text-sky-300">
          <Globe className="w-3.5 h-3.5 shrink-0" />
          Internet answer — {answer.liveWeb ? "from a live web search" : "from the model's general knowledge"}, not your controlled documents.
        </div>
        <AnswerView answer={answer.answer} citations={answer.citations} onCite={onCite} />
        <CitationChips citations={answer.citations} onOpen={onCite} />
        <p className="mt-3 pt-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]">
          {answer.provider} · {answer.model} · carries no doc-control weight — cross-check before relying on it.
        </p>
      </div>
    );
  }

  return (
    <div>
      {replayed && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-violet-300 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 px-3 py-2 text-[11px] font-bold text-violet-800 dark:text-violet-300">
          <History className="w-3.5 h-3.5 shrink-0" />
          Reused from the team&apos;s record — answered {relativeTime(replayed.createdAt)} ago for {(replayed.userName ?? "someone").split("@")[0]}. No new AI run.
        </div>
      )}
      <AnswerExperience question={question} answer={answer} showQuestion={false}
        onCite={onCite} onOpenDoc={onOpenDoc} onOpenTag={onOpenTag} />
      {answer.questionId && !replayed && (
        <RatedFeedback questionId={answer.questionId} onRated={onRated} />
      )}
    </div>
  );
}

/** Thumbs — the same AnswerFeedback, with the verdict surfaced so the shell
 *  can settle a conversation on a thumbs-up. */
function RatedFeedback({ questionId, onRated }: { questionId: string; onRated: (r: 1 | -1 | 0) => void }) {
  return <AnswerFeedback key={questionId} questionId={questionId} onRated={onRated} />;
}

function ToolsTurn({ m, payload, actions, onConfirm }: {
  m: ChatMessage;
  payload: Extract<AssistantPayload, { kind: "tools" }>;
  actions: ActionState;
  onConfirm: (m: ChatMessage, a: PendingAction) => void;
}) {
  const [showTrace, setShowTrace] = useState(false);
  const steps = payload.steps ?? [];
  const pending = payload.pending ?? [];
  return (
    <div className="space-y-3">
      <AssistantAnswer answer={payload.answer ?? m.content} mentionedDocs={payload.mentionedDocs} />

      {pending.map((action) => (
        <PendingCard
          key={action.fingerprint}
          action={action}
          done={actions.approved.includes(action.fingerprint)}
          outcome={actions.outcomes[action.fingerprint]}
          busy={actions.executing === action.fingerprint}
          onConfirm={() => onConfirm(m, action)}
        />
      ))}

      {(steps.length > 0 || payload.stoppedBecause) && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/60">
          <button
            onClick={() => setShowTrace((s) => !s)}
            className="flex w-full items-center gap-2 px-3 py-2 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            {showTrace ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <Wrench className="h-3.5 w-3.5" />
            {steps.length} {steps.length === 1 ? "step" : "steps"} — what it actually did
            {payload.stoppedBecause && (
              <span className="ml-auto text-amber-700 dark:text-amber-400">stopped early — {payload.stoppedBecause}</span>
            )}
            <span className={`text-[var(--color-text-faint)] ${payload.stoppedBecause ? "" : "ml-auto"}`}>{payload.model}</span>
          </button>
          {showTrace && (
            <div className="space-y-2 border-t border-[var(--color-border)] px-3 py-2">
              {steps.map((s, i) => <StepView key={i} step={s} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepView({ step }: { step: RunStep }) {
  const [open, setOpen] = useState(false);
  const params = Object.entries(step.parameters ?? {})
    .map(([k, v]) => `${k}: ${String(v)}`).join(", ");
  return (
    <div className="text-xs">
      <button onClick={() => setOpen((o) => !o)} className="text-left font-bold text-[var(--color-text)] hover:underline">
        {describeTool(step.tool)}
        {params && <span className="font-normal text-[var(--color-text-muted)]"> — {params}</span>}
      </button>
      {step.error
        ? <p className="mt-0.5 text-rose-600">{step.error}</p>
        : open && (
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-[var(--color-surface)] border border-[var(--color-border)] p-2 text-[11px] text-[var(--color-text-muted)]">
            {JSON.stringify(step.result, null, 2)}
          </pre>
        )}
    </div>
  );
}

function PendingCard({ action, done, outcome, busy, onConfirm }: {
  action: PendingAction; done: boolean;
  outcome?: { ok: boolean; note: string };
  busy: boolean; onConfirm: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="flex-1">
          <p className="text-sm font-bold text-amber-900 dark:text-amber-200">Needs your confirmation</p>
          <p className="mt-0.5 text-sm text-amber-800 dark:text-amber-300">{action.summary}</p>
          {outcome && !outcome.ok && (
            <p className="mt-1 text-xs font-bold text-rose-700 dark:text-rose-400">{outcome.note}</p>
          )}
          <div className="mt-2 flex items-center gap-2">
            {done ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" /> Done{outcome?.note && outcome.note !== "done" ? ` — ${outcome.note}` : ""}
              </span>
            ) : action.href ? (
              // Handed off rather than executed: the real flow enforces guards
              // this assistant must not shortcut.
              <Link href={action.href}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700">
                Open and continue there <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <button onClick={onConfirm} disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Confirm and run
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
