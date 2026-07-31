"use client";

// /knowledge/[id] — one AI knowledge library: the Ask box up top (that's the
// whole point), the shelf of PDFs below it with live indexing progress, and
// the recent Q&A so the team benefits from each other's questions.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  BookOpen, ArrowLeft, Sparkles, Loader2, Send, FileText, Upload,
  Trash2, RefreshCw, CheckCircle2, AlertTriangle, ExternalLink, History, Globe,
  ChevronRight, ChevronDown, Copy, Check, Search, ScanSearch, PenLine, Quote, Wand2,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { appConfirm } from "@/components/providers/DialogProvider";
import { parseAnswerBlocks } from "@/lib/knowledgeText";
import {
  getKnowledgeLibrary, listKnowledgeDocuments, addKnowledgeDocument,
  ingestKnowledgeDocument, deleteKnowledgeDocument, deleteKnowledgeLibrary,
  askKnowledgeLibrary, listKnowledgeQuestions, listLibraryLinks,
  type KnowledgeLibrary, type KnowledgeDocument, type KnowledgeAnswer,
  type KnowledgeQuestion, type KnowledgeCitation, type AskMode,
  type KnowledgeLibraryLink,
} from "@/lib/knowledge";
import LibraryAiModal from "@/components/knowledge/LibraryAiModal";

// pdf.js only loads when someone actually opens a cited page.
const CitedPageViewer = dynamic(() => import("@/components/knowledge/CitedPageViewer"), { ssr: false });

interface ViewerTarget {
  fileKey: string;
  page: number;
  quote: string | null;
  title: string;
  section?: string | null;
}

/** Inline renderer for answer text: **bold** spans, and [n] markers become
 *  clickable badges that open the cited page directly. */
