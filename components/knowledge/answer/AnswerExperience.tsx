"use client";

// components/knowledge/answer/AnswerExperience.tsx — the library answer,
// read like an engineering answer: the direct answer first in big condensed
// type, the reasons and conditions as short numbered lists, warnings as rows
// with a status edge, and the sources beside it (below it on a phone) as a
// ruled list: document, page, quote. Every action is a white secondary
// button (the composer's Send is the chat's one filled button); the next
// step on the latest answer gets a graphite edge. Also here: the clarify /
// need rounds, the floating proof card, the thumbs that teach retrieval,
// and the card that fills in while an answer streams.

import React, { useEffect, useMemo, useState } from "react";
import {
  BookOpen, Sparkles, Send, FileText, AlertTriangle, ExternalLink, History, Globe,
  ChevronRight, ChevronDown, Copy, Check, PenLine, Eye,
  ThumbsUp, ThumbsDown, FlaskConical, X, Waypoints, Loader2, Printer, Upload, RefreshCw, ShieldCheck, Plus,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import StepPath from "@/components/ui/StepPath";
import { Textarea } from "@/components/ui/Field";
import {
  referencedQuote, hasSource, parseAnswerBlocks, extractCitationNumbers, proofTerms, highlightQuote, splitVerdict, quoteWindow,
  structureAnswer, isMissingFact, extractAnswerMeta, type AnswerBlock, type Verdict,
} from "@/lib/knowledgeText";
import type { KnowledgeAnswer, KnowledgeCitation } from "@/lib/knowledge";
import GraphShapeWizard from "@/components/graph/GraphShapeWizard";
import { buildAnswerExport, printableDocument } from "@/lib/answerExport";
import { ANSWER_MODES } from "@/lib/answerModes";
import FormFillModal from "@/components/knowledge/answer/FormFillModal";
import { copyText } from "@/lib/clipboard";
import EquipmentTablePanel from "@/components/knowledge/EquipmentTablePanel";
import AnswerTestEditor from "@/components/knowledge/AnswerTestEditor";
import CandidateTablePanel from "@/components/knowledge/answer/CandidateTablePanel";
import { Modal, ModalHeader } from "@/components/ui/Modal";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { useDraft } from "@/hooks/useDraft";

export type DocLink = NonNullable<KnowledgeAnswer["mentionedDocs"]>[number];

// ── The look, in one place ────────────────────────────────────────────────
/** The small name of a group (13 px, muted, sentence case). */
const LABEL = "text-[13px] font-semibold text-[var(--color-text-muted)]";
/** The direct answer: the one big line, in the condensed display face. */
const HERO = "font-display text-[24px] sm:text-[30px] leading-[1.15] font-semibold text-[var(--color-text)]";
/** Body text of the answer. */
const BODY = "text-[15px] leading-relaxed text-[var(--color-text)]";
/** A secondary button: white, ruled, graphite text. */
const QUIET_CORE = "inline-flex items-center justify-center gap-1.5 border border-[var(--color-border-strong)] bg-[var(--color-surface)] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-text-faint)] disabled:opacity-40 transition-colors";
/** A quiet action (copy, open a page, ask again). */
const QUIET = `${QUIET_CORE} h-8 px-3 rounded-md text-[13px]`;
const QUIET_LG = `${QUIET_CORE} h-9 px-3.5 rounded-md text-[14px]`;
/** A dialog's one main action (the floating proof card). */
const ORANGE = "inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[14px] font-semibold hover:bg-[var(--color-accent-hover)] shadow-[0_1px_0_rgb(0_0_0/0.12)] disabled:opacity-40 transition-colors";
/** The step that moves the latest answer forward: still a secondary button
 *  (Send is the chat's one filled button), with a graphite edge. */
const NEXT = `${QUIET_LG} !border-[var(--color-text)]`;
const act = (primary: boolean) => (primary ? NEXT : QUIET_LG);
/** A link: signal-colored text, underlined on hover. */
const LINK = "inline-flex items-center gap-1 text-[14px] text-[var(--color-accent-text)] hover:underline";
/** A citation number, the same square everywhere it appears. */
const NUM = "min-w-[1.5rem] h-6 px-1 rounded border border-[var(--color-border-strong)] font-display tabular-nums text-[13px] font-semibold text-[var(--color-text)] grid place-items-center";

/** A short numbered list: the number in a narrow column, the text beside
 *  it. Reasons and conditions read top to bottom, no decoration. */
function PathList({ items }: { items: Array<{ key: React.Key; marker: React.ReactNode; body: React.ReactNode; style?: React.CSSProperties }> }) {
  return (
    <ol className="space-y-2">
      {items.map((it) => (
        <li key={it.key} style={it.style} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start">
          <span className="pt-[3px]">{it.marker}</span>
          {it.body}
        </li>
      ))}
    </ol>
  );
}

/** The number of an item on a PathList. */
function StepDot({ n }: { n: React.ReactNode }) {
  return (
    <span className="font-display tabular-nums text-[15px] leading-6 font-semibold text-[var(--color-text-muted)]">{n}.</span>
  );
}

/** A row whose state is on its left edge: a warning (held), a must-not-miss
 *  or a gap (overdue), a done thing (released). */
function EdgeRow({ tone, children, className = "", style }: {
  tone: "held" | "overdue" | "released"; children: React.ReactNode; className?: string; style?: React.CSSProperties;
}) {
  const bar = tone === "overdue" ? "bg-[var(--state-overdue)]" : tone === "released" ? "bg-[var(--state-released)]" : "bg-[var(--state-held)]";
  return (
    <div style={style} className={`relative pl-4 py-1 ${className}`}>
      <span aria-hidden className={`absolute left-0 inset-y-0 w-[3px] rounded-full ${bar}`} />
      {children}
    </div>
  );
}

const DocLinkContext = React.createContext<{ links: DocLink[]; open: ((d: DocLink) => void) | null }>({ links: [], open: null });

// ── Instant proof ───────────────────────────────────────────────────────────
//
// The verification moment, WHERE THE READER IS. Clicking a citation used to
// jump straight into the full page viewer — a context switch just to check
// one number. Now the first click opens a proof card floating at the
// citation: the exact quoted passage with the claim's own terms marked
// inside it (the at-a-glance evidence that the interpretation matches the
// source), and one tap from there opens the page with the passage
// highlighted for the deep check.
interface ProofState {
  citation: KnowledgeCitation;
  /** The claim text this citation backs — its terms get marked in the quote. */
  context: string;
  x: number;
  y: number;
  /** Anchor was low on screen — the card opens upward. */
  up: boolean;
}
const ProofContext = React.createContext<{
  show: ((c: KnowledgeCitation, context: string, anchor: DOMRect) => void) | null;
}>({ show: null });

const PROOF_W = 440;

/** The passage as proof: when the answer named the exact words that prove
 *  its claim, show THOSE words marked with a little context either side —
 *  not a 1,600-character wall. Older answers fall back to term marking. */
function ProofQuote({ c, context, className }: { c: KnowledgeCitation; context?: string; className: string }) {
  const win = c.highlight ? quoteWindow(c.quote ?? "", c.highlight) : null;
  const segs = useMemo(
    () => (win ? [] : highlightQuote(c.quote ?? "", context ? proofTerms(context) : [])),
    [win, c.quote, context],
  );
  if (!c.quote) {
    return (
      <p className="text-[12.5px] text-[var(--color-text-muted)]">
        The passage text wasn&apos;t stored for this answer. Open the page to read it in the document.
      </p>
    );
  }
  return (
    <blockquote className={className}>
      {win ? (
        <>
          <span className="text-[var(--color-text-muted)]">{win.clippedStart ? "… " : ""}{win.before}</span>
          <mark className="rounded px-0.5 bg-amber-200 dark:bg-amber-700/60 text-[var(--color-text)] font-semibold">{win.hit}</mark>
          <span className="text-[var(--color-text-muted)]">{win.after}{win.clippedEnd ? " …" : ""}</span>
        </>
      ) : segs.map((sg, i) => sg.hit
        ? <mark key={i} className="rounded px-0.5 bg-[var(--color-border)] dark:bg-[var(--color-surface-2)] text-inherit font-semibold">{sg.text}</mark>
        : <React.Fragment key={i}>{sg.text}</React.Fragment>)}
    </blockquote>
  );
}

// Status colors keep one meaning each: green done/fine, amber a condition
// or a wait, red a problem. "Not settled" is plain graphite.
const DOT_GOOD = "bg-[var(--state-released)]";
const DOT_WARN = "bg-[var(--state-held)]";
const DOT_BAD = "bg-[var(--state-overdue)]";
const DOT_PLAIN = "bg-[var(--color-text-faint)]";
const VERDICT_STYLE: Record<Verdict, { label: string; dot: string }> = {
  yes: { label: "Yes", dot: DOT_GOOD },
  conditional: { label: "Yes, with conditions", dot: DOT_WARN },
  no: { label: "No", dot: DOT_BAD },
  unsettled: { label: "Not settled", dot: DOT_PLAIN },
  complies: { label: "Complies", dot: DOT_GOOD },
  fails: { label: "Does not comply", dot: DOT_BAD },
  undetermined: { label: "Can't determine", dot: DOT_PLAIN },
};

/** A small, quiet status tag: an 8 px dot in the status color, the words in
 *  graphite. */
function StatusTag({ dot, children, title }: { dot: string; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)]">
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-hidden />{children}
    </span>
  );
}

/** The verdict as a tag — the yes/no lands before a single word is read. */
function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const v = VERDICT_STYLE[verdict];
  return (
    <span className="inline-flex items-center gap-2 text-[15px] font-semibold text-[var(--color-text)]">
      <span className={`w-2.5 h-2.5 rounded-full ${v.dot}`} aria-hidden />{v.label}
    </span>
  );
}

/** The answer line once its verdict word is split off starts mid-sentence
 *  ("test the line at…"): give it its capital back. */
const capFirst = (t: string) => t.replace(/^([^A-Za-z0-9]*)([a-z])/, (_, pre: string, ch: string) => pre + ch.toUpperCase());

/** The direct answer: its verdict, then the one big line. */
function DirectAnswer({ verdict, children }: { verdict: Verdict | null; children: React.ReactNode }) {
  return (
    <div>
      {verdict && <div className="mb-2"><VerdictBadge verdict={verdict} /></div>}
      <div className={HERO}>{children}</div>
    </div>
  );
}

