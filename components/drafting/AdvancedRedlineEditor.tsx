"use client";

import React, { useEffect, useRef, useState } from 'react';
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
  RotateCcw,
  AlertTriangle,
  Minus // For Line Tool
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import { PDF_DOC_OPTIONS } from "@/lib/pdfjsConfig";
import * as fabric from 'fabric'; 
import { PDFDocument } from 'pdf-lib';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { appConfirm } from "@/components/providers/DialogProvider";
import { useDraft } from "@/hooks/useDraft";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { friendlyError } from "@/lib/friendlyError";
import { vDim, vPanel, vKicker, vIcon, vTool, vGroup, vPrimary, vClose, vNote } from "@/components/viewers/viewerChrome";

// Configure PDF Worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type Tool = 'select' | 'pan' | 'pen' | 'highlight' | 'text' | 'line';
type Color = 'red' | 'blue' | 'black' | 'yellow' | 'green';

// Serialized fabric canvas shape we touch when re-scaling annotations between
// screen pixels and PDF points. Only the geometry fields are read/written.
type RedlineCanvasObject = { left: number; top: number; scaleX: number; scaleY: number; [k: string]: unknown };
type RedlineCanvasJson = { objects?: RedlineCanvasObject[]; [k: string]: unknown };
// The slice of react-pdf's page proxy we actually call.
type PdfPageProxy = { getViewport(opts: { scale: number }): { width: number; height: number } };

// Pure colour lookups, hoisted to module scope so the tool effect can reference
// them without a use-before-declaration (and so they aren't recreated per render).
function getColorHex(c: Color) {
  switch (c) {
    case 'red': return '#dc2626';
    case 'blue': return '#2563eb';
    case 'black': return '#000000';
    case 'green': return '#16a34a';
    case 'yellow': return '#facc15';
  }
}

function getHighlightColor(c: Color) {
  switch (c) {
    case 'yellow': return 'rgba(250, 204, 21, 0.35)';
    case 'red': return 'rgba(220, 38, 38, 0.35)';
    case 'green': return 'rgba(22, 163, 74, 0.35)';
    case 'blue': return 'rgba(37, 99, 235, 0.35)';
    default: return 'rgba(0,0,0,0.35)';
  }
}

