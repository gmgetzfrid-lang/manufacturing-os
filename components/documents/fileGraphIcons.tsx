"use client";

// fileGraphIcons — one icon per kind of thing, shared by the canvas map and
// the result lists so a PDF looks like the same PDF everywhere.

import React, { useEffect, useRef, useState } from "react";
import {
  File, FileText, FileSpreadsheet, FileCode, FileImage, FileArchive, Presentation, Mail,
  DraftingCompass, Library, Folder, FolderOpen, HardDrive, type LucideIcon,
} from "lucide-react";
import type { FileIconKey, FileTypeInfo } from "@/lib/fileFinder/fileTypes";

export const ICONS: Record<FileIconKey, LucideIcon> = {
  pdf: FileText, cad: DraftingCompass, sheet: FileSpreadsheet, doc: FileText, code: FileCode,
  image: FileImage, archive: FileArchive, slides: Presentation, mail: Mail, file: File,
  library: Library, folder: Folder, folderOpen: FolderOpen, drive: HardDrive,
};

/** A type's icon in its colour, for lists and cards. */
export function FileTypeIcon({ type, className = "w-4 h-4" }: { type: FileTypeInfo; className?: string }) {
  const Icon = ICONS[type.key];
  return <Icon className={className} style={{ color: type.color }} aria-label={type.label} />;
}

/** Renders every icon once, off-screen (mount `<IconHost ref={hostRef} />`),
 *  and hands back rasterisable images for the canvas. White strokes: they
 *  sit on coloured discs. */
export function useIconImages(): { images: Map<FileIconKey, HTMLImageElement>; hostRef: React.RefObject<HTMLDivElement | null> } {
  const host = useRef<HTMLDivElement | null>(null);
  const [images, setImages] = useState<Map<FileIconKey, HTMLImageElement>>(new Map());

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const svgs = Array.from(el.querySelectorAll<SVGSVGElement>("svg[data-icon]"));
    const next = new Map<FileIconKey, HTMLImageElement>();
    let pending = svgs.length;
    for (const svg of svgs) {
      const key = svg.dataset.icon as FileIconKey;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
      const img = new Image();
      img.onload = () => { next.set(key, img); if (--pending === 0) setImages(new Map(next)); };
      img.onerror = () => { if (--pending === 0) setImages(new Map(next)); };
      img.src = src;
    }
  }, []);

  return { images, hostRef: host };
}

/** Mount once near the canvas. Invisible. */
export const IconHost = React.forwardRef<HTMLDivElement>(function IconHost(_, ref) {
  return (
    <div ref={ref} aria-hidden style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", opacity: 0 }}>
      {(Object.keys(ICONS) as FileIconKey[]).map((k) => {
        const Icon = ICONS[k];
        return <Icon key={k} data-icon={k} width={48} height={48} strokeWidth={1.9} color="#ffffff" />;
      })}
    </div>
  );
});
