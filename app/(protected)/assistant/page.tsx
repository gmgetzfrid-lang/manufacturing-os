"use client";

// /assistant — the document controller you can talk to.
//
// Not a chatbot over a search box. You ask a question in plain English; the
// model decides which of the system's tools to call, calls them, and answers
// from what came back. Three things make it worth trusting:
//
//   1. THE TRACE IS VISIBLE. Every tool call it made is listed, with what it
//      got. An answer you can't audit is a rumour.
//   2. WRITES ARE PROPOSED. Checking out a document or messaging a colleague
//      arrives as a card with a button. The model never acts on its own.
//   3. IT SAYS WHEN IT DOESN'T KNOW. "No documents mention that" is a real
//      answer here, not a failure to be papered over.

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Loader2, Send, Bot, User, Wrench, ChevronDown, ChevronRight,
  ShieldAlert, ArrowUpRight, AlertTriangle, Check,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  askOrchestrator, executeAction, describeTool,
  type OrchestratorReply, type PendingAction, type RunStep,
} from "@/lib/orchestratorClient";

interface Exchange {
  id: string;
  question: string;
  reply?: OrchestratorReply;
  error?: string;
  /** Fingerprints the user confirmed on this exchange. */
  approved: string[];
  /** Per-fingerprint outcome of a confirmed action ("sent", an error, …). */
  outcomes: Record<string, { ok: boolean; note: string }>;
  /** Fingerprint of the action currently executing, if any. */
  executing?: string | null;
}

const EXAMPLES = [
  "Do we have any standards about pipe supports?",
  "What documents mention E-101?",
  "Where did I store the tank inspection procedure?",
  "What connects P-101 to T-201?",
];

export default function AssistantPage() {
  const { activeOrgId } = useRole();
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Cancel any in-flight run when the page goes away — a run that outlives
  // its page still spends the user's money and lands nowhere.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [exchanges]);

  const run = useCallback(async (id: string, text: string, approved: string[]) => {
    if (!activeOrgId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const reply = await askOrchestrator(activeOrgId, text, approved, controller.signal);
      setExchanges((xs) => xs.map((x) => (
        x.id === id ? { ...x, reply, error: undefined } : x
      )));
    } catch (e) {
      if (controller.signal.aborted) return;
      setExchanges((xs) => xs.map((x) => (
        x.id === id
          ? { ...x, error: e instanceof Error ? e.message : "Something went wrong." }
          : x
      )));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [activeOrgId]);

  const ask = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setExchanges((xs) => [...xs, { id, question: trimmed, approved: [], outcomes: {} }]);
    setQuestion("");
    void run(id, trimmed, []);
  }, [busy, run]);

  // Confirming a write executes EXACTLY the proposed action server-side —
  // stored tool + stored parameters, no second model run. What the card said
  // is what happens, every time.
  const confirm = useCallback(async (ex: Exchange, action: PendingAction) => {
    if (!activeOrgId) return;
    const fp = action.fingerprint;
    setExchanges((xs) => xs.map((x) => (x.id === ex.id ? { ...x, executing: fp } : x)));
    let outcome: { ok: boolean; note: string };
    try {
      const result = await executeAction(activeOrgId, action);
      outcome = { ok: true, note: String(result.status ?? "done") };
    } catch (e) {
      outcome = { ok: false, note: e instanceof Error ? e.message : "The action failed." };
    }
    setExchanges((xs) => xs.map((x) => (
      x.id === ex.id
        ? {
            ...x,
            executing: null,
            approved: outcome.ok ? [...x.approved, fp] : x.approved,
            outcomes: { ...x.outcomes, [fp]: outcome },
          }
        : x
    )));
  }, [activeOrgId]);

  if (!activeOrgId) {
    return <div className="p-8 text-sm text-slate-500">Select a workspace to continue.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-slate-900 p-2 text-white"><Bot className="h-5 w-5" /></div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Document controller</h1>
            <p className="text-sm text-slate-500">
              Asks the system, not the internet. Every answer shows the tools it used.
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-8">
          {exchanges.length === 0 && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
              <p className="text-sm font-medium text-slate-700">Try asking:</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {EXAMPLES.map((e) => (
                  <button
                    key={e}
                    onClick={() => ask(e)}
                    className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm
                               text-slate-700 hover:border-slate-400 hover:bg-slate-100"
                  >
                    {e}
                  </button>
                ))}
              </div>
              <p className="mt-4 text-xs text-slate-500">
                It only reads documents approved for indexing. Anything excluded from AI stays invisible to it.
              </p>
            </div>
          )}

          {exchanges.map((ex) => (
            <ExchangeView key={ex.id} exchange={ex} onConfirm={confirm} />
          ))}

          {busy && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Working…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-slate-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(question); }
            }}
            rows={2}
            placeholder="Ask about your documents, equipment, or drawings…"
            className="flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm
                       focus:border-slate-500 focus:outline-none"
          />
          <button
            onClick={() => ask(question)}
            disabled={busy || !question.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm
                       font-medium text-white hover:bg-slate-800 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}

