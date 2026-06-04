"use client";

// DocThumb — a lazy, cached first-page PDF thumbnail. Reusable anywhere we want
// a real preview of a drawing instead of a generic icon (activity feed, cards,
// search). Renders only when scrolled into view (IntersectionObserver), caches
// the signed URL per path, and falls back to a typed placeholder on
// loading/error/non-PDF so it can never break the surrounding layout.

import React from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { FileText, Loader2 } from "lucide-react";
import { getSignedUrlForPath } from "@/lib/storage";
import { supabase } from "@/lib/supabase";

// Same self-hosted worker the full viewers use (copied to /public at build).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

// Resolve + cache the signed URL for a storage path. One in-flight promise per
// path so a feed with the same doc repeated only signs once.
const urlCache = new Map<string, Promise<string | null>>();
function resolveUrl(filePath: string): Promise<string | null> {
  if (filePath.startsWith("http")) return Promise.resolve(filePath);
  const hit = urlCache.get(filePath);
  if (hit) return hit;
  const p = getSignedUrlForPath(filePath).catch(() => null);
  urlCache.set(filePath, p);
  return p;
}

// Resolve a document id → its current version's file path. Cached per doc so
// DocThumb is drop-in anywhere with just a documentId (no pre-fetch needed).
const pathByDoc = new Map<string, Promise<string | null>>();
function resolvePathByDoc(docId: string): Promise<string | null> {
  const hit = pathByDoc.get(docId);
  if (hit) return hit;
  const p = (async () => {
    const { data: doc } = await supabase.from("documents").select("current_version_id").eq("id", docId).maybeSingle();
    const vid = (doc as { current_version_id: string | null } | null)?.current_version_id;
    if (!vid) return null;
    const { data: ver } = await supabase.from("document_versions").select("file_url").eq("id", vid).maybeSingle();
    return (ver as { file_url: string | null } | null)?.file_url ?? null;
  })().catch(() => null);
  pathByDoc.set(docId, p);
  return p;
}

export default function DocThumb({
  filePath,
  documentId,
  width = 64,
  className = "",
  rounded = "rounded-md",
}: {
  /** A storage path, if the caller already has it (cheapest). */
  filePath?: string | null;
  /** Or a document id — DocThumb resolves the current version's file itself. */
  documentId?: string | null;
  width?: number;
  className?: string;
  rounded?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(false);
  const [resolvedPath, setResolvedPath] = React.useState<string | null>(filePath ?? null);
  const [url, setUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const effectivePath = filePath ?? resolvedPath;
  const isPdf = !!effectivePath && /\.pdf($|\?)/i.test(effectivePath);

  // Only start work once scrolled near the viewport.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  // If only a documentId was given, resolve its file path once visible.
  React.useEffect(() => {
    if (!visible || filePath || !documentId) return;
    let alive = true;
    void resolvePathByDoc(documentId).then((p) => { if (alive) { if (p) setResolvedPath(p); else setFailed(true); } });
    return () => { alive = false; };
  }, [visible, filePath, documentId]);

  React.useEffect(() => {
    if (!visible || !effectivePath || !isPdf) return;
    let alive = true;
    void resolveUrl(effectivePath).then((u) => { if (alive) { if (u) setUrl(u); else setFailed(true); } });
    return () => { alive = false; };
  }, [visible, effectivePath, isPdf]);

  const box = `relative shrink-0 overflow-hidden bg-slate-100 border border-slate-200 ${rounded} ${className}`;
  const style: React.CSSProperties = { width, height: Math.round(width * 1.3) };
  const nothingToShow = !effectivePath && !documentId;
  const nonPdf = !!effectivePath && !isPdf;

  // Nothing to render, non-PDF, or a render failure → typed placeholder.
  if (nothingToShow || nonPdf || failed) {
    return <div ref={ref} className={`${box} flex items-center justify-center`} style={style}><FileText className="w-4 h-4 text-slate-300" /></div>;
  }
  // Not visible yet, still resolving the path/url → loader.
  if (!visible || !url) {
    return <div ref={ref} className={`${box} flex items-center justify-center`} style={style}><Loader2 className="w-3.5 h-3.5 animate-spin text-slate-300" /></div>;
  }

  return (
    <div ref={ref} className={box} style={style}>
      <Document
        file={url}
        loading={<div className="absolute inset-0 flex items-center justify-center"><Loader2 className="w-3.5 h-3.5 animate-spin text-slate-300" /></div>}
        onLoadError={() => setFailed(true)}
        error={<div className="absolute inset-0 flex items-center justify-center"><FileText className="w-4 h-4 text-slate-300" /></div>}
      >
        <Page
          pageNumber={1}
          width={width}
          renderTextLayer={false}
          renderAnnotationLayer={false}
          onRenderError={() => setFailed(true)}
        />
      </Document>
    </div>
  );
}
