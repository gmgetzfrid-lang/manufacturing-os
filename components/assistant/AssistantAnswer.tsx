"use client";

// The controller's answer, rendered like an answer — not a wall of text.
// Same visual language as the knowledge library chat: hero callout up top,
// accent-bar section headers, orange-dot bullets, amber warning callouts,
// value chips, and every document the answer names as a click-to-open chip.
// The parser (parseAnswerBlocks) guarantees structure even when the model
// ignores its format — run-on paragraphs are exploded into bullets there.
// Theme tokens throughout, so it reads the same in dark mode as the rest.

import React from "react";
import Link from "next/link";
import { AlertTriangle, FileText } from "lucide-react";
import { parseAnswerBlocks } from "@/lib/knowledgeText";
import type { MentionedDoc } from "@/lib/orchestratorClient";

function Inline({ text, docs }: { text: string; docs: MentionedDoc[] }) {
  // Longest mention first so "EP 5-5-1" never half-matches as "EP 5-5".
  const alt = docs
    .map((d) => d.mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  const parts = text.split(new RegExp(`(\\*\\*[^*]+\\*\\*|\`[^\`]+\`${alt ? `|${alt}` : ""})`, "g"));
  const linkFor = (s: string) => docs.find((d) => d.mention === s);
  const chip = (d: MentionedDoc, label: string, key: number) => (
    <Link key={key} href={d.openUrl} title={`Open ${d.title || d.number || label}`}
      className="inline-flex items-center gap-1 align-baseline mx-0.5 px-1.5 py-0.5 rounded-md border border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/40 text-orange-800 dark:text-orange-200 font-bold text-[0.85em] leading-none hover:bg-orange-100 dark:hover:bg-orange-900/50 hover:border-orange-500 transition-colors">
      <FileText className="w-3 h-3 shrink-0" />{label}
    </Link>
  );
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          // Recurse so a doc mention INSIDE a bold span still gets its chip.
          return <b key={i} className="font-black"><Inline text={part.slice(2, -2)} docs={docs} /></b>;
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          const inner = part.slice(1, -1);
          const dl = linkFor(inner);
          if (dl) return chip(dl, inner, i);
          return (
            <code key={i} className="mx-0.5 px-1.5 py-0.5 rounded-md bg-orange-100 dark:bg-orange-950/50 border border-orange-200 dark:border-orange-900 text-orange-900 dark:text-orange-200 font-mono font-bold text-[0.92em]">
              {inner}
            </code>
          );
        }
        const dl = linkFor(part);
        if (dl) return chip(dl, part, i);
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
}

export default function AssistantAnswer({ answer, mentionedDocs }: {
  answer: string;
  mentionedDocs?: MentionedDoc[];
}) {
  const docs = mentionedDocs ?? [];
  const blocks = parseAnswerBlocks(answer);
  const hero = blocks[0]?.type === "hero" ? blocks[0] : null;
  const rest = hero ? blocks.slice(1) : blocks;
  return (
    <div className="space-y-2.5">
      {hero && (
        <div className="rounded-xl border-l-4 border-orange-500 bg-orange-50 dark:bg-orange-950/30 px-4 py-3">
          <div className="text-[9px] font-black uppercase tracking-[0.18em] text-orange-600 mb-1">Answer</div>
          <div className="text-[15px] font-bold text-[var(--color-text)] leading-snug">
            <Inline text={hero.text} docs={docs} />
          </div>
        </div>
      )}
      {rest.map((b, i) => {
        if (b.type === "label") {
          return (
            <div key={i} className="flex items-center gap-2 pt-3 first:pt-0">
              <span className="w-1 h-4 rounded-full bg-orange-500 shrink-0" />
              <span className="text-[13px] font-black text-[var(--color-text)]">{b.text}</span>
              <span className="flex-1 h-px bg-[var(--color-border)]" />
            </div>
          );
        }
        if (b.type === "important") {
          return (
            <div key={i} className="flex items-start gap-2.5 rounded-xl border-2 border-amber-400 dark:border-amber-600 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/30 px-4 py-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
              <span className="text-[14px] font-bold text-amber-900 dark:text-amber-200 leading-snug">
                <Inline text={b.text} docs={docs} />
              </span>
            </div>
          );
        }
        if (b.type === "bullet") {
          return (
            <div key={i} className="flex items-start gap-2 text-sm text-[var(--color-text)] leading-relaxed">
              <span className="mt-[8px] w-1 h-1 rounded-full bg-orange-500 shrink-0" />
              <span><Inline text={b.text} docs={docs} /></span>
            </div>
          );
        }
        return (
          <p key={i} className="text-sm text-[var(--color-text)] leading-relaxed">
            <Inline text={b.text} docs={docs} />
          </p>
        );
      })}
    </div>
  );
}