function ExchangeView({
  exchange, onConfirm,
}: { exchange: Exchange; onConfirm: (ex: Exchange, a: PendingAction) => void }) {
  const { question, reply, error, approved, outcomes, executing } = exchange;
  const [showTrace, setShowTrace] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <div className="mt-0.5 rounded-full bg-slate-200 p-1.5"><User className="h-3.5 w-3.5 text-slate-600" /></div>
        <p className="flex-1 text-sm font-medium text-slate-900">{question}</p>
      </div>

      {error && (
        <div className="ml-9 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {reply && (
        <div className="ml-9 space-y-3">
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
            {reply.answer}
          </div>

          {reply.stoppedBecause && (
            <p className="text-xs text-amber-700">
              Stopped early — {reply.stoppedBecause}. Narrowing the question usually helps.
            </p>
          )}

          {reply.pending.map((action) => (
            <PendingCard
              key={action.fingerprint}
              action={action}
              done={approved.includes(action.fingerprint)}
              outcome={outcomes[action.fingerprint]}
              busy={executing === action.fingerprint}
              onConfirm={() => onConfirm(exchange, action)}
            />
          ))}

          {reply.steps.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50">
              <button
                onClick={() => setShowTrace((s) => !s)}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                {showTrace ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <Wrench className="h-3.5 w-3.5" />
                {reply.steps.length} {reply.steps.length === 1 ? "step" : "steps"} — what it actually did
              </button>
              {showTrace && (
                <div className="space-y-2 border-t border-slate-200 px-3 py-2">
                  {reply.steps.map((s, i) => <StepView key={i} step={s} />)}
                </div>
              )}
            </div>
          )}

          <p className="text-[11px] text-slate-400">
            {reply.model} · ${reply.budget.spentUsd.toFixed(2)}
            {reply.budget.capUsd > 0 ? ` of $${reply.budget.capUsd.toFixed(2)} this month` : " this month"}
          </p>
        </div>
      )}
    </div>
  );
}

function StepView({ step }: { step: RunStep }) {
  const params = Object.entries(step.parameters)
    .map(([k, v]) => `${k}: ${String(v)}`).join(", ");
  return (
    <div className="text-xs">
      <p className="font-medium text-slate-700">
        {describeTool(step.tool)}
        {params && <span className="font-normal text-slate-500"> — {params}</span>}
      </p>
      {step.error
        ? <p className="mt-0.5 text-rose-600">{step.error}</p>
        : (
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-white p-2 text-[11px] text-slate-600">
            {JSON.stringify(step.result, null, 2)}
          </pre>
        )}
    </div>
  );
}

function PendingCard({
  action, done, outcome, busy, onConfirm,
}: {
  action: PendingAction; done: boolean;
  outcome?: { ok: boolean; note: string };
  busy: boolean; onConfirm: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="flex-1">
          <p className="text-sm font-medium text-amber-900">Needs your confirmation</p>
          <p className="mt-0.5 text-sm text-amber-800">{action.summary}</p>
          {outcome && !outcome.ok && (
            <p className="mt-1 text-xs font-medium text-rose-700">{outcome.note}</p>
          )}
          <div className="mt-2 flex items-center gap-2">
            {done ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                <Check className="h-3.5 w-3.5" /> Done{outcome?.note && outcome.note !== "done" ? ` — ${outcome.note}` : ""}
              </span>
            ) : action.href ? (
              // Handed off rather than executed: the real flow enforces guards
              // this assistant must not shortcut.
              <Link
                href={action.href}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5
                           text-xs font-medium text-white hover:bg-amber-700"
              >
                Open and continue there <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <button
                onClick={onConfirm}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5
                           text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
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