function ProofCard({ proof, onClose, onOpenPage }: {
  proof: ProofState;
  onClose: () => void;
  onOpenPage: (c: KnowledgeCitation) => void;
}) {
  const { citation: c, context } = proof;
  // A past job (Ask's findings from close-out reviews): a project, not a page.
  const pastJob = !!c.url && c.url.startsWith("/");
  const hits = useMemo(
    () => c.highlight ? 0 : highlightQuote(c.quote ?? "", proofTerms(context)).filter((s) => s.hit).length,
    [c.highlight, c.quote, context],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Scrolling moves the anchor out from under a fixed card — close rather
    // than drift.
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);
  return (
    <>
      {/* Opened over the answer: what's behind dims a little. */}
      <div className="fixed inset-0 z-40 bg-[color-mix(in_srgb,var(--color-ink)_22%,transparent)]" onClick={onClose} />
      <div
        role="dialog" aria-label="Source proof"
        className="fixed z-50 animate-pop rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-2xl)] overflow-hidden"
        style={{ left: proof.x, width: Math.min(PROOF_W, typeof window !== "undefined" ? window.innerWidth - 24 : PROOF_W), ...(proof.up ? { bottom: proof.y } : { top: proof.y }) }}
      >
        <div className="px-4 pt-3 pb-4">
          <div className="flex items-center gap-2">
            <span className={`${LABEL} min-w-0 flex-1 truncate`}>
              {pastJob ? "Past job" : <>Page {c.page}{c.section ? ` · ${c.section.slice(0, 30)}` : ""}</>}
            </span>
            <button onClick={onClose} aria-label="Close"
              className="shrink-0 w-8 h-8 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="mt-1 font-display text-[18px] font-semibold leading-snug text-[var(--color-text)]">{(c.documentName ?? "Document").replace(/\.pdf$/i, "")}</div>
          {c.claim && (
            <div className="mt-0.5 text-[14px] text-[var(--color-text-muted)]">{c.claim}</div>
          )}
          <ProofQuote c={c} context={context}
            className="mt-2.5 border-l-2 border-[var(--color-border-strong)] pl-3 py-0.5 text-[14px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap max-h-52 overflow-y-auto" />
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            {pastJob ? (
              <a href={c.url} className={ORANGE}>
                <Eye className="w-4 h-4" /> Open the project
              </a>
            ) : (
              <button onClick={() => onOpenPage(c)} className={ORANGE}>
                <Eye className="w-4 h-4" /> Open the page, highlighted
              </button>
            )}
            {c.highlight ? (
              <StatusTag dot={DOT_GOOD}>Exact wording from the page</StatusTag>
            ) : hits > 0 && (
              <StatusTag dot={DOT_GOOD}>{hits} claim term{hits === 1 ? "" : "s"} found in this passage</StatusTag>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Inline renderer for answer text: **bold** spans, [n] markers as clickable
 *  citation badges, `values` as chips, and named documents as show-me
 *  buttons that open the document itself. */
export function InlineAnswer({ text, citations, onCite }: {
  text: string;
  citations: KnowledgeCitation[];
  onCite: (c: KnowledgeCitation) => void;
}) {
  const { links, open } = React.useContext(DocLinkContext);
  const { show: showProof } = React.useContext(ProofContext);
  // Longest mention first so "EP 5-5-1" never half-matches as "EP 5-5".
  const mentionAlt = links
    .map((d) => d.mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  // Bold may contain a lone "*" — standards mark Owner's-Engineer clauses
  // "(*)", and "**(*) Use in water service…**" used to print raw asterisks.
  // "(not from your library)" marks a statement no passage backs — it gets
  // its own tag so it can't pass for a cited fact.
  // A citation number never wraps onto a line of its own: the space before
  // it becomes a no-break space.
  const glued = text.replace(/[ \t]+(?=\[\d{1,3}\])/g, "\u00A0");
  const parts = glued.split(new RegExp(`(\\[\\d{1,3}\\]|\\(not from your library[^)]*\\)|\\*\\*(?:[^*]|\\*(?!\\*))+?\\*\\*|\`[^\`]+\`${mentionAlt ? `|${mentionAlt}` : ""})`, "gi"));
  // Adjacent markers ("[36][37][39]") read as one long number ("363739")
  // unless something separates them.
  const CITE_RE = /^\[(\d{1,3})\]$/;
  const followsCite = (i: number): boolean => {
    for (let j = i - 1; j >= 0; j--) if (parts[j] !== "") return CITE_RE.test(parts[j]);
    return false;
  };
  const linkFor = (s: string) => links.find((d) => d.mention === s);
  const docChip = (d: DocLink, label: string, key: number) => (
    <button key={key} onClick={() => open?.(d)} title={`Open ${d.name} · p.${d.page}`}
      className="inline-flex items-center gap-1 align-baseline mx-0.5 px-1.5 py-0.5 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-accent-text)] font-display font-semibold text-[0.92em] leading-none hover:bg-[var(--color-surface-2)] transition-colors cursor-pointer">
      <FileText className="w-3 h-3 shrink-0" />{label}
    </button>
  );
  return (
    <>
      {parts.map((part, i) => {
        const cite = part.match(CITE_RE);
        if (part === "") return null;
        const sep = cite && followsCite(i);
        const node = (() => {
        if (cite) {
          const c = citations.find((x) => x.n === Number(cite[1]));
          if (c && !c.url) {
            return (
              <button key={i}
                onClick={(e) => {
                  // First tap: the proof card, right here — evidence without
                  // the context switch. The full viewer is one tap further.
                  if (showProof) showProof(c, text, e.currentTarget.getBoundingClientRect());
                  else onCite(c);
                }}
                title={`${c.documentName ?? "Document"} · page ${c.page} - see the exact passage`}
                // Minimal superscript anchor, not a filled badge: a solid
                // chip on every line cluttered the reading flow (design
                // review). p-1.5/-m-1 keeps a real tap target.
                className="align-super font-display text-[12px] font-semibold text-[var(--color-accent-text)] underline decoration-dotted decoration-[var(--color-text-faint)] underline-offset-2 hover:decoration-solid hover:decoration-[var(--color-accent-text)] p-1.5 -m-1 cursor-pointer">
                {cite[1]}
              </button>
            );
          }
          if (c && c.url) {
            // A web source: jumps to its card in the proof column, where the
            // page's own quoted text and the link to it are.
            return (
              <button key={i} onClick={(e) => { if (showProof) showProof(c, text, e.currentTarget.getBoundingClientRect()); }}
                title={c.url.startsWith("/") ? `From a past job: ${c.title ?? ""}` : `From the web: ${c.title ?? c.url}`}
                className="align-super font-display text-[12px] font-semibold text-[var(--color-accent-text)] underline decoration-dotted decoration-[var(--color-text-faint)] underline-offset-2 hover:decoration-solid hover:decoration-[var(--color-accent-text)] p-1.5 -m-1 cursor-pointer">
                {cite[1]}
              </button>
            );
          }
          return <span key={i} className="align-super font-display text-[12px] font-semibold text-[var(--color-text)]">{cite[1]}</span>;
        }
        if (/^\(not from your library/i.test(part)) {
          return (
            <span key={i} title="General engineering knowledge or a code that isn't in this library - verify before relying on it"
              className="inline-block align-baseline mx-0.5 px-1.5 rounded border border-[var(--color-border)] text-[12px] font-semibold text-[var(--color-text-muted)] whitespace-nowrap">
              not from your library
            </span>
          );
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          // Recurse so a doc mention INSIDE a bold span still gets its chip —
          // the prompt bolds every identifier, so most mentions live here.
          return <b key={i} className="font-semibold"><InlineAnswer text={part.slice(2, -2)} citations={citations} onCite={onCite} /></b>;
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          const inner = part.slice(1, -1);
          const dl = open ? linkFor(inner) : undefined;
          if (dl) return docChip(dl, inner, i);
          // Value chip — exact values pop out, and TAP COPIES the value so a
          // field user grabs "250 ft-lb" without selecting a paragraph.
          return <CopyChip key={i} value={inner} />;
        }
        const dl = open ? linkFor(part) : undefined;
        if (dl) return docChip(dl, part, i);
        return <React.Fragment key={i}>{part}</React.Fragment>;
        })();
        return sep
          ? <React.Fragment key={i}><span className="align-super text-[12px] text-[var(--color-text-muted)]">,</span>{node}</React.Fragment>
          : node;
      })}
    </>
  );
}

/** The draw-your-eyes-here tier: imperatives, hold points, gaps. The
 *  warning sits on the line it is about, never in a box above. */
function ImportantCallout({ text, citations, onCite }: {
  text: string;
  citations: KnowledgeCitation[];
  onCite: (c: KnowledgeCitation) => void;
}) {
  return (
    <EdgeRow tone="held" className="flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 text-[var(--state-held)] mt-1 shrink-0" />
      <span className="text-[15px] font-semibold text-[var(--color-text)] leading-relaxed">
        <InlineAnswer text={text} citations={citations} onCite={onCite} />
      </span>
    </EdgeRow>
  );
}

/** A value chip you can TAKE with you: tap copies the exact value (torque,
 *  pressure, clause number) for field notes — no paragraph selection. */
function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title="Tap to copy"
      className={`mx-0.5 px-1.5 py-0.5 rounded border font-display tabular-nums font-semibold text-[0.98em] transition-colors cursor-pointer ${copied
        ? "bg-[var(--color-surface)] border-[var(--state-released)] text-[var(--state-released)]"
        : "bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-border-strong)]"}`}
    >
      {copied ? "Copied" : value}
    </button>
  );
}

/** Section titles that read as deep-reference material — these default
 *  COLLAPSED (everything else stays open, tap any header to toggle). */
const DEEP_SECTION = /further|ancillary|reference|missing|not retrieved|beyond|background/i;

/** One FACT presented like one: numbered, its sources right under it as
 *  quiet buttons (document · page → the page itself, passage marked). */
function FactCard({ n, text, citations, onCite }: {
  n: number;
  text: string;
  citations: KnowledgeCitation[];
  onCite: (c: KnowledgeCitation) => void;
}) {
  // This fact's own sources, deduped by document+page.
  const seen = new Set<string>();
  const sources: KnowledgeCitation[] = [];
  for (const num of extractCitationNumbers(text)) {
    const c = citations.find((x) => x.n === num && !x.url);
    if (!c) continue;
    const key = `${c.documentName ?? ""}:${c.page ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(c);
    if (sources.length >= 4) break;
  }
  return (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start py-1">
      <span className="font-display tabular-nums text-[15px] leading-relaxed font-semibold text-[var(--color-text-muted)]">
        {n}.
      </span>
      <div className="flex-1 min-w-0">
        <div className={BODY}>
          <InlineAnswer text={text} citations={citations} onCite={onCite} />
        </div>
        {sources.length > 0 && (
          <div className="mt-1 flex items-center gap-x-4 gap-y-1 flex-wrap">
            {/* These open the DOCUMENT ITSELF, at the cited page, passage
                highlighted — the real paper is the proof. The superscript
                anchors remain the quick in-place passage peek. */}
            {sources.map((c) => (
              <button key={c.n}
                onClick={() => onCite(c)}
                title={`Open ${c.documentName ?? "the document"} at page ${c.page} - passage highlighted`}
                className={`${LINK} !text-[13px]`}>
                <Eye className="w-3.5 h-3.5 shrink-0" />
                {(c.documentName ?? "Source").replace(/\.pdf$/i, "").slice(0, 32)}, p. {c.page}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Grouped, collapsible answer sections — the shared renderer for both the
 *  "More" area and the no-hero fallback. Each section is a numbered step on
 *  one line running down the left, so the answer reads as a route; facts
 *  are plain numbered rows; deep-reference sections start collapsed. */
function SectionedBlocks({ blocks, citations, onCite }: {
  blocks: AnswerBlock[];
  citations: KnowledgeCitation[];
  onCite: (c: KnowledgeCitation) => void;
}) {
  const sections = useMemo(() => {
    const out: Array<{ label: string | null; items: AnswerBlock[] }> = [];
    let cur: { label: string | null; items: AnswerBlock[] } = { label: null, items: [] };
    for (const b of blocks) {
      if (b.type === "label") {
        if (cur.label !== null || cur.items.length > 0) out.push(cur);
        cur = { label: b.text, items: [] };
      } else {
        cur.items.push(b);
      }
    }
    if (cur.label !== null || cur.items.length > 0) out.push(cur);
    // An empty labeled section gets NO step. Two ways one appears: a
    // super-heading like **Basis:** whose content all lives in the ###
    // sections right after it (those ARE the steps), and a section whose
    // only lines were `!` imperatives — hoisted above the stepper so they
    // are never hidden. Either way a numbered node with nothing under it
    // reads broken.
    return out.filter((sec) => sec.items.length > 0);
  }, [blocks]);
  const [closed, setClosed] = useState<Set<number>>(() => {
    const s = new Set<number>();
    sections.forEach((sec, i) => { if (sec.label && DEEP_SECTION.test(sec.label)) s.add(i); });
    return s;
  });
  const isCheck = (t: string) => /^\*{0,2}Check:?\*{0,2}/i.test(t);
  // Items rise in one after another (capped stagger) — the reveal itself
  // walks the reader down the step, both on load and on accordion open.
  const enter = (i: number): React.CSSProperties => ({
    animation: "rise 0.35s var(--ease-fluid) both",
    animationDelay: `${Math.min(i, 10) * 40}ms`,
  });
  const renderItems = (items: AnswerBlock[]) => {
    let n = 0;
    return items.map((b, i) => {
      if (b.type === "important") {
        return <div key={i} style={enter(i)}><ImportantCallout text={b.text} citations={citations} onCite={onCite} /></div>;
      }
      if (b.type === "bullet") {
        n += 1;
        return <div key={i} style={enter(i)}><FactCard n={n} text={b.text} citations={citations} onCite={onCite} /></div>;
      }
      if (isCheck(b.text)) {
        return (
          <EdgeRow key={i} tone="held" style={enter(i)} className="flex items-start gap-2 text-[15px] text-[var(--color-text)]">
            <AlertTriangle className="w-4 h-4 mt-1 shrink-0 text-[var(--state-held)]" />
            <span><InlineAnswer text={b.text.replace(/^\*{0,2}Check:?\*{0,2}\s*/i, "")} citations={citations} onCite={onCite} /></span>
          </EdgeRow>
        );
      }
      return (
        <p key={i} style={enter(i)} className={BODY}>
          <InlineAnswer text={b.text} citations={citations} onCite={onCite} />
        </p>
      );
    });
  };
  let step = 0;
  return (
    <div>
      {sections.map((sec, si) => {
        if (sec.label === null) {
          return <div key={si} className="space-y-1.5 pb-2">{renderItems(sec.items)}</div>;
        }
        step += 1;
        const facts = sec.items.filter((b) => b.type === "bullet").length;
        const open = !closed.has(si);
        return (
          <div
            key={si}
            style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(step - 1, 8) * 70}ms` }}
          >
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setClosed((prev) => {
                const next = new Set(prev);
                if (next.has(si)) next.delete(si); else next.add(si);
                return next;
              })}
              className="group/step w-full flex items-center gap-2 pt-3 pb-1.5 text-left border-t border-[var(--color-border)] first:border-t-0"
            >
              <ChevronDown className={`w-4 h-4 text-[var(--color-text-muted)] shrink-0 transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />
              <span className="font-display text-[17px] font-semibold leading-snug text-[var(--color-text)] group-hover/step:underline decoration-[var(--color-border-strong)]">{sec.label}</span>
              {facts > 0 && <span className="shrink-0 text-[13px] text-[var(--color-text-muted)] tabular-nums">{facts} {facts === 1 ? "fact" : "facts"}</span>}
            </button>
            <div className={`pl-6 ${open ? "pb-3" : "pb-2"}`}>
              {open ? (
                <div className="space-y-1">{renderItems(sec.items)}</div>
              ) : (
                <div className="text-[13px] text-[var(--color-text-muted)]">
                  {facts > 0 ? `${facts} ${facts === 1 ? "item" : "items"}, tap to open` : "Tap to open"}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Structured answer: the Answer line big, then the rest as steps on a
 *  line — never a wall of text. */
export function AnswerView({ answer, citations, onCite }: {
  answer: string;
  citations: KnowledgeCitation[];
  onCite: (c: KnowledgeCitation) => void;
}) {
  const blocks = parseAnswerBlocks(answer);
  const hero = blocks[0]?.type === "hero" ? blocks[0] : null;
  const rest = hero ? blocks.slice(1) : blocks;
  const heroV = hero ? splitVerdict(hero.text) : null;
  return (
    <div className="space-y-4">
      {hero && heroV && (
        <DirectAnswer verdict={heroV.verdict}>
          <InlineAnswer text={heroV.verdict ? capFirst(heroV.text) : heroV.text} citations={citations} onCite={onCite} />
        </DirectAnswer>
      )}
      <SectionedBlocks key={answer} blocks={rest} citations={citations} onCite={onCite} />
    </div>
  );
}

/** While the AI works, show WHAT it's doing — staged progress on one path
 *  beats a bare spinner. Stages advance on a timer that tracks the real
 *  pipeline order; the last stage holds until the answer lands. */
const ASK_STAGES = [
  "Writing search queries",
  "Searching the library",
  "Refining with different terms",
  "Reading the passages",
  "Composing the cited answer",
];

export function AskProgress() {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStage((s) => Math.min(s + 1, ASK_STAGES.length - 1)), 2600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mt-4 space-y-2.5 animate-rise" role="status" aria-live="polite">
      <StepPath steps={ASK_STAGES} current={stage} />
      <p className="max-sm:hidden flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text)]">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-text-muted)]" /> {ASK_STAGES[stage]}…
      </p>
    </div>
  );
}

/** A choice: a white secondary button; the picked one has a graphite edge
 *  and a light fill, never a solid block of color. */
const CHOICE = (on: boolean) => `h-8 px-3 rounded-md border text-[13px] font-semibold transition-colors ${on
  ? "border-[var(--color-text)] bg-[var(--color-surface-2)] text-[var(--color-text)]"
  : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`;

// Clarify round (opt-in library feature): the AI found the answer across
// several distinct aspects and asks WHICH before answering — select all that
// apply, or take everything. One round max: the re-ask always carries focus.
export function ClarifyCard({ prompt, options, onAnswer }: {
  prompt: string;
  options: string[];
  onAnswer: (focus: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (o: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(o)) next.delete(o); else next.add(o);
      return next;
    });
  };
  return (
    <EdgeRow tone="held" className="mt-2 space-y-3 animate-rise">
     <section className="space-y-3" aria-label="One thing before I answer">
      <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">One thing before I answer</div>
      <p className="font-display text-[19px] font-semibold leading-snug text-[var(--color-text)]">{prompt}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button key={o} type="button" onClick={() => toggle(o)} aria-pressed={selected.has(o)} className={CHOICE(selected.has(o))}>
            {o}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => onAnswer([...selected])} disabled={selected.size === 0} className={NEXT}>
          <Send className="w-4 h-4" /> Answer selected ({selected.size})
        </button>
        <button type="button" onClick={() => onAnswer(options)} className={QUIET_LG}>
          Answer all of it
        </button>
      </div>
     </section>
    </EdgeRow>
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
  // The typed values wait on this device until they're sent.
  const valueDraft = useDraft<string>(`need:${prompt.slice(0, 120)}`, value, setValue, (v) => !v.trim());
  const provide = (v: string) => { valueDraft.clear(); onProvide(v); };
  return (
    <EdgeRow tone="held" className="mt-2 animate-rise">
     <section className="space-y-3" aria-label="A value is needed">
      <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">I need a value from you to run this calculation</div>
      <p className="text-[15px] font-semibold leading-relaxed text-[var(--color-text)] whitespace-pre-wrap">{prompt}</p>
      <div className="flex items-end gap-2">
        <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={1}
          aria-label="The values"
          placeholder='e.g. "test temperature = 150°F, design pressure = 285 psig"'
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value.trim()) provide(value.trim());
          }}
          className="flex-1 text-[15px]" />
        <button type="button" onClick={() => provide(value.trim())} disabled={!value.trim()} className={NEXT}>
          <Send className="w-4 h-4" /> Calculate
        </button>
      </div>
     </section>
    </EdgeRow>
  );
}

export function CopyButton({ text, label, onDark, link }: { text: string; label: string; onDark?: boolean; /** Drawn as a link (in a source row). */ link?: boolean }) {
  const [copied, setCopied] = useState<boolean | "failed">(false);
  return (
    <button
      type="button"
      onClick={() => {
        void copyText(text).then((ok) => {
          setCopied(ok ? true : "failed");
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      title={label}
      className={onDark
        ? "inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-[13px] font-semibold text-[var(--color-ink-fg)] hover:bg-[var(--color-ink-line)] transition-colors"
        : link ? LINK : QUIET}>
      {copied === true ? <Check className="w-3.5 h-3.5 text-[var(--state-released)]" /> : <Copy className="w-3.5 h-3.5" />} {copied === true ? "Copied" : copied === "failed" ? "Copy blocked" : label}
    </button>
  );
}

/** One source = one quiet ROW. The answer above already synthesized this
 *  material — showing quote previews by default read as the same info twice.
 *  Collapsed: identifiers only. Expanded (one tap): the verbatim quote +
 *  the highlighted page. Evidence stays one gesture away without competing
 *  with the answer. */
export function SourceCard({ citation, onOpen, delay }: {
  citation: KnowledgeCitation;
  onOpen: (c: KnowledgeCitation) => void;
  delay: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const c = citation;
  return (
    <div className="border-b border-[var(--color-border)] animate-rise" style={{ animationDelay: `${delay}ms` }}>
      <button onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}
        className="w-full py-2.5 flex items-center gap-2.5 text-left">
        <span className={NUM}>{c.n}</span>
        <span className="font-display text-[16px] font-semibold text-[var(--color-text)] truncate min-w-0">
          {(c.documentName ?? "Document").replace(/\.pdf$/i, "")}
        </span>
        {c.tier && (
          <StatusTag dot={c.tier === "governing" ? DOT_GOOD : DOT_PLAIN}
            title={c.tier === "governing" ? "From the governing library - supersedes reference minimums" : "From a linked reference library"}>
            {c.tier === "governing" ? "Governing" : "Reference"}
          </StatusTag>
        )}
        <span className="shrink-0 font-display tabular-nums text-[14px] text-[var(--color-text-muted)]">p. {c.page}</span>
        <ChevronDown className={`ml-auto shrink-0 w-4 h-4 text-[var(--color-text-muted)] transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className="pb-3 pl-9 space-y-2 animate-rise">
          {c.section && <div className="text-[13px] text-[var(--color-text-muted)]">{c.section}</div>}
          <ProofQuote c={c}
            className="border-l-2 border-[var(--color-border-strong)] pl-3 py-0.5 text-[14px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap max-h-64 overflow-y-auto" />
          <div className="flex items-center gap-4 flex-wrap">
            <button onClick={() => onOpen(c)} className={LINK}>
              <ExternalLink className="w-3.5 h-3.5" /> View highlighted page
            </button>
            {c.quote && <CopyButton text={referencedQuote(c)} label="Copy quote" link />}
            {c.tier && c.libraryName && (
              <span className="ml-auto text-[13px] text-[var(--color-text-muted)]">{c.libraryName}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One piece of proof, as a quiet row: what it proves, where it lives, and
 *  (one tap) the exact words marked, with the page one tap further. A cite
 *  tap in the answer opens and lights up the matching row. */
function ProofItem({ c, onOpen, open, onToggle, flash, domId }: {
  c: KnowledgeCitation;
  onOpen: (c: KnowledgeCitation) => void;
  open: boolean;
  onToggle: () => void;
  flash: boolean;
  domId: string;
}) {
  const doc = (c.documentName ?? "Document").replace(/\.pdf$/i, "");
  return (
    // One source, one ruled row: the document (condensed type) and its
    // page, what it proves, and (open) the exact words.
    <li id={domId}
      className={`-mx-2 px-2 scroll-mt-24 transition-colors duration-500 ${flash ? "bg-[var(--color-accent-soft)]" : ""}`}>
      <button onClick={onToggle} aria-expanded={open}
        className="group w-full py-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 text-left">
        <span className={NUM}>{c.n}</span>
        <span className="min-w-0">
          <span className="flex items-baseline gap-3 min-w-0">
            <span className="min-w-0 flex-1 font-display text-[16px] font-semibold text-[var(--color-text)] leading-snug group-hover:underline decoration-[var(--color-border-strong)]">{doc}</span>
            <span className="shrink-0 font-display tabular-nums text-[14px] text-[var(--color-text-muted)]">p. {c.page}</span>
          </span>
          {c.claim && <span className="block mt-0.5 text-[14px] text-[var(--color-text-muted)] leading-snug">{c.claim}</span>}
        </span>
        <ChevronDown className={`mt-1 w-4 h-4 text-[var(--color-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="pb-3 pl-9 space-y-2">
          {c.section && <div className="text-[13px] text-[var(--color-text-muted)]">{c.section}</div>}
          <ProofQuote c={c}
            className="border-l-2 border-[var(--color-border-strong)] pl-3 py-0.5 text-[14px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap max-h-56 overflow-y-auto" />
          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap">
            <button onClick={() => onOpen(c)} className={LINK}>
              <Eye className="w-3.5 h-3.5" /> Open page {c.page}{c.highlight ? " at these words" : ""}
            </button>
            {(c.highlight || c.quote) && <CopyButton text={referencedQuote(c)} label="Copy quote" link />}
            {!c.highlight && c.quote && (
              <span className="text-[13px] text-[var(--color-text-muted)]">Whole passage, no exact words given</span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** The evidence trail, ranked by what each passage does for the answer:
 *  what decides it, what rules a restriction out or limits it, and the rest
 *  collapsed. Answers saved before evidence roles existed show one plain
 *  "Sources" group in the order the answer used them. */
function ProofTrail({ citations, onOpen, openSet, onToggle, onShowRelated, showRelated, flashN, idPrefix }: {
  citations: KnowledgeCitation[];
  onOpen: (c: KnowledgeCitation) => void;
  openSet: Set<number>;
  onToggle: (n: number) => void;
  showRelated: boolean;
  onShowRelated: (v: boolean) => void;
  flashN: number | null;
  idPrefix: string;
}) {
  const hasRoles = citations.some((c) => c.role);
  const decides = hasRoles ? citations.filter((c) => c.role === "decides") : [];
  const limits = hasRoles ? citations.filter((c) => c.role === "limits") : [];
  const related = hasRoles ? citations.filter((c) => c.role !== "decides" && c.role !== "limits") : [];
  const item = (c: KnowledgeCitation) => (
    <ProofItem key={c.n} c={c} onOpen={onOpen} open={openSet.has(c.n)} onToggle={() => onToggle(c.n)}
      flash={flashN === c.n} domId={`${idPrefix}-${c.n}`} />
  );
  const rows = (list: KnowledgeCitation[]) => (
    <ol className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">{list.map(item)}</ol>
  );
  const groupHead = (label: string, dot: string, count: number) => (
    <div className="flex items-center gap-2 pb-1.5">
      <span className={`w-2 h-2 rounded-full ${dot}`} aria-hidden />
      <span className={LABEL}>{label}</span>
      <span className="font-display tabular-nums text-[13px] text-[var(--color-text-muted)]">{count}</span>
    </div>
  );
  if (citations.length === 0) {
    return <p className="text-[14px] text-[var(--color-text-muted)]">No library passages were cited for this answer.</p>;
  }
  return (
    <div className="space-y-5">
      {!hasRoles && (
        <div>{groupHead("Sources", DOT_PLAIN, citations.length)}{rows(citations)}</div>
      )}
      {decides.length > 0 && (
        <div>{groupHead("Decides the answer", "bg-[var(--color-text)]", decides.length)}{rows(decides)}</div>
      )}
      {limits.length > 0 && (
        <div>{groupHead("Conditions and limits", DOT_WARN, limits.length)}{rows(limits)}</div>
      )}
      {related.length > 0 && (
        <div>
          <button onClick={() => onShowRelated(!showRelated)} aria-expanded={showRelated}
            className="w-full flex items-center gap-2 pb-2 text-left group">
            <span className="w-2 h-2 rounded-full border border-[var(--color-text-faint)]" aria-hidden />
            <span className={`${LABEL} min-w-0 truncate group-hover:text-[var(--color-text)]`}
              title={decides.length + limits.length > 0 ? "Related passages, not needed for the answer" : undefined}>
              {decides.length + limits.length > 0 ? "Related" : "Sources"}
            </span>
            <span className="font-display tabular-nums text-[13px] text-[var(--color-text-muted)]">{related.length}</span>
            <span className="ml-auto shrink-0 whitespace-nowrap inline-flex items-center gap-1 text-[13px] text-[var(--color-accent-text)] group-hover:underline">
              {showRelated ? "Hide" : `Show ${related.length}`}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showRelated ? "rotate-180" : ""}`} />
            </span>
          </button>
          {showRelated && rows(related)}
        </div>
      )}
    </div>
  );
}

/** "Answering for" — the AI's reading of the question, as chips. A dashed
 *  chip is an input the answer depends on that nobody gave. On the latest
 *  turn any chip can be corrected: the correction re-asks with it as a
 *  given, so the user fixes the reading instead of re-typing the question. */
function AnsweringFor({ chips, onCorrect }: { chips: string[]; onCorrect?: (value: string) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [value, setValue] = useState("");
  const start = (i: number) => {
    if (!onCorrect) return;
    setEditing(i);
    setValue(isMissingFact(chips[i]) ? chips[i].replace(/:\s*[^:]*$/, ": ") : chips[i]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[13px] text-[var(--color-text-muted)] mr-1">Answering for</span>
      {chips.map((chip, i) => editing === i ? (
        <form key={i} className="inline-flex items-center gap-1"
          onSubmit={(e) => { e.preventDefault(); if (value.trim()) { onCorrect?.(value.trim()); setEditing(null); } }}>
          <input id={`af-${i}`} autoFocus value={value} onChange={(e) => setValue(e.target.value)}
            aria-label="Correct this and ask again"
            onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }}
            className="h-8 text-[14px] px-2.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] w-52 focus:outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40" />
          <button type="submit" className={QUIET}>Ask again</button>
        </form>
      ) : (
        <button key={i} type="button" onClick={() => start(i)} disabled={!onCorrect}
          title={onCorrect ? (isMissingFact(chip) ? "Add this and ask again" : "Correct this and ask again") : undefined}
          className={`inline-flex items-center gap-1.5 h-8 text-[13px] px-2.5 rounded-md border transition-colors ${isMissingFact(chip)
            ? "border-dashed border-[var(--state-held)] bg-[var(--color-surface)] text-[var(--color-text)]"
            : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]"} ${onCorrect ? "hover:border-[var(--color-text-faint)] cursor-pointer" : "cursor-default"}`}>
          {isMissingFact(chip) && <span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-held)]" />}
          {chip}
          {onCorrect && (isMissingFact(chip) ? <Plus className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> : <PenLine className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />)}
        </button>
      ))}
    </div>
  );
}

/** The one question that would finish the answer — asked AFTER the answer,
 *  never instead of it. Tap an option or type a value; it re-asks with it. */
function OneQuestion({ followup, onAnswer, primary }: {
  followup: { question: string; options: string[] };
  onAnswer?: (value: string) => void;
  primary: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <EdgeRow tone="held">
     <section className="space-y-2.5">
      <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">One thing would finish this</div>
      <p className="font-display text-[18px] font-semibold leading-snug text-[var(--color-text)]">{followup.question}</p>
      {onAnswer && (
        <form className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); if (value.trim()) onAnswer(`${followup.question} → ${value.trim()}`); }}>
          {followup.options.map((o) => (
            <button key={o} type="button" onClick={() => onAnswer(`${followup.question} → ${o}`)} className={QUIET_LG}>
              {o}
            </button>
          ))}
          <input id="one-question" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Or type the answer"
            aria-label="Type the answer"
            className="h-9 text-[14px] px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] w-48 placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40" />
          <button type="submit" disabled={!value.trim()} className={act(primary)}>
            Finish the answer
          </button>
        </form>
      )}
     </section>
    </EdgeRow>
  );
}

/** The name of a part of the answer. */
function PartHead({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-2 font-display text-[17px] font-semibold text-[var(--color-text)]">{children}</h4>;
}

/** Copy (a menu: formatted for email or Word, plain text, Markdown for
 *  Teams or Slack, the answer alone, or the references alone) and Print
 *  (the same content on a clean page). The main button copies formatted. */
type CopyKind = "formatted" | "text" | "markdown" | "answer" | "references";
const COPY_OPTIONS: Array<{ kind: CopyKind; label: string; hint: string }> = [
  { kind: "formatted", label: "Formatted", hint: "Email, Word - looks like the card, proof included" },
  { kind: "text", label: "Plain text", hint: "The whole answer and its proof, no formatting" },
  { kind: "markdown", label: "Markdown", hint: "Teams, Slack, notes, tickets" },
  { kind: "answer", label: "Answer only", hint: "The answer line - no proof" },
  { kind: "references", label: "References only", hint: "Each cited document, page and quote" },
];

function ExportButtons({ question, answer }: { question: string; answer: KnowledgeAnswer }) {
  const [state, setState] = useState<{ s: "idle" | "copied" | "failed"; label?: string }>({ s: "idle" });
  const [menu, setMenu] = useState(false);
  const flash = (s: "copied" | "failed", label?: string) => { setState({ s, label }); setTimeout(() => setState({ s: "idle" }), 1800); };
  const copy = async (kind: CopyKind) => {
    setMenu(false);
    const exp = buildAnswerExport(question, answer);
    const label = COPY_OPTIONS.find((o) => o.kind === kind)!.label;
    if (kind === "formatted") {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([exp.html], { type: "text/html" }),
          "text/plain": new Blob([exp.text], { type: "text/plain" }),
        })]);
        flash("copied", label);
      } catch {
        // A browser that won't take formatted copy still gets the text.
        flash((await copyText(exp.text)) ? "copied" : "failed", "Plain text");
      }
      return;
    }
    const body = kind === "text" ? exp.text : kind === "markdown" ? exp.markdown : kind === "answer" ? exp.answerOnly : exp.references;
    flash((await copyText(body)) ? "copied" : "failed", label);
  };
  const print = () => {
    const w = window.open("", "_blank");
    if (!w) { flash("failed"); return; }
    w.document.write(printableDocument(question, buildAnswerExport(question, answer)));
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  };
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <div className="relative inline-flex">
        <button type="button" onClick={() => void copy("formatted")} className={`${QUIET_CORE} h-8 px-3 text-[13px] rounded-l-md`}
          title="Copy the answer and its proof, formatted - pastes into email or Word looking like the card">
          {state.s === "copied" ? <Check className="w-3.5 h-3.5 text-[var(--state-released)]" /> : <Copy className="w-3.5 h-3.5" />}
          {state.s === "copied" ? `Copied: ${state.label}` : state.s === "failed" ? "Copy blocked" : "Copy"}
        </button>
        <button type="button" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu} title="Other ways to copy" aria-label="Other ways to copy"
          className={`${QUIET_CORE} h-8 px-1.5 rounded-r-md border-l-0`}>
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
            <div role="menu" className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg bg-[var(--color-surface)] shadow-2xl ring-1 ring-[var(--color-border-strong)] py-1">
              {COPY_OPTIONS.map((o) => (
                <button key={o.kind} role="menuitem" type="button" onClick={() => void copy(o.kind)}
                  className="w-full text-left px-3 py-2 hover:bg-[var(--color-surface-2)]">
                  <div className="text-[14px] font-semibold text-[var(--color-text)]">{o.label}</div>
                  <div className="text-[12px] text-[var(--color-text-muted)]">{o.hint}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <button type="button" onClick={print} className={QUIET} title="Print, or choose Save as PDF in the print dialog">
        <Printer className="w-3.5 h-3.5" /> <span>Print<span className="max-sm:hidden"> / save PDF</span></span>
      </button>
    </div>
  );
}

/** What "I can settle this if you give me" asks for, and the best answer
 *  meanwhile. An item with no words (a stray "*" left when an ask for a
 *  document the library holds was removed) is not something to ask for. */
function settleParts(items: AnswerBlock[]) {
  const best = items.filter((b) => /^\*{0,2}best answer/i.test(b.text));
  const needs = items.filter((b) => b.type !== "label" && !best.includes(b) && b.text.replace(/[*_\s:—–-]/g, "").length > 0);
  return { best, needs };
}

/** "I can settle this if you give me…" — what's missing, why, where the
 *  standards point to it, and a place to drop it. Dropped files ride with
 *  the next question; Rethink re-asks with them. */
function SettleBox({ items, inline, onAttach, onRethink, primary }: {
  items: AnswerBlock[];
  inline: (text: string) => React.ReactNode;
  onAttach?: (files: File[]) => void;
  onRethink?: () => void;
  primary: boolean;
}) {
  const [added, setAdded] = useState<File[]>([]);
  const pick = React.useRef<HTMLInputElement>(null);
  const take = (list: FileList | File[] | null) => {
    const files = list ? [...list] : [];
    if (files.length === 0 || !onAttach) return;
    onAttach(files);
    setAdded((a) => [...a, ...files]);
  };
  const drag = useFileDrag((fs) => take(fs), !onAttach);
  const { best, needs } = settleParts(items);
  if (needs.length === 0 && best.length === 0) return null;
  return (
    <section className="space-y-3">
      {needs.length > 0 && (
        // What's missing, as a warning row: amber on its edge.
        <EdgeRow tone="held" className="space-y-1.5">
          <h4 className="font-display text-[17px] font-semibold text-[var(--color-text)]">I can settle this if you give me</h4>
          <ol className="space-y-1">
            {needs.map((b, i) => (
              <li key={i} className={`grid grid-cols-[1.75rem_minmax(0,1fr)] items-start ${BODY}`}>
                <span className="font-display tabular-nums font-semibold text-[var(--color-text-muted)]">{i + 1}.</span>
                <span>{inline(b.text)}</span>
              </li>
            ))}
          </ol>
        </EdgeRow>
      )}
      {best.map((b, i) => (
        <div key={i} className="text-[15px] leading-relaxed text-[var(--color-text-muted)]">{inline(b.text)}</div>
      ))}
      {onAttach && (
        <div
          {...drag.bind}
          onClick={() => pick.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick.current?.click(); } }}
          role="button" tabIndex={0}
          className={`rounded-lg border-2 border-dashed px-3 py-3.5 text-center cursor-pointer transition-colors border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] ${drag.ring}`}>
          <input ref={pick} id="settle-drop" type="file" multiple hidden
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
            onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
          <div className="text-[14px] font-semibold text-[var(--color-text)] inline-flex items-center gap-1.5">
            <Upload className="w-4 h-4 text-[var(--color-text-muted)]" /> {drag.over ? drag.say : "Drop the document here, or a photo of the page"}
          </div>
          <div className="text-[13px] text-[var(--color-text-muted)]">
            {added.length > 0 ? "Added below. It goes with the next ask." : "PDF or image, read for this question, not added to the library"}
          </div>
        </div>
      )}
      {added.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {added.map((f, i) => (
            <li key={`${f.name}-${i}`} className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] pl-1 pr-2 py-1 text-[13px] font-semibold text-[var(--color-text)] max-w-[260px]">
              <FileThumb file={f} size={32} />
              <span className="min-w-0 flex flex-col leading-tight"><span className="truncate">{f.name}</span><span className="font-normal text-[12px] text-[var(--color-text-muted)]">{f.size >= 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`}</span></span>
            </li>
          ))}
        </ul>
      )}
      {onRethink && (
        <button type="button" onClick={onRethink} className={act(primary)}>
          <RefreshCw className="w-4 h-4" /> {added.length > 0 ? "Ask again with what I added" : "Ask again"}
        </button>
      )}
    </section>
  );
}

const MODES = ANSWER_MODES;

const GOAL_LABEL: Record<string, string> = {
  deviation: "a deviation from the standard",
  compliance: "a compliance check",
  ncr: "a nonconformance report",
  tq: "a technical query",
  moc: "a management of change",
  inspection: "an inspection",
  test: "a test",
  design: "a design decision",
  troubleshoot: "troubleshooting a problem",
  learn: "understanding why the rule exists",
};

const DOC_TYPE_WORD: Record<string, string> = {
  form: "Form", checklist: "Checklist", catalog: "Catalog", standard: "Standard",
  procedure: "Procedure", std_drawing: "Standard drawing", pid: "Drawing", datasheet: "Data sheet", other: "Document",
};

/** The next answer shape that fits where the conversation is heading. */
function helperStep(answer: KnowledgeAnswer, mode: string) {
  const goal = answer.goal;
  return goal?.kind === "deviation" && mode !== "deviation" ? { m: "deviation" as const, label: "Work up the deviation case" }
    : goal?.kind === "compliance" && mode !== "compliance" ? { m: "compliance" as const, label: "Run it as a compliance check" }
    : null;
}

/** The helper: where the conversation seems to be heading, the next step
 *  that fits, and the library documents to use for it — forms to fill,
 *  checklists to open. Offered, never assumed. */
function HelperBand({ answer, mode, onRethink, onOpenDoc, onFill, primary }: {
  answer: KnowledgeAnswer;
  mode: string;
  onRethink?: (m: "answer" | "compliance" | "explore" | "deviation") => void;
  onOpenDoc?: (d: DocLink) => void;
  onFill: (doc: NonNullable<KnowledgeAnswer["suggestedDocs"]>[number]) => void;
  /** Which of its actions is the answer's one orange, if any. */
  primary: "step" | "fill" | null;
}) {
  const goal = answer.goal;
  const docs = answer.suggestedDocs ?? [];
  const step = helperStep(answer, mode);
  const firstForm = docs.find((d) => d.form)?.documentId;
  if (!goal && docs.length === 0) return null;
  return (
    <section className="space-y-3">
      <PartHead>{goal ? "Next step" : "From your library"}</PartHead>
      {goal && (
        <p className={BODY}>
          Looks like you&apos;re working toward <b className="font-semibold">{GOAL_LABEL[goal.kind] ?? goal.kind}</b>{goal.why ? <>: {goal.why}</> : null}.
        </p>
      )}
      {step && onRethink && (
        <button type="button" onClick={() => onRethink(step.m)} className={act(primary === "step")}>
          <RefreshCw className="w-4 h-4" /> {step.label}
        </button>
      )}
      {docs.length > 0 && (
        <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {docs.map((d) => (
            <li key={d.documentId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
              <FileText className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
              <span className="min-w-0 flex-1 basis-48">
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="min-w-0 truncate font-display text-[16px] font-semibold text-[var(--color-text)]">{d.name.replace(/\.pdf$/i, "")}</span>
                  <span className="shrink-0 text-[13px] text-[var(--color-text-muted)]">{DOC_TYPE_WORD[d.type] ?? "Document"}</span>
                </span>
                {d.why && <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{d.why}</span>}
              </span>
              <span className="flex items-center gap-1.5 shrink-0">
                {d.form && (
                  <button type="button" onClick={() => onFill(d)} className={act(primary === "fill" && d.documentId === firstForm)}>
                    <PenLine className="w-4 h-4" /> Fill it in
                  </button>
                )}
                {d.fileKey && onOpenDoc && (
                  <button type="button" onClick={() => onOpenDoc({ id: d.documentId, name: d.name, fileKey: d.fileKey!, page: 1, mention: d.name })} className={QUIET_LG}>
                    <Eye className="w-4 h-4" /> Open
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Under every answer: reshape it if it isn't what was needed. */
function RethinkBar({ mode, onRethink }: { mode: string; onRethink: (m: "answer" | "compliance" | "explore" | "deviation") => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[13px] text-[var(--color-text-muted)] mr-1">Not what you needed? Ask again as</span>
      {MODES.map((m) => (
        <button key={m.id} type="button" onClick={() => onRethink(m.id)} title={m.hint} aria-pressed={mode === m.id}
          className={`inline-flex items-center gap-1 ${CHOICE(mode === m.id)}`}>
          {mode === m.id && <Check className="w-3.5 h-3.5" />}{m.label}
        </button>
      ))}
    </div>
  );
}

/** The full answer, laid out like a document: what kind of answer it is,
 *  the verdict and the direct answer in one big line, the short chain of
 *  why as one connected path, what to check before acting, the one
 *  question that would finish it, and everything else folded — with the
 *  ranked sources beside it (below it on narrow screens). A cite tap jumps
 *  to its source row instead of opening a floating popup. */
export function AnswerExperience({ question, answer, onCite, onOpenTag, onOpenDoc, onFollowup, onRethink, onAttach, showQuestion = true, latest = false }: {
  question: string;
  answer: KnowledgeAnswer;
  /** The chat shell shows the question as its own bubble — no echo there. */
  showQuestion?: boolean;
  /** The newest answer in the conversation: it alone may carry the one
   *  orange step forward. Older answers keep every action, all quiet. */
  latest?: boolean;
  onCite: (c: KnowledgeCitation) => void;
  /** Open a sheet in the viewer with a tag ringed (equipment table rows). */
  onOpenTag?: (documentId: string, page: number, tag: string, documentName: string) => void;
  /** Open a document the answer names (show-me chips). */
  onOpenDoc?: (d: DocLink) => void;
  /** Latest turn only: re-ask this question with a value the user supplied
   *  (a corrected chip or the answer to the one question). */
  onFollowup?: (value: string) => void;
  /** Re-ask this question, optionally reshaped as another answer mode. */
  onRethink?: (mode?: "answer" | "compliance" | "explore" | "deviation") => void;
  /** Add files to the next question (the "settle this" drop zone). */
  onAttach?: (files: File[]) => void;
}) {
  const mode = answer.answerMode ?? "answer";
  const [filling, setFilling] = useState<NonNullable<KnowledgeAnswer["suggestedDocs"]>[number] | null>(null);
  const parts = useMemo(() => structureAnswer(parseAnswerBlocks(answer.answer), answer.answerMode ?? null), [answer.answer, answer.answerMode]);
  const heroV = parts.hero !== null ? splitVerdict(parts.hero) : null;
  const docLinkCtx = useMemo(
    () => ({ links: answer.mentionedDocs ?? [], open: onOpenDoc ?? null }),
    [answer.mentionedDocs, onOpenDoc],
  );
  // Shaping the graph is ADMIN curation of the shared map — the entry point
  // only exists for Admin/DocCtrl, and the server enforces the same gate.
  const { activeOrgId: shapeOrgId, activeRole: shapeRole, uid: shapeUid, userEmail: shapeUserEmail } = useRole();
  const canShape = shapeRole === "Admin" || shapeRole === "DocCtrl";
  const [shaping, setShaping] = useState(false);
  const [proof, setProof] = useState<ProofState | null>(null);
  const libraryCitations = useMemo(() => answer.citations.filter((c) => !c.url), [answer.citations]);
  // A link inside the app ("/projects/…") is a past job (findings kept at a
  // close-out review), not a web page.
  const webCitations = useMemo(() => answer.citations.filter((c) => !!c.url && !c.url.startsWith("/") && answer.knowledgeSource === "documents_and_web"), [answer.citations, answer.knowledgeSource]);
  const jobCitations = useMemo(() => answer.citations.filter((c) => !!c.url && c.url.startsWith("/")), [answer.citations]);
  const hasRoles = libraryCitations.some((c) => c.role);

  // ── The proof trail's state lives here so a cite tap can drive it ──
  const idPrefix = `proof-${(answer.questionId ?? question).replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "a"}`;
  const [openSet, setOpenSet] = useState<Set<number>>(() => {
    const s = new Set<number>();
    const lead = hasRoles
      ? [...libraryCitations.filter((c) => c.role === "decides").slice(0, 3), ...libraryCitations.filter((c) => c.role === "limits").slice(0, 2)]
      : libraryCitations.slice(0, 2);
    for (const c of lead) s.add(c.n);
    return s;
  });
  const [showRelated, setShowRelated] = useState(false);
  const [flashN, setFlashN] = useState<number | null>(null);
  const toggle = (n: number) => setOpenSet((prev) => {
    const next = new Set(prev);
    if (next.has(n)) next.delete(n); else next.add(n);
    return next;
  });
  useEffect(() => {
    if (flashN === null) return;
    const t = setTimeout(() => setFlashN(null), 1600);
    return () => clearTimeout(t);
  }, [flashN]);

  const proofCtx = {
    show: (c: KnowledgeCitation, context: string, anchor: DOMRect) => {
      // A cited library passage: open its proof row in the trail and bring
      // it into view. Anything else gets the floating proof card.
      if (!c.url && libraryCitations.some((x) => x.n === c.n)) {
        setOpenSet((prev) => new Set(prev).add(c.n));
        if (hasRoles && c.role !== "decides" && c.role !== "limits") setShowRelated(true);
        setFlashN(c.n);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          document.getElementById(`${idPrefix}-${c.n}`)?.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            block: "center",
          });
        }));
        return;
      }
      if (c.url && webCitations.some((x) => x.n === c.n)) {
        setFlashN(c.n);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          document.getElementById(`${idPrefix}-w-${c.n}`)?.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            block: "center",
          });
        }));
        return;
      }
      const w = Math.min(PROOF_W, window.innerWidth - 24);
      const up = anchor.bottom > window.innerHeight - 340;
      setProof({
        citation: c,
        context,
        x: Math.min(Math.max(12, anchor.left), window.innerWidth - w - 12),
        y: up ? window.innerHeight - anchor.top + 8 : anchor.bottom + 8,
        up,
      });
    },
  };

  const inline = (text: string) => <InlineAnswer text={text} citations={answer.citations} onCite={onCite} />;
  // Provenance you can see: a claim with no citation — and not something
  // the user told it — is tagged, so nothing unsourced passes for fact.
  const sourced = (text: string) => (
    <>
      {inline(text)}
      {!hasSource(text) && (
        <span title="No citation - this line isn't tied to a page in your documents. Don't rely on it without checking."
          className="ml-2 inline-flex items-center gap-1 align-baseline text-[12px] font-semibold text-[var(--state-overdue)] whitespace-nowrap">
          <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-[var(--state-overdue)]" />No source
        </span>
      )}
    </>
  );
  // Why: a short numbered list; headings become small group labels.
  const renderWhy = (blocks: AnswerBlock[]) => {
    let n = 0;
    return (
      <PathList items={blocks.map((b, i) => {
        if (b.type === "label") {
          return { key: i, marker: null, body: <div className="pt-1 text-[13px] font-semibold text-[var(--color-text-muted)]">{b.text}</div> };
        }
        if (b.type === "bullet") {
          n += 1;
          return { key: i, marker: <StepDot n={n} />, body: <div className={BODY}>{sourced(b.text)}</div> };
        }
        return { key: i, marker: null, body: <p className={BODY}>{sourced(b.text)}</p> };
      })} />
    );
  };
  // Before you act: the conditions as a numbered list; "!" lines are the
  // MUSTs, rows with an amber edge.
  const renderBefore = (blocks: AnswerBlock[]) => {
    let n = 0;
    return blocks.map((b, i) => {
      if (b.type === "label") {
        return <div key={i} className="pt-1 text-[13px] font-semibold text-[var(--color-text-muted)]">{b.text}</div>;
      }
      if (b.type === "important") {
        return (
          <EdgeRow key={i} tone="held" className="flex items-start gap-2">
            <AlertTriangle className="mt-1 w-4 h-4 shrink-0 text-[var(--state-held)]" />
            <div className="text-[15px] font-semibold leading-relaxed text-[var(--color-text)]">{sourced(b.text)}</div>
          </EdgeRow>
        );
      }
      n += 1;
      return (
        <div key={i} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start">
          <StepDot n={n} />
          <div className={BODY}>{sourced(b.text)}</div>
        </div>
      );
    });
  };

  // The one orange: the step that moves this answer forward, and only on
  // the latest answer. Everything else stays quiet.
  const settle = heroV ? settleParts(parts.settle) : { best: [], needs: [] };
  const step = helperStep(answer, mode);
  const hasForm = (answer.suggestedDocs ?? []).some((d) => d.form);
  const primary: "followup" | "settle" | "step" | "fill" | null = !latest ? null
    : answer.followup && onFollowup ? "followup"
    : settle.needs.length + settle.best.length > 0 && onRethink ? "settle"
    : step && onRethink ? "step"
    : hasForm && shapeOrgId ? "fill"
    : null;

  return (
    <DocLinkContext.Provider value={docLinkCtx}>
    <ProofContext.Provider value={proofCtx}>
    {proof && (
      <ProofCard
        proof={proof}
        onClose={() => setProof(null)}
        onOpenPage={(c) => { setProof(null); onCite(c); }}
      />
    )}
    {filling && shapeOrgId && (
      <FormFillModal orgId={shapeOrgId} documentId={filling.documentId} formName={filling.name}
        question={question} answer={answer.answer} citations={answer.citations}
        goal={answer.goal ? `${answer.goal.kind}${answer.goal.why ? ` - ${answer.goal.why}` : ""}` : undefined}
        onClose={() => setFilling(null)} />
    )}
    {shaping && shapeOrgId && shapeUid && (
      <GraphShapeWizard
        orgId={shapeOrgId}
        userId={shapeUid}
        userName={shapeUserEmail ?? undefined}
        question={question}
        answer={answer.answer}
        citedKnowledgeDocIds={answer.citations.filter((c) => !c.url && c.documentId).map((c) => c.documentId!)}
        onClose={() => setShaping(false)}
      />
    )}
    <div className={`${showQuestion ? "mt-4" : ""} space-y-6 @container`}>
      {showQuestion && (
        <div className="text-[14px] text-[var(--color-text-muted)] animate-rise">
          You asked: <i>&ldquo;{question}&rdquo;</i>
        </div>
      )}

      {/* A REPLAYED answer must never pass for a fresh run. */}
      {answer.provider === "memory" && (
        <p className="flex items-start gap-2 text-[14px] leading-relaxed text-[var(--color-text-muted)]">
          <History className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            <span className="font-semibold text-[var(--color-text)]">Replayed from your team&apos;s record.</span> No new AI run; ask the question fresh for one.
          </span>
        </p>
      )}

      <article className="grid @min-[760px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] animate-rise">
        {/* ── The answer column ── */}
        <div className="min-w-0 space-y-6 @min-[760px]:pr-8">
          {/* What kind of answer this is and what it drew on, and the
              quiet ways to take it with you. */}
          <div className="flex items-center justify-between gap-x-3 gap-y-2 flex-wrap">
            <span className="inline-flex items-center gap-x-3 gap-y-1 flex-wrap min-w-0">
              <span className={LABEL}>{MODES.find((m) => m.id === mode)?.label ?? "Direct answer"}</span>
              {/* What this answer was allowed to draw on — visible, not assumed. */}
              {answer.knowledgeSource === "documents" && (
                <span title="Every statement is cited to a page in this library, or is something you said - no AI training knowledge, no web"
                  className="inline-flex items-center gap-1 text-[13px] text-[var(--color-text-muted)]">
                  <ShieldCheck className="w-3.5 h-3.5" /> Documents only
                </span>
              )}
              {answer.knowledgeSource === "documents_and_web" && (
                <span title="Web was on for this question: documents first and they govern; every web statement links to the page it came from"
                  className="inline-flex items-center gap-1 text-[13px] text-[var(--color-text-muted)]">
                  <Globe className="w-3.5 h-3.5" /> Documents and web{webCitations.length > 0 ? `, ${webCitations.length} web source${webCitations.length === 1 ? "" : "s"}` : ", web not needed"}
                </span>
              )}
              {/* The Reasoning Skills this question fit — so their help is
                  seen, and the Skill Library is one tap away. */}
              {(answer.skillsApplied ?? []).map((sk) => (
                <a key={sk.id || sk.name} href="/intelligence/skills" title="A Reasoning Skill shaped this answer - open the Skill Library to see or change it"
                  className={`${LINK} !text-[13px]`}>
                  <Sparkles className="w-3.5 h-3.5" /> {sk.name}
                </a>
              ))}
            </span>
            <ExportButtons question={question} answer={answer} />
          </div>

          {/* The answer first, in the biggest type on the page. */}
          {heroV ? (
            <DirectAnswer verdict={heroV.verdict}>{inline(heroV.verdict ? capFirst(heroV.text) : heroV.text)}</DirectAnswer>
          ) : (
            <AnswerView answer={answer.answer} citations={answer.citations} onCite={onCite} />
          )}

          {(answer.answeringFor ?? []).length > 0 && (
            <AnsweringFor chips={answer.answeringFor!} onCorrect={onFollowup} />
          )}

          {heroV && parts.settle.length > 0 && (
            <SettleBox items={parts.settle} inline={inline} onAttach={onAttach}
              onRethink={onRethink ? () => onRethink(mode) : undefined} primary={primary === "settle"} />
          )}

          {heroV && parts.why.length > 0 && (
            <section>
              <PartHead>{mode === "compliance" ? "Findings" : "Why"}</PartHead>
              {renderWhy(parts.why)}
            </section>
          )}

          {heroV && parts.trail.length > 0 && (
            <details className="group border-y border-[var(--color-border)] py-3">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-center gap-2 text-[15px] font-semibold text-[var(--color-text)] hover:underline">
                <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] transition-transform group-open:rotate-90" />
                Engineering trail, step by step
                <span className="ml-auto text-[13px] font-normal text-[var(--color-text-muted)] tabular-nums">{parts.trail.filter((b) => b.type !== "label").length} steps</span>
              </summary>
              <div className="mt-3">{renderWhy(parts.trail)}</div>
            </details>
          )}

          {heroV && parts.before.length > 0 && (
            <section>
              <PartHead>{mode === "compliance" ? "Required corrections" : "Before you act"}</PartHead>
              <div className="space-y-2">{renderBefore(parts.before)}</div>
            </section>
          )}

          {heroV && parts.dontMiss.length > 0 && (
            <section>
              <PartHead>Don&apos;t miss</PartHead>
              <div className="space-y-2">
                {parts.dontMiss.filter((b) => b.type !== "label").map((b, i) => (
                  <EdgeRow key={i} tone="overdue" className="flex items-start gap-2">
                    <AlertTriangle className="mt-1 w-4 h-4 shrink-0 text-[var(--state-overdue)]" />
                    <div className={`${BODY} font-semibold`}>{sourced(b.text)}</div>
                  </EdgeRow>
                ))}
              </div>
            </section>
          )}

          {answer.followup && (
            <OneQuestion followup={answer.followup} onAnswer={onFollowup} primary={primary === "followup"} />
          )}

          <HelperBand answer={answer} mode={mode} onRethink={onRethink} onOpenDoc={onOpenDoc} onFill={setFilling}
            primary={primary === "step" || primary === "fill" ? primary : null} />

          {heroV && parts.more.length > 0 && (
            <details className="group border-t border-[var(--color-border)] pt-3">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-center gap-2 text-[15px] font-semibold text-[var(--color-text)] hover:underline">
                <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] transition-transform group-open:rotate-90" />
                More: related rules, drafts, what would go further
              </summary>
              <div className="mt-2">
                <SectionedBlocks key={answer.answer} blocks={parts.more} citations={answer.citations} onCite={onCite} />
              </div>
            </details>
          )}

          <div className="pt-4 border-t border-[var(--color-border)] space-y-3">
            {onRethink && answer.mode !== "internet" && <RethinkBar mode={mode} onRethink={onRethink} />}
            <div className="flex items-center gap-x-4 gap-y-2 flex-wrap text-[13px] text-[var(--color-text-muted)]">
              {canShape && shapeOrgId && shapeUid && (
                <button onClick={() => setShaping(true)}
                  title="AI proposes how this answer attributes to the org graph - you curate, it writes"
                  className={QUIET}>
                  <Waypoints className="w-3.5 h-3.5" /> Shape the graph
                </button>
              )}
              <span className="ml-auto tabular-nums">{libraryCitations.length} source{libraryCitations.length === 1 ? "" : "s"}</span>
              {answer.model && <span title={answer.provider}>Model {answer.model}</span>}
              {/* Version beacon: which renderer produced this card. */}
              <span className="text-[var(--color-text-faint)]" title="Answer renderer version">fmt16</span>
            </div>
          </div>
        </div>

        {/* ── The sources: quiet rows, beside the answer (below on a phone) ── */}
        <aside aria-label="Sources"
          className="min-w-0 mt-8 pt-6 border-t border-[var(--color-border)] @min-[760px]:mt-0 @min-[760px]:pt-0 @min-[760px]:border-t-0 @min-[760px]:pl-8 @min-[760px]:border-l">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h3 className="font-display text-[19px] font-semibold text-[var(--color-text)]">Sources</h3>
            <span className="text-[13px] text-[var(--color-text-muted)] text-right">Tap a number in the answer to jump here</span>
          </div>
          <ProofTrail citations={libraryCitations} onOpen={onCite} openSet={openSet} onToggle={toggle}
            showRelated={showRelated} onShowRelated={setShowRelated} flashN={flashN} idPrefix={idPrefix} />
          {webCitations.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center gap-2 pb-1">
                <Globe className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                <span className={LABEL}>From the web</span>
                <span className="font-display tabular-nums text-[13px] text-[var(--color-text-muted)]">{webCitations.length}</span>
              </div>
              <p className="pb-2 text-[13px] text-[var(--color-text-muted)]">
                Not your controlled documents: check it against the publication.
              </p>
              <ol className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
                {webCitations.map((c) => {
                  let host = c.url ?? "";
                  try { host = new URL(c.url ?? "").hostname.replace(/^www\./, ""); } catch { /* keep */ }
                  return (
                    <li key={c.n} id={`${idPrefix}-w-${c.n}`}
                      className={`-mx-2 px-2 py-2.5 space-y-2 scroll-mt-24 transition-colors duration-500 ${flashN === c.n ? "bg-[var(--color-accent-soft)]" : ""}`}>
                      <div className="flex items-start gap-3">
                        <span className={NUM}>{c.n}</span>
                        <span className="min-w-0">
                          <span className="block font-display text-[16px] font-semibold text-[var(--color-text)] leading-snug">{c.title ?? host}</span>
                          <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{host}</span>
                        </span>
                      </div>
                      {c.quote && (
                        <blockquote className="ml-9 border-l-2 border-[var(--color-border-strong)] pl-3 py-0.5 text-[14px] leading-relaxed text-[var(--color-text)]">
                          &ldquo;{c.quote}&rdquo;
                        </blockquote>
                      )}
                      <div className="ml-9 flex items-center gap-4 flex-wrap">
                        <a href={c.url} target="_blank" rel="noopener noreferrer" className={LINK}>
                          <ExternalLink className="w-3.5 h-3.5" /> Open the page
                        </a>
                        {c.quote && <CopyButton text={referencedQuote(c)} label="Copy quote" link />}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          {jobCitations.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center gap-2 pb-1">
                <span className={LABEL}>From past jobs</span>
                <span className="font-display tabular-nums text-[13px] text-[var(--color-text-muted)]">{jobCitations.length}</span>
              </div>
              <p className="pb-2 text-[13px] text-[var(--color-text-muted)]">Kept at the close-out reviews of earlier projects.</p>
              <ol className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
                {jobCitations.map((c) => (
                  <li key={c.n} className={`-mx-2 px-2 py-2.5 space-y-2 transition-colors duration-500 ${flashN === c.n ? "bg-[var(--color-accent-soft)]" : ""}`}>
                    <div className="flex items-start gap-3">
                      <span className={NUM}>{c.n}</span>
                      <span className="min-w-0 text-[14px] leading-relaxed text-[var(--color-text)]">{c.quote ?? c.title}</span>
                    </div>
                    <a href={c.url} className={`ml-9 ${LINK}`}>Open the project</a>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>
      </article>

      {/* Interactive equipment register — the deterministic table behind
          "show me all equipment". Every sheet chip rings the tag. */}
      {answer.equipmentTable && onOpenTag && (
        <EquipmentTablePanel table={answer.equipmentTable} onOpenTag={onOpenTag} />
      )}

      {/* The shortlist behind a selection answer: the catalog, filtered. */}
      {answer.candidateTable && answer.candidateTable.rows.length > 0 && (
        <CandidateTablePanel table={answer.candidateTable}
          onOpen={onOpenDoc ? (r) => onOpenDoc({ id: r.documentId, name: r.documentName, fileKey: r.fileKey!, page: r.page, mention: r.code }) : undefined} />
      )}

      {/* You-need-this-book: referenced documents no library holds. A
          problem with this answer, so it sits right under it. */}
      {(answer.missingDocs ?? []).length > 0 && (
        // A gap in this answer: a row with a red edge, right under it.
        <EdgeRow tone="overdue" className="space-y-1.5 animate-rise">
          <h4 className="flex items-center gap-1.5 font-display text-[17px] font-semibold text-[var(--color-text)]">
            <BookOpen className="w-4 h-4 text-[var(--state-overdue)]" /> Not in your libraries
          </h4>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {answer.missingDocs!.map((d) => (
              <span key={d} className="font-display text-[16px] font-semibold text-[var(--color-text)]">{d}</span>
            ))}
          </div>
          <p className="text-[14px] leading-relaxed text-[var(--color-text-muted)]">
            Part of the answer leans on {answer.missingDocs!.length === 1 ? "it" : "them"}. Add {answer.missingDocs!.length === 1 ? "it" : "them"} to a linked library or pull the physical copy.
          </p>
        </EdgeRow>
      )}
    </div>
    </ProofContext.Provider>
    </DocLinkContext.Provider>
  );
}

/** What went wrong, in the same terms the answer tests check. */
const WRONG_REASONS: Array<{ code: string; label: string }> = [
  { code: "missed_page", label: "Missed the right page" },
  { code: "asks_for_held", label: "Asked for a document we have" },
  { code: "unproven_link", label: "Assumed two things are the same" },
  { code: "class_mixup", label: "Wrong rating / class" },
  { code: "missing_fact", label: "Left out something that matters" },
  { code: "misread", label: "Misread the document" },
  { code: "off_topic", label: "Answered a different question" },
];

/** Thumbs on an answer — the loop that makes retrieval smarter with use.
 *  A 👍 stores the verdict on the answer's history row; future similar
 *  questions pull that answer's cited pages into the passage pool first.
 *  A 👎 asks, in one tap, what went wrong. Document controllers can turn
 *  any answer into a test case that every future version must pass. */
export function AnswerFeedback({ questionId, onRated, question, citations }: {
  questionId: string;
  /** Called with the verdict after it is stored (0 = cleared). */
  onRated?: (rating: 1 | -1 | 0) => void;
  /** For "Make this a test case": the question and what the answer cited. */
  question?: string;
  citations?: Array<{ documentName: string; page: number }>;
}) {
  const { activeOrgId, activeRole } = useRole();
  const canTest = !!question && (activeRole === "Admin" || activeRole === "DocCtrl");
  const [state, setState] = useState<1 | -1 | 0>(0);
  const [reasons, setReasons] = useState<string[]>([]);
  const [reasonsSent, setReasonsSent] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testSaved, setTestSaved] = useState(false);
  // A rating shows at once; if it doesn't save, it's put back and said so.
  const [rateError, setRateError] = useState<string | null>(null);
  const rate = async (r: 1 | -1) => {
    const prev = state;
    const next = state === r ? 0 : r;    // clicking again clears the rating
    setState(next);
    setReasons([]); setReasonsSent(false); setRateError(null);
    try {
      const { rateKnowledgeAnswer } = await import("@/lib/knowledge");
      await rateKnowledgeAnswer(questionId, next);
      onRated?.(next);
    } catch (e) {
      setState(prev);
      setRateError(`Your rating wasn't saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const sendReasons = async (list: string[]) => {
    const prev = reasons;
    setReasons(list); setRateError(null);
    try {
      const { rateKnowledgeAnswer } = await import("@/lib/knowledge");
      await rateKnowledgeAnswer(questionId, -1, { reasons: list });
      setReasonsSent(true);
    } catch (e) {
      setReasons(prev);
      setRateError(`That wasn't saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const btn = (active: boolean) =>
    `w-9 h-9 grid place-items-center rounded-md border transition-colors ${active
      ? "border-[var(--color-text)] text-[var(--color-text)] bg-[var(--color-surface-2)]"
      : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`;
  return (
    <div className="mt-4">
      <div className="flex items-center justify-end gap-2 text-[14px] text-[var(--color-text-muted)] flex-wrap">
        {canTest && !testSaved && (
          <button onClick={() => setTesting(true)} className={`mr-auto ${LINK}`} title="Mark what a right answer must do - every future version is checked against it">
            <FlaskConical className="w-3.5 h-3.5" /> Make this a test case
          </button>
        )}
        {testSaved && <span className="mr-auto text-[var(--color-text)]">Saved as a test case. See Answer tests on the library page.</span>}
        {rateError && <span role="alert" className="font-semibold text-[var(--state-overdue)]">{rateError}</span>}
        {!rateError && state === 1 && <StatusTag dot={DOT_GOOD}>Saved. Similar questions will start from these pages.</StatusTag>}
        {!rateError && state === -1 && <span className="text-[var(--color-text)]">{reasonsSent ? "Thanks. That tells us where to look." : "What went wrong?"}</span>}
        {!rateError && state === 0 && <span>Did this answer it?</span>}
        <button onClick={() => void rate(1)} className={btn(state === 1)} aria-pressed={state === 1} aria-label="Right answer" title="Right answer: teach retrieval these pages">
          <ThumbsUp className="w-4 h-4" />
        </button>
        <button onClick={() => void rate(-1)} className={btn(state === -1)} aria-pressed={state === -1} aria-label="Wrong answer" title="Wrong or missed the point">
          <ThumbsDown className="w-4 h-4" />
        </button>
      </div>
      {state === -1 && (
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          {WRONG_REASONS.map((r) => {
            const on = reasons.includes(r.code);
            return (
              <button key={r.code} onClick={() => void sendReasons(on ? reasons.filter((x) => x !== r.code) : [...reasons, r.code])}
                aria-pressed={on}
                className={`inline-flex items-center gap-1 ${CHOICE(on)}`}>
                {on && <Check className="w-3.5 h-3.5" />}{r.label}
              </button>
            );
          })}
        </div>
      )}
      {testing && activeOrgId && question && (
        <Modal onClose={() => setTesting(false)} size="lg">
          <ModalHeader icon={FlaskConical} title="Make this a test case" onClose={() => setTesting(false)} />
          <div className="p-5 overflow-y-auto">
            <AnswerTestEditor
              initial={{ question, expect: {}, tags: [], sourceQuestionId: questionId }}
              citations={citations ?? []}
              onCancel={() => setTesting(false)}
              onSave={async (d) => {
                const { saveAnswerTest } = await import("@/lib/knowledge");
                await saveAnswerTest(activeOrgId, null, { question: d.question, expect: d.expect, tags: d.tags, notes: d.notes, sourceQuestionId: questionId });
                setTesting(false); setTestSaved(true);
              }}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Sources as quiet rows: a library passage opens in place (its quote, and
 *  the page one tap further); a web source or past job is a link. */
export function CitationChips({ citations, onOpen }: {
  citations: KnowledgeCitation[];
  onOpen: (c: KnowledgeCitation) => void;
}) {
  if (citations.length === 0) return null;
  return (
    <div className="mt-5">
      <div className="flex items-center gap-2 pb-2">
        <span className="font-display text-[17px] font-semibold text-[var(--color-text)]">Sources</span>
        <span className="font-display tabular-nums text-[14px] text-[var(--color-text-muted)]">{citations.length}</span>
      </div>
      <ol className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
        {citations.map((c) => c.url?.startsWith("/") ? (
          // A past job → its project.
          <li key={c.n}>
            <a href={c.url} title={c.quote ?? c.title} className="group flex items-center gap-3 py-2.5">
              <span className={NUM}>{c.n}</span>
              <span className="min-w-0 flex-1 truncate font-display text-[16px] font-semibold text-[var(--color-text)] group-hover:underline">{(c.title ?? "Past job").slice(0, 60)}</span>
              <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
            </a>
          </li>
        ) : c.url ? (
          // Internet citation → the web source itself.
          <li key={c.n}>
            <a href={c.url} target="_blank" rel="noopener noreferrer" title={c.url} className="group flex items-center gap-3 py-2.5">
              <span className={NUM}>{c.n}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-[16px] font-semibold text-[var(--color-text)] group-hover:underline">{c.title ?? c.url}</span>
                <span className="block truncate text-[13px] text-[var(--color-text-muted)]">{(() => { try { return new URL(c.url ?? "").hostname.replace(/^www\./, ""); } catch { return c.url ?? ""; } })()}</span>
              </span>
              <ExternalLink className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
            </a>
          </li>
        ) : (
          // Library citation → its verbatim passage, and the page itself.
          <li key={c.n}>
            <details className="group">
              <summary className="flex items-center gap-3 py-2.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <span className={NUM}>{c.n}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-3 min-w-0">
                    <span className="min-w-0 flex-1 truncate font-display text-[16px] font-semibold text-[var(--color-text)]">{(c.documentName ?? "Document").replace(/\.pdf$/i, "")}</span>
                    <span className="shrink-0 font-display tabular-nums text-[14px] text-[var(--color-text-muted)]">p. {c.page}</span>
                  </span>
                  {c.section && <span className="block truncate text-[13px] text-[var(--color-text-muted)]">{c.section.slice(0, 60)}</span>}
                </span>
                <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)] shrink-0 transition-transform group-open:rotate-180" />
              </summary>
              <div className="pb-3 pl-9 space-y-2">
                {c.quote ? (
                  <blockquote className="border-l-2 border-[var(--color-border-strong)] pl-3 py-0.5 text-[14px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {c.quote}
                  </blockquote>
                ) : (
                  <p className="text-[13px] text-[var(--color-text-muted)]">The passage text wasn&apos;t stored for this older answer. Open the page to read it.</p>
                )}
                <button onClick={() => onOpen(c)} className={LINK}>
                  <ExternalLink className="w-3.5 h-3.5" /> Open page {c.page}, passage highlighted
                </button>
              </div>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}


// ── While the answer is being written ────────────────────────────────────────
//
// Nobody should watch raw text typing itself out. Until the Answer line is
// complete the reader sees the answer's own shape, shimmering, under a path
// of stages that follows the real pipeline, in words. The moment the Answer
// line lands it takes its place; Why and the checklist fill in step by
// step; the sources column waits for the evidence and says so.

const STAGES = [
  { label: "Reading the question", match: /starting|attachment|search queries/i },
  { label: "Searching the library", match: /searching the library|nothing matched|rewriting the search/i },
  { label: "Following references", match: /reviewing|chasing/i },
  { label: "Reading the pages", match: /printed page|fetched page|reading \d/i },
  { label: "Writing the answer", match: /composing|answering/i },
  { label: "Attaching proof", match: /$^/ },
];

const EVIDENCE_SPLIT = /\n\s*(?:#{1,4}\s*)?\*{0,2}Evidence:?\*{0,2}:?\s*(?:\n|$)/i;

function Shimmer({ className }: { className: string }) {
  const round = /\brounded-/.test(className) ? "" : "rounded-md";
  return (
    <div aria-hidden
      className={`${round} bg-[linear-gradient(90deg,var(--color-surface-2)_0%,var(--color-border)_50%,var(--color-surface-2)_100%)] bg-[length:200%_100%] motion-safe:animate-[shimmer_1.8s_linear_infinite] ${className}`} />
  );
}

function StageTracker({ stage, status, compact }: { stage: number; status: string; compact: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  if (compact) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]" role="status" aria-live="polite">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        <span className="font-semibold text-[var(--color-text)]">{STAGES[stage].label}…</span>
        <span className="text-[var(--color-text-faint)] tabular-nums">{elapsed}s</span>
      </div>
    );
  }
  const extra = status && !STAGES[stage].label.toLowerCase().startsWith(status.toLowerCase().slice(0, 12)) ? status : null;
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <StepPath steps={STAGES.map((s) => s.label)} current={stage} />
      <div className="flex items-center gap-2 text-[14px] min-w-0">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-[var(--color-text-muted)]" />
        <span className="max-sm:hidden font-semibold text-[var(--color-text)] shrink-0">{STAGES[stage].label}…</span>
        {extra && <span className="min-w-0 truncate text-[var(--color-text-muted)]">{extra}</span>}
        <span className="ml-auto shrink-0 text-[13px] text-[var(--color-text-muted)] tabular-nums">{elapsed}s</span>
      </div>
    </div>
  );
}

/** The answer, filling in as it streams. `draft` is the raw streamed text;
 *  only COMPLETE lines are shown, so nothing ever types. */
export function StreamingAnswer({ status, draft }: { status: string; draft: string }) {
  const [body, ...afterEvidence] = draft.split(EVIDENCE_SPLIT);
  const inEvidence = afterEvidence.length > 0;
  const complete = inEvidence ? body : body.slice(0, body.lastIndexOf("\n") + 1);
  const meta = extractAnswerMeta(complete);
  const parts = structureAnswer(parseAnswerBlocks(meta.answer));
  const heroV = parts.hero !== null ? splitVerdict(parts.hero) : null;

  const statusStage = STAGES.findIndex((s) => s.match.test(status));
  const stage = inEvidence ? 5 : heroV ? 4 : Math.max(0, statusStage);
  const inline = (text: string) => <InlineAnswer text={text} citations={[]} onCite={() => undefined} />;
  const reveal = { animation: "rise 0.4s var(--ease-fluid) both" } as React.CSSProperties;
  const why = parts.why.filter((b) => b.type !== "label");

  return (
    <article className="@container space-y-6" aria-busy="true" aria-label="The answer is being written">
      {/* The stages run the full width, so every step reads in words. */}
      <StageTracker stage={stage} status={status} compact={!!heroV} />
      <div className="grid @min-[760px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6 @min-[760px]:pr-8">
          {heroV ? (
            <div style={reveal}><DirectAnswer verdict={heroV.verdict}>{inline(heroV.verdict ? capFirst(heroV.text) : heroV.text)}</DirectAnswer></div>
          ) : (
            <div className="space-y-3" aria-hidden>
              <Shimmer className="h-6 w-11/12" />
              <Shimmer className="h-6 w-3/4" />
            </div>
          )}

          {meta.answeringFor.length > 0 ? (
            <div style={reveal}><AnsweringFor chips={meta.answeringFor} /></div>
          ) : !heroV && (
            <div className="flex gap-1.5"><Shimmer className="h-7 w-24 rounded-full" /><Shimmer className="h-7 w-32 rounded-full" /><Shimmer className="h-7 w-20 rounded-full" /></div>
          )}

          {heroV ? (
            <section>
              <PartHead>Why</PartHead>
              <PathList items={[
                ...why.map((b, i) => ({ key: i, style: reveal, marker: <StepDot n={i + 1} />, body: <div className={BODY}>{inline(b.text)}</div> })),
                ...(parts.before.length === 0 && !inEvidence
                  ? [{ key: "more", marker: <Shimmer className="w-4 h-4" />, body: <Shimmer className="mt-1 h-4 w-4/5" /> }]
                  : []),
              ]} />
            </section>
          ) : (
            <section aria-hidden>
              <PathList items={["w-11/12", "w-3/4", "w-5/6"].map((w) => ({
                key: w, marker: <Shimmer className="w-4 h-4" />, body: <Shimmer className={`mt-1 h-4 ${w}`} />,
              }))} />
            </section>
          )}

          {heroV && parts.before.length > 0 && (
            <section style={reveal}>
              <PartHead>Before you act</PartHead>
              <div className="space-y-2">
                {parts.before.filter((b) => b.type !== "label").map((b, i) => b.type === "important" ? (
                  <EdgeRow key={i} tone="held" style={reveal} className="flex items-start gap-2">
                    <AlertTriangle className="mt-1 w-4 h-4 shrink-0 text-[var(--state-held)]" />
                    <div className={`${BODY} font-semibold`}>{inline(b.text)}</div>
                  </EdgeRow>
                ) : (
                  <div key={i} style={reveal} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start">
                    <StepDot n={i + 1} />
                    <div className={BODY}>{inline(b.text)}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside aria-label="Sources"
          className="min-w-0 mt-8 pt-6 border-t border-[var(--color-border)] @min-[760px]:mt-0 @min-[760px]:pt-0 @min-[760px]:border-t-0 @min-[760px]:pl-8 @min-[760px]:border-l">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h3 className="font-display text-[19px] font-semibold text-[var(--color-text)]">Sources</h3>
            <span className="text-[13px] text-[var(--color-text-muted)]">
              {inEvidence ? "Marking the exact words on each page…" : "They arrive with the answer"}
            </span>
          </div>
          <ol className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]" aria-hidden>
            {[0, 1, 2].map((i) => (
              <li key={i} className="py-3 flex items-start gap-3">
                <Shimmer className="w-6 h-6" />
                <div className="flex-1 space-y-2"><Shimmer className="h-4 w-4/5" /><Shimmer className="h-3 w-2/5" /></div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </article>
  );
}
