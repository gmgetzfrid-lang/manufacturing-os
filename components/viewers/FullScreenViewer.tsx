"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Download,
  Printer,
  Camera,
  ShieldAlert,
  Loader2,
  Pen,
  Highlighter,
  Type,
  ZoomIn,
  ZoomOut,
  Move,
  MousePointer2,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Minus,
  ArrowUpRight,
  Square,
  Cloud,
  StickyNote,
  Undo2,
  Redo2,
  Eraser,
  Stamp as StampIcon,
  FileDown,
  GitCompare,
  Send,
  Lock,
  Smartphone,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Document, Page, pdfjs } from "react-pdf";
import { PDF_DOC_OPTIONS } from "@/lib/pdfjsConfig";
import * as fabric from "fabric";
import { PDFDocument } from "pdf-lib";
import CheckoutStatusCell from "@/components/documents/CheckoutStatusCell";
import EquipmentTagsStrip from "@/components/assets/EquipmentTagsStrip";
import CompareRevisionsModal from "@/components/documents/CompareRevisionsModal";
import BackupViewer from "@/components/archive/BackupViewer";
import { listVersions } from "@/lib/revisions";
import { recordIntent } from "@/lib/intents";
import QrBadge from "@/components/ui/QrBadge";
import MoreMenu, { type MoreItem } from "@/components/ui/MoreMenu";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/Field";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { useIsMobile } from "@/hooks/useIsMobile";
import CopyId from "@/components/ui/CopyId";
import { vDim, vPanel, vKicker, vTitle, vIcon, vTool, vQuiet, vGroup, vPrimary, vClose, vNote } from "@/components/viewers/viewerChrome";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";
import { fileBlobIfStarted, fileLink } from "@/lib/docOpen";
import { bakeMarkupIntoPdf } from "@/lib/markupExport";
import { stashDraft } from "@/lib/draftHandoff";
import {
  downloadDocumentPdf,
  printDocumentPdf,
  determineControlState,
  viewerStatusBadge,
  type ViewBadgeTone,
  logDownloadAudit,
} from "@/lib/downloads";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { publicOrigin } from "@/lib/publicOrigin";
import { useViewerPanZoom } from "@/lib/useViewerPanZoom";

import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

import { friendlyError } from "@/lib/friendlyError";
import { previewKind, fileTypeName } from "@/lib/filePreview";
import { shownRevision, uploadedName } from "@/lib/revisionShown";
// Serve the pdfjs worker from our own /public so the viewer doesn't depend
// on a CDN at all. The file is copied from node_modules during build via
// `scripts/copy-pdfjs-worker.mjs` (wired into `prebuild`/`predev`). CDN
// hosting of the exact pdfjs version react-pdf bundles has been unreliable
// (cdnjs returns 404 for 5.x patches; unpkg has variable cold starts).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

type Tool =
  | "select" | "pan" | "pen" | "highlight" | "line" | "arrow"
  | "rect" | "cloud" | "text" | "sticky" | "stamp" | "eraser";

type ColorKey = "red" | "blue" | "black" | "yellow" | "green" | "orange";

// ─── Minimal typed shims for fabric.js v7 + react-pdf dynamics ──────────
// fabric v7 renamed Image -> FabricImage but keeps both at runtime; its
// published types don't expose the constructor uniformly, so we describe
// just the `fromURL` factory we call.
type FabricImageCtor = {
  fromURL(url: string, opts?: { crossOrigin?: string }): Promise<fabric.FabricImage>;
};
// Shape of the (de)serialized fabric canvas JSON we mutate during page-state
// normalization. Only the per-object transform fields are touched.
type CanvasObjectTransform = { left: number; top: number; scaleX: number; scaleY: number };
type CanvasJson = {
  objects?: Array<Record<string, number> & CanvasObjectTransform>;
  [k: string]: unknown;
};
// The slice of react-pdf's PageCallback we use in onRenderSuccess.
type PdfPageProxy = { getViewport(opts: { scale: number }): { width: number; height: number } };

const COLOR_HEX: Record<ColorKey, string> = {
  red: "#dc2626", blue: "#2563eb", black: "#0f172a",
  yellow: "#facc15", green: "#16a34a", orange: "#ea580c",
};
const HIGHLIGHT_RGBA: Record<ColorKey, string> = {
  yellow: "rgba(250, 204, 21, 0.35)", red: "rgba(220, 38, 38, 0.35)",
  green: "rgba(22, 163, 74, 0.35)", blue: "rgba(37, 99, 235, 0.35)",
  black: "rgba(15, 23, 42, 0.30)", orange: "rgba(234, 88, 12, 0.35)",
};
const STAMPS: { label: string; tone: ColorKey }[] = [
  { label: "APPROVED", tone: "green" },
  { label: "FOR REVIEW", tone: "blue" },
  { label: "FOR CONSTRUCTION", tone: "blue" },
  { label: "AS-BUILT", tone: "green" },
  { label: "SUPERSEDED", tone: "yellow" },
  { label: "VOID", tone: "red" },
  { label: "REJECTED", tone: "red" },
  { label: "DRAFT", tone: "black" },
  { label: "FOR INFO ONLY", tone: "black" },
];

interface FullScreenViewerProps {
  isOpen: boolean;
  onClose: () => void;
  url: string;
  title: string;
  docNumber: string;
  rev: string;
  document?: DocumentRecord;
  userRole?: string | null;
  currentUserId?: string;
  currentUserEmail?: string;
  onCheckout?: (doc: DocumentRecord) => void;
  // Asset registry integration — floating equipment-tag ribbon
  orgId?: string;
  customColumns?: Array<{ key: string; label: string; type?: string; pillGroupLabel?: string }>;
  // Markup persistence — so a parent (e.g. the book viewer) can keep each
  // sheet's annotations alive across opens. Seed from `initialPageStates`;
  // `onPageStatesChange` reports the latest (normalized) per-page state on close.
  initialPageStates?: Record<number, object>;
  onPageStatesChange?: (states: Record<number, object>) => void;
  /** Async commit on close: the parent persists + bakes, and the editor stays
   *  up (showing "applying…") until it resolves, so closing reveals the
   *  finished sheet with no flash of the un-marked original. */
  onCommit?: (states: Record<number, object>) => Promise<void>;
}

