"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Pen,
  Highlighter,
  Type,
  Save,
  X,
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
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import * as fabric from "fabric";
import { PDFDocument } from "pdf-lib";

import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type Tool =
  | "select"
  | "pan"
  | "pen"
  | "highlight"
  | "line"
  | "arrow"
  | "rect"
  | "cloud"
  | "text"
  | "sticky"
  | "stamp"
  | "eraser";

type ColorKey = "red" | "blue" | "black" | "yellow" | "green" | "orange";

const COLOR_HEX: Record<ColorKey, string> = {
  red: "#dc2626",
  blue: "#2563eb",
  black: "#0f172a",
  yellow: "#facc15",
  green: "#16a34a",
  orange: "#ea580c",
};

const HIGHLIGHT_RGBA: Record<ColorKey, string> = {
  yellow: "rgba(250, 204, 21, 0.35)",
  red: "rgba(220, 38, 38, 0.35)",
  green: "rgba(22, 163, 74, 0.35)",
  blue: "rgba(37, 99, 235, 0.35)",
  black: "rgba(15, 23, 42, 0.30)",
  orange: "rgba(234, 88, 12, 0.35)",
};

// Standard QA/DC stamp set — text + tone. Custom stamps can extend later.
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

interface PdfMarkupEditorProps {
  isOpen: boolean;
  fileUrl: string;
  title: string;
  docNumber?: string;
  rev?: string;
  filename?: string;     // defaults to <title>_markup.pdf
  onClose: () => void;
}

