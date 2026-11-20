"use client";

// FileTagChip — the "file reference" counterpart to AssetTagChip. For tag
// columns set to referenceKind:"files", the pill shows a file icon + count of
// LINKED drawings and opens the FileReferenceModal (a ¾-screen multipage viewer)
// instead of the photo gallery.

import React, { useState } from "react";
import { FileText, Files } from "lucide-react";
import { useAssetFilesByTag } from "@/lib/assets";
import dynamic from "next/dynamic";
// react-pdf + pdf-lib are heavy; chips render on every library row, so
// the viewer loads only when a chip is actually opened.
const FileReferenceModal = dynamic(() => import("./FileReferenceModal"), { ssr: false });

export default function FileTagChip({ tag, type = "Linked drawings", orgId, userId, canManage = false }: {
  tag: string;
  type?: string;
  orgId?: string;
  userId?: string;
  canManage?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { fileCount } = useAssetFilesByTag(orgId, tag);
  const interactive = !!orgId;
  const hasFiles = fileCount > 0;

  const title = !interactive ? tag
    : hasFiles ? `${fileCount} linked drawing${fileCount === 1 ? "" : "s"} for ${tag}`
      : canManage ? `Link a drawing to ${tag}`
        : `No drawing linked to ${tag}`;

  // A pill you can press: a file glyph, the tag, and how many drawings are
  // linked when there are any.
  if (!interactive) return <span className="ui-tag tabular-nums"><FileText className="w-3 h-3 opacity-70" aria-hidden />{tag}</span>;

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        title={title}
        aria-label={title}
        className="ui-tag tabular-nums"
      >
        <FileText className="w-3 h-3 opacity-70" aria-hidden />
        <span>{tag}</span>
        {hasFiles ? (
          <span className="inline-flex items-center gap-0.5 font-sans text-[12px] font-bold" aria-hidden>
            <Files className="w-3 h-3" />{fileCount}
          </span>
        ) : null}
      </button>

      {open && orgId && (
        <FileReferenceModal tag={tag} type={type} orgId={orgId} userId={userId} canManage={canManage} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
