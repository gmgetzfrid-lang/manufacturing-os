// lib/fileFinder/fileTypes.ts — what kind of file is this, at a glance.
//
// The map shows an icon per file type, not a coloured dot: a PDF, a CAD
// drawing, a spreadsheet and a photo are different things to the person
// hunting for one of them. Pure: extension in, icon key + colour + label out.

export type FileIconKey =
  | "pdf" | "cad" | "sheet" | "doc" | "code" | "image" | "archive" | "slides" | "mail" | "file"
  | "library" | "folder" | "folderOpen" | "drive";

export interface FileTypeInfo {
  key: FileIconKey;
  label: string;
  /** Ring colour on the map and chip colour in lists. */
  color: string;
  ext: string;
}

const BY_EXT: Record<string, { key: FileIconKey; label: string; color: string }> = {
  pdf: { key: "pdf", label: "PDF", color: "#dc2626" },
  dwg: { key: "cad", label: "AutoCAD drawing", color: "#ea580c" },
  dxf: { key: "cad", label: "CAD exchange", color: "#ea580c" },
  dgn: { key: "cad", label: "MicroStation drawing", color: "#ea580c" },
  rvt: { key: "cad", label: "Revit model", color: "#ea580c" },
  xls: { key: "sheet", label: "Excel", color: "#16a34a" },
  xlsx: { key: "sheet", label: "Excel", color: "#16a34a" },
  xlsm: { key: "sheet", label: "Excel (macros)", color: "#16a34a" },
  csv: { key: "sheet", label: "CSV", color: "#16a34a" },
  doc: { key: "doc", label: "Word", color: "#2563eb" },
  docx: { key: "doc", label: "Word", color: "#2563eb" },
  rtf: { key: "doc", label: "Rich text", color: "#2563eb" },
  txt: { key: "doc", label: "Text", color: "#64748b" },
  md: { key: "doc", label: "Markdown", color: "#64748b" },
  xml: { key: "code", label: "XML", color: "#7c3aed" },
  json: { key: "code", label: "JSON", color: "#7c3aed" },
  html: { key: "code", label: "HTML", color: "#7c3aed" },
  yaml: { key: "code", label: "YAML", color: "#7c3aed" },
  yml: { key: "code", label: "YAML", color: "#7c3aed" },
  png: { key: "image", label: "Image", color: "#db2777" },
  jpg: { key: "image", label: "Image", color: "#db2777" },
  jpeg: { key: "image", label: "Image", color: "#db2777" },
  gif: { key: "image", label: "Image", color: "#db2777" },
  tif: { key: "image", label: "TIFF scan", color: "#db2777" },
  tiff: { key: "image", label: "TIFF scan", color: "#db2777" },
  bmp: { key: "image", label: "Image", color: "#db2777" },
  svg: { key: "image", label: "Vector image", color: "#db2777" },
  zip: { key: "archive", label: "ZIP archive", color: "#6b7280" },
  rar: { key: "archive", label: "RAR archive", color: "#6b7280" },
  "7z": { key: "archive", label: "7z archive", color: "#6b7280" },
  ppt: { key: "slides", label: "PowerPoint", color: "#d97706" },
  pptx: { key: "slides", label: "PowerPoint", color: "#d97706" },
  msg: { key: "mail", label: "Outlook message", color: "#0891b2" },
  eml: { key: "mail", label: "Email", color: "#0891b2" },
};

export const CONTAINER_TYPES: Record<"library" | "folder" | "folderOpen" | "drive", FileTypeInfo> = {
  library: { key: "library", label: "Library", color: "#7c3aed", ext: "" },
  folder: { key: "folder", label: "Folder", color: "#d97706", ext: "" },
  folderOpen: { key: "folderOpen", label: "Folder", color: "#d97706", ext: "" },
  drive: { key: "drive", label: "Drive listing", color: "#0f766e", ext: "" },
};

export function fileTypeOf(name: string): FileTypeInfo {
  const m = name.match(/\.([A-Za-z0-9]{1,5})$/);
  const ext = m ? m[1].toLowerCase() : "";
  const t = BY_EXT[ext];
  if (t) return { ...t, ext };
  return { key: "file", label: ext ? `.${ext} file` : "File", color: "#64748b", ext };
}
