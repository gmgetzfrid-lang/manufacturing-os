// lib/filePreview.ts - which files the app can show in place, and what to
// call the rest.
//
// A frame pointed at a file the browser can't draw (a Word document, a
// spreadsheet, a CAD file) makes the browser download it: on a phone that
// is the "Do you want to download…?" prompt the moment a panel opens. So
// only PDFs and pictures preview on their own; anything else shows as a
// file card with its type and size, and opens or downloads only when the
// person presses for it.

export type PreviewKind = "pdf" | "image" | "none";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/** The extension of a file name or storage path, lower case, no dot. */
export function extensionOf(name: string | null | undefined): string {
  const clean = String(name ?? "").split(/[?#]/)[0];
  const last = clean.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

/** What the file can be shown as. The type the file was stored with wins;
 *  the extension decides when there is no type (or only a generic one). */
export function previewKind(input: { fileName?: string | null; mime?: string | null; path?: string | null }): PreviewKind {
  const mime = String(input.mime ?? "").toLowerCase().trim();
  const ext = extensionOf(input.fileName) || extensionOf(input.path);
  if (mime === "application/pdf") return "pdf";
  if (/^image\/(png|jpe?g|gif|webp|bmp)$/.test(mime)) return "image";
  const generic = !mime || mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "-";
  if (!generic) return "none";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  return "none";
}

const NAMES: Record<string, string> = {
  doc: "Word document", docx: "Word document", docm: "Word document", rtf: "Word document",
  xls: "Excel workbook", xlsx: "Excel workbook", xlsm: "Excel workbook", csv: "Spreadsheet (CSV)",
  ppt: "PowerPoint deck", pptx: "PowerPoint deck",
  dwg: "AutoCAD drawing", dxf: "CAD drawing (DXF)", dgn: "MicroStation drawing",
  txt: "Text file", zip: "Zip archive", msg: "Outlook email", eml: "Email",
  vsd: "Visio drawing", vsdx: "Visio drawing", tif: "TIFF image", tiff: "TIFF image",
  pdf: "PDF", png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image",
};

/** "Word document (.docx)", or "File" when nothing is known. */
export function fileTypeName(input: { fileName?: string | null; mime?: string | null; path?: string | null }): string {
  const ext = extensionOf(input.fileName) || extensionOf(input.path);
  const name = NAMES[ext];
  if (name) return `${name} (.${ext})`;
  return ext ? `${ext.toUpperCase()} file` : "File";
}

/** "1.2 MB" from bytes; "" when unknown. */
export function sizeWords(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
