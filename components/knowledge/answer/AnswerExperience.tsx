"use client";

// components/knowledge/answer/AnswerExperience.tsx — the library answer,
// rendered like an answer: hero card, numbered basis steps, imperatives
// that never hide, sources grouped by document, instant proof cards, the
// clarify / need rounds, and the thumbs that teach retrieval.
//
// Lifted verbatim out of the library page so the chat shell and the
// library page render the SAME answer. Nothing here changed in behavior.

import React, { useEffect, useMemo, useState } from "react";
import {
  BookOpen, Sparkles, Send, FileText, CheckCircle2, AlertTriangle, ExternalLink, History, Globe,
  ChevronRight, ChevronDown, Copy, Check, Search, ScanSearch, PenLine, Quote, Eye,
  ThumbsUp, ThumbsDown, X, Waypoints, Loader2, Printer, Upload, RefreshCw, ShieldCheck,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import {
  referencedQuote, hasSource, parseAnswerBlocks, extractCitationNumbers, proofTerms, highlightQuote, splitVerdict, quoteWindow,
  structureAnswer, isMissingFact, extractAnswerMeta, type AnswerBlock, type Verdict,
} from "@/lib/knowledgeText";
import type { KnowledgeAnswer, KnowledgeCitation } from "@/lib/knowledge";
import GraphShapeWizard from "@/components/graph/GraphShapeWizard";
import { buildAnswerExport, printableDocument } from "@/lib/answerExport";
import FormFillModal from "@/components/knowledge/answer/FormFillModal";
import { copyText } from "@/lib/clipboard";
import EquipmentTablePanel from "@/components/knowledge/EquipmentTablePanel";

export type DocLink = NonNullable<KnowledgeAnswer["mentionedDocs"]>[number];
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
      <p className="text-[11px] italic text-[var(--color-text-muted)]">
        The passage text wasn&apos;t stored for this answer — open the page to read it in the document.
      </p>
    );
  }
  return (
    <blockquote className={className}>
      {win ? (
        <>
          <span className="text-[var(--color-text-muted)]">{win.clippedStart ? "… " : ""}{win.before}</span>
          <mark className="rounded px-0.5 bg-yellow-200 dark:bg-yellow-700/60 text-[var(--color-text)] font-bold">{win.hit}</mark>
          <span className="text-[var(--color-text-muted)]">{win.after}{win.clippedEnd ? " …" : ""}</span>
        </>
      ) : segs.map((sg, i) => sg.hit
        ? <mark key={i} className="rounded px-0.5 bg-orange-200 dark:bg-orange-800/70 text-inherit font-bold">{sg.text}</mark>
        : <React.Fragment key={i}>{sg.text}</React.Fragment>)}
    </blockquote>
  );
}

const VERDICT_STYLE: Record<Verdict, { label: string; cls: string }> = {
  yes: { label: "Yes", cls: "bg-emerald-600 text-white" },
  conditional: { label: "Yes, with conditions", cls: "bg-amber-500 text-white dark:bg-amber-600" },
  no: { label: "No", cls: "bg-rose-600 text-white" },
  unsettled: { label: "Not settled", cls: "bg-slate-600 text-white dark:bg-slate-500" },
  complies: { label: "Complies", cls: "bg-emerald-600 text-white" },
  fails: { label: "Does not comply", cls: "bg-rose-600 text-white" },
  undetermined: { label: "Can't determine", cls: "bg-slate-600 text-white dark:bg-slate-500" },
};

/** The verdict as a badge — the yes/no lands before a single word is read. */
function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const v = VERDICT_STYLE[verdict];
  return (
    <span className={`inline-flex items-center mb-1.5 px-2.5 py-1 rounded-md text-[12px] font-black uppercase tracking-[0.08em] shadow-sm ${v.cls}`}>
      {v.label}
    </span>
  );
}

function ProofCard({ proof, onClose, onOpenPage }: {
  proof: ProofState;
  onClose: () => void;
  onOpenPage: (c: KnowledgeCitation) => void;
}) {
  const { citation: c, context } = proof;
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
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="dialog" aria-label="Source proof"
        className="fixed z-50 animate-pop rounded-2xl border-2 border-orange-300 dark:border-orange-800 bg-[var(--color-surface)] shadow-2xl overflow-hidden"
        style={{ left: proof.x, width: Math.min(PROOF_W, typeof window !== "undefined" ? window.innerWidth - 24 : PROOF_W), ...(proof.up ? { bottom: proof.y } : { top: proof.y }) }}
      >
        <div className="h-1 bg-gradient-to-r from-orange-500 via-amber-500 to-orange-500" />
        <div className="px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-3.5 h-3.5 text-orange-600 shrink-0" />
            <span className="text-xs font-black text-[var(--color-text)] truncate">{c.documentName ?? "Document"}</span>
            <span className="text-[10px] font-bold text-[var(--color-text-muted)] shrink-0">
              p.{c.page}{c.section ? ` · ${c.section.slice(0, 30)}` : ""}
            </span>
            <button onClick={onClose} aria-label="Close proof"
              className="ml-auto shrink-0 p-1 rounded-md text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {c.claim && (
            <div className="mb-1.5 text-[12px] font-black text-[var(--color-text)]">{c.claim}</div>
          )}
          <ProofQuote c={c} context={context}
            className="border-l-2 border-orange-400 pl-3 py-1 text-[12px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap max-h-52 overflow-y-auto" />
          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
            <button onClick={() => onOpenPage(c)}
              className="inline-flex items-center gap-1.5 text-[11px] font-black px-3 py-1.5 rounded-lg bg-orange-600 text-white shadow-sm hover:bg-orange-700 transition-colors">
              <Eye className="w-3.5 h-3.5" /> Open the page — highlighted
            </button>
            {c.highlight ? (
              <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Exact wording from the page
              </span>
            ) : hits > 0 && (
              <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> {hits} claim term{hits === 1 ? "" : "s"} found in this passage
              </span>
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
  const parts = text.split(new RegExp(`(\\[\\d{1,3}\\]|\\(not from your library[^)]*\\)|\\*\\*(?:[^*]|\\*(?!\\*))+?\\*\\*|\`[^\`]+\`${mentionAlt ? `|${mentionAlt}` : ""})`, "gi"));
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
      className="inline-flex items-center gap-1 align-baseline mx-0.5 px-1.5 py-0.5 rounded-md border border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/40 text-orange-800 dark:text-orange-200 font-bold text-[0.85em] leading-none hover:bg-orange-100 dark:hover:bg-orange-900/50 hover:border-orange-500 transition-colors cursor-pointer">
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
                title={`${c.documentName ?? "Document"} · page ${c.page} — see the exact passage`}
                // Minimal superscript anchor, not a filled badge: a solid
                // chip on every line cluttered the reading flow (design
                // review). p-1.5/-m-1 keeps a real tap target.
                className="align-super text-[10px] font-black text-orange-600 dark:text-orange-400 underline decoration-dotted decoration-orange-400/70 underline-offset-2 hover:text-orange-800 dark:hover:text-orange-300 p-1.5 -m-1 cursor-pointer">
                {cite[1]}
              </button>
            );
          }
          if (c && c.url) {
            // A web source: jumps to its card in the proof column, where the
            // page's own quoted text and the link to it are.
            return (
              <button key={i} onClick={(e) => { if (showProof) showProof(c, text, e.currentTarget.getBoundingClientRect()); }}
                title={`From the web: ${c.title ?? c.url}`}
                className="align-super text-[10px] font-black text-sky-700 dark:text-sky-400 underline decoration-dotted decoration-sky-400/70 underline-offset-2 hover:text-sky-900 p-1.5 -m-1 cursor-pointer">
                {cite[1]}
              </button>
            );
          }
          return <span key={i} className="align-super text-[10px] font-black text-orange-700/80">{cite[1]}</span>;
        }
        if (/^\(not from your library/i.test(part)) {
          return (
            <span key={i} title="General engineering knowledge or a code that isn't in this library — verify before relying on it"
              className="inline-block align-baseline mx-0.5 px-1.5 rounded font-mono text-[10.5px] font-bold bg-sky-100 dark:bg-sky-950/50 text-sky-800 dark:text-sky-300 whitespace-nowrap">
              not from your library
            </span>
          );
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          // Recurse so a doc mention INSIDE a bold span still gets its chip —
          // the prompt bolds every identifier, so most mentions live here.
          return <b key={i} className="font-black"><InlineAnswer text={part.slice(2, -2)} citations={citations} onCite={onCite} /></b>;
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
          ? <React.Fragment key={i}><span className="align-super text-[10px] text-orange-600/60">,</span>{node}</React.Fragment>
          : node;
      })}
    </>
  );
}

/** The draw-your-eyes-here tier: imperatives, hold points, gaps. Bigger
 *  type, heavier border, icon — impossible to skim past. */
function ImportantCallout({ text, citations, onCite }: {
  text: string;
  citations: KnowledgeCitation[];
  onCite: (c: KnowledgeCitation) => void;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border-2 border-amber-400 dark:border-amber-600 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/30 px-4 py-3 shadow-sm">
      <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
      <span className="text-[15px] font-bold text-amber-900 dark:text-amber-200 leading-snug">
        <InlineAnswer text={text} citations={citations} onCite={onCite} />
      </span>
    </div>
  );
}

/** Per-section accent colors. One orange everything IS the wall — color is
 *  how the eye tells "Joint type" from "Alignment" from "Hold points" at a
 *  glance. Full class strings (Tailwind can't build them dynamically). */
const SECTION_ACCENTS = [
  { band: "bg-orange-100/80 dark:bg-orange-950/50 border border-orange-200 dark:border-orange-900", text: "text-orange-950 dark:text-orange-200", bar: "bg-orange-600", pill: "bg-orange-600 text-white", num: "bg-orange-600 text-white border-transparent", hover: "hover:border-orange-300 dark:hover:border-orange-800" },
  { band: "bg-violet-100/80 dark:bg-violet-950/50 border border-violet-200 dark:border-violet-900", text: "text-violet-950 dark:text-violet-200", bar: "bg-violet-600", pill: "bg-violet-600 text-white", num: "bg-violet-600 text-white border-transparent", hover: "hover:border-violet-300 dark:hover:border-violet-800" },
  { band: "bg-sky-100/80 dark:bg-sky-950/50 border border-sky-200 dark:border-sky-900", text: "text-sky-950 dark:text-sky-200", bar: "bg-sky-600", pill: "bg-sky-600 text-white", num: "bg-sky-600 text-white border-transparent", hover: "hover:border-sky-300 dark:hover:border-sky-800" },
  { band: "bg-emerald-100/80 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900", text: "text-emerald-950 dark:text-emerald-200", bar: "bg-emerald-600", pill: "bg-emerald-600 text-white", num: "bg-emerald-600 text-white border-transparent", hover: "hover:border-emerald-300 dark:hover:border-emerald-800" },
  { band: "bg-rose-100/80 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900", text: "text-rose-950 dark:text-rose-200", bar: "bg-rose-600", pill: "bg-rose-600 text-white", num: "bg-rose-600 text-white border-transparent", hover: "hover:border-rose-300 dark:hover:border-rose-800" },
  { band: "bg-amber-100/80 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900", text: "text-amber-950 dark:text-amber-200", bar: "bg-amber-600", pill: "bg-amber-600 text-white", num: "bg-amber-600 text-white border-transparent", hover: "hover:border-amber-300 dark:hover:border-amber-800" },
];

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
      className={`mx-0.5 px-1.5 py-0.5 rounded-md border font-mono font-bold text-[0.92em] transition-colors cursor-pointer ${copied
        ? "bg-emerald-100 dark:bg-emerald-950/50 border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300"
        : "bg-orange-100 dark:bg-orange-950/50 border-orange-200 dark:border-orange-900 text-orange-900 dark:text-orange-200 hover:border-orange-400"}`}
    >
      {copied ? "copied ✓" : value}
    </button>
  );
}

/** Section titles that read as deep-reference material — these default
 *  COLLAPSED (everything else stays open, tap any header to toggle). */
const DEEP_SECTION = /further|ancillary|reference|missing|not retrieved|beyond|background/i;

/** One FACT presented like one: numbered, carded, its sources visible as
 *  buttons on the card (document · page → instant proof passage) — not a
 *  microscopic dot in front of 13px prose. */
function FactCard({ n, alt, text, citations, onCite }: {
  n: number;
  /** Alternating row tint — soft separation instead of a border per fact. */
  alt: boolean;
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
    <div className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 ${alt ? "bg-[var(--color-surface-2)]/50" : ""}`}>
      <span className="mt-1 shrink-0 w-5 text-right font-mono text-[10px] font-bold text-[var(--color-text-faint)] tabular-nums">
        {String(n).padStart(2, "0")}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--color-text)] leading-relaxed">
          <InlineAnswer text={text} citations={citations} onCite={onCite} />
        </div>
        {sources.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            {/* These open the DOCUMENT ITSELF, at the cited page, passage
                highlighted — the real paper is the proof. The superscript
                anchors remain the quick in-place passage peek. */}
            {sources.map((c) => (
              <button key={c.n}
                onClick={() => onCite(c)}
                title={`Open ${c.documentName ?? "the document"} at page ${c.page} — passage highlighted`}
                className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1.5 sm:py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] shadow-sm hover:border-orange-400 hover:text-orange-700 dark:hover:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-950/30 active:scale-[0.98] transition-all">
                <Eye className="w-3 h-3 shrink-0 text-orange-600" />
                {(c.documentName ?? "Source").replace(/\.pdf$/i, "").slice(0, 26)} · p.{c.page}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Grouped, collapsible answer sections — the shared renderer for both the
 *  detail area and the no-hero fallback. Soft typographic headers (colored
 *  dot, hairline, chevron) instead of a bordered band per section; facts as
 *  alternating tinted rows instead of a box per line; deep-reference
 *  sections start collapsed, everything toggles. */
function SectionedBlocks({ blocks, citations, onCite }: {
  blocks: AnswerBlock[];
  citations: KnowledgeCitation[];
  onCite: (c: KnowledgeCitation) => void;
}) {
  const sections = useMemo(() => {
    const out: Array<{ label: string | null; accent: number; items: AnswerBlock[] }> = [];
    let cur: { label: string | null; accent: number; items: AnswerBlock[] } = { label: null, accent: 0, items: [] };
    let accent = -1;
    for (const b of blocks) {
      if (b.type === "label") {
        if (cur.label !== null || cur.items.length > 0) out.push(cur);
        accent += 1;
        cur = { label: b.text, accent: Math.max(0, accent), items: [] };
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
        return <div key={i} style={enter(i)}><FactCard n={n} alt={n % 2 === 0} text={b.text} citations={citations} onCite={onCite} /></div>;
      }
      if (isCheck(b.text)) {
        return (
          <div key={i} style={enter(i)} className="flex items-start gap-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 text-[13px] text-amber-800 dark:text-amber-300">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span><InlineAnswer text={b.text.replace(/^\*{0,2}Check:?\*{0,2}\s*/i, "")} citations={citations} onCite={onCite} /></span>
          </div>
        );
      }
      return (
        <p key={i} style={enter(i)} className="text-sm text-[var(--color-text)] leading-relaxed px-3">
          <InlineAnswer text={b.text} citations={citations} onCite={onCite} />
        </p>
      );
    });
  };
  // Which labeled section is LAST decides where the stepper rail ends — the
  // rail runs node → node and stops at the final step instead of dangling.
  const lastLabeled = sections.reduce((acc, sec, i) => (sec.label !== null ? i : acc), -1);
  let step = 0;
  return (
    <div className="space-y-0">
      {sections.map((sec, si) => {
        if (sec.label === null) {
          return <div key={si} className="space-y-1.5 pb-2">{renderItems(sec.items)}</div>;
        }
        step += 1;
        const facts = sec.items.filter((b) => b.type === "bullet").length;
        const open = !closed.has(si);
        const a = SECTION_ACCENTS[sec.accent % SECTION_ACCENTS.length];
        const isLast = si === lastLabeled;
        return (
          <div
            key={si}
            style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(step - 1, 8) * 70}ms` }}
          >
            <button
              type="button"
              onClick={() => setClosed((prev) => {
                const next = new Set(prev);
                if (next.has(si)) next.delete(si); else next.add(si);
                return next;
              })}
              className="group/step w-full flex items-center gap-3 pt-4 pb-1.5 text-left"
            >
              {/* Numbered step node — the stepper's anchor point. */}
              <span className={`shrink-0 w-6 h-6 rounded-full ${a.bar} text-white text-[11px] font-black flex items-center justify-center shadow-sm ring-2 ring-[var(--color-surface)] transition-transform duration-200 group-hover/step:scale-110`}>
                {step}
              </span>
              <span className="text-[16px] sm:text-[17px] font-black tracking-tight leading-tight text-[var(--color-text)] group-hover/step:text-[var(--color-accent)] transition-colors">{sec.label}</span>
              {facts > 0 && <span className="shrink-0 text-[11px] font-bold text-[var(--color-text-faint)]">· {facts} {facts === 1 ? "fact" : "facts"}</span>}
              <span className="flex-1 h-px bg-[var(--color-border)]/70" />
              <ChevronDown className={`w-4 h-4 text-[var(--color-text-faint)] shrink-0 transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />
            </button>
            {/* The rail: content hangs off a vertical connector dropping from
                the step node to the next one — the answer READS as a route. */}
            <div className={`ml-3 pl-5 sm:pl-6 ${open || !isLast ? "border-l-2 border-[var(--color-border)]/60" : ""} ${open ? "pb-4" : "pb-2"}`}>
              {open ? (
                <div className="space-y-1.5">{renderItems(sec.items)}</div>
              ) : (
                <div className="text-[11px] text-[var(--color-text-faint)] font-medium pl-3">
                  {facts > 0 ? `${facts} ${facts === 1 ? "item" : "items"} — tap to expand` : "tap to expand"}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Structured answer: the Answer line as a hero callout, Basis/Check as
 *  compact labeled sections — never a wall of text. */
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
    <div className="space-y-2.5">
      {hero && heroV && (
        <div className="rounded-xl border-l-4 border-orange-500 bg-orange-50 dark:bg-orange-950/30 px-4 py-3">
          <div className="text-[9px] font-black uppercase tracking-[0.18em] text-orange-600 mb-1">Answer</div>
          {heroV.verdict && <div><VerdictBadge verdict={heroV.verdict} /></div>}
          <div className="text-base font-bold text-[var(--color-text)] leading-snug">
            <InlineAnswer text={heroV.text} citations={citations} onCite={onCite} />
          </div>
        </div>
      )}
      <SectionedBlocks key={answer} blocks={rest} citations={citations} onCite={onCite} />
    </div>
  );
}

/** While the AI works, show WHAT it's doing — staged progress beats a bare
 *  spinner. Stages advance on a timer that tracks the real pipeline order;
 *  the last stage holds until the answer lands. */
const ASK_STAGES = [
  { icon: PenLine, label: "Writing search queries" },
  { icon: Search, label: "Searching the library" },
  { icon: ScanSearch, label: "Refining with different terms" },
  { icon: Quote, label: "Reading the passages" },
  { icon: Sparkles, label: "Composing the cited answer" },
];

export function AskProgress() {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStage((s) => Math.min(s + 1, ASK_STAGES.length - 1)), 2600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 animate-rise">
      <div className="space-y-2.5">
        {ASK_STAGES.map((s, i) => {
          const Icon = s.icon;
          const state = i < stage ? "done" : i === stage ? "active" : "todo";
          return (
            <div key={s.label} className={`flex items-center gap-2.5 text-xs transition-opacity ${state === "todo" ? "opacity-35" : ""}`}>
              {state === "done"
                ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                : state === "active"
                  ? <Loader2 className="w-4 h-4 text-orange-600 animate-spin shrink-0" />
                  : <Icon className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />}
              <span className={state === "active" ? "font-black text-[var(--color-text)]" : "font-bold text-[var(--color-text-muted)]"}>
                {s.label}{state === "active" ? "…" : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
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
  const toggle = (o: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(o)) next.delete(o); else next.add(o);
      return next;
    });
  };
  return (
    <div className="mt-4 rounded-2xl border-2 border-sky-300 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/20 p-4 animate-rise">
      <div className="flex items-start gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-sky-600 flex items-center justify-center shrink-0">
          <Sparkles className="w-3.5 h-3.5 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-black text-[var(--color-text)]">One thing before I answer</div>
          <p className="text-xs text-[var(--color-text)] mt-1">{prompt}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {options.map((o) => (
              <button key={o} type="button" onClick={() => toggle(o)}
                className={`text-[11px] font-black px-2.5 py-1.5 rounded-lg border transition-colors ${
                  selected.has(o)
                    ? "border-sky-600 bg-sky-600 text-white"
                    : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-sky-400"}`}>
                {o}
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <Button size="sm" onClick={() => onAnswer([...selected])} disabled={selected.size === 0}>
              <Send className="w-3.5 h-3.5" /> Answer selected ({selected.size})
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onAnswer(options)}>
              Answer all of it
            </Button>
          </div>
        </div>
      </div>
    </div>
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
  return (
    <div className="mt-4 rounded-2xl border-2 border-indigo-300 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-950/20 p-4 animate-rise">
      <div className="flex items-start gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
          <Sparkles className="w-3.5 h-3.5 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-black text-[var(--color-text)]">I need a value from you to run this calculation</div>
          <p className="text-xs text-[var(--color-text)] mt-1 whitespace-pre-wrap">{prompt}</p>
          <div className="mt-2.5 flex items-end gap-2">
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
        </div>
      </div>
    </div>
  );
}

