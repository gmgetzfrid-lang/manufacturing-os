"use client";

// MultiDocViewer — the combined "Reference Book".
//
// Renders many documents as ONE continuous, smoothly-scrolling stack of real
// PDF pages (react-pdf canvases — no nested iframes, so there's no per-page
// scroll stutter). As you scroll, the active sheet drives a floating
// equipment-tag ribbon, and a column-agnostic Tag Search jumps you straight to
// the sheet carrying a given tag. Full markup is one click away per sheet via
// the single-document editor.
//
// LAYOUT: a true full-bleed PDF surface with all chrome as overlays — a compact
// auto-hiding top toolbar, a slide-over sidebar (page thumbnails + contents),
// and a collapsible tag ribbon. Pages render fit-to-width by default (no max
// cap) so a wide refinery P&ID truly fills the screen; fit-page, zoom, rotate
// and a real browser-fullscreen toggle round out the viewer controls.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X, BookOpen, ChevronLeft, ChevronRight, Loader2, FileText, Menu,
  Download, Printer, ShieldAlert, Library, Briefcase,
  Search, Pen, ZoomIn, ZoomOut, Camera, Pin, Layers, Plus, Check, Send,
  Maximize2, Minimize2, RotateCw, MoreHorizontal, PanelLeftClose,
  MousePointer2, Highlighter, Square, ArrowUpRight, Type, Eraser, Trash2, Tags, ChevronDown, Hand,
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import { PDF_DOC_OPTIONS } from "@/lib/pdfjsConfig";
import * as fabric from "fabric";
import { supabase } from "@/lib/supabase";
import type { DocumentRecord } from "@/types/schema";
import { downloadDocumentPdf, printDocumentPdf, determineControlState, viewerStatusBadge, type ViewBadgeTone } from "@/lib/downloads";
import { stampPdf } from "@/lib/stamping";
import { recordIntent } from "@/lib/intents";
import { publicOrigin } from "@/lib/publicOrigin";
import { PDFDocument } from "pdf-lib";
import BulkCheckoutToProjectModal from "@/components/documents/BulkCheckoutToProjectModal";
import EquipmentTagsStrip from "@/components/assets/EquipmentTagsStrip";
import { collectTagGroups, rankTags, type TagColumnDef } from "@/lib/documentTags";
import { useViewerPanZoom } from "@/lib/useViewerPanZoom";
import { bakeMarkupIntoPdf } from "@/lib/markupExport";
import { issuedFileUrl, prepareDraftingRequest } from "@/lib/sendToDrafting";
import { appAlert } from "@/components/providers/DialogProvider";
import { useRouter } from "next/navigation";
import { badgeText } from "@/lib/badge";
import { escapeStackBusy } from "@/components/documents/useEscapeClose";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { vDim, vPanel, vKicker, vTitle, vIcon, vTool, vQuiet, vGroup, vPrimary, vClose, vNote } from "@/components/viewers/viewerChrome";

// Same self-hosted worker the single viewer uses (copied to /public on prebuild).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

// The sheet's state in words on the charcoal: status colors keep their
// meanings (green issued, amber not yet / not current, red void).
const STATUS_TONE: Record<ViewBadgeTone, string> = {
  controlled: "text-emerald-400",
  caution: "text-amber-400",
  danger: "text-rose-400",
  muted: "text-[var(--color-text-muted)]",
};

interface DocEntry {
  doc: DocumentRecord;
  resolvedUrl: string | null;
  loading: boolean;
  error: string | null;
}

// Resolve a column key to a doc's display text — mirrors the library table's
// renderDocCell (built-ins from top-level fields, custom keys from metadata) so
// a thumbnail's label matches exactly what the table shows.
function cellText(doc: DocumentRecord, key: string): string {
  if (key === "title") return doc.title || doc.name || "";
  if (key === "documentNumber") return doc.documentNumber || "";
  if (key === "rev") return doc.rev || "";
  if (key === "status") return doc.status || "";
  if (key === "updatedAt") {
    const v = doc.updatedAt as unknown;
    try {
      if (v && typeof (v as { toDate?: () => Date }).toDate === "function") return (v as { toDate: () => Date }).toDate().toLocaleDateString();
      if (typeof v === "string" || typeof v === "number") return new Date(v).toLocaleDateString();
    } catch { /* ignore */ }
    return "";
  }
  const v = (doc.metadata ?? {})[key];
  return Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
}

// Lazy page-thumbnail — measures its own box and renders the page at exactly that
// width (so it fills horizontally and never clips), with height wrapping the page
// (no fixed aspect → no empty white space for wide landscape sheets). Only parses
// its PDF once scrolled near the panel.
function PageThumb({ url }: { url: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [show, setShow] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver((obs) => { const cw = obs[0]?.contentRect.width ?? 0; if (cw > 0) setW(Math.round(cw)); });
      ro.observe(el);
    }
    let io: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setShow(true); io?.disconnect(); } }, { rootMargin: "500px 0px" });
      io.observe(el);
    }
    return () => { ro?.disconnect(); io?.disconnect(); };
  }, []);
  const ph = Math.max(48, Math.round(w * 0.66)); // placeholder height (landscape guess)
  return (
    <div ref={ref} className="w-full bg-[var(--color-ink-2)] leading-[0]">
      {show && url && w > 0 ? (
        <Document options={PDF_DOC_OPTIONS} file={url} loading={<div className="animate-pulse bg-[var(--color-ink-2)]" style={{ height: ph }} />} error={<div className="flex items-center justify-center text-[var(--color-text-muted)]" style={{ height: ph }}><FileText className="w-5 h-5 opacity-40" /></div>}>
          <Page pageNumber={1} width={w} renderTextLayer={false} renderAnnotationLayer={false} loading={<div className="animate-pulse bg-[var(--color-ink-2)]" style={{ height: ph }} />} />
        </Document>
      ) : (
        <div className="animate-pulse bg-[var(--color-ink-2)]" style={{ height: ph }} />
      )}
    </div>
  );
}

// ── Inline markup ───────────────────────────────────────────────────────────
type MarkTool = "select" | "pen" | "highlight" | "rect" | "arrow" | "text" | "eraser";
type ColorKey = "red" | "blue" | "black" | "yellow" | "green" | "orange";
const COLOR_HEX: Record<ColorKey, string> = {
  red: "#dc2626", blue: "#2563eb", black: "#111827", yellow: "#f59e0b", green: "#16a34a", orange: "#ea580c",
};
const HIGHLIGHT_RGBA: Record<ColorKey, string> = {
  red: "rgba(220,38,38,0.32)", blue: "rgba(37,99,235,0.32)", black: "rgba(17,24,39,0.30)",
  yellow: "rgba(245,158,11,0.40)", green: "rgba(22,163,74,0.32)", orange: "rgba(234,88,12,0.34)",
};

type CanvasJson = { objects?: Array<Record<string, unknown>>; [k: string]: unknown };
// Markups are STORED at scale 1.0 (PDF-point space) so bakeMarkupIntoPdf can
// stamp them regardless of the on-screen zoom — same contract as FullScreenViewer.
function scaleObjects(json: CanvasJson, f: number): CanvasJson {
  if (!json?.objects) return json;
  const out: CanvasJson = JSON.parse(JSON.stringify(json));
  out.objects!.forEach((o) => {
    o.left = (o.left as number) * f;
    o.top = (o.top as number) * f;
    o.scaleX = (o.scaleX as number) * f;
    o.scaleY = (o.scaleY as number) * f;
  });
  return out;
}
function normJson(json: CanvasJson, s: number): CanvasJson {
  return s > 0 ? scaleObjects(json, 1 / s) : json;
}
function denormJson(json: CanvasJson, s: number): CanvasJson {
  return scaleObjects(json, s);
}

