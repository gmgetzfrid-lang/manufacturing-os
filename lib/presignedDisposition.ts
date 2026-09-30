// lib/presignedDisposition.ts — SEC-7 / SEC-1: how a presigned download is
// allowed to arrive in a browser.
//
// A presigned GET signed with no response overrides is served with whatever
// Content-Type the object was stored with — for an intake upload, the type
// the UPLOADER declared — and the browser is free to render it: an HTML or
// SVG "drawing" opens as a page. So every presigned GET is signed with a
// Content-Disposition:
//
//   * ATTACHMENT by default — the browser saves the file, it never renders
//     it as a page;
//   * INLINE only when the caller explicitly asks (`?inline=1`, the in-app
//     viewers) AND the key names a type the browser shows in a viewer rather
//     than a page — PDF or a raster image. The inline URL also PINS the
//     Content-Type to that type, so whatever the uploader declared (or
//     whatever the bytes really are) the browser treats it as a PDF or an
//     image, never as HTML. SVG is not on the list: an SVG document runs
//     script when it is opened as a page.
//
// The client half — the in-app viewer renders only a PDF or a raster image,
// re-typed to that exact type, and never frames anything else — reads the
// same list through viewerRenderKind.

import { contentDispositionAttachment } from "@/lib/outputTemplateText";

/** Extension → the only Content-Type a presigned URL may be served INLINE
 *  as. Raster images and PDF: what a browser shows in a viewer, not a page. */
export const INLINE_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const INLINE_TYPES = new Set(Object.values(INLINE_TYPES_BY_EXTENSION));

/** The last path segment of a storage key — the download's file name. */
export function storageKeyFilename(key: string): string {
  const base = key.split("/").pop() ?? "";
  return base.trim() || "file";
}

/** The inline type the key's extension names, or null (not inline-safe). */
export function inlineTypeForKey(key: string): string | null {
  const name = storageKeyFilename(key);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return INLINE_TYPES_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** `?inline=` — only an explicit "1" or "true" opts in. */
export function wantsInline(raw: string | null | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export interface PresignedGetDisposition {
  /** True when the URL is signed inline (asked for, and the type is safe). */
  inline: boolean;
  /** The pinned Content-Type when inline; null for an attachment. */
  contentType: string | null;
  /** Spread into the GetObjectCommand input. */
  overrides: { ResponseContentDisposition: string; ResponseContentType?: string };
}

/** The response overrides a presigned GET for `key` is signed with. */
export function presignedGetDisposition(key: string, inlineRequested: boolean): PresignedGetDisposition {
  const attachment = contentDispositionAttachment(storageKeyFilename(key));
  const type = inlineRequested ? inlineTypeForKey(key) : null;
  if (!type) {
    return { inline: false, contentType: null, overrides: { ResponseContentDisposition: attachment } };
  }
  return {
    inline: true,
    contentType: type,
    overrides: {
      ResponseContentDisposition: attachment.replace(/^attachment/, "inline"),
      ResponseContentType: type,
    },
  };
}

/** What the in-app viewer may render a fetched file as, from the type it
 *  arrived with: "pdf", "image", or null (offer nothing — never frame it).
 *  `type` is the canonical type to re-type the bytes to before rendering. */
export function viewerRenderKind(rawType: string | null | undefined): { kind: "pdf" | "image"; type: string } | null {
  const type = (rawType ?? "").split(";")[0].trim().toLowerCase();
  if (!INLINE_TYPES.has(type)) return null;
  return { kind: type === "application/pdf" ? "pdf" : "image", type };
}
