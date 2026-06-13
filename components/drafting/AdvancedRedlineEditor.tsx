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
  Trash2,
  ChevronLeft,
  ChevronRight,
  Minus // For Line Tool
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import * as fabric from 'fabric'; 
import { PDFDocument } from 'pdf-lib';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { appAlert } from "@/components/providers/DialogProvider";

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
      }).catch(err => {
        console.error("Error loading fabric state:", err);
      });
    } else {
        console.log(`No saved state for page ${currentPage}.`);
    }
  };

  const handlePageChange = (newPage: number) => {
    saveCurrentPageState(); // Save current page before switch
    setCurrentPage(newPage);
  };

  // --- ZOOM HANDLING ---
  const handleZoom = (newScale: number) => {
    saveCurrentPageState(); // Save current page before zoom
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

    if (Object.keys(pageStatesRef.current).length === 0 && !currentNormalizedState) {
      await appAlert({ message: "No markups made." });
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

    } catch (e) {
      console.error("Save Failed:", e);
      await appAlert({ message: "Failed to save redlines. See console.", tone: "danger" });
    }
  };

  // --- HELPERS ---
  return (
    <div
      className="fixed inset-0 z-[200] bg-slate-200 flex flex-col"
      onMouseUp={handleMouseUp} // Global mouse up for dragging safety
      onMouseLeave={handleMouseUp}
    >
      {/* TOOLBAR */}
      <div className="h-16 bg-slate-900 flex items-center justify-between px-4 shrink-0 shadow-xl z-50">
        <div className="flex items-center space-x-4">
          <span className="text-slate-400 text-xs font-bold uppercase tracking-widest hidden md:block">Redline Pro</span>
          <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
             <button onClick={() => setTool('pan')} className={`p-2 rounded ${tool === 'pan' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-white'}`} title="Pan (Grab & Move)"><Move className="w-5 h-5"/></button>
             <div className="w-px h-6 bg-slate-700 mx-1 self-center"/>
             <button onClick={() => setTool('pen')} className={`p-2 rounded ${tool === 'pen' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-white'}`} title="Pen"><Pen className="w-5 h-5"/></button>
             <button onClick={() => setTool('line')} className={`p-2 rounded ${tool === 'line' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-white'}`} title="Straight Line"><Minus className="w-5 h-5"/></button>
             <button onClick={() => setTool('highlight')} className={`p-2 rounded ${tool === 'highlight' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-white'}`} title="Highlighter"><Highlighter className="w-5 h-5"/></button>
             <button onClick={addText} className={`p-2 rounded ${tool === 'text' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-white'}`} title="Add Text"><Type className="w-5 h-5"/></button>
             <button onClick={deleteSelected} className="p-2 text-slate-400 hover:text-red-500" title="Delete Selected"><Trash2 className="w-5 h-5"/></button>
          </div>
          
          <div className="flex items-center space-x-3 bg-slate-800 rounded-lg p-1.5 border border-slate-700">
             <div className="flex space-x-1">
              {(['red', 'blue', 'black', 'yellow', 'green'] as Color[]).map(c => (
                <button 
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-5 h-5 rounded-full border-2 ${color === c ? 'border-white scale-110' : 'border-transparent hover:scale-105'}`}
                  style={{ backgroundColor: getColorHex(c) }}
                />
              ))}
             </div>
             <div className="w-px h-6 bg-slate-700 mx-1"/>
             <input 
               type="range" 
               min="1" 
               max="10" 
               step="1" 
               value={strokeWidth} 
               onChange={(e) => setStrokeWidth(Number(e.target.value))}
               className="w-16 h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer"
               title={`Line Width: ${strokeWidth}px`}
             />
          </div>
        </div>

        <div className="flex items-center space-x-4">
           {/* ZOOM */}
           <div className="flex items-center bg-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-300">
              <button onClick={() => handleZoom(Math.max(0.5, scale - 0.25))} className="p-1 hover:text-white"><ZoomOut className="w-4 h-4"/></button>
              <span className="mx-2">{(scale * 100).toFixed(0)}%</span>
              <button onClick={() => handleZoom(Math.min(3, scale + 0.25))} className="p-1 hover:text-white"><ZoomIn className="w-4 h-4"/></button>
           </div>

           {/* PAGES */}
           <div className="flex items-center bg-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-300">
              <button onClick={() => handlePageChange(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} className="p-1 hover:text-white disabled:opacity-30"><ChevronLeft className="w-4 h-4"/></button>
              <span className="mx-2">{currentPage} / {numPages || '-'}</span>
              <button onClick={() => handlePageChange(Math.min(numPages, currentPage + 1))} disabled={currentPage >= numPages} className="p-1 hover:text-white disabled:opacity-30"><ChevronRight className="w-4 h-4"/></button>
           </div>

           <button onClick={handleSave} disabled={isSaving} className="flex items-center px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-bold rounded shadow-lg transition-transform hover:scale-105 disabled:opacity-50">
             {isSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <Save className="w-4 h-4 mr-2"/>} Save
           </button>
           
           <button onClick={onClose} className="p-2 text-slate-400 hover:text-red-500 hover:bg-slate-800 rounded-full"><X className="w-6 h-6"/></button>
        </div>
      </div>

      {/* WORKSPACE AREA */}
      <div 
        className={`flex-1 overflow-hidden bg-slate-200 relative p-8 ${tool === 'pan' ? 'cursor-grab active:cursor-grabbing' : ''}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
      >
        {/* CENTERED CONTENT WRAPPER WITH TRANSFORM */}
        <div 
          className="min-w-full min-h-full flex items-center justify-center transition-transform duration-75 ease-out will-change-transform"
          style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px)` }}
        >
          <div className="relative shadow-2xl border border-slate-300 bg-white">
             {/* 1. PDF LAYER (Background) */}
             {/* We use !important styles to ensure nothing in react-pdf captures events */}
             <div className="relative z-0" style={{ pointerEvents: 'none', userSelect: 'none' }}>
               <Document 
                 file={fileUrl} 
                 onLoadSuccess={({ numPages }) => setNumPages(numPages)} 
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
  );
}