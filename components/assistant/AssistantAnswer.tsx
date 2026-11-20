"use client";

// The controller's answer, read like a document — not a wall of text.
// Same look as the library answer: the direct answer first in one big line,
// small all-caps part names on a hairline, plain bullets, amber warnings on
// the line they are about, value chips, and every document the answer names
// as a click-to-open chip.
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
      className="inline-flex items-center gap-1 align-baseline mx-0.5 px-1.5 py-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)] font-bold text-[0.85em] leading-none hover:border-[var(--color-border-strong)] transition-colors">
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
            <code key={i} className="mx-0.5 px-1.5 py-0.5 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text)] font-mono font-bold text-[0.92em]">
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
        // The answer first, in the biggest type on the page.
        <div className="pb-2 text-[20px] sm:text-[24px] leading-[1.3] font-extrabold tracking-[-0.015em] text-[var(--color-text)]">
          <Inline text={hero.text} docs={docs} />
        </div>
      )}
      {rest.map((b, i) => {
        if (b.type === "label") {
          return (
            <div key={i} className="flex items-center gap-3 pt-4 first:pt-0">
              <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">{b.text}</span>
              <span className="flex-1 h-px bg-[var(--color-border)]" />
            </div>
          );
        }
        if (b.type === "important") {
          return (
            <div key={i} className="flex items-start gap-2.5 py-0.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-1 shrink-0" />
              <span className="text-[14.5px] font-semibold text-amber-900 dark:text-amber-200 leading-relaxed">
                <Inline text={b.text} docs={docs} />
              </span>
            </div>
          );
        }
        if (b.type === "bullet") {
          return (
            <div key={i} className="flex items-start gap-2.5 text-[14.5px] text-[var(--color-text)] leading-relaxed">
              <span className="mt-[10px] w-1.5 h-1.5 rounded-full bg-[var(--color-text)] shrink-0" />
              <span><Inline text={b.text} docs={docs} /></span>
            </div>
          );
        }
        return (
          <p key={i} className="text-[14.5px] text-[var(--color-text)] leading-relaxed">
            <Inline text={b.text} docs={docs} />
          </p>
        );
      })}
    </div>
  );
}
