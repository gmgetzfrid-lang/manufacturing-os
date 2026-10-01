"use client";

// components/knowledge/AssistantAskCards.tsx — ASK-6. The two places the
// knowledge page puts text the MODEL wrote in front of the reader: a clarify
// round's question and aspect buttons, and a calculation's Need prompt above
// an input. Both are framed as the assistant's words and screened by
// lib/assistantScreen.ts, which refuses in exactly two cases — a real URL,
// or a secret plus an instruction to put it in this box — shown in place of
// the card. Anything else that touches a credential is an amber caution
// beside the text, and the input / buttons stay enabled.

import React, { useState } from "react";
import { Sparkles, Send, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { screenAssistantRequest } from "@/lib/assistantScreen";

// ASK-6: text the MODEL wrote is shown as the assistant's words — quoted,
// labelled, in a container that is not the app's own chrome — never as the
// app speaking, and never as a bare action label.
function AssistantAskingFrame({ tone, children }: { tone: "sky" | "indigo"; children: React.ReactNode }) {
  const ring = tone === "sky"
    ? "border-sky-300 dark:border-sky-800 bg-sky-50/40 dark:bg-sky-950/10"
    : "border-indigo-300 dark:border-indigo-800 bg-indigo-50/40 dark:bg-indigo-950/10";
  return (
    <div className={`mt-4 rounded-2xl border-2 border-dashed ${ring} p-4 animate-rise`} data-assistant-authored="true">
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-[0.18em] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
          <Sparkles className="w-3 h-3" /> AI-written
        </span>
        <span className="text-[11px] font-bold text-[var(--color-text-muted)]">
          The assistant is asking — the words below are the AI model&apos;s, not this app&apos;s.
        </span>
      </div>
      {children}
    </div>
  );
}

/** What the screen refuses, in place of the input or the buttons. */
function AssistantRequestRefused({ reason }: { reason: string }) {
  return (
    <div className="mt-4 rounded-2xl border-2 border-rose-300 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-950/20 p-4 text-xs text-rose-800 dark:text-rose-200">
      <div className="font-black flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> The AI asked for something this app never collects</div>
      <p className="mt-1">
        Its request was not shown because {reason}. Nothing was sent. Don&apos;t type passwords, keys, account or
        identity details anywhere in response — ask the question again, or tell your admin if it repeats.
      </p>
    </div>
  );
}

/** ASK-6: a credential or a web address is mentioned — said beside the text,
 *  never in place of the input. */
function AssistantCaution({ text }: { text: string }) {
  return (
    <p role="note" data-assistant-caution="true"
      className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/20 px-2.5 py-1.5 text-[11px] font-bold text-amber-800 dark:text-amber-200">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

// Clarify round (opt-in library feature): the AI found the answer across
// several distinct aspects and asks WHICH before answering — select all that
// apply, or take everything. One round max: the re-ask always carries focus.
export function ClarifyCard({ prompt, options, onAnswer }: {
  prompt: string;
  options: string[];
  onAnswer: (focus: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The question gets the same two refusals as a Need prompt; anything else
  // is at most a caution. An aspect is a short label the model proposed:
  // dropped only for a real URL or its length ("Mean and Std.Dev." and
  // "Password length and rotation" are aspects), and too few left means no
  // card at all.
  const promptCheck = screenAssistantRequest(prompt, "clarify");
  const safeOptions = options.filter((o) => screenAssistantRequest(o, "aspect").ok).map((o) => o.slice(0, 80));
  const toggle = (o: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(o)) next.delete(o); else next.add(o);
      return next;
    });
  };
  if (!promptCheck.ok) return <AssistantRequestRefused reason={promptCheck.reason} />;
  if (safeOptions.length < 2) return <AssistantRequestRefused reason="its choices were not plain aspects of the question" />;
  return (
    <AssistantAskingFrame tone="sky">
      <blockquote className="border-l-2 border-sky-400 pl-3 text-xs italic text-[var(--color-text)] whitespace-pre-wrap">
        &ldquo;{prompt}&rdquo;
      </blockquote>
      {promptCheck.caution && <AssistantCaution text={promptCheck.caution} />}
      <div className="mt-2.5 text-[10px] font-bold text-[var(--color-text-muted)]">Aspects the assistant suggested — pick which to answer:</div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {safeOptions.map((o) => (
          <button key={o} type="button" onClick={() => toggle(o)} aria-label={`AI-suggested aspect: ${o}`}
            className={`text-[11px] font-bold italic px-2.5 py-1.5 rounded-lg border border-dashed transition-colors ${
              selected.has(o)
                ? "border-sky-600 bg-sky-600 text-white"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-sky-400"}`}>
            {o}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <Button size="sm" onClick={() => onAnswer([...selected])} disabled={selected.size === 0}>
          <Send className="w-3.5 h-3.5" /> Answer the selected aspects ({selected.size})
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onAnswer(safeOptions)}>
          Answer all of them
        </Button>
      </div>
    </AssistantAskingFrame>
  );
}

// Need round: a calculation answer stopped because it needs user-specific
// values (test temperature, design pressure…). Ask, collect, re-ask — the
// documents can't know these, only the person can.
export function NeedCard({ prompt, onProvide }: {
  prompt: string;
  onProvide: (values: string) => void;
}) {
  const [value, setValue] = useState("");
  // A Need prompt opens an input: refused only for a real URL or a secret it
  // asks to have typed into this box; any other credential it mentions is a
  // caution above the input, never a refusal.
  const check = screenAssistantRequest(prompt, "need");
  if (!check.ok) return <AssistantRequestRefused reason={check.reason} />;
  return (
    <AssistantAskingFrame tone="indigo">
      <div className="text-[10px] font-bold text-[var(--color-text-muted)]">To finish a calculation, the assistant asks for an input value:</div>
      <blockquote className="mt-1 border-l-2 border-indigo-400 pl-3 text-xs italic text-[var(--color-text)] whitespace-pre-wrap">
        &ldquo;{prompt}&rdquo;
      </blockquote>
      {check.caution && <AssistantCaution text={check.caution} />}
      <p className="mt-2 text-[11px] font-bold text-rose-700 dark:text-rose-400">
        Never enter passwords, keys, account numbers or personal data here — what you type is sent to the AI provider
        and saved with this question. Engineering values only.
      </p>
      <div className="mt-2 flex items-end gap-2">
        <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={1}
          placeholder='e.g. "test temperature = 150°F, design pressure = 285 psig"'
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value.trim()) onProvide(value.trim());
          }}
          className="flex-1 text-xs" />
        <Button size="sm" onClick={() => onProvide(value.trim())} disabled={!value.trim()}>
          <Send className="w-3.5 h-3.5" /> Calculate
        </Button>
      </div>
    </AssistantAskingFrame>
  );
}
