"use client";

// FindPreview - the document you tapped, beside the list: its first page,
// Open / Open full size / new tab, what else is on it, and where else the
// picked equipment shows up.

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Maximize2, X } from "lucide-react";
import DocThumb from "@/components/documents/DocThumb";
import { docHref, docLabel, docMeta, equipLabel, type FindDoc, type FindEquip, type FindWorkOrder } from "@/lib/findEverywhere";

interface Props {
  doc: FindDoc;
  /** Other equipment tagged on this document. */
  onSheet?: string[];
  equip?: FindEquip | null;
  /** The picked equipment's other documents. */
  elsewhere?: FindDoc[];
  workOrders?: FindWorkOrder[];
  onPreview?: (id: string) => void;
  onClose?: () => void;
}

export default function FindPreview({ doc, onSheet, equip, elsewhere, workOrders, onPreview, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(260);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(160, Math.min(560, Math.floor(el.clientWidth)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const meta = docMeta(doc);
  const others = (elsewhere ?? []).filter((d) => d.id !== doc.id);

  return (
    <div className="flex flex-col gap-2 min-w-0" data-find-preview>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-black text-[var(--color-text)] truncate">{docLabel(doc)}</div>
          <div className="text-[11px] text-[var(--color-text-muted)] truncate">{[meta, doc.folderName].filter(Boolean).join(" · ")}</div>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} title="Close the preview" className="shrink-0 p-1 rounded-md text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <div ref={box} className="w-full">
        <Link href={docHref(doc, true)} title="Open full size" className="block">
          <DocThumb key={doc.id} documentId={doc.id} width={w} rounded="rounded-lg" />
        </Link>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Link href={docHref(doc)} className="inline-flex items-center gap-1 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-bold hover:opacity-90">
          Open
        </Link>
        <Link href={docHref(doc, true)} className="inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
          <Maximize2 className="w-3.5 h-3.5" /> Full size
        </Link>
        <a href={docHref(doc)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
          New tab <ArrowUpRight className="w-3.5 h-3.5" />
        </a>
      </div>
      {onSheet && onSheet.length > 0 && (
        <div className="text-[11.5px] text-[var(--color-text)]"><b>Also on it:</b> {onSheet.slice(0, 24).join(", ")}{onSheet.length > 24 ? ` and ${onSheet.length - 24} more` : ""}</div>
      )}
      {equip && (others.length > 0 || (workOrders?.length ?? 0) > 0) && (
        <div className="text-[11.5px] text-[var(--color-text)]">
          <b>{equipLabel(equip)} elsewhere:</b>{" "}
          {others.map((d, i) => (
            <React.Fragment key={d.id}>
              {i > 0 && ", "}
              {onPreview
                ? <button type="button" onClick={() => onPreview(d.id)} className="font-semibold text-[var(--color-accent)] hover:underline">{docLabel(d)}</button>
                : <Link href={docHref(d)} className="font-semibold text-[var(--color-accent)] hover:underline">{docLabel(d)}</Link>}
            </React.Fragment>
          ))}
          {(workOrders ?? []).map((w, i) => (
            <React.Fragment key={w.id}>
              {(others.length > 0 || i > 0) && ", "}
              <Link href={`/projects/${w.projectId}`} className="font-semibold text-[var(--color-accent)] hover:underline">
                {w.wo ? `work order ${w.wo}` : w.name} ({w.projectName})
              </Link>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
