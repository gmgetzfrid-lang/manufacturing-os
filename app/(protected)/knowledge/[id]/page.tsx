"use client";

// /knowledge/[id] — one AI knowledge library: the Ask box up top (that's the
// whole point), the shelf of PDFs below it with live indexing progress, and
// the recent Q&A so the team benefits from each other's questions.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  BookOpen, ArrowLeft, Sparkles, Loader2, Send, FileText, Upload,
  Trash2, RefreshCw, CheckCircle2, AlertTriangle, ExternalLink, History, Globe,
  ChevronRight, ChevronDown, Copy, Check, Search, ScanSearch, PenLine, Quote, Wand2, Eye, MessageSquare,
  ThumbsUp, ThumbsDown, X, Waypoints,
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { appConfirm } from "@/components/providers/DialogProvider";
import { parseAnswerBlocks, extractCitationNumbers, proofTerms, highlightQuote, type AnswerBlock } from "@/lib/knowledgeText";
import {
  getKnowledgeLibrary, listKnowledgeDocuments, addKnowledgeDocument,
  ingestKnowledgeDocument, deleteKnowledgeDocument, deleteKnowledgeLibrary,
  askKnowledgeLibrary, listKnowledgeQuestions, listLibraryLinks, acceptAiAgreement,
  parseNeedPrompt,
  type AgreementRequiredError,
  type KnowledgeLibrary, type KnowledgeDocument, type KnowledgeAnswer,
  type KnowledgeQuestion, type KnowledgeCitation, type AskMode,
  type KnowledgeLibraryLink,
  rebuildDrawingIndex,
} from "@/lib/knowledge";
import GraphShapeWizard from "@/components/graph/GraphShapeWizard";
import LibraryAiModal from "@/components/knowledge/LibraryAiModal";
import SourcesPanel from "@/components/knowledge/SourcesPanel";
import DrawingIntelPanel from "@/components/knowledge/DrawingIntelPanel";
import SemanticIndexPanel from "@/components/knowledge/SemanticIndexPanel";
import EquipmentTablePanel from "@/components/knowledge/EquipmentTablePanel";

// pdf.js only loads when someone actually opens a cited page.
const CitedPageViewer = dynamic(() => import("@/components/knowledge/CitedPageViewer"), { ssr: false });

interface ViewerTarget {
  fileKey: string;
  page: number;
  quote: string | null;
  title: string;
  section?: string | null;
  /** Drawings: the sheet and the tags to point at on it. */
  documentId?: string;
  tags?: string[];
  /** The answer's full evidence trail — 2+ entries grow the viewer's
   *  Previous/Next source carousel. */
  sources?: Array<{
    fileKey: string; page: number; quote: string | null; title: string;
    section?: string | null; documentId?: string; tags?: string[]; n?: number;
  }>;
  sourceIndex?: number;
}

/** A document the answer NAMES, clickable in place. "per EP 5-6-2" with no
 *  [n] used to be a dead end — the reader was told a document matters and
 *  given no way to open it. Provided per-answer by AnswerExperience; the
 *  default (no links, no opener) leaves older saved answers unchanged. */
type DocLink = NonNullable<KnowledgeAnswer["mentionedDocs"]>[number];
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