function InlineAnswer({ text, citations, onCite }: {
  text: string;
  citations: KnowledgeCitation[];
  onCite: (c: KnowledgeCitation) => void;
}) {
  const parts = text.split(/(\[\d{1,2}\]|\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        const cite = part.match(/^\[(\d{1,2})\]$/);
        if (cite) {
          const c = citations.find((x) => x.n === Number(cite[1]));
          if (c && !c.url) {
            return (
              <button key={i} onClick={() => onCite(c)}
                title={`${c.documentName ?? "Document"} · page ${c.page} — open with the passage highlighted`}
                className="inline-flex items-center justify-center align-baseline text-[10px] font-black min-w-[1.35rem] px-1 py-0.5 rounded-md bg-orange-600 text-white shadow-sm ring-1 ring-orange-700/40 hover:bg-orange-700 hover:scale-110 transition-all mx-0.5 cursor-pointer">
                {cite[1]}
              </button>
            );
          }
          return <span key={i} className="text-[10px] font-black text-orange-700">{part}</span>;
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return <b key={i} className="font-black">{part.slice(2, -2)}</b>;
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          // Value chip — exact values, designations, table refs pop out.
          return (
            <code key={i} className="mx-0.5 px-1.5 py-0.5 rounded-md bg-orange-100 dark:bg-orange-950/50 border border-orange-200 dark:border-orange-900 text-orange-900 dark:text-orange-200 font-mono font-bold text-[0.92em]">
              {part.slice(1, -1)}
            </code>
          );
        }
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

/** Structured answer: the Answer line as a hero callout, Basis/Check as
 *  compact labeled sections — never a wall of text. */
function AnswerView({ answer, citations, onCite }: {
  answer: string;
  citations: KnowledgeCitation[];
  onCite: (c: KnowledgeCitation) => void;
}) {
  const blocks = parseAnswerBlocks(answer);
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) => {
        if (b.type === "hero") {
          return (
            <div key={i} className="rounded-xl border-l-4 border-orange-500 bg-orange-50 dark:bg-orange-950/30 px-4 py-3">
              <div className="text-[9px] font-black uppercase tracking-[0.18em] text-orange-600 mb-1">Answer</div>
              <div className="text-base font-bold text-[var(--color-text)] leading-snug">
                <InlineAnswer text={b.text} citations={citations} onCite={onCite} />
              </div>
            </div>
          );
        }
        if (b.type === "label") {
          return <div key={i} className="text-[9px] font-black uppercase tracking-[0.18em] text-[var(--color-text-muted)] pt-1">{b.text}</div>;
        }
        if (b.type === "important") {
          return <ImportantCallout key={i} text={b.text} citations={citations} onCite={onCite} />;
        }
        if (b.type === "bullet") {
          return (
            <div key={i} className="flex items-start gap-2 text-[13px] text-[var(--color-text)] leading-relaxed">
              <span className="mt-[7px] w-1 h-1 rounded-full bg-orange-500 shrink-0" />
              <span><InlineAnswer text={b.text} citations={citations} onCite={onCite} /></span>
            </div>
          );
        }
        return (
          <p key={i} className="text-[13px] text-[var(--color-text)] leading-relaxed">
            <InlineAnswer text={b.text} citations={citations} onCite={onCite} />
          </p>
        );
      })}
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

function CopyButton({ text, label }: { text: string; label: string }) {
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
      className="inline-flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
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
function AnswerExperience({ question, answer, onCite }: {
  question: string;
  answer: KnowledgeAnswer;
  onCite: (c: KnowledgeCitation) => void;
}) {
  const blocks = parseAnswerBlocks(answer.answer);
  const hero = blocks.find((b) => b.type === "hero");
  const rest = blocks.filter((b) => b !== hero);
  // Imperatives (! lines) stay visible even collapsed — never hide a MUST or
  // a hold point behind a button. Everything else waits for "Elaborate".
  const importantBlocks = rest.filter((b) => b.type === "important");
  const detailBlocks = rest.filter((b) => b.type !== "important");
  const [elaborated, setElaborated] = useState(false);
  const libraryCitations = answer.citations.filter((c) => !c.url);
  const isCheck = (t: string) => /^\*{0,2}Check:?\*{0,2}/i.test(t);

  return (
    <div className="mt-4 space-y-3">
      <div className="text-[11px] text-[var(--color-text-muted)] animate-rise">
        You asked: <i>&ldquo;{question}&rdquo;</i>
      </div>

      {/* Hero answer card */}
      <div className="rounded-2xl border-2 border-orange-400 dark:border-orange-700 bg-[var(--color-surface)] shadow-lg overflow-hidden animate-pop">
        <div className="h-1.5 bg-gradient-to-r from-orange-500 via-amber-500 to-orange-500" />
        <div className="p-5">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-orange-600">Answer</div>
            <CopyButton text={answer.answer} label="Copy answer" />
          </div>
          {hero ? (
            <div className="text-lg font-bold text-[var(--color-text)] leading-snug">
              <InlineAnswer text={hero.text} citations={answer.citations} onCite={onCite} />
            </div>
          ) : (
            <AnswerView answer={answer.answer} citations={answer.citations} onCite={onCite} />
          )}

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
            <div className="mt-4 space-y-2 animate-rise">
              {detailBlocks.map((b, i) => {
                if (b.type === "label") {
                  return <div key={i} className="text-[9px] font-black uppercase tracking-[0.18em] text-[var(--color-text-muted)] pt-1">{b.text}</div>;
                }
                if (b.type === "bullet") {
                  return (
                    <div key={i} className="flex items-start gap-2 text-[13px] text-[var(--color-text)] leading-relaxed">
                      <span className="mt-[7px] w-1 h-1 rounded-full bg-orange-500 shrink-0" />
                      <span><InlineAnswer text={b.text} citations={answer.citations} onCite={onCite} /></span>
                    </div>
                  );
                }
                if (isCheck(b.text)) {
                  return (
                    <div key={i} className="flex items-start gap-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 text-[12px] text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span><InlineAnswer text={b.text.replace(/^\*{0,2}Check:?\*{0,2}\s*/i, "")} citations={answer.citations} onCite={onCite} /></span>
                    </div>
                  );
                }
                return (
                  <p key={i} className="text-[13px] text-[var(--color-text)] leading-relaxed">
                    <InlineAnswer text={b.text} citations={answer.citations} onCite={onCite} />
                  </p>
                );
              })}
            </div>
          )}

          <div className="mt-4 pt-3 border-t border-[var(--color-border)] flex items-center gap-2 flex-wrap text-[10px] text-[var(--color-text-muted)]">
            {hero && detailBlocks.length > 0 && (
              <button onClick={() => setElaborated((e) => !e)}
                className="inline-flex items-center gap-1 text-[10px] font-black px-2.5 py-1.5 rounded-lg border border-orange-300 dark:border-orange-800 text-orange-700 dark:text-orange-300 hover:bg-orange-500/10 transition-colors">
                <ChevronDown className={`w-3 h-3 transition-transform ${elaborated ? "rotate-180" : ""}`} />
                {elaborated ? "Less" : "Elaborate"}
              </button>
            )}
            <span className="font-bold ml-auto">{answer.provider} · {answer.model}</span>
            <span>·</span>
            <span>{libraryCitations.length} source{libraryCitations.length === 1 ? "" : "s"} below</span>
          </div>
        </div>
      </div>

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

      {/* Source cards — every quote its own card */}
      {libraryCitations.length > 0 && (
        <>
          <div className="text-[9px] font-black uppercase tracking-[0.2em] text-[var(--color-text-muted)] pt-1">
            Sources — tap a row for the exact wording, or the page itself
          </div>
          <div className="space-y-1.5">
            {libraryCitations.map((c, i) => (
              <SourceCard key={c.n} citation={c} onOpen={onCite} delay={i * 50} />
            ))}
          </div>
        </>
      )}
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
  const [loading, setLoading] = useState(true);

  const [question, setQuestion] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
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
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [links, setLinks] = useState<KnowledgeLibraryLink[]>([]);
  const [showAiSetup, setShowAiSetup] = useState(false);

  const openCitation = useCallback((c: KnowledgeCitation) => {
    const doc = docs.find((d) => d.id === c.documentId);
    if (!doc) { showToast({ type: "error", title: "That document is no longer in the library." }); return; }
    setViewer({
      fileKey: doc.fileKey,
      page: c.page ?? 1,
      quote: c.quote ?? null,
      title: c.documentName ?? doc.name,
      section: c.section ?? null,
    });
  }, [docs, showToast]);

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

  const ask = async () => {
    if (!activeOrgId || !question.trim()) return;
    const q = question.trim();
    setLastQuestion(q);
    setAsking(true); setAskError(null); setAnswer(null);
    try {
      setAnswer(await askKnowledgeLibrary(activeOrgId, libraryId, q, mode));
      setHistory(await listKnowledgeQuestions(libraryId));
    } catch (e) {
      setAskError((e as Error).message);
    } finally { setAsking(false); }
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

  return (
    <PageShell>
      <PageHeaderBar
        icon={BookOpen}
        eyebrow={<button onClick={() => router.push("/knowledge")} className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="w-3 h-3" /> Knowledge</button>}
        title={library.name}
        subtitle={library.description || `${readyDocs} of ${docs.length} documents indexed and searchable`}
        actions={isController ? (
          <div className="flex items-center gap-2">
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
            Nothing indexed yet — add PDF documents below first, or switch to Internet mode.
          </p>
        )}
        {askError && (
          <div className="mt-3 rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-3 py-2.5 text-xs font-bold text-rose-700 dark:text-rose-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {askError}
          </div>
        )}
        {asking && <AskProgress />}
        {answer && !asking && (
          answer.mode === "internet" ? (
            <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 animate-rise">
              <div className="mb-3 rounded-lg border border-sky-300 bg-sky-50 dark:bg-sky-950/40 dark:border-sky-800 px-3 py-2 text-[11px] font-bold text-sky-800 dark:text-sky-300 flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 shrink-0" />
                Internet answer — {answer.liveWeb ? "from a live web search" : "from the model's general knowledge (no live web on this provider)"}, NOT from your controlled documents.
              </div>
              <div className="text-sm text-[var(--color-text)] whitespace-pre-wrap leading-relaxed">{answer.answer}</div>
              <CitationChips citations={answer.citations} onOpen={openCitation} />
              <div className="mt-3 pt-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]">
                Answered by {answer.provider} · {answer.model} · internet answers carry no doc-control weight — cross-check before relying on them.
              </div>
            </div>
          ) : (
            <AnswerExperience question={lastQuestion} answer={answer} onCite={openCitation} />
          )
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Documents ──────────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-black uppercase tracking-widest text-[var(--color-text-muted)]">Documents ({docs.length})</h2>
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

          {docs.length === 0 && !uploadState ? (
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
                    <div className="text-xs font-bold text-[var(--color-text)] truncate">{doc.name}</div>
                    <div className="text-[10px] text-[var(--color-text-muted)]">
                      {doc.status === "ready" && <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-black"><CheckCircle2 className="w-3 h-3" /> {doc.pageCount} pages indexed</span>}
                      {doc.status === "indexing" && <span className="text-amber-700 dark:text-amber-400 font-black">Indexing {doc.pagesIndexed}{doc.pageCount ? ` / ${doc.pageCount}` : ""} pages…</span>}
                      {doc.status === "pending" && <span>Waiting to index</span>}
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
                  {isController && (
                    <button onClick={() => void removeDoc(doc)} title="Remove"
                      className="p-1.5 rounded-lg hover:bg-rose-500/10 text-[var(--color-text-muted)] hover:text-rose-600">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Recent questions ───────────────────────────────────────────── */}
        <div>
          <h2 className="text-xs font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-2 flex items-center gap-1.5">
            <History className="w-3.5 h-3.5" /> Recent questions ({history.length})
          </h2>
          {history.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] p-8 text-center text-xs text-[var(--color-text-muted)]">
              Questions and their cited answers land here for the whole team.
            </div>
          ) : (
            <ul className="space-y-2">
              {history.map((q) => (
                <li key={q.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
                  <div className="text-xs font-black text-[var(--color-text)] flex items-start gap-1.5">
                    {q.mode === "internet" && (
                      <span title="Internet answer — not from the library" className="shrink-0 mt-0.5">
                        <Globe className="w-3 h-3 text-sky-600" />
                      </span>
                    )}
                    <span>{q.question}</span>
                  </div>
                  {q.answer && (
                    <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)] whitespace-pre-wrap line-clamp-4">{q.answer}</div>
                  )}
                  <CitationChips citations={q.citations} onOpen={openCitation} />
                  <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                    {q.userName ?? "Someone"} · {new Date(q.createdAt).toLocaleString()}
                  </div>
                </li>
              ))}
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
