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
  Download, Printer, ShieldCheck, ShieldAlert, Library, Briefcase,
  Search, Pen, ZoomIn, ZoomOut, Camera, Pin, Layers, Plus, Check, Send,
  Maximize2, Minimize2, RotateCw, MoreHorizontal, PanelLeftClose,
  MousePointer2, Highlighter, Square, ArrowUpRight, Type, Eraser, Trash2, Tags, ChevronDown, Hand,
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import * as fabric from "fabric";
import { supabase } from "@/lib/supabase";
import type { DocumentRecord } from "@/types/schema";
import { downloadDocumentPdf, printDocumentPdf, determineControlState, viewerStatusBadge, type ViewBadgeTone } from "@/lib/downloads";
import { stampPdf } from "@/lib/stamping";
import { PDFDocument } from "pdf-lib";
import BulkCheckoutToProjectModal from "@/components/documents/BulkCheckoutToProjectModal";
import EquipmentTagsStrip from "@/components/assets/EquipmentTagsStrip";
import { collectTagGroups, rankTags, type TagColumnDef } from "@/lib/documentTags";
import { useViewerPanZoom } from "@/lib/useViewerPanZoom";
import { bakeMarkupIntoPdf } from "@/lib/markupExport";
import { stashDraft, type DraftHandoffFile } from "@/lib/draftHandoff";
import { appAlert } from "@/components/providers/DialogProvider";
import { useRouter } from "next/navigation";

