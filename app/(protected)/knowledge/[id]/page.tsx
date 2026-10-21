"use client";

// /knowledge/[id] — one AI knowledge library: the door into asking it (the
// chat itself lives in /assistant, scoped here), the shelf of PDFs with live
// indexing progress, and the library's intelligence panels.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  BookOpen, ArrowLeft, Sparkles, Loader2, FileText, Upload,
  Trash2, RefreshCw, CheckCircle2, AlertTriangle, History, Globe, Bot,
  ChevronRight, ChevronDown, Wand2, Eye, MessageSquare, ArrowRight, FolderUp, Search,
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  getKnowledgeLibrary, listKnowledgeDocuments, addKnowledgeDocument,
  ingestKnowledgeDocument, deleteKnowledgeDocuments, deleteKnowledgeLibrary,
  listLibraryLinks,
  type KnowledgeLibrary, type KnowledgeDocument,
  type KnowledgeLibraryLink,
  rebuildDrawingIndex,
} from "@/lib/knowledge";
import { listThreads, type ChatThread } from "@/lib/chatClient";
import LibraryAiModal from "@/components/knowledge/LibraryAiModal";
import SourcesPanel from "@/components/knowledge/SourcesPanel";
import DrawingIntelPanel from "@/components/knowledge/DrawingIntelPanel";
import LibraryMapPanel from "@/components/knowledge/LibraryMapPanel";
import HealthPanel from "@/components/knowledge/HealthPanel";
import SemanticIndexPanel from "@/components/knowledge/SemanticIndexPanel";
import { collectDroppedFiles, filesFromDirectoryInput } from "@/lib/folderUpload";

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
export default function KnowledgeLibraryPage() {
  const params = useParams<{ id: string }>();
  const libraryId = params.id;
  const router = useRouter();
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const [library, setLibrary] = useState<KnowledgeLibrary | null>(null);
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  // The per-document status list is bookkeeping, not the point of the page —
  // collapsed by default, live counts always in the header.
  const [docsOpen, setDocsOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // Opening the library quietly advances any pending meaning-index build
  // server-side (fire-and-forget) — large builds no longer depend on a tab.
  useEffect(() => {
    void import("@/lib/knowledge").then((m) => m.nudgeEmbedDrain());
  }, []);

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Multi-select on the shelf: remove many at once instead of one by one.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // A long removal (a big library, many documents) shows progress in place.
  const [removing, setRemoving] = useState<{ label: string; done: number; total: number } | null>(null);
  const [uploadState, setUploadState] = useState<{ name: string; phase: string } | null>(null);
  const [reindexing, setReindexing] = useState<string | null>(null);
  // Browser-driven queue drain: linked source documents index right here,
  // automatically — free-tier hosting kills long server jobs, so the open
  // page is the reliable indexing engine.
  const [autoIndexing, setAutoIndexing] = useState<{
    name: string; remaining: number; visionPages?: number; visionSkipReason?: string | null; waiting?: string | null;
  } | null>(null);
  const autoIndexRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [links, setLinks] = useState<KnowledgeLibraryLink[]>([]);
  const [showAiSetup, setShowAiSetup] = useState(false);

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
    const [lib, documents, libLinks] = await Promise.all([
      getKnowledgeLibrary(libraryId),
      listKnowledgeDocuments(libraryId),
      listLibraryLinks(libraryId),
    ]);
    setLibrary(lib);
    setDocs(documents);
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
        const report = (progress?: { visionPages?: number; visionSkipReason?: string | null; waiting?: string | null }) => {
          if (!mountedRef.current) return;
          const names = [...active.values()];
          setAutoIndexing({
            name: names.length > 1 ? `${names[0]} (+${names.length - 1} more)` : names[0] ?? "",
            remaining,
            ...(progress ? {
              visionPages: progress.visionPages,
              visionSkipReason: progress.visionSkipReason,
              waiting: progress.waiting ?? null,
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

  // Uploads go up THREE at a time and only queue the document; the
  // library's indexer (above) drains the queue. A dropped folder of 300 PDFs
  // used to upload-then-index one file at a time with a toast per file.
  const onFiles = async (input: File[] | FileList | null) => {
    if (!input || !activeOrgId || !uid) return;
    const all = Array.from(input);
    const pdfs = all.filter((f) => /\.pdf$/i.test(f.name));
    const skipped = all.length - pdfs.length;
    if (pdfs.length === 0) {
      showToast({ type: "error", title: skipped ? `Only PDF files can be indexed — ${skipped} other file(s) skipped.` : "No files." });
      return;
    }
    if (pdfs.length === 1) {
      // One file: upload and index it right here, with page progress.
      const file = pdfs[0];
      try {
        setUploadState({ name: file.name, phase: "Uploading…" });
        await addKnowledgeDocument({
          orgId: activeOrgId, libraryId, file,
          userId: uid, userName: userEmail ?? "Member",
          onUpload: (p) => setUploadState({ name: file.name, phase: `Uploading… ${Math.round(p.percent)}%` }),
          onIndex: (indexed, total) => {
            setUploadState({ name: file.name, phase: `Indexing… ${indexed}${total ? ` / ${total}` : ""} pages` });
            void listKnowledgeDocuments(libraryId).then(setDocs);
          },
        });
        showToast({ type: "success", title: `${file.name} indexed and searchable.` });
      } catch (e) {
        showToast({ type: "error", title: `${file.name}: ${(e as Error).message}` });
      }
    } else {
      let done = 0;
      const failed: string[] = [];
      const queue = [...pdfs];
      setUploadState({ name: `${pdfs.length} PDFs`, phase: `Uploading 0 of ${pdfs.length}…` });
      const worker = async () => {
        for (let file = queue.shift(); file; file = queue.shift()) {
          try {
            await addKnowledgeDocument({
              orgId: activeOrgId, libraryId, file, index: false,
              userId: uid, userName: userEmail ?? "Member",
            });
          } catch { failed.push(file.name); }
          done++;
          if (mountedRef.current) setUploadState({ name: `${pdfs.length} PDFs`, phase: `Uploading ${done} of ${pdfs.length}…` });
        }
      };
      await Promise.all(Array.from({ length: 3 }, () => worker()));
      showToast(failed.length
        ? { type: "error", title: `${pdfs.length - failed.length} uploaded; ${failed.length} failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}` }
        : { type: "success", title: `${pdfs.length} PDFs uploaded — indexing them now.` });
    }
    if (skipped > 0) showToast({ type: "info", title: `${skipped} non-PDF file(s) skipped — only PDFs can be indexed.` });
    setUploadState(null);
    await refresh();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!isController || uploadState !== null) return;
    const { promise } = collectDroppedFiles(e.dataTransfer.items);
    setDocsOpen(true);
    void promise.then(
      (files) => onFiles(files.map((f) => f.file)),
      (err) => showToast({ type: "error", title: (err as Error).message }),
    );
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

  const removeDocs = async (ids: string[]) => {
    if (!activeOrgId || ids.length === 0) return;
    const names = docs.filter((d) => ids.includes(d.id)).map((d) => d.name);
    const ok = await appConfirm({
      title: ids.length === 1 ? "Remove document?" : `Remove ${ids.length} documents?`,
      message: (ids.length === 1 ? `"${names[0]}"` : `${ids.length} documents`) +
        " — the PDF" + (ids.length === 1 ? "" : "s") + " and the search index — will be deleted from this library. " +
        "Answers they already contributed to stay in the history.",
      confirmLabel: ids.length === 1 ? "Remove" : `Remove ${ids.length}`,
    });
    if (!ok) return;
    setRemoving({ label: "Removing documents", done: 0, total: ids.length });
    try {
      const n = await deleteKnowledgeDocuments(activeOrgId, libraryId, ids,
        (done) => setRemoving({ label: "Removing documents", done, total: ids.length }));
      setSelected(new Set());
      showToast({ type: "success", title: `${n} document${n === 1 ? "" : "s"} removed.` });
    } catch (e) { showToast({ type: "error", title: (e as Error).message }); }
    finally { setRemoving(null); await refresh(); }
  };

  const removeLibrary = async () => {
    if (!library || !activeOrgId) return;
    const ok = await appConfirm({
      title: `Delete "${library.name}"?`,
      message: `This deletes the library and everything in it: ${docs.length} document${docs.length === 1 ? "" : "s"}, ` +
        "their search index, and the library's conversations and question history. " +
        "Controlled documents mirrored from Document Control stay in Document Control. This cannot be undone.",
      confirmLabel: "Delete library",
    });
    if (!ok) return;
    setRemoving({ label: "Deleting library", done: 0, total: docs.length });
    try {
      await deleteKnowledgeLibrary(activeOrgId, library.id,
        (done, remaining) => setRemoving({ label: "Deleting library", done, total: done + remaining }));
      showToast({ type: "success", title: `"${library.name}" deleted.` });
      router.push("/knowledge");
    } catch (e) {
      setRemoving(null);
      showToast({ type: "error", title: (e as Error).message });
    }
  };

  const removable = docs.filter((d) => !d.sourceDocumentId);
  // ── Find a document in a long list: search, filter by state, sort. A
  //    library of a thousand standards is unreadable as one unsorted list.
  const [docQuery, setDocQuery] = useState("");
  const [docFilter, setDocFilter] = useState<"all" | "ready" | "working" | "failed" | "uploaded">("all");
  const [docSort, setDocSort] = useState<"name" | "pages" | "problems">("name");
  const [docLimit, setDocLimit] = useState(200);
  const docGroups = {
    all: docs.length,
    ready: docs.filter((d) => d.status === "ready").length,
    working: docs.filter((d) => d.status === "pending" || d.status === "indexing" || d.status === "stale").length,
    failed: docs.filter((d) => d.status === "error").length,
    uploaded: docs.filter((d) => !d.sourceDocumentId).length,
  };
  const shownDocs = (() => {
    const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const words = docQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const list = docs.filter((d) => {
      if (docFilter === "ready" && d.status !== "ready") return false;
      if (docFilter === "working" && !(d.status === "pending" || d.status === "indexing" || d.status === "stale")) return false;
      if (docFilter === "failed" && d.status !== "error") return false;
      if (docFilter === "uploaded" && d.sourceDocumentId) return false;
      if (!words.length) return true;
      // "ep 5-2-3", "EP523" and "piping specs" all find their document.
      const name = d.name.toLowerCase();
      return words.every((w) => name.includes(w) || squash(name).includes(squash(w)));
    });
    const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const rank = (d: typeof docs[number]) => (d.status === "error" ? 0 : d.status === "ready" ? 2 : 1);
    return list.sort((a, b) =>
      docSort === "pages" ? (b.pageCount ?? 0) - (a.pageCount ?? 0)
      : docSort === "problems" ? rank(a) - rank(b) || natural.compare(a.name, b.name)
      : natural.compare(a.name, b.name));
  })();
  const toggleSelect = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

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
            <Button variant="secondary" onClick={() => void removeLibrary()} disabled={removing !== null}>
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

      {removing && (
        <div className="mb-4 rounded-xl border border-rose-300 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-950/20 px-3 py-2.5 text-xs">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-rose-600 shrink-0" />
            <span className="font-bold">{removing.label}…</span>
            <span className="text-[var(--color-text-muted)] ml-auto">{removing.done} of {removing.total} documents removed</span>
          </div>
          {removing.total > 0 && (
            <div className="mt-1.5 h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
              <div className="h-full bg-rose-500 transition-all" style={{ width: `${Math.round((removing.done / removing.total) * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {/* ── Ask ─────────────────────────────────────────────────────────── */}
      {/* The chat itself lives in the shell (/assistant), scoped to this
          library — one conversation model for every source. This card is
          the door: ask, or pick up a recent conversation. */}
      {activeOrgId && (
        <AskEntry orgId={activeOrgId} libraryId={libraryId} readyDocs={readyDocs} docsTotal={docs.length} />
      )}

      {/* Is the index a complete, current copy of what it's linked to? */}
      {activeOrgId && (
        <HealthPanel orgId={activeOrgId} libraryId={libraryId} isController={isController} onRepaired={() => void refresh()} />
      )}

      {/* What the assistant knows is in here — forms, checklists, specs. */}
      {activeOrgId && readyDocs > 0 && <LibraryMapPanel orgId={activeOrgId} libraryId={libraryId} />}

      <div>
        {/* ── Documents ──────────────────────────────────────────────────── */}
        {/* The whole section is a drop target: files or folders (every PDF
            inside, any depth), straight from the desktop. */}
        <div
          onDragOver={(e) => { if (isController && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
          onDrop={onDrop}
          className={dragOver ? "rounded-2xl outline-2 outline-dashed outline-orange-400 outline-offset-4 bg-orange-50/40 dark:bg-orange-950/10" : undefined}
        >
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
                  onChange={(e) => { void onFiles(e.target.files ? Array.from(e.target.files) : null); e.target.value = ""; }} />
                <input ref={folderInput} type="file" multiple hidden
                  {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                  onChange={(e) => {
                    try {
                      const files = e.target.files ? filesFromDirectoryInput(e.target.files).map((f) => f.file) : null;
                      setDocsOpen(true);
                      void onFiles(files);
                    } catch (err) { showToast({ type: "error", title: (err as Error).message }); }
                    e.target.value = "";
                  }} />
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => folderInput.current?.click()} disabled={uploadState !== null}
                    title="Pick a folder — every PDF inside it, in any subfolder, is added">
                    <FolderUp className="w-3.5 h-3.5" /> Add folder
                  </Button>
                  <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploadState !== null}>
                    <Upload className="w-3.5 h-3.5" /> Add PDFs
                  </Button>
                </div>
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
              {autoIndexing.waiting && (
                <div role="status" className="mt-1 flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-400 font-bold">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-px" /> {autoIndexing.waiting}
                </div>
              )}
            </div>
          )}

          {!docsOpen && docs.length > 0 ? null : docs.length === 0 && !uploadState ? (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] p-8 text-center text-xs text-[var(--color-text-muted)]">
              <FileText className="w-6 h-6 mx-auto mb-2 opacity-50" />
              {isController ? "Drag PDFs or whole folders here to build the shelf." : "No documents yet — Admin or Doc Control can add PDFs."}
            </div>
          ) : (
            <>
            {isController && removable.length > 0 && (
              <div className="mb-1.5 flex items-center gap-2 text-[11px]">
                <label className="inline-flex items-center gap-1.5 font-bold text-[var(--color-text-muted)] cursor-pointer select-none">
                  <input type="checkbox" className="accent-orange-600"
                    checked={selected.size > 0 && selected.size === removable.length}
                    ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < removable.length; }}
                    onChange={() => setSelected(selected.size === removable.length ? new Set() : new Set(removable.map((d) => d.id)))} />
                  {selected.size > 0 ? `${selected.size} selected` : "Select all"}
                </label>
                {selected.size > 0 && (
                  <>
                    <button onClick={() => void removeDocs([...selected])} disabled={removing !== null}
                      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg bg-rose-600 text-white font-black hover:bg-rose-700 disabled:opacity-50">
                      <Trash2 className="w-3.5 h-3.5" /> Remove {selected.size}
                    </button>
                    <button onClick={() => setSelected(new Set())} className="font-bold text-[var(--color-text-muted)] hover:underline">Clear</button>
                  </>
                )}
              </div>
            )}
            <div className="mb-2 flex items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
                <input id="kdoc-search" value={docQuery} onChange={(e) => { setDocQuery(e.target.value); setDocLimit(200); }}
                  placeholder={`Search ${docs.length.toLocaleString()} documents — "EP 5-2-3", "piping specs"…`}
                  className="w-full h-8 pl-8 pr-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-orange-400" />
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {([
                  ["all", "All"], ["ready", "Indexed"], ["working", "In progress"], ["failed", "Failed"], ["uploaded", "Uploaded here"],
                ] as const).filter(([k]) => k === "all" || docGroups[k] > 0).map(([k, label]) => (
                  <button key={k} onClick={() => { setDocFilter(k); setDocLimit(200); }}
                    className={`h-7 px-2 rounded-lg text-[10px] font-black border transition-colors ${docFilter === k
                      ? "bg-orange-600 text-white border-orange-600"
                      : `border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] ${k === "failed" ? "text-rose-700 dark:text-rose-400" : ""}`}`}>
                    {label} {docGroups[k].toLocaleString()}
                  </button>
                ))}
              </div>
              <select aria-label="Sort documents" value={docSort} onChange={(e) => setDocSort(e.target.value as typeof docSort)}
                className="h-7 px-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[10px] font-black text-[var(--color-text-muted)]">
                <option value="name">Sort: number</option>
                <option value="pages">Sort: most pages</option>
                <option value="problems">Sort: problems first</option>
              </select>
            </div>
            {shownDocs.length === 0 && (
              <div className="rounded-xl border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-text-muted)]">
                No document matches{docQuery ? ` "${docQuery}"` : ""}{docFilter !== "all" ? " in this filter" : ""}.
              </div>
            )}
            <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
              {shownDocs.slice(0, docLimit).map((doc) => (
                <li key={doc.id} className={`px-3.5 py-2.5 flex items-center gap-3 ${selected.has(doc.id) ? "bg-orange-50/70 dark:bg-orange-950/20" : "bg-[var(--color-surface)]"}`}>
                  {isController && (
                    <input type="checkbox" className="accent-orange-600 shrink-0" aria-label={`Select ${doc.name}`}
                      disabled={!!doc.sourceDocumentId} checked={selected.has(doc.id)}
                      title={doc.sourceDocumentId ? "Mirrored from Document Control — remove it by unlinking the source" : undefined}
                      onChange={() => toggleSelect(doc.id)} />
                  )}
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
                    <button onClick={() => void removeDocs([doc.id])} title="Remove" disabled={removing !== null}
                      className="p-1.5 rounded-lg hover:bg-rose-500/10 text-[var(--color-text-muted)] hover:text-rose-600">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {shownDocs.length > docLimit && (
              <button onClick={() => setDocLimit((n) => n + 500)}
                className="mt-1.5 w-full h-8 rounded-lg border border-[var(--color-border)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                Showing {docLimit.toLocaleString()} of {shownDocs.length.toLocaleString()} — show more
              </button>
            )}
            </>
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

/** The door into the chat, scoped to this library: ask now, or pick up one
 *  of the recent conversations. The conversations rail in the shell has the
 *  full list, search, pin and settle. */
function AskEntry({ orgId, libraryId, readyDocs, docsTotal }: {
  orgId: string; libraryId: string; readyDocs: number; docsTotal: number;
}) {
  const [recent, setRecent] = useState<ChatThread[] | null>(null);
  const [instructionCount, setInstructionCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void listThreads(orgId, { libraryId, limit: 4 }).then(
      (ts) => { if (!cancelled) setRecent(ts); },
      () => { if (!cancelled) setRecent([]); },
    );
    void import("@/lib/aiInstructions").then((m) =>
      m.countActiveInstructions(orgId, "knowledge").then((n) => { if (!cancelled) setInstructionCount(n); }));
    return () => { cancelled = true; };
  }, [orgId, libraryId]);
  const askHref = `/assistant?library=${libraryId}`;
  const router = useRouter();
  const [q, setQ] = useState("");
  const ask = (e: React.FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    if (!text) return;
    router.push(`/assistant?library=${libraryId}&ask=${encodeURIComponent(text.slice(0, 2000))}`);
  };
  return (
    <div className="rounded-2xl border-2 border-orange-300 dark:border-orange-800 bg-gradient-to-br from-orange-50/70 to-[var(--color-surface)] dark:from-orange-950/20 dark:to-[var(--color-surface)] p-5 mb-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-black text-[var(--color-text)]">Ask this library</div>
          <div className="text-[10px] text-[var(--color-text-muted)]">
            Answers come only from the indexed documents, cited to the page.
            {instructionCount > 0 && (
              <Link href="/admin/ai-instructions" className="ml-1.5 font-bold text-violet-700 dark:text-violet-300 hover:underline">
                {instructionCount} standing instruction{instructionCount === 1 ? "" : "s"} apply
              </Link>
            )}
          </div>
        </div>
        <Link href={askHref}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-orange-600 text-white text-xs font-black hover:bg-orange-700 transition-colors">
          <MessageSquare className="w-4 h-4" /> All conversations <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
      {/* Ask right here — the question opens in the chat already running,
          instead of a door you have to walk through first. */}
      <form onSubmit={ask} className="mt-4 flex items-center gap-2">
        <input id="library-ask" value={q} onChange={(e) => setQ(e.target.value)} disabled={readyDocs === 0}
          placeholder={readyDocs === 0 ? "Asking unlocks when the first document is indexed" : "Ask this library — e.g. \"Can I use seam-welded 304 pipe?\""}
          className="flex-1 min-w-0 h-11 px-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-orange-400 disabled:opacity-60" />
        <button type="submit" disabled={readyDocs === 0 || !q.trim()}
          className="inline-flex items-center gap-1.5 h-11 px-4 rounded-xl bg-orange-600 text-white text-sm font-black hover:bg-orange-700 disabled:opacity-40 transition-colors">
          Ask <ArrowRight className="w-4 h-4" />
        </button>
      </form>
      {readyDocs === 0 && (
        <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-400 font-bold">
          {docsTotal > 0
            ? "Documents are indexing below — asking unlocks as soon as the first one finishes."
            : "Nothing indexed yet — link a source or add PDF documents below first."}
        </p>
      )}
      {recent && recent.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5 flex items-center gap-1.5">
            <History className="w-3 h-3" /> Recent conversations
          </div>
          <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            {recent.map((t) => (
              <li key={t.id}>
                <Link href={`/assistant?thread=${t.id}&library=${libraryId}`}
                  className="flex items-center gap-2.5 px-3.5 py-2 hover:bg-[var(--color-surface-2)] transition-colors group">
                  {t.scope === "internet" ? <Globe className="w-3.5 h-3.5 text-sky-600 shrink-0" />
                    : t.scope === "tools" ? <Bot className="w-3.5 h-3.5 text-violet-600 shrink-0" />
                    : <MessageSquare className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-bold text-[var(--color-text)] truncate">{t.title || "Untitled"}</span>
                    <span className="block text-[10px] text-[var(--color-text-muted)]">
                      {(t.createdByName ?? "Someone").split("@")[0]} · {new Date(t.lastMessageAt).toLocaleString()}{t.settledAt ? " · settled" : ""}
                    </span>
                  </span>
                  <span className="text-[10px] font-black text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0">Reopen →</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
