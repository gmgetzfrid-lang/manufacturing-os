"use client";

// FileReferenceModal — the "file reference" counterpart to the photo carousel.
//
// A tag whose column is referenceKind:"files" opens this instead of a photo
// gallery: a ¾-screen, multipage viewer of the drawing(s) LINKED to that tag
// (e.g. a circuit id → its scoped isometric). Managers can link existing
// documents (DocumentLinkPicker) and remove links. A fullscreen toggle matches
// the photo carousel's "start smaller, go bigger" feel.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, Loader2, FileText, Maximize2, Minimize2, Link2, Trash2, Plus, Printer, ZoomIn, ZoomOut, Hand, MousePointer2 } from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import { PDFDocument } from "pdf-lib";
import { supabase } from "@/lib/supabase";
import { useViewerPanZoom } from "@/lib/useViewerPanZoom";
import { stampPdf } from "@/lib/stamping";
import {
  getAssetByTag, createAsset, listAssetFiles, linkAssetFile, unlinkAssetFile,
  type Asset, type AssetFile, type LinkedDocument,
} from "@/lib/assets";
import DocumentLinkPicker from "@/components/documents/DocumentLinkPicker";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center h-full min-h-[240px] px-6">{children}</div>;
}

// Resolve a document's current-version PDF to a fetchable URL (presigning a
// storage path when needed). Shared by the active-doc view and Print all.
async function resolveCurrentVersionUrl(doc: { id: string; current_version_id?: string | null }): Promise<string | null> {
  let fileUrl: string | null = null;
  if (doc.current_version_id) {
    const { data } = await supabase.from("document_versions").select("file_url").eq("id", doc.current_version_id).maybeSingle();
    fileUrl = (data?.file_url as string) ?? null;
  }
  if (!fileUrl) {
    const { data } = await supabase.from("document_versions").select("file_url").eq("record_id", doc.id).order("created_at", { ascending: false }).limit(1);
    fileUrl = (data?.[0]?.file_url as string) ?? null;
  }
  if (!fileUrl) return null;
  if (/^https?:\/\//.test(fileUrl)) return fileUrl;
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return null;
  const res = await fetch(`/api/storage/download-url?path=${encodeURIComponent(fileUrl)}&expiresIn=3600`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return ((await res.json()).url as string) ?? null;
}

export default function FileReferenceModal({ tag, type, orgId, userId, canManage = false, onClose }: {
  tag: string;
  type?: string;
  orgId: string;
  userId?: string;
  canManage?: boolean;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [files, setFiles] = useState<AssetFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [pageWidth, setPageWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [isFull, setIsFull] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  const panZoom = useViewerPanZoom({
    containerRef: scrollRef,
    onZoom: (d) => setZoom((z) => Math.min(3, Math.max(0.4, Math.round((z + d * 0.15) * 100) / 100))),
  });

  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const a = await getAssetByTag(orgId, tag);
      setAsset(a);
      if (a) {
        const fs = await listAssetFiles(a.id);
        setFiles(fs);
        setActiveId((cur) => (cur && fs.some((f) => f.id === cur) ? cur : (fs[0]?.id ?? null)));
      } else {
        setFiles([]);
        setActiveId(null);
      }
    } finally {
      setLoading(false);
    }
  }, [orgId, tag]);
  useEffect(() => { loadFiles(); }, [loadFiles]);

  const activeFile = files.find((f) => f.id === activeId) ?? null;

  // Resolve the active document's current-version PDF to a presigned URL.
  useEffect(() => {
    let alive = true;
    (async () => {
      const doc = activeFile?.document;
      if (!doc) { setResolvedUrl(null); return; }
      setResolving(true); setResolvedUrl(null); setPageCount(0);
      try {
        const url = await resolveCurrentVersionUrl(doc);
        if (alive) setResolvedUrl(url);
      } finally {
        if (alive) setResolving(false);
      }
    })();
    return () => { alive = false; };
  }, [activeFile]);

  // Fit pages to the viewer column.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((obs) => { const w = obs[0]?.contentRect.width ?? 0; if (w > 0) setPageWidth(Math.max(320, Math.round(w - 32))); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toggleFull = useCallback(async () => {
    try { if (!document.fullscreenElement) await rootRef.current?.requestFullscreen?.(); else await document.exitFullscreen?.(); } catch { /* denied */ }
  }, []);
  useEffect(() => { const h = () => setIsFull(!!document.fullscreenElement); document.addEventListener("fullscreenchange", h); return () => document.removeEventListener("fullscreenchange", h); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.fullscreenElement && !pickerOpen) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, pickerOpen]);

  const handlePick = async (docId: string) => {
    if (!userId) return;
    let a = asset ?? await getAssetByTag(orgId, tag);
    if (!a) a = await createAsset({ orgId, tag, createdBy: userId });
    await linkAssetFile({ orgId, assetId: a.id, documentId: docId, createdBy: userId });
    setPickerOpen(false);
    setAsset(a);
    await loadFiles();
  };
  const handleUnlink = async (id: string) => { await unlinkAssetFile(id); await loadFiles(); };

  // Print every linked drawing as ONE stamped (uncontrolled) PDF — the file-stack
  // counterpart to the collection book's "Print all".
  const printAll = async () => {
    const docs = files.map((f) => f.document).filter(Boolean) as LinkedDocument[];
    if (docs.length === 0 || printing) return;
    setPrinting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const email = session?.user?.email ?? undefined;
      const merged = await PDFDocument.create();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 3600 * 1000);
      for (const doc of docs) {
        const url = await resolveCurrentVersionUrl(doc);
        if (!url) continue;
        try {
          const stamped = await stampPdf(url, {
            userLabel: email, email, timestamp: now, expiresAt,
            watermarkText: `UNCONTROLLED — ${doc.document_number || "DOC"} Rev ${doc.rev || "-"}`,
          });
          const src = await PDFDocument.load(await stamped.arrayBuffer());
          const copied = await merged.copyPages(src, src.getPageIndices());
          copied.forEach((p) => merged.addPage(p));
        } catch (e) { console.error("Failed to add linked drawing", doc.document_number, e); }
      }
      if (merged.getPageCount() === 0) return;
      const bytes = await merged.save();
      const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      const w = window.open(u, "_blank");
      if (w) w.addEventListener("load", () => setTimeout(() => w.print(), 250));
      setTimeout(() => URL.revokeObjectURL(u), 60_000);
      if (userId) {
        const rows = docs.map((d) => ({ org_id: orgId, document_id: d.id, user_id: userId, user_email: email ?? null, created_at: now.toISOString(), expires_at: expiresAt.toISOString(), watermark_policy_id: null }));
        try { await supabase.from("download_audits").insert(rows); } catch (e) { console.error(e); }
      }
    } finally { setPrinting(false); }
  };

  return (
    <div ref={rootRef} className="fixed inset-0 z-[500] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-3 sm:p-6" onClick={onClose}>
      <div
        className={`bg-slate-900 shadow-2xl border border-slate-700 overflow-hidden flex flex-col ${isFull ? "w-screen h-screen rounded-none" : "w-[80vw] h-[85vh] max-w-[1400px] rounded-2xl"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-slate-800 flex items-center gap-3 bg-slate-900 shrink-0">
          <FileText className="w-4 h-4 text-orange-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-white truncate">{tag} <span className="text-[11px] font-medium text-slate-400">· {type || "Linked drawings"}</span></div>
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {activeFile && (
              <div className="hidden sm:flex items-center gap-0.5 bg-slate-800/80 rounded-lg px-1 py-0.5">
                <button onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100))} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300 hover:text-white" title="Zoom out"><ZoomOut className="w-4 h-4" /></button>
                <button onClick={() => setZoom(1)} className="w-9 text-center text-[11px] font-mono text-slate-300 hover:text-white" title="Fit to width (Ctrl + scroll to zoom)">{Math.round(zoom * 100)}%</button>
                <button onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.15) * 100) / 100))} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300 hover:text-white" title="Zoom in"><ZoomIn className="w-4 h-4" /></button>
                <button onClick={() => panZoom.setPanMode((v) => !v)} className={`p-1.5 rounded-lg hover:bg-white/10 ${panZoom.panMode ? "text-orange-300" : "text-slate-300 hover:text-white"}`} title={panZoom.panMode ? "Pan tool (drag to move) — click for cursor" : "Cursor — click for the pan/grab hand"}>
                  {panZoom.panMode ? <Hand className="w-4 h-4" /> : <MousePointer2 className="w-4 h-4" />}
                </button>
              </div>
            )}
            {files.length > 0 && (
              <button onClick={() => void printAll()} disabled={printing} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold disabled:opacity-50" title="Print all linked drawings as one stamped, uncontrolled PDF">
                {printing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />} Print all ({files.length})
              </button>
            )}
            {canManage && (
              <button onClick={() => setPickerOpen(true)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-[11px] font-bold"><Plus className="w-3.5 h-3.5" /> Link a drawing</button>
            )}
            <button onClick={() => void toggleFull()} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300 hover:text-white transition-colors" title={isFull ? "Exit full screen" : "Full screen"}>
              {isFull ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button onClick={onClose} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold"><X className="w-3.5 h-3.5" /> Close</button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0">
          {(files.length > 1 || canManage) && (
            <div className="w-56 shrink-0 border-r border-slate-800 bg-slate-900/60 overflow-y-auto">
              {files.map((f) => (
                <div key={f.id} className={`group flex items-stretch border-b border-slate-800/60 ${activeId === f.id ? "bg-orange-500/10" : ""}`}>
                  <button onClick={() => setActiveId(f.id)} className={`flex-1 min-w-0 text-left px-3 py-2.5 ${activeId === f.id ? "text-orange-300" : "text-slate-300 hover:text-white"}`}>
                    <div className="text-[11px] font-mono font-bold truncate">{f.document?.document_number || f.document?.title || "Document"}</div>
                    <div className="text-[10px] text-slate-500 truncate">{f.document?.title || f.document?.name || ""}{f.document?.rev ? ` · Rev ${f.document.rev}` : ""}</div>
                  </button>
                  {canManage && (
                    <button onClick={() => void handleUnlink(f.id)} title="Remove link" className="shrink-0 px-2 flex items-center text-slate-600 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </div>
              ))}
              {files.length === 0 && <div className="p-4 text-[11px] text-slate-500">No linked drawings yet.</div>}
            </div>
          )}

          <div ref={scrollRef} className={`flex-1 overflow-auto bg-slate-950 min-w-0 ${panZoom.cursorClass}`} {...panZoom.panHandlers}>
            {loading ? (
              <Centered><Loader2 className="w-8 h-8 animate-spin text-orange-500" /></Centered>
            ) : !activeFile ? (
              <Centered>
                <div className="text-center text-slate-500">
                  <Link2 className="w-10 h-10 mx-auto opacity-30 mb-2" />
                  <div className="text-sm">No drawing linked to {tag} yet.{canManage ? " Use “Link a drawing”." : ""}</div>
                </div>
              </Centered>
            ) : resolving ? (
              <Centered><Loader2 className="w-8 h-8 animate-spin text-orange-500" /></Centered>
            ) : !resolvedUrl ? (
              <Centered><div className="text-slate-500 text-sm">Couldn’t load this drawing.</div></Centered>
            ) : (
              <div className="flex flex-col items-center gap-3 py-4 px-2">
                <Document
                  file={resolvedUrl}
                  onLoadSuccess={({ numPages }) => setPageCount(numPages)}
                  loading={<Centered><Loader2 className="w-8 h-8 animate-spin text-orange-500" /></Centered>}
                  error={<Centered><div className="text-slate-500 text-sm">Couldn’t render this PDF</div></Centered>}
                  className="flex flex-col items-center gap-3"
                >
                  {Array.from({ length: pageCount }).map((_, p) => (
                    <div key={p} className="shadow-xl shadow-black/40 bg-white">
                      <Page pageNumber={p + 1} width={Math.round(pageWidth * zoom)} renderTextLayer={false} renderAnnotationLayer={false} loading={<div className="bg-slate-800 animate-pulse" style={{ width: Math.round(pageWidth * zoom), height: Math.round(pageWidth * zoom * 1.3) }} />} />
                    </div>
                  ))}
                </Document>
              </div>
            )}
          </div>
        </div>
      </div>

      {pickerOpen && (
        <DocumentLinkPicker
          orgId={orgId}
          userId={userId}
          canManage={canManage}
          excludeIds={files.map((f) => f.document_id)}
          onPick={handlePick}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
