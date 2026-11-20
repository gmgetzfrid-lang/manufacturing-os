"use client";

// One drop box for the lifecycle wizards: drag a PDF onto it or tap to pick
// one. While a file is over it, it lights up and says what letting go does.
import React from "react";
import { useFileDrag } from "@/hooks/useFileDrag";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PdfDrop({ onFile, file, children, className = "" }: {
  onFile: (f: File | null) => void;
  file: File | null;
  children: React.ReactNode;
  className?: string;
}) {
  const drag = useFileDrag((fs) => onFile(fs[0] ?? null));
  return (
    <label
      {...drag.bind}
      className={`flex-1 block border-2 border-dashed border-[var(--color-border-strong)] rounded p-2 cursor-pointer hover:bg-[var(--color-surface-2)] ${file ? "" : "text-center"} ${drag.ring} ${className}`}
    >
      <input type="file" accept="application/pdf" className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      {drag.over ? <span className="text-[11px] font-bold text-[var(--color-text)]">{drag.say}</span> : children}
    </label>
  );
}