export function CopyButton({ text, label, onDark }: { text: string; label: string; onDark?: boolean }) {
  const [copied, setCopied] = useState<boolean | "failed">(false);
  return (
    <button
      onClick={() => {
        void copyText(text).then((ok) => {
          setCopied(ok ? true : "failed");
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      title={label}
      className={`inline-flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded-lg border transition-colors ${onDark
        ? "border-white/25 text-slate-300 hover:text-white hover:bg-white/10"
        : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
      {copied === true ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />} {copied === true ? "Copied" : copied === "failed" ? "Copy blocked" : label}
    </button>
  );
}

/** One source = one compact ROW. The answer above already synthesized this
 *  material — showing quote previews by default read as the same info twice.
 *  Collapsed: identifiers only. Expanded (one tap): the verbatim quote +
 *  view-highlighted-page. Evidence stays one gesture away without competing
 *  with the answer. */
export function SourceCard({ citation, onOpen, delay }: {
  citation: KnowledgeCitation;
  onOpen: (c: KnowledgeCitation) => void;
  delay: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const c = citation;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden hover:border-orange-300 dark:hover:border-orange-800 transition-all animate-rise"
      style={{ animationDelay: `${delay}ms` }}>
      <button onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[var(--color-surface-2)]/50 transition-colors">
        <span className="shrink-0 w-5.5 h-5.5 min-w-[1.375rem] min-h-[1.375rem] rounded-md bg-orange-600 text-white text-[10px] font-black flex items-center justify-center">{c.n}</span>
        <span className="text-xs font-black text-[var(--color-text)] truncate shrink-0 max-w-[38%]">
          {(c.documentName ?? "Document").replace(/\.pdf$/i, "")}
        </span>
        {c.tier && (
          <span className={`shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded border truncate max-w-36 ${
            c.tier === "governing"
              ? "bg-emerald-100 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800"
              : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]"}`}
            title={c.tier === "governing" ? "From the governing library — supersedes reference minimums" : "From a linked reference library"}>
            {c.tier === "governing" ? "GOVERNING" : "REFERENCE"}
          </span>
        )}
        {c.section && (
          <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-950/50 text-orange-800 dark:text-orange-300 border border-orange-200 dark:border-orange-900 truncate">
            {c.section}
          </span>
        )}
        <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border border-[var(--color-border)]">
          p.{c.page}
        </span>
        <ChevronDown className={`ml-auto shrink-0 w-3.5 h-3.5 text-[var(--color-text-muted)] transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-[var(--color-border)] animate-rise">
          <ProofQuote c={c}
            className="border-l-2 border-orange-400 pl-3 py-1 text-[11px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap max-h-64 overflow-y-auto" />
          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => onOpen(c)}
              className="inline-flex items-center gap-1.5 text-[10px] font-black px-2.5 py-1.5 rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors">
              <ExternalLink className="w-3 h-3" /> View highlighted page
            </button>
            {c.quote && <CopyButton text={referencedQuote(c)} label="Copy quote" />}
            {c.tier && c.libraryName && (
              <span className="ml-auto text-[9px] text-[var(--color-text-muted)] font-bold">{c.libraryName}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One piece of proof: what it proves, where it lives, and the exact words —
 *  marked — with the page one tap away. A cite tap in the answer opens and
 *  flashes the matching card. */
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
    <div id={domId}
      className={`rounded-xl border bg-[var(--color-surface)] overflow-hidden scroll-mt-24 transition-shadow duration-300 ${flash
        ? "border-orange-500 shadow-[0_0_0_3px_rgba(249,115,22,0.25)]"
        : "border-[var(--color-border)]"}`}>
      <button onClick={onToggle} aria-expanded={open}
        className="w-full px-3 py-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 text-left hover:bg-[var(--color-surface-2)]/50 transition-colors">
        <span className="mt-0.5 min-w-[1.375rem] h-[1.375rem] px-1 rounded-md bg-orange-100 dark:bg-orange-950/60 text-orange-700 dark:text-orange-300 font-mono text-[11px] font-bold flex items-center justify-center">{c.n}</span>
        <span className="min-w-0">
          <span className="block text-[13px] font-bold text-[var(--color-text)] leading-snug">{c.claim || doc}</span>
          <span className="block mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)] truncate">
            {c.claim ? `${doc} · ` : ""}{c.section ? `${c.section.slice(0, 36)} · ` : ""}p.{c.page}
          </span>
        </span>
        <ChevronDown className={`mt-1 w-3.5 h-3.5 text-[var(--color-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <ProofQuote c={c}
            className="border-l-[3px] border-[var(--color-border)] bg-[var(--color-surface-2)]/50 rounded-r-md pl-3 pr-2 py-1.5 text-[12.5px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap max-h-56 overflow-y-auto" />
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <button onClick={() => onOpen(c)}
              className="inline-flex items-center gap-1.5 font-bold px-2.5 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-orange-400 transition-colors">
              <Eye className="w-3 h-3 text-orange-600" /> Open p.{c.page}{c.highlight ? " at these words" : ""}
            </button>
            {(c.highlight || c.quote) && <CopyButton text={referencedQuote(c)} label="Copy quote" />}
            {!c.highlight && c.quote && (
              <span className="text-[var(--color-text-faint)]">whole passage — no exact words given</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The evidence trail, ranked by what each passage does for the answer:
 *  what decides it, what rules a restriction out or limits it, and the rest
 *  collapsed. Answers saved before evidence roles existed show one plain
 *  "Sources" tier in the order the answer used them. */
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
  const tierHead = (label: string, dot: string, count: number) => (
    <div className="flex items-center gap-2 font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
      <span className={`w-2 h-2 rounded-full ${dot}`} />{label}
      <span className="text-[var(--color-text-faint)]">{count}</span>
    </div>
  );
  if (citations.length === 0) {
    return <p className="text-xs text-[var(--color-text-muted)]">No library passages were cited for this answer.</p>;
  }
  return (
    <div className="space-y-4">
      {!hasRoles && (
        <div className="space-y-2">{tierHead("Sources", "bg-orange-500", citations.length)}{citations.map(item)}</div>
      )}
      {decides.length > 0 && (
        <div className="space-y-2">{tierHead("Decides the answer", "bg-emerald-500", decides.length)}{decides.map(item)}</div>
      )}
      {limits.length > 0 && (
        <div className="space-y-2">{tierHead("Conditions & limits", "bg-amber-500", limits.length)}{limits.map(item)}</div>
      )}
      {related.length > 0 && (
        <div className="space-y-2">
          <button onClick={() => onShowRelated(!showRelated)} aria-expanded={showRelated}
            className="w-full flex items-center gap-2 font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            <span className="w-2 h-2 rounded-full bg-slate-400" />
            {decides.length + limits.length > 0 ? "Related, not needed for the answer" : "Sources"}
            <span className="text-[var(--color-text-faint)]">{related.length}</span>
            <ChevronDown className={`ml-auto w-3.5 h-3.5 transition-transform ${showRelated ? "rotate-180" : ""}`} />
          </button>
          {showRelated && related.map(item)}
        </div>
      )}
    </div>
  );
}

const VERDICT_BOX: Record<Verdict | "none", string> = {
  yes: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-800",
  conditional: "bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800",
  no: "bg-rose-50 dark:bg-rose-950/30 border-rose-300 dark:border-rose-800",
  unsettled: "bg-slate-50 dark:bg-slate-900/40 border-slate-300 dark:border-slate-700",
  complies: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-800",
  fails: "bg-rose-50 dark:bg-rose-950/30 border-rose-300 dark:border-rose-800",
  undetermined: "bg-slate-50 dark:bg-slate-900/40 border-slate-300 dark:border-slate-700",
  none: "bg-orange-50/70 dark:bg-orange-950/20 border-orange-200 dark:border-orange-900",
};

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
      <span className="text-[11px] text-[var(--color-text-muted)] mr-0.5">Answering for</span>
      {chips.map((chip, i) => editing === i ? (
        <form key={i} className="inline-flex items-center gap-1"
          onSubmit={(e) => { e.preventDefault(); if (value.trim()) { onCorrect?.(value.trim()); setEditing(null); } }}>
          <input id={`af-${i}`} autoFocus value={value} onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }}
            className="text-[12px] px-2 py-0.5 rounded-full border border-orange-400 bg-[var(--color-surface)] text-[var(--color-text)] w-48 focus:outline-none" />
          <button type="submit" className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-orange-600 text-white">Re-ask</button>
        </form>
      ) : (
        <button key={i} type="button" onClick={() => start(i)} disabled={!onCorrect}
          title={onCorrect ? (isMissingFact(chip) ? "Add this and re-ask" : "Correct this and re-ask") : undefined}
          className={`inline-flex items-center gap-1 text-[12px] px-2.5 py-0.5 rounded-full border transition-colors ${isMissingFact(chip)
            ? "border-dashed border-amber-500 text-amber-700 dark:text-amber-300"
            : "border-[var(--color-border)] bg-[var(--color-surface-2)]/60 text-[var(--color-text)]"} ${onCorrect ? "hover:border-orange-400 cursor-pointer" : "cursor-default"}`}>
          {chip}
          {onCorrect && <span className="text-[10px] text-[var(--color-text-faint)]">{isMissingFact(chip) ? "+" : "✎"}</span>}
        </button>
      ))}
    </div>
  );
}

/** The one question that would finish the answer — asked AFTER the answer,
 *  never instead of it. Tap an option or type a value; it re-asks with it. */
function OneQuestion({ followup, onAnswer }: {
  followup: { question: string; options: string[] };
  onAnswer?: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="rounded-lg border border-dashed border-amber-500/80 px-3.5 py-3 space-y-2">
      <div className="text-[13.5px] text-[var(--color-text)]"><b>One thing would finish this:</b> {followup.question}</div>
      {onAnswer && (
        <form className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); if (value.trim()) onAnswer(`${followup.question} → ${value.trim()}`); }}>
          {followup.options.map((o) => (
            <button key={o} type="button" onClick={() => onAnswer(`${followup.question} → ${o}`)}
              className="text-[12.5px] px-2.5 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-orange-400">
              {o}
            </button>
          ))}
          <input id="one-question" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Type the answer"
            className="text-[12.5px] px-2.5 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] w-44 focus:outline-none focus:border-orange-400" />
          <button type="submit" disabled={!value.trim()}
            className="text-[12.5px] font-bold px-2.5 py-1 rounded-md bg-orange-600 text-white disabled:opacity-40">
            Finish the answer
          </button>
        </form>
      )}
    </div>
  );
}

/** Section heading inside the answer column. */
function PartHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] mb-2">
      {children}
    </div>
  );
}

