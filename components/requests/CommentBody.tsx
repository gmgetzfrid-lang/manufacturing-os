"use client";

// CommentBody — render a comment that may contain @[name](uid) tokens
// as inline mention chips. Lightweight markdown: **bold**, *italic*,
// `code`, [link](url), URL auto-link, * and - bullet lists, > quotes,
// newlines preserved. We hand-roll the parser instead of pulling
// in a heavy md library — comments are short and we want to ensure
// XSS-safe rendering (no html-string injection).

import React from "react";
import { tokenizeMentions } from "@/lib/notifications";
import { AtSign } from "lucide-react";

interface CommentBodyProps {
  text: string;
  currentUserId?: string;
  className?: string;
}

export default function CommentBody({ text, currentUserId, className }: CommentBodyProps) {
  if (!text) return null;
  const tokens = tokenizeMentions(text);

  return (
    <div className={`whitespace-pre-wrap break-words ${className ?? ""}`}>
      {tokens.map((t, idx) => {
        if (t.kind === "mention") {
          const isMe = currentUserId && t.uid === currentUserId;
          return (
            <span
              key={idx}
              className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[12px] font-bold align-baseline mr-0.5 ${
                isMe
                  ? "bg-orange-100 text-orange-700 ring-1 ring-orange-200"
                  : "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent-ring)]"
              }`}
              title={`Mentioned: ${t.name}`}
            >
              <AtSign className="w-3 h-3" />
              {t.name}
            </span>
          );
        }
        return <MdSpan key={idx} text={t.value} />;
      })}
    </div>
  );
}

// Lightweight inline markdown renderer. Order matters: scan once,
// match patterns longest-first. Everything else falls through as plain
// text so we never lose user content.
function MdSpan({ text }: { text: string }) {
  if (!text) return null;
  const nodes: React.ReactNode[] = [];
  // Block-level: lines starting with > become quote rows; * / - become bullets.
  const lines = text.split("\n");
  lines.forEach((line, lineIdx) => {
    const lineKey = `l${lineIdx}`;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("> ")) {
      nodes.push(
        <div key={lineKey} className="border-l-2 border-[var(--color-border-strong)] pl-2 my-0.5 text-[var(--color-text-muted)] italic">
          {renderInline(trimmed.slice(2))}
        </div>
      );
    } else if (/^[*-] /.test(trimmed)) {
      nodes.push(
        <div key={lineKey} className="flex gap-1.5 my-0.5">
          <span className="text-[var(--color-text-faint)]">•</span>
          <span className="flex-1">{renderInline(trimmed.slice(2))}</span>
        </div>
      );
    } else {
      nodes.push(<React.Fragment key={lineKey}>{renderInline(line)}{lineIdx < lines.length - 1 && "\n"}</React.Fragment>);
    }
  });
  return <>{nodes}</>;
}

function renderInline(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Regex captures: bold **x** | italic *x* (or _x_) | code `x` | link [t](u) | bare URL
  const re = /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*|_([^_\n]+)_)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\bhttps?:\/\/\S+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(<React.Fragment key={`t${i++}`}>{line.slice(last, m.index)}</React.Fragment>);
    if (m[1]) out.push(<strong key={`b${i++}`} className="font-bold">{m[2]}</strong>);
    else if (m[3]) out.push(<em key={`i${i++}`} className="italic">{m[4] ?? m[5]}</em>);
    else if (m[6]) out.push(<code key={`c${i++}`} className="px-1 py-0.5 rounded bg-[var(--color-surface-2)] text-[11px] font-mono">{m[7]}</code>);
    else if (m[8]) out.push(<a key={`l${i++}`} href={m[10]} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] underline hover:text-[var(--color-accent-hover)] transition-colors">{m[9]}</a>);
    else if (m[11]) out.push(<a key={`a${i++}`} href={m[11]} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] underline hover:text-[var(--color-accent-hover)] transition-colors break-all">{m[11]}</a>);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(<React.Fragment key={`t${i}`}>{line.slice(last)}</React.Fragment>);
  return out;
}