function ProofCard({ proof, onClose, onOpenPage }: {
  proof: ProofState;
  onClose: () => void;
  onOpenPage: (c: KnowledgeCitation) => void;
}) {
  const { citation: c, context } = proof;
  const segs = useMemo(() => highlightQuote(c.quote ?? "", proofTerms(context)), [c.quote, context]);
  const hits = segs.filter((s) => s.hit).length;
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
          {c.quote ? (
            <blockquote className="border-l-2 border-orange-400 pl-3 py-1 text-[12px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap max-h-52 overflow-y-auto">
              {segs.map((s, i) => s.hit
                ? <mark key={i} className="rounded px-0.5 bg-orange-200 dark:bg-orange-800/70 text-inherit font-bold">{s.text}</mark>
                : <React.Fragment key={i}>{s.text}</React.Fragment>)}
            </blockquote>
          ) : (
            <p className="text-[11px] italic text-[var(--color-text-muted)]">
              The passage text wasn&apos;t stored for this answer — open the page to read it in the document.
            </p>
          )}
          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
            <button onClick={() => onOpenPage(c)}
              className="inline-flex items-center gap-1.5 text-[11px] font-black px-3 py-1.5 rounded-lg bg-orange-600 text-white shadow-sm hover:bg-orange-700 transition-colors">
              <Eye className="w-3.5 h-3.5" /> Open the page — highlighted
            </button>
            {hits > 0 && (
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
function InlineAnswer({ text, citations, onCite }: {
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
  const parts = text.split(new RegExp(`(\\[\\d{1,3}\\]|\\*\\*[^*]+\\*\\*|\`[^\`]+\`${mentionAlt ? `|${mentionAlt}` : ""})`, "g"));
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
        const cite = part.match(/^\[(\d{1,3})\]$/);
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
          return <span key={i} className="align-super text-[10px] font-black text-orange-700/80">{cite[1]}</span>;
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
        void navigator.clipboard.writeText(value).then(() => {
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
function AnswerView({ answer, citations, onCite }: {
  answer: string;
  citations: KnowledgeCitation[];
  onCite: (c: KnowledgeCitation) => void;
}) {
  const blocks = parseAnswerBlocks(answer);
  const hero = blocks[0]?.type === "hero" ? blocks[0] : null;
  const rest = hero ? blocks.slice(1) : blocks;
  return (
    <div className="space-y-2.5">
      {hero && (
        <div className="rounded-xl border-l-4 border-orange-500 bg-orange-50 dark:bg-orange-950/30 px-4 py-3">
          <div className="text-[9px] font-black uppercase tracking-[0.18em] text-orange-600 mb-1">Answer</div>
          <div className="text-base font-bold text-[var(--color-text)] leading-snug">
            <InlineAnswer text={hero.text} citations={citations} onCite={onCite} />
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

function AskProgress() {
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
function ClarifyCard({ prompt, options, onAnswer }: {
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
function NeedCard({ prompt, onProvide }: {
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

function CopyButton({ text, label, onDark }: { text: string; label: string; onDark?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      title={label}
      className={`inline-flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded-lg border transition-colors ${onDark
        ? "border-white/25 text-slate-300 hover:text-white hover:bg-white/10"
        : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
      {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />} {copied ? "Copied" : label}
    </button>
  );
}

/** One source = one compact ROW. The answer above already synthesized this
 *  material — showing quote previews by default read as the same info twice.
 *  Collapsed: identifiers only. Expanded (one tap): the verbatim quote +
 *  view-highlighted-page. Evidence stays one gesture away without competing
 *  with the answer. */
function SourceCard({ citation, onOpen, delay }: {
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
          {c.quote ? (
            <blockquote className="border-l-2 border-orange-400 pl-3 py-1 text-[11px] leading-relaxed text-[var(--color-text-muted)] whitespace-pre-wrap max-h-64 overflow-y-auto">
              {c.quote}
            </blockquote>
          ) : (
            <p className="text-[11px] text-[var(--color-text-muted)] italic">Passage text wasn&apos;t stored for this answer — open the page to read it.</p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => onOpen(c)}
              className="inline-flex items-center gap-1.5 text-[10px] font-black px-2.5 py-1.5 rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors">
              <ExternalLink className="w-3 h-3" /> View highlighted page
            </button>
            {c.quote && <CopyButton text={c.quote} label="Copy quote" />}
            {c.tier && c.libraryName && (
              <span className="ml-auto text-[9px] text-[var(--color-text-muted)] font-bold">{c.libraryName}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The full answer experience: question echo → hero answer card → basis →
 *  check callout → source cards. Cards, air, hierarchy — never a wall. */
function AnswerExperience({ question, answer, onCite, onOpenTag, onOpenDoc }: {
  question: string;
  answer: KnowledgeAnswer;
  onCite: (c: KnowledgeCitation) => void;
  /** Open a sheet in the viewer with a tag ringed (equipment table rows). */
  onOpenTag?: (documentId: string, page: number, tag: string, documentName: string) => void;
  /** Open a document the answer names (show-me chips). */
  onOpenDoc?: (d: DocLink) => void;
}) {
  const blocks = parseAnswerBlocks(answer.answer);
  const hero = blocks.find((b) => b.type === "hero");
  const rest = blocks.filter((b) => b !== hero);
  // Imperatives (! lines) stay visible even collapsed — never hide a MUST or
  // a hold point behind a button.
  const importantBlocks = rest.filter((b) => b.type === "important");
  const detailBlocks = rest.filter((b) => b.type !== "important");
  // The sectioned detail IS the answer for checklist questions — it shows
  // by default; the button collapses it for readers who only want the hero.
  const [elaborated, setElaborated] = useState(true);
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
  const proofCtx = useMemo(() => ({
    show: (c: KnowledgeCitation, context: string, anchor: DOMRect) => {
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
  }), []);
  const libraryCitations = answer.citations.filter((c) => !c.url);

  // PRIORITY ORDER, everywhere. The order the ANSWER cites things is the
  // order the reader needs them — not citation-number order, which is just
  // retrieval order. The direct answer's own sources surface first as
  // named-document buttons in the hero; the source pile below groups by
  // document, most-load-bearing document first, collapsed past the top.
  const citeByN = new Map(libraryCitations.map((c) => [c.n, c]));
  const answerOrder = extractCitationNumbers(answer.answer);
  const heroSources = (() => {
    if (!hero) return [] as KnowledgeCitation[];
    const seen = new Set<string>();
    const out: KnowledgeCitation[] = [];
    // The run-on explosion can move every [n] out of the headline into the
    // Key-points bullets — which silently ERASED the Sources strip. The
    // strip must survive that: fall back to the answer's first-used
    // citations whenever the headline itself carries none.
    const heroNs = extractCitationNumbers(hero.text);
    for (const n of (heroNs.length > 0 ? heroNs : answerOrder)) {
      const c = citeByN.get(n);
      const key = c?.documentName ?? "";
      if (c && !seen.has(key)) { seen.add(key); out.push(c); }
      if (out.length >= 4) break;
    }
    return out;
  })();
  const sourceGroups = (() => {
    const rank = new Map<number, number>();
    answerOrder.forEach((n, i) => rank.set(n, i));
    const byDoc = new Map<string, KnowledgeCitation[]>();
    for (const c of libraryCitations) {
      const key = c.documentName ?? "Document";
      byDoc.set(key, [...(byDoc.get(key) ?? []), c]);
    }
    const groups = [...byDoc.entries()].map(([doc, cites]) => ({
      doc,
      cites: [...cites].sort((a, b) =>
        (rank.get(a.n) ?? 9999) - (rank.get(b.n) ?? 9999)),
      first: Math.min(...cites.map((c) => rank.get(c.n) ?? 9999)),
    }));
    groups.sort((a, b) => a.first - b.first);
    return groups;
  })();
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [allSources, setAllSources] = useState(false);
  const visibleGroups = allSources ? sourceGroups : sourceGroups.slice(0, 4);

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
    <div className="mt-4 space-y-3">
      <div className="text-[11px] text-[var(--color-text-muted)] animate-rise">
        You asked: <i>&ldquo;{question}&rdquo;</i>
      </div>

      {/* A REPLAYED answer must never masquerade as a fresh run. The subtle
          "memory · past answer" footer was missed for days while a stale
          record kept answering a repeated question — say it loudly. */}
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

      {/* Hero answer card */}
      <div className="rounded-2xl border-2 border-orange-400 dark:border-orange-700 bg-[var(--color-surface)] shadow-lg overflow-hidden animate-pop">
        {/* Living top rule: a slow sheen drifts along the gradient — quiet
            proof the page is alive. Disabled for reduced-motion users. */}
        <div
          className="h-1.5 bg-gradient-to-r from-orange-500 via-amber-400 to-orange-500 motion-safe:animate-[shimmer_6s_linear_infinite]"
          style={{ backgroundSize: "200% 100%" }}
        />
        {/* THE ANSWER — a light frosted band with an orange spine. The dark
            plaque read as a harsh speedbump (design review); separation now
            comes from tone + the accent border, not a black block. */}
        <div className={hero
          ? "px-4 sm:px-5 py-4 border-l-4 border-orange-500 bg-[var(--color-surface-2)]/60 backdrop-blur-sm"
          : "px-4 sm:px-5 pt-4"}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-orange-600">
              <span aria-hidden className="relative flex w-1.5 h-1.5">
                <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-60" style={{ animationDuration: "2.4s" }} />
                <span className="relative inline-flex rounded-full w-1.5 h-1.5 bg-orange-500" />
              </span>
              Answer
            </div>
            <CopyButton text={answer.answer} label="Copy answer" />
          </div>
          {hero ? (
            <div className="text-[17px] font-black text-[var(--color-text)] leading-relaxed">
              <InlineAnswer text={hero.text} citations={answer.citations} onCite={onCite} />
            </div>
          ) : (
            <AnswerView answer={answer.answer} citations={answer.citations} onCite={onCite} />
          )}

          {/* THE documents behind the direct answer — real buttons that open
              the real paper. The reader's first question after any answer is
              "says who?" — this answers it above the fold. */}
          {heroSources.length > 0 && (
            <div className="mt-3.5 flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-black uppercase tracking-[0.18em] text-[var(--color-text-muted)] w-full sm:w-auto">Sources · tap to open</span>
              {heroSources.map((c) => (
                <button key={c.n} onClick={() => onCite(c)}
                  className="inline-flex items-center gap-1.5 text-[11px] font-black px-2.5 py-1.5 rounded-lg bg-[var(--color-surface)] border border-orange-300 dark:border-orange-800 text-[var(--color-text)] shadow-sm hover:bg-orange-50 dark:hover:bg-orange-950/30 hover:border-orange-500 active:scale-[0.98] transition-all">
                  <Eye className="w-3.5 h-3.5 text-orange-600" />
                  {(c.documentName ?? "Document").replace(/\.pdf$/i, "")}
                  <span className="font-bold text-orange-600">p.{c.page}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 sm:px-5 pb-4 pt-3">

          {/* Imperatives always visible — safety never hides behind a click */}
          {hero && importantBlocks.length > 0 && (
            <div className="mt-3 space-y-2">
              {importantBlocks.map((b, i) => (
                <ImportantCallout key={i} text={b.text} citations={answer.citations} onCite={onCite} />
              ))}
            </div>
          )}

          {/* The reasoning waits for "Elaborate" — unnecessary until it isn't */}
          {hero && detailBlocks.length > 0 && elaborated && (
            <div className="mt-4 animate-rise">
              <SectionedBlocks key={answer.answer} blocks={detailBlocks} citations={answer.citations} onCite={onCite} />
            </div>
          )}

          <div className="mt-4 pt-3 border-t border-[var(--color-border)] flex items-center gap-2 flex-wrap text-[10px] text-[var(--color-text-muted)]">
            {hero && detailBlocks.length > 0 && (
              <button onClick={() => setElaborated((e) => !e)}
                className="inline-flex items-center gap-1 text-[10px] font-black px-2.5 py-1.5 rounded-lg border border-orange-300 dark:border-orange-800 text-orange-700 dark:text-orange-300 hover:bg-orange-500/10 transition-colors">
                <ChevronDown className={`w-3 h-3 transition-transform ${elaborated ? "rotate-180" : ""}`} />
                {elaborated ? "Hide detail" : "Show detail"}
              </button>
            )}
            {canShape && shapeOrgId && shapeUid && (
              <button onClick={() => setShaping(true)}
                title="AI proposes how this answer attributes to the org graph — you curate, it writes"
                className="inline-flex items-center gap-1 text-[10px] font-black px-2.5 py-1.5 rounded-lg border border-violet-300 dark:border-violet-800 text-violet-700 dark:text-violet-300 hover:bg-violet-500/10 transition-colors">
                <Waypoints className="w-3 h-3" /> Shape the graph
              </button>
            )}
            <span className="font-bold ml-auto">{answer.provider} · {answer.model}</span>
            <span>·</span>
            <span>{libraryCitations.length} source{libraryCitations.length === 1 ? "" : "s"} below</span>
            <span>·</span>
            {/* Version beacon: which renderer produced this card. If a report
                of bad formatting comes without this tag on screen, the tab is
                serving pre-fmt5 code — a fact, not a guess. */}
            <span className="font-black text-orange-600/70" title="Answer renderer version">fmt5</span>
          </div>
        </div>
      </div>

      {/* Interactive equipment register — the deterministic table behind
          "show me all equipment". Every sheet chip rings the tag. */}
      {answer.equipmentTable && onOpenTag && (
        <EquipmentTablePanel table={answer.equipmentTable} onOpenTag={onOpenTag} />
      )}

      <CiteCoachMark />

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

      {/* Sources, GROUPED BY DOCUMENT and ordered by how load-bearing each
          document is for THIS answer (first use wins). A 60-citation answer
          used to render 60 equal flat cards — a pile nobody could
          prioritize. Now: the top documents lead, each group opens on tap,
          and the long tail waits behind "Show all". */}
      {sourceGroups.length > 0 && (
        <>
          <div className="text-[9px] font-black uppercase tracking-[0.2em] text-[var(--color-text-muted)] pt-1">
            Sources — most load-bearing documents first; tap a document to see its passages
          </div>
          <div className="space-y-1.5">
            {visibleGroups.map((g) => {
              const open = openGroups.has(g.doc);
              return (
                <div key={g.doc} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
                  <button
                    onClick={() => setOpenGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(g.doc)) next.delete(g.doc); else next.add(g.doc);
                      return next;
                    })}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-[var(--color-surface-2)] transition-colors">
                    <ChevronRight className={`w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
                    <FileText className="w-3.5 h-3.5 text-orange-600 shrink-0" />
                    <span className="text-xs font-black text-[var(--color-text)] truncate">{g.doc}</span>
                    <span className="ml-auto shrink-0 text-[10px] font-black px-2 py-0.5 rounded-md bg-orange-100 dark:bg-orange-950/50 text-orange-800 dark:text-orange-300">
                      {g.cites.length} passage{g.cites.length === 1 ? "" : "s"}
                    </span>
                  </button>
                  {open && (
                    <div className="px-2 pb-2 space-y-1.5 border-t border-[var(--color-border)]">
                      {g.cites.map((c, i) => (
                        <SourceCard key={c.n} citation={c} onOpen={onCite} delay={i * 30} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {sourceGroups.length > visibleGroups.length && (
            <button onClick={() => setAllSources(true)}
              className="text-[11px] font-black px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors">
              Show all {sourceGroups.length} documents ({libraryCitations.length} passages)
            </button>
          )}
          {allSources && sourceGroups.length > 4 && (
            <button onClick={() => { setAllSources(false); setOpenGroups(new Set()); }}
              className="text-[11px] font-black px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors">
              Show fewer
            </button>
          )}
        </>
      )}
    </div>
    </ProofContext.Provider>
    </DocLinkContext.Provider>
  );
}

/** Thumbs on an answer — the loop that makes retrieval smarter with use.
 *  A 👍 stores the verdict on the answer's history row; future similar
 *  questions pull that answer's cited pages into the passage pool first. */
function AnswerFeedback({ questionId }: { questionId: string }) {
  const [state, setState] = useState<1 | -1 | 0>(0);
  const rate = async (r: 1 | -1) => {
    const next = state === r ? 0 : r;    // clicking again clears the rating
    setState(next);
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

/** One-time coach mark: nobody clicked the orange numbers because nothing
 *  said they were buttons. Says it once, dismisses forever. Hydration-safe
 *  via useSyncExternalStore (server snapshot: hidden). */
const subscribeNever = () => () => {};
const citeHintUnseen = () => {
  try { return !window.localStorage.getItem("kl-cite-hint-seen"); } catch { return false; }
};
function CiteCoachMark() {
  const unseen = React.useSyncExternalStore(subscribeNever, citeHintUnseen, () => false);
  const [dismissed, setDismissed] = useState(false);
  if (!unseen || dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try { window.localStorage.setItem("kl-cite-hint-seen", "1"); } catch { /* ignore */ }
  };
  return (
    <div className="flex items-center gap-2.5 rounded-xl border-2 border-dashed border-orange-400 bg-orange-50 dark:bg-orange-950/30 px-3.5 py-2.5 animate-rise">
      <span className="shrink-0 w-6 h-6 rounded-md bg-orange-600 text-white text-[11px] font-black flex items-center justify-center animate-pulse">1</span>
      <p className="text-xs font-bold text-orange-900 dark:text-orange-200 flex-1">
        The orange numbers are buttons — tap one to open the PDF at that exact page with the passage highlighted.
      </p>
      <button onClick={dismiss} className="shrink-0 text-[10px] font-black text-orange-700 dark:text-orange-300 hover:underline">Got it</button>
    </div>
  );
}

function CitationChips({ citations, onOpen }: {
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

export default function KnowledgeLibraryPage() {
  const params = useParams<{ id: string }>();
  const libraryId = params.id;
  const router = useRouter();
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const [library, setLibrary] = useState<KnowledgeLibrary | null>(null);
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [history, setHistory] = useState<KnowledgeQuestion[]>([]);
  // The per-document status list is bookkeeping, not the point of the page —
  // collapsed by default, live counts always in the header.
  const [docsOpen, setDocsOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const [question, setQuestion] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);
  // The conversation: prior turns render in full above the latest answer,
  // and every new ask carries them as context. threadId groups the turns in
  // knowledge_questions so a conversation can be reopened tomorrow.
  const [thread, setThread] = useState<Array<{ question: string; answer: KnowledgeAnswer }>>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  // Conversations survive reloads. Thread state used to live only in this
  // component — any reload, navigation, or crash silently reset the chat to
  // zero while looking identical, which read as "my chats are one-shot".
  // The active thread mirrors to sessionStorage per library; restore runs in
  // an effect (never an initializer) so hydration stays consistent.
  const threadStoreKey = `kl-active-thread-${libraryId}`;
  const threadRestoredRef = useRef(false);
  // Opening the library quietly advances any pending meaning-index build
  // server-side (fire-and-forget) — large builds no longer depend on a tab.
  useEffect(() => {
    void import("@/lib/knowledge").then((m) => m.nudgeEmbedDrain());
  }, []);
  useEffect(() => {
    if (threadRestoredRef.current) return;
    threadRestoredRef.current = true;
    try {
      const raw = window.sessionStorage.getItem(threadStoreKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        threadId: string | null;
        turns: Array<{ question: string; answer: KnowledgeAnswer }>;
      };
      if (saved?.turns?.length) {
        setThread(saved.turns);
        setThreadId(saved.threadId);
        const last = saved.turns[saved.turns.length - 1];
        setAnswer(last.answer);
        setLastQuestion(last.question);
      }
    } catch { /* corrupted or absent — start fresh */ }
  }, [threadStoreKey]);
  useEffect(() => {
    try {
      if (thread.length === 0) { window.sessionStorage.removeItem(threadStoreKey); return; }
      window.sessionStorage.setItem(
        threadStoreKey,
        JSON.stringify({ threadId, turns: thread.slice(-6) }),
      );
    } catch { /* storage full — chat still works, it just won't survive a reload */ }
  }, [thread, threadId, threadStoreKey]);
  // Org Playbooks visibility: how many standing instructions ride on asks.
  const [instructionCount, setInstructionCount] = useState(0);
  useEffect(() => {
    if (!activeOrgId) return;
    void import("@/lib/aiInstructions").then((m) =>
      m.countActiveInstructions(activeOrgId, "knowledge").then(setInstructionCount));
  }, [activeOrgId]);

  const [askError, setAskError] = useState<string | null>(null);
  // Amber "provider busy" notice — transient overloads get a calm card and
  // an automatic retry, never the red failure banner.
  const [busyNotice, setBusyNotice] = useState<string | null>(null);
  const overloadRetriedRef = useRef(false);
  // Pending clarify round: the AI asked which aspects to answer.
  const [clarify, setClarify] = useState<{ question: string; options: string[]; forQuestion: string } | null>(null);
  // Pending Need round: a calculation wants user-specific input values.
  const [need, setNeed] = useState<{
    prompt: string; forQuestion: string; focus?: string[]; priorInputs?: string;
  } | null>(null);
  // Default is STRICT library-only — that's the compliance posture. The
  // choice sticks per browser so people who live in one mode stay there.
  const [mode, setMode] = useState<AskMode>("library");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("knowledge-ask-mode");
      if (saved === "internet") setMode("internet");
    } catch { /* private mode etc. */ }
  }, []);
  const pickMode = (m: AskMode) => {
    setMode(m);
    try { window.localStorage.setItem("knowledge-ask-mode", m); } catch { /* ignore */ }
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<{ name: string; phase: string } | null>(null);
  const [reindexing, setReindexing] = useState<string | null>(null);
  // Browser-driven queue drain: linked source documents index right here,
  // automatically — free-tier hosting kills long server jobs, so the open
  // page is the reliable indexing engine.
  const [autoIndexing, setAutoIndexing] = useState<{
    name: string; remaining: number; visionPages?: number; visionSkipReason?: string | null;
  } | null>(null);
  const autoIndexRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [links, setLinks] = useState<KnowledgeLibraryLink[]>([]);
  const [showAiSetup, setShowAiSetup] = useState(false);

  const openCitation = useCallback((c: KnowledgeCitation) => {
    const doc = docs.find((d) => d.id === c.documentId);
    if (!doc) { showToast({ type: "error", title: "That document is no longer in the library." }); return; }
    // The whole answer's evidence trail rides along: every resolvable doc
    // citation becomes a carousel stop, opened on the one that was clicked.
    // An answer built from §4.2.4 [1] and §4.2.5 [2] is two obvious stops,
    // and both passages highlight while paging the same document. Earlier
    // TURNS keep their carousels too — the clicked citation is looked up in
    // every rendered answer's array, not just the latest one.
    const pools: Array<KnowledgeCitation[] | undefined> = [
      answer?.citations,
      ...thread.map((t) => t.answer.citations),
    ];
    const siblings = pools.find((p) => p?.includes(c)) ?? [c];
    const sources = siblings
      .filter((x) => !x.url && x.documentId)
      .map((x) => {
        const d = docs.find((dd) => dd.id === x.documentId);
        return d ? {
          fileKey: d.fileKey,
          page: x.page ?? 1,
          quote: x.quote ?? null,
          title: x.documentName ?? d.name,
          section: x.section ?? null,
          documentId: d.id,
          tags: x.tags,
          n: x.n,
        } : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    // Match the clicked citation by its NUMBER first — two chunks can yield
    // identical doc+page+quote under different [n]s, and the chip the user
    // clicked must be the chip that lights up.
    const byN = sources.findIndex((s) => s.n === c.n);
    const sourceIndex = Math.max(0, byN >= 0 ? byN : sources.findIndex((s) =>
      s.documentId === c.documentId && s.page === (c.page ?? 1) && s.quote === (c.quote ?? null)));
    setViewer({
      fileKey: doc.fileKey,
      page: c.page ?? 1,
      quote: c.quote ?? null,
      title: c.documentName ?? doc.name,
      section: c.section ?? null,
      documentId: doc.id,
      tags: c.tags,
      ...(sources.length > 1 ? { sources, sourceIndex } : {}),
    });
  }, [docs, answer, thread, showToast]);

  // Show-me chips: open a document the answer NAMED. The server sends the
  // fileKey with each mention, so this works even for docs in linked
  // libraries that this page's own docs list doesn't hold.
  const openMentionedDoc = useCallback((d: DocLink) => {
    setViewer({ fileKey: d.fileKey, page: d.page, quote: null, title: d.name, section: null, documentId: d.id });
  }, []);

  // ── Deep link straight to a page: ?doc=<id>&page=<n>&quote=<text> ───────
  //
  // What makes a mention worth clicking. A backlink that dumps you at the top
  // of a 400-page standard has told you nothing; this lands on the page with
  // the sentence highlighted, and the viewer's close button puts you back
  // where you came from. Handled once per (doc, page) so closing the viewer
  // doesn't immediately reopen it.
  const searchParams = useSearchParams();
  const handledDeepLink = useRef<string | null>(null);
  useEffect(() => {
    const docId = searchParams.get("doc");
    if (!docId || docs.length === 0) return;
    const page = Number(searchParams.get("page") ?? 1) || 1;
    const key = `${docId}#${page}`;
    if (handledDeepLink.current === key) return;
    const doc = docs.find((d) => d.id === docId);
    if (!doc) return;                       // not in this library, or removed
    handledDeepLink.current = key;
    setViewer({
      fileKey: doc.fileKey, page,
      quote: searchParams.get("quote"),
      title: doc.name,
      documentId: doc.id,
    });
  }, [searchParams, docs]);

  const refresh = useCallback(async () => {
    const [lib, documents, questions, libLinks] = await Promise.all([
      getKnowledgeLibrary(libraryId),
      listKnowledgeDocuments(libraryId),
      listKnowledgeQuestions(libraryId),
      listLibraryLinks(libraryId),
    ]);
    setLibrary(lib);
    setDocs(documents);
    setHistory(questions);
    setLinks(libLinks);
    setLoading(false);
  }, [libraryId]);
  useEffect(() => { void refresh(); }, [refresh]);

  // ── Auto-index queued documents while the page is open ─────────────────
  // Linked sources create docs in "pending"; a rev-up marks them "stale".
  // Whenever the queue is non-empty (and no upload/manual reindex is
  // driving), drain it here batch-by-batch. Each doc gets one attempt per
  // page visit — a failing PDF is marked errored server-side and skipped,
  // never retried in a hot loop.
  const hasQueued = isController && docs.some((d) =>
    d.status === "pending" || d.status === "stale" || d.status === "indexing");
  useEffect(() => {
    if (!hasQueued || autoIndexRef.current || uploadState !== null || reindexing !== null) return;
    autoIndexRef.current = true;
    const attempted = new Set<string>();
    (async () => {
      try {
        // THREE documents in flight, not one. Each document's ingest is its
        // own chain of serverless invocations, so a hundred-file library
        // used to be a hundred SEQUENTIAL chains — the single biggest wall
        // in indexing time. Three concurrent chains cut it to roughly a
        // third; the cap stays modest because vision pages bill the same
        // per-user key and providers rate-limit per minute.
        const CONCURRENCY = 3;
        const active = new Map<string, string>();      // id -> name
        let remaining = 0;
        const report = (progress?: { visionPages?: number; visionSkipReason?: string | null }) => {
          if (!mountedRef.current) return;
          const names = [...active.values()];
          setAutoIndexing({
            name: names.length > 1 ? `${names[0]} (+${names.length - 1} more)` : names[0] ?? "",
            remaining,
            ...(progress ? {
              visionPages: progress.visionPages,
              visionSkipReason: progress.visionSkipReason,
            } : {}),
          });
        };
        const worker = async (): Promise<void> => {
          for (;;) {
            if (!mountedRef.current) return;
            const list = await listKnowledgeDocuments(libraryId);
            if (!mountedRef.current) return;
            setDocs(list);
            const queue = list.filter((d) =>
              (d.status === "pending" || d.status === "stale" || d.status === "indexing") &&
              !attempted.has(d.id) && !active.has(d.id));
            remaining = queue.length + active.size;
            const next = queue[0];
            if (!next) return;
            attempted.add(next.id);
            active.set(next.id, next.name);
            report();
            try {
              await ingestKnowledgeDocument(next.id, (_i, _t, progress) => {
                if (progress) report(progress);
                void listKnowledgeDocuments(libraryId).then((ds) => {
                  if (mountedRef.current) setDocs(ds);
                });
              });
            } catch { /* row is marked errored server-side; move on */ }
            finally { active.delete(next.id); report(); }
          }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      } finally {
        autoIndexRef.current = false;
        if (mountedRef.current) {
          setAutoIndexing(null);
          void refresh();
        }
      }
    })();
  }, [hasQueued, uploadState, reindexing, libraryId, refresh]);

  // Ask memory: a near-duplicate of a past question gets offered from the
  // org's own record BEFORE a fresh AI call spends anything. "Ask fresh"
  // always available — memory is a shortcut, never a wall.
  const [priorAsks, setPriorAsks] = useState<import("@/lib/knowledge").PastAsk[] | null>(null);
  const priorDismissedRef = useRef<string>("");

  const ask = async (focusArg?: string[], questionOverride?: string, inputsArg?: string, skipMemory?: boolean) => {
    const q = (questionOverride ?? question).trim();
    if (!activeOrgId || !q) return;
    if (!skipMemory && thread.length === 0 && mode === "library" && priorDismissedRef.current !== q) {
      try {
        const { searchAskHistory } = await import("@/lib/knowledge");
        const past = await searchAskHistory(activeOrgId, q, 3);
        if (past.length > 0) {
          setPriorAsks(past);
          priorDismissedRef.current = q;
          return; // show the memory card; the user decides
        }
      } catch { /* memory is best-effort */ }
    }
    setPriorAsks(null);
    setLastQuestion(q);
    setAsking(true); setAskError(null); setBusyNotice(null); setAnswer(null); setClarify(null); setNeed(null);
    try {
      const tid = threadId ?? crypto.randomUUID();
      const run = () => askKnowledgeLibrary(activeOrgId, libraryId, q, mode, focusArg, inputsArg,
        {
          history: thread.slice(-4).map((t) => ({ question: t.question, answer: t.answer.answer })),
          threadId: tid,
        });
      let res: KnowledgeAnswer;
      try {
        res = await run();
      } catch (e) {
        // First question ever: the server requires the acceptable-use
        // agreement (428). Show it, record acceptance, re-ask — one time.
        const err = e as AgreementRequiredError;
        if (!err.agreementRequired) throw e;
        const agreed = await appConfirm({
          title: "Before your first question — the ground rules",
          message: err.agreementText ??
            "Everything you type is sent to the workspace's AI provider. Never enter passwords, " +
            "financial details, or personal identity information — work questions only.",
          confirmLabel: "I agree",
        });
        if (!agreed) { setAsking(false); return; }
        await acceptAiAgreement(activeOrgId);
        res = await run();
      }
      const needPrompt = res.answer ? parseNeedPrompt(res.answer) : null;
      if (res.clarification) {
        // No answer yet — the AI wants the asker to narrow the aspects.
        setClarify({
          question: res.clarification.question,
          options: res.clarification.options,
          forQuestion: q,
        });
      } else if (needPrompt) {
        // Calculation stopped for user-specific values — collect and re-run.
        setNeed({ prompt: needPrompt, forQuestion: q, focus: focusArg, priorInputs: inputsArg });
      } else {
        setAnswer(res);
        setThread((prev) => [...prev, { question: q, answer: res }]);
        setThreadId(tid);
        setHistory(await listKnowledgeQuestions(libraryId));
      }
    } catch (e) {
      const msg = (e as Error).message || "The question failed.";
      // Provider briefly overloaded (Anthropic 529 etc.): this heals itself
      // in seconds, so it deserves a calm auto-retry — not the red alarm
      // banner and a manual re-ask. One automatic retry; if the provider is
      // still down after that, the amber notice hands over a Retry button.
      if (/overloaded/i.test(msg) && !overloadRetriedRef.current) {
        overloadRetriedRef.current = true;
        setBusyNotice("The AI provider is briefly overloaded — retrying automatically in a few seconds…");
        setTimeout(() => {
          setBusyNotice(null);
          void ask(focusArg, q, inputsArg, true);
        }, 6_000);
        return; // the spinner keeps running through the wait
      }
      overloadRetriedRef.current = false;
      if (/overloaded/i.test(msg)) {
        setBusyNotice(msg); // amber card with a Retry button — see render
      } else {
        setAskError(msg);
      }
      setAsking(false);
      return;
    }
    overloadRetriedRef.current = false;
    setAsking(false);
  };

  /** Reopen a past conversation IN FULL and make it continuable — the way
   *  every chat product works. Rows sharing a thread_id load together in
   *  order; pre-thread history rows load as single-turn conversations. */
  const openConversation = (rows: KnowledgeQuestion[]) => {
    const ordered = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const turns = ordered.map((q) => ({
      question: q.question,
      answer: {
        answer: q.answer ?? "",
        citations: q.citations,
        provider: "memory", model: "past answer",
        mode: q.mode,
      } as KnowledgeAnswer,
    }));
    setThread(turns);
    setThreadId(ordered[0]?.threadId ?? crypto.randomUUID());
    setAnswer(turns[turns.length - 1]?.answer ?? null);
    setLastQuestion(turns[turns.length - 1]?.question ?? "");
    setPriorAsks(null); setClarify(null); setNeed(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || !activeOrgId || !uid) return;
    for (const file of Array.from(files)) {
      if (!/\.pdf$/i.test(file.name)) {
        showToast({ type: "error", title: `${file.name}: only PDF files can be indexed.` });
        continue;
      }
      try {
        setUploadState({ name: file.name, phase: "Uploading…" });
        await addKnowledgeDocument({
          orgId: activeOrgId, libraryId, file,
          userId: uid, userName: userEmail ?? "Member",
          onUpload: (p) => setUploadState({
            name: file.name,
            phase: `Uploading… ${Math.round(p.percent)}%`,
          }),
          onIndex: (indexed, total) => {
            setUploadState({ name: file.name, phase: `Indexing… ${indexed}${total ? ` / ${total}` : ""} pages` });
            void listKnowledgeDocuments(libraryId).then(setDocs);
          },
        });
        showToast({ type: "success", title: `${file.name} indexed and searchable.` });
      } catch (e) {
        showToast({ type: "error", title: `${file.name}: ${(e as Error).message}` });
      }
    }
    setUploadState(null);
    await refresh();
  };

  const resumeIndex = async (doc: KnowledgeDocument) => {
    setReindexing(doc.id);
    try {
      await ingestKnowledgeDocument(doc.id, () => { void listKnowledgeDocuments(libraryId).then(setDocs); });
      showToast({ type: "success", title: `${doc.name} indexed.` });
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally {
      setReindexing(null);
      await refresh();
    }
  };

  const removeDoc = async (doc: KnowledgeDocument) => {
    const ok = await appConfirm({
      title: "Remove document?",
      message: `"${doc.name}" and its search index will be removed from this library. The answers it already contributed to stay in the history.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    try {
      await deleteKnowledgeDocument(doc.id);
      await refresh();
    } catch (e) { showToast({ type: "error", title: (e as Error).message }); }
  };

  const removeLibrary = async () => {
    const ok = await appConfirm({
      title: "Delete this library?",
      message: "All documents, their search index, and the question history will be deleted. This cannot be undone.",
      confirmLabel: "Delete library",
    });
    if (!ok || !library) return;
    try {
      await deleteKnowledgeLibrary(library.id);
      router.push("/knowledge");
    } catch (e) { showToast({ type: "error", title: (e as Error).message }); }
  };

  if (loading) return <PageShell><div className="py-16 text-center"><Spinner /></div></PageShell>;
  if (!library) {
    return (
      <PageShell>
        <div className="py-16 text-center text-sm text-[var(--color-text-muted)]">
          Library not found. <button className="underline" onClick={() => router.push("/knowledge")}>Back to Knowledge</button>
        </div>
      </PageShell>
    );
  }

  const readyDocs = docs.filter((d) => d.status === "ready").length;
  const indexingDocs = docs.filter((d) => d.status === "indexing" || d.status === "pending" || d.status === "stale").length;

  return (
    <PageShell>
      <PageHeaderBar
        icon={BookOpen}
        eyebrow={<button onClick={() => router.push("/knowledge")} className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="w-3 h-3" /> Knowledge</button>}
        title={library.name}
        subtitle={library.description || `${readyDocs} of ${docs.length} documents indexed and searchable`}
        actions={isController ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="secondary" onClick={() => setShowAiSetup(true)}>
              <Wand2 className="w-4 h-4" /> Library AI setup
            </Button>
            <Button variant="secondary" onClick={() => void removeLibrary()}>
              <Trash2 className="w-4 h-4" /> Delete library
            </Button>
          </div>
        ) : undefined}
      />

      {links.length > 0 && (
        <div className="mb-4 -mt-1 flex items-center gap-1.5 flex-wrap text-[10px] text-[var(--color-text-muted)]">
          <span className="font-black uppercase tracking-wider">Also searches:</span>
          {links.map((l) => (
            <span key={l.id} className="font-black px-2 py-0.5 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)]">
              {l.linkedLibraryName} · REFERENCE
            </span>
          ))}
          <span className="italic">— this library governs; answers say which document won.</span>
        </div>
      )}

      {/* ── Ask ─────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border-2 border-orange-300 dark:border-orange-800 bg-gradient-to-br from-orange-50/70 to-[var(--color-surface)] dark:from-orange-950/20 dark:to-[var(--color-surface)] p-5 mb-6">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-sm font-black text-[var(--color-text)]">Ask this library</div>
              <div className="text-[10px] text-[var(--color-text-muted)]">
                {mode === "library"
                  ? "Answers come ONLY from the indexed documents, cited to the page."
                  : "Answers come from the internet / general knowledge — NOT your controlled documents."}
                {instructionCount > 0 && (
                  <Link href="/admin/ai-instructions" className="ml-1.5 font-bold text-violet-700 hover:underline">
                    {instructionCount} standing instruction{instructionCount === 1 ? "" : "s"} apply
                  </Link>
                )}
              </div>
            </div>
          </div>
          {/* Source toggle: strict library grounding vs the outside world. */}
          <div className="inline-flex rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
            <button onClick={() => pickMode("library")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-[11px] font-black transition-colors ${
                mode === "library"
                  ? "bg-orange-600 text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              <BookOpen className="w-3.5 h-3.5" /> Library only
            </button>
            <button onClick={() => pickMode("internet")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-[11px] font-black transition-colors ${
                mode === "internet"
                  ? "bg-sky-600 text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              <Globe className="w-3.5 h-3.5" /> Internet
            </button>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2}
            placeholder={mode === "library"
              ? 'e.g. "What is the minimum hydrotest pressure for Class 300 piping?"'
              : 'e.g. "What is the latest edition of API 653 and what changed?"'}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask(); }}
            className="flex-1" />
          <Button onClick={() => void ask()}
            disabled={asking || !question.trim() || (mode === "library" && readyDocs === 0)}>
            {asking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Ask
          </Button>
        </div>
        {mode === "library" && readyDocs === 0 && (
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400 font-bold">
            {docs.some((d) => d.status === "pending" || d.status === "stale" || d.status === "indexing")
              ? "Documents are indexing below — asking unlocks as soon as the first one finishes. Indexing keeps running anywhere in the app."
              : "Nothing indexed yet — link a source or add PDF documents below first, or switch to Internet mode."}
          </p>
        )}
        {/* Ask memory: this question (or a near-twin) was answered before —
            offer the org's own record before spending a fresh AI call. */}
        {priorAsks && priorAsks.length > 0 && (
          <div className="mb-4 rounded-2xl border-2 border-violet-300 dark:border-violet-800 bg-violet-50/70 dark:bg-violet-950/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <History className="w-4 h-4 text-violet-600" />
              <span className="text-sm font-black text-[var(--color-text)]">Asked before — from your team&apos;s record</span>
            </div>
            <div className="space-y-2">
              {priorAsks.map((pa) => (
                <div key={pa.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                  <div className="text-xs font-bold text-[var(--color-text)]">{pa.question}</div>
                  <div className="text-[10px] text-[var(--color-text-faint)] mb-1.5">
                    {pa.user_name || "someone"} · {new Date(pa.created_at).toLocaleDateString()}
                  </div>
                  <button
                    onClick={() => {
                      const past: KnowledgeAnswer = {
                        answer: pa.answer,
                        citations: (Array.isArray(pa.citations) ? pa.citations : []) as KnowledgeCitation[],
                        provider: "memory", model: "past answer", mode: "library",
                      };
                      setAnswer(past);
                      // Seed the conversation so the next question CONTINUES
                      // from this answer instead of starting cold.
                      setThread([{ question: pa.question, answer: past }]);
                      setThreadId(crypto.randomUUID());
                      setLastQuestion(pa.question);
                      setPriorAsks(null);
                    }}
                    className="text-[11px] font-black text-white bg-violet-600 hover:bg-violet-500 rounded-lg px-2.5 py-1">
                    Show this answer — no AI call
                  </button>
                </div>
              ))}
            </div>
            <button onClick={() => { setPriorAsks(null); void ask(undefined, undefined, undefined, true); }}
              className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-black text-violet-700 hover:underline">
              <Sparkles className="w-3.5 h-3.5" /> Ask fresh anyway
            </button>
          </div>
        )}

        {askError && (
          <div className="mt-3 rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-3 py-2.5 text-xs font-bold text-rose-700 dark:text-rose-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {askError}
          </div>
        )}
        {busyNotice && (
          <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 px-3 py-2.5 text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-2 animate-rise">
            {asking
              ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
              : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span className="flex-1">{busyNotice}</span>
            {!asking && lastQuestion && (
              <button
                onClick={() => { setBusyNotice(null); void ask(undefined, lastQuestion); }}
                className="shrink-0 px-2.5 py-1 rounded-lg border border-amber-400 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 font-black">
                Retry now
              </button>
            )}
          </div>
        )}
        {asking && <AskProgress />}
        {clarify && !asking && (
          <ClarifyCard
            prompt={clarify.question}
            options={clarify.options}
            onAnswer={(focus) => void ask(focus, clarify.forQuestion)}
          />
        )}
        {need && !asking && (
          <NeedCard
            prompt={need.prompt}
            onProvide={(values) => void ask(
              need.focus,
              need.forQuestion,
              need.priorInputs ? `${need.priorInputs}; ${values}` : values,
            )}
          />
        )}
        {thread.length > 1 && !asking && (
          <div className="space-y-6 mb-2">
            {thread.slice(0, -1).map((t, i) => (
              <div key={i} className="opacity-90">
                <AnswerExperience question={t.question} answer={t.answer} onCite={openCitation} onOpenDoc={openMentionedDoc} />
              </div>
            ))}
          </div>
        )}
        {thread.length > 0 && !asking && (
          <div className="flex justify-end -mb-2">
            <button
              onClick={() => { setThread([]); setThreadId(null); setAnswer(null); setLastQuestion(""); }}
              className="text-[11px] font-black px-2.5 py-1 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
              + New conversation
            </button>
          </div>
        )}
        {answer && !asking && (
          answer.mode === "internet" ? (
            <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 animate-rise">
              <div className="mb-3 rounded-lg border border-sky-300 bg-sky-50 dark:bg-sky-950/40 dark:border-sky-800 px-3 py-2 text-[11px] font-bold text-sky-800 dark:text-sky-300 flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 shrink-0" />
                Internet answer — {answer.liveWeb ? "from a live web search" : "from the model's general knowledge (no live web on this provider)"}, NOT from your controlled documents.
              </div>
              {/* Same structured renderer as library answers — an internet
                  answer is not exempt from being readable. */}
              <AnswerView answer={answer.answer} citations={answer.citations} onCite={openCitation} />
              <CitationChips citations={answer.citations} onOpen={openCitation} />
              <div className="mt-3 pt-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]">
                Answered by {answer.provider} · {answer.model} · internet answers carry no doc-control weight — cross-check before relying on them.
              </div>
            </div>
          ) : (
            <>
            <AnswerExperience question={lastQuestion} answer={answer} onCite={openCitation} onOpenDoc={openMentionedDoc}
              onOpenTag={(documentId, page, tag, documentName) => {
                const doc = docs.find((d) => d.id === documentId);
                if (!doc) { showToast({ type: "error", title: "That sheet is no longer in the library." }); return; }
                setViewer({
                  fileKey: doc.fileKey, page, quote: null,
                  title: documentName || doc.name, section: null,
                  documentId, tags: [tag],
                });
              }} />
              {answer.questionId ? (
                <AnswerFeedback key={answer.questionId} questionId={answer.questionId} />
              ) : null}
            </>
          )
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Documents ──────────────────────────────────────────────────── */}
        <div>
          {activeOrgId && (
            <SourcesPanel orgId={activeOrgId} libraryId={libraryId}
              isController={isController} onChanged={() => void refresh()} />
          )}
          <div className="flex items-center justify-between mb-2">
            <button onClick={() => setDocsOpen((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
              {docsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Documents ({readyDocs}/{docs.length} indexed{indexingDocs > 0 ? ` · ${indexingDocs} in progress` : ""})
            </button>
            {/* Re-index lives HERE, with the documents — not inside Drawing
                Intelligence, where gating that panel to drawing sets briefly
                made rebuilding unreachable for every prose library. The
                action was always general; now its home is too. */}
            {isController && docs.length > 0 && (
              <button
                onClick={async () => {
                  const ok = await appConfirm({
                    title: "Re-index all documents?",
                    message:
                      "Every document re-reads from scratch — text, tables, tags, and anchors. "
                      + "Do this after an ingestion upgrade or when indexing missed things. "
                      + "Runs in the background; you can leave this page.",
                    confirmLabel: "Re-index",
                  });
                  if (!ok || !activeOrgId) return;
                  try {
                    const res = await rebuildDrawingIndex(activeOrgId, libraryId);
                    showToast({ type: "success", title: `${res.docs} document(s) queued — indexing starts now.` });
                    void refresh();
                  } catch (e) {
                    showToast({ type: "error", title: (e as Error).message });
                  }
                }}
                className="text-[10px] font-black px-2 py-1 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] transition-colors mr-auto ml-3"
              >
                Re-index all
              </button>
            )}
            {isController && (
              <>
                <input ref={fileInput} type="file" accept=".pdf,application/pdf" multiple hidden
                  onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
                <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploadState !== null}>
                  <Upload className="w-3.5 h-3.5" /> Add PDFs
                </Button>
              </>
            )}
          </div>

          {uploadState && (
            <div className="mb-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 flex items-center gap-2 text-xs">
              <Loader2 className="w-4 h-4 animate-spin text-orange-600 shrink-0" />
              <span className="font-bold truncate">{uploadState.name}</span>
              <span className="text-[var(--color-text-muted)] shrink-0 ml-auto">{uploadState.phase}</span>
            </div>
          )}
          {autoIndexing && (
            <div className="mb-2 rounded-xl border border-orange-300 dark:border-orange-800 bg-orange-50/60 dark:bg-orange-950/20 px-3 py-2.5 text-xs">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-orange-600 shrink-0" />
                <span className="font-bold truncate">Indexing {autoIndexing.name}</span>
                <span className="text-[var(--color-text-muted)] shrink-0 ml-auto">
                  {autoIndexing.remaining} in queue — continues anywhere in the app
                </span>
              </div>
              {(autoIndexing.visionPages ?? 0) > 0 && (
                <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                  <Eye className="w-3 h-3 text-sky-600 shrink-0" />
                  <b className="text-[var(--color-text)]">{autoIndexing.visionPages}</b> page(s) had no text
                  layer — read by AI vision (billed to your key, slower per page).
                </div>
              )}
              {autoIndexing.visionSkipReason && (
                <div className="mt-1 flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-400 font-bold">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-px" /> {autoIndexing.visionSkipReason}
                </div>
              )}
            </div>
          )}

          {!docsOpen && docs.length > 0 ? null : docs.length === 0 && !uploadState ? (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] p-8 text-center text-xs text-[var(--color-text-muted)]">
              <FileText className="w-6 h-6 mx-auto mb-2 opacity-50" />
              {isController ? "Drop your standards and practice PDFs here to build the shelf." : "No documents yet — Admin or Doc Control can add PDFs."}
            </div>
          ) : (
            <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
              {docs.map((doc) => (
                <li key={doc.id} className="px-3.5 py-2.5 bg-[var(--color-surface)] flex items-center gap-3">
                  <FileText className="w-4 h-4 text-orange-600 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-[var(--color-text)] truncate flex items-center gap-1.5">
                      <span className="truncate">{doc.name}</span>
                      {doc.sourceDocumentId && (
                        <span className="shrink-0 text-[8px] font-black px-1 py-0.5 rounded bg-sky-500/10 border border-sky-300 dark:border-sky-800 text-sky-700 dark:text-sky-400"
                          title="Mirrors a controlled document — kept current by the source sync">
                          DOC CONTROL{doc.sourceRev ? ` · REV ${doc.sourceRev}` : ""}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-muted)]">
                      {doc.status === "ready" && <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-black"><CheckCircle2 className="w-3 h-3" /> {doc.pageCount} pages indexed</span>}
                      {doc.status === "indexing" && <span className="text-amber-700 dark:text-amber-400 font-black">Indexing {doc.pagesIndexed}{doc.pageCount ? ` / ${doc.pageCount}` : ""} pages…</span>}
                      {doc.status === "pending" && <span>Waiting to index</span>}
                      {doc.status === "stale" && <span className="text-amber-700 dark:text-amber-400 font-black">New revision published — waiting to re-index</span>}
                      {doc.status === "error" && <span className="text-rose-700 dark:text-rose-400 font-black" title={doc.error ?? undefined}>Indexing failed — {doc.error?.slice(0, 80)}</span>}
                    </div>
                    {doc.status === "indexing" && doc.pageCount ? (
                      <div className="mt-1 h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                        <div className="h-full bg-orange-500 transition-all" style={{ width: `${Math.round((doc.pagesIndexed / doc.pageCount) * 100)}%` }} />
                      </div>
                    ) : null}
                  </div>
                  {isController && doc.status !== "ready" && (
                    <button onClick={() => void resumeIndex(doc)} disabled={reindexing !== null}
                      title="Resume indexing"
                      className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
                      {reindexing === doc.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    </button>
                  )}
                  {isController && !doc.sourceDocumentId && (
                    <button onClick={() => void removeDoc(doc)} title="Remove"
                      className="p-1.5 rounded-lg hover:bg-rose-500/10 text-[var(--color-text-muted)] hover:text-rose-600">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {activeOrgId && library.aiFeatures?.drawingIntel === true && (
            <DrawingIntelPanel orgId={activeOrgId} libraryId={libraryId}
              isController={isController} refreshKey={readyDocs}
              onRebuilt={() => void refresh()} />
          )}
          {activeOrgId && (
            <SemanticIndexPanel orgId={activeOrgId} libraryId={libraryId} isController={isController} />
          )}
        </div>

        {/* ── Conversations ──────────────────────────────────────────────── */}
        {/* One compact row per CONVERSATION — click to reopen it in full up
            in the answer area and keep asking. The old design stacked
            ever-growing preview cards nobody could reopen or continue,
            which is a history of dead ends, not a history. */}
        <div>
          <h2 className="text-xs font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-2 flex items-center gap-1.5">
            <History className="w-3.5 h-3.5" /> Conversations ({(() => {
              const seen = new Set<string>();
              for (const q of history) seen.add(q.threadId ?? q.id);
              return seen.size;
            })()})
          </h2>
          {history.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] p-8 text-center text-xs text-[var(--color-text-muted)]">
              Questions and their cited answers land here for the whole team — click one to reopen and continue it.
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
              {(() => {
                const groups = new Map<string, KnowledgeQuestion[]>();
                for (const q of history) {
                  const key = q.threadId ?? q.id;
                  groups.set(key, [...(groups.get(key) ?? []), q]);
                }
                return [...groups.values()].map((rows) => {
                  const first = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
                  const last = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                  return (
                    <li key={first.threadId ?? first.id}>
                      <button
                        onClick={() => openConversation(rows)}
                        className="w-full text-left px-3.5 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors flex items-center gap-2.5 group"
                      >
                        {first.mode === "internet"
                          ? <Globe className="w-3.5 h-3.5 text-sky-600 shrink-0" />
                          : <MessageSquare className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-bold text-[var(--color-text)] truncate">{first.question}</span>
                          <span className="block text-[10px] text-[var(--color-text-muted)]">
                            {rows.length > 1 ? `${rows.length} turns · ` : ""}
                            {last.userName ?? "Someone"} · {new Date(last.createdAt).toLocaleString()}
                          </span>
                        </span>
                        <span className="text-[10px] font-black text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          Reopen →
                        </span>
                      </button>
                    </li>
                  );
                });
              })()}
            </ul>
          )}
        </div>
      </div>

      {viewer && (
        <CitedPageViewer
          fileKey={viewer.fileKey}
          page={viewer.page}
          quote={viewer.quote}
          title={viewer.title}
          section={viewer.section}
          orgId={activeOrgId ?? undefined}
          documentId={viewer.documentId}
          tags={viewer.tags}
          sources={viewer.sources}
          initialIndex={viewer.sourceIndex}
          onClose={() => setViewer(null)}
        />
      )}

      {library && activeOrgId && (
        <LibraryAiModal
          library={library}
          orgId={activeOrgId}
          open={showAiSetup}
          onClose={() => setShowAiSetup(false)}
          onSaved={() => void refresh()}
        />
      )}
    </PageShell>
  );
}