// Same self-hosted worker the single viewer uses (copied to /public on prebuild).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const BADGE_TONE: Record<ViewBadgeTone, string> = {
  controlled: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  caution: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  danger: "bg-red-500/10 text-red-400 border-red-500/30",
  muted: "bg-slate-500/10 text-slate-300 border-slate-500/30",
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
    <div ref={ref} className="w-full bg-slate-800/60 leading-[0]">
      {show && url && w > 0 ? (
        <Document file={url} loading={<div className="animate-pulse bg-slate-800/60" style={{ height: ph }} />} error={<div className="flex items-center justify-center text-slate-600" style={{ height: ph }}><FileText className="w-5 h-5 opacity-30" /></div>}>
          <Page pageNumber={1} width={w} renderTextLayer={false} renderAnnotationLayer={false} loading={<div className="animate-pulse bg-slate-800/60" style={{ height: ph }} />} />
        </Document>
      ) : (
        <div className="animate-pulse bg-slate-800/40" style={{ height: ph }} />
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
}

export default function MultiDocViewer({ docs, onClose, currentUserId, currentUserEmail, orgId, userRole, customColumns, labelColumns }: MultiDocViewerProps) {
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
  const [activeIdx, setActiveIdx] = useState(0);
  // Thumbnail rail — a push panel (default CLOSED for a clean full-bleed page;
  // open it with the toolbar button or B).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tagsBarOpen, setTagsBarOpen] = useState(true);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);

  // Continuous-render state.
  const [pageCounts, setPageCounts] = useState<Record<number, number>>({});
  const [mounted, setMounted] = useState<Set<number>>(() => new Set([0]));
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
  // Markups persisted per sheet (docId → normalized fabric page states), so
  // annotating several sheets in one session never loses work.
  const [markupStore, setMarkupStore] = useState<Record<string, Record<number, object>>>({});
  const [sendingDraft, setSendingDraft] = useState(false);
  // Inline markup: compact tools in the toolbar draw straight onto the rendered
  // page (no editor window, no PDF re-render). Markups live in memory and are
  // DISCARDED on close unless baked for a drafting request or a download.
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

  // Load versions + resolve presigned URLs for all docs
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        try {
          let fileUrl: string | null = null;
          if (doc.currentVersionId) {
            const { data } = await supabase.from("document_versions").select("file_url").eq("id", doc.currentVersionId).single();
            if (data?.file_url) fileUrl = data.file_url;
          }
          if (!fileUrl) {
            const { data } = await supabase.from("document_versions").select("file_url").eq("record_id", doc.id).order("created_at", { ascending: false }).limit(1);
            if (data && data.length > 0) fileUrl = data[0].file_url;
          }
          let resolvedUrl: string | null = null;
          if (fileUrl) {
            if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
              resolvedUrl = fileUrl;
            } else if (token) {
              const res = await fetch(`/api/storage/download-url?path=${encodeURIComponent(fileUrl)}&expiresIn=3600`, { headers: { authorization: `Bearer ${token}` } });
              if (res.ok) { const { url } = await res.json(); resolvedUrl = url; }
            }
          }
          if (!alive) return;
          setEntries((prev) => { const next = [...prev]; next[i] = { doc, resolvedUrl, loading: false, error: null }; return next; });
        } catch {
          if (!alive) return;
          setEntries((prev) => { const next = [...prev]; next[i] = { ...next[i], loading: false, error: "Failed to load document" }; return next; });
        }
      }
    };
    load();
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
  const renderWidth = useMemo(() => {
    const availW = Math.max(280, containerSize.w - 24);
    return Math.max(200, Math.round(availW * zoom));
  }, [containerSize, zoom]);

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
      if (e.key === "Escape") { if (document.fullscreenElement) return; onClose(); }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") step(1);
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") step(-1);
      if (e.key === "f" || e.key === "F") void toggleFullscreen();
      if (e.key === "b" || e.key === "B") setSidebarOpen((v) => !v);
    },
    [onClose, step, toggleFullscreen]
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
      const ctx = { doc: activeEntry.doc, fileUrl, userId: currentUserId, userEmail: currentUserEmail ?? null, userLabel: currentUserEmail ?? null };
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
          watermarkText: `UNCONTROLLED — ${entry.doc.documentNumber || "DOC"} Rev ${entry.doc.rev || "-"}`,
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
      user_id: currentUserId,
      user_email: currentUserEmail ?? null,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      watermark_policy_id: null,
    }));
    try { await supabase.from("download_audits").insert(rows); } catch (e) { console.error(e); }
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

  // Bake every marked-up sheet's annotations into its PDF, stash them, and open
  // a NEW drafting request with all of them pre-attached — so you can mark up a
  // few sheets and send them together, markups included.
  const sendMarkupsToDrafting = async () => {
    if (markedUpIds.length === 0 || sendingDraft) return;
    setSendingDraft(true);
    try {
      const files: DraftHandoffFile[] = [];
      for (const id of markedUpIds) {
        const entry = entries.find((e) => e.doc.id === id);
        if (!entry?.resolvedUrl || !markupStore[id]) continue;
        const res = await fetch(entry.resolvedUrl);
        if (!res.ok) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const baked = await bakeMarkupIntoPdf(bytes, markupStore[id]);
        const stem = `${entry.doc.documentNumber || entry.doc.title || "sheet"}${entry.doc.rev ? `_Rev${entry.doc.rev}` : ""}_markup`.replace(/[^\w.\-]+/g, "_");
        files.push({ name: `${stem}.pdf`, blob: new Blob([baked as BlobPart], { type: "application/pdf" }), docId: id, docNumber: entry.doc.documentNumber });
      }
      if (files.length === 0) {
        setSendingDraft(false);
        await appAlert("Couldn't prepare any marked-up sheets.");
        return;
      }
      // Rich prefill so the requester only adds their notes: doc number · rev ·
      // sheet · title per sheet, plus a shared Unit if they all belong to one.
      const docsForFiles = files
        .map((f) => entries.find((e) => e.doc.id === f.docId)?.doc)
        .filter((d): d is DocumentRecord => !!d);
      const metaVal = (d: DocumentRecord, re: RegExp): string | null => {
        const m = (d.metadata ?? {}) as Record<string, unknown>;
        for (const [kk, vv] of Object.entries(m)) if (re.test(kk) && vv != null && vv !== "") return String(vv);
        return null;
      };
      const sheetOf = (d: DocumentRecord) => (d.sheetNumber != null ? String(d.sheetNumber) : metaVal(d, /sheet/i));
      const unitOf = (d: DocumentRecord) => metaVal(d, /\bunit\b|\barea\b/i);
      const units = Array.from(new Set(docsForFiles.map(unitOf).filter((u): u is string => !!u)));
      const unit = units.length === 1 ? units[0] : "";
      const lines = docsForFiles.map((d) => {
        const sheet = sheetOf(d);
        return `• ${d.documentNumber || d.title || "Document"}${d.rev ? ` Rev ${d.rev}` : ""}${sheet ? ` · Sheet ${sheet}` : ""}${d.title ? ` — ${d.title}` : ""}`;
      });
      const description = [
        "Marked-up sheets, attached as Source files:",
        ...lines,
        unit ? `\nUnit: ${unit}` : "",
        "\nWhat needs to change:\n- ",
      ].filter(Boolean).join("\n");

      const key = await stashDraft(files);
      const params = new URLSearchParams({
        title: `Markups: ${files.length} sheet${files.length === 1 ? "" : "s"}${unit ? ` · Unit ${unit}` : ""}`,
        description,
        draft: key,
      });
      if (unit) params.set("unit", unit);
      router.push(`/requests/new?${params.toString()}`);
    } catch (e) {
      console.error("Send markups to drafting failed", e);
      setSendingDraft(false);
      await appAlert(`Couldn't prepare markups: ${(e as Error).message || "unknown error"}`);
    }
  };

  // Toolbar stays put — no auto-hide (it disappearing on scroll was disliked).
  const showChrome = true;
  const iconBtn = "p-1.5 rounded-lg hover:bg-white/10 text-slate-300 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent transition-colors";
  const MENU_ITEM = "w-full px-3 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 disabled:opacity-40";

  // Ctrl+wheel zoom + grab-hand pan (disabled while marking up so the canvas owns
  // the pointer).
  const panZoom = useViewerPanZoom({
    containerRef: scrollContainerRef,
    onZoom: (f) => setZoom((z) => Math.min(3, Math.max(0.4, Math.round(z * f * 100) / 100))),
    enabled: !markupMode,
  });

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[85] bg-slate-950 animate-in fade-in duration-200 flex"
    >
      {/* ── THUMBNAIL RAIL (push panel; never overlaps the page) ── */}
      <div className={`${sidebarOpen ? "w-52" : "w-0"} shrink-0 bg-slate-900 border-r border-slate-800 overflow-hidden transition-[width] duration-200 flex flex-col`}>
        <div className="px-3 py-2.5 border-b border-slate-800 flex items-center gap-2 shrink-0">
          <BookOpen className="w-4 h-4 text-orange-400 shrink-0" />
          <span className="text-sm font-bold text-white truncate">Reference Book</span>
          <span className="text-[10px] font-black bg-orange-500 text-white px-1.5 py-0.5 rounded-full">{docs.length}</span>
          <button onClick={() => setSidebarOpen(false)} className="ml-auto p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800" title="Hide thumbnails (B)"><PanelLeftClose className="w-4 h-4" /></button>
        </div>
        {/* Focus controls — review just the sheets you pin. */}
        <div className="px-3 py-2 flex items-center gap-2 shrink-0 border-b border-slate-800/60">
          <button
            onClick={toggleFocus}
            disabled={picked.size === 0}
            title={picked.size === 0 ? "Pin sheets below, then focus on just those" : focusActive ? "Show all sheets" : "Show only your pinned sheets"}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors disabled:opacity-40 ${focusActive ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-300 hover:text-white"}`}
          >
            <Layers className="w-3.5 h-3.5" /> {focusActive ? "Focused" : "Focus"}{picked.size > 0 ? ` (${picked.size})` : ""}
          </button>
          {picked.size > 0 && (
            <button onClick={() => { setPicked(new Set()); setFocusMode(false); }} title="Clear pinned set" className="px-2 py-1.5 rounded-lg text-[11px] font-bold text-slate-400 hover:text-white hover:bg-slate-800">Clear</button>
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
              <div key={id} className={`relative group rounded-lg overflow-hidden border-2 transition-colors ${activeIdx === idx ? "border-orange-500" : "border-slate-700 hover:border-slate-500"} ${focusActive && !isPicked ? "opacity-40" : ""}`}>
                <button onClick={() => goToSheet(idx, { flash: true, addToFocus: !isVisible(idx) })} className="block w-full text-left" title={lines.join(" · ")}>
                  <PageThumb url={entry.resolvedUrl} />
                  <div className="px-2 py-1.5 bg-slate-950/90 flex items-baseline gap-2">
                    <span className="flex-1 min-w-0 text-[11px] font-mono font-bold text-slate-100 truncate">{lines[0] || `Sheet ${idx + 1}`}</span>
                    {lines[1] && <span className="shrink-0 text-[10px] font-bold text-slate-300">{lines[1]}</span>}
                  </div>
                </button>
                <div className="absolute top-1 left-1 w-4 h-4 rounded-full bg-orange-500 flex items-center justify-center text-[8px] font-black text-white shadow pointer-events-none">{idx + 1}</div>
                <button onClick={() => togglePick(idx)} title={isPicked ? "Remove from focus set" : "Pin to focus set"} className={`absolute top-1 right-1 p-1 rounded-md transition-opacity ${isPicked ? "text-orange-400 bg-slate-950/70" : "text-slate-200 bg-slate-950/50 opacity-0 group-hover:opacity-100"}`}>
                  <Pin className={`w-3 h-3 ${isPicked ? "fill-orange-400" : ""}`} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── MAIN (PDF fills whatever space the rail leaves) ── */}
      <div className="relative flex-1 min-w-0">
        {/* ── FULL-BLEED PAGE STACK ── */}
        <div ref={scrollContainerRef} className={`absolute inset-0 overflow-auto bg-slate-950 ${panZoom.cursorClass}`} {...panZoom.panHandlers}>
        {/* Spacer so the first sheet clears the floating toolbar when shown. */}
        <div className="h-12 shrink-0" />
        {entries.map((entry, idx) => (
          <div key={entry.doc.id} ref={(el) => { sectionRefs.current[idx] = el; }} style={{ display: isVisible(idx) ? undefined : "none" }} className={`flex flex-col ${flashIdx === idx ? "ring-4 ring-orange-500/70 ring-inset" : ""}`}>
            {/* Slim, translucent per-sheet header — keeps Markup + pin reachable
                without eating the page. Rides just below the toolbar when it's
                shown, slides to the very top when the toolbar hides. */}
            <div className="sticky z-10 bg-slate-900/80 backdrop-blur-sm border-y border-slate-800/80 px-4 py-1.5 flex items-center gap-3 transition-[top] duration-200" style={{ top: showChrome ? 52 : 0 }}>
              <div className="w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center text-[9px] font-black text-white shrink-0">{idx + 1}</div>
              <span className="text-[11px] font-mono font-bold text-orange-400 shrink-0">{entry.doc.documentNumber || "—"}</span>
              <span className="text-[11px] text-slate-300 font-medium truncate">{entry.doc.title || entry.doc.name}</span>
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <span className="text-[10px] text-slate-500 hidden sm:inline">Rev {entry.doc.rev || "—"}</span>
                <span className="text-[10px] text-slate-600 bg-slate-800 px-1.5 py-0.5 rounded hidden md:inline">{entry.doc.status || "—"}</span>
                {isMarkedUp(entry.doc.id) && (
                  <span className="text-[10px] font-bold text-emerald-300 inline-flex items-center gap-1"><Pen className="w-3 h-3" /> Marked up</span>
                )}
                <button
                  onClick={() => togglePick(idx)}
                  title={picked.has(entry.doc.id ?? "") ? "Remove from focus set" : "Add to focus set — review just the sheets you need"}
                  className={`text-[10px] font-bold inline-flex items-center gap-1 px-2 py-0.5 rounded-md border transition-colors ${picked.has(entry.doc.id ?? "") ? "bg-orange-500/20 border-orange-500/50 text-orange-300" : "bg-slate-800 border-slate-700 text-slate-300 hover:text-white"}`}
                >
                  <Pin className={`w-3 h-3 ${picked.has(entry.doc.id ?? "") ? "fill-orange-400" : ""}`} /> {picked.has(entry.doc.id ?? "") ? "Focused" : "Focus"}
                </button>
              </div>
            </div>

            {/* Pages — real canvases at fit-width (no cap), no nested scroll.
                "safe center" keeps pages centered when they fit but left-aligns
                them once zoomed wider than the viewport, so the whole page stays
                reachable by pan/scroll (plain center clips the left edge). */}
            <div className="flex flex-col gap-3 py-3 px-1 min-h-[40vh]" style={{ alignItems: "safe center" }}>
              {entry.loading ? (
                <div className="flex flex-col items-center justify-center gap-4 text-slate-500 py-20">
                  <Loader2 className="w-10 h-10 animate-spin text-orange-500" />
                  <span className="text-sm font-mono text-orange-400/70 animate-pulse">Loading {entry.doc.documentNumber || "document"}…</span>
                </div>
              ) : entry.error || !entry.resolvedUrl ? (
                <div className="flex flex-col items-center justify-center gap-3 text-slate-600 py-20">
                  <FileText className="w-16 h-16 opacity-20" />
                  <span className="text-sm font-medium">{entry.error || "No file available for this document"}</span>
                </div>
              ) : mounted.has(idx) ? (
                <Document
                  file={entry.resolvedUrl}
                  onLoadSuccess={({ numPages }) => setPageCounts((c) => (c[idx] === numPages ? c : { ...c, [idx]: numPages }))}
                  loading={<div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-orange-500" /></div>}
                  error={<div className="flex flex-col items-center gap-2 text-slate-600 py-20"><FileText className="w-12 h-12 opacity-20" /><span className="text-xs">Couldn’t render this PDF</span></div>}
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
                          loading={<div className="bg-slate-800 animate-pulse" style={{ width: renderWidth, height: Math.round(renderWidth * 1.3) }} />}
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
                <div className="bg-slate-900/40 rounded-lg flex items-center justify-center text-slate-700" style={{ width: renderWidth, height: Math.round(renderWidth * 1.3) }}>
                  <FileText className="w-10 h-10 opacity-20" />
                </div>
              )}
            </div>
          </div>
        ))}
        <div className="h-16 bg-slate-950" />
      </div>

      {/* ── FLOATING TOP TOOLBAR (overlay, always visible) ── */}
      <div className={`absolute top-0 inset-x-0 z-50 transition-transform duration-200 ${showChrome ? "translate-y-0" : "-translate-y-full"}`}>
        <div className="m-2 rounded-xl bg-slate-900/90 backdrop-blur border border-slate-700/80 shadow-2xl shadow-black/40 px-2 py-1.5 flex items-center gap-2">
          <button onClick={() => setSidebarOpen((v) => !v)} className={iconBtn} title="Pages & contents (B)"><Menu className="w-4 h-4" /></button>
          <div className="hidden sm:flex items-center gap-1.5 min-w-0">
            <BookOpen className="w-4 h-4 text-orange-400 shrink-0" />
            <span className="text-xs font-bold text-white truncate max-w-[140px]">Reference Book</span>
            <span className="shrink-0 text-[10px] font-black bg-orange-500 text-white px-1.5 py-0.5 rounded-full">{docs.length}</span>
          </div>

          <div className="w-px h-5 bg-slate-700 hidden sm:block" />

          {/* Page nav */}
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => step(-1)} disabled={visibleIdxs.indexOf(activeIdx) <= 0} className={iconBtn} title="Previous sheet (↑)"><ChevronLeft className="w-4 h-4" /></button>
            <span className="text-[11px] text-slate-400 px-1 font-mono whitespace-nowrap">{Math.max(1, visibleIdxs.indexOf(activeIdx) + 1)} / {visibleIdxs.length}</span>
            <button onClick={() => step(1)} disabled={visibleIdxs.indexOf(activeIdx) >= visibleIdxs.length - 1} className={iconBtn} title="Next sheet (↓)"><ChevronRight className="w-4 h-4" /></button>
          </div>

          {/* Tag search */}
          <div className="relative min-w-0 flex-1 max-w-sm">
            <div className="flex items-center gap-1.5 bg-slate-950/70 border border-slate-600 rounded-lg px-2.5 py-1.5 shadow-inner transition-all focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/30">
              <Search className="w-4 h-4 text-orange-400 shrink-0" />
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
                className="bg-transparent text-xs font-medium text-white placeholder:text-slate-400 outline-none w-full min-w-0"
                title="Search anything — equipment tag, sheet #, document name or any metadata. Typo-tolerant (P-34 = p34). Enter jumps; + pins a sheet to your focus set."
              />
              {searchMsg && <span className={`text-[10px] font-bold shrink-0 ${searchMsg === "No match" ? "text-rose-400" : "text-emerald-400"}`}>{searchMsg}</span>}
              {search ? (
                <button onMouseDown={(e) => { e.preventDefault(); setSearch(""); setSearchMsg(null); setShowSuggest(false); searchInputRef.current?.focus(); }} title="Clear" className="shrink-0 p-0.5 text-slate-400 hover:text-white"><X className="w-3.5 h-3.5" /></button>
              ) : (
                <kbd className="hidden lg:inline shrink-0 text-[9px] font-bold text-slate-400 border border-slate-600 rounded px-1 py-px">↵</kbd>
              )}
            </div>

            {showSuggest && results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl shadow-black/50 overflow-hidden py-1 max-h-80 overflow-y-auto">
                {results.map((r, i) => {
                  const e = entries[r.idx];
                  const id = e?.doc.id ?? "";
                  const isPicked = picked.has(id);
                  return (
                    <div key={r.idx} onMouseEnter={() => setSuggestIdx(i)} className={`flex items-stretch transition-colors ${i === suggestIdx ? "bg-orange-500/20" : "hover:bg-slate-800"}`}>
                      <button
                        onMouseDown={(ev) => { ev.preventDefault(); goToSheet(r.idx, { addToFocus: focusActive, flash: true }); }}
                        className="flex-1 min-w-0 text-left px-3 py-1.5"
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-mono font-bold text-white truncate">{e?.doc.documentNumber || `Sheet ${r.idx + 1}`}</span>
                          <span className="text-[10px] text-slate-400 truncate">{e?.doc.title || e?.doc.name}</span>
                        </div>
                        <div className="text-[10px] text-orange-300/80 truncate">matched “{r.matched}”</div>
                      </button>
                      <button
                        onMouseDown={(ev) => { ev.preventDefault(); togglePick(r.idx); }}
                        title={isPicked ? "Remove from focus set" : "Add this sheet to your focus set"}
                        className={`shrink-0 px-2.5 flex items-center border-l border-slate-800 transition-colors ${isPicked ? "text-orange-400" : "text-slate-500 hover:text-white"}`}
                      >
                        {isPicked ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Zoom / fit-width / rotate cluster */}
          <div className="hidden md:flex items-center gap-0.5 bg-slate-800/80 rounded-lg px-1 py-0.5 shrink-0">
            <button onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100))} className={iconBtn} title="Zoom out"><ZoomOut className="w-4 h-4" /></button>
            <button onClick={() => setZoom(1)} className={`${iconBtn} ${zoom === 1 ? "text-orange-300" : ""}`} title="Fit to width — reset zoom to 100%"><span className="text-[11px] font-mono w-9 text-center inline-block">{Math.round(zoom * 100)}%</span></button>
            <button onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.15) * 100) / 100))} className={iconBtn} title="Zoom in (or Ctrl + scroll)"><ZoomIn className="w-4 h-4" /></button>
            <div className="w-px h-4 bg-slate-700 mx-0.5" />
            <button onClick={() => setRotation((r) => r + 90)} className={iconBtn} title="Rotate 90°"><RotateCw className="w-4 h-4" /></button>
            {!markupMode && (
              <button onClick={() => panZoom.setPanMode((v) => !v)} className={`${iconBtn} ${panZoom.panMode ? "bg-white/10 text-orange-300" : ""}`} title={panZoom.panMode ? "Pan tool (drag to move the page) — click for the normal cursor" : "Cursor — click to switch back to the pan/grab hand"}>
                {panZoom.panMode ? <Hand className="w-4 h-4" /> : <MousePointer2 className="w-4 h-4" />}
              </button>
            )}
          </div>

          {/* All-tags jump dropdown — every tag in the book, click to scroll there. */}
          {totalCollectionTags > 0 && (
            <div className="relative shrink-0">
              <button onClick={() => setTagMenuOpen((v) => !v)} title="Jump to any tag in this book" className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${tagMenuOpen ? "bg-slate-700 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"}`}>
                <Tags className="w-3.5 h-3.5" /> <span className="hidden lg:inline">Tags</span> <ChevronDown className="w-3 h-3" />
              </button>
              {tagMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setTagMenuOpen(false)} />
                  <div className="absolute top-full right-0 mt-1 z-50 w-64 max-h-[70vh] overflow-y-auto bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/60 py-1 custom-scrollbar">
                    {collectionTags.map((g) => (
                      <div key={g.label}>
                        <div className="px-3 pt-2 pb-1 text-[9px] font-black uppercase tracking-widest text-slate-500">{g.label}</div>
                        <div className="flex flex-wrap gap-1 px-2 pb-2">
                          {g.tags.map(([t, idx]) => (
                            <button key={t} onClick={() => { setTagMenuOpen(false); goToSheet(idx, { flash: true }); }} title={`Sheet ${idx + 1}`} className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-800 hover:bg-orange-600 hover:text-white text-[10px] font-bold text-slate-200 border border-slate-700 transition-colors">
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

          {/* Markup toggle — reveals the compact tools sub-bar. */}
          <button onClick={() => setMarkupMode((v) => !v)} title="Markup — draw on the page. Discarded on close unless you download the sheet or send it to drafting." className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold shrink-0 transition-colors ${markupMode ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"}`}>
            <Pen className="w-3.5 h-3.5" /> <span className="hidden lg:inline">Markup</span>
          </button>

          {/* Focus toggle */}
          {picked.size > 0 && (
            <button onClick={toggleFocus} title={focusActive ? "Show all sheets" : "Show only your pinned sheets"} className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold shrink-0 transition-colors ${focusActive ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"}`}>
              <Layers className="w-3.5 h-3.5" /> {focusActive ? "Focused" : "Focus"} {picked.size}
            </button>
          )}

          {viewBadge && (
            <span className={`hidden xl:inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold shrink-0 border ${BADGE_TONE[viewBadge.tone]}`} title="Status of the live version you're viewing. A copy you download or print is stamped separately.">
              {viewBadge.tone === "controlled" ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
              {viewBadge.label}
            </span>
          )}

          {markedUpIds.length > 0 && (
            <button onClick={() => void sendMarkupsToDrafting()} disabled={sendingDraft} title="Send all marked-up sheets (with your markups baked in) to one new drafting request" className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold disabled:opacity-50 shrink-0">
              {sendingDraft ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              <span className="hidden lg:inline">Send Markups</span> ({markedUpIds.length})
            </button>
          )}

          {/* ── DOWNLOAD (uncontrolled) — this sheet / pinned / whole book ── */}
          <div className="relative shrink-0 ml-auto">
            <button onClick={() => setExportMenu((m) => (m === "download" ? null : "download"))} title="Download an uncontrolled (stamped) copy" className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${exportMenu === "download" ? "bg-slate-700 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"}`}>
              {bookBusy || docBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} <span className="hidden lg:inline">Download</span> <ChevronDown className="w-3 h-3" />
            </button>
            {exportMenu === "download" && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportMenu(null)} />
                <div className="absolute top-full right-0 mt-1 z-50 w-60 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/60 py-1.5">
                  <div className="px-3 pt-1 pb-1 text-[9px] font-black uppercase tracking-widest text-slate-500">Download as PDF</div>
                  <button onClick={() => { setExportMenu(null); requestDocDownload(); }} disabled={!activeEntry?.resolvedUrl || !currentUserId || docBusy} title="The sheet you're viewing. Stamped UNCONTROLLED unless you hold its checkout." className={MENU_ITEM}><FileText className="w-3.5 h-3.5 text-slate-400" /> This sheet</button>
                  <button onClick={() => { setExportMenu(null); requestBookDownload("pinned"); }} disabled={bookBusy || !currentUserId || pinnedReadyEntries.length === 0} title="Merge your pinned sheets into one stamped, uncontrolled PDF" className={MENU_ITEM}><Pin className="w-3.5 h-3.5 text-orange-400" /> Pinned sheets ({pinnedReadyEntries.length}) <span className="ml-auto text-[9px] text-slate-500 font-bold">UNCONTROLLED</span></button>
                  <button onClick={() => { setExportMenu(null); requestBookDownload("all"); }} disabled={bookBusy || !currentUserId || bookReadyEntries.length === 0} title="Merge the whole collection into one stamped, uncontrolled PDF" className={MENU_ITEM}><Library className="w-3.5 h-3.5 text-orange-400" /> Whole book ({bookReadyEntries.length}) <span className="ml-auto text-[9px] text-slate-500 font-bold">UNCONTROLLED</span></button>
                </div>
              </>
            )}
          </div>

          {/* ── PRINT (uncontrolled) — this sheet / pinned / whole book ── */}
          <div className="relative shrink-0">
            <button onClick={() => setExportMenu((m) => (m === "print" ? null : "print"))} title="Print an uncontrolled (stamped) copy" className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${exportMenu === "print" ? "bg-slate-700 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"}`}>
              {bookBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />} <span className="hidden lg:inline">Print</span> <ChevronDown className="w-3 h-3" />
            </button>
            {exportMenu === "print" && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportMenu(null)} />
                <div className="absolute top-full right-0 mt-1 z-50 w-60 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/60 py-1.5">
                  <div className="px-3 pt-1 pb-1 text-[9px] font-black uppercase tracking-widest text-slate-500">Send to printer</div>
                  <button onClick={() => { setExportMenu(null); requestDocPrint(); }} disabled={!activeEntry?.resolvedUrl || !currentUserId || docBusy} title="The sheet you're viewing. Stamped UNCONTROLLED unless you hold its checkout." className={MENU_ITEM}><FileText className="w-3.5 h-3.5 text-slate-400" /> This sheet</button>
                  <button onClick={() => { setExportMenu(null); requestBookPrint("pinned"); }} disabled={bookBusy || !currentUserId || pinnedReadyEntries.length === 0} title="Merge your pinned sheets into one stamped, uncontrolled PDF and print" className={MENU_ITEM}><Pin className="w-3.5 h-3.5 text-orange-400" /> Pinned sheets ({pinnedReadyEntries.length}) <span className="ml-auto text-[9px] text-slate-500 font-bold">UNCONTROLLED</span></button>
                  <button onClick={() => { setExportMenu(null); requestBookPrint("all"); }} disabled={bookBusy || !currentUserId || bookReadyEntries.length === 0} title="Merge the whole collection into one stamped, uncontrolled PDF and print" className={MENU_ITEM}><Library className="w-3.5 h-3.5 text-orange-400" /> Whole book ({bookReadyEntries.length}) <span className="ml-auto text-[9px] text-slate-500 font-bold">UNCONTROLLED</span></button>
                </div>
              </>
            )}
          </div>

          {/* Overflow menu — the rare bulk action. */}
          <div className="relative shrink-0">
            <button onClick={() => setMoreOpen((v) => !v)} className={`${iconBtn} ${moreOpen ? "bg-white/10 text-white" : ""}`} title="More actions"><MoreHorizontal className="w-4 h-4" /></button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
                <div className="absolute top-full right-0 mt-1 z-50 w-52 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/60 py-1.5">
                  <button onClick={() => { setMoreOpen(false); setShowBulkCheckout(true); }} disabled={!currentUserId || docs.length === 0} className="w-full px-3 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 disabled:opacity-40"><Briefcase className="w-3.5 h-3.5 text-indigo-400" /> Checkout all to project</button>
                </div>
              </>
            )}
          </div>

          <button onClick={() => void toggleFullscreen()} className={iconBtn} title={isFullscreen ? "Exit full screen (F)" : "Full screen (F)"}>
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button onClick={onClose} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold transition-colors shrink-0" title="Close (Esc)">
            <X className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Close</span>
          </button>
        </div>
      </div>

      {/* ── MARKUP SUB-TOOLBAR (compact tools; appears when Markup is on) ── */}
      {markupMode && showChrome && (
        <div className="absolute top-[3.6rem] left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 bg-slate-900/95 backdrop-blur border border-slate-700 rounded-xl shadow-2xl shadow-black/50 px-2 py-1.5">
          {([
            ["select", "Select / move", MousePointer2],
            ["pen", "Pen", Pen],
            ["highlight", "Highlighter", Highlighter],
            ["rect", "Rectangle", Square],
            ["arrow", "Arrow", ArrowUpRight],
            ["text", "Text", Type],
            ["eraser", "Eraser — click an object to delete", Eraser],
          ] as [MarkTool, string, typeof Pen][]).map(([t, label, Icon]) => (
            <button key={t} onClick={() => setMarkTool(t)} title={label} className={`${iconBtn} ${markTool === t ? "bg-orange-600 text-white hover:bg-orange-600" : ""}`}>
              <Icon className="w-4 h-4" />
            </button>
          ))}
          <div className="w-px h-5 bg-slate-700 mx-0.5" />
          {(["red", "blue", "green", "orange", "yellow", "black"] as ColorKey[]).map((ck) => (
            <button key={ck} onClick={() => setMarkColor(ck)} title={`Colour: ${ck}`} className={`w-5 h-5 rounded-full border-2 transition-transform ${markColor === ck ? "border-white scale-110" : "border-transparent"}`} style={{ backgroundColor: COLOR_HEX[ck] }} />
          ))}
          <div className="w-px h-5 bg-slate-700 mx-0.5" />
          {[2, 4, 6].map((w) => (
            <button key={w} onClick={() => setMarkStroke(w)} title={`Line thickness: ${w}px`} className={`${iconBtn} flex items-center justify-center ${markStroke === w ? "bg-white/10 text-orange-300" : ""}`}>
              <span className="rounded-full bg-current block" style={{ width: w + 3, height: w + 3 }} />
            </button>
          ))}
          <div className="w-px h-5 bg-slate-700 mx-0.5" />
          <button onClick={() => clearActiveMarkup(activeEntry?.doc.id)} title="Clear this sheet's markup" className={iconBtn}><Trash2 className="w-4 h-4" /></button>
          <button onClick={() => setMarkupMode(false)} title="Done marking up" className="ml-1 px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-bold">Done</button>
        </div>
      )}

      {/* ── PER-PAGE TAG PILLS (floating overlay at the top of the page) ── */}
      {orgId && !markupMode && activeEntry?.doc && activeTagGroups.length > 0 && (
        tagsBarOpen ? (
          <div className="absolute top-[3.4rem] left-1/2 -translate-x-1/2 z-40 max-w-[92vw] w-auto bg-slate-900/85 backdrop-blur border border-slate-700/80 rounded-xl shadow-2xl shadow-black/40 px-2.5 py-1.5 flex items-center gap-2">
            <div className="min-w-0">
              <EquipmentTagsStrip metadata={activeEntry.doc.metadata as Record<string, unknown>} customColumns={customColumns} orgId={orgId} userId={currentUserId} canManage={false} variant="ribbon" />
            </div>
            <button onClick={() => setTagsBarOpen(false)} title="Hide tags for this sheet" className="shrink-0 p-1 rounded text-white/50 hover:text-white hover:bg-white/10"><X className="w-3.5 h-3.5" /></button>
          </div>
        ) : (
          <button onClick={() => setTagsBarOpen(true)} className="absolute top-[3.4rem] left-1/2 -translate-x-1/2 z-40 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-900/85 backdrop-blur border border-slate-700 text-white/80 hover:text-white text-[11px] font-bold shadow-xl" title="Show tags for this sheet">
            <Camera className="w-3.5 h-3.5" /> Tags
          </button>
        )
      )}

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

      {/* Uncontrolled confirmation modal */}
      {downloadConfirm && (
        <div className="fixed inset-0 z-[120] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-6">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
              <div className="p-2 bg-amber-100 rounded-lg"><ShieldAlert className="w-5 h-5 text-amber-700" /></div>
              <div>
                <div className="text-sm font-black text-slate-900">Uncontrolled Copy</div>
                <div className="text-xs text-slate-500">{downloadConfirm.type === "book" || downloadConfirm.type === "book-print" ? "Reference books are always uncontrolled." : "You don't have this document checked out."}</div>
              </div>
            </div>
            <div className="px-6 py-4 text-sm text-slate-700 space-y-3">
              <p>
                {downloadConfirm.type === "book" || downloadConfirm.type === "book-print" ? (
                  <>Every page of {downloadConfirm.scope === "pinned" ? "your" : "all"} {entriesForScope(downloadConfirm.scope ?? "all").length} {downloadConfirm.scope === "pinned" ? "pinned " : ""}sheet{entriesForScope(downloadConfirm.scope ?? "all").length === 1 ? "" : "s"} will be merged into one PDF and stamped with a diagonal &quot;UNCONTROLLED — FOR REVIEW ONLY&quot; watermark plus a footer with your email and the timestamp. Every document is logged to the audit trail.</>
                ) : (
                  <>Every page will be stamped with a diagonal &quot;UNCONTROLLED — FOR REVIEW ONLY&quot; watermark plus a footer with your email and the timestamp. The action will be logged.</>
                )}
              </p>
              {actionError && <p className="text-xs text-red-600 font-mono bg-red-50 border border-red-200 rounded-lg p-2">{actionError}</p>}
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button onClick={() => { setDownloadConfirm(null); setActionError(null); }} disabled={docBusy || bookBusy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
              <button
                onClick={() => { if (downloadConfirm.type === "book") void downloadBookMerged(entriesForScope(downloadConfirm.scope ?? "all")); else if (downloadConfirm.type === "book-print") void printBookMerged(entriesForScope(downloadConfirm.scope ?? "all")); else void runDocAction(downloadConfirm.type); }}
                disabled={docBusy || bookBusy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60"
              >
                {(docBusy || bookBusy) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {downloadConfirm.type === "book" ? "Download stamped book" : downloadConfirm.type === "book-print" ? "Print stamped book" : downloadConfirm.type === "download" ? "Download stamped copy" : "Print stamped copy"}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