export default function AdvancedRedlineEditor({ fileUrl, onClose, onSave, isSaving }: {
  fileUrl: string; 
  onClose: () => void; 
  onSave: (blob: Blob) => Promise<void>;
  isSaving: boolean;
}) {
  // --- STATE ---
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.2);
  
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState<Color>('red');
  const [strokeWidth, setStrokeWidth] = useState<number>(3);
  const [activeLine, setActiveLine] = useState<fabric.Line | null>(null); // For tracking line drawing
  
  const [pageStates, setPageStates] = useState<Record<number, RedlineCanvasJson>>({});
  // Synchronous mirror of pageStates. setState is async, but onPageLoadSuccess
  // (fired by react-pdf on every zoom / page change) and handleSave both need
  // the JUST-saved page state immediately — reading React state there raced
  // the commit and loaded stale or empty annotations (so markups appeared to
  // jump or vanish on zoom). The ref is the source of truth; state mirrors it
  // for renders.
  const pageStatesRef = useRef<Record<number, RedlineCanvasJson>>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);
  
  // A save that couldn't happen, said here in the editor (not in a popup).
  const [saveMsg, setSaveMsg] = useState<{ tone: "info" | "bad"; text: string } | null>(null);
  const pageReadyRef = useRef(false);
  const [restoredSeen, setRestoredSeen] = useState(false);

  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // --- INITIALIZE FABRIC ---
  useEffect(() => {
    if (!canvasRef.current) return;

    // Initialize Fabric
    const canvas = new fabric.Canvas(canvasRef.current, {
      isDrawingMode: false,
      selection: true,
    });
    
    fabricRef.current = canvas;

    // Selection Events
    canvas.on('selection:created', () => setTool('select'));

    return () => {
      canvas.dispose();
      fabricRef.current = null;
    };
  }, []);

  // --- HELPER: STATE NORMALIZATION ---
  // We store all page states at Scale 1.0 (PDF Point coordinates).
  // When saving (from screen), we divide by current scale.
  // When loading (to screen), we multiply by current scale.
  
  const normalizeState = (json: RedlineCanvasJson, currentScale: number): RedlineCanvasJson => {
    if (!json || !json.objects) return json;
    const inv = 1 / currentScale;
    const normalized = JSON.parse(JSON.stringify(json)) as RedlineCanvasJson; // Deep copy
    normalized.objects?.forEach((obj) => {
       obj.left *= inv;
       obj.top *= inv;
       obj.scaleX *= inv;
       obj.scaleY *= inv;
       // We don't scale strokeWidth or fontSize here because they are properties
       // of the object which is now scaled down by scaleX/scaleY.
       // E.g. fontSize 20 with scaleX 0.5 renders as 10.
    });
    return normalized;
  };

  const denormalizeState = (json: RedlineCanvasJson, targetScale: number): RedlineCanvasJson => {
    if (!json || !json.objects) return json;
    const denormalized = JSON.parse(JSON.stringify(json)) as RedlineCanvasJson; // Deep copy
    denormalized.objects?.forEach((obj) => {
       obj.left *= targetScale;
       obj.top *= targetScale;
       obj.scaleX *= targetScale;
       obj.scaleY *= targetScale;
    });
    return denormalized;
  };

  const saveCurrentPageState = () => {
    if (fabricRef.current) {
      const json = fabricRef.current.toJSON();
      const normalized = normalizeState(json, scale);
      const next = { ...pageStatesRef.current, [currentPage]: normalized };
      pageStatesRef.current = next;   // synchronous source of truth
      setPageStates(next);            // mirror into React state for renders
    }
  };

  // --- AUTOSAVE ---
  // Every mark (and any note typed on the sheet) is kept on this device as
  // you go, so a reload or a closed tab doesn't lose it. It comes back the
  // next time this file is opened for redlines, and is cleared once saved.
  const draftKey = fileUrl ? `redline:${fileUrl.split('?')[0]}` : null;
  const hasObjects = (v: Record<number, RedlineCanvasJson>) =>
    Object.values(v).some((st) => Array.isArray(st?.objects) && st.objects.length > 0);
  const draft = useDraft<Record<number, RedlineCanvasJson>>(
    draftKey,
    pageStates,
    (v) => {
      pageStatesRef.current = v;
      setPageStates(v);
      // The sheet may already be on screen: draw the restored marks on it now.
      const canvas = fabricRef.current;
      const st = v[currentPage];
      if (canvas && pageReadyRef.current && st) {
        pageReadyRef.current = false;
        canvas.loadFromJSON(denormalizeState(st, scale))
          .then(() => canvas.requestRenderAll())
          .catch(() => undefined)
          .finally(() => { pageReadyRef.current = true; });
      }
    },
    (v) => !hasObjects(v),
  );
  // Keep the saved copy current: after each mark, and while typing on the sheet.
  const syncRef = useRef<() => void>(() => {});
  useEffect(() => {
    syncRef.current = () => {
      if (!pageReadyRef.current) return;
      saveCurrentPageState();
      setSaveMsg((m) => (m?.tone === 'info' ? null : m)); // "no marks yet" is answered
    };
  });
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const h = () => {
      if (!pageReadyRef.current) return; // a page loading or turning, not a mark
      clearTimeout(t); t = setTimeout(() => syncRef.current(), 250);
    };
    const evs = ['object:added', 'object:modified', 'object:removed', 'path:created', 'text:changed', 'text:editing:exited'] as const;
    evs.forEach((ev) => canvas.on(ev, h));
    return () => { clearTimeout(t); evs.forEach((ev) => canvas.off(ev, h)); };
  }, []);

  // --- TOOL STATE MANAGEMENT ---
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    // Reset Defaults
    canvas.isDrawingMode = false;
    canvas.selection = false;
    canvas.defaultCursor = 'default';
    canvas.hoverCursor = 'move';

    if (tool === 'pen' || tool === 'highlight') {
      canvas.isDrawingMode = true;
      const brush = new fabric.PencilBrush(canvas);
      brush.color = tool === 'highlight' ? getHighlightColor(color) : getColorHex(color);
      // Scale brush width so it draws consistently relative to document
      brush.width = (tool === 'highlight' ? 20 : strokeWidth) * scale;
      canvas.freeDrawingBrush = brush;
      canvas.defaultCursor = 'crosshair';
      canvas.hoverCursor = 'crosshair';
    } else if (tool === 'line') {
      canvas.selection = false;
      canvas.defaultCursor = 'crosshair';
      canvas.hoverCursor = 'crosshair';
    } else if (tool === 'select') {
      canvas.selection = true;
    } else if (tool === 'pan') {
      canvas.defaultCursor = 'grab';
      canvas.hoverCursor = 'grab';
    }

    // Apply properties to selected object
    const activeObj = canvas.getActiveObject();
    if (activeObj && tool === 'select') {
       if (activeObj.type === 'i-text' || activeObj.type === 'text') {
         activeObj.set({ fill: getColorHex(color) });
       } else {
         activeObj.set({ stroke: getColorHex(color), strokeWidth: strokeWidth * scale });
       }
       canvas.requestRenderAll();
    }

  }, [tool, color, strokeWidth, scale]); // Added scale dependency

  // --- HANDLING PAGE RENDERING ---
  const onPageLoadSuccess = (page: PdfPageProxy) => {
    const canvas = fabricRef.current;
    if (!canvas) {
      console.warn("Fabric canvas not ready during page load.");
      return;
    }

    const viewport = page.getViewport({ scale });
    console.log("Resizing Fabric to:", viewport.width, viewport.height);

    // 1. Resize Fabric Internal State
    canvas.setDimensions({ width: viewport.width, height: viewport.height });
    
    // 2. Force CSS Styles on the wrapper element to match (Fabric handles the canvas tag)
    canvas.calcOffset();
    // Until this page's marks are back on the canvas, the canvas and the saved
    // states disagree: the autosave waits (it would save a half-loaded page).
    pageReadyRef.current = false;
    
    // Load JSON state for this page if exists. Read the synchronous ref first
    // — React state may not have committed the save that immediately preceded
    // this re-render (zoom / page change), which is what corrupted markups.
    const savedState = pageStatesRef.current[currentPage] ?? pageStates[currentPage];
    canvas.clear();
    if (savedState) {
      console.log(`Loading saved state for page ${currentPage} at scale ${scale}`, savedState);
      // Saved state is normalized (Scale 1.0). We need to scale it up to current 'scale'.
      const stateToLoad = denormalizeState(savedState, scale);
      canvas.loadFromJSON(stateToLoad).then(() => {
        console.log("State loaded successfully. Rendering...");
        canvas.requestRenderAll();
        pageReadyRef.current = true;
      }).catch(err => {
        console.error("Error loading fabric state:", err);
        pageReadyRef.current = true;
      });
    } else {
        console.log(`No saved state for page ${currentPage}.`);
        pageReadyRef.current = true;
    }
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || (numPages && newPage > numPages) || newPage === currentPage) return;
    saveCurrentPageState(); // Save current page before switch
    pageReadyRef.current = false; // the canvas holds the old page until the new one renders
    setCurrentPage(newPage);
  };

  // --- ZOOM HANDLING ---
  const handleZoom = (newScale: number) => {
    if (newScale === scale) return;
    saveCurrentPageState(); // Save current page before zoom
    pageReadyRef.current = false; // the canvas holds the old scale until the page re-renders
    setScale(newScale);
  };

  // --- ACTIONS ---
  const addText = () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const text = new fabric.IText('Text', {
      left: 50 * scale,
      top: 50 * scale,
      fontFamily: 'Helvetica',
      fill: getColorHex(color),
      fontSize: 20 * scale // Scale initial font size
    });
    canvas.add(text);
    canvas.setActiveObject(text);
    setTool('select');
  };

  const deleteSelected = () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const active = canvas.getActiveObjects();
    if (active.length) {
      canvas.discardActiveObject();
      active.forEach(obj => canvas.remove(obj));
    }
  };

  // --- MOUSE LOGIC (PAN & LINE) ---
  const handleMouseDown = (e: React.MouseEvent) => {
    if (tool === 'pan') {
      setIsPanning(true);
      setDragStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
    } else if (tool === 'line') {
      const canvas = fabricRef.current;
      if (!canvas) return;
      const pointer = canvas.getScenePoint(e.nativeEvent); // Fabric v6+
      const points: [number, number, number, number] = [pointer.x, pointer.y, pointer.x, pointer.y];
      const line = new fabric.Line(points, {
        strokeWidth: strokeWidth * scale, // Scale stroke width
        fill: getColorHex(color),
        stroke: getColorHex(color),
        originX: 'center',
        originY: 'center',
        selectable: false // Not selectable while drawing
      });
      canvas.add(line);
      setActiveLine(line);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPanOffset({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    } else if (tool === 'line' && activeLine) {
      const canvas = fabricRef.current;
      if (!canvas) return;
      const pointer = canvas.getScenePoint(e.nativeEvent); // Fabric v6+
      activeLine.set({ x2: pointer.x, y2: pointer.y });
      canvas.requestRenderAll();
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
    if (tool === 'line' && activeLine) {
      const canvas = fabricRef.current;
      if (canvas) {
        activeLine.setCoords(); // Finalize position
        activeLine.set('selectable', true); // Make editable after drawing
      }
      setActiveLine(null);
      syncRef.current(); // the line's end point is set without an event
    }
  };

  // --- SAVE ---
  const handleSave = async () => {
    // Save current page state
    saveCurrentPageState();

    // Since pageStates is updated asynchronously via setState in saveCurrentPageState, 
    // we should use the updated value. However, react state updates aren't immediate.
    // For safety, we can construct the latest state manually for the current page here.
    // But pageStates ref might be stale.
    // Actually, saveCurrentPageState calls setPageStates. 
    // To be safe, we can read the *latest* canvas state for the current page directly from canvas,
    // normalize it, and use that for the current page in the loop.
    
    let currentNormalizedState = null;
    if(fabricRef.current) {
        currentNormalizedState = normalizeState(fabricRef.current.toJSON(), scale);
    }

    setSaveMsg(null);
    const anyMarks = hasObjects(pageStatesRef.current) || (fabricRef.current?.getObjects().length ?? 0) > 0;
    if (!anyMarks) {
      setSaveMsg({ tone: "info", text: "There are no marks to save yet. Draw on the sheet first." });
      return;
    }

    try {
      const existingPdfBytes = await fetch(fileUrl).then(res => res.arrayBuffer());
      const pdfDoc = await PDFDocument.load(existingPdfBytes);
      const pages = pdfDoc.getPages();

      // Merge current state into a local map for processing (ref = source of
      // truth across ALL pages, not just the current one).
      const statesToProcess = { ...pageStatesRef.current };
      if (currentNormalizedState) {
          statesToProcess[currentPage] = currentNormalizedState;
      }

      for (const [pageNumStr, fabricState] of Object.entries(statesToProcess)) {
        const pageNum = parseInt(pageNumStr);
        if (pageNum > pages.length) continue;
        
        const page = pages[pageNum - 1];
        const { width, height } = page.getSize(); 

        // Use a temporary static canvas to rasterize
        const tempCanvasEl = document.createElement('canvas');
        const staticCanvas = new fabric.StaticCanvas(tempCanvasEl, { width: 1000, height: 1000 });
        
        await new Promise<void>((resolve, reject) => {
            // Load the NORMALIZED (Scale 1.0) state
            // And render it onto a canvas of Scale 1.0 (PDF size)
            staticCanvas.loadFromJSON(fabricState).then(() => {
                staticCanvas.setDimensions({ width, height });
                staticCanvas.renderAll();
                resolve();
            }).catch(reject);
        });

        // Use high-res output
        const pngDataUrl = staticCanvas.toDataURL({ format: 'png', multiplier: 2 });
        const pngImageBytes = await fetch(pngDataUrl).then(res => res.arrayBuffer());
        const pngImage = await pdfDoc.embedPng(pngImageBytes);

        page.drawImage(pngImage, {
            x: 0,
            y: 0,
            width: width,
            height: height,
        });
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
      await onSave(blob);
      draft.clear(); // saved: the copy kept on this device is done with

    } catch (e) {
      console.error("Save Failed:", e);
      setSaveMsg({ tone: "bad", text: `The redlines weren't saved. ${friendlyError(e)} Your marks are still here.` });
    }
  };

  // Start over: wipe the marks on every page (and the copy kept on this device).
  const startOver = async () => {
    if (!(await appConfirm({ title: "Start over?", message: "All your marks on this file are removed.", tone: "danger", confirmLabel: "Start over" }))) return;
    fabricRef.current?.clear();
    pageStatesRef.current = {};
    setPageStates({});
    draft.clear();
    setSaveMsg(null);
  };

  // Closing never drops marks without asking.
  const hasMarks = () =>
    (fabricRef.current?.getObjects().length ?? 0) > 0 ||
    Object.values(pageStatesRef.current).some((st) => {
      const objs = (st as { objects?: unknown[] }).objects;
      return Array.isArray(objs) && objs.length > 0;
    });
  const requestClose = async () => {
    if (isSaving) return;
    if (hasMarks()) {
      if (!(await appConfirm({ title: "Close without saving?", message: "Your marks on this file will be lost.", tone: "danger", confirmLabel: "Close" }))) return;
      draft.clear();
    }
    onClose();
  };
  // Escape closes the editor (asking first if there are marks). It shares the
  // dialog stack: with that question open, Escape closes only the question.
  useEscapeClose(() => {
    const active = document.activeElement;
    // Typing a note on the sheet: Escape ends the typing, not the editor.
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) { active.blur(); return; }
    void requestClose();
  });
  // The arrow keys turn the page (left goes back a page).
  const pageKeyRef = useRef<(d: number) => void>(() => {});
  useEffect(() => { pageKeyRef.current = (d) => handlePageChange(currentPage + d); });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-redline-editor])')) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); pageKeyRef.current(-1); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); pageKeyRef.current(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A friendly name for the file: its name from the link, minus the upload stamp.
  const fileName = (() => {
    try {
      const last = decodeURIComponent(fileUrl.split('?')[0].split('/').pop() || '');
      return last.replace(/^\d{10,}_/, '') || 'Drawing';
    } catch { return 'Drawing'; }
  })();
  const markCount = Object.entries(pageStates).reduce((n, [, st]) => n + (st?.objects?.length ?? 0), 0);

  const toolBtn = (value: Tool, Icon: typeof Pen, label: string) => (
    <button type="button" onClick={() => setTool(value)} className={vTool(tool === value, 'w-9 h-9')} title={label} aria-label={label} aria-pressed={tool === value}>
      <Icon className="w-[18px] h-[18px]" />
    </button>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Mark up the drawing"
      data-redline-editor
      className="fixed inset-0 z-[200]"
      onMouseUp={handleMouseUp} // Global mouse up for dragging safety
      onMouseLeave={handleMouseUp}
    >
      {/* The page behind stays in view at the edges, dimmed. */}
      <div className={vDim} aria-hidden="true" />

      <div className={vPanel}>
        {/* TOOL BAR: charcoal. Tools are quiet; the chosen one is a white pill.
            One orange action (Save), and the X. */}
        <header className="shrink-0 z-50 border-b border-[var(--color-border)] px-3 sm:px-5 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-[calc(100%-200px)] xl:basis-auto xl:max-w-[260px]">
            <div className={vKicker}>Redline{markCount > 0 ? ` · ${markCount} mark${markCount === 1 ? '' : 's'}` : ''}</div>
            <div className="truncate text-[15px] font-bold text-[var(--color-text)]" title={fileName}>{fileName}</div>
          </div>

          <div className="xl:order-last flex items-center gap-2 shrink-0">
            <button type="button" onClick={handleSave} disabled={isSaving} className={vPrimary}>
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {isSaving ? 'Saving' : 'Save'}
            </button>
            <button type="button" onClick={() => void requestClose()} disabled={isSaving} aria-label="Close" title="Close (Esc)" className={vClose}><X className="w-5 h-5" /></button>
          </div>

          <div className="w-full xl:w-auto xl:flex-1 flex flex-wrap items-center gap-2 min-w-0">
            {/* Tools */}
            <div className={`${vGroup} px-0.5 gap-0.5`} role="toolbar" aria-label="Markup tools">
              {toolBtn('select', MousePointer2, 'Select marks')}
              {toolBtn('pan', Move, 'Move the sheet')}
              <div className="w-px h-5 bg-[var(--color-ink-line)] mx-0.5" aria-hidden="true" />
              {toolBtn('pen', Pen, 'Pen')}
              {toolBtn('line', Minus, 'Straight line')}
              {toolBtn('highlight', Highlighter, 'Highlighter')}
              <button type="button" onClick={addText} className={vTool(false, 'w-9 h-9')} title="Add text" aria-label="Add text"><Type className="w-[18px] h-[18px]" /></button>
              <button type="button" onClick={deleteSelected} className="w-9 h-9 shrink-0 rounded-[10px] grid place-items-center text-[var(--color-text-muted)] hover:text-rose-400 hover:bg-[var(--color-ink-2)] transition-colors" title="Delete what's selected" aria-label="Delete what's selected"><Trash2 className="w-[18px] h-[18px]" /></button>
            </div>

            {/* Pen color (the markup colors on the sheet) and line width */}
            <div className={`${vGroup} px-2 gap-2`}>
              <div className="flex gap-1.5" role="radiogroup" aria-label="Pen color">
                {(['red', 'blue', 'black', 'yellow', 'green'] as Color[]).map(c => (
                  <button
                    type="button"
                    key={c}
                    onClick={() => setColor(c)}
                    role="radio"
                    aria-label={`${c} pen`}
                    aria-checked={color === c}
                    className={`w-5 h-5 rounded-full border-2 ring-1 ring-[var(--color-ink-line)] transition-transform ${color === c ? 'border-[var(--color-ink-fg)] scale-110' : 'border-transparent hover:scale-105'}`}
                    style={{ backgroundColor: getColorHex(c) }}
                  />
                ))}
              </div>
              <div className="w-px h-5 bg-[var(--color-ink-line)]" aria-hidden="true" />
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                value={strokeWidth}
                onChange={(e) => setStrokeWidth(Number(e.target.value))}
                className="w-16 h-1 rounded-lg cursor-pointer accent-[var(--color-ink-fg)]"
                title={`Line width: ${strokeWidth}px`}
                aria-label="Line width"
              />
            </div>

            <div className="flex-1 max-xl:hidden" />

            {/* Zoom */}
            <div className={vGroup}>
              <button type="button" onClick={() => handleZoom(Math.max(0.5, scale - 0.25))} aria-label="Zoom out" title="Zoom out" className={vIcon}><ZoomOut className="w-4 h-4"/></button>
              <span className="px-0.5 min-w-[2.75rem] text-center">{(scale * 100).toFixed(0)}%</span>
              <button type="button" onClick={() => handleZoom(Math.min(3, scale + 0.25))} aria-label="Zoom in" title="Zoom in" className={vIcon}><ZoomIn className="w-4 h-4"/></button>
            </div>

            {/* Pages: left goes back a page (the arrow keys too) */}
            <div className={vGroup}>
              <button type="button" onClick={() => handlePageChange(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page" title="Previous page (Left arrow)" className={vIcon}><ChevronLeft className="w-4 h-4"/></button>
              <span className="px-1 min-w-[3.25rem] text-center" aria-live="polite">{currentPage} / {numPages || '-'}</span>
              <button type="button" onClick={() => handlePageChange(currentPage + 1)} disabled={!numPages || currentPage >= numPages} aria-label="Next page" title="Next page (Right arrow)" className={vIcon}><ChevronRight className="w-4 h-4"/></button>
            </div>
          </div>
        </header>

        {/* What happened, said here: a save that couldn't go, or marks brought back. */}
        {saveMsg ? (
          <p role="alert" className={`${vNote} ${saveMsg.tone === 'bad' ? 'text-rose-300' : 'text-[var(--color-text)]'}`}>
            {saveMsg.tone === 'bad' && <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
            <span className="min-w-0">{saveMsg.text}</span>
            <button type="button" onClick={() => setSaveMsg(null)} aria-label="Dismiss" className="ml-auto shrink-0 w-7 h-7 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]"><X className="w-3.5 h-3.5" /></button>
          </p>
        ) : draft.restored && !restoredSeen && markCount > 0 ? (
          <p className={`${vNote} text-[var(--color-text)]`}>
            <RotateCcw className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
            <span className="min-w-0">Your marks from last time are back. They were kept on this device.</span>
            <button type="button" onClick={() => void startOver()} className="ml-auto shrink-0 h-7 px-2.5 rounded-lg bg-[var(--color-ink-2)] hover:bg-[var(--color-ink-line)] text-[13px] font-bold">Start over</button>
            <button type="button" onClick={() => setRestoredSeen(true)} aria-label="Dismiss" className="shrink-0 w-7 h-7 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]"><X className="w-3.5 h-3.5" /></button>
          </p>
        ) : null}

        {/* WORKSPACE AREA */}
        <div
          className={`flex-1 min-h-0 overflow-hidden bg-[var(--color-surface)] relative p-4 sm:p-8 ${tool === 'pan' ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
        >
          {/* CENTERED CONTENT WRAPPER WITH TRANSFORM */}
          <div
            className="min-w-full min-h-full flex items-center justify-center transition-transform duration-75 ease-out will-change-transform"
            style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px)` }}
          >
            <div className="relative shadow-2xl shadow-black/40 bg-white">
               {/* 1. PDF LAYER (Background) */}
               {/* We use !important styles to ensure nothing in react-pdf captures events */}
               <div className="relative z-0" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                 <Document options={PDF_DOC_OPTIONS}
                   file={fileUrl}
                   onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                   loading={<div className="w-[min(80vw,720px)] h-[60vh] grid place-items-center bg-[var(--color-surface)] text-[var(--color-text-muted)] text-[13px]"><span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Opening the sheet</span></div>}
                   error={<div role="alert" className="w-[min(80vw,720px)] h-[40vh] grid place-items-center bg-[var(--color-surface)] text-rose-300 text-[13px] font-semibold px-6 text-center">Couldn&apos;t open this file for redlines. Close and try again.</div>}
                   className="block"
                 >
                   <Page
                      pageNumber={currentPage}
                      scale={scale}
                      onRenderSuccess={onPageLoadSuccess}
                      renderAnnotationLayer={false}
                      renderTextLayer={false}
                      className="block"
                   />
                 </Document>
               </div>

               {/* 2. FABRIC LAYER (Foreground) */}
               {/* Force high z-index to sit ON TOP of PDF canvas */}
               <div className="absolute top-0 left-0 z-[50]" style={{ width: '100%', height: '100%' }}>
                  <canvas ref={canvasRef} />
               </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
