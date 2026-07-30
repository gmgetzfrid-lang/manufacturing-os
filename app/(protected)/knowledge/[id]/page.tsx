"use client";

// /knowledge/[id] — one AI knowledge library: the Ask box up top (that's the
// whole point), the shelf of PDFs below it with live indexing progress, and
// the recent Q&A so the team benefits from each other's questions.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  BookOpen, ArrowLeft, Sparkles, Loader2, Send, FileText, Upload,
  Trash2, RefreshCw, CheckCircle2, AlertTriangle, ExternalLink, History, Globe,
  ChevronRight,
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
  askKnowledgeLibrary, listKnowledgeQuestions,
  type KnowledgeLibrary, type KnowledgeDocument, type KnowledgeAnswer,
  type KnowledgeQuestion, type KnowledgeCitation, type AskMode,
} from "@/lib/knowledge";

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
  const parts = text.split(/(\[\d{1,2}\]|\*\*[^*]+\*\*)/g);
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
                className="inline-flex items-center justify-center align-baseline text-[10px] font-black min-w-[1.2rem] px-1 rounded bg-orange-600 text-white hover:bg-orange-700 transition-colors mx-0.5">
                {cite[1]}
              </button>
            );
          }
          return <span key={i} className="text-[10px] font-black text-orange-700">{part}</span>;
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return <b key={i} className="font-black">{part.slice(2, -2)}</b>;
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
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
    const [lib, documents, questions] = await Promise.all([
      getKnowledgeLibrary(libraryId),
      listKnowledgeDocuments(libraryId),
      listKnowledgeQuestions(libraryId),
    ]);
    setLibrary(lib);
    setDocs(documents);
    setHistory(questions);
    setLoading(false);
  }, [libraryId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const ask = async () => {
    if (!activeOrgId || !question.trim()) return;
    setAsking(true); setAskError(null); setAnswer(null);
    try {
      setAnswer(await askKnowledgeLibrary(activeOrgId, libraryId, question.trim(), mode));
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
          <Button variant="secondary" onClick={() => void removeLibrary()}>
            <Trash2 className="w-4 h-4" /> Delete library
          </Button>
        ) : undefined}
      />

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
        {answer && (
          <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            {answer.mode === "internet" && (
              <div className="mb-3 rounded-lg border border-sky-300 bg-sky-50 dark:bg-sky-950/40 dark:border-sky-800 px-3 py-2 text-[11px] font-bold text-sky-800 dark:text-sky-300 flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 shrink-0" />
                Internet answer — {answer.liveWeb ? "from a live web search" : "from the model's general knowledge (no live web on this provider)"}, NOT from your controlled documents.
              </div>
            )}
            {answer.mode === "internet" ? (
              <div className="text-sm text-[var(--color-text)] whitespace-pre-wrap leading-relaxed">{answer.answer}</div>
            ) : (
              <AnswerView answer={answer.answer} citations={answer.citations} onCite={openCitation} />
            )}
            <CitationChips citations={answer.citations} onOpen={openCitation} />
            <div className="mt-3 pt-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]">
              Answered by {answer.provider} · {answer.model} · {answer.mode === "internet"
                ? "internet answers carry no doc-control weight — cross-check before relying on them."
                : "click any citation number to open the page with the passage highlighted."}
            </div>
          </div>
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
    </PageShell>
  );
}