/** Copy (a menu: formatted for email or Word, plain text, Markdown for
 *  Teams or Slack, the answer alone, or the references alone) and Print
 *  (the same content on a clean page). The main button copies formatted. */
type CopyKind = "formatted" | "text" | "markdown" | "answer" | "references";
const COPY_OPTIONS: Array<{ kind: CopyKind; label: string; hint: string }> = [
  { kind: "formatted", label: "Formatted", hint: "Email, Word — looks like the card, proof included" },
  { kind: "text", label: "Plain text", hint: "The whole answer and its proof, no formatting" },
  { kind: "markdown", label: "Markdown", hint: "Teams, Slack, notes, tickets" },
  { kind: "answer", label: "Answer only", hint: "The answer line — no proof" },
  { kind: "references", label: "References only", hint: "Each cited document, page and quote" },
];

function ExportButtons({ question, answer, large = false }: { question: string; answer: KnowledgeAnswer; large?: boolean }) {
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
  const primary = large
    ? "inline-flex items-center gap-1.5 text-[13px] font-bold px-3.5 py-2 bg-orange-600 text-white shadow-sm hover:bg-orange-700 transition-colors"
    : "inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-orange-400 transition-colors";
  const secondary = large
    ? "inline-flex items-center gap-1.5 text-[13px] font-bold px-3.5 py-2 rounded-lg border border-[var(--color-border-strong,var(--color-border))] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-orange-400 transition-colors"
    : `${primary} rounded-md`;
  const icon = large ? "w-4 h-4" : "w-3 h-3";
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <div className="relative inline-flex">
        <button type="button" onClick={() => void copy("formatted")} className={`${primary} ${large ? "rounded-l-lg" : "rounded-l-md"}`}
          title="Copy the answer and its proof, formatted — pastes into email or Word looking like the card">
          {state.s === "copied" ? <Check className={icon} /> : <Copy className={icon} />}
          {state.s === "copied" ? `Copied — ${state.label}` : state.s === "failed" ? "Copy blocked" : "Copy"}
        </button>
        <button type="button" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu} title="Other ways to copy"
          className={`${primary} ${large ? "rounded-r-lg border-l border-orange-500/60 px-2" : "rounded-r-md border-l-0 px-1"}`}>
          <ChevronDown className={icon} />
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
            <div role="menu" className="absolute right-0 top-full mt-1 z-50 w-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl py-1">
              {COPY_OPTIONS.map((o) => (
                <button key={o.kind} role="menuitem" type="button" onClick={() => void copy(o.kind)}
                  className="w-full text-left px-3 py-2 hover:bg-[var(--color-surface-2)]">
                  <div className="text-[12.5px] font-bold text-[var(--color-text)]">{o.label}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">{o.hint}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <button type="button" onClick={print} className={secondary} title="Print, or choose Save as PDF in the print dialog">
        <Printer className={icon} /> {large ? "Print / save PDF" : "Print"}
      </button>
    </div>
  );
}

/** "I can settle this if you give me…" — what's missing, why, where the
 *  standards point to it, and a place to drop it. Dropped files ride with
 *  the next question; Rethink re-asks with them. */
function SettleBox({ items, inline, onAttach, onRethink }: {
  items: AnswerBlock[];
  inline: (text: string) => React.ReactNode;
  onAttach?: (files: File[]) => void;
  onRethink?: () => void;
}) {
  const [added, setAdded] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const pick = React.useRef<HTMLInputElement>(null);
  const take = (list: FileList | null) => {
    const files = list ? [...list] : [];
    if (files.length === 0 || !onAttach) return;
    onAttach(files);
    setAdded((a) => [...a, ...files.map((f) => f.name)]);
  };
  const best = items.filter((b) => /^\*{0,2}best answer/i.test(b.text));
  const needs = items.filter((b) => b.type !== "label" && !best.includes(b));
  return (
    <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-[var(--color-surface)] px-4 py-3.5 space-y-2.5">
      <div className="text-[14px] font-bold text-[var(--color-text)]">I can settle this if you give me:</div>
      <ul className="space-y-1.5">
        {needs.map((b, i) => (
          <li key={i} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 items-start text-[14px] leading-relaxed text-[var(--color-text)]">
            <span className="mt-2 w-1.5 h-1.5 rounded-full bg-slate-500" />
            <span>{inline(b.text)}</span>
          </li>
        ))}
      </ul>
      {best.map((b, i) => (
        <div key={i} className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)] border-t border-[var(--color-border)] pt-2">{inline(b.text)}</div>
      ))}
      {onAttach && (
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
          onClick={() => pick.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick.current?.click(); } }}
          role="button" tabIndex={0}
          className={`rounded-lg border-2 border-dashed px-3 py-3 text-center cursor-pointer transition-colors ${over
            ? "border-orange-500 bg-orange-50 dark:bg-orange-950/30"
            : "border-[var(--color-border)] hover:border-orange-400"}`}>
          <input ref={pick} id="settle-drop" type="file" multiple hidden
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
            onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
          <div className="text-[13px] font-bold text-[var(--color-text)] inline-flex items-center gap-1.5">
            <Upload className="w-3.5 h-3.5 text-orange-600" /> Drop the document here — or a photo of the page
          </div>
          <div className="text-[11.5px] text-[var(--color-text-muted)]">
            {added.length > 0 ? `Added: ${added.join(", ")} — it goes with the rethink` : "PDF or image · it's read for this question, not added to the library"}
          </div>
        </div>
      )}
      {onRethink && (
        <button type="button" onClick={onRethink}
          className="inline-flex items-center gap-1.5 text-[13px] font-bold px-3 py-1.5 rounded-md bg-orange-600 text-white hover:bg-orange-700 transition-colors">
          <RefreshCw className="w-3.5 h-3.5" /> {added.length > 0 ? "Rethink with what I added" : "Rethink the answer"}
        </button>
      )}
    </div>
  );
}