export default function FullScreenViewer({
  isOpen, onClose, url, title, docNumber, rev, document: docRecord,
  userRole, currentUserId, currentUserEmail, onCheckout,
  orgId, customColumns, initialPageStates, onPageStatesChange, onCommit,
}: FullScreenViewerProps) {
  const canManageAssets = userRole === 'Admin' || userRole === 'Manager' || userRole === 'Supervisor'
    || (userRole?.includes('Engineer') ?? false) || userRole === 'Drafter' || userRole === 'DocCtrl';
  const router = useRouter();
  // A Word, Excel or CAD file isn't a drawing this viewer can show: say so
  // in words (the panel's Download saves it) instead of a PDF parse error.
  const shownFileName = uploadedName(docRecord) || decodeURIComponent((url || "").split(/[?#]/)[0].split("/").pop() || "");
  const notViewable = previewKind({ fileName: shownFileName, path: url }) === "none";
  const isMobile = useIsMobile();
  const [tagsBarOpen, setTagsBarOpen] = useState(true);
  // ─── Pre-fetched PDF bytes (one fetch for view AND save) ──────────────
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // ─── Phase 4: revision-diff state ─────────────────────────────────────
  // Loaded once per docRecord change. `currentVersion` is the head row
  // for the open document; `previousVersion` is the row it supersedes
  // (null if none — the Compare button stays disabled in that case).
  const [currentVersion, setCurrentVersion] = useState<DocumentVersion | null>(null);
  const [previousVersion, setPreviousVersion] = useState<DocumentVersion | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [phoneQrOpen, setPhoneQrOpen] = useState(false);
  // Resolved http(s) URL. `url` may arrive as a raw storage path
  // (e.g. "orgs/.../file.pdf"); we resolve it to a signed URL once and
  // reuse it for the PDF stream AND for the Download/Print code path.
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  // Set when the binary was shed to an offline space archive — the body then
  // shows the provide-the-zip prompt (in-memory viewer) instead of a dead PDF.
  const [archivedInfo, setArchivedInfo] = useState<{ archiveId: string | null; root: string | null; fileName: string } | null>(null);

  // Resolve a storage path (e.g. "orgs/.../foo.pdf") to a presigned URL,
  // from the shared cache (lib/storage): a file opened before, or pointed
  // at a moment ago, does not wait on the server again. If `url` is already
  // an http(s)/blob URL it is used as it is.
  const resolveToHttpUrl = async (raw: string): Promise<string> => {
    if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("blob:")) return raw;
    const r = await fileLink(raw);
    if (r?.kind === "archived") {
      throw Object.assign(new Error("File archived offline"), {
        archivedInfo: { archiveId: r.archiveId, root: r.root, fileName: r.fileName || raw.split("/").pop() || "file" },
      });
    }
    if (!r) throw new Error("Could not get a link to the file. Check you are signed in, then try again.");
    return r.url;
  };
  // The file's bytes, when the preview (or a press on its row) already
  // fetched them: the drawing opens from memory, nothing downloads twice.
  const [fileData, setFileData] = useState<Uint8Array | null>(null);
  // react-pdf reloads when `file` changes identity, and pdf.js takes the
  // buffer it is given: one copy, made once.
  const fileSource = React.useMemo(() => (fileData ? { data: fileData.slice() } : null), [fileData]);

  // Ambient intent capture: opening the viewer records a VIEW intent (kind
  // 'view' decays in hours; it never triggers overlap advisories — only
  // edit×edit does). Fire-and-forget; never blocks the viewer.
  useEffect(() => {
    if (!isOpen || !docRecord?.id || !docRecord.orgId || !currentUserId) return;
    void recordIntent({
      orgId: docRecord.orgId,
      documentId: docRecord.id,
      libraryId: docRecord.libraryId ?? null,
      userId: currentUserId,
      userName: currentUserEmail?.split("@")[0] ?? null,
      kind: "view",
      source: "viewer",
      baseVersionId: docRecord.currentVersionId ?? null,
    });
  }, [isOpen, docRecord?.id, docRecord?.orgId, docRecord?.libraryId, docRecord?.currentVersionId, currentUserId, currentUserEmail]);

  useEffect(() => {
    if (!isOpen || !url) return;
    let cancelled = false;
    const ctl = new AbortController();
    setPdfBytes(null);
    setFetchError(null);
    setResolvedUrl(null);
    setArchivedInfo(null);

    // The bytes are already here or on their way (the preview fetched them):
    // open from those. Otherwise resolve the URL ONLY and let pdfjs stream
    // page 1 from a range request instead of downloading the whole PDF
    // before the first page appears. Raw bytes are then fetched lazily
    // (ensureBytes) only when markups are exported.
    setFileData(null);
    (async () => {
      try {
        const started = fileBlobIfStarted(url);
        const link = resolveToHttpUrl(url);
        link.catch(() => undefined); // awaited below; never an unhandled rejection meanwhile
        if (started) {
          const blob = await started.catch(() => null);
          if (blob && !cancelled) {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (!cancelled) { setPdfBytes(bytes); setFileData(bytes); }
          }
        }
        const httpUrl = await link;
        if (!cancelled && !ctl.signal.aborted) setResolvedUrl(httpUrl);
      } catch (e) {
        const shed = (e as { archivedInfo?: { archiveId: string | null; root: string | null; fileName: string } }).archivedInfo;
        if (!cancelled && shed) {
          setArchivedInfo(shed);
        } else if (!cancelled && (e as Error).name !== "AbortError") {
          setFetchError(friendlyError(e));
        }
      }
    })();

    return () => { cancelled = true; ctl.abort(); };
  }, [isOpen, url]);

  // Phase 4 — load current + previous DocumentVersion for the Compare
  // button. Cheap (one query); only fires when the open document
  // changes. Stale safety via `alive` flag.
  useEffect(() => {
    if (!isOpen || !docRecord?.id) {
      setCurrentVersion(null);
      setPreviousVersion(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const versions = await listVersions(docRecord.id!);
        if (!alive) return;
        const cur = versions.find((v) => v.id === docRecord.currentVersionId) ?? versions[0] ?? null;
        setCurrentVersion(cur);
        // "Previous" = the version this one supersedes. Falls back to
        // the next-newest by chronological order if the supersedes
        // pointer is missing (legacy data before the chain was
        // tracked).
        let prev: DocumentVersion | null = null;
        if (cur?.supersedesVersionId) {
          prev = versions.find((v) => v.id === cur.supersedesVersionId) ?? null;
        }
        if (!prev && cur) {
          const curIdx = versions.findIndex((v) => v.id === cur.id);
          if (curIdx >= 0 && curIdx + 1 < versions.length) prev = versions[curIdx + 1];
        }
        setPreviousVersion(prev);
      } catch {
        if (alive) { setCurrentVersion(null); setPreviousVersion(null); }
      }
    })();
    return () => { alive = false; };
  }, [isOpen, docRecord?.id, docRecord?.currentVersionId]);

  // Lazily fetch the raw PDF bytes — needed only to BAKE markups into a download
  // (viewing streams straight from the URL). Cached after the first fetch so a
  // second export doesn't re-download.
  const ensureBytes = useCallback(async (): Promise<Uint8Array | null> => {
    if (pdfBytes) return pdfBytes;
    if (!resolvedUrl) return null;
    try {
      const res = await fetch(resolvedUrl);
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      setPdfBytes(buf);
      return buf;
    } catch { return null; }
  }, [pdfBytes, resolvedUrl]);

  // ─── PDF page + zoom state ────────────────────────────────────────────
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);

  // ─── Tool + style ─────────────────────────────────────────────────────
  // Pan (the grab hand) is the DEFAULT: open a drawing and immediately drag
  // it around, mouse or finger — like every real PDF viewer. Select is one
  // click (or V) away for editing markups.
  const [tool, setTool] = useState<Tool>("pan");
  const [color, setColor] = useState<ColorKey>("red");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [stampMenuOpen, setStampMenuOpen] = useState(false);
  // Custom uploaded stamps (PNG/JPG) persisted to localStorage so they survive
  // refresh. Stored as data URLs — small footprint per stamp, capped at 12.
  const [customStamps, setCustomStamps] = useState<{ id: string; name: string; src: string }[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem("manufacturingos.customStamps");
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const stampFileInputRef = useRef<HTMLInputElement>(null);

  const persistCustomStamps = (next: { id: string; name: string; src: string }[]) => {
    setCustomStamps(next);
    try { window.localStorage.setItem("manufacturingos.customStamps", JSON.stringify(next)); } catch {}
  };

  const onUploadStamp = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result || "");
      if (!src) return;
      const next = [{ id: `cs-${Date.now()}`, name: file.name, src }, ...customStamps].slice(0, 12);
      persistCustomStamps(next);
    };
    reader.readAsDataURL(file);
  };

  const removeCustomStamp = (id: string) => {
    persistCustomStamps(customStamps.filter((s) => s.id !== id));
  };

  const addCustomStamp = async (src: string) => {
    const c = fabricRef.current; if (!c) return;
    // Fabric v6 renamed Image -> FabricImage; v7 keeps both. Resolve whichever
    // the installed build exposes via a minimal typed shim.
    const ImageCtor = ((fabric as unknown as { FabricImage?: FabricImageCtor; Image?: FabricImageCtor }).FabricImage
      ?? (fabric as unknown as { Image?: FabricImageCtor }).Image)!;
    const img = await ImageCtor.fromURL(src, { crossOrigin: "anonymous" });
    img.set({
      left: 120 * scale, top: 120 * scale,
      scaleX: Math.min(0.5, (200 * scale) / (img.width ?? 200)),
      scaleY: Math.min(0.5, (200 * scale) / (img.width ?? 200)),
    });
    c.add(img); c.setActiveObject(img);
    setStampMenuOpen(false);
    setTool("select");
  };

  // ─── Per-page Fabric state (normalized at scale 1.0) ──────────────────
  const [pageStates, setPageStates] = useState<Record<number, object>>(() => initialPageStates ?? {});
  // True while the parent bakes markups on close (keeps the editor up).
  const [committing, setCommitting] = useState(false);
  // True while we bake markups into the PDF for a "Send to Drafting" handoff.
  const [sendingDraft, setSendingDraft] = useState(false);

  // Undo/redo per-page snapshot stacks
  const undoRef = useRef<Record<number, string[]>>({});
  const redoRef = useRef<Record<number, string[]>>({});
  const restoringRef = useRef(false);

  // ─── Download / print action state ────────────────────────────────────
  const [pending, setPending] = useState<null | { type: "download" | "print" | "markup" }>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [markupBusy, setMarkupBusy] = useState(false);
  const [markupError, setMarkupError] = useState<string | null>(null);

  // Scroll/canvas wrapper — target for pan drags + Ctrl+wheel/pinch zoom.
  const canvasScrollRef = useRef<HTMLDivElement>(null);

  // ─── Fabric canvas ────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);

  useEffect(() => {
    if (!isOpen || !canvasRef.current) return;
    console.warn("[FullScreenViewer] viewer mounted (build: markup-stamp-v3)");
    const c = new fabric.Canvas(canvasRef.current, { isDrawingMode: false, selection: true });
    fabricRef.current = c;
    return () => { c.dispose(); fabricRef.current = null; };
  }, [isOpen]);

  // Undo snapshot
  const pushSnapshot = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas || restoringRef.current) return;
    const json = JSON.stringify(canvas.toJSON());
    const stack = undoRef.current[currentPage] ?? [];
    stack.push(json);
    if (stack.length > 100) stack.shift();
    undoRef.current[currentPage] = stack;
    redoRef.current[currentPage] = [];
  }, [currentPage]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const h = () => pushSnapshot();
    canvas.on("object:added", h);
    canvas.on("object:modified", h);
    canvas.on("object:removed", h);
    canvas.on("path:created", h);
    return () => {
      canvas.off("object:added", h);
      canvas.off("object:modified", h);
      canvas.off("object:removed", h);
      canvas.off("path:created", h);
    };
  }, [pushSnapshot]);

  const undo = useCallback(async () => {
    const canvas = fabricRef.current;
    const stack = undoRef.current[currentPage] ?? [];
    if (!canvas || stack.length < 2) return;
    const current = stack.pop()!;
    redoRef.current[currentPage] = [...(redoRef.current[currentPage] ?? []), current];
    const prev = stack[stack.length - 1];
    restoringRef.current = true;
    try { await canvas.loadFromJSON(JSON.parse(prev)); canvas.requestRenderAll(); }
    finally { restoringRef.current = false; }
  }, [currentPage]);

  const redo = useCallback(async () => {
    const canvas = fabricRef.current;
    const stack = redoRef.current[currentPage] ?? [];
    if (!canvas || stack.length === 0) return;
    const next = stack.pop()!;
    undoRef.current[currentPage] = [...(undoRef.current[currentPage] ?? []), next];
    restoringRef.current = true;
    try { await canvas.loadFromJSON(JSON.parse(next)); canvas.requestRenderAll(); }
    finally { restoringRef.current = false; }
  }, [currentPage]);

  // ─── Tool-state on canvas ─────────────────────────────────────────────
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    canvas.isDrawingMode = false;
    canvas.selection = false;
    canvas.defaultCursor = "default";
    canvas.hoverCursor = "move";

    if (tool === "pen") {
      canvas.isDrawingMode = true;
      const b = new fabric.PencilBrush(canvas);
      b.color = COLOR_HEX[color]; b.width = strokeWidth * scale;
      canvas.freeDrawingBrush = b;
      canvas.defaultCursor = canvas.hoverCursor = "crosshair";
    } else if (tool === "highlight") {
      canvas.isDrawingMode = true;
      const b = new fabric.PencilBrush(canvas);
      b.color = HIGHLIGHT_RGBA[color]; b.width = 20 * scale;
      canvas.freeDrawingBrush = b;
      canvas.defaultCursor = canvas.hoverCursor = "crosshair";
    } else if (tool === "select") canvas.selection = true;
    else if (tool === "pan") canvas.defaultCursor = canvas.hoverCursor = "grab";
    else if (tool === "eraser") canvas.defaultCursor = canvas.hoverCursor = "not-allowed";
    else canvas.defaultCursor = canvas.hoverCursor = "crosshair";

    const active = canvas.getActiveObject();
    if (active && tool === "select") {
      if (active.type === "i-text" || active.type === "text" || active.type === "textbox") {
        active.set({ fill: COLOR_HEX[color] });
      } else {
        active.set({ stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale });
      }
      canvas.requestRenderAll();
    }
  }, [tool, color, strokeWidth, scale]);

  // ─── Page-state normalization ─────────────────────────────────────────
  const normalize = (json: CanvasJson, s: number): CanvasJson => {
    if (!json?.objects) return json;
    const inv = 1 / s;
    const out: CanvasJson = JSON.parse(JSON.stringify(json));
    out.objects!.forEach((o) => { o.left *= inv; o.top *= inv; o.scaleX *= inv; o.scaleY *= inv; });
    return out;
  };
  const denormalize = (json: CanvasJson, s: number): CanvasJson => {
    if (!json?.objects) return json;
    const out: CanvasJson = JSON.parse(JSON.stringify(json));
    out.objects!.forEach((o) => { o.left *= s; o.top *= s; o.scaleX *= s; o.scaleY *= s; });
    return out;
  };

  const saveCurrentPage = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    setPageStates((prev) => ({ ...prev, [currentPage]: normalize(canvas.toJSON(), scale) }));
  }, [currentPage, scale]);

  const onPageLoaded = (page: PdfPageProxy) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const vp = page.getViewport({ scale });
    canvas.setDimensions({ width: vp.width, height: vp.height });
    canvas.calcOffset();
    canvas.clear();
    const saved = pageStates[currentPage];
    if (saved) {
      canvas.loadFromJSON(denormalize(saved as CanvasJson, scale)).then(() => {
        canvas.requestRenderAll();
        undoRef.current[currentPage] = [JSON.stringify(canvas.toJSON())];
        redoRef.current[currentPage] = [];
      });
    } else {
      undoRef.current[currentPage] = [JSON.stringify(canvas.toJSON())];
      redoRef.current[currentPage] = [];
    }
  };

  const goPage = (n: number) => { if (n < 1 || n > numPages) return; saveCurrentPage(); setCurrentPage(n); };
  // The arrow keys turn the page (left goes back a page, right forward).
  const pageStepRef = useRef<(d: number) => void>(() => {});
  useEffect(() => { pageStepRef.current = (d: number) => goPage(currentPage + d); });
  const setZoom = (n: number) => { saveCurrentPage(); setScale(Math.min(3, Math.max(0.5, n))); };

  // Ctrl+wheel zoom via the shared viewer hook — smoothed + throttled, and
  // attached exactly the way the book viewer does it. enabled:false → wheel-zoom
  // only (no drag-pan): this editor has its own Pan tool + Fabric overlay.
  const scaleRef = useRef(scale);
  useEffect(() => { scaleRef.current = scale; });
  const panZoom = useViewerPanZoom({
    containerRef: canvasScrollRef,
    onZoom: (f) => setZoom(scaleRef.current * f),
    enabled: tool === "pan",
    anchorZoom: true,
  });

  // ─── Shape constructors ───────────────────────────────────────────────
  const addText = useCallback(() => {
    const c = fabricRef.current; if (!c) return;
    const t = new fabric.IText("Text", { left: 60 * scale, top: 60 * scale, fontFamily: "Helvetica", fill: COLOR_HEX[color], fontSize: 20 * scale });
    c.add(t); c.setActiveObject(t); setTool("select");
  }, [scale, color]);
  const addStickyNote = useCallback(() => {
    const c = fabricRef.current; if (!c) return;
    const w = 180 * scale, h = 110 * scale;
    const r = new fabric.Rect({ width: w, height: h, fill: "rgba(254, 240, 138, 0.92)", stroke: "#ca8a04", strokeWidth: 1, rx: 6, ry: 6, shadow: new fabric.Shadow({ color: "rgba(0,0,0,0.25)", blur: 6, offsetX: 2, offsetY: 3 }) });
    const txt = new fabric.Textbox("Note…", { width: w - 16 * scale, top: 8 * scale, left: 8 * scale, fontSize: 14 * scale, fill: "#713f12", fontFamily: "Helvetica" });
    const g = new fabric.Group([r, txt], { left: 80 * scale, top: 80 * scale });
    c.add(g); c.setActiveObject(g); setTool("select");
  }, [scale]);
  const addStamp = (label: string, tone: ColorKey) => {
    const c = fabricRef.current; if (!c) return;
    const txt = new fabric.Text(label, { fontFamily: "Helvetica", fontSize: 28 * scale, fontWeight: 900, fill: COLOR_HEX[tone], originX: "center", originY: "center" });
    const padX = 18 * scale, padY = 8 * scale;
    const box = new fabric.Rect({ width: (txt.width ?? 0) + padX * 2, height: (txt.height ?? 0) + padY * 2, fill: "transparent", stroke: COLOR_HEX[tone], strokeWidth: 3 * scale, originX: "center", originY: "center" });
    const g = new fabric.Group([box, txt], { left: 120 * scale, top: 120 * scale, angle: -8, opacity: 0.85 });
    c.add(g); c.setActiveObject(g); setStampMenuOpen(false); setTool("select");
  };
  const deleteSelected = () => {
    const c = fabricRef.current; if (!c) return;
    const a = c.getActiveObjects();
    if (a.length) { c.discardActiveObject(); a.forEach((o) => c.remove(o)); }
  };

  // ─── Drag-to-draw for line/arrow/rect/cloud ───────────────────────────
  const draftRef = useRef<fabric.Object | null>(null);
  const draftStartRef = useRef<{ x: number; y: number } | null>(null);
  // Snap indicator (small green dot rendered over Fabric while snapping)
  const [snapDot, setSnapDot] = useState<{ x: number; y: number } | null>(null);

  // Build a list of "snap points" (line endpoints) from existing line objects.
  // We compute scene coords from the line's current center + half-length so
  // snapping still works after a line has been moved.
  const collectSnapPoints = (canvas: fabric.Canvas): { x: number; y: number }[] => {
    const pts: { x: number; y: number }[] = [];
    for (const obj of canvas.getObjects()) {
      if (obj.type !== "line") continue;
      const ln = obj as fabric.Line;
      const cp = ln.getCenterPoint();
      const dx = ((ln.x2 ?? 0) - (ln.x1 ?? 0)) / 2;
      const dy = ((ln.y2 ?? 0) - (ln.y1 ?? 0)) / 2;
      pts.push({ x: cp.x - dx, y: cp.y - dy });
      pts.push({ x: cp.x + dx, y: cp.y + dy });
    }
    return pts;
  };

  // Snap candidate cursor to nearest line endpoint (within `tol` scene px).
  const snapToEndpoint = (
    pt: { x: number; y: number },
    canvas: fabric.Canvas,
    tol = 10
  ): { x: number; y: number; snapped: boolean } => {
    const tolerance = tol * scale;
    let best: { x: number; y: number } | null = null;
    let bestDist = tolerance;
    for (const p of collectSnapPoints(canvas)) {
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestDist) { best = p; bestDist = d; }
    }
    return best ? { ...best, snapped: true } : { ...pt, snapped: false };
  };

  // Constrain a vector to 15° increments (shift-drag angle snap).
  const constrainAngle = (
    start: { x: number; y: number },
    pt: { x: number; y: number }
  ) => {
    const dx = pt.x - start.x;
    const dy = pt.y - start.y;
    const len = Math.hypot(dx, dy);
    const step = Math.PI / 12; // 15°
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: start.x + Math.cos(ang) * len, y: start.y + Math.sin(ang) * len };
  };

  // SVG path for a Bluebeam-style rev cloud along a rectangle perimeter.
  // Uses outward-bulging arcs so the cloud reads as a closed scalloped shape.
  const buildCloudPath = (x1: number, y1: number, x2: number, y2: number, scallop = 10): string => {
    const lx = Math.min(x1, x2), rx = Math.max(x1, x2);
    const ty = Math.min(y1, y2), by = Math.max(y1, y2);
    const w = rx - lx, h = by - ty;
    const target = Math.max(8, scallop * scale);
    const sx = Math.max(2, Math.round(w / (target * 1.5)));
    const sy = Math.max(2, Math.round(h / (target * 1.5)));
    const dx = w / sx, dy = h / sy;
    const r = Math.min(dx, dy) / 1.4;
    let d = `M ${lx} ${ty}`;
    // Top: left → right (sweep=0 bulges upward)
    for (let i = 1; i <= sx; i++) d += ` A ${r} ${r} 0 0 0 ${lx + i * dx} ${ty}`;
    // Right: top → bottom (sweep=0 bulges right)
    for (let i = 1; i <= sy; i++) d += ` A ${r} ${r} 0 0 0 ${rx} ${ty + i * dy}`;
    // Bottom: right → left
    for (let i = 1; i <= sx; i++) d += ` A ${r} ${r} 0 0 0 ${rx - i * dx} ${by}`;
    // Left: bottom → top
    for (let i = 1; i <= sy; i++) d += ` A ${r} ${r} 0 0 0 ${lx} ${by - i * dy}`;
    d += " Z";
    return d;
  };

  const onCanvasMouseDown = (e: React.PointerEvent) => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    if (tool === "eraser") {
      const pt = canvas.getScenePoint(e.nativeEvent);
      const target = canvas.getObjects().reverse().find((o) => o.containsPoint(pt));
      if (target) canvas.remove(target);
      return;
    }

    // For shape tools, if the click hits an existing object, drop into Select
    // and let Fabric handle the move/rotate/scale gesture. This avoids the
    // 'crosshair keeps drawing while I'm trying to drag' problem.
    if (tool === "line" || tool === "arrow" || tool === "rect" || tool === "cloud") {
      // Use a manual hit test instead of canvas.findTarget — Fabric v7
      // changed findTarget's return type to a wrapper, which fails the
      // production TS build. containsPoint is stable across versions.
      const pt = canvas.getScenePoint(e.nativeEvent);
      const hit = canvas.getObjects().reverse().find((o) => o.containsPoint(pt));
      if (hit) {
        setTool("select");
        canvas.selection = true;
        canvas.setActiveObject(hit);
        canvas.requestRenderAll();
        return;
      }
    }

    if (tool === "line" || tool === "arrow") {
      const raw = canvas.getScenePoint(e.nativeEvent);
      const snap = snapToEndpoint(raw, canvas);
      const start = { x: snap.x, y: snap.y };
      const line = new fabric.Line([start.x, start.y, start.x, start.y], {
        stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale, selectable: false,
      });
      canvas.add(line);
      draftRef.current = line;
      draftStartRef.current = start;
      return;
    }

    if (tool === "rect") {
      const pt = canvas.getScenePoint(e.nativeEvent);
      const r = new fabric.Rect({
        left: pt.x, top: pt.y, width: 1, height: 1,
        fill: "transparent", stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale, selectable: false,
      });
      canvas.add(r);
      draftRef.current = r;
      draftStartRef.current = { x: pt.x, y: pt.y };
      return;
    }

    if (tool === "cloud") {
      const pt = canvas.getScenePoint(e.nativeEvent);
      // Initial path is a degenerate dot; replaced on every move
      const path = new fabric.Path(`M ${pt.x} ${pt.y} Z`, {
        fill: "transparent", stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale, selectable: false,
      });
      canvas.add(path);
      draftRef.current = path;
      draftStartRef.current = { x: pt.x, y: pt.y };
      return;
    }
  };

  const onCanvasMouseMove = (e: React.PointerEvent) => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    // Hover snap preview when we're about to start a line/arrow
    if ((tool === "line" || tool === "arrow") && !draftRef.current) {
      const raw = canvas.getScenePoint(e.nativeEvent);
      const snap = snapToEndpoint(raw, canvas);
      setSnapDot(snap.snapped ? { x: snap.x, y: snap.y } : null);
      return;
    }

    if ((tool === "line" || tool === "arrow") && draftRef.current && draftStartRef.current) {
      const raw = canvas.getScenePoint(e.nativeEvent);
      let pt: { x: number; y: number } = { x: raw.x, y: raw.y };
      const endSnap = snapToEndpoint(raw, canvas);
      if (endSnap.snapped) pt = { x: endSnap.x, y: endSnap.y };
      else if (e.shiftKey) pt = constrainAngle(draftStartRef.current, raw);
      setSnapDot(endSnap.snapped ? { x: endSnap.x, y: endSnap.y } : null);
      const ln = draftRef.current as fabric.Line;
      ln.set({ x2: pt.x, y2: pt.y });
      canvas.requestRenderAll();
      return;
    }

    if (tool === "rect" && draftRef.current && draftStartRef.current) {
      const pt = canvas.getScenePoint(e.nativeEvent);
      const s = draftStartRef.current;
      const r = draftRef.current as fabric.Rect;
      r.set({
        left: Math.min(s.x, pt.x), top: Math.min(s.y, pt.y),
        width: Math.abs(pt.x - s.x), height: Math.abs(pt.y - s.y),
      });
      r.setCoords();
      canvas.requestRenderAll();
      return;
    }

    if (tool === "cloud" && draftRef.current && draftStartRef.current) {
      const pt = canvas.getScenePoint(e.nativeEvent);
      const s = draftStartRef.current;
      const d = buildCloudPath(s.x, s.y, pt.x, pt.y);
      // Replace the draft path: removing + re-adding is the most reliable
      // path-update strategy across fabric versions.
      canvas.remove(draftRef.current);
      const next = new fabric.Path(d, {
        fill: "transparent", stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale, selectable: false,
      });
      canvas.add(next);
      draftRef.current = next;
      canvas.requestRenderAll();
      return;
    }
  };

  const onCanvasMouseUp = () => {
    setSnapDot(null);
    const canvas = fabricRef.current;
    if (!canvas) return;

    if ((tool === "line" || tool === "arrow") && draftRef.current) {
      const ln = draftRef.current as fabric.Line;
      ln.set({ selectable: true }); ln.setCoords();
      if (tool === "arrow") {
        const x1 = ln.x1 ?? 0, y1 = ln.y1 ?? 0, x2 = ln.x2 ?? 0, y2 = ln.y2 ?? 0;
        const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
        const head = new fabric.Triangle({
          left: x2, top: y2, originX: "center", originY: "center",
          width: 14 * scale, height: 18 * scale, fill: COLOR_HEX[color], angle: angle + 90,
        });
        canvas.add(head);
      }
    } else if (tool === "rect" && draftRef.current) {
      const r = draftRef.current as fabric.Rect;
      // Discard zero-sized rects from accidental clicks
      if ((r.width ?? 0) < 2 || (r.height ?? 0) < 2) canvas.remove(r);
      else r.set({ selectable: true });
    } else if (tool === "cloud" && draftRef.current) {
      const p = draftRef.current as fabric.Path;
      p.set({ selectable: true });
    }

    draftRef.current = null;
    draftStartRef.current = null;
  };

  // ─── Keyboard shortcuts ───────────────────────────────────────────────
  // Escape steps out one layer: the stamp menu or a drawing tool, then the
  // phone code, and once nothing is open it closes the viewer (same as the X).
  // It shares the dialog stack, so a dialog opened over the viewer (the
  // stamped-copy question, a confirm) closes first.
  const escState = useRef({ tool, stampMenuOpen, pending: !!pending, diffOpen, phoneQrOpen });
  useEffect(() => { escState.current = { tool, stampMenuOpen, pending: !!pending, diffOpen, phoneQrOpen }; });
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // A menu open in the chrome closes itself on Escape; the viewer stays. The
  // menu is gone by the time the close below runs, so look before it goes.
  const menuOpenAtEsc = useRef(false);
  useEffect(() => {
    if (!isOpen) return;
    const look = (e: KeyboardEvent) => {
      if (e.key === "Escape") menuOpenAtEsc.current = !!document.querySelector("[data-fullscreen-viewer] [role=menu]");
    };
    window.addEventListener("keydown", look, true);
    return () => window.removeEventListener("keydown", look, true);
  }, [isOpen]);
  useEscapeClose(() => {
    const st = escState.current;
    if (st.diffOpen) return; // the compare window handles its own Escape
    if (menuOpenAtEsc.current) return;
    if (st.phoneQrOpen) { setPhoneQrOpen(false); return; }
    if (st.stampMenuOpen || st.tool !== "pan") { setStampMenuOpen(false); setTool("pan"); return; }
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    closeBtnRef.current?.click();
  }, isOpen);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); void undo(); return; }
      if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); void redo(); return; }
      if (e.key === "Delete" || e.key === "Backspace") {
        const act = fabricRef.current?.getActiveObject();
        if (act && (act.type === "i-text" || act.type === "textbox") && (act as unknown as { isEditing?: boolean }).isEditing) return;
        deleteSelected(); return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (escState.current.pending || escState.current.diffOpen) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); pageStepRef.current(-1); return; }
      if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); pageStepRef.current(1); return; }
      const k = e.key.toLowerCase();
      if (k === "v") setTool("select");
      else if (k === "h") setTool("pan");
      else if (k === "p") setTool("pen");
      else if (k === "l") setTool("line");
      else if (k === "a") setTool("arrow");
      else if (k === "r") setTool("rect");
      else if (k === "t") addText();
      else if (k === "n") addStickyNote();
      else if (k === "e") setTool("eraser");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, undo, redo, addText, addStickyNote]);

  // ─── Download / Print (original document, optionally stamped) ─────────
  const controlState = docRecord && currentUserId
    ? determineControlState(docRecord, currentUserId) : "uncontrolled";
  const isControlled = controlState === "controlled";

  const runDocAction = async (type: "download" | "print") => {
    if (!docRecord || !currentUserId) return;
    setActionBusy(true); setActionError(null);
    try {
      const ctx = { doc: docRecord, fileUrl: resolvedUrl ?? url, userId: currentUserId,
        userEmail: currentUserEmail ?? null, userLabel: currentUserEmail ?? null,
        versionId: docRecord.currentVersionId ?? undefined };
      if (type === "download") await downloadDocumentPdf(ctx);
      else await printDocumentPdf(ctx);
      setPending(null);
    } catch (e) {
      setActionError(friendlyError(e));
    } finally { setActionBusy(false); }
  };
  const requestDownload = () => {
    if (!docRecord || !currentUserId) return;
    if (isControlled) void runDocAction("download"); else setPending({ type: "download" });
  };
  const requestPrint = () => {
    if (!docRecord || !currentUserId) return;
    if (isControlled) void runDocAction("print"); else setPending({ type: "print" });
  };

  /**
   * Open a new drafting request pre-filled with this document as the
   * source / reference. The destination route reads query params:
   *  - title         "Revision: <docNumber> – <docTitle>"
   *  - description   prefilled body that names the source doc + rev
   *  - sourceDocId   so the request can backlink to this document
   *  - sourceDocNum  so the form has the doc number even pre-fetch
   *  - sourceDocTitle
   *  - sourceDocRev
   *  - sourceFileUrl (the R2 path so /requests/new can resolve and attach)
   *  - sourceFileName
   */
  const sendToDrafting = async () => {
    if (!docRecord || sendingDraft) return;
    setSendingDraft(true);
    try {
      const d = docRecord;
      const filename = (() => {
        const base = (d.name || d.title || "document").replace(/\s+/g, "_");
        return base.endsWith(".pdf") ? base : `${base}.pdf`;
      })();

      // Pull a sheet number / unit out of either the typed columns or any
      // custom metadata field, so the request body is prefilled the same way
      // the curated-book handoff does it.
      const metaVal = (re: RegExp): string | null => {
        const m = (d.metadata ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(m)) if (re.test(k) && v != null && v !== "") return String(v);
        return null;
      };
      const sheet = d.sheetNumber != null ? String(d.sheetNumber) : metaVal(/sheet/i);
      const unit = metaVal(/\bunit\b|\barea\b/i) ?? "";
      const docNum = docNumber || d.documentNumber || "";
      const docTitle = title || d.title || "";
      const docRev = rev || shownRevision(d.rev, uploadedName(d)) || "";

      // Capture any markups the user has drawn (including the live page).
      saveCurrentPage();
      const states: Record<number, object> = { ...pageStates };
      if (fabricRef.current) states[currentPage] = normalize(fabricRef.current.toJSON(), scale) as object;
      const hasMarkup = Object.values(states).some(
        (p) => ((p as { objects?: unknown[] }).objects?.length ?? 0) > 0,
      );

      // If there are markups, bake them into the PDF and hand THAT off, so the
      // marked-up sheet — not the clean original — lands in the request's
      // source files. With no markups we keep the original-attachment path.
      let draftKey = "";
      if (hasMarkup) {
        const bytes = await ensureBytes();
        if (bytes) {
          try {
            const baked = await bakeMarkupIntoPdf(bytes, states);
            const stem = `${docNum || docTitle || "sheet"}${docRev ? `_Rev${docRev}` : ""}_markup`.replace(/[^\w.\-]+/g, "_");
            draftKey = await stashDraft([{ name: `${stem}.pdf`, blob: new Blob([baked as BlobPart], { type: "application/pdf" }), docId: d.id, docNumber: docNum }]);
          } catch (e) {
            console.error("bake markup for drafting failed; falling back to clean original", e);
          }
        }
      }

      const description = [
        `Source: ${docNum || "(no number)"}${docRev ? ` Rev ${docRev}` : ""}${sheet ? ` · Sheet ${sheet}` : ""}${docTitle ? ` - ${docTitle}` : ""}`,
        draftKey ? "(marked-up sheet attached as a Source file)" : "",
        unit ? `\nUnit: ${unit}` : "",
        "\nWhat needs to change:\n- ",
      ].filter(Boolean).join("\n");

      const params = new URLSearchParams({
        title: `Revision: ${docNum || "Document"} – ${docTitle}`.trim(),
        description,
        sourceDocId: String(d.id || ""),
        sourceDocNum: String(docNum),
        sourceDocTitle: String(docTitle),
        sourceDocRev: String(docRev),
      });
      if (draftKey) {
        // The baked markup carries the content — skip the clean-original
        // attachment so the request doesn't get a duplicate of the sheet.
        params.set("draft", draftKey);
      } else {
        params.set("sourceFileUrl", String(url || ""));
        params.set("sourceFileName", filename);
      }
      if (unit) params.set("unit", unit);
      router.push(`/requests/new?${params.toString()}`);
    } catch (e) {
      console.error("Send to drafting failed", e);
      setSendingDraft(false);
    }
  };

  // ─── Download with markup baked in ────────────────────────────────────
  // Applies the same UNCONTROLLED-COPY watermark + footer + audit row as a
  // plain Download when the user does not hold a checkout, so the markup
  // export never bypasses the document-control gate.
  const downloadWithMarkup = async () => {
    if (!resolvedUrl) return;
    setMarkupBusy(true); setMarkupError(null);
    // Recompute control state from props at the moment of execution rather
    // than relying on a captured closure — defends against any stale React
    // batching and makes the decision tree easier to debug.
    const liveState: "controlled" | "uncontrolled" =
      docRecord && currentUserId
        ? determineControlState(docRecord, currentUserId)
        : "uncontrolled";
    const stampNow = liveState !== "controlled";
    console.warn("[FullScreenViewer] downloadWithMarkup", {
      liveState, stampNow, hasDocRecord: !!docRecord, currentUserId,
      checkedOutBy: docRecord?.checkedOutBy,
    });

    try {
      saveCurrentPage();
      let currentNorm: CanvasJson | null = null;
      if (fabricRef.current) currentNorm = normalize(fabricRef.current.toJSON(), scale);

      const srcBytes = await ensureBytes();
      if (!srcBytes) { setMarkupError("Couldn't load the PDF to export."); setMarkupBusy(false); return; }
      const pdfDoc = await PDFDocument.load(srcBytes);
      const pages = pdfDoc.getPages();

      const states: Record<number, object> = { ...pageStates };
      if (currentNorm) states[currentPage] = currentNorm;

      // 1. Bake Fabric annotations into each page
      for (const [k, st] of Object.entries(states)) {
        const pn = parseInt(k, 10);
        if (pn < 1 || pn > pages.length) continue;
        const page = pages[pn - 1];
        const { width, height } = page.getSize();
        const tempEl = window.document.createElement("canvas");
        const sc = new fabric.StaticCanvas(tempEl, { width: 1000, height: 1000 });
        await sc.loadFromJSON(st as CanvasJson);
        sc.setDimensions({ width, height });
        sc.renderAll();
        const png = sc.toDataURL({ format: "png", multiplier: 2 });
        const pngBytes = await fetch(png).then((r) => r.arrayBuffer());
        const img = await pdfDoc.embedPng(pngBytes);
        page.drawImage(img, { x: 0, y: 0, width, height });
      }

      // 2. Apply UNCONTROLLED stamp on top if the user doesn't hold checkout
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 3600 * 1000);
      let suffix = "_markup";
      if (stampNow) {
        await applyStampToPdfDoc(pdfDoc, {
          sourceBytes: pdfBytes ?? undefined,
          userLabel: currentUserEmail ?? undefined,
          email: currentUserEmail ?? undefined,
          timestamp: now,
          expiresAt,
          watermarkText: "UNCONTROLLED - FOR REVIEW ONLY",
          footerNotice: `${docNumber || title || "Document"} Rev ${rev ?? "?"} WITH MARKUPS at time of export: markups are not part of the controlled revision.`,
          verifyUrl: docRecord?.id && docRecord.currentVersionId && publicOrigin()
            ? `${publicOrigin()}/verify/${docRecord.id}?v=${docRecord.currentVersionId}`
            : undefined,
        });
        suffix = "_markup_UNCONTROLLED";
      }

      // 3. Save + trigger local download
      const bytes = await pdfDoc.save();
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const u = URL.createObjectURL(blob);
      const stem = `${docNumber || title || "document"}${rev ? `_Rev${rev}` : ""}${suffix}`.replace(/[^\w.\-]+/g, "_");
      const a = window.document.createElement("a");
      a.href = u; a.download = `${stem}.pdf`;
      window.document.body.appendChild(a); a.click(); window.document.body.removeChild(a);
      URL.revokeObjectURL(u);

      // 4. Audit log — same row shape as a plain Download
      if (docRecord && currentUserId) {
        await logDownloadAudit({
          doc: docRecord,
          versionId: docRecord.currentVersionId ?? undefined,
          userId: currentUserId,
          userEmail: currentUserEmail ?? null,
          state: liveState,
          expiresAt: stampNow ? expiresAt : null,
        });
        // Marking up is the most edit-like act in the viewer — record it so
        // overlap advisories and provenance see the work.
        if (docRecord.orgId && docRecord.id) {
          void recordIntent({
            orgId: docRecord.orgId,
            documentId: docRecord.id,
            libraryId: docRecord.libraryId ?? null,
            userId: currentUserId,
            userName: currentUserEmail?.split("@")[0] ?? null,
            kind: "edit",
            source: "download",
            baseVersionId: docRecord.currentVersionId ?? null,
          });
        }
      }

      setPending(null);
    } catch (e) {
      console.error("Markup download failed", e);
      setMarkupError(friendlyError(e));
    } finally { setMarkupBusy(false); }
  };

  // Always force the confirm modal when the doc is uncontrolled so the user
  // can't quietly bypass the watermark by clicking too fast. Only skip the
  // modal in the ad-hoc viewer case where we have no doc/user context.
  const requestMarkupDownload = () => {
    console.warn("[FullScreenViewer] requestMarkupDownload entry", {
      hasResolvedUrl: !!resolvedUrl, hasDocRecord: !!docRecord, currentUserId,
    });
    if (!resolvedUrl) return;
    if (!docRecord || !currentUserId) {
      console.warn("[FullScreenViewer] no doc/user context → direct downloadWithMarkup");
      void downloadWithMarkup();
      return;
    }
    const live = determineControlState(docRecord, currentUserId);
    console.warn("[FullScreenViewer] live control state:", live);
    if (live === "controlled") {
      // User holds checkout → raw bake, no stamp, no modal
      void downloadWithMarkup();
      return;
    }
    console.warn("[FullScreenViewer] opening uncontrolled confirm modal");
    setPending({ type: "markup" });
  };

  if (!isOpen) return null;

  // Report the latest per-page markup (including the live current page) before
  // closing, so a parent can persist it across opens.
  const handleClose = async () => {
    const canvas = fabricRef.current;
    const merged: Record<number, object> = { ...pageStates };
    if (canvas) merged[currentPage] = normalize(canvas.toJSON(), scale) as object;
    if (onCommit) {
      // Stay up showing "applying…" until the parent has the baked sheet ready,
      // so closing doesn't flash the un-marked original.
      setCommitting(true);
      try { await onCommit(merged); } catch (e) { console.error("markup commit failed", e); }
      setCommitting(false);
    } else if (onPageStatesChange) {
      onPageStatesChange(merged);
    }
    onClose();
  };

  // A drawing tool: quiet, or a white pill when chosen.
  const toolBtn = (value: Tool, Icon: LucideIcon, label: string) => (
    <button key={value} type="button" onClick={() => setTool(value)} title={label} aria-label={label} aria-pressed={tool === value}
      className={vTool(tool === value)}>
      <Icon className="w-5 h-5" />
    </button>
  );
  const railBtn = "w-9 h-9 sm:w-10 sm:h-10 pointer-coarse:w-11 pointer-coarse:h-11 shrink-0 rounded-lg grid place-items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)] transition-colors";
  const railLine = <div className="w-7 h-px shrink-0 bg-[var(--color-border)] my-1" aria-hidden="true" />;

  // Detect whether the doc has any equipment tags worth showing — if
  // not we don't render the floating bar at all (cleaner viewer).
  const hasAnyTags = !!(docRecord?.metadata && Object.values(docRecord.metadata).some(
    (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")
  ));

  // The drawing's state in words, on the line over its name. Status colors
  // keep their meanings: green issued, amber not yet / not current, red void.
  const vb = docRecord ? viewerStatusBadge({ status: docRecord.status, rev: docRecord.rev ?? rev }) : null;
  const statusWord = vb ? vb.label.replace(/\s·\sRev\s.*$/, "") : null;
  const statusTone: Record<ViewBadgeTone, string> = {
    controlled: "text-emerald-400",
    caution: "text-amber-400",
    danger: "text-rose-400",
    muted: "text-[var(--color-text-muted)]",
  };
  const lockedByOther = !!(docRecord?.checkedOutBy && currentUserId && String(docRecord.checkedOutBy) !== String(currentUserId));
  const canDocAction = !!docRecord && !!currentUserId;

  // Less-used actions live in More. On a phone, Download and Print move in too.
  const moreItems: MoreItem[] = [
    ...(isMobile && canDocAction ? [
      { icon: <Download className="w-4 h-4" />, label: isControlled ? "Download" : "Download a stamped copy", onClick: requestDownload },
      { icon: <Printer className="w-4 h-4" />, label: isControlled ? "Print" : "Print a stamped copy", onClick: requestPrint },
    ] : []),
    ...(resolvedUrl ? [{ icon: <FileDown className="w-4 h-4" />, label: markupBusy ? "Preparing your copy…" : "Download with markups", onClick: requestMarkupDownload }] : []),
    ...(docRecord ? [{ icon: <GitCompare className="w-4 h-4" />, label: "Compare revisions", onClick: () => setDiffOpen(true), line: true }] : []),
    ...(docRecord?.id && docRecord.libraryId ? [{ icon: <Smartphone className="w-4 h-4" />, label: phoneQrOpen ? "Hide the phone code" : "Open on your phone", onClick: () => setPhoneQrOpen((v) => !v) }] : []),
  ];

  const closePending = () => { setPending(null); setActionError(null); setMarkupError(null); };
  const pendingBusy = actionBusy || markupBusy;
  // A failed download or print says so here, next to the drawing, unless the
  // stamped-copy question is open (then it says so in there).
  const chromeError = !pending ? (actionError || markupError) : null;

  return (
    <div data-fullscreen-viewer role="dialog" aria-modal="true" aria-label={title}
      className="fixed inset-0 z-[100]" onPointerUp={onCanvasMouseUp} onPointerCancel={onCanvasMouseUp} onMouseLeave={onCanvasMouseUp}>
      {/* The page behind stays in view at the edges, dimmed. */}
      <div className={vDim} aria-hidden="true" />

      <div className={vPanel}>
        {committing && (
          <div className="absolute inset-0 z-[200] bg-[color-mix(in_srgb,var(--color-ink)_85%,transparent)] backdrop-blur-sm flex flex-col items-center justify-center gap-3">
            <Loader2 className="w-9 h-9 animate-spin text-[var(--color-text-muted)]" />
            <span className="text-body font-medium text-[var(--color-text)]">Applying your markups…</span>
          </div>
        )}

        {/* ─── TOP CHROME ──────────────────────────────────────────────
            Which drawing, big. Then the few controls used every time, the
            rest in More, one orange action, and the X. On a phone the
            controls drop to their own row under the name. */}
        <header className="relative z-[60] shrink-0 border-b border-[var(--color-border)] px-3 sm:px-5 py-2.5 sm:py-3 flex flex-wrap lg:flex-nowrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-[calc(100%-56px)] lg:basis-auto">
            <div className={vKicker}>
              {docNumber && docNumber !== title ? <>{docNumber} · </> : null}{rev ? `Rev ${rev}` : "No revision set"}
              {vb && statusWord && (
                <> · <span className={statusTone[vb.tone]} title="Status of the live version you're viewing. A copy you download or print is stamped separately.">{statusWord}</span></>
              )}
            </div>
            <h2 className={vTitle} title={title}>
              {docNumber && docNumber === title ? <CopyId value={docNumber} label="document number" /> : title}
            </h2>
          </div>

          <button ref={closeBtnRef} type="button" data-viewer-close onClick={() => void handleClose()} disabled={committing}
            title="Close (Esc)" aria-label="Close" className={`${vClose} lg:order-last`}>
            <X className="w-5 h-5" />
          </button>

          <div className="w-full lg:w-auto flex items-center gap-1.5 sm:gap-2 min-w-0">
            {docRecord && onCheckout && (
              <div className="shrink-0 max-sm:hidden">
                <CheckoutStatusCell docRecord={docRecord} currentUserId={currentUserId} currentUserEmail={currentUserEmail} userRole={userRole} onCheckout={onCheckout} />
              </div>
            )}
            {/* Pages: left goes back a page (the arrow keys too) */}
            <div className={vGroup}>
              <button type="button" onClick={() => goPage(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page" title="Previous page (Left arrow)" className={vIcon}><ChevronLeft className="w-4 h-4" /></button>
              <span className="px-1 min-w-[3.25rem] text-center" aria-live="polite">{currentPage} / {numPages || "-"}</span>
              <button type="button" onClick={() => goPage(currentPage + 1)} disabled={currentPage >= numPages} aria-label="Next page" title="Next page (Right arrow)" className={vIcon}><ChevronRight className="w-4 h-4" /></button>
            </div>
            {/* Zoom */}
            <div className={vGroup}>
              <button type="button" onClick={() => setZoom(scale - 0.25)} aria-label="Zoom out" title="Zoom out" className={vIcon}><ZoomOut className="w-4 h-4" /></button>
              <span className="px-0.5 min-w-[2.75rem] text-center">{Math.round(scale * 100)}%</span>
              <button type="button" onClick={() => setZoom(scale + 0.25)} aria-label="Zoom in" title="Zoom in" className={vIcon}><ZoomIn className="w-4 h-4" /></button>
            </div>

            <div className="flex-1" />

            {/* Download and print the original (stamped if uncontrolled) */}
            {!isMobile && (
              <>
                <button type="button" onClick={requestDownload} disabled={!canDocAction || actionBusy}
                  className={vQuiet} aria-label="Download"
                  title={isControlled ? "Download the original PDF" : "Download a stamped (uncontrolled) PDF"}>
                  {actionBusy && pending?.type !== "print" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  <span className="hidden xl:inline">Download</span>
                </button>
                <button type="button" onClick={requestPrint} disabled={!canDocAction || actionBusy}
                  className={vQuiet} aria-label="Print" title={isControlled ? "Print" : "Print a stamped (uncontrolled) copy"}>
                  <Printer className="w-4 h-4" /> <span className="hidden xl:inline">Print</span>
                </button>
              </>
            )}

            {/* Less-used: markup download, compare revisions, open on a phone. */}
            <div className="relative shrink-0">
              <MoreMenu label="More" iconOnly triggerClass={vQuiet} items={moreItems} />
              {phoneQrOpen && docRecord?.id && docRecord.libraryId && (
                <div className="absolute right-0 top-full mt-2 z-[60] w-[184px] flex justify-center rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl p-3 pt-8">
                  <button type="button" onClick={() => setPhoneQrOpen(false)} aria-label="Hide the phone code" className="ui-hit absolute top-1 right-1 w-7 h-7 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]"><X className="w-4 h-4" /></button>
                  <QrBadge
                    value={`${window.location.origin}/documents/${docRecord.libraryId}?doc=${docRecord.id}`}
                    size={150}
                    caption="Scan to open this drawing on your phone"
                  />
                </div>
              )}
            </div>

            {/* The one action: a drafting request for this drawing, markups
                included as the Source file. */}
            <button type="button" onClick={() => void sendToDrafting()} disabled={!docRecord || sendingDraft}
              className={vPrimary} aria-label="Send to drafting"
              title="Start a drafting request for this drawing. Your markups go with it.">
              {sendingDraft ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              <span className="max-md:hidden">Send to drafting</span>
            </button>
          </div>
        </header>

        {/* On a phone the checkout sits on its own line under the controls. */}
        {docRecord && onCheckout && (
          <div className="sm:hidden shrink-0 px-3 py-1.5 border-b border-[var(--color-border)]">
            <CheckoutStatusCell docRecord={docRecord} currentUserId={currentUserId} currentUserEmail={currentUserEmail} userRole={userRole} onCheckout={onCheckout} />
          </div>
        )}

        {/* Someone ELSE holds the checkout: said here, on the drawing it's
            about, passively (who, why, since when, one tap to their thread). */}
        {lockedByOther && docRecord && (
          <div className={`${vNote} text-amber-300`}>
            <Lock className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              <b>{docRecord.checkedOutByName || "Another user"}</b> is working on this drawing
              {docRecord.checkedOutAt ? <> since {new Date(String(docRecord.checkedOutAt)).toLocaleDateString()}</> : null}
              {docRecord.checkoutNote ? <>: <i>{docRecord.checkoutNote}</i></> : null}
              . Talk to them before you change it.
            </span>
            {onCheckout && (
              <button type="button" onClick={() => onCheckout(docRecord)}
                className="pointer-coarse:h-11 ml-auto shrink-0 h-7 px-2.5 rounded-lg bg-[var(--color-ink-2)] text-[var(--color-text)] hover:bg-[var(--color-ink-line)] text-body font-medium">
                Open checkout thread
              </button>
            )}
          </div>
        )}

        {chromeError && (
          <p role="alert" className={`${vNote} text-rose-300`}>
            <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{chromeError}</span>
            <button type="button" onClick={() => { setActionError(null); setMarkupError(null); }} aria-label="Dismiss"
              className="ui-hit ml-auto shrink-0 w-7 h-7 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]"><X className="w-3.5 h-3.5" /></button>
          </p>
        )}

        {/* ─── BODY: Tool rail | Canvas ─────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-hidden flex">
          {/* TOOL RAIL */}
          <div className="relative z-[60] w-12 sm:w-14 border-r border-[var(--color-border)] flex flex-col items-center py-2 gap-1 shrink-0" role="toolbar" aria-label="Markup tools" aria-orientation="vertical">
            {toolBtn("pan", Move, "Pan / move page (H or Esc)")}
            {toolBtn("select", MousePointer2, "Select markups (V)")}
            {railLine}
            {toolBtn("pen", Pen, "Pen (P)")}
            {toolBtn("highlight", Highlighter, "Highlighter")}
            {toolBtn("line", Minus, "Line (L)")}
            {toolBtn("arrow", ArrowUpRight, "Arrow (A)")}
            {toolBtn("rect", Square, "Rectangle (R)")}
            {toolBtn("cloud", Cloud, "Rev cloud (drag to draw the box)")}
            <button type="button" onClick={addText} className={railBtn} title="Text (T)" aria-label="Text"><Type className="w-5 h-5" /></button>
            <button type="button" onClick={addStickyNote} className={railBtn} title="Sticky note (N)" aria-label="Sticky note"><StickyNote className="w-5 h-5" /></button>
            <div className="relative">
              <button type="button" onClick={() => setStampMenuOpen((v) => !v)} aria-expanded={stampMenuOpen} aria-label="Stamp" title="Stamp" className={vTool(stampMenuOpen)}><StampIcon className="w-5 h-5" /></button>
              {stampMenuOpen && (
                <div className="absolute left-12 bottom-0 w-64 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl p-2 z-50 max-h-[min(52vh,30rem)] overflow-y-auto">
                  <div className="text-body font-medium text-[var(--color-text-muted)] px-2 pb-2">Standard</div>
                  {/* Each stamp shown as it lands on the sheet: its color on paper. */}
                  <div className="grid grid-cols-1 gap-1">
                    {STAMPS.map((s) => (
                      <button type="button" key={s.label} onClick={() => addStamp(s.label, s.tone)} className="text-left px-1.5 py-1 rounded-md hover:bg-[var(--color-ink-2)]">
                        <span className="inline-block px-2 py-0.5 rounded border-2 bg-[var(--color-ink-fg)] text-body font-medium tracking-wide" style={{ color: COLOR_HEX[s.tone], borderColor: COLOR_HEX[s.tone] }}>{s.label}</span>
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 pt-2 border-t border-[var(--color-border)] flex items-center justify-between px-2 pb-2">
                    <span className="text-body font-medium text-[var(--color-text-muted)] ">Custom</span>
                    <button
                      type="button"
                      onClick={() => stampFileInputRef.current?.click()}
                      className="pointer-coarse:h-11 text-body font-medium h-7 px-2.5 rounded-lg bg-[var(--color-ink-2)] hover:bg-[var(--color-ink-line)] text-[var(--color-text)]"
                    >+ Upload</button>
                    <input
                      ref={stampFileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onUploadStamp(f);
                        e.target.value = "";
                      }}
                    />
                  </div>
                  {customStamps.length === 0 ? (
                    <div className="text-caption text-[var(--color-text-muted)] px-2 pb-2">Upload PNG, JPG or SVG stamps. They&apos;re kept on this device.</div>
                  ) : (
                    <div className="grid grid-cols-3 gap-1 px-1 pb-1">
                      {customStamps.map((s) => (
                        <div key={s.id} className="relative group">
                          <button
                            type="button"
                            onClick={() => void addCustomStamp(s.src)}
                            className="w-full h-14 rounded-md bg-[var(--color-ink-fg)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)] overflow-hidden p-1"
                            title={s.name}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded stamp thumbnails are data/storage URLs the optimizer can't process */}
                            <img src={s.src} alt={s.name} className="w-full h-full object-contain" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeCustomStamp(s.id)}
                            className="ui-hit absolute -top-1 -right-1 w-4 h-4 bg-[var(--state-overdue)] text-[var(--color-ink-fg)] rounded-full text-caption font-medium opacity-60 sm:opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity"
                            title="Remove" aria-label={`Remove ${s.name}`}
                          >×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {railLine}
            {toolBtn("eraser", Eraser, "Eraser (E)")}
            <button type="button" onClick={deleteSelected} className={`${railBtn} hover:text-rose-400`} title="Delete what's selected" aria-label="Delete what's selected"><Trash2 className="w-5 h-5" /></button>
            {railLine}
            <button type="button" onClick={() => void undo()} className={railBtn} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 className="w-5 h-5" /></button>
            <button type="button" onClick={() => void redo()} className={railBtn} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 className="w-5 h-5" /></button>
          </div>

          {/* PROPERTY BAR + CANVAS */}
          <div className="relative flex-1 min-w-0 flex flex-col">
            <div className="h-10 border-b border-[var(--color-border)] flex items-center px-3 gap-3 shrink-0 overflow-x-auto">
              {/* Pen colors stay the markup colors drawn on the sheet. */}
              <div className="flex items-center gap-1.5 shrink-0" role="radiogroup" aria-label="Markup color">
                {(Object.keys(COLOR_HEX) as ColorKey[]).map((c) => (
                  <button type="button" key={c} onClick={() => setColor(c)} role="radio" aria-checked={color === c} aria-label={`${c} pen`}
                    className={`pointer-coarse:size-11 w-5 h-5 rounded-full border-2 ring-1 ring-[var(--color-ink-line)] transition-transform ${color === c ? "border-[var(--color-ink-fg)] scale-110" : "border-transparent hover:scale-105"}`}
                    style={{ backgroundColor: COLOR_HEX[c] }} title={c} />
                ))}
              </div>
              <div className="w-px h-5 shrink-0 bg-[var(--color-border)]" />
              <label className="flex items-center gap-2 shrink-0">
                <span className="text-body font-medium text-[var(--color-text-muted)] ">Width</span>
                <input type="range" min={1} max={12} value={strokeWidth} onChange={(e) => setStrokeWidth(Number(e.target.value))}
                  className="w-24 h-1 rounded-lg accent-[var(--color-ink-fg)] cursor-pointer" />
                <span className="text-body tabular-nums text-[var(--color-text)] w-5 text-right">{strokeWidth}</span>
              </label>
            </div>

            {/* EQUIPMENT TAGS: pull up an item's photos while studying the
                drawing, without closing it. Hide it to see more sheet. */}
            {orgId && docRecord && hasAnyTags && (tagsBarOpen ? (
              <div className="absolute top-12 left-3 right-3 z-40 rounded-xl bg-[color-mix(in_srgb,var(--color-ink)_88%,transparent)] backdrop-blur border border-[var(--color-border)] px-3 py-2 shadow-lg flex items-center gap-2">
                <div className="flex-1 min-w-0 overflow-x-auto">
                  <EquipmentTagsStrip
                    metadata={docRecord.metadata as Record<string, unknown>}
                    customColumns={customColumns}
                    orgId={orgId}
                    userId={currentUserId}
                    canManage={canManageAssets}
                    variant="ribbon"
                  />
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setTagsBarOpen(false); }}
                  title="Hide equipment tags"
                  aria-label="Hide equipment tags"
                  className="ui-hit shrink-0 w-7 h-7 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setTagsBarOpen(true); }}
                className="absolute top-12 right-3 z-40 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[color-mix(in_srgb,var(--color-ink)_88%,transparent)] backdrop-blur border border-[var(--color-border)] text-[var(--color-text)] text-caption font-medium shadow-lg"
                title="Show the equipment tags"
              >
                <Camera className="w-3.5 h-3.5" /> Equipment tags
              </button>
            ))}

            <div ref={canvasScrollRef} className={`flex-1 overflow-auto relative bg-[var(--color-surface)] p-4 sm:p-6 ${panZoom.cursorClass}`}
                 onPointerDown={(e) => { panZoom.panHandlers.onPointerDown(e); if (tool !== "pan") onCanvasMouseDown(e); }}
                 onPointerMove={(e) => { panZoom.panHandlers.onPointerMove(e); if (tool !== "pan") onCanvasMouseMove(e); }}
                 onPointerUp={(e) => panZoom.panHandlers.onPointerUp(e)}
                 onPointerCancel={(e) => panZoom.panHandlers.onPointerCancel(e)}
                 onPointerLeave={(e) => panZoom.panHandlers.onPointerLeave(e)}
                 style={{
                   // When a pan/draw tool is active, claim touch gestures so the
                   // browser doesn't steal them for scroll/zoom — this is what
                   // makes finger-drawing and one-finger pan work on a tablet.
                   // In select/none/pen mode we leave native scroll intact (Fabric
                   // handles pen drawing on its own canvas).
                   touchAction:
                     tool === "pan" || tool === "line" || tool === "arrow" ||
                     tool === "rect" || tool === "cloud" || tool === "eraser"
                       ? "none"
                       : "auto",
                 }}>
              {/* Archived-offline: this revision's binary was shed for space —
                  show the provide-the-zip prompt + in-memory viewer instead of a
                  dead stream. */}
              {archivedInfo && (
                <div className="absolute inset-0 overflow-y-auto bg-[var(--color-canvas)] p-4 sm:p-6 z-10">
                  <div className="max-w-4xl mx-auto">
                    <BackupViewer
                      target={{
                        storageKey: url,
                        fileName: archivedInfo.fileName,
                        archiveId: archivedInfo.archiveId,
                        root: archivedInfo.root,
                        kind: "space",
                      }}
                    />
                  </div>
                </div>
              )}
              {/* Couldn't open it / opening: said in place of the drawing */}
              {!archivedInfo && fetchError && (
                <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
                  <ShieldAlert className="w-10 h-10 text-rose-400 mb-3" />
                  <div className="text-reading font-medium text-[var(--color-text)] mb-1">{notViewable ? `${fileTypeName({ fileName: shownFileName, path: url })} can't be shown here` : "Couldn't open this drawing"}</div>
                  <div className="text-body text-[var(--color-text-muted)] max-w-md">{notViewable ? "Close this and use Download in the document's panel to open it in its own program." : fetchError}</div>
                </div>
              )}
              {!archivedInfo && !fetchError && !resolvedUrl && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-[var(--color-text-muted)]">
                  <Loader2 className="w-9 h-9 animate-spin mb-3" />
                  <div className="text-body font-medium">Opening the drawing…</div>
                </div>
              )}

              <div className="min-w-full min-h-full flex items-center justify-center">
                <div className="relative shadow-2xl shadow-black/40 bg-white">
                  <div className="relative z-0" style={{ pointerEvents: "none", userSelect: "none" }}>
                    {resolvedUrl && (
                      <Document options={PDF_DOC_OPTIONS}
                        file={fileSource ?? resolvedUrl}
                        onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                        onLoadError={(err) => setFetchError(err.message || "PDF parse failed")}
                        loading={null}
                        className="block"
                      >
                        <Page
                          pageNumber={currentPage}
                          scale={scale}
                          onRenderSuccess={onPageLoaded}
                          renderAnnotationLayer={false}
                          renderTextLayer={false}
                          className="block"
                        />
                      </Document>
                    )}
                  </div>
                  <div className="absolute top-0 left-0 z-[50]" style={{ width: "100%", height: "100%" }}>
                    <canvas ref={canvasRef} />
                  </div>
                  {/* Snap point indicator — green dot, pointer-events-none */}
                  {snapDot && (
                    <div
                      className="absolute z-[60] pointer-events-none rounded-full bg-emerald-400 ring-2 ring-emerald-300/60"
                      style={{ left: snapDot.x - 5, top: snapDot.y - 5, width: 10, height: 10 }}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Phase 4 — revision compare (true overlay, with version pickers) */}
      {diffOpen && docRecord && (
        <CompareRevisionsModal
          isOpen
          onClose={() => setDiffOpen(false)}
          doc={docRecord}
          initialBaseVersionId={previousVersion?.id}
          initialCompareVersionId={currentVersion?.id}
        />
      )}

      {/* ─── Uncontrolled-copy question ─────────────────────────────── */}
      {pending && (
        <Modal onClose={closePending} dismissable={!pendingBusy} size="sm" zIndex={400}>
          <ModalHeader
            icon={ShieldAlert}
            iconClassName="bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)] text-[var(--state-held-text)]"
            title="This copy will be stamped uncontrolled"
            subtitle="You don't have this document checked out."
            onClose={pendingBusy ? undefined : closePending}
          />
          <ModalBody className="space-y-3">
            <p className="text-body text-[var(--color-text-muted)]">Each page gets an &quot;UNCONTROLLED - FOR REVIEW ONLY&quot; mark and a footer with your email and the time. It&apos;s logged.</p>
            {(pending.type === "markup" ? markupError : actionError) && (
              <FieldError>{pending.type === "markup" ? markupError : actionError}</FieldError>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="secondary" onClick={closePending} disabled={pendingBusy}>Cancel</Button>
            <Button
              loading={pendingBusy}
              onClick={() => {
                if (pending.type === "markup") void downloadWithMarkup();
                else void runDocAction(pending.type);
              }}
            >
              {pending.type === "download" ? "Download stamped copy" :
               pending.type === "print" ? "Print stamped copy" :
               "Download stamped markup"}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}