// One Fabric overlay over ONE already-rendered PDF page. It measures its own box
// (which is sized to the page), so it stays aligned through zoom; it never
// re-renders the PDF. Edits are emitted normalized to point space.
function InlinePageMarkup({ naturalWidth, tool, color, strokeWidth, enabled, value, onChange }: {
  naturalWidth: number;
  tool: MarkTool; color: ColorKey; strokeWidth: number; enabled: boolean;
  value?: object; onChange: (json: object | undefined) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLCanvasElement>(null);
  const fabRef = useRef<fabric.Canvas | null>(null);
  const commitRef = useRef<() => void>(() => {});
  const draftRef = useRef<fabric.Object | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const restoringRef = useRef(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const scale = naturalWidth > 0 && size.w > 0 ? size.w / naturalWidth : 1;
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const strokeRef = useRef(strokeWidth);
  const scaleRef = useRef(scale);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  // Keep the latest props in refs for the Fabric event/pointer handlers — synced
  // in an effect (never during render).
  useEffect(() => {
    toolRef.current = tool;
    colorRef.current = color;
    strokeRef.current = strokeWidth;
    scaleRef.current = scale;
    onChangeRef.current = onChange;
    valueRef.current = value;
  });

  // Measure our box (== the rendered page), driving canvas size + scale.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((obs) => { const r = obs[0]?.contentRect; if (r && r.width > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Create the Fabric canvas once.
  useEffect(() => {
    if (!elRef.current) return;
    const c = new fabric.Canvas(elRef.current, { selection: true, preserveObjectStacking: true });
    fabRef.current = c;
    const commit = () => {
      if (restoringRef.current || draftRef.current) return;
      const norm = normJson(c.toJSON() as CanvasJson, scaleRef.current);
      onChangeRef.current(norm.objects && norm.objects.length ? norm : undefined);
    };
    commitRef.current = commit;
    c.on("path:created", commit);
    c.on("object:added", commit);
    c.on("object:removed", commit);
    c.on("object:modified", commit);
    c.on("text:changed", commit);
    return () => { c.dispose(); fabRef.current = null; };
  }, []);

  // Size + (re)load on dimension/scale change. value is read from a ref so edits
  // don't trigger a reload (which would wipe in-progress work).
  useEffect(() => {
    const c = fabRef.current;
    if (!c || size.w === 0) return;
    c.setDimensions({ width: size.w, height: size.h });
    restoringRef.current = true;
    c.clear();
    const v = valueRef.current as CanvasJson | undefined;
    const finish = () => { restoringRef.current = false; c.requestRenderAll(); };
    if (v && v.objects && v.objects.length) c.loadFromJSON(denormJson(v, scale)).then(finish);
    else finish();
  }, [size.w, size.h, scale]);

  // Tool / color / width / interactivity.
  useEffect(() => {
    const c = fabRef.current;
    if (!c) return;
    c.isDrawingMode = enabled && (tool === "pen" || tool === "highlight");
    c.selection = enabled && tool === "select";
    if (tool === "pen") { const b = new fabric.PencilBrush(c); b.color = COLOR_HEX[color]; b.width = strokeWidth * scale; c.freeDrawingBrush = b; }
    else if (tool === "highlight") { const b = new fabric.PencilBrush(c); b.color = HIGHLIGHT_RGBA[color]; b.width = 16 * scale; c.freeDrawingBrush = b; }
    c.defaultCursor = c.hoverCursor = !enabled ? "default" : tool === "select" ? "default" : tool === "eraser" ? "not-allowed" : "crosshair";
    c.forEachObject((o) => { o.selectable = enabled && tool === "select"; o.evented = enabled && tool === "select"; });
    c.requestRenderAll();
  }, [tool, color, strokeWidth, scale, enabled]);

  const down = (e: React.PointerEvent) => {
    const c = fabRef.current;
    if (!c || !enabled) return;
    const t = toolRef.current;
    if (t === "select" || t === "pen" || t === "highlight") return; // Fabric handles these
    const pt = c.getScenePoint(e.nativeEvent);
    if (t === "eraser") { const target = c.getObjects().reverse().find((o) => o.containsPoint(pt)); if (target) c.remove(target); return; }
    if (t === "text") { const it = new fabric.IText("Text", { left: pt.x, top: pt.y, fontFamily: "Helvetica", fill: COLOR_HEX[colorRef.current], fontSize: 18 * scaleRef.current }); c.add(it); c.setActiveObject(it); return; }
    const hit = c.getObjects().reverse().find((o) => o.containsPoint(pt));
    if (hit) { c.setActiveObject(hit); c.requestRenderAll(); return; }
    const stroke = COLOR_HEX[colorRef.current], sw = strokeRef.current * scaleRef.current;
    if (t === "arrow") { const ln = new fabric.Line([pt.x, pt.y, pt.x, pt.y], { stroke, strokeWidth: sw, selectable: false }); draftRef.current = ln; startRef.current = { x: pt.x, y: pt.y }; c.add(ln); }
    else if (t === "rect") { const r = new fabric.Rect({ left: pt.x, top: pt.y, width: 1, height: 1, fill: "transparent", stroke, strokeWidth: sw, selectable: false }); draftRef.current = r; startRef.current = { x: pt.x, y: pt.y }; c.add(r); }
  };
  const move = (e: React.PointerEvent) => {
    const c = fabRef.current;
    if (!c || !enabled || !draftRef.current || !startRef.current) return;
    const pt = c.getScenePoint(e.nativeEvent); const s = startRef.current;
    if (toolRef.current === "arrow") (draftRef.current as fabric.Line).set({ x2: pt.x, y2: pt.y });
    else if (toolRef.current === "rect") { (draftRef.current as fabric.Rect).set({ left: Math.min(s.x, pt.x), top: Math.min(s.y, pt.y), width: Math.abs(pt.x - s.x), height: Math.abs(pt.y - s.y) }); draftRef.current.setCoords(); }
    c.requestRenderAll();
  };
  const up = () => {
    const c = fabRef.current;
    if (!c) return;
    const t = toolRef.current;
    if (t === "arrow" && draftRef.current) {
      const ln = draftRef.current as fabric.Line; const x1 = ln.x1 ?? 0, y1 = ln.y1 ?? 0, x2 = ln.x2 ?? 0, y2 = ln.y2 ?? 0;
      draftRef.current = null;
      if (Math.hypot(x2 - x1, y2 - y1) > 4) {
        ln.set({ selectable: true }); ln.setCoords();
        const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
        c.add(new fabric.Triangle({ left: x2, top: y2, originX: "center", originY: "center", width: 13 * scaleRef.current, height: 16 * scaleRef.current, fill: COLOR_HEX[colorRef.current], angle: angle + 90 }));
      } else c.remove(ln);
      commitRef.current();
    } else if (t === "rect" && draftRef.current) {
      const r = draftRef.current as fabric.Rect; draftRef.current = null;
      if ((r.width ?? 0) < 3 || (r.height ?? 0) < 3) c.remove(r); else r.set({ selectable: true });
      commitRef.current();
    }
    startRef.current = null;
  };

  return (
    <div ref={wrapRef} className="absolute inset-0" style={{ pointerEvents: enabled ? "auto" : "none" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}>
      <canvas ref={elRef} />
    </div>
  );
}

interface MultiDocViewerProps {
  docs: DocumentRecord[];
  onClose: () => void;
  currentUserId?: string;
  currentUserEmail?: string;
  orgId?: string;
  userRole?: string;
  /** The library's columns — drives the dynamic tag ribbon + tag search. */
  customColumns?: TagColumnDef[];
  /** First two VISIBLE table columns — drives each thumbnail's two-line label so
   *  it matches what the library table shows. */
  labelColumns?: { key: string; label: string }[];
  /** What this set is called in the chrome ("Reference book", "Staged"). */
  setName?: string;
  /** Open at this document instead of the first. */
  startDocId?: string;
  /** Markups kept from before (docId → page states), drawn when it opens. */
  initialMarkups?: Record<string, Record<number, object>>;
  /** Called when a document's markups change (undefined: it has none now),
   *  so they can be kept after the viewer closes. */
  onMarkupsChange?: (docId: string, pages: Record<number, object> | undefined) => void;
  /** A line to show under the chrome (e.g. the markups could not be kept). */
  note?: string | null;
  onDismissNote?: () => void;
}

export default function MultiDocViewer({ docs, onClose, currentUserId, currentUserEmail, orgId, userRole, customColumns, labelColumns, setName = "Reference book", startDocId, initialMarkups, onMarkupsChange, note, onDismissNote }: MultiDocViewerProps) {
  const router = useRouter();
  const [bookBusy, setBookBusy] = useState(false);
  const [docBusy, setDocBusy] = useState(false);
  const [downloadConfirm, setDownloadConfirm] = useState<null | { type: "download" | "print" | "book" | "book-print"; scope?: "all" | "pinned" }>(null);
  // Which export menu (download/print) is open in the toolbar, if any.
  const [exportMenu, setExportMenu] = useState<null | "download" | "print">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showBulkCheckout, setShowBulkCheckout] = useState(false);
  const [entries, setEntries] = useState<DocEntry[]>(() =>
    docs.map((doc) => ({ doc, resolvedUrl: null, loading: true, error: null }))
  );
  const startIdx = Math.max(0, startDocId ? docs.findIndex((d) => d.id === startDocId) : 0);
  const [activeIdx, setActiveIdx] = useState(startIdx);
  // Thumbnail rail — a push panel (default CLOSED for a clean full-bleed page;
  // open it with the toolbar button or B).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tagsBarOpen, setTagsBarOpen] = useState(true);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);

  // Continuous-render state.
  const [pageCounts, setPageCounts] = useState<Record<number, number>>({});
  const [mounted, setMounted] = useState<Set<number>>(() => new Set([startIdx]));
  const [zoom, setZoom] = useState(1);

  // Pages render fit-to-width from the live container size (no hard cap) so a
  // wide P&ID fills the screen; zoom multiplies on top, rotate spins 90°.
  const [containerSize, setContainerSize] = useState({ w: 1024, h: 768 });
  const [rotation, setRotation] = useState(0);

  // Chrome: auto-hiding overlay toolbar + true (browser) fullscreen.
  const [moreOpen, setMoreOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Tag search.
  const [search, setSearch] = useState("");
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [flashIdx, setFlashIdx] = useState<number | null>(null);
  // Autocomplete dropdown.
  const [showSuggest, setShowSuggest] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(-1);
  // Focus set — a temporary subset of sheets the user pins in to review.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [focusMode, setFocusMode] = useState(false);
  const [pendingScroll, setPendingScroll] = useState<{ idx: number; flash: boolean } | null>(null);
  // Markups per sheet (docId → normalized fabric page states), so annotating
  // several sheets in one session never loses work.
  const [markupStore, setMarkupStore] = useState<Record<string, Record<number, object>>>(() => initialMarkups ?? {});
  const [sendingDraft, setSendingDraft] = useState(false);
  // Inline markup: compact tools in the toolbar draw straight onto the rendered
  // page (no editor window, no PDF re-render). Markups live in memory; with
  // onMarkupsChange (staged documents) every change is handed out to be kept,
  // otherwise they are DISCARDED on close unless baked for a drafting request
  // or a download.
  const [markupMode, setMarkupMode] = useState(false);
  const [markTool, setMarkTool] = useState<MarkTool>("pen");
  const [markColor, setMarkColor] = useState<ColorKey>("red");
  const [markStroke, setMarkStroke] = useState(3);
  // Bumped per-doc to force a page's overlay to remount (used by "Clear sheet").
  const [markupVersion, setMarkupVersion] = useState<Record<string, number>>({});
  // Natural (point) width + intrinsic /Rotate per "idx:pageIndex" — normalizes
  // markup to point space and lets us honor each PDF's own page rotation.
  const [pageNat, setPageNat] = useState<Record<string, number>>({});
  const [pageRot, setPageRot] = useState<Record<string, number>>({});

  const rootRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load versions + resolve presigned URLs for all docs — in PARALLEL (this was a
  // serial loop, so a 20-sheet book waited on 20 round-trips one after another).
  // The URL resolve shares a TTL cache, so a re-open / a sheet shown elsewhere as a
  // thumbnail costs no extra request.
  useEffect(() => {
    let alive = true;
    void Promise.all(docs.map(async (doc, i) => {
      try {
        const resolvedUrl = doc.id ? await issuedFileUrl({ id: doc.id, currentVersionId: doc.currentVersionId }) : null;
        if (!alive) return;
        setEntries((prev) => { const next = [...prev]; next[i] = { doc, resolvedUrl, loading: false, error: null }; return next; });
      } catch {
        if (!alive) return;
        setEntries((prev) => { const next = [...prev]; next[i] = { ...next[i], loading: false, error: "Failed to load document" }; return next; });
      }
    }));
    return () => { alive = false; };
  }, [docs]);

  // Measure the live container so pages fit the viewport (then ×zoom).
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((obs) => {
      const r = obs[0]?.contentRect;
      if (r && r.width > 0) setContainerSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Derived render width: fit-to-width fills whatever space is left after the
  // thumbnail rail (no cap — wide P&IDs go full-bleed); zoom multiplies on top.
  const effectiveRot = ((rotation % 360) + 360) % 360;
  // SMOOTH ZOOM: react-pdf rasterizes ONCE at fit-width and the live zoom is a
  // CSS `zoom` on the page stack (synchronous layout + GPU bitmap scale, NO
  // per-tick re-rasterization — that re-raster was the "loads/jitters/breaks up"
  // jank). In markup mode we DO raster at the true displayed size so Fabric's
  // pointer coordinates line up with the page.
  const renderWidth = useMemo(() => {
    const availW = Math.max(280, containerSize.w - 24);
    return Math.max(200, Math.round(availW * (markupMode ? zoom : 1)));
  }, [containerSize, zoom, markupMode]);
  const cssZoom = markupMode ? 1 : zoom;

  // Lazy-mount each doc's <Document> as it nears the viewport — keeps a large
  // book scalable (we don't fetch+parse every PDF up front) while staying smooth.
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (obs) => {
        const toAdd: number[] = [];
        for (const e of obs) {
          if (e.isIntersecting) {
            const idx = sectionRefs.current.indexOf(e.target as HTMLDivElement);
            if (idx >= 0) toAdd.push(idx);
          }
        }
        if (toAdd.length) {
          setMounted((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const i of toAdd) if (!next.has(i)) { next.add(i); changed = true; }
            return changed ? next : prev;
          });
        }
      },
      { root, rootMargin: "1400px 0px", threshold: 0 },
    );
    sectionRefs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [entries.length]);

  // Active sheet = the one whose top has passed a line ~35% down the viewport.
  // The same rAF-throttled handler drives chrome auto-hide (hide on scroll-down,
  // reveal on scroll-up) so reading a P&ID is pure canvas.
  useEffect(() => {
    const c = scrollContainerRef.current;
    if (!c) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const mark = c.scrollTop + c.clientHeight * 0.35;
        let best = -1;
        let firstVisible = -1;
        for (let i = 0; i < sectionRefs.current.length; i++) {
          const el = sectionRefs.current[i];
          if (!el || el.offsetParent === null) continue; // skip sheets hidden by focus mode
          if (firstVisible < 0) firstVisible = i;
          if (el.offsetTop <= mark) best = i; else break;
        }
        const next = best >= 0 ? best : firstVisible;
        if (next >= 0) setActiveIdx((prev) => (prev === next ? prev : next));
      });
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    return () => { c.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [entries.length]);

  // True browser fullscreen (escapes the tab chrome — "operate like a PDF viewer").
  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) await rootRef.current?.requestFullscreen?.();
      else await document.exitFullscreen?.();
    } catch { /* fullscreen denied — ignore */ }
  }, []);
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // ── Focus set: a temporary subset of sheets to review without scrolling
  // past the rest. `picked` holds doc ids; focus mode hides everything else. ──
  const focusActive = focusMode && picked.size > 0;
  const isVisible = useCallback(
    (entryIdx: number) => !focusActive || picked.has(entries[entryIdx]?.doc.id ?? ""),
    [focusActive, picked, entries],
  );
  const visibleIdxs = useMemo(
    () => entries.map((_, i) => i).filter((i) => !focusActive || picked.has(entries[i].doc.id ?? "")),
    [entries, focusActive, picked],
  );
  const togglePick = useCallback((entryIdx: number) => {
    const id = entries[entryIdx]?.doc.id;
    if (!id) return;
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, [entries]);

  // Per-sheet searchable terms: tags + sheet#/doc#/name/rev + EVERY metadata
  // value — one clean, ranked, versatile result list (not just tags).
  const searchEntries = useMemo(() => entries.map((e, idx) => {
    const tags = collectTagGroups(e.doc.metadata as Record<string, unknown> | undefined, customColumns).flatMap((g) => g.tags);
    const meta = e.doc.metadata
      ? Object.values(e.doc.metadata).flatMap((v) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]))
      : [];
    const terms = Array.from(new Set([
      e.doc.documentNumber, e.doc.title, e.doc.name,
      e.doc.sheetNumber != null ? `Sheet ${e.doc.sheetNumber}` : null,
      e.doc.rev ? `Rev ${e.doc.rev}` : null,
      ...tags, ...meta,
    ].filter(Boolean) as string[]));
    return { idx, terms };
  }), [entries, customColumns]);

  // Rank every sheet by its best-matching term (typo-tolerant), capped + clean.
  const results = useMemo(() => {
    const q = search.trim();
    if (!q) return [] as Array<{ idx: number; score: number; matched: string }>;
    const scored: Array<{ idx: number; score: number; matched: string }> = [];
    for (const se of searchEntries) {
      const best = rankTags(q, se.terms, 1)[0];
      if (best) scored.push({ idx: se.idx, score: best.score, matched: best.tag });
    }
    scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
    return scored.slice(0, 8);
  }, [search, searchEntries]);

  // Every tag in the whole collection, grouped by its column, each pointing at
  // the first sheet that carries it — powers the "jump to a tag" dropdown.
  const collectionTags = useMemo(() => {
    const groups = new Map<string, { label: string; tags: Map<string, number> }>();
    entries.forEach((e, idx) => {
      collectTagGroups(e.doc.metadata as Record<string, unknown> | undefined, customColumns).forEach((g) => {
        let gr = groups.get(g.key);
        if (!gr) { gr = { label: g.label, tags: new Map() }; groups.set(g.key, gr); }
        g.tags.forEach((t) => { if (!gr!.tags.has(t)) gr!.tags.set(t, idx); });
      });
    });
    return Array.from(groups.values())
      .map((gr) => ({ label: gr.label, tags: Array.from(gr.tags.entries()).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })) }))
      .filter((g) => g.tags.length > 0);
  }, [entries, customColumns]);
  const totalCollectionTags = useMemo(() => collectionTags.reduce((n, g) => n + g.tags.length, 0), [collectionTags]);

  const flash = useCallback((idx: number) => {
    setFlashIdx(idx);
    setTimeout(() => setFlashIdx((f) => (f === idx ? null : f)), 1700);
  }, []);

  // Jump to a sheet. `addToFocus` brings a hidden sheet into the focus set
  // first (used by search "add"); the scroll is deferred until it's visible.
  const goToSheet = useCallback((entryIdx: number, opts?: { addToFocus?: boolean; flash?: boolean }) => {
    if (entryIdx < 0 || entryIdx >= entries.length) return;
    const id = entries[entryIdx]?.doc.id;
    setMounted((m) => (m.has(entryIdx) ? m : new Set(m).add(entryIdx)));
    if (opts?.addToFocus && id) setPicked((p) => (p.has(id) ? p : new Set(p).add(id)));
    setShowSuggest(false);
    setPendingScroll({ idx: entryIdx, flash: !!opts?.flash });
  }, [entries]);

  // Deferred scroll — runs after any focus change makes the target visible, so
  // "add to focus + jump" lands correctly.
  useEffect(() => {
    if (!pendingScroll) return;
    const { idx, flash: doFlash } = pendingScroll;
    const el = sectionRefs.current[idx];
    const c = scrollContainerRef.current;
    if (el && c && el.offsetParent !== null) {
      c.scrollTo({ top: Math.max(0, el.offsetTop - 4), behavior: "smooth" });
      setActiveIdx(idx);
      if (doFlash) flash(idx);
    }
    setPendingScroll(null);
  }, [pendingScroll, picked, focusMode, flash]);

  // Step to the next/previous VISIBLE sheet (skips ones hidden by focus mode).
  const step = useCallback((dir: number) => {
    const pos = visibleIdxs.indexOf(activeIdx);
    if (pos < 0) { if (visibleIdxs.length) goToSheet(visibleIdxs[0], { flash: false }); return; }
    const nextPos = pos + dir;
    if (nextPos >= 0 && nextPos < visibleIdxs.length) goToSheet(visibleIdxs[nextPos], { flash: false });
  }, [visibleIdxs, activeIdx, goToSheet]);

  // Enter focus mode (and land on its first sheet so the view isn't blank).
  const toggleFocus = useCallback(() => {
    if (!focusMode && picked.size > 0) {
      const first = entries.findIndex((e) => picked.has(e.doc.id ?? ""));
      if (first >= 0) setPendingScroll({ idx: first, flash: false });
    }
    setFocusMode((v) => !v);
  }, [focusMode, picked, entries]);

  // Enter: jump to the best-ranked sheet across tags + sheet#/name + all metadata.
  const runSearch = useCallback(() => {
    const q = search.trim();
    if (!q) { setSearchMsg(null); return; }
    if (results.length === 0) { setSearchMsg("No match"); return; }
    setSearchMsg(`${results.length} match${results.length === 1 ? "" : "es"}`);
    goToSheet(results[0].idx, { addToFocus: focusActive, flash: true });
  }, [search, results, goToSheet, focusActive]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") {
        if (document.fullscreenElement) return;
        // A dialog over the viewer (stamp confirm, bulk checkout) closes first,
        // then an open menu; only then the viewer.
        if (escapeStackBusy() || showBulkCheckout) return;
        if (exportMenu || tagMenuOpen || moreOpen) { setExportMenu(null); setTagMenuOpen(false); setMoreOpen(false); return; }
        onClose();
        return;
      }
      if (downloadConfirm || showBulkCheckout) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") step(1);
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") step(-1);
      if (e.key === "f" || e.key === "F") void toggleFullscreen();
      if (e.key === "b" || e.key === "B") setSidebarOpen((v) => !v);
    },
    [onClose, step, toggleFullscreen, downloadConfirm, showBulkCheckout, exportMenu, tagMenuOpen, moreOpen]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // A sheet is "marked up" once a saved page holds at least one object.
  const isMarkedUp = useCallback((docId: string | null | undefined) => {
    if (!docId) return false;
    const st = markupStore[docId];
    return !!st && Object.values(st).some((p) => ((p as { objects?: unknown[] }).objects?.length ?? 0) > 0);
  }, [markupStore]);
  const markedUpIds = useMemo(
    () => entries.map((e) => e.doc.id).filter((id): id is string => isMarkedUp(id)),
    [entries, isMarkedUp],
  );

  // Store/clear a single page's markup (normalized point-space JSON). Empty →
  // drop the page (and the doc entry if it has no pages left).
  const setPageMarkup = useCallback((docId: string, pageNum: number, json: object | undefined) => {
    setMarkupStore((prev) => {
      const docMap = { ...(prev[docId] ?? {}) };
      if (json) docMap[pageNum] = json; else delete docMap[pageNum];
      const next = { ...prev };
      if (Object.keys(docMap).length) next[docId] = docMap; else delete next[docId];
      return next;
    });
  }, []);

  // Wipe the active sheet's markup and remount its overlays so they redraw blank.
  const clearActiveMarkup = useCallback((docId: string | null | undefined) => {
    if (!docId) return;
    setMarkupStore((prev) => { const next = { ...prev }; delete next[docId]; return next; });
    setMarkupVersion((v) => ({ ...v, [docId]: (v[docId] ?? 0) + 1 }));
  }, []);

  // Hand each changed sheet's markups out to be kept (staged documents), so
  // they are still there after the viewer closes. Only sheets whose markups
  // changed are reported; what came in is not reported back.
  const onMarkupsChangeRef = useRef(onMarkupsChange);
  useEffect(() => { onMarkupsChangeRef.current = onMarkupsChange; });
  const reportedMarks = useRef(markupStore);
  useEffect(() => {
    const prev = reportedMarks.current;
    reportedMarks.current = markupStore;
    const report = onMarkupsChangeRef.current;
    if (!report || prev === markupStore) return;
    for (const id of new Set([...Object.keys(prev), ...Object.keys(markupStore)])) {
      if (prev[id] !== markupStore[id]) report(id, markupStore[id]);
    }
  }, [markupStore]);

  // Opened at a sheet further down: go there once every sheet's file is
  // known, and keep it there while the sheets above it load and change
  // height, until the person moves the page themselves (or 5 seconds pass).
  const startedAt = useRef(startIdx === 0);
  const stopHolding = useRef<() => void>(() => {});
  useEffect(() => {
    if (startedAt.current || entries.some((e) => e.loading)) return;
    startedAt.current = true;
    const el = sectionRefs.current[startIdx], c = scrollContainerRef.current;
    if (!el || !c) return;
    const align = () => { c.scrollTop = Math.max(0, el.offsetTop - 4); };
    align();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(align) : null;
    sectionRefs.current.slice(0, startIdx).forEach((s) => s && ro?.observe(s));
    const moved = () => stopHolding.current();
    const timer = window.setTimeout(moved, 5000);
    c.addEventListener("wheel", moved, { passive: true });
    c.addEventListener("touchstart", moved, { passive: true });
    c.addEventListener("pointerdown", moved);
    window.addEventListener("keydown", moved);
    stopHolding.current = () => {
      ro?.disconnect();
      window.clearTimeout(timer);
      c.removeEventListener("wheel", moved);
      c.removeEventListener("touchstart", moved);
      c.removeEventListener("pointerdown", moved);
      window.removeEventListener("keydown", moved);
      stopHolding.current = () => {};
    };
  }, [entries, startIdx]);
  useEffect(() => () => stopHolding.current(), []);

  const activeEntry = entries[activeIdx];
  const activeControlState = activeEntry?.doc && currentUserId ? determineControlState(activeEntry.doc, currentUserId) : "uncontrolled";
  const activeControlled = activeControlState === "controlled";
  // The on-screen badge reflects the live master/revision status — NOT the
  // copy-control state (which still governs download/print stamping).
  const viewBadge = activeEntry?.doc ? viewerStatusBadge(activeEntry.doc) : null;
  const activeTagGroups = activeEntry?.doc ? collectTagGroups(activeEntry.doc.metadata as Record<string, unknown> | undefined, customColumns) : [];

  // Single-document download / print for the currently focused doc. If the sheet
  // has markups, they're baked into the PDF first (download/print keep markups —
  // everything else discards them on close).
  const runDocAction = async (type: "download" | "print") => {
    if (!activeEntry?.resolvedUrl || !currentUserId) return;
    setDocBusy(true);
    setActionError(null);
    let bakedUrl: string | null = null;
    try {
      let fileUrl = activeEntry.resolvedUrl;
      const marks = markupStore[activeEntry.doc.id ?? ""];
      if (marks && Object.keys(marks).length) {
        const res = await fetch(activeEntry.resolvedUrl);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const baked = await bakeMarkupIntoPdf(bytes, marks);
        bakedUrl = URL.createObjectURL(new Blob([baked as BlobPart], { type: "application/pdf" }));
        fileUrl = bakedUrl;
      }
      const ctx = { doc: activeEntry.doc, fileUrl, userId: currentUserId, userEmail: currentUserEmail ?? null, userLabel: currentUserEmail ?? null, versionId: activeEntry.doc.currentVersionId ?? undefined };
      if (type === "download") await downloadDocumentPdf(ctx);
      else await printDocumentPdf(ctx);
      setDownloadConfirm(null);
    } catch (e) {
      setActionError((e as Error).message || "Action failed");
    } finally {
      if (bakedUrl) URL.revokeObjectURL(bakedUrl);
      setDocBusy(false);
    }
  };

  // Sheets a merged-book action can operate on. We expose BOTH the pinned subset
  // and the whole collection so the Print/Download menus offer explicit choices
  // ("Pinned (3)" vs "All (12)") — never a silent guess. Only resolved PDFs count.
  const bookReadyEntries = entries.filter((e) => e.resolvedUrl);
  const pinnedReadyEntries = bookReadyEntries.filter((e) => picked.has(e.doc.id ?? ""));
  const entriesForScope = (s: "all" | "pinned") => (s === "pinned" ? pinnedReadyEntries : bookReadyEntries);

  // Merge a scope of resolved PDFs into ONE stamped (uncontrolled) PDF and log
  // every included document to the audit trail. Shared by download + print.
  const assembleStampedBook = async (scope: typeof entries): Promise<Blob | null> => {
    if (!currentUserId || scope.length === 0) return null;
    const merged = await PDFDocument.create();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 3600 * 1000);
    for (const entry of scope) {
      try {
        const stamped = await stampPdf(entry.resolvedUrl!, {
          userLabel: currentUserEmail ?? undefined,
          email: currentUserEmail ?? undefined,
          timestamp: now,
          expiresAt,
          watermarkText: `UNCONTROLLED - ${entry.doc.documentNumber || "DOC"} Rev ${entry.doc.rev || "-"}`,
          footerNotice: `${entry.doc.documentNumber || entry.doc.title || "Document"} Rev ${entry.doc.rev ?? "?"} at time of issue - verify current revision before use.`,
          verifyUrl: entry.doc.id && entry.doc.currentVersionId && publicOrigin()
            ? `${publicOrigin()}/verify/${entry.doc.id}?v=${entry.doc.currentVersionId}`
            : undefined,
        });
        const buf = await stamped.arrayBuffer();
        const src = await PDFDocument.load(buf);
        const copied = await merged.copyPages(src, src.getPageIndices());
        copied.forEach((p) => merged.addPage(p));
      } catch (e) {
        console.error("Failed to add doc to book", entry.doc.documentNumber, e);
      }
    }
    const bytes = await merged.save();
    const rows = scope.map((e) => ({
      org_id: e.doc.orgId ?? null,
      document_id: e.doc.id ?? null,
      version_id: e.doc.currentVersionId ?? null,
      user_id: currentUserId,
      user_email: currentUserEmail ?? null,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      watermark_policy_id: null,
    }));
    try { await supabase.from("download_audits").insert(rows); } catch (e) { console.error(e); }
    // Same ambient trail as a single-doc pull: each included sheet leaves a
    // reference intent so the stale-copy radar sees book pulls too.
    for (const e of scope) {
      if (!e.doc.id || !e.doc.orgId) continue;
      void recordIntent({
        orgId: e.doc.orgId,
        documentId: e.doc.id,
        libraryId: e.doc.libraryId ?? null,
        userId: currentUserId,
        userName: currentUserEmail?.split("@")[0] ?? null,
        kind: "reference",
        source: "download",
        baseVersionId: e.doc.currentVersionId ?? null,
      });
    }
    return new Blob([bytes as BlobPart], { type: "application/pdf" });
  };

  const downloadBookMerged = async (scope: typeof entries) => {
    if (!currentUserId || scope.length === 0) return;
    setBookBusy(true);
    setActionError(null);
    try {
      const blob = await assembleStampedBook(scope);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Reference_Book_${scope.length}_docs_UNCONTROLLED.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setDownloadConfirm(null);
    } catch (e) {
      setActionError((e as Error).message || "Book download failed");
    } finally {
      setBookBusy(false);
    }
  };

  // Print the merged book: open the stamped PDF in a new tab and invoke the
  // browser print dialog (mirrors the single-sheet print path).
  const printBookMerged = async (scope: typeof entries) => {
    if (!currentUserId || scope.length === 0) return;
    setBookBusy(true);
    setActionError(null);
    try {
      const blob = await assembleStampedBook(scope);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (!w) {
        // Stamping a big book can outlast the click's transient activation, so
        // the print tab may be pop-up blocked. Keep the dialog open and say so.
        setActionError("Your browser blocked the print tab. Allow pop-ups for this site, or use Download instead.");
        return;
      }
      w.addEventListener("load", () => setTimeout(() => w.print(), 250));
      setDownloadConfirm(null);
    } catch (e) {
      setActionError((e as Error).message || "Book print failed");
    } finally {
      setBookBusy(false);
    }
  };

  const requestDocDownload = () => {
    if (!activeEntry?.resolvedUrl || !currentUserId) return;
    if (activeControlled) void runDocAction("download");
    else setDownloadConfirm({ type: "download" });
  };
  const requestDocPrint = () => {
    if (!activeEntry?.resolvedUrl || !currentUserId) return;
    if (activeControlled) void runDocAction("print");
    else setDownloadConfirm({ type: "print" });
  };
  const requestBookDownload = (scope: "all" | "pinned") => setDownloadConfirm({ type: "book", scope });
  const requestBookPrint = (scope: "all" | "pinned") => setDownloadConfirm({ type: "book-print", scope });

  // Bake every marked-up sheet's annotations into its PDF and open a NEW
  // drafting request with all of them attached (lib/sendToDrafting, shared
  // with the Staged page), so you can mark up a few sheets and send them
  // together, markups included.
  const sendMarkupsToDrafting = async () => {
    if (markedUpIds.length === 0 || sendingDraft) return;
    setSendingDraft(true);
    try {
      const sheets = markedUpIds
        .map((id) => entries.find((e) => e.doc.id === id))
        .filter((e): e is DocEntry => !!e?.resolvedUrl)
        .map((e) => ({ doc: e.doc, url: e.resolvedUrl, markups: markupStore[e.doc.id ?? ""] }));
      const { href } = await prepareDraftingRequest(sheets);
      if (!href) {
        setSendingDraft(false);
        await appAlert("Couldn't prepare any marked-up sheets.");
        return;
      }
      router.push(href);
    } catch (e) {
      console.error("Send markups to drafting failed", e);
      setSendingDraft(false);
      await appAlert(`Couldn't prepare markups: ${(e as Error).message || "unknown error"}`);
    }
  };

  const MENU_BOX = "absolute top-full right-0 mt-1 z-50 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl shadow-black/50 py-1.5";
  const MENU_HEAD = "px-3 pt-1 pb-1 text-[13px] font-semibold text-[var(--color-text-muted)]";
  const MENU_ITEM = "w-full px-3 min-h-10 text-left text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-ink-2)] flex items-center gap-2.5 disabled:opacity-40 disabled:pointer-events-none";
  const MENU_ICON = "w-4 h-4 shrink-0 text-[var(--color-text-muted)]";

  // Ctrl+wheel zoom + grab-hand pan (disabled while marking up so the canvas owns
  // the pointer).
  const panZoom = useViewerPanZoom({
    containerRef: scrollContainerRef,
    onZoom: (f) => setZoom((z) => Math.min(3, Math.max(0.4, Math.round(z * f * 100) / 100))),
    enabled: !markupMode,
  });

  // Which sheet is open, said big: its number (or name), with where it sits in
  // the book and its state on the line above.
  const posInBook = Math.max(1, visibleIdxs.indexOf(activeIdx) + 1);
  const activeName = activeEntry?.doc.documentNumber || activeEntry?.doc.title || activeEntry?.doc.name || setName;
  const statusWord = viewBadge ? viewBadge.label.replace(/\s·\sRev\s.*$/, "") : null;
  const isBook = downloadConfirm?.type === "book" || downloadConfirm?.type === "book-print";
  const closeConfirm = () => { setDownloadConfirm(null); setActionError(null); };

  return (
    <div className="fixed inset-0 z-[85]" role="dialog" aria-modal="true" aria-label={`${setName}, ${docs.length} sheet${docs.length === 1 ? "" : "s"}`}>
      {/* The page behind stays in view at the edges, dimmed. */}
      <div className={vDim} aria-hidden="true" />

      {/* Full screen (F) takes this panel to the whole screen. */}
      <div ref={rootRef} className={vPanel}>
      <div className="flex-1 min-h-0 flex">
      {/* ── THUMBNAIL RAIL (push panel; never overlaps the page) ── */}
      <div className={`${sidebarOpen ? "w-52" : "w-0"} shrink-0 border-r border-[var(--color-border)] overflow-hidden transition-[width] duration-200 flex flex-col`} aria-hidden={!sidebarOpen}>
        <div className="px-3 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 shrink-0">
          <BookOpen className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
          <span className="text-[13px] font-bold text-[var(--color-text)] truncate">{badgeText(docs.length)} sheet{docs.length === 1 ? "" : "s"}</span>
          <button type="button" onClick={() => setSidebarOpen(false)} className="ml-auto w-8 h-8 shrink-0 rounded-lg grid place-items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]" title="Hide the sheets (B)" aria-label="Hide the sheets"><PanelLeftClose className="w-4 h-4" /></button>
        </div>
        {/* Focus controls — review just the sheets you pin. */}
        <div className="px-3 py-2 flex items-center gap-2 shrink-0 border-b border-[var(--color-border)]">
          <button
            type="button"
            onClick={toggleFocus}
            disabled={picked.size === 0}
            title={picked.size === 0 ? "Pin sheets below, then focus on just those" : focusActive ? "Show all sheets" : "Show only your pinned sheets"}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 h-8 px-2 rounded-lg text-[13px] font-bold transition-colors disabled:opacity-40 ${focusActive ? "bg-[var(--color-ink-fg)] text-[var(--color-ink)]" : "bg-[var(--color-ink-2)] text-[var(--color-text)] hover:bg-[var(--color-ink-line)]"}`}
            aria-pressed={focusActive}
          >
            <Layers className="w-3.5 h-3.5" /> {focusActive ? "Focused" : "Focus"}{picked.size > 0 ? ` (${picked.size})` : ""}
          </button>
          {picked.size > 0 && (
            <button type="button" onClick={() => { setPicked(new Set()); setFocusMode(false); }} title="Clear the pinned set" className="h-8 px-2 rounded-lg text-[13px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]">Clear</button>
          )}
        </div>
        {/* Thumbnails — the one and only nav, labelled with the first two visible
            table columns. */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-2">
          {entries.map((entry, idx) => {
            const id = entry.doc.id ?? "";
            const isPicked = picked.has(id);
            const lines = (labelColumns && labelColumns.length ? labelColumns : [{ key: "documentNumber", label: "" }, { key: "title", label: "" }])
              .slice(0, 2).map((c) => cellText(entry.doc, c.key)).filter(Boolean);
            return (
              <div key={id} className={`relative group rounded-lg overflow-hidden border-2 transition-colors ${activeIdx === idx ? "border-[var(--color-ink-fg)]" : "border-[var(--color-border)] hover:border-[var(--color-ink-line)]"} ${focusActive && !isPicked ? "opacity-40" : ""}`}>
                <button type="button" onClick={() => goToSheet(idx, { flash: true, addToFocus: !isVisible(idx) })} className="block w-full text-left" title={lines.join(" · ")} aria-current={activeIdx === idx ? "page" : undefined}>
                  <PageThumb url={entry.resolvedUrl} />
                  <div className="px-2 py-1.5 bg-[var(--color-ink)] flex items-baseline gap-2">
                    <span className="shrink-0 text-[13px] font-bold text-[var(--color-text-muted)]">{idx + 1}</span>
                    <span className="flex-1 min-w-0 text-[13px] font-bold text-[var(--color-text)] truncate">{lines[0] || `Sheet ${idx + 1}`}</span>
                    {lines[1] && <span className="shrink-0 text-[13px] font-semibold text-[var(--color-text-muted)]">{lines[1]}</span>}
                  </div>
                </button>
                <button type="button" onClick={() => togglePick(idx)} title={isPicked ? "Remove from focus set" : "Pin to focus set"} className={`absolute top-1 right-1 w-7 h-7 grid place-items-center rounded-md transition-opacity bg-[color-mix(in_srgb,var(--color-ink)_75%,transparent)] ${isPicked ? "text-[var(--color-ink-fg)]" : "text-[var(--color-text-muted)] opacity-60 sm:opacity-0 group-hover:opacity-100"}`} aria-pressed={isPicked} aria-label={isPicked ? "Remove from focus set" : "Pin to focus set"}>
                  <Pin className={`w-3.5 h-3.5 ${isPicked ? "fill-current" : ""}`} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── MAIN: the chrome, then the pages ── */}
      <div className="relative flex-1 min-w-0 flex flex-col">
        {/* ─── TOP CHROME ───────────────────────────────────────────────
            Row one: which sheet, big; the one orange action (when there are
            markups to send) and the X. Row two: getting around the book.
            Wraps on phones so every control stays reachable. */}
        <header className="relative z-[60] shrink-0 border-b border-[var(--color-border)] px-3 sm:px-5 pt-2.5 pb-2 space-y-2">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setSidebarOpen((v) => !v)} className={vTool(sidebarOpen, "w-9 h-9")} title="Sheets in this book (B)" aria-label="Sheets in this book" aria-pressed={sidebarOpen}><Menu className="w-4 h-4" /></button>
            <div className="min-w-0 flex-1">
              <div className={vKicker}>
                <span className="max-sm:hidden">{setName} · </span>Sheet {posInBook} of {visibleIdxs.length}
                {activeEntry?.doc.rev ? <> · Rev {activeEntry.doc.rev}</> : null}
                {viewBadge && statusWord && (
                  <> · <span className={STATUS_TONE[viewBadge.tone]} title="Status of the live version you're viewing. A copy you download or print is stamped separately.">{statusWord}</span></>
                )}
              </div>
              <h2 className={vTitle} title={activeEntry?.doc.title || activeName}>{activeName}</h2>
            </div>
            {markedUpIds.length > 0 && (
              <button type="button" onClick={() => void sendMarkupsToDrafting()} disabled={sendingDraft} title="Send all marked-up sheets (with your markups in them) to one new drafting request" className={vPrimary} aria-label={`Send markups (${markedUpIds.length})`}>
                {sendingDraft ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                <span className="max-sm:hidden">Send markups</span> ({markedUpIds.length})
              </button>
            )}
            <button type="button" aria-label="Close" onClick={onClose} className={vClose} title="Close (Esc)">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          {/* Sheets: left / up goes back a sheet (the arrow keys too) */}
          <div className={vGroup}>
            <button type="button" onClick={() => step(-1)} disabled={visibleIdxs.indexOf(activeIdx) <= 0} className={vIcon} title="Previous sheet (Left arrow)" aria-label="Previous sheet"><ChevronLeft className="w-4 h-4" /></button>
            <span className="px-1 min-w-[3rem] text-center" aria-live="polite">{posInBook} / {visibleIdxs.length}</span>
            <button type="button" onClick={() => step(1)} disabled={visibleIdxs.indexOf(activeIdx) >= visibleIdxs.length - 1} className={vIcon} title="Next sheet (Right arrow)" aria-label="Next sheet"><ChevronRight className="w-4 h-4" /></button>
          </div>

          {/* Find a sheet: tag, number, name or anything on it */}
          <div className="relative min-w-0 flex-1 basis-[200px] max-w-md">
            <div className="flex items-center gap-1.5 h-9 rounded-[10px] bg-[var(--color-ink-2)] border border-[var(--color-ink-line)] px-2.5 transition-colors focus-within:border-[var(--color-ink-fg)]">
              <Search className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
              <input
                ref={searchInputRef}
                value={search}
                onChange={(e) => { setSearch(e.target.value); setSearchMsg(null); setShowSuggest(true); setSuggestIdx(-1); }}
                onFocus={() => { if (search) setShowSuggest(true); }}
                onBlur={() => setTimeout(() => setShowSuggest(false), 120)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); if (results.length) { setShowSuggest(true); setSuggestIdx((i) => Math.min(results.length - 1, i + 1)); } }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setSuggestIdx((i) => Math.max(-1, i - 1)); }
                  else if (e.key === "Enter") {
                    e.preventDefault();
                    if (showSuggest && suggestIdx >= 0 && results[suggestIdx]) goToSheet(results[suggestIdx].idx, { addToFocus: focusActive, flash: true });
                    else runSearch();
                  } else if (e.key === "Escape") {
                    setShowSuggest(false);
                  }
                }}
                placeholder="Find a sheet, tag, #…"
                aria-label="Find a sheet by tag, number, name or anything on it"
                className="bg-transparent text-[13px] font-medium text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none w-full min-w-0"
                title="Search anything: equipment tag, sheet #, document name or any metadata. Typo-tolerant (P-34 = p34). Enter jumps; + pins a sheet to your focus set."
              />
              {searchMsg && <span className={`text-[13px] font-bold shrink-0 ${searchMsg === "No match" ? "text-rose-400" : "text-[var(--color-text-muted)]"}`}>{searchMsg}</span>}
              {search ? (
                <button type="button" onMouseDown={(e) => { e.preventDefault(); setSearch(""); setSearchMsg(null); setShowSuggest(false); searchInputRef.current?.focus(); }} title="Clear" aria-label="Clear the search" className="shrink-0 w-6 h-6 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-3.5 h-3.5" /></button>
              ) : (
                <kbd className="hidden lg:inline shrink-0 text-[11px] font-bold text-[var(--color-text-muted)] border border-[var(--color-ink-line)] rounded px-1 py-px">↵</kbd>
              )}
            </div>

            {showSuggest && results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl shadow-black/50 overflow-hidden py-1 max-h-80 overflow-y-auto" role="listbox" aria-label="Matching sheets">
                {results.map((r, i) => {
                  const e = entries[r.idx];
                  const id = e?.doc.id ?? "";
                  const isPicked = picked.has(id);
                  return (
                    <div key={r.idx} onMouseEnter={() => setSuggestIdx(i)} className={`flex items-stretch transition-colors ${i === suggestIdx ? "bg-[var(--color-ink-line)]" : "hover:bg-[var(--color-ink-2)]"}`}>
                      <button
                        type="button"
                        onMouseDown={(ev) => { ev.preventDefault(); goToSheet(r.idx, { addToFocus: focusActive, flash: true }); }}
                        className="flex-1 min-w-0 text-left px-3 py-1.5"
                      >
                        <div className="flex items-center gap-2 text-[13px]">
                          <span className="font-bold text-[var(--color-text)] truncate">{e?.doc.documentNumber || `Sheet ${r.idx + 1}`}</span>
                          <span className="text-[13px] text-[var(--color-text-muted)] truncate">{e?.doc.title || e?.doc.name}</span>
                        </div>
                        <div className="text-[13px] text-[var(--color-text-muted)] truncate">matched “{r.matched}”</div>
                      </button>
                      <button
                        type="button"
                        onMouseDown={(ev) => { ev.preventDefault(); togglePick(r.idx); }}
                        title={isPicked ? "Remove from focus set" : "Add this sheet to your focus set"}
                        aria-label={isPicked ? "Remove from focus set" : "Add this sheet to your focus set"}
                        className={`shrink-0 px-2.5 flex items-center border-l border-[var(--color-border)] transition-colors ${isPicked ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
                      >
                        {isPicked ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Zoom / fit-width / rotate / pan */}
          <div className={`${vGroup} max-md:hidden`}>
            <button type="button" onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100))} className={vIcon} title="Zoom out" aria-label="Zoom out"><ZoomOut className="w-4 h-4" /></button>
            <button type="button" onClick={() => setZoom(1)} className="h-9 px-1 min-w-[2.75rem] text-center rounded-[10px] hover:bg-[var(--color-ink-2)]" title="Fit to width: reset zoom to 100%">{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.15) * 100) / 100))} className={vIcon} title="Zoom in (or Ctrl + scroll)" aria-label="Zoom in"><ZoomIn className="w-4 h-4" /></button>
            <div className="w-px h-5 bg-[var(--color-ink-line)] mx-0.5" aria-hidden="true" />
            <button type="button" onClick={() => setRotation((r) => r + 90)} className={vIcon} title="Rotate 90°" aria-label="Rotate 90 degrees"><RotateCw className="w-4 h-4" /></button>
            {!markupMode && (
              <button type="button" onClick={() => panZoom.setPanMode((v) => !v)} className={vTool(panZoom.panMode, "w-9 h-9")} aria-pressed={panZoom.panMode} aria-label="Pan tool" title={panZoom.panMode ? "Pan tool (drag to move the page) - click for the normal cursor" : "Cursor - click to switch back to the pan/grab hand"}>
                {panZoom.panMode ? <Hand className="w-4 h-4" /> : <MousePointer2 className="w-4 h-4" />}
              </button>
            )}
          </div>

          {/* All-tags jump dropdown — every tag in the book, click to scroll there. */}
          {totalCollectionTags > 0 && (
            <div className="relative shrink-0">
              <button type="button" onClick={() => setTagMenuOpen((v) => !v)} title="Jump to any tag in this book" aria-expanded={tagMenuOpen} className={`${vQuiet} ${tagMenuOpen ? "bg-[var(--color-ink-line)]" : ""}`}>
                <Tags className="w-4 h-4" /> <span className="hidden lg:inline">Tags</span> <ChevronDown className="w-3.5 h-3.5" />
              </button>
              {tagMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setTagMenuOpen(false)} />
                  <div className={`${MENU_BOX} w-64 max-h-[70vh] overflow-y-auto custom-scrollbar max-sm:right-auto max-sm:left-0`}>
                    {collectionTags.map((g) => (
                      <div key={g.label}>
                        <div className={MENU_HEAD}>{g.label}</div>
                        <div className="flex flex-wrap gap-1 px-2 pb-2">
                          {g.tags.map(([t, idx]) => (
                            <button type="button" key={t} onClick={() => { setTagMenuOpen(false); goToSheet(idx, { flash: true }); }} title={`Sheet ${idx + 1}`} className="inline-flex items-center h-7 px-2 rounded-md bg-[var(--color-ink-2)] hover:bg-[var(--color-ink-line)] text-[13px] font-bold text-[var(--color-text)] transition-colors">
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Markup toggle — reveals the compact tools. A white pill while on. */}
          <button type="button" onClick={() => setMarkupMode((v) => !v)} aria-label="Markup" aria-pressed={markupMode}
            title={onMarkupsChange
              ? "Markup: draw on the page. Kept on this device until you clear it."
              : "Markup: draw on the page. Discarded on close unless you download the sheet or send it to drafting."}
            className={`inline-flex items-center justify-center gap-1.5 h-9 px-3 shrink-0 rounded-[10px] text-[13px] font-semibold transition-colors ${markupMode ? "bg-[var(--color-ink-fg)] text-[var(--color-ink)]" : "bg-[var(--color-ink-2)] text-[var(--color-text)] hover:bg-[var(--color-ink-line)]"}`}>
            <Pen className="w-4 h-4" /> <span className="hidden lg:inline">Markup</span>
          </button>

          {/* Focus toggle */}
          {picked.size > 0 && (
            <button type="button" onClick={toggleFocus} title={focusActive ? "Show all sheets" : "Show only your pinned sheets"} aria-pressed={focusActive}
              className={`inline-flex items-center justify-center gap-1.5 h-9 px-3 shrink-0 rounded-[10px] text-[13px] font-semibold transition-colors ${focusActive ? "bg-[var(--color-ink-fg)] text-[var(--color-ink)]" : "bg-[var(--color-ink-2)] text-[var(--color-text)] hover:bg-[var(--color-ink-line)]"}`}>
              <Layers className="w-4 h-4" /> {focusActive ? "Focused" : "Focus"} {picked.size}
            </button>
          )}

          <div className="flex-1 max-lg:hidden" />

          {/* ── DOWNLOAD (uncontrolled) — this sheet / pinned / whole book ── */}
          <div className="relative shrink-0">
            <button type="button" onClick={() => setExportMenu((m) => (m === "download" ? null : "download"))} title="Download an uncontrolled (stamped) copy" aria-expanded={exportMenu === "download"} aria-label="Download" className={`${vQuiet} ${exportMenu === "download" ? "bg-[var(--color-ink-line)]" : ""}`}>
              {bookBusy || docBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} <span className="hidden lg:inline">Download</span> <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {exportMenu === "download" && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportMenu(null)} />
                <div className={`${MENU_BOX} w-64`} role="menu">
                  <div className={MENU_HEAD}>Download as PDF</div>
                  <button type="button" role="menuitem" onClick={() => { setExportMenu(null); requestDocDownload(); }} disabled={!activeEntry?.resolvedUrl || !currentUserId || docBusy} title="The sheet you're viewing. Stamped UNCONTROLLED unless you hold its checkout." className={MENU_ITEM}><FileText className={MENU_ICON} /> This sheet</button>
                  <button type="button" role="menuitem" onClick={() => { setExportMenu(null); requestBookDownload("pinned"); }} disabled={bookBusy || !currentUserId || pinnedReadyEntries.length === 0} title="Merge your pinned sheets into one stamped, uncontrolled PDF" className={MENU_ITEM}><Pin className={MENU_ICON} /> Pinned sheets ({pinnedReadyEntries.length}) <span className="ml-auto text-[11px] text-[var(--color-text-muted)] font-bold">UNCONTROLLED</span></button>
                  <button type="button" role="menuitem" onClick={() => { setExportMenu(null); requestBookDownload("all"); }} disabled={bookBusy || !currentUserId || bookReadyEntries.length === 0} title="Merge the whole collection into one stamped, uncontrolled PDF" className={MENU_ITEM}><Library className={MENU_ICON} /> Whole book ({bookReadyEntries.length}) <span className="ml-auto text-[11px] text-[var(--color-text-muted)] font-bold">UNCONTROLLED</span></button>
                </div>
              </>
            )}
          </div>

          {/* ── PRINT (uncontrolled) — this sheet / pinned / whole book ── */}
          <div className="relative shrink-0">
            <button type="button" onClick={() => setExportMenu((m) => (m === "print" ? null : "print"))} title="Print an uncontrolled (stamped) copy" aria-expanded={exportMenu === "print"} aria-label="Print" className={`${vQuiet} ${exportMenu === "print" ? "bg-[var(--color-ink-line)]" : ""}`}>
              {bookBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />} <span className="hidden lg:inline">Print</span> <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {exportMenu === "print" && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportMenu(null)} />
                <div className={`${MENU_BOX} w-64 max-sm:-right-12`} role="menu">
                  <div className={MENU_HEAD}>Send to printer</div>
                  <button type="button" role="menuitem" onClick={() => { setExportMenu(null); requestDocPrint(); }} disabled={!activeEntry?.resolvedUrl || !currentUserId || docBusy} title="The sheet you're viewing. Stamped UNCONTROLLED unless you hold its checkout." className={MENU_ITEM}><FileText className={MENU_ICON} /> This sheet</button>
                  <button type="button" role="menuitem" onClick={() => { setExportMenu(null); requestBookPrint("pinned"); }} disabled={bookBusy || !currentUserId || pinnedReadyEntries.length === 0} title="Merge your pinned sheets into one stamped, uncontrolled PDF and print" className={MENU_ITEM}><Pin className={MENU_ICON} /> Pinned sheets ({pinnedReadyEntries.length}) <span className="ml-auto text-[11px] text-[var(--color-text-muted)] font-bold">UNCONTROLLED</span></button>
                  <button type="button" role="menuitem" onClick={() => { setExportMenu(null); requestBookPrint("all"); }} disabled={bookBusy || !currentUserId || bookReadyEntries.length === 0} title="Merge the whole collection into one stamped, uncontrolled PDF and print" className={MENU_ITEM}><Library className={MENU_ICON} /> Whole book ({bookReadyEntries.length}) <span className="ml-auto text-[11px] text-[var(--color-text-muted)] font-bold">UNCONTROLLED</span></button>
                </div>
              </>
            )}
          </div>

          {/* More: the rare bulk action. */}
          <div className="relative shrink-0">
            <button type="button" onClick={() => setMoreOpen((v) => !v)} className={`${vQuiet} ${moreOpen ? "bg-[var(--color-ink-line)]" : ""}`} title="More" aria-label="More" aria-expanded={moreOpen}><MoreHorizontal className="w-4 h-4" /></button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
                <div className={`${MENU_BOX} w-56`} role="menu">
                  <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setShowBulkCheckout(true); }} disabled={!currentUserId || docs.length === 0} className={MENU_ITEM}><Briefcase className={MENU_ICON} /> Check out all to a project</button>
                </div>
              </>
            )}
          </div>

          <button type="button" onClick={() => void toggleFullscreen()} className={vIcon} title={isFullscreen ? "Exit full screen (F)" : "Full screen (F)"} aria-label={isFullscreen ? "Exit full screen" : "Full screen"}>
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          </div>
        </header>

        {note && (
          <p role="alert" className={`${vNote} text-amber-300`}>
            <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
            <span className="min-w-0">{note}</span>
            {onDismissNote && (
              <button type="button" onClick={onDismissNote} aria-label="Dismiss" className="ml-auto shrink-0 w-7 h-7 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]"><X className="w-3.5 h-3.5" /></button>
            )}
          </p>
        )}

        {actionError && !downloadConfirm && (
          <p role="alert" className={`${vNote} text-rose-300`}>
            <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
            <span className="min-w-0">{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss" className="ml-auto shrink-0 w-7 h-7 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]"><X className="w-3.5 h-3.5" /></button>
          </p>
        )}

        <div className="relative flex-1 min-h-0">
        {/* ── FULL-BLEED PAGE STACK ── */}
        <div ref={scrollContainerRef} className={`absolute inset-0 overflow-auto bg-[var(--color-surface)] ${panZoom.cursorClass}`} style={{ touchAction: "pan-x pan-y" }} {...panZoom.panHandlers}>
        {entries.map((entry, idx) => (
          <div key={entry.doc.id} ref={(el) => { sectionRefs.current[idx] = el; }} style={{ display: isVisible(idx) ? undefined : "none" }} className={`flex flex-col ${flashIdx === idx ? "ring-4 ring-[color-mix(in_srgb,var(--color-ink-fg)_60%,transparent)] ring-inset" : ""}`}>
            {/* Slim per-sheet line — keeps the sheet's name and Focus
                reachable without eating the page. Sticks to the top. */}
            <div className="sticky top-0 z-10 bg-[color-mix(in_srgb,var(--color-ink)_88%,transparent)] backdrop-blur-sm border-b border-[var(--color-border)] px-4 py-1.5 flex items-center gap-3">
              <div className="w-5 h-5 rounded-full bg-[var(--color-ink-2)] flex items-center justify-center text-[11px] font-bold text-[var(--color-text)] shrink-0">{idx + 1}</div>
              <span className="text-[13px] font-bold text-[var(--color-text)] shrink-0">{entry.doc.documentNumber || "-"}</span>
              <span className="text-[13px] text-[var(--color-text-muted)] font-medium truncate">{entry.doc.title || entry.doc.name}</span>
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <span className="text-[13px] text-[var(--color-text-muted)] hidden sm:inline">Rev {entry.doc.rev || "-"}</span>
                <span className="text-[13px] text-[var(--color-text-muted)] hidden md:inline">· {entry.doc.status || "-"}</span>
                {isMarkedUp(entry.doc.id) && (
                  <span className="text-[12px] font-bold text-[var(--color-text)] inline-flex items-center gap-1"><Pen className="w-3 h-3" /> Marked up</span>
                )}
                <button
                  type="button"
                  onClick={() => togglePick(idx)}
                  title={picked.has(entry.doc.id ?? "") ? "Remove from focus set" : "Add to focus set - review just the sheets you need"}
                  className={`text-[13px] font-bold inline-flex items-center gap-1 h-7 px-2 rounded-md transition-colors ${picked.has(entry.doc.id ?? "") ? "bg-[var(--color-ink-fg)] text-[var(--color-ink)]" : "bg-[var(--color-ink-2)] text-[var(--color-text)] hover:bg-[var(--color-ink-line)]"}`}
                  aria-pressed={picked.has(entry.doc.id ?? "")}
                >
                  <Pin className={`w-3 h-3 ${picked.has(entry.doc.id ?? "") ? "fill-current" : ""}`} /> {picked.has(entry.doc.id ?? "") ? "Focused" : "Focus"}
                </button>
              </div>
            </div>

            {/* Pages — real canvases at fit-width (no cap), no nested scroll.
                "safe center" keeps pages centered when they fit but left-aligns
                them once zoomed wider than the viewport, so the whole page stays
                reachable by pan/scroll (plain center clips the left edge). The
                live zoom is applied here as CSS `zoom` so the already-rendered
                canvases scale instantly without re-rasterizing. */}
            <div className="flex flex-col gap-3 py-3 px-1 min-h-[40vh]" style={{ alignItems: "safe center", zoom: cssZoom }}>
              {entry.loading ? (
                <div className="flex flex-col items-center justify-center gap-4 py-20">
                  <Loader2 className="w-9 h-9 animate-spin text-[var(--color-text-muted)]" />
                  <span className="text-[13px] text-[var(--color-text-muted)]">Opening {entry.doc.documentNumber || "the sheet"}…</span>
                </div>
              ) : entry.error || !entry.resolvedUrl ? (
                <div role="alert" className="flex flex-col items-center justify-center gap-3 py-20 text-[var(--color-text-muted)]">
                  <FileText className="w-14 h-14 opacity-30" />
                  <span className="text-[13px] font-semibold">{entry.error ? "Couldn't open this sheet." : "This sheet has no file to show."}</span>
                </div>
              ) : mounted.has(idx) ? (
                <Document options={PDF_DOC_OPTIONS}
                  file={entry.resolvedUrl}
                  onLoadSuccess={({ numPages }) => setPageCounts((c) => (c[idx] === numPages ? c : { ...c, [idx]: numPages }))}
                  loading={<div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-[var(--color-text-muted)]" /></div>}
                  error={<div role="alert" className="flex flex-col items-center gap-2 text-[var(--color-text-muted)] py-20"><FileText className="w-12 h-12 opacity-30" /><span className="text-[13px] font-semibold">Couldn’t show this PDF</span></div>}
                  className="flex flex-col items-center gap-3"
                >
                  {Array.from({ length: pageCounts[idx] ?? 0 }).map((_, p) => {
                    const docId = entry.doc.id ?? "";
                    const natKey = `${idx}:${p}`;
                    const nat = pageNat[natKey];
                    const pageMark = markupStore[docId]?.[p + 1];
                    const intrinsicRot = pageRot[natKey] ?? 0;
                    // Honor the PDF's OWN /Rotate when the user hasn't rotated — passing
                    // rotate=0 would force-flip pages authored with an intrinsic rotation.
                    const pageRotate = effectiveRot === 0 ? undefined : (((intrinsicRot + effectiveRot) % 360) + 360) % 360;
                    // Markup only on truly upright pages (no user OR intrinsic rotation)
                    // so normalized coordinates bake back onto the page correctly.
                    const showMark = effectiveRot === 0 && intrinsicRot === 0 && !!nat && (markupMode || !!pageMark);
                    return (
                      <div key={p} className="relative shadow-xl shadow-black/40 bg-white">
                        <Page
                          pageNumber={p + 1}
                          width={renderWidth}
                          rotate={pageRotate}
                          renderTextLayer={false}
                          renderAnnotationLayer={false}
                          onLoadSuccess={(page) => {
                            if (!pageNat[natKey]) { const vp = page.getViewport({ scale: 1 }); setPageNat((m) => (m[natKey] ? m : { ...m, [natKey]: vp.width })); }
                            if (pageRot[natKey] === undefined) setPageRot((m) => (m[natKey] !== undefined ? m : { ...m, [natKey]: ((page.rotate ?? 0) % 360 + 360) % 360 }));
                          }}
                          loading={<div className="bg-[var(--color-ink-2)] animate-pulse" style={{ width: renderWidth, height: Math.round(renderWidth * 1.3) }} />}
                        />
                        {showMark && (
                          <InlinePageMarkup
                            key={`mk-${docId}-${p}-${markupVersion[docId] ?? 0}`}
                            naturalWidth={nat}
                            tool={markTool}
                            color={markColor}
                            strokeWidth={markStroke}
                            enabled={markupMode}
                            value={pageMark}
                            onChange={(json) => setPageMarkup(docId, p + 1, json)}
                          />
                        )}
                      </div>
                    );
                  })}
                </Document>
              ) : (
                // Not yet mounted (offscreen) — a light placeholder keeps layout stable.
                <div className="bg-[var(--color-ink-2)] rounded-lg flex items-center justify-center text-[var(--color-text-muted)]" style={{ width: renderWidth, height: Math.round(renderWidth * 1.3) }}>
                  <FileText className="w-10 h-10 opacity-30" />
                </div>
              )}
            </div>
          </div>
        ))}
        <div className="h-16" />
      </div>

      {/* ── MARKUP TOOLS (compact; appear when Markup is on) ── */}
      {markupMode && (
        <div className="absolute top-11 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100%-16px)] overflow-x-auto flex items-center gap-1 rounded-xl bg-[color-mix(in_srgb,var(--color-ink)_92%,transparent)] backdrop-blur border border-[var(--color-border)] shadow-2xl shadow-black/50 px-2 py-1.5" role="toolbar" aria-label="Markup tools">
          {([
            ["select", "Select / move", MousePointer2],
            ["pen", "Pen", Pen],
            ["highlight", "Highlighter", Highlighter],
            ["rect", "Rectangle", Square],
            ["arrow", "Arrow", ArrowUpRight],
            ["text", "Text", Type],
            ["eraser", "Eraser - click an object to delete", Eraser],
          ] as [MarkTool, string, typeof Pen][]).map(([t, label, Icon]) => (
            <button type="button" key={t} onClick={() => setMarkTool(t)} title={label} aria-label={label} aria-pressed={markTool === t} className={vTool(markTool === t, "w-9 h-9")}>
              <Icon className="w-4 h-4" />
            </button>
          ))}
          <div className="w-px h-5 shrink-0 bg-[var(--color-ink-line)] mx-0.5" aria-hidden="true" />
          {(["red", "blue", "green", "orange", "yellow", "black"] as ColorKey[]).map((ck) => (
            <button type="button" key={ck} onClick={() => setMarkColor(ck)} title={`Colour: ${ck}`} aria-label={`${ck} pen`} aria-pressed={markColor === ck} className={`w-5 h-5 shrink-0 rounded-full border-2 ring-1 ring-[var(--color-ink-line)] transition-transform ${markColor === ck ? "border-[var(--color-ink-fg)] scale-110" : "border-transparent"}`} style={{ backgroundColor: COLOR_HEX[ck] }} />
          ))}
          <div className="w-px h-5 shrink-0 bg-[var(--color-ink-line)] mx-0.5" aria-hidden="true" />
          {[2, 4, 6].map((w) => (
            <button type="button" key={w} onClick={() => setMarkStroke(w)} title={`Line thickness: ${w}px`} aria-label={`Line thickness ${w}`} aria-pressed={markStroke === w} className={vTool(markStroke === w, "w-9 h-9")}>
              <span className="rounded-full bg-current block" style={{ width: w + 3, height: w + 3 }} />
            </button>
          ))}
          <div className="w-px h-5 shrink-0 bg-[var(--color-ink-line)] mx-0.5" aria-hidden="true" />
          <button type="button" onClick={() => clearActiveMarkup(activeEntry?.doc.id)} title="Clear this sheet's markup" aria-label="Clear this sheet's markup" className="w-9 h-9 shrink-0 rounded-[10px] grid place-items-center text-[var(--color-text-muted)] hover:text-rose-400 hover:bg-[var(--color-ink-2)] transition-colors"><Trash2 className="w-4 h-4" /></button>
          <button type="button" onClick={() => setMarkupMode(false)} title="Done marking up" className="ml-1 shrink-0 h-8 px-3 rounded-lg bg-[var(--color-ink-2)] hover:bg-[var(--color-ink-line)] text-[var(--color-text)] text-[13px] font-bold">Done</button>
        </div>
      )}

      {/* ── THIS SHEET'S EQUIPMENT TAGS (floating at the top of the page) ── */}
      {orgId && !markupMode && activeEntry?.doc && activeTagGroups.length > 0 && (
        tagsBarOpen ? (
          <div className="absolute top-11 left-1/2 -translate-x-1/2 z-30 max-w-[calc(100%-16px)] w-auto rounded-xl bg-[color-mix(in_srgb,var(--color-ink)_88%,transparent)] backdrop-blur border border-[var(--color-border)] shadow-2xl shadow-black/40 px-2.5 py-1.5 flex items-center gap-2">
            <div className="min-w-0 overflow-x-auto">
              <EquipmentTagsStrip metadata={activeEntry.doc.metadata as Record<string, unknown>} customColumns={customColumns} orgId={orgId} userId={currentUserId} canManage={false} variant="ribbon" />
            </div>
            <button type="button" onClick={() => setTagsBarOpen(false)} title="Hide tags for this sheet" aria-label="Hide tags for this sheet" className="shrink-0 w-7 h-7 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]"><X className="w-3.5 h-3.5" /></button>
          </div>
        ) : (
          <button type="button" onClick={() => setTagsBarOpen(true)} className="absolute top-11 left-1/2 -translate-x-1/2 z-30 inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-[color-mix(in_srgb,var(--color-ink)_88%,transparent)] backdrop-blur border border-[var(--color-border)] text-[var(--color-text)] text-[12px] font-bold shadow-xl" title="Show tags for this sheet">
            <Camera className="w-3.5 h-3.5" /> Tags
          </button>
        )
      )}
      </div>
      </div>
      </div>
      </div>

      {showBulkCheckout && orgId && currentUserId && (
        <BulkCheckoutToProjectModal
          isOpen={showBulkCheckout}
          onClose={() => setShowBulkCheckout(false)}
          docs={docs}
          orgId={orgId}
          actorUserId={currentUserId}
          actorEmail={currentUserEmail}
          actorRole={userRole || ""}
          onSuccess={() => { setShowBulkCheckout(false); onClose(); }}
        />
      )}

      {/* Uncontrolled-copy question */}
      {downloadConfirm && (
        <Modal onClose={closeConfirm} dismissable={!(docBusy || bookBusy)} size="sm">
          <ModalHeader
            icon={ShieldAlert}
            iconClassName="bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
            title="This copy will be stamped uncontrolled"
            subtitle={isBook ? "Reference books are always uncontrolled." : "You don't have this document checked out."}
            onClose={docBusy || bookBusy ? undefined : closeConfirm}
          />
          <ModalBody className="space-y-3">
            <p className="text-[14px] text-[var(--color-text-muted)]">
              {isBook ? (
                <>Every page of {downloadConfirm.scope === "pinned" ? "your" : "all"} {entriesForScope(downloadConfirm.scope ?? "all").length} {downloadConfirm.scope === "pinned" ? "pinned " : ""}sheet{entriesForScope(downloadConfirm.scope ?? "all").length === 1 ? "" : "s"} will be merged into one PDF and stamped with a diagonal &quot;UNCONTROLLED - FOR REVIEW ONLY&quot; watermark plus a footer with your email and the time. Every document is logged.</>
              ) : (
                <>Every page will be stamped with a diagonal &quot;UNCONTROLLED - FOR REVIEW ONLY&quot; watermark plus a footer with your email and the time. It&apos;s logged.</>
              )}
            </p>
            {actionError && <p role="alert" className="text-[13px] font-semibold text-rose-700 dark:text-rose-300">{actionError}</p>}
          </ModalBody>
          <ModalFooter>
            <Button variant="secondary" onClick={closeConfirm} disabled={docBusy || bookBusy}>Cancel</Button>
            <Button
              loading={docBusy || bookBusy}
              onClick={() => { if (downloadConfirm.type === "book") void downloadBookMerged(entriesForScope(downloadConfirm.scope ?? "all")); else if (downloadConfirm.type === "book-print") void printBookMerged(entriesForScope(downloadConfirm.scope ?? "all")); else void runDocAction(downloadConfirm.type); }}
            >
              {downloadConfirm.type === "book" ? "Download stamped book" : downloadConfirm.type === "book-print" ? "Print stamped book" : downloadConfirm.type === "download" ? "Download stamped copy" : "Print stamped copy"}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}
