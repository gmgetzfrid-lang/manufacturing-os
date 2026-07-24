"use client";

// FileTagChip — the "file reference" counterpart to AssetTagChip. For tag
// columns set to referenceKind:"files", the pill shows a file icon + count of
// LINKED drawings and opens the FileReferenceModal (a ¾-screen multipage viewer)
// instead of the photo gallery.

import React, { useState } from "react";
import { FileText, Files, Link2 } from "lucide-react";
import { useAssetFilesByTag } from "@/lib/assets";
import FileReferenceModal from "./FileReferenceModal";

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

  const base = "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border mr-1 mb-1 whitespace-nowrap shadow-sm transition-all";
  const state = hasFiles
    ? "bg-gradient-to-br from-orange-50 to-orange-100/70 text-orange-800 border-orange-200 hover:border-orange-300 hover:from-orange-100 hover:to-orange-200 cursor-pointer"
    : interactive
      ? "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)] hover:bg-orange-50 hover:border-orange-300 hover:text-orange-700 cursor-pointer"
      : "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]";

  return (
    <>
      <button
        onClick={(e) => { if (!interactive) return; e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        disabled={!interactive}
        title={
          !interactive ? tag
            : hasFiles ? `${fileCount} linked drawing${fileCount === 1 ? "" : "s"} for ${tag}`
              : canManage ? `Link a drawing to ${tag}`
                : `No drawing linked to ${tag}`
        }
        className={`${base} ${state}`}
      >
        <span className={hasFiles ? "text-orange-500 mr-1" : "text-[var(--color-text-faint)] mr-1"}><FileText className="w-3 h-3" /></span>
        <span>{tag}</span>
        {hasFiles ? (
          <span className="ml-1.5 inline-flex items-center gap-0.5 px-1 py-px rounded bg-white/80 text-orange-700 text-[9px] font-black">
            <Files className="w-2.5 h-2.5" />{fileCount}
          </span>
        ) : interactive ? (
          <span className="ml-1.5 inline-flex items-center text-slate-300"><Link2 className="w-2.5 h-2.5" /></span>
        ) : null}
      </button>

      {open && orgId && (
        <FileReferenceModal tag={tag} type={type} orgId={orgId} userId={userId} canManage={canManage} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
