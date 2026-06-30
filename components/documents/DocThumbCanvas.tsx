"use client";

// The react-pdf half of DocThumb, split into its own module so DocThumb can load
// it with next/dynamic. That keeps pdfjs OUT of the initial bundle of every
// route that merely shows thumbnails (dashboard, inbox, search, activity,
// transmittals) — pdfjs only downloads once a thumbnail actually scrolls in.

import React from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { FileText, Loader2 } from "lucide-react";

// Same self-hosted worker the full viewers use (copied to /public at build).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export default function DocThumbCanvas({ url, width, onFail }: {
  url: string;
  width: number;
  onFail: () => void;
}) {
  return (
    <Document
      file={url}
      loading={<div className="absolute inset-0 flex items-center justify-center"><Loader2 className="w-3.5 h-3.5 animate-spin text-slate-300" /></div>}
      onLoadError={onFail}
      error={<div className="absolute inset-0 flex items-center justify-center"><FileText className="w-4 h-4 text-slate-300" /></div>}
    >
      <Page
        pageNumber={1}
        width={width}
        renderTextLayer={false}
        renderAnnotationLayer={false}
        onRenderError={onFail}
        devicePixelRatio={1}
      />
    </Document>
  );
}