export default function PdfMarkupEditor({
  isOpen,
  fileUrl,
  title,
  docNumber,
  rev,
  filename,
  onClose,
}: PdfMarkupEditorProps) {
  // PDF rendering
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);

  // Tool & styling
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<ColorKey>("red");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [stampMenuOpen, setStampMenuOpen] = useState(false);

  // Per-page normalized (PDF-coord) Fabric JSON
  const [pageStates, setPageStates] = useState<Record<number, object>>({});

  // Undo/redo per-page snapshot stacks (denormalized — current-screen state)
  const undoRef = useRef<Record<number, string[]>>({});
  const redoRef = useRef<Record<number, string[]>>({});
  const restoringRef = useRef(false);

  // Saving / progress
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Pan state
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const panRef = useRef({ panning: false, startX: 0, startY: 0 });

  // Fabric canvas
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);

  // Initialize Fabric
  useEffect(() => {
    if (!isOpen || !canvasRef.current) return;
    const canvas = new fabric.Canvas(canvasRef.current, {
      isDrawingMode: false,
      selection: true,
    });
    fabricRef.current = canvas;
    return () => {
      canvas.dispose();
      fabricRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // --- Snapshot / undo-redo ---
  const pushSnapshot = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas || restoringRef.current) return;
    const json = JSON.stringify(canvas.toJSON());
    const stack = undoRef.current[currentPage] ?? [];
    stack.push(json);
    if (stack.length > 100) stack.shift();
    undoRef.current[currentPage] = stack;
    redoRef.current[currentPage] = []; // any new edit clears redo
  }, [currentPage]);

  // Listen for object mutations to capture undo points
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const handler = () => pushSnapshot();
    canvas.on("object:added", handler);
    canvas.on("object:modified", handler);
    canvas.on("object:removed", handler);
    canvas.on("path:created", handler);
    return () => {
      canvas.off("object:added", handler);
      canvas.off("object:modified", handler);
      canvas.off("object:removed", handler);
      canvas.off("path:created", handler);
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
    try {
      await canvas.loadFromJSON(JSON.parse(prev));
      canvas.requestRenderAll();
    } finally {
      restoringRef.current = false;
    }
  }, [currentPage]);

  const redo = useCallback(async () => {
    const canvas = fabricRef.current;
    const stack = redoRef.current[currentPage] ?? [];
    if (!canvas || stack.length === 0) return;
    const next = stack.pop()!;
    undoRef.current[currentPage] = [...(undoRef.current[currentPage] ?? []), next];
    restoringRef.current = true;
    try {
      await canvas.loadFromJSON(JSON.parse(next));
      canvas.requestRenderAll();
    } finally {
      restoringRef.current = false;
    }
  }, [currentPage]);

  // --- Tool state on canvas ---
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    canvas.isDrawingMode = false;
    canvas.selection = false;
    canvas.defaultCursor = "default";
    canvas.hoverCursor = "move";

    if (tool === "pen") {
      canvas.isDrawingMode = true;
      const brush = new fabric.PencilBrush(canvas);
      brush.color = COLOR_HEX[color];
      brush.width = strokeWidth * scale;
      canvas.freeDrawingBrush = brush;
      canvas.defaultCursor = "crosshair";
      canvas.hoverCursor = "crosshair";
    } else if (tool === "highlight") {
      canvas.isDrawingMode = true;
      const brush = new fabric.PencilBrush(canvas);
      brush.color = HIGHLIGHT_RGBA[color];
      brush.width = 20 * scale;
      canvas.freeDrawingBrush = brush;
      canvas.defaultCursor = "crosshair";
      canvas.hoverCursor = "crosshair";
    } else if (tool === "select") {
      canvas.selection = true;
    } else if (tool === "pan") {
      canvas.defaultCursor = "grab";
      canvas.hoverCursor = "grab";
    } else if (tool === "eraser") {
      canvas.defaultCursor = "not-allowed";
      canvas.hoverCursor = "not-allowed";
    } else {
      canvas.defaultCursor = "crosshair";
      canvas.hoverCursor = "crosshair";
    }

    // Push style to selected object
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

  // --- Page state normalization (store at scale=1) ---
  const normalize = (json: any, currentScale: number) => {
    if (!json?.objects) return json;
    const inv = 1 / currentScale;
    const out = JSON.parse(JSON.stringify(json));
    out.objects.forEach((o: any) => {
      o.left *= inv;
      o.top *= inv;
      o.scaleX *= inv;
      o.scaleY *= inv;
    });
    return out;
  };
  const denormalize = (json: any, targetScale: number) => {
    if (!json?.objects) return json;
    const out = JSON.parse(JSON.stringify(json));
    out.objects.forEach((o: any) => {
      o.left *= targetScale;
      o.top *= targetScale;
      o.scaleX *= targetScale;
      o.scaleY *= targetScale;
    });
    return out;
  };

  const saveCurrentPage = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const json = canvas.toJSON();
    setPageStates((prev) => ({ ...prev, [currentPage]: normalize(json, scale) }));
  }, [currentPage, scale]);

  const onPageLoaded = (page: any) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const viewport = page.getViewport({ scale });
    canvas.setDimensions({ width: viewport.width, height: viewport.height });
    canvas.calcOffset();

    canvas.clear();
    const saved = pageStates[currentPage];
    if (saved) {
      canvas.loadFromJSON(denormalize(saved, scale)).then(() => {
        canvas.requestRenderAll();
        // seed undo with current state
        undoRef.current[currentPage] = [JSON.stringify(canvas.toJSON())];
        redoRef.current[currentPage] = [];
      });
    } else {
      undoRef.current[currentPage] = [JSON.stringify(canvas.toJSON())];
      redoRef.current[currentPage] = [];
    }
  };

  const goPage = (next: number) => {
    if (next < 1 || next > numPages) return;
    saveCurrentPage();
    setCurrentPage(next);
  };

  const setZoom = (next: number) => {
    saveCurrentPage();
    setScale(Math.min(3, Math.max(0.5, next)));
  };

  // --- Add primitive shapes ---
  const addText = () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const t = new fabric.IText("Text", {
      left: 60 * scale,
      top: 60 * scale,
      fontFamily: "Helvetica",
      fill: COLOR_HEX[color],
      fontSize: 20 * scale,
    });
    canvas.add(t);
    canvas.setActiveObject(t);
    setTool("select");
  };

  const addStickyNote = () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const w = 180 * scale;
    const h = 110 * scale;
    const rect = new fabric.Rect({
      width: w,
      height: h,
      fill: "rgba(254, 240, 138, 0.92)", // amber-200 ish
      stroke: "#ca8a04",
      strokeWidth: 1,
      rx: 6,
      ry: 6,
      shadow: new fabric.Shadow({ color: "rgba(0,0,0,0.25)", blur: 6, offsetX: 2, offsetY: 3 }),
    });
    const txt = new fabric.Textbox("Note…", {
      width: w - 16 * scale,
      top: 8 * scale,
      left: 8 * scale,
      fontSize: 14 * scale,
      fill: "#713f12",
      fontFamily: "Helvetica",
    });
    const group = new fabric.Group([rect, txt], { left: 80 * scale, top: 80 * scale });
    canvas.add(group);
    canvas.setActiveObject(group);
    setTool("select");
  };

  const addRect = () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const r = new fabric.Rect({
      left: 80 * scale,
      top: 80 * scale,
      width: 160 * scale,
      height: 100 * scale,
      fill: "transparent",
      stroke: COLOR_HEX[color],
      strokeWidth: strokeWidth * scale,
    });
    canvas.add(r);
    canvas.setActiveObject(r);
    setTool("select");
  };

  const addCloud = () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    // Simple scalloped rectangle approximated with overlapping circles around an
    // invisible rect. Good-enough rev-cloud for Wave A.
    const w = 200 * scale;
    const h = 120 * scale;
    const r = 14 * scale;
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
    const group = new fabric.Group(bumps, { left: 100 * scale, top: 100 * scale });
    canvas.add(group);
    canvas.setActiveObject(group);
    setTool("select");
  };

  const addStamp = (label: string, tone: ColorKey) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const txt = new fabric.Text(label, {
      fontFamily: "Helvetica",
      fontSize: 28 * scale,
      fontWeight: 900,
      fill: COLOR_HEX[tone],
      originX: "center",
      originY: "center",
    });
    const padX = 18 * scale;
    const padY = 8 * scale;
    const w = (txt.width ?? 0) + padX * 2;
    const h = (txt.height ?? 0) + padY * 2;
    const box = new fabric.Rect({
      width: w,
      height: h,
      fill: "transparent",
      stroke: COLOR_HEX[tone],
      strokeWidth: 3 * scale,
      originX: "center",
      originY: "center",
    });
    const group = new fabric.Group([box, txt], {
      left: 120 * scale,
      top: 120 * scale,
      angle: -8,
      opacity: 0.85,
    });
    canvas.add(group);
    canvas.setActiveObject(group);
    setStampMenuOpen(false);
    setTool("select");
  };

  const deleteSelected = () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const active = canvas.getActiveObjects();
    if (active.length) {
      canvas.discardActiveObject();
      active.forEach((o) => canvas.remove(o));
    }
  };

  // Drawing state for line/arrow/rect drag-to-draw
  const draftRef = useRef<fabric.Object | null>(null);
  const draftStartRef = useRef<{ x: number; y: number } | null>(null);

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    if (tool === "pan") {
      panRef.current = { panning: true, startX: e.clientX - panOffset.x, startY: e.clientY - panOffset.y };
      return;
    }

    if (tool === "eraser") {
      // delete topmost object under the cursor
      const pt = canvas.getScenePoint(e.nativeEvent);
      const target = canvas.getObjects().reverse().find((o) => o.containsPoint(pt));
      if (target) {
        canvas.remove(target);
      }
      return;
    }

    if (tool === "line" || tool === "arrow") {
      const pt = canvas.getScenePoint(e.nativeEvent);
      const line = new fabric.Line([pt.x, pt.y, pt.x, pt.y], {
        stroke: COLOR_HEX[color],
        strokeWidth: strokeWidth * scale,
        selectable: false,
      });
      canvas.add(line);
      draftRef.current = line;
      draftStartRef.current = { x: pt.x, y: pt.y };
      return;
    }

    if (tool === "rect" || tool === "cloud") return; // those use one-shot add buttons
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
      const line = draftRef.current as fabric.Line;
      line.set({ x2: pt.x, y2: pt.y });
      canvas.requestRenderAll();
    }
  };

  const onCanvasMouseUp = () => {
    panRef.current.panning = false;
    const canvas = fabricRef.current;
    if (!canvas) return;

    if ((tool === "line" || tool === "arrow") && draftRef.current && draftStartRef.current) {
      const line = draftRef.current as fabric.Line;
      line.set({ selectable: true });
      line.setCoords();

      if (tool === "arrow") {
        // Add a triangular head at the end pointing along the line
        const x1 = line.x1 ?? 0;
        const y1 = line.y1 ?? 0;
        const x2 = line.x2 ?? 0;
        const y2 = line.y2 ?? 0;
        const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
        const head = new fabric.Triangle({
          left: x2,
          top: y2,
          originX: "center",
          originY: "center",
          width: 14 * scale,
          height: 18 * scale,
          fill: COLOR_HEX[color],
          angle: angle + 90,
        });
        canvas.add(head);
      }

      draftRef.current = null;
      draftStartRef.current = null;
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const isMeta = e.ctrlKey || e.metaKey;
      if (isMeta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); void undo(); return; }
      if (isMeta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); void redo(); return; }
      if (e.key === "Escape") { setStampMenuOpen(false); setTool("select"); return; }
      if (e.key === "Delete" || e.key === "Backspace") {
        // only if the user isn't typing in a textbox
        const active = fabricRef.current?.getActiveObject();
        if (active && (active.type === "i-text" || active.type === "textbox") && (active as any).isEditing) return;
        deleteSelected();
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.toLowerCase() === "v") setTool("select");
      else if (e.key.toLowerCase() === "h") setTool("pan");
      else if (e.key.toLowerCase() === "p") setTool("pen");
      else if (e.key.toLowerCase() === "l") setTool("line");
      else if (e.key.toLowerCase() === "a") setTool("arrow");
      else if (e.key.toLowerCase() === "r") setTool("rect");
      else if (e.key.toLowerCase() === "t") addText();
      else if (e.key.toLowerCase() === "n") addStickyNote();
      else if (e.key.toLowerCase() === "e") setTool("eraser");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, undo, redo]);

  // --- Save: bake all annotations into PDF and download locally ---
  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      saveCurrentPage();

      // Use the freshest state for the current page directly from canvas
      let currentNorm: any = null;
      if (fabricRef.current) currentNorm = normalize(fabricRef.current.toJSON(), scale);

      const existing = await fetch(fileUrl).then((r) => r.arrayBuffer());
      const pdfDoc = await PDFDocument.load(existing);
      const pages = pdfDoc.getPages();

      const states: Record<number, object> = { ...pageStates };
      if (currentNorm) states[currentPage] = currentNorm;

      for (const [pageNumStr, st] of Object.entries(states)) {
        const pageNum = parseInt(pageNumStr, 10);
        if (pageNum < 1 || pageNum > pages.length) continue;
        const page = pages[pageNum - 1];
        const { width, height } = page.getSize();

        const tempEl = document.createElement("canvas");
        const sc = new fabric.StaticCanvas(tempEl, { width: 1000, height: 1000 });
        await sc.loadFromJSON(st as any);
        sc.setDimensions({ width, height });
        sc.renderAll();

        const png = sc.toDataURL({ format: "png", multiplier: 2 });
        const pngBytes = await fetch(png).then((r) => r.arrayBuffer());
        const pngImg = await pdfDoc.embedPng(pngBytes);
        page.drawImage(pngImg, { x: 0, y: 0, width, height });
      }

      const bytes = await pdfDoc.save();
      const blob = new Blob([bytes as any], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const stem = (filename || `${docNumber || title || "document"}${rev ? `_Rev${rev}` : ""}_markup`).replace(/[^\w.\-]+/g, "_");
      const safeName = stem.endsWith(".pdf") ? stem : `${stem}.pdf`;

      const a = document.createElement("a");
      a.href = url;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Markup save failed", e);
      setSaveError((e as Error).message || "Failed to save");
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  const ToolBtn = ({ value, icon: Icon, label }: { value: Tool; icon: any; label: string }) => (
    <button
      onClick={() => setTool(value)}
      className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
        tool === value ? "bg-orange-600 text-white" : "text-slate-300 hover:text-white hover:bg-slate-700"
      }`}
      title={label}
    >
      <Icon className="w-5 h-5" />
    </button>
  );

  return (
    <div className="fixed inset-0 z-[200] bg-slate-200 flex flex-col" onMouseUp={onCanvasMouseUp} onMouseLeave={onCanvasMouseUp}>
      {/* TOP BAR */}
      <div className="h-14 bg-slate-900 flex items-center justify-between px-3 shrink-0 border-b border-slate-800 z-50">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-orange-400 text-[10px] font-black uppercase tracking-widest hidden md:block">Markup</span>
          <div className="text-white font-bold text-sm truncate">{title}</div>
          {docNumber && <span className="text-slate-400 text-xs font-mono whitespace-nowrap">{docNumber} • Rev {rev || "—"}</span>}
        </div>

        <div className="flex items-center gap-2">
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

          <button
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-lg shadow disabled:opacity-50"
          >
            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save PDF
          </button>

          <button onClick={onClose} className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {saveError && (
        <div className="bg-red-50 border-b border-red-200 text-red-700 text-xs px-4 py-2 font-mono">{saveError}</div>
      )}

      {/* WORKSPACE */}
      <div className="flex-1 overflow-hidden flex">
        {/* LEFT TOOL RAIL */}
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
            <button
              onClick={() => setStampMenuOpen((v) => !v)}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${stampMenuOpen ? "bg-orange-600 text-white" : "text-slate-300 hover:text-white hover:bg-slate-700"}`}
              title="Stamp"
            >
              <StampIcon className="w-5 h-5" />
            </button>
            {stampMenuOpen && (
              <div className="absolute left-12 top-0 w-56 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl p-2 z-50">
                <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest px-2 pb-2">Stamps</div>
                <div className="grid grid-cols-1 gap-1">
                  {STAMPS.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => addStamp(s.label, s.tone)}
                      className="text-left px-2 py-1.5 rounded-md text-xs font-bold hover:bg-slate-800 text-slate-200"
                      style={{ color: COLOR_HEX[s.tone] }}
                    >
                      {s.label}
                    </button>
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

        {/* TOP PROPERTY BAR + CANVAS */}
        <div className="flex-1 flex flex-col">
          {/* Property bar */}
          <div className="h-10 bg-slate-800/95 border-b border-slate-800 flex items-center px-3 gap-3 shrink-0">
            <div className="flex items-center gap-1.5">
              {(Object.keys(COLOR_HEX) as ColorKey[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-5 h-5 rounded-full border-2 transition-transform ${color === c ? "border-white scale-110" : "border-transparent hover:scale-105"}`}
                  style={{ backgroundColor: COLOR_HEX[c] }}
                  title={c}
                />
              ))}
            </div>
            <div className="w-px h-5 bg-slate-700" />
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Width</span>
              <input
                type="range"
                min={1}
                max={12}
                value={strokeWidth}
                onChange={(e) => setStrokeWidth(Number(e.target.value))}
                className="w-24 h-1 bg-slate-700 rounded-lg accent-orange-500 cursor-pointer"
              />
              <span className="text-[10px] font-mono text-slate-300 w-5 text-right">{strokeWidth}</span>
            </div>
          </div>

          {/* Canvas + PDF */}
          <div
            className={`flex-1 overflow-hidden relative p-6 ${tool === "pan" ? "cursor-grab active:cursor-grabbing" : ""}`}
            onMouseDown={onCanvasMouseDown}
            onMouseMove={onCanvasMouseMove}
          >
            <div
              className="min-w-full min-h-full flex items-center justify-center will-change-transform"
              style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px)` }}
            >
              <div className="relative shadow-2xl border border-slate-300 bg-white">
                <div className="relative z-0" style={{ pointerEvents: "none", userSelect: "none" }}>
                  <Document file={fileUrl} onLoadSuccess={({ numPages }) => setNumPages(numPages)} className="block">
                    <Page
                      pageNumber={currentPage}
                      scale={scale}
                      onRenderSuccess={onPageLoaded}
                      renderAnnotationLayer={false}
                      renderTextLayer={false}
                      className="block"
                    />
                  </Document>
                </div>
                <div className="absolute top-0 left-0 z-[50]" style={{ width: "100%", height: "100%" }}>
                  <canvas ref={canvasRef} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
