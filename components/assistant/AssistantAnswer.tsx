"use client";

// The controller's answer, read like a document — not a wall of text.
// Same look as the library answer: the direct answer first in one big line,
// small part names on a hairline, plain bullets, warnings as rows with an
// amber edge, value chips, and every document the answer names as a
// click-to-open chip.
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
      className="ui-id inline-flex items-center gap-1 align-baseline mx-0.5 underline decoration-[color-mix(in_srgb,var(--color-heading)_40%,transparent)] underline-offset-[3px]">
      <FileText className="w-3.5 h-3.5 shrink-0" />{label}
    </Link>
  );
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          // Recurse so a doc mention INSIDE a bold span still gets its chip.
          return <b key={i} className="font-medium"><Inline text={part.slice(2, -2)} docs={docs} /></b>;
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          const inner = part.slice(1, -1);
          const dl = linkFor(inner);
          if (dl) return chip(dl, inner, i);
          return (
            <code key={i} className="mx-0.5 px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text)] font-display tabular-nums font-semibold text-[0.95em]">
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
        <div className="pb-2 font-display text-[24px] sm:text-[28px] leading-[1.2] font-semibold text-[var(--color-text)]">
          <Inline text={hero.text} docs={docs} />
        </div>
      )}
      {rest.map((b, i) => {
        if (b.type === "label") {
          return (
            <h4 key={i} className="pt-4 first:pt-0 font-display text-section font-semibold text-[var(--color-heading)]">{b.text}</h4>
          );
        }
        if (b.type === "important") {
          return (
            <div key={i} className="relative pl-4 py-1 flex items-start gap-2">
              <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-held)]" />
              <AlertTriangle className="w-4 h-4 text-[var(--state-held)] mt-1 shrink-0" />
              <span className="text-reading font-medium text-[var(--color-text)] leading-relaxed">
                <Inline text={b.text} docs={docs} />
              </span>
            </div>
          );
        }
        if (b.type === "bullet") {
          return (
            <div key={i} className="flex items-start gap-2.5 text-reading text-[var(--color-text)] leading-relaxed">
              <span className="mt-[10px] w-1.5 h-1.5 rounded-full bg-[var(--color-main)] shrink-0" />
              <span><Inline text={b.text} docs={docs} /></span>
            </div>
          );
        }
        return (
          <p key={i} className="text-reading text-[var(--color-text)] leading-relaxed">
            <Inline text={b.text} docs={docs} />
          </p>
        );
      })}
    </div>
  );
}
