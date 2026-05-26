"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Download,
  Printer,
  ShieldCheck,
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
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import * as fabric from "fabric";
import { PDFDocument } from "pdf-lib";
import CheckoutStatusCell from "@/components/documents/CheckoutStatusCell";
import type { DocumentRecord } from "@/types/schema";
import {
  downloadDocumentPdf,
  printDocumentPdf,
  determineControlState,
} from "@/lib/downloads";

import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// CDNJS is more reliable than unpkg and the version pinning is exact.
// pdfjs fails silently if the worker URL is unreachable, which presents
// as "PDF failed to load" with no useful console error.
pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;

type Tool =
  | "select" | "pan" | "pen" | "highlight" | "line" | "arrow"
  | "rect" | "cloud" | "text" | "sticky" | "stamp" | "eraser";

type ColorKey = "red" | "blue" | "black" | "yellow" | "green" | "orange";

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
}

export default function FullScreenViewer({
  isOpen, onClose, url, title, docNumber, rev, document: docRecord,
  userRole, currentUserId, currentUserEmail, onCheckout,
}: FullScreenViewerProps) {
  // ─── Pre-fetched PDF bytes (one fetch for view AND save) ──────────────
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [fetchPct, setFetchPct] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !url) return;
    let cancelled = false;
    const ctl = new AbortController();
    setPdfBytes(null);
    setFetchPct(0);
    setFetchError(null);

    (async () => {
      try {
        const res = await fetch(url, { signal: ctl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching PDF`);
        const total = Number(res.headers.get("content-length") || 0);

        if (!res.body || !total) {
          const buf = await res.arrayBuffer();
          if (!cancelled) {
            setPdfBytes(new Uint8Array(buf));
            setFetchPct(100);
          }
          return;
        }

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.length;
            if (!cancelled) setFetchPct(Math.round((received / total) * 100));
          }
        }
        const all = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        if (!cancelled) {
          setPdfBytes(all);
          setFetchPct(100);
        }
      } catch (e) {
        if (!cancelled && (e as Error).name !== "AbortError") {
          setFetchError((e as Error).message || "Failed to load PDF");
        }
      }
    })();

    return () => { cancelled = true; ctl.abort(); };
  }, [isOpen, url]);

  // Memoize the file object so react-pdf doesn't re-fetch on every render.
  const documentFile = useMemo(() => {
    if (!pdfBytes) return null;
    // Clone so pdfjs's internal mutation can't corrupt our bytes for the save path.
    return { data: pdfBytes.slice(0) };
  }, [pdfBytes]);

  // ─── PDF page + zoom state ────────────────────────────────────────────
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);

  // ─── Tool + style ─────────────────────────────────────────────────────
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<ColorKey>("red");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [stampMenuOpen, setStampMenuOpen] = useState(false);

  // ─── Per-page Fabric state (normalized at scale 1.0) ──────────────────
  const [pageStates, setPageStates] = useState<Record<number, object>>({});

  // Undo/redo per-page snapshot stacks
  const undoRef = useRef<Record<number, string[]>>({});
  const redoRef = useRef<Record<number, string[]>>({});
  const restoringRef = useRef(false);

  // ─── Download / print action state ────────────────────────────────────
  const [pending, setPending] = useState<null | { type: "download" | "print" }>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [markupBusy, setMarkupBusy] = useState(false);
  const [markupError, setMarkupError] = useState<string | null>(null);

  // ─── Pan state ────────────────────────────────────────────────────────
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const panRef = useRef({ panning: false, startX: 0, startY: 0 });

  // ─── Fabric canvas ────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);

  useEffect(() => {
    if (!isOpen || !canvasRef.current) return;
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
  const normalize = (json: any, s: number) => {
    if (!json?.objects) return json;
    const inv = 1 / s, out = JSON.parse(JSON.stringify(json));
    out.objects.forEach((o: any) => { o.left *= inv; o.top *= inv; o.scaleX *= inv; o.scaleY *= inv; });
    return out;
  };
  const denormalize = (json: any, s: number) => {
    if (!json?.objects) return json;
    const out = JSON.parse(JSON.stringify(json));
    out.objects.forEach((o: any) => { o.left *= s; o.top *= s; o.scaleX *= s; o.scaleY *= s; });
    return out;
  };

  const saveCurrentPage = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    setPageStates((prev) => ({ ...prev, [currentPage]: normalize(canvas.toJSON(), scale) }));
  }, [currentPage, scale]);

  const onPageLoaded = (page: any) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const vp = page.getViewport({ scale });
    canvas.setDimensions({ width: vp.width, height: vp.height });
    canvas.calcOffset();
    canvas.clear();
    const saved = pageStates[currentPage];
    if (saved) {
      canvas.loadFromJSON(denormalize(saved, scale)).then(() => {
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
  const setZoom = (n: number) => { saveCurrentPage(); setScale(Math.min(3, Math.max(0.5, n))); };

  // ─── Shape constructors ───────────────────────────────────────────────
  const addText = () => {
    const c = fabricRef.current; if (!c) return;
    const t = new fabric.IText("Text", { left: 60 * scale, top: 60 * scale, fontFamily: "Helvetica", fill: COLOR_HEX[color], fontSize: 20 * scale });
    c.add(t); c.setActiveObject(t); setTool("select");
  };
  const addStickyNote = () => {
    const c = fabricRef.current; if (!c) return;
    const w = 180 * scale, h = 110 * scale;
    const r = new fabric.Rect({ width: w, height: h, fill: "rgba(254, 240, 138, 0.92)", stroke: "#ca8a04", strokeWidth: 1, rx: 6, ry: 6, shadow: new fabric.Shadow({ color: "rgba(0,0,0,0.25)", blur: 6, offsetX: 2, offsetY: 3 }) });
    const txt = new fabric.Textbox("Note…", { width: w - 16 * scale, top: 8 * scale, left: 8 * scale, fontSize: 14 * scale, fill: "#713f12", fontFamily: "Helvetica" });
    const g = new fabric.Group([r, txt], { left: 80 * scale, top: 80 * scale });
    c.add(g); c.setActiveObject(g); setTool("select");
  };
  const addRect = () => {
    const c = fabricRef.current; if (!c) return;
    const r = new fabric.Rect({ left: 80 * scale, top: 80 * scale, width: 160 * scale, height: 100 * scale, fill: "transparent", stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale });
    c.add(r); c.setActiveObject(r); setTool("select");
  };
  const addCloud = () => {
    const c = fabricRef.current; if (!c) return;
    const w = 200 * scale, h = 120 * scale, r = 14 * scale;
    const bumps: fabric.Object[] = [];
    const step = r * 1.5;
    for (let x = 0; x <= w; x += step) {
      bumps.push(new fabric.Circle({ left: x - r, top: -r, radius: r, fill: "white", stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale }));
      bumps.push(new fabric.Circle({ left: x - r, top: h - r, radius: r, fill: "white", stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale }));
    }
    for (let y = 0; y <= h; y += step) {
      bumps.push(new fabric.Circle({ left: -r, top: y - r, radius: r, fill: "white", stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale }));
      bumps.push(new fabric.Circle({ left: w - r, top: y - r, radius: r, fill: "white", stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale }));
    }
    const g = new fabric.Group(bumps, { left: 100 * scale, top: 100 * scale });
    c.add(g); c.setActiveObject(g); setTool("select");
  };
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

  // ─── Drag-to-draw for line/arrow ──────────────────────────────────────
  const draftRef = useRef<fabric.Object | null>(null);

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    if (tool === "pan") {
      panRef.current = { panning: true, startX: e.clientX - panOffset.x, startY: e.clientY - panOffset.y };
      return;
    }
    if (tool === "eraser") {
      const pt = canvas.getScenePoint(e.nativeEvent);
      const target = canvas.getObjects().reverse().find((o) => o.containsPoint(pt));
      if (target) canvas.remove(target);
      return;
    }
    if (tool === "line" || tool === "arrow") {
      const pt = canvas.getScenePoint(e.nativeEvent);
      const line = new fabric.Line([pt.x, pt.y, pt.x, pt.y], {
        stroke: COLOR_HEX[color], strokeWidth: strokeWidth * scale, selectable: false,
      });
      canvas.add(line);
      draftRef.current = line;
    }
  };
  const onCanvasMouseMove = (e: React.MouseEvent) => {
    if (panRef.current.panning) {
      setPanOffset({ x: e.clientX - panRef.current.startX, y: e.clientY - panRef.current.startY });
      return;
    }
    const canvas = fabricRef.current;
    if (!canvas) return;
    if ((tool === "line" || tool === "arrow") && draftRef.current) {
      const pt = canvas.getScenePoint(e.nativeEvent);
      const ln = draftRef.current as fabric.Line;
      ln.set({ x2: pt.x, y2: pt.y });
      canvas.requestRenderAll();
    }
  };
  const onCanvasMouseUp = () => {
    panRef.current.panning = false;
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
      draftRef.current = null;
    }
  };

  // ─── Keyboard shortcuts ───────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); void undo(); return; }
      if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); void redo(); return; }
      if (e.key === "Escape") { setStampMenuOpen(false); setTool("select"); return; }
      if (e.key === "Delete" || e.key === "Backspace") {
        const act = fabricRef.current?.getActiveObject();
        if (act && (act.type === "i-text" || act.type === "textbox") && (act as any).isEditing) return;
        deleteSelected(); return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
  }, [isOpen, undo, redo]);

  // ─── Download / Print (original document, optionally stamped) ─────────
  const controlState = docRecord && currentUserId
    ? determineControlState(docRecord, currentUserId) : "uncontrolled";
  const isControlled = controlState === "controlled";

  const runDocAction = async (type: "download" | "print") => {
    if (!docRecord || !currentUserId) return;
    setActionBusy(true); setActionError(null);
    try {
      const ctx = { doc: docRecord, fileUrl: url, userId: currentUserId,
        userEmail: currentUserEmail ?? null, userLabel: currentUserEmail ?? null };
      if (type === "download") await downloadDocumentPdf(ctx);
      else await printDocumentPdf(ctx);
      setPending(null);
    } catch (e) {
      setActionError((e as Error).message || "Action failed");
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

  // ─── Download with markup baked in ────────────────────────────────────
  const downloadWithMarkup = async () => {
    if (!pdfBytes) return;
    setMarkupBusy(true); setMarkupError(null);
    try {
      saveCurrentPage();
      let currentNorm: any = null;
      if (fabricRef.current) currentNorm = normalize(fabricRef.current.toJSON(), scale);

      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();

      const states: Record<number, object> = { ...pageStates };
      if (currentNorm) states[currentPage] = currentNorm;

      for (const [k, st] of Object.entries(states)) {
        const pn = parseInt(k, 10);
        if (pn < 1 || pn > pages.length) continue;
        const page = pages[pn - 1];
        const { width, height } = page.getSize();
        const tempEl = window.document.createElement("canvas");
        const sc = new fabric.StaticCanvas(tempEl, { width: 1000, height: 1000 });
        await sc.loadFromJSON(st as any);
        sc.setDimensions({ width, height });
        sc.renderAll();
        const png = sc.toDataURL({ format: "png", multiplier: 2 });
        const pngBytes = await fetch(png).then((r) => r.arrayBuffer());
        const img = await pdfDoc.embedPng(pngBytes);
        page.drawImage(img, { x: 0, y: 0, width, height });
      }

      const bytes = await pdfDoc.save();
      const blob = new Blob([bytes as any], { type: "application/pdf" });
      const u = URL.createObjectURL(blob);
      const stem = `${docNumber || title || "document"}${rev ? `_Rev${rev}` : ""}_markup`.replace(/[^\w.\-]+/g, "_");
      const a = window.document.createElement("a");
      a.href = u; a.download = `${stem}.pdf`;
      window.document.body.appendChild(a); a.click(); window.document.body.removeChild(a);
      URL.revokeObjectURL(u);
    } catch (e) {
      console.error("Markup download failed", e);
      setMarkupError((e as Error).message || "Failed to export markup");
    } finally { setMarkupBusy(false); }
  };

  if (!isOpen) return null;

  const ToolBtn = ({ value, icon: Icon, label }: { value: Tool; icon: any; label: string }) => (
    <button onClick={() => setTool(value)} title={label}
      className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
        tool === value ? "bg-orange-600 text-white" : "text-slate-300 hover:text-white hover:bg-slate-700"
      }`}>
      <Icon className="w-5 h-5" />
    </button>
  );

  return (
    <div className="fixed inset-0 z-[100] bg-slate-900 flex flex-col" onMouseUp={onCanvasMouseUp} onMouseLeave={onCanvasMouseUp}>
      {/* ─── TOP CHROME ──────────────────────────────────────────────── */}
      <div className="h-14 px-3 bg-slate-900 border-b border-slate-800 flex items-center gap-3 shrink-0 z-50">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="min-w-0">
            <h2 className="text-white font-bold text-sm truncate">{title}</h2>
            <p className="text-slate-400 text-[10px] font-mono truncate">{docNumber} • Rev {rev || "—"}</p>
          </div>
          {docRecord && onCheckout && (
            <div className="pl-3 border-l border-slate-700 shrink-0">
              <CheckoutStatusCell docRecord={docRecord} currentUserId={currentUserId} currentUserEmail={currentUserEmail} userRole={userRole} onCheckout={onCheckout} />
            </div>
          )}
          {docRecord && currentUserId && (
            <div className={`hidden md:inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold ${
              isControlled ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                           : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
            }`}>
              {isControlled ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
              {isControlled ? "Controlled" : "Uncontrolled"}
            </div>
          )}
        </div>

        {/* Page nav */}
        <div className="flex items-center bg-slate-800 rounded-lg px-2 py-1 text-xs font-mono text-slate-300">
          <button onClick={() => goPage(currentPage - 1)} disabled={currentPage <= 1} className="p-1 hover:text-white disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
          <span className="mx-2">{currentPage} / {numPages || "—"}</span>
          <button onClick={() => goPage(currentPage + 1)} disabled={currentPage >= numPages} className="p-1 hover:text-white disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
        </div>
        {/* Zoom */}
        <div className="flex items-center bg-slate-800 rounded-lg px-2 py-1 text-xs font-mono text-slate-300">
          <button onClick={() => setZoom(scale - 0.25)} className="p-1 hover:text-white"><ZoomOut className="w-4 h-4" /></button>
          <span className="mx-2">{Math.round(scale * 100)}%</span>
          <button onClick={() => setZoom(scale + 0.25)} className="p-1 hover:text-white"><ZoomIn className="w-4 h-4" /></button>
        </div>

        {/* Download original (stamped if uncontrolled) */}
        <button onClick={requestDownload} disabled={!docRecord || !currentUserId || actionBusy}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
          title={isControlled ? "Download original PDF" : "Download stamped (uncontrolled) PDF"}>
          <Download className="w-3.5 h-3.5" /> Download
        </button>
        {/* Download with markup */}
        <button onClick={() => void downloadWithMarkup()} disabled={!pdfBytes || markupBusy}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-orange-600 hover:bg-orange-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
          title="Download a copy with your markups baked into the PDF">
          {markupBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">Download w/ Markup</span>
        </button>
        {/* Print */}
        <button onClick={requestPrint} disabled={!docRecord || !currentUserId || actionBusy}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Print PDF">
          <Printer className="w-3.5 h-3.5" /> Print
        </button>

        <button onClick={onClose} className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-full">
          <X className="w-5 h-5" />
        </button>
      </div>

      {markupError && <div className="bg-red-50 border-b border-red-200 text-red-700 text-xs px-4 py-2 font-mono">{markupError}</div>}

      {/* ─── BODY: Tool rail | Canvas ─────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex">
        {/* TOOL RAIL */}
        <div className="w-14 bg-slate-900 border-r border-slate-800 flex flex-col items-center py-2 gap-1 shrink-0">
          <ToolBtn value="select" icon={MousePointer2} label="Select (V)" />
          <ToolBtn value="pan" icon={Move} label="Pan (H)" />
          <div className="w-8 h-px bg-slate-800 my-1" />
          <ToolBtn value="pen" icon={Pen} label="Pen (P)" />
          <ToolBtn value="highlight" icon={Highlighter} label="Highlighter" />
          <ToolBtn value="line" icon={Minus} label="Line (L)" />
          <ToolBtn value="arrow" icon={ArrowUpRight} label="Arrow (A)" />
          <button onClick={addRect} className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-300 hover:text-white hover:bg-slate-700" title="Rectangle (R)"><Square className="w-5 h-5" /></button>
          <button onClick={addCloud} className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-300 hover:text-white hover:bg-slate-700" title="Rev Cloud"><Cloud className="w-5 h-5" /></button>
          <button onClick={addText} className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-300 hover:text-white hover:bg-slate-700" title="Text (T)"><Type className="w-5 h-5" /></button>
          <button onClick={addStickyNote} className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-300 hover:text-white hover:bg-slate-700" title="Sticky Note (N)"><StickyNote className="w-5 h-5" /></button>
          <div className="relative">
            <button onClick={() => setStampMenuOpen((v) => !v)} className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${stampMenuOpen ? "bg-orange-600 text-white" : "text-slate-300 hover:text-white hover:bg-slate-700"}`} title="Stamp"><StampIcon className="w-5 h-5" /></button>
            {stampMenuOpen && (
              <div className="absolute left-12 top-0 w-56 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl p-2 z-50">
                <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest px-2 pb-2">Stamps</div>
                <div className="grid grid-cols-1 gap-1">
                  {STAMPS.map((s) => (
                    <button key={s.label} onClick={() => addStamp(s.label, s.tone)} className="text-left px-2 py-1.5 rounded-md text-xs font-bold hover:bg-slate-800" style={{ color: COLOR_HEX[s.tone] }}>{s.label}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="w-8 h-px bg-slate-800 my-1" />
          <ToolBtn value="eraser" icon={Eraser} label="Eraser (E)" />
          <button onClick={deleteSelected} className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-300 hover:text-red-400 hover:bg-slate-700" title="Delete selected"><Trash2 className="w-5 h-5" /></button>
          <div className="w-8 h-px bg-slate-800 my-1" />
          <button onClick={() => void undo()} className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-300 hover:text-white hover:bg-slate-700" title="Undo (Ctrl+Z)"><Undo2 className="w-5 h-5" /></button>
          <button onClick={() => void redo()} className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-300 hover:text-white hover:bg-slate-700" title="Redo (Ctrl+Y)"><Redo2 className="w-5 h-5" /></button>
        </div>

        {/* PROPERTY BAR + CANVAS */}
        <div className="flex-1 flex flex-col">
          <div className="h-10 bg-slate-800/95 border-b border-slate-800 flex items-center px-3 gap-3 shrink-0">
            <div className="flex items-center gap-1.5">
              {(Object.keys(COLOR_HEX) as ColorKey[]).map((c) => (
                <button key={c} onClick={() => setColor(c)} className={`w-5 h-5 rounded-full border-2 transition-transform ${color === c ? "border-white scale-110" : "border-transparent hover:scale-105"}`} style={{ backgroundColor: COLOR_HEX[c] }} title={c} />
              ))}
            </div>
            <div className="w-px h-5 bg-slate-700" />
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Width</span>
              <input type="range" min={1} max={12} value={strokeWidth} onChange={(e) => setStrokeWidth(Number(e.target.value))} className="w-24 h-1 bg-slate-700 rounded-lg accent-orange-500 cursor-pointer" />
              <span className="text-[10px] font-mono text-slate-300 w-5 text-right">{strokeWidth}</span>
            </div>
            <div className="ml-auto text-[10px] text-slate-500 font-mono hidden md:block">
              Tip: V/H/P/L/A/R/T/N/E to switch tools — Ctrl+Z / Ctrl+Y to undo
            </div>
          </div>

          <div className={`flex-1 overflow-auto relative bg-slate-200 p-6 ${tool === "pan" ? "cursor-grab active:cursor-grabbing" : ""}`}
               onMouseDown={onCanvasMouseDown} onMouseMove={onCanvasMouseMove}>
            {/* Loading / Error overlay */}
            {fetchError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-red-700 bg-slate-100 p-8">
                <ShieldAlert className="w-12 h-12 text-red-400 mb-3" />
                <div className="text-sm font-bold mb-1">Failed to load PDF</div>
                <div className="text-xs font-mono text-slate-500 max-w-md text-center">{fetchError}</div>
              </div>
            )}
            {!fetchError && !pdfBytes && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500">
                <Loader2 className="w-10 h-10 animate-spin text-orange-500 mb-3" />
                <div className="text-xs font-mono">Loading PDF… {fetchPct}%</div>
                <div className="w-48 h-1.5 bg-slate-300 rounded-full mt-2 overflow-hidden">
                  <div className="h-full bg-orange-500 transition-all" style={{ width: `${fetchPct}%` }} />
                </div>
              </div>
            )}

            <div className="min-w-full min-h-full flex items-center justify-center will-change-transform"
                 style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px)` }}>
              <div className="relative shadow-2xl border border-slate-300 bg-white">
                <div className="relative z-0" style={{ pointerEvents: "none", userSelect: "none" }}>
                  {documentFile && (
                    <Document
                      file={documentFile}
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
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Uncontrolled-copy confirmation modal ────────────────────── */}
      {pending && (
        <div className="fixed inset-0 z-[110] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
              <div className="p-2 bg-amber-100 rounded-lg"><ShieldAlert className="w-5 h-5 text-amber-700" /></div>
              <div>
                <div className="text-sm font-black text-slate-900">Uncontrolled Copy</div>
                <div className="text-xs text-slate-500">You don&apos;t currently have this document checked out.</div>
              </div>
            </div>
            <div className="px-6 py-4 text-sm text-slate-700 space-y-3">
              <p>Continuing will produce an <b>uncontrolled copy</b>. Every page will be stamped with a diagonal &quot;UNCONTROLLED — FOR REVIEW ONLY&quot; watermark plus a footer with your email and the timestamp. The action will be logged to the audit trail.</p>
              {actionError && <p className="text-xs text-red-600 font-mono bg-red-50 border border-red-200 rounded-lg p-2">{actionError}</p>}
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button onClick={() => { setPending(null); setActionError(null); }} disabled={actionBusy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
              <button onClick={() => void runDocAction(pending.type)} disabled={actionBusy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60">
                {actionBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {pending.type === "download" ? "Download stamped copy" : "Print stamped copy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
