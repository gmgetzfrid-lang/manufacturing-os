"use client";

// Every page of a PDF, fit to the width given (loaded only in the browser:
// components/projects/cost/FilePreview).

import React, { useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { Loader2 } from "lucide-react";
import { PDF_DOC_OPTIONS } from "@/lib/pdfjsConfig";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export default function PdfPages({ url, width }: { url: string; width: number }) {
  const [pages, setPages] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  if (err) return <div className="p-6 text-[13px] text-rose-700 dark:text-rose-300">{err}</div>;
  return (
    <Document file={url} options={PDF_DOC_OPTIONS}
      onLoadSuccess={(d) => setPages(d.numPages)}
      onLoadError={(e) => setErr(`The PDF couldn't be shown (${e.message}). Use Open or Download.`)}
      loading={<div className="flex items-center justify-center gap-2 py-16 text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Opening…</div>}>
      <div className="py-3 flex flex-col items-center gap-3">
        {Array.from({ length: pages }, (_, i) => (
          <div key={i} className="shadow bg-white">
            <Page pageNumber={i + 1} width={width} renderAnnotationLayer={false} renderTextLayer={false} />
          </div>
        ))}
        {pages > 1 && <div className="text-[11px] text-[var(--color-text-faint)]">{pages} pages</div>}
      </div>
    </Document>
  );
}
