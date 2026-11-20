"use client";

// /knowledge/[id] — one AI knowledge library: the door into asking it (the
// chat itself lives in /assistant, scoped here), the shelf of PDFs with live
// indexing progress, and the library's intelligence panels.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Loader2, FileText, Upload,
  Trash2, RefreshCw, AlertTriangle, History, Globe, Bot,
  ChevronRight, ChevronDown, Wand2, Eye, MessageSquare, ArrowRight, FolderUp, Search,
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroQuiet } from "@/components/ui/PageHero";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { Button } from "@/components/ui/Button";
import { appConfirm } from "@/components/providers/DialogProvider";
import LoadingBlock from "@/components/ui/LoadingBlock";
import MoreMenu from "@/components/ui/MoreMenu";
import { useFileDrag } from "@/hooks/useFileDrag";
import { useDraft } from "@/hooks/useDraft";
import { tryUpload } from "@/lib/uploadRetry";
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
import AnswerTestsPanel from "@/components/knowledge/AnswerTestsPanel";
import { SourcesMenu, AnswerMenu, SkillHint, useAnswerSkills } from "@/components/chat/AskControls";
import type { AnswerMode } from "@/lib/answerModes";
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
  const [loadError, setLoadError] = useState<string | null>(null);

  // Opening the library quietly advances any pending meaning-index build
  // server-side (fire-and-forget) — large builds no longer depend on a tab.
  useEffect(() => {
    void import("@/lib/knowledge").then((m) => m.nudgeEmbedDrain());
  }, []);

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // Files whose upload failed in a batch: each keeps its own Try again.
  const [failedUploads, setFailedUploads] = useState<Array<{ file: File; error: string }>>([]);
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
    try {
      const [lib, documents, libLinks] = await Promise.all([
        getKnowledgeLibrary(libraryId),
        listKnowledgeDocuments(libraryId),
        listLibraryLinks(libraryId),
      ]);
      setLibrary(lib);
      setDocs(documents);
      setLinks(libLinks);
      setLoadError(null);
    } catch (e) {
      // A failed read says so, instead of "not found" or an empty shelf.
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
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
  // One file up and on the shelf (queued, not indexed): the step that's safe
  // to repeat, so the corner card's Try again can run it with the same file.
  // Indexing runs after, once, on the record that now exists.
  const upOne = (file: File, onUpload?: (p: { percent: number }) => void) => {
    if (!activeOrgId || !uid) return Promise.reject(new Error("Pick a workspace first."));
    const orgId = activeOrgId, userId = uid;
    return tryUpload(file.name, () => addKnowledgeDocument({
      orgId, libraryId, file, index: false,
      userId, userName: userEmail ?? "Member", onUpload,
    }), {
      onRetried: () => {
        setFailedUploads((fs) => fs.filter((f) => f.file !== file));
        void refresh();
      },
    });
  };
  const retryUpload = async (file: File) => {
    setFailedUploads((fs) => fs.filter((f) => f.file !== file));
    try { await upOne(file); showToast({ type: "success", title: `${file.name} uploaded. Indexing it now.` }); }
    catch (e) { setFailedUploads((fs) => [...fs, { file, error: (e as Error).message }]); }
    await refresh();
  };

  const onFiles = async (input: File[] | FileList | null) => {
    if (!input || !activeOrgId || !uid) return;
    const all = Array.from(input);
    const pdfs = all.filter((f) => /\.pdf$/i.test(f.name));
    const skipped = all.length - pdfs.length;
    if (pdfs.length === 0) {
      showToast({ type: "error", title: skipped ? `Only PDF files can be indexed. ${skipped} other file(s) skipped.` : "No files." });
      return;
    }
    if (pdfs.length === 1) {
      // One file: upload and index it right here, with page progress.
      const file = pdfs[0];
      let doc: KnowledgeDocument | null = null;
      try {
        setUploadState({ name: file.name, phase: "Uploading…" });
        doc = await upOne(file, (p) => setUploadState({ name: file.name, phase: `Uploading… ${Math.round(p.percent)}%` }));
      } catch (e) {
        setFailedUploads((fs) => [...fs, { file, error: (e as Error).message }]);
      }
      if (doc) {
        // Say what it read, not just that it finished.
        let read = 0;
        let of: number | null = null;
        try {
          await ingestKnowledgeDocument(doc.id, (indexed, total) => {
            read = indexed; of = total;
            setUploadState({ name: file.name, phase: `Reading… ${indexed}${total ? ` / ${total}` : ""} pages` });
            void listKnowledgeDocuments(libraryId).then(setDocs, () => undefined);
          });
          showToast({ type: "success", title: `Read ${read}${of ? ` of ${of}` : ""} page${(of ?? read) === 1 ? "" : "s"} of ${file.name}. It's searchable now.` });
        } catch (e) {
          showToast({ type: "error", title: `${file.name} is on the shelf but wasn't fully read: ${(e as Error).message}. Use Resume indexing on its row.` });
        }
      }
    } else {
      let done = 0;
      const failed: Array<{ file: File; error: string }> = [];
      const queue = [...pdfs];
      setUploadState({ name: `${pdfs.length} PDFs`, phase: `Uploading 0 of ${pdfs.length}…` });
      const worker = async () => {
        for (let file = queue.shift(); file; file = queue.shift()) {
          try { await upOne(file); }
          catch (e) { failed.push({ file, error: (e as Error).message }); }
          done++;
          if (mountedRef.current) setUploadState({ name: `${pdfs.length} PDFs`, phase: `Uploading ${done} of ${pdfs.length}…` });
        }
      };
      await Promise.all(Array.from({ length: 3 }, () => worker()));
      if (failed.length) setFailedUploads((fs) => [...fs, ...failed]);
      showToast(failed.length
        ? { type: "error", title: `${pdfs.length - failed.length} uploaded; ${failed.length} didn't. Each has Try again on the shelf.` }
        : { type: "success", title: `${pdfs.length} PDFs uploaded. Indexing them now.` });
    }
    if (skipped > 0) showToast({ type: "info", title: `${skipped} non-PDF file(s) skipped. Only PDFs can be indexed.` });
    setUploadState(null);
    await refresh();
  };

  // The drop box answers back while files are over it. Folders need the
  // drop's items (read here, before the event ends), so the hook only
  // lights the box; the files are collected below.
  const docsDrag = useFileDrag(() => undefined, !isController || uploadState !== null);
  const onDrop = (e: React.DragEvent) => {
    if (isController && uploadState === null && Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
      const { promise } = collectDroppedFiles(e.dataTransfer.items);
      setDocsOpen(true);
      void promise.then(
        (files) => onFiles(files.map((f) => f.file)),
        (err) => showToast({ type: "error", title: (err as Error).message }),
      );
    }
    docsDrag.bind.onDrop(e);
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
        " - the PDF" + (ids.length === 1 ? "" : "s") + " and the search index - will be deleted from this library. " +
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
  const [docFilter, setDocFilter] = useState<"all" | "ready" | "partial" | "working" | "failed" | "uploaded">("all");
  const partlyRead = (d: typeof docs[number]) => d.status === "ready" && !((d.pageCount ?? 0) > 0 && d.pagesIndexed >= (d.pageCount ?? 0));
  const [docSort, setDocSort] = useState<"name" | "pages" | "problems">("name");
  const [docLimit, setDocLimit] = useState(200);
  const docGroups = {
    all: docs.length,
    ready: docs.filter((d) => d.status === "ready" && !partlyRead(d)).length,
    partial: docs.filter(partlyRead).length,
    working: docs.filter((d) => d.status === "pending" || d.status === "indexing" || d.status === "stale").length,
    failed: docs.filter((d) => d.status === "error").length,
    uploaded: docs.filter((d) => !d.sourceDocumentId).length,
  };
  const shownDocs = (() => {
    const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const words = docQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const list = docs.filter((d) => {
      if (docFilter === "ready" && (d.status !== "ready" || partlyRead(d))) return false;
      if (docFilter === "partial" && !partlyRead(d)) return false;
      if (docFilter === "working" && !(d.status === "pending" || d.status === "indexing" || d.status === "stale")) return false;
      if (docFilter === "failed" && d.status !== "error") return false;
      if (docFilter === "uploaded" && d.sourceDocumentId) return false;
      if (!words.length) return true;
      // "ep 5-2-3", "EP523" and "piping specs" all find their document.
      const name = d.name.toLowerCase();
      return words.every((w) => name.includes(w) || squash(name).includes(squash(w)));
    });
    const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const rank = (d: typeof docs[number]) => (d.status === "error" ? 0 : partlyRead(d) ? 1 : d.status === "ready" ? 3 : 2);
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

  if (loading) {
    return (
      <PageShell>
        <PageHero back={{ href: "/knowledge", label: "Back to Knowledge" }} kicker="Intelligence · Knowledge" title="Loading the library…" size="md" />
        <PageBody><Card><LoadingBlock what="the library" rows={6} className="border-0 p-0" /></Card></PageBody>
      </PageShell>
    );
  }
  if (!library) {
    return (
      <PageShell>
        <PageHero back={{ href: "/knowledge", label: "Back to Knowledge" }} kicker="Intelligence · Knowledge"
          title={loadError ? "This library didn't open." : "This library isn't there."} size="md" />
        <PageBody>
          <Card>
            {loadError
              ? <p role="alert" className="text-[15px] font-semibold text-[var(--state-overdue)]">Couldn&apos;t open this library: {loadError}</p>
              : <p className="text-[14px] text-[var(--color-text-muted)]">It may have been deleted.</p>}
            <div className="mt-4 flex gap-2">
              {loadError && <Button variant="secondary" onClick={() => { setLoading(true); void refresh(); }}><RefreshCw className="w-4 h-4" /> Try again</Button>}
              <Button variant="secondary" onClick={() => router.push("/knowledge")}>Go to Knowledge</Button>
            </div>
          </Card>
        </PageBody>
      </PageShell>
    );
  }

  const readyDocs = docs.filter((d) => d.status === "ready").length;
  const indexingDocs = docs.filter((d) => d.status === "indexing" || d.status === "pending" || d.status === "stale").length;

  // The answer: how much is in here, and how much of it can be asked.
  const answer = docs.length === 0
    ? "Empty, nothing to ask yet"
    : readyDocs === docs.length
      ? `All ${docs.length.toLocaleString()} ${docs.length === 1 ? "document" : "documents"} indexed`
      : readyDocs === 0
        ? "Nothing indexed yet"
        : `${readyDocs.toLocaleString()} of ${docs.length.toLocaleString()} documents indexed`;
  const facts = docs.length > 0 ? [
    { label: "Documents", value: docs.length.toLocaleString() },
    { label: "Indexed", value: readyDocs.toLocaleString(), tone: readyDocs === docs.length ? "good" as const : undefined },
    ...(indexingDocs > 0 ? [{ label: "In progress", value: indexingDocs.toLocaleString(), tone: "warn" as const }] : []),
    ...(docGroups.failed > 0 ? [{ label: "Failed", value: docGroups.failed.toLocaleString(), tone: "bad" as const }] : []),
  ] : undefined;

  return (
    <PageShell>
      <PageHero
        back={{ href: "/knowledge", label: "Back to Knowledge" }}
        kicker={<>Knowledge · {library.name}</>}
        title={answer}
        size="md"
        facts={facts}
        sub={
          <>
            {library.description ? <span className="line-clamp-2">{library.description}</span> : null}
            {indexingDocs > 0 && <span className="block mt-1">Asking works on what&apos;s already indexed.</span>}
            {loadError && (
              <span role="alert" className="block mt-1 text-[var(--state-overdue)] font-semibold">
                Couldn&apos;t refresh the library: {loadError}{" "}
                <button type="button" onClick={() => void refresh()} className="font-normal text-[var(--color-accent-text)] hover:underline">Try again</button>
              </span>
            )}
          </>
        }
        tools={isController ? (
          <>
            <button type="button" className={heroQuiet} onClick={() => setShowAiSetup(true)}>
              <Wand2 className="w-4 h-4" /><span className="max-sm:hidden">Library AI setup</span><span className="sr-only sm:hidden">Library AI setup</span>
            </button>
            <MoreMenu iconOnly label="More" triggerClass={heroQuiet} items={[
              { icon: <Trash2 className="w-4 h-4" />, label: "Delete library", tone: "bad", onClick: () => { if (removing === null) void removeLibrary(); } },
            ]} />
          </>
        ) : undefined}
      >
        {links.length > 0 && (
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[14px] text-[var(--color-text-muted)]">
            <span>Also searches</span>
            {links.map((l) => (
              <span key={l.id} className="font-semibold text-[var(--color-text)]">{l.linkedLibraryName} <span className="font-normal text-[var(--color-text-muted)]">(reference)</span></span>
            ))}
            <span>This library governs; answers say which document won.</span>
          </div>
        )}
      </PageHero>

      <PageBody>
      {removing && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[14px]">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)] shrink-0" />
            <span className="font-semibold">{removing.label}…</span>
            <span className="text-[var(--color-text-muted)] ml-auto">{removing.done} of {removing.total} documents removed</span>
          </div>
          {removing.total > 0 && (
            <div className="mt-1.5 h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
              <div className="h-full bg-[var(--color-text-muted)] transition-all" style={{ width: `${Math.round((removing.done / removing.total) * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {/* ── Ask ─────────────────────────────────────────────────────────── */}
      {/* The chat itself lives in the shell (/assistant), scoped to this
          library — one conversation model for every source. This card is
          the door: ask, or pick up a recent conversation. */}
      {activeOrgId && (
        <AskEntry orgId={activeOrgId} libraryId={libraryId} libraryName={library.name} readyDocs={readyDocs} docsTotal={docs.length} />
      )}

      {/* Is the index a complete, current copy of what it's linked to? */}
      {activeOrgId && (
        <HealthPanel orgId={activeOrgId} libraryId={libraryId} isController={isController} onRepaired={() => void refresh()} />
      )}

      {/* What the assistant knows is in here — forms, checklists, specs. */}
      {activeOrgId && readyDocs > 0 && <LibraryMapPanel orgId={activeOrgId} libraryId={libraryId} libraryName={library.name} docs={docs} />}

      {/* Proof the answers hold up: real questions, re-asked and scored. */}
      {activeOrgId && isController && readyDocs > 0 && <AnswerTestsPanel orgId={activeOrgId} libraryId={libraryId} />}

      <section>
        {/* ── Documents ──────────────────────────────────────────────────── */}
        <div className="flex items-end gap-3 mb-2.5 min-h-8">
          <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">Documents</h2>
        </div>
        {/* The whole sheet is a drop target: files or folders (every PDF
            inside, any depth), straight from the desktop. */}
        <div
          {...docsDrag.bind}
          onDrop={onDrop}
          className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 ${docsDrag.over ? docsDrag.ring : ""}`}
        >
          {docsDrag.over && <p className="mb-2 text-center text-[15px] font-semibold text-[var(--color-text)]">{docsDrag.say}: PDFs and whole folders</p>}
          {activeOrgId && (
            <SourcesPanel orgId={activeOrgId} libraryId={libraryId}
              isController={isController} onChanged={() => void refresh()} />
          )}
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <button onClick={() => setDocsOpen((v) => !v)} aria-expanded={docsOpen}
              className="flex items-center gap-1.5 text-[15px] font-semibold text-[var(--color-text)] hover:underline mr-auto">
              {docsOpen ? <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)]" />}
              <span>{readyDocs.toLocaleString()} of {docs.length.toLocaleString()} indexed{indexingDocs > 0 && <span className="font-normal text-[var(--color-text-muted)]">, {indexingDocs} in progress</span>}</span>
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
                      "Every document re-reads from scratch - text, tables, tags, and anchors. "
                      + "Do this after an ingestion upgrade or when indexing missed things. "
                      + "Runs in the background; you can leave this page.",
                    confirmLabel: "Re-index",
                  });
                  if (!ok || !activeOrgId) return;
                  try {
                    const res = await rebuildDrawingIndex(activeOrgId, libraryId);
                    showToast({ type: "success", title: `${res.docs} document(s) queued - indexing starts now.` });
                    void refresh();
                  } catch (e) {
                    showToast({ type: "error", title: (e as Error).message });
                  }
                }}
                className={heroQuiet + " !h-8 !text-[13px]"}
              >
                <RefreshCw className="w-3.5 h-3.5" /> Re-index all
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
                    title="Pick a folder: every PDF inside it, in any subfolder, is added">
                    <FolderUp className="w-3.5 h-3.5" /> Add folder
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()} disabled={uploadState !== null}>
                    <Upload className="w-3.5 h-3.5" /> Add PDFs
                  </Button>
                </div>
              </>
            )}
          </div>

          {uploadState && (
            <div className="mb-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 flex items-center gap-2 text-[14px]">
              <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)] shrink-0" />
              <span className="font-semibold truncate">{uploadState.name}</span>
              <span className="text-[var(--color-text-muted)] shrink-0 ml-auto">{uploadState.phase}</span>
            </div>
          )}
          {failedUploads.length > 0 && (
            <ul className="mb-2 space-y-1">
              {failedUploads.map(({ file, error }) => (
                <li key={`${file.name}-${file.size}-${file.lastModified}`} className="relative flex items-center gap-2 pl-4 py-0.5 text-[14px]">
                  <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-overdue)]" />
                  <span className="min-w-0 flex-1 truncate"><span className="font-semibold text-[var(--color-text)]">{file.name}</span> <span className="text-[var(--color-text-muted)]">({(file.size / 1024 / 1024).toFixed(1)} MB)</span> <span className="text-[var(--state-overdue)] font-semibold">didn&apos;t upload: {error}</span></span>
                  <button type="button" onClick={() => void retryUpload(file)} disabled={uploadState !== null} className={heroQuiet + " !h-8 !text-[13px]"}>Try again</button>
                  <button type="button" onClick={() => setFailedUploads((fs) => fs.filter((f) => f.file !== file))} aria-label={`Dismiss ${file.name}`} className="shrink-0 w-8 h-8 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">×</button>
                </li>
              ))}
            </ul>
          )}
          {autoIndexing && (
            <div className="mb-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5 text-[14px]">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)] shrink-0" />
                <span className="font-semibold truncate">Indexing {autoIndexing.name}</span>
                <span className="text-[var(--color-text-muted)] shrink-0 ml-auto">
                  {autoIndexing.remaining} in queue. Keeps going anywhere in the app.
                </span>
              </div>
              {(autoIndexing.visionPages ?? 0) > 0 && (
                <div className="mt-1 flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                  <Eye className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                  <span className="font-semibold text-[var(--color-text)]">{autoIndexing.visionPages}</span> page(s) had no text
                  layer, so AI vision read them (billed to your key, slower per page).
                </div>
              )}
              {autoIndexing.visionSkipReason && (
                <div className="mt-1 flex items-start gap-1.5 text-[13px] text-[var(--color-text)] font-semibold">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--state-held)]" /> {autoIndexing.visionSkipReason}
                </div>
              )}
              {autoIndexing.waiting && (
                <div role="status" className="mt-1 flex items-start gap-1.5 text-[13px] text-[var(--color-text)] font-semibold">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--state-held)]" /> {autoIndexing.waiting}
                </div>
              )}
            </div>
          )}

          {!docsOpen && docs.length > 0 ? null : docs.length === 0 && !uploadState ? (
            <div className="rounded-md border border-dashed border-[var(--color-border-strong)] p-8 text-center text-[15px] text-[var(--color-text-muted)]">
              <FileText className="w-6 h-6 mx-auto mb-2 opacity-50" />
              {isController ? "Drag PDFs or whole folders here to build the shelf." : "No documents yet. Admin or Doc Control can add PDFs."}
            </div>
          ) : (
            <>
            <div className="mb-3 flex items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
                <input id="kdoc-search" value={docQuery} onChange={(e) => { setDocQuery(e.target.value); setDocLimit(200); }}
                  aria-label="Search documents"
                  placeholder={`Search ${docs.length.toLocaleString()} documents: "EP 5-2-3", "piping specs"…`}
                  className="w-full h-9 pl-9 pr-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40" />
              </div>
              <div className={bandSeg} role="group" aria-label="Show">
                {([
                  ["all", "All"], ["ready", "Fully indexed"], ["partial", "Partly read"], ["working", "In progress"], ["failed", "Failed"], ["uploaded", "Uploaded here"],
                ] as const).filter(([k]) => k === "all" || docGroups[k] > 0).map(([k, label]) => (
                  <button key={k} onClick={() => { setDocFilter(k); setDocLimit(200); }} aria-pressed={docFilter === k}
                    className={`${bandSegItem(docFilter === k)} !h-7 !text-[13px]`}>
                    {k === "failed" && <span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-overdue)]" />}
                    {k === "partial" && <span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-held)]" />}
                    {label} <span className="font-display tabular-nums">{docGroups[k].toLocaleString()}</span>
                  </button>
                ))}
              </div>
              <select aria-label="Sort documents" value={docSort} onChange={(e) => setDocSort(e.target.value as typeof docSort)}
                className="h-9 px-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)]">
                <option value="name">Sort: number</option>
                <option value="pages">Sort: most pages</option>
                <option value="problems">Sort: problems first</option>
              </select>
            </div>
            {isController && selected.size > 0 && (
              <div className="mb-2 flex items-center gap-3 text-[14px]">
                <span className="font-semibold text-[var(--color-text)]">{selected.size} selected</span>
                <Button size="sm" variant="danger" onClick={() => void removeDocs([...selected])} disabled={removing !== null}>
                  <Trash2 className="w-3.5 h-3.5" /> Remove {selected.size}
                </Button>
                <button onClick={() => setSelected(new Set())} className="text-[var(--color-accent-text)] hover:underline">Clear</button>
              </div>
            )}
            {shownDocs.length === 0 && (
              <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-[14px] text-[var(--color-text-muted)]">
                No document matches{docQuery ? ` "${docQuery}"` : ""}{docFilter !== "all" ? " in this filter" : ""}.
              </div>
            )}
            {shownDocs.length > 0 && (
            <div className="-mx-4 sm:-mx-5 border-y border-[var(--color-border)]">
            <table className="w-full text-[14px]">
              <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
                <tr>
                  {isController && (
                    <th className="pl-4 sm:pl-5 w-8 h-10">
                      {removable.length > 0 && (
                        <input type="checkbox" className="accent-[var(--color-text)] align-middle" aria-label="Select all documents"
                          checked={selected.size > 0 && selected.size === removable.length}
                          ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < removable.length; }}
                          onChange={() => setSelected(selected.size === removable.length ? new Set() : new Set(removable.map((d) => d.id)))} />
                      )}
                    </th>
                  )}
                  <th className={`font-semibold h-10 ${isController ? "px-3" : "px-4 sm:px-5"}`}>Document</th>
                  <th className="font-semibold px-3 text-right hidden sm:table-cell">Pages</th>
                  <th className="font-semibold px-3 hidden md:table-cell">Status</th>
                  <th className="px-2 w-20"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
              {shownDocs.slice(0, docLimit).map((doc) => {
                const fullyRead = doc.status === "ready" && (doc.pageCount ?? 0) > 0 && doc.pagesIndexed >= (doc.pageCount ?? 0);
                const bad = doc.status === "error";
                const warn = (doc.status === "ready" && !fullyRead) || doc.status === "indexing" || doc.status === "stale";
                const statusTag = (
                  // Pages actually READ, against the file's page count — "28 pages
                  // indexed" used to show the file's total even when reading
                  // had stopped part-way.
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)]"
                    title={bad ? doc.error ?? undefined : doc.status === "ready" && !fullyRead ? "Reading stopped before the last page. Repair in Library health, at the top of this page, resumes it - pages already read aren't paid for again." : undefined}>
                    <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 ${bad ? "bg-[var(--state-overdue)]" : warn ? "bg-[var(--state-held)]" : fullyRead ? "bg-[var(--state-released)]" : "bg-[var(--color-text-faint)]"}`} />
                    {fullyRead && "Indexed"}
                    {doc.status === "ready" && !fullyRead && "Partly read"}
                    {doc.status === "indexing" && "Indexing"}
                    {doc.status === "pending" && "Waiting to index"}
                    {doc.status === "stale" && "New revision, waiting"}
                    {bad && <span className="text-[var(--state-overdue)]">Failed</span>}
                  </span>
                );
                return (
                <tr key={doc.id} className={`relative align-top ${selected.has(doc.id) ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-surface-2)]"}`}>
                  {isController && (
                    <td className="relative pl-4 sm:pl-5 py-3 w-8">
                      {bad && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
                      <input type="checkbox" className="accent-[var(--color-text)] mt-1" aria-label={`Select ${doc.name}`}
                        disabled={!!doc.sourceDocumentId} checked={selected.has(doc.id)}
                        title={doc.sourceDocumentId ? "Mirrored from Document Control - remove it by unlinking the source" : undefined}
                        onChange={() => toggleSelect(doc.id)} />
                    </td>
                  )}
                  <td className={`py-3 min-w-0 relative ${isController ? "px-3" : "px-4 sm:px-5"}`}>
                    {bad && !isController && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
                    <div className="font-display text-[16px] font-semibold text-[var(--color-text)] break-words">{doc.name.replace(/\.pdf$/i, "")}</div>
                    <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[13px] text-[var(--color-text-muted)]">
                      {doc.sourceDocumentId && (
                        <span title="Mirrors a controlled document - kept current by the source sync">
                          From Doc Control{doc.sourceRev ? `, Rev ${doc.sourceRev}` : ""}
                        </span>
                      )}
                      <span className="md:hidden">{statusTag}</span>
                      {doc.status === "ready" && !fullyRead && <span className="tabular-nums">{doc.pagesIndexed} of {doc.pageCount ?? "?"} pages read</span>}
                      {doc.status === "indexing" && <span className="tabular-nums">{doc.pagesIndexed}{doc.pageCount ? ` of ${doc.pageCount}` : ""} pages so far</span>}
                      {bad && doc.error && <span className="text-[var(--state-overdue)] truncate max-w-[60ch]">{doc.error.slice(0, 80)}</span>}
                    </div>
                    {doc.status === "indexing" && doc.pageCount ? (
                      <div className="mt-1.5 h-1 max-w-sm rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                        <div className="h-full bg-[var(--state-held)] transition-all" style={{ width: `${Math.round((doc.pagesIndexed / doc.pageCount) * 100)}%` }} />
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-right font-display tabular-nums text-[15px] text-[var(--color-text)] hidden sm:table-cell whitespace-nowrap">{doc.pageCount ?? "?"}</td>
                  <td className="px-3 py-3 hidden md:table-cell whitespace-nowrap">{statusTag}</td>
                  <td className="px-2 py-2 whitespace-nowrap text-right">
                    {isController && doc.status !== "ready" && (
                      <button onClick={() => void resumeIndex(doc)} disabled={reindexing !== null}
                        title="Resume indexing"
                        aria-label={`Resume indexing ${doc.name}`}
                        className="w-8 h-8 inline-grid place-items-center rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                        {reindexing === doc.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                      </button>
                    )}
                    {isController && !doc.sourceDocumentId && (
                      <button onClick={() => void removeDocs([doc.id])} title="Remove" aria-label={`Remove ${doc.name}`} disabled={removing !== null}
                        className="w-8 h-8 inline-grid place-items-center rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--state-overdue)]">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
              </tbody>
            </table>
            </div>
            )}
            {shownDocs.length > docLimit && (
              <button onClick={() => setDocLimit((n) => n + 500)}
                className="mt-2 w-full h-9 text-left text-[14px] text-[var(--color-accent-text)] hover:underline">
                {docLimit.toLocaleString()} of {shownDocs.length.toLocaleString()} shown. Show {Math.min(500, shownDocs.length - docLimit).toLocaleString()} more
              </button>
            )}
            </>
          )}
        </div>

      </section>

      {activeOrgId && library.aiFeatures?.drawingIntel === true && (
        <DrawingIntelPanel orgId={activeOrgId} libraryId={libraryId}
          isController={isController} refreshKey={readyDocs}
          onRebuilt={() => void refresh()} />
      )}
      {activeOrgId && (
        <SemanticIndexPanel orgId={activeOrgId} libraryId={libraryId} isController={isController} />
      )}

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
      </PageBody>
    </PageShell>
  );
}

/** The door into the chat, scoped to this library: ask now, or pick up one
 *  of the recent conversations. The conversations rail in the shell has the
 *  full list, search, pin and settle. */
function AskEntry({ orgId, libraryId, libraryName, readyDocs, docsTotal }: {
  orgId: string; libraryId: string; libraryName: string; readyDocs: number; docsTotal: number;
}) {
  const [recent, setRecent] = useState<ChatThread[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [instructionCount, setInstructionCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void listThreads(orgId, { libraryId, limit: 4 }).then(
      (ts) => { if (!cancelled) { setRecent(ts); setRecentError(null); } },
      (e: unknown) => { if (!cancelled) { setRecent([]); setRecentError(e instanceof Error ? e.message : String(e)); } },
    );
    void import("@/lib/aiInstructions").then((m) =>
      m.countActiveInstructions(orgId, "knowledge").then((n) => { if (!cancelled) setInstructionCount(n); }))
      .catch(() => undefined); // only a count beside the heading
    return () => { cancelled = true; };
  }, [orgId, libraryId]);
  const askHref = `/assistant?library=${libraryId}`;
  const router = useRouter();
  const [q, setQ] = useState("");
  // A half-typed question waits here on this device.
  const askDraft = useDraft<string>(`library-ask:${libraryId}`, q, setQ, (v) => !v.trim());
  // The same choices as the chat's prompt bar — they travel with the
  // question into the chat, so asking here is never the lesser way to ask.
  const skills = useAnswerSkills(orgId);
  const [mode, setMode] = useState<AnswerMode | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [web, setWeb] = useState(false);
  const ask = (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = q.trim();
    if (!text) return;
    const params = new URLSearchParams({ library: libraryId, ask: text.slice(0, 2000) });
    if (mode) params.set("mode", mode);
    if (web) params.set("web", "1");
    if (picked) params.set("skills", picked.join(","));
    askDraft.clear();
    router.push(`/assistant?${params.toString()}`);
  };
  return (
    <section>
      <div className="flex items-end gap-x-3 gap-y-1 flex-wrap mb-2.5 min-h-8">
        <div className="min-w-0 flex-1 basis-[16rem]">
          <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">Ask this library</h2>
          <div className="text-[14px] text-[var(--color-text-muted)]">
            Answers come only from the indexed documents, cited to the page.
            {instructionCount > 0 && (
              <Link href="/admin/ai-instructions" className="ml-1.5 text-[var(--color-accent-text)] hover:underline">
                {instructionCount} standing instruction{instructionCount === 1 ? "" : "s"} apply
              </Link>
            )}
          </div>
        </div>
        <Link href={askHref} className="inline-flex items-center gap-1 text-[14px] text-[var(--color-accent-text)] hover:underline">
          All conversations <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
      {/* Ask right here — the question opens in the chat already running,
          instead of a door you have to walk through first. */}
      <form onSubmit={ask} className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] focus-within:border-[var(--color-main)] focus-within:ring-2 focus-within:ring-[var(--color-accent-ring)]/30">
        <textarea id="library-ask" value={q} onChange={(e) => setQ(e.target.value)} disabled={readyDocs === 0} rows={2}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
          placeholder={readyDocs === 0 ? "Asking unlocks when the first document is indexed" : "Ask this library, e.g. \"What piping spec should I use for 150 class sour gas?\""}
          className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none disabled:opacity-60" />
        <div className="px-4 pb-1"><SkillHint skills={skills} picked={picked} question={q} answerMode={mode} /></div>
        <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
          <SourcesMenu scope="library" libraryId={libraryId} libraries={[]} fixedLibrary={libraryName} webOn={web} onToggleWeb={() => setWeb((v) => !v)} />
          <AnswerMenu answerMode={mode} onAnswerMode={setMode} skills={skills} picked={picked} onPick={setPicked} question={q} />
          <span className="flex-1" />
          <button type="submit" disabled={readyDocs === 0 || !q.trim()}
            className="shrink-0 ml-auto inline-flex items-center gap-1.5 h-10 px-4 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[15px] font-semibold hover:bg-[var(--color-accent-hover)] shadow-[0_1px_0_rgb(0_0_0/0.12)] disabled:opacity-40 disabled:shadow-none transition-colors">
            Ask <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>
      {readyDocs === 0 && (
        <p className="relative mt-3 pl-4 py-0.5 text-[14px] text-[var(--color-text)] font-semibold">
          <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-held)]" />
          {docsTotal > 0
            ? "Documents are indexing below. Asking unlocks as soon as the first one finishes."
            : "Nothing indexed yet. Link a source or add PDFs below first."}
        </p>
      )}
      {recentError && (
        <p role="alert" className="mt-3 text-[13px] font-semibold text-[var(--state-overdue)]">Couldn&apos;t load the recent conversations: {recentError}</p>
      )}
      {recent && recent.length > 0 && (
        <div className="mt-4">
          <div className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-1 flex items-center gap-1.5">
            <History className="w-3.5 h-3.5" /> Recent conversations
          </div>
          <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)] -mx-4 sm:-mx-5">
            {recent.map((t) => (
              <li key={t.id}>
                <Link href={`/assistant?thread=${t.id}&library=${libraryId}`}
                  className="flex items-center gap-2.5 px-4 sm:px-5 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors group">
                  {t.scope === "internet" ? <Globe className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                    : t.scope === "tools" ? <Bot className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                    : <MessageSquare className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold text-[var(--color-text)] group-hover:text-[var(--color-accent-text)] truncate">{t.title || "Untitled"}</span>
                    <span className="flex gap-3 text-[13px] text-[var(--color-text-muted)]">
                      <span>{(t.createdByName ?? "Someone").split("@")[0]}</span>
                      <span>{new Date(t.lastMessageAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, {new Date(t.lastMessageAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                      {t.settledAt && <span>Settled</span>}
                    </span>
                  </span>
                  <ArrowRight className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>
    </section>
  );
}