const MODES: Array<{ id: "answer" | "compliance" | "explore" | "deviation"; label: string; hint: string }> = [
  { id: "answer", label: "Direct answer", hint: "The answer and its proof, nothing extra" },
  { id: "compliance", label: "Compliance check", hint: "Does what was done meet the standard? Findings with quoted proof, and a note you can send" },
  { id: "deviation", label: "Deviation case", hint: "Why the rule exists, whether that reason applies to you, and a justification ready for the form" },
  { id: "explore", label: "Explore / design review", hint: "Broader — related rules and what to consider" },
];

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
  form: "Form", checklist: "Checklist", pipe_spec: "Piping spec", standard: "Standard",
  procedure: "Procedure", std_drawing: "Standard drawing", pid: "Drawing", datasheet: "Data sheet", other: "Document",
};

/** The helper: where the conversation seems to be heading, the next step
 *  that fits, and the library documents to use for it — forms to fill,
 *  checklists to open. Offered, never assumed. */
function HelperBand({ answer, mode, onRethink, onOpenDoc, onFill }: {
  answer: KnowledgeAnswer;
  mode: string;
  onRethink?: (m: "answer" | "compliance" | "explore" | "deviation") => void;
  onOpenDoc?: (d: DocLink) => void;
  onFill: (doc: NonNullable<KnowledgeAnswer["suggestedDocs"]>[number]) => void;
}) {
  const goal = answer.goal;
  const docs = answer.suggestedDocs ?? [];
  const step = goal?.kind === "deviation" && mode !== "deviation" ? { m: "deviation" as const, label: "Work up the deviation case" }
    : goal?.kind === "compliance" && mode !== "compliance" ? { m: "compliance" as const, label: "Run it as a compliance check" }
    : null;
  if (!goal && docs.length === 0) return null;
  return (
    <div className="rounded-xl border border-violet-200 dark:border-violet-900 bg-violet-50/60 dark:bg-violet-950/20 px-4 py-3 space-y-2.5">
      {goal && (
        <div className="text-[13.5px] leading-snug text-[var(--color-text)]">
          <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] text-violet-700 dark:text-violet-300 mr-1.5">Helper</span>
          Looks like you&apos;re working toward <b>{GOAL_LABEL[goal.kind] ?? goal.kind}</b>{goal.why ? <> — {goal.why}</> : null}.
        </div>
      )}
      {!goal && (
        <div className="font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] text-violet-700 dark:text-violet-300">From your library</div>
      )}
      {(step && onRethink) || docs.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {step && onRethink && (
            <button type="button" onClick={() => onRethink(step.m)}
              className="self-start inline-flex items-center gap-1.5 text-[13px] font-bold px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors">
              <RefreshCw className="w-3.5 h-3.5" /> {step.label}
            </button>
          )}
          {docs.map((d) => (
            <div key={d.documentId} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] px-3 py-2">
              <FileText className="w-4 h-4 text-violet-600 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-bold text-[var(--color-text)] truncate">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] mr-1.5">{DOC_TYPE_WORD[d.type] ?? "Document"}</span>
                  {d.name.replace(/\.pdf$/i, "")}
                </span>
                {d.why && <span className="block text-[12px] text-[var(--color-text-muted)] truncate">{d.why}</span>}
              </span>
              {d.form && (
                <button type="button" onClick={() => onFill(d)}
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-bold px-3 py-1.5 rounded-md bg-orange-600 text-white hover:bg-orange-700">
                  <PenLine className="w-3.5 h-3.5" /> Fill it in
                </button>
              )}
              {d.fileKey && onOpenDoc && (
                <button type="button" onClick={() => onOpenDoc({ id: d.documentId, name: d.name, fileKey: d.fileKey!, page: 1, mention: d.name })}
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-bold px-3 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-violet-400">
                  <Eye className="w-3.5 h-3.5" /> Open
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Under every answer: reshape it if it isn't what was needed. */
function RethinkBar({ mode, onRethink }: { mode: string; onRethink: (m: "answer" | "compliance" | "explore" | "deviation") => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[12px] text-[var(--color-text-muted)] mr-0.5">Not what you needed? Rethink as</span>
      {MODES.map((m) => (
        <button key={m.id} type="button" onClick={() => onRethink(m.id)} title={m.hint}
          className={`text-[12px] font-bold px-2.5 py-1 rounded-md border transition-colors ${mode === m.id
            ? "border-orange-400 bg-orange-50 dark:bg-orange-950/30 text-orange-800 dark:text-orange-200"
            : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-orange-400"}`}>
          {mode === m.id ? "✓ " : ""}{m.label}
        </button>
      ))}
    </div>
  );
}

/** The full answer, laid out answer-first: what the AI understood, the
 *  verdict, the short chain of why, what to check before acting, the one
 *  question that would finish it, and everything else collapsed — with the
 *  ranked proof trail beside it (below it on narrow screens). A cite tap
 *  jumps to its proof card instead of opening a floating popup. */
export function AnswerExperience({ question, answer, onCite, onOpenTag, onOpenDoc, onFollowup, onRethink, onAttach, showQuestion = true }: {
  question: string;
  answer: KnowledgeAnswer;
  /** The chat shell shows the question as its own bubble — no echo there. */
  showQuestion?: boolean;
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
  const webCitations = useMemo(() => answer.citations.filter((c) => !!c.url && answer.knowledgeSource === "documents_and_web"), [answer.citations, answer.knowledgeSource]);
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
      // A cited library passage: open its proof card in the trail and bring
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
        <span title="No citation — this line isn't tied to a page in your documents. Don't rely on it without checking."
          className="ml-1.5 inline-block align-baseline px-1.5 rounded font-mono text-[10px] font-bold bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 whitespace-nowrap">
          no source
        </span>
      )}
    </>
  );
  // Why: numbered steps; headings become small group labels.
  const renderWhy = (blocks: AnswerBlock[]) => {
    let n = 0;
    return blocks.map((b, i) => {
      if (b.type === "label") {
        return <div key={i} className="pt-1 text-[12px] font-bold text-[var(--color-text-muted)]">{b.text}</div>;
      }
      if (b.type === "bullet") {
        n += 1;
        return (
          <div key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 items-start">
            <span className="mt-0.5 w-6 h-6 rounded-full border border-[var(--color-border)] font-mono text-[11px] text-[var(--color-text-muted)] flex items-center justify-center">{n}</span>
            <div className="text-[14px] leading-relaxed text-[var(--color-text)]">{sourced(b.text)}</div>
          </div>
        );
      }
      return <p key={i} className="text-[14px] leading-relaxed text-[var(--color-text)]">{sourced(b.text)}</p>;
    });
  };
  // Before you act: a checklist; "!" lines are the MUSTs and look it.
  const renderBefore = (blocks: AnswerBlock[]) => blocks.map((b, i) => {
    if (b.type === "label") {
      return <div key={i} className="pt-1 text-[12px] font-bold text-[var(--color-text-muted)]">{b.text}</div>;
    }
    if (b.type === "important") {
      return (
        <div key={i} className="grid grid-cols-[1.125rem_minmax(0,1fr)] gap-2 items-start rounded-md bg-amber-50 dark:bg-amber-950/30 px-2 py-1.5">
          <AlertTriangle className="mt-0.5 w-4 h-4 text-amber-600" />
          <div className="text-[14px] font-semibold leading-relaxed text-amber-950 dark:text-amber-100">{sourced(b.text)}</div>
        </div>
      );
    }
    return (
      <div key={i} className="grid grid-cols-[1.125rem_minmax(0,1fr)] gap-2 items-start px-2">
        <span className="mt-1 w-3.5 h-3.5 rounded-[3px] border-[1.5px] border-[var(--color-text-muted)]" />
        <div className="text-[14px] leading-relaxed text-[var(--color-text)]">{sourced(b.text)}</div>
      </div>
    );
  });

  const verdictKey: Verdict | "none" = heroV?.verdict ?? "none";

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
        goal={answer.goal ? `${answer.goal.kind}${answer.goal.why ? ` — ${answer.goal.why}` : ""}` : undefined}
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
    <div className={`${showQuestion ? "mt-4" : ""} space-y-3 @container`}>
      {showQuestion && (
        <div className="text-[11px] text-[var(--color-text-muted)] animate-rise">
          You asked: <i>&ldquo;{question}&rdquo;</i>
        </div>
      )}

      {/* A REPLAYED answer must never masquerade as a fresh run. */}
      {answer.provider === "memory" && (
        <div className="rounded-xl border-2 border-violet-300 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 px-3.5 py-2.5 text-[11px] font-bold text-violet-800 dark:text-violet-300 flex items-center gap-2">
          <History className="w-4 h-4 shrink-0" />
          <span>
            <b className="font-black">Replayed from your team&apos;s record</b> — this is a PAST answer, shown
            without a new AI run. Its wording and formatting are whatever was saved at the time. Use
            &ldquo;Ask fresh anyway&rdquo; on the asked-before card for a new run.
          </span>
        </div>
      )}

      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden animate-rise">
        <div className="grid @min-[760px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          {/* ── The answer column ── */}
          <div className="min-w-0 p-4 sm:p-5 space-y-5">
            {/* Header bar: what kind of answer this is, and the one place to
                send it — always visible at the top, never hunted for. */}
            <div className="flex items-center justify-between gap-2 flex-wrap pb-3 border-b border-[var(--color-border)]">
              <span className="inline-flex items-center gap-2 flex-wrap">
                <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                  {MODES.find((m) => m.id === mode)?.label ?? "Direct answer"}
                </span>
                {/* What this answer was allowed to draw on — visible, not assumed. */}
                {answer.knowledgeSource === "documents" && (
                  <span title="Every statement is cited to a page in this library, or is something you said — no AI training knowledge, no web"
                    className="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300">
                    <ShieldCheck className="w-3 h-3" /> Documents only
                  </span>
                )}
                {answer.knowledgeSource === "documents_and_web" && (
                  <span title="Web was on for this question: documents first and they govern; every web statement links to the page it came from"
                    className="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-sky-100 dark:bg-sky-950/40 text-sky-800 dark:text-sky-300">
                    <Globe className="w-3 h-3" /> Documents + web{webCitations.length > 0 ? ` · ${webCitations.length} web source${webCitations.length === 1 ? "" : "s"}` : " · web not needed"}
                  </span>
                )}
              </span>
              <ExportButtons question={question} answer={answer} large />
            </div>

            {(answer.answeringFor ?? []).length > 0 && (
              <AnsweringFor chips={answer.answeringFor!} onCorrect={onFollowup} />
            )}

            <div className={`rounded-xl border px-4 py-3.5 ${VERDICT_BOX[verdictKey]}`}>
              <div className="flex items-start justify-between gap-2">
                {heroV?.verdict
                  ? <VerdictBadge verdict={heroV.verdict} />
                  : <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] text-orange-700 dark:text-orange-400">Answer</span>}
              </div>
              <div className="mt-1 text-[16.5px] font-semibold leading-snug text-[var(--color-text)]">
                {heroV ? inline(heroV.text) : <AnswerView answer={answer.answer} citations={answer.citations} onCite={onCite} />}
              </div>
            </div>

            <HelperBand answer={answer} mode={mode} onRethink={onRethink} onOpenDoc={onOpenDoc} onFill={setFilling} />

            {heroV && parts.settle.length > 0 && (
              <SettleBox items={parts.settle} inline={inline} onAttach={onAttach}
                onRethink={onRethink ? () => onRethink(mode) : undefined} />
            )}

            {heroV && parts.why.length > 0 && (
              <div>
                <PartHead>{mode === "compliance" ? "Findings" : "Why"}</PartHead>
                <div className="space-y-2.5">{renderWhy(parts.why)}</div>
              </div>
            )}

            {heroV && parts.trail.length > 0 && (
              <details className="group rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 px-3 py-2">
                <summary className="cursor-pointer list-none flex items-center gap-1.5 text-[12.5px] font-bold text-[var(--color-text)]">
                  <ChevronRight className="w-3.5 h-3.5 transition-transform group-open:rotate-90" />
                  Engineering trail — the full chain, step by step
                  <span className="font-mono text-[10.5px] font-normal text-[var(--color-text-faint)]">{parts.trail.filter((b) => b.type !== "label").length} steps</span>
                </summary>
                <div className="mt-2.5 space-y-2.5">{renderWhy(parts.trail)}</div>
              </details>
            )}

            {heroV && parts.before.length > 0 && (
              <div>
                <PartHead>{mode === "compliance" ? "Required corrections" : "Before you act"}</PartHead>
                <div className="space-y-1.5">{renderBefore(parts.before)}</div>
              </div>
            )}

            {heroV && parts.dontMiss.length > 0 && (
              <div className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50/60 dark:bg-rose-950/20 px-3 py-2.5">
                <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] text-rose-700 dark:text-rose-300 mb-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> Don&apos;t miss
                </div>
                <div className="space-y-1.5">
                  {parts.dontMiss.filter((b) => b.type !== "label").map((b, i) => (
                    <div key={i} className="text-[14px] leading-relaxed text-[var(--color-text)]">{sourced(b.text)}</div>
                  ))}
                </div>
              </div>
            )}

            {answer.followup && (
              <OneQuestion followup={answer.followup} onAnswer={onFollowup} />
            )}

            {heroV && parts.more.length > 0 && (
              <details className="group border-t border-[var(--color-border)] pt-3">
                <summary className="cursor-pointer list-none flex items-center gap-1.5 text-[12.5px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                  <ChevronRight className="w-3.5 h-3.5 transition-transform group-open:rotate-90" />
                  More — related rules, drafts, what would go further
                </summary>
                <div className="mt-2">
                  <SectionedBlocks key={answer.answer} blocks={parts.more} citations={answer.citations} onCite={onCite} />
                </div>
              </details>
            )}

            {onRethink && answer.mode !== "internet" && <RethinkBar mode={mode} onRethink={onRethink} />}

            <div className="pt-3 border-t border-[var(--color-border)] flex items-center gap-2 flex-wrap text-[10px] text-[var(--color-text-muted)]">
              {canShape && shapeOrgId && shapeUid && (
                <button onClick={() => setShaping(true)}
                  title="AI proposes how this answer attributes to the org graph — you curate, it writes"
                  className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-[var(--color-border)] hover:border-violet-400 hover:text-violet-700 dark:hover:text-violet-300 transition-colors">
                  <Waypoints className="w-3 h-3" /> Shape the graph
                </button>
              )}
              <span className="font-bold ml-auto">{answer.provider} · {answer.model}</span>
              <span>·</span>
              <span>{libraryCitations.length} source{libraryCitations.length === 1 ? "" : "s"}</span>
              <span>·</span>
              {/* Version beacon: which renderer produced this card. */}
              <span className="font-black text-orange-600/70" title="Answer renderer version">fmt14</span>
            </div>
          </div>

          {/* ── The proof trail ── */}
          <aside className="min-w-0 p-4 sm:p-5 border-t @min-[760px]:border-t-0 @min-[760px]:border-l border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
            <div className="flex items-baseline justify-between gap-2 mb-3">
              <h3 className="text-[15px] font-black text-[var(--color-text)]">Proof</h3>
              <span className="font-mono text-[10px] text-[var(--color-text-faint)]">tap a number in the answer to jump here</span>
            </div>
            <ProofTrail citations={libraryCitations} onOpen={onCite} openSet={openSet} onToggle={toggle}
              showRelated={showRelated} onShowRelated={setShowRelated} flashN={flashN} idPrefix={idPrefix} />
            {webCitations.length > 0 && (
              <div className="mt-5 space-y-2">
                <div className="flex items-center gap-2 font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] text-sky-700 dark:text-sky-300">
                  <Globe className="w-3.5 h-3.5" /> From the web <span className="text-[var(--color-text-faint)]">{webCitations.length}</span>
                </div>
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  Not your controlled documents. A web page about a code is not the code — verify against the publication.
                </p>
                {webCitations.map((c) => {
                  let host = c.url ?? "";
                  try { host = new URL(c.url ?? "").hostname.replace(/^www\./, ""); } catch { /* keep */ }
                  return (
                    <div key={c.n} id={`${idPrefix}-w-${c.n}`}
                      className={`rounded-xl border bg-[var(--color-surface)] px-3 py-2.5 space-y-1.5 scroll-mt-24 transition-shadow duration-300 ${flashN === c.n
                        ? "border-sky-500 shadow-[0_0_0_3px_rgba(14,165,233,0.25)]" : "border-[var(--color-border)]"}`}>
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 min-w-[1.375rem] h-[1.375rem] px-1 rounded-md bg-sky-100 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 font-mono text-[11px] font-bold flex items-center justify-center">{c.n}</span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-bold text-[var(--color-text)] leading-snug">{c.title ?? host}</span>
                          <span className="block font-mono text-[10px] text-[var(--color-text-muted)] truncate">{host}</span>
                        </span>
                      </div>
                      {c.quote && (
                        <blockquote className="border-l-[3px] border-sky-300 dark:border-sky-800 bg-[var(--color-surface-2)]/50 rounded-r-md pl-3 pr-2 py-1.5 text-[12.5px] leading-relaxed text-[var(--color-text)] italic">
                          &ldquo;{c.quote}&rdquo;
                        </blockquote>
                      )}
                      <div className="flex items-center gap-2 flex-wrap">
                        <a href={c.url} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-md border border-[var(--color-border)] text-[var(--color-text)] hover:border-sky-400">
                          <ExternalLink className="w-3 h-3 text-sky-600" /> Open the page
                        </a>
                        {c.quote && <CopyButton text={referencedQuote(c)} label="Copy quote" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* Interactive equipment register — the deterministic table behind
          "show me all equipment". Every sheet chip rings the tag. */}
      {answer.equipmentTable && onOpenTag && (
        <EquipmentTablePanel table={answer.equipmentTable} onOpenTag={onOpenTag} />
      )}

      {/* You-need-this-book cards: referenced documents no library holds */}
      {(answer.missingDocs ?? []).length > 0 && (
        <div className="rounded-2xl border-2 border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 p-4 animate-rise">
          <div className="flex items-center gap-2 text-sm font-black text-rose-800 dark:text-rose-300 mb-1.5">
            <BookOpen className="w-4 h-4" /> You need {answer.missingDocs!.length === 1 ? "this document" : "these documents"}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {answer.missingDocs!.map((d) => (
              <span key={d} className="text-[11px] font-black px-2.5 py-1 rounded-lg bg-white dark:bg-rose-950/60 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200">
                {d}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-rose-700 dark:text-rose-400">
            The passages reference {answer.missingDocs!.length === 1 ? "this document" : "these documents"} for part of the answer,
            but {answer.missingDocs!.length === 1 ? "it isn't" : "they aren't"} in this library or its linked libraries —
            add {answer.missingDocs!.length === 1 ? "it" : "them"} to a linked library or pull the physical copy.
          </p>
        </div>
      )}
    </div>
    </ProofContext.Provider>
    </DocLinkContext.Provider>
  );
}

/** Thumbs on an answer — the loop that makes retrieval smarter with use.
 *  A 👍 stores the verdict on the answer's history row; future similar
 *  questions pull that answer's cited pages into the passage pool first. */
export function AnswerFeedback({ questionId, onRated }: {
  questionId: string;
  /** Called with the verdict after it is stored (0 = cleared). */
  onRated?: (rating: 1 | -1 | 0) => void;
}) {
  const [state, setState] = useState<1 | -1 | 0>(0);
  const rate = async (r: 1 | -1) => {
    const next = state === r ? 0 : r;    // clicking again clears the rating
    setState(next);
    onRated?.(next);
    try {
      const { rateKnowledgeAnswer } = await import("@/lib/knowledge");
      await rateKnowledgeAnswer(questionId, next);
    } catch { /* best-effort — never interrupt reading the answer */ }
  };
  const btn = (active: boolean) =>
    `p-1.5 rounded-lg border transition-colors ${active
      ? "border-[var(--color-primary)] text-[var(--color-primary)] bg-[var(--color-primary)]/10"
      : "border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`;
  return (
    <div className="mt-2 flex items-center justify-end gap-2 text-[11px] text-[var(--color-text-muted)]">
      {state === 1 && <span className="font-bold text-emerald-600 dark:text-emerald-400">Saved — similar questions will start from these pages.</span>}
      {state === -1 && <span className="font-bold">Noted — this answer will not guide future retrieval.</span>}
      {state === 0 && <span className="font-bold">Did this answer it?</span>}
      <button onClick={() => void rate(1)} className={btn(state === 1)} title="Right answer — teach retrieval these pages">
        <ThumbsUp className="w-3.5 h-3.5" />
      </button>
      <button onClick={() => void rate(-1)} className={btn(state === -1)} title="Wrong or missed the point">
        <ThumbsDown className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function CitationChips({ citations, onOpen }: {
  citations: KnowledgeCitation[];
  onOpen: (c: KnowledgeCitation) => void;
}) {
  if (citations.length === 0) return null;
  return (
    <div className="mt-3 space-y-1.5">
      {citations.map((c) => c.url ? (
        // Internet citation → the web source itself.
        <a key={c.n} href={c.url} target="_blank" rel="noopener noreferrer"
          title={c.url}
          className="inline-flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded-lg border border-sky-300 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-800 text-sky-800 dark:text-sky-300 hover:bg-sky-100 transition-colors mr-1.5">
          <Globe className="w-2.5 h-2.5" /> {(c.title ?? c.url).slice(0, 40)}
          <ExternalLink className="w-2.5 h-2.5" />
        </a>
      ) : (
        // Library citation → expandable verbatim passage + open-in-viewer.
        <details key={c.n} className="group rounded-xl border border-orange-200 dark:border-orange-900 bg-orange-50/50 dark:bg-orange-950/20 overflow-hidden">
          <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
            <ChevronRight className="w-3.5 h-3.5 text-orange-600 transition-transform group-open:rotate-90 shrink-0" />
            <span className="text-[11px] font-black text-orange-800 dark:text-orange-300 truncate">
              [{c.n}] {(c.documentName ?? "Document").replace(/\.pdf$/i, "").slice(0, 40)}
              {c.section ? <span className="text-orange-600/80"> · {c.section.slice(0, 36)}</span> : ""} · p.{c.page}
            </span>
            <span className="ml-auto shrink-0 text-[9px] font-bold uppercase tracking-wider text-orange-600/70 group-open:hidden">view source</span>
          </summary>
          <div className="px-3 pb-3">
            {c.quote ? (
              <blockquote className="border-l-2 border-orange-400 pl-3 py-1 text-[11px] leading-relaxed text-[var(--color-text)] bg-[var(--color-surface)] rounded-r-lg whitespace-pre-wrap max-h-40 overflow-y-auto">
                {c.quote}
              </blockquote>
            ) : (
              <p className="text-[11px] text-[var(--color-text-muted)] italic">Passage text wasn&apos;t stored for this older answer — open the page to read it.</p>
            )}
            <button onClick={() => onOpen(c)}
              className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-black px-2.5 py-1.5 rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors">
              <ExternalLink className="w-3 h-3" /> Open page {c.page} — passage highlighted
            </button>
          </div>
        </details>
      ))}
    </div>
  );
}


// ── While the answer is being written ────────────────────────────────────────
//
// Nobody should watch raw text typing itself out. Until the Answer line is
// complete the reader sees the card's own shape, shimmering, with a stage
// tracker that follows the real pipeline. The moment the Answer line lands
// it takes its place in the card; Why and the checklist fill in step by
// step; the proof column waits for the evidence and says so.

const STAGES = [
  { label: "Understanding the question", match: /starting|attachment|search queries/i },
  { label: "Searching the library", match: /searching the library|nothing matched|rewriting the search/i },
  { label: "Following references", match: /reviewing|chasing/i },
  { label: "Reading the pages", match: /printed page|fetched page|reading \d/i },
  { label: "Writing the answer", match: /composing|answering/i },
  { label: "Attaching proof", match: /$^/ },
];

const EVIDENCE_SPLIT = /\n\s*(?:#{1,4}\s*)?\*{0,2}Evidence:?\*{0,2}:?\s*(?:\n|$)/i;

function Shimmer({ className }: { className: string }) {
  return (
    <div aria-hidden
      className={`rounded-md bg-[linear-gradient(90deg,var(--color-surface-2)_0%,var(--color-border)_50%,var(--color-surface-2)_100%)] bg-[length:200%_100%] motion-safe:animate-[shimmer_1.8s_linear_infinite] ${className}`} />
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
      <div className="flex items-center gap-2 text-[11.5px] text-[var(--color-text-muted)]" role="status" aria-live="polite">
        <span className="relative flex w-2 h-2">
          <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-60" />
          <span className="relative inline-flex rounded-full w-2 h-2 bg-orange-500" />
        </span>
        {STAGES[stage].label}<span className="text-[var(--color-text-faint)]">· {elapsed}s</span>
      </div>
    );
  }
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <div className="flex items-center gap-1.5">
        {STAGES.map((s, i) => (
          <div key={s.label} className="flex-1 h-1 rounded-full overflow-hidden bg-[var(--color-surface-2)]">
            <div className={`h-full rounded-full transition-all duration-700 ease-out ${i < stage ? "w-full bg-orange-500"
              : i === stage ? "w-full bg-[linear-gradient(90deg,#f97316_0%,#fdba74_50%,#f97316_100%)] bg-[length:200%_100%] motion-safe:animate-[shimmer_1.6s_linear_infinite]"
              : "w-0"}`} />
          </div>
        ))}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[14px] font-bold text-[var(--color-text)]">{STAGES[stage].label}</div>
        <div className="font-mono text-[11px] text-[var(--color-text-faint)] tabular-nums">{elapsed}s</div>
      </div>
      {status && !STAGES[stage].label.toLowerCase().startsWith(status.toLowerCase().slice(0, 12)) && (
        <div className="-mt-2 text-[12px] text-[var(--color-text-muted)]">{status}</div>
      )}
    </div>
  );
}

/** The answer card, filling in as the answer streams. `draft` is the raw
 *  streamed text; only COMPLETE lines are shown, so nothing ever types. */
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

  return (
    <div className="@container">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden">
        <div className="grid @min-[760px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="min-w-0 p-4 sm:p-5 space-y-5">
            <StageTracker stage={stage} status={status} compact={!!heroV} />

            {meta.answeringFor.length > 0 ? (
              <div style={reveal}><AnsweringFor chips={meta.answeringFor} /></div>
            ) : !heroV && (
              <div className="flex gap-1.5"><Shimmer className="h-6 w-24 rounded-full" /><Shimmer className="h-6 w-32 rounded-full" /><Shimmer className="h-6 w-20 rounded-full" /></div>
            )}

            {heroV ? (
              <div style={reveal} className={`rounded-xl border px-4 py-3.5 ${VERDICT_BOX[heroV.verdict ?? "none"]}`}>
                {heroV.verdict
                  ? <VerdictBadge verdict={heroV.verdict} />
                  : <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] text-orange-700 dark:text-orange-400">Answer</span>}
                <div className="mt-1 text-[16.5px] font-semibold leading-snug text-[var(--color-text)]">{inline(heroV.text)}</div>
              </div>
            ) : (
              <div className="rounded-xl border border-[var(--color-border)] px-4 py-4 space-y-2.5">
                <Shimmer className="h-5 w-36" />
                <Shimmer className="h-4 w-full" />
                <Shimmer className="h-4 w-5/6" />
              </div>
            )}

            {heroV && (
              <div>
                <PartHead>Why</PartHead>
                <div className="space-y-2.5">
                  {parts.why.filter((b) => b.type !== "label").map((b, i) => (
                    <div key={i} style={reveal} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 items-start">
                      <span className="mt-0.5 w-6 h-6 rounded-full border border-[var(--color-border)] font-mono text-[11px] text-[var(--color-text-muted)] flex items-center justify-center">{i + 1}</span>
                      <div className="text-[14px] leading-relaxed text-[var(--color-text)]">{inline(b.text)}</div>
                    </div>
                  ))}
                  {parts.before.length === 0 && !inEvidence && (
                    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 items-center">
                      <Shimmer className="w-6 h-6 rounded-full" /><Shimmer className="h-4 w-4/5" />
                    </div>
                  )}
                </div>
              </div>
            )}

            {heroV && parts.before.length > 0 && (
              <div style={reveal}>
                <PartHead>Before you act</PartHead>
                <div className="space-y-1.5">
                  {parts.before.filter((b) => b.type !== "label").map((b, i) => (
                    <div key={i} style={reveal} className="grid grid-cols-[1.125rem_minmax(0,1fr)] gap-2 items-start px-2">
                      {b.type === "important"
                        ? <AlertTriangle className="mt-0.5 w-4 h-4 text-amber-600" />
                        : <span className="mt-1 w-3.5 h-3.5 rounded-[3px] border-[1.5px] border-[var(--color-text-muted)]" />}
                      <div className="text-[14px] leading-relaxed text-[var(--color-text)]">{inline(b.text)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!heroV && (
              <div className="space-y-2.5">
                {["w-11/12", "w-3/4", "w-5/6"].map((w) => (
                  <div key={w} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 items-center">
                    <Shimmer className="w-6 h-6 rounded-full" /><Shimmer className={`h-4 ${w}`} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <aside className="min-w-0 p-4 sm:p-5 border-t @min-[760px]:border-t-0 @min-[760px]:border-l border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
            <div className="flex items-baseline justify-between gap-2 mb-3">
              <h3 className="text-[15px] font-black text-[var(--color-text)]">Proof</h3>
              <span className="font-mono text-[10px] text-[var(--color-text-faint)]">
                {inEvidence ? "marking the exact words on each page" : "arrives with the answer"}
              </span>
            </div>
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2">
                  <div className="flex items-center gap-2.5"><Shimmer className="w-6 h-6" /><Shimmer className="h-4 flex-1" /></div>
                  <Shimmer className="h-3 w-2/5" />
                  <Shimmer className="h-12 w-full" />
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
