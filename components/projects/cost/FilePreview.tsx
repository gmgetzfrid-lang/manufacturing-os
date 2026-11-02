"use client";

// A look at an uploaded file without leaving the page: an AFE, a quote, an
// invoice. A PDF shows its pages, a picture shows itself, anything else
// (Word, Excel) opens or downloads.

import React, { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Download, ExternalLink, Eye, FileText, Loader2, X } from "lucide-react";
import { resolveFileUrl } from "@/lib/storage";
import { fmtMoney } from "@/lib/costs";

const PdfPages = dynamic(() => import("@/components/projects/cost/PdfPages"), { ssr: false, loading: () => <Waiting /> });

export interface PreviewFile {
  /** Storage key (or a full URL). */
  key: string;
  name: string | null;
  mime: string | null;
  /** "Invoice 4471 · $12,400", shown under the name. */
  sub?: string | null;
}

const isPdf = (f: PreviewFile) => /pdf/i.test(f.mime ?? "") || /\.pdf$/i.test(f.name ?? f.key);
const isImage = (f: PreviewFile) => /^image\//i.test(f.mime ?? "") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name ?? f.key);

function Waiting() {
  return <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Opening…</div>;
}

export function FilePreviewModal({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    let alive = true;
    void resolveFileUrl(file.key).then((u) => { if (alive) setUrl(u); }).catch((e) => { if (alive) setErr((e as Error).message || "The file couldn't be opened."); });
    return () => { alive = false; };
  }, [file.key]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(260, Math.min(1000, el.clientWidth - 24))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  const btn = "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[12px] font-bold text-[var(--color-text)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]";
  return (
    <div className="fixed inset-0 z-[400] bg-slate-900/70 backdrop-blur-sm flex items-stretch sm:items-center justify-center sm:p-4" role="dialog" aria-modal="true" aria-label={file.name ?? "File"} onClick={onClose}>
      <div className="w-full sm:max-w-5xl h-full sm:h-[92vh] flex flex-col bg-[var(--color-surface)] sm:rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-[var(--color-border)]">
          <FileText className="w-4 h-4 shrink-0 text-[var(--color-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-black text-[var(--color-text)] truncate">{file.name ?? "File"}</div>
            {file.sub && <div className="text-[11.5px] text-[var(--color-text-muted)] truncate">{file.sub}</div>}
          </div>
          {url && <a href={url} target="_blank" rel="noopener noreferrer" className={`${btn} max-sm:hidden`}><ExternalLink className="w-3.5 h-3.5" /> Open</a>}
          {url && <a href={url} download={file.name ?? undefined} className={btn}><Download className="w-3.5 h-3.5" /><span className="max-sm:hidden">Download</span></a>}
          <button type="button" onClick={onClose} aria-label="Close" className="p-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <div ref={box} className="flex-1 min-h-0 overflow-auto bg-[var(--color-surface-2)]">
          {err ? <div className="p-6 text-[13px] text-rose-700 dark:text-rose-300">{err}</div>
            : !url ? <Waiting />
            : isPdf(file) ? <PdfPages url={url} width={width} />
            : isImage(file) ? (
              <div className="p-3 flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element -- a signed storage URL, shown as is */}
                <img src={url} alt={file.name ?? "File"} className="max-w-full h-auto rounded shadow" />
              </div>
            )
            : (
              <div className="p-8 text-center space-y-3">
                <div className="text-[13px] text-[var(--color-text)]">This kind of file can&apos;t be shown here.</div>
                <a href={url} target="_blank" rel="noopener noreferrer" className={btn}><ExternalLink className="w-3.5 h-3.5" /> Open it</a>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

/** A small "Preview" button that opens the file in place. */
export function PreviewButton({ file, label = "Preview", className = "" }: { file: PreviewFile | null; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!file?.key) return null;
  return (
    <>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(true); }} title={`See ${file.name ?? "the file"}`}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] ${className}`}>
        <Eye className="w-3 h-3" /> {label}
      </button>
      {open && <FilePreviewModal file={file} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A cost document (AFE, quote, invoice) as a file to preview. */
export function fileOfDoc(d: { fileUrl: string | null; fileName: string | null; mimeType: string | null; docNumber?: string | null; totalAmount?: number | null; currency?: string | null; vendorName?: string | null } | null | undefined): PreviewFile | null {
  if (!d?.fileUrl) return null;
  const sub = [d.vendorName, d.docNumber, d.totalAmount != null ? fmtMoney(d.totalAmount, d.currency ?? "USD") : null].filter(Boolean).join(" · ");
  return { key: d.fileUrl, name: d.fileName, mime: d.mimeType, sub: sub || null };
}
