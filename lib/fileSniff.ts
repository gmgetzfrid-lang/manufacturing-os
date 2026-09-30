// lib/fileSniff.ts
//
// What a file IS, read from its first bytes — never from the name or the
// Content-Type the uploader declared (projects-tab SEC-1 / SEC-6,
// projects-and-cost INTK-11). The external intake door is unauthenticated:
// the filename and the declared type are both attacker-controlled, so the
// stored ContentType must come from the bytes, and a file whose bytes are
// not on the door's allowlist is refused before it reaches storage.
//
// Pure (no I/O), so the route, the tests and any future door share one
// rule. The allowlist is deliberately short (fail-safe: fewer types) —
// quotes are PDF only; drawings are PDF, DWG, DXF or ZIP (the
// projects-and-cost default); redlines add PNG and JPEG — a phone photo or
// a scan of a marked-up print is the common redline (the projects-tab
// default), and a raster image carries no script. Anything else is refused
// naming the accepted list.

export type SniffedKind = "pdf" | "dwg" | "dxf" | "zip" | "png" | "jpeg";

export type IntakeBranch = "quote" | "document" | "redline";

/** The Content-Type stored on the object — derived from the sniffed kind. */
export const KIND_CONTENT_TYPE: Record<SniffedKind, string> = {
  pdf: "application/pdf",
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
  zip: "application/zip",
  png: "image/png",
  jpeg: "image/jpeg",
};

/** The filename extension each kind must carry. */
export const KIND_EXTENSIONS: Record<SniffedKind, readonly string[]> = {
  pdf: ["pdf"],
  dwg: ["dwg"],
  dxf: ["dxf"],
  zip: ["zip"],
  png: ["png"],
  jpeg: ["jpg", "jpeg"],
};

/** Declared types a browser or OS plausibly sends for each kind. An empty
 *  type and application/octet-stream are accepted for every kind (browsers
 *  send one of them for CAD files); anything else must be on this list —
 *  a PDF declared as text/html is refused, never "corrected". */
export const KIND_DECLARED_TYPES: Record<SniffedKind, readonly string[]> = {
  pdf: ["application/pdf", "application/x-pdf"],
  dwg: ["image/vnd.dwg", "image/x-dwg", "application/acad", "application/x-acad", "application/autocad_dwg", "application/dwg", "application/x-dwg", "drawing/dwg"],
  dxf: ["image/vnd.dxf", "image/x-dxf", "application/dxf", "application/x-dxf", "text/plain"],
  zip: ["application/zip", "application/x-zip", "application/x-zip-compressed", "multipart/x-zip"],
  png: ["image/png"],
  jpeg: ["image/jpeg", "image/pjpeg"],
};

export const BRANCH_ALLOWLIST: Record<IntakeBranch, readonly SniffedKind[]> = {
  quote: ["pdf"],
  document: ["pdf", "dwg", "dxf", "zip"],
  redline: ["pdf", "dwg", "dxf", "zip", "png", "jpeg"],
};

const KIND_LABEL: Record<SniffedKind, string> = { pdf: "PDF", dwg: "DWG", dxf: "DXF", zip: "ZIP", png: "PNG", jpeg: "JPEG" };

/** "PDF", "PDF, DWG, DXF or ZIP" — the accepted list, named in refusals. */
export function acceptedLabel(branch: IntakeBranch): string {
  const labels = BRANCH_ALLOWLIST[branch].map((k) => KIND_LABEL[k]);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** How many leading bytes the sniff needs. */
export const SNIFF_BYTES = 64;

function ascii(head: Uint8Array, n: number): string {
  let s = "";
  for (let i = 0; i < Math.min(n, head.length); i++) s += String.fromCharCode(head[i]);
  return s;
}

/** The kind the bytes declare, or null when they match nothing on any list.
 *  Magic numbers only — PDF `%PDF-` at offset 0 (strict: no leading junk),
 *  DWG `AC10nn`, ZIP local-file header `PK\x03\x04` (an empty archive's
 *  end-of-directory `PK\x05\x06` is not a file), DXF the binary sentinel or
 *  the ASCII `0 / SECTION` opening (after an optional 999 comment), PNG its
 *  eight-byte signature, JPEG `FF D8 FF`. */
export function sniffKind(head: Uint8Array): SniffedKind | null {
  const s = ascii(head, SNIFF_BYTES);
  if (s.startsWith("%PDF-")) return "pdf";
  if (s.startsWith("\x89PNG\r\n\x1a\n")) return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (/^AC10\d\d/.test(s)) return "dwg";
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return "zip";
  if (s.startsWith("AutoCAD Binary DXF\r\n\x1a\x00")) return "dxf";
  // ASCII DXF, after an optional UTF-8 byte-order mark (read here as the
  // three latin-1 characters EF BB BF).
  const text = s.replace(/^ï»¿/, "");
  if (/^[ \t\r\n]*(?:999[ \t]*\r?\n[^\r\n]*\r?\n[ \t]*)?0[ \t]*\r?\n[ \t]*SECTION\b/.test(text)) return "dxf";
  return null;
}

function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function normaliseDeclared(t: string | null | undefined): string {
  return String(t ?? "").split(";")[0].trim().toLowerCase();
}

export type IntakeFileVerdict =
  | { ok: true; kind: SniffedKind; contentType: string }
  | { ok: false; message: string };

/** The door's content rule: the bytes must be an allowlisted kind for this
 *  branch, the filename's extension must name that kind, and the declared
 *  type (if any) must be one a real file of that kind is sent with. The
 *  ContentType to store is the sniffed kind's — never `file.type`. */
export function validateIntakeFile(input: {
  branch: IntakeBranch;
  fileName: string;
  declaredType: string | null | undefined;
  head: Uint8Array;
}): IntakeFileVerdict {
  const accepted = acceptedLabel(input.branch);
  const kind = sniffKind(input.head);
  if (!kind || !BRANCH_ALLOWLIST[input.branch].includes(kind)) {
    return { ok: false, message: `This file type isn't accepted here — upload a ${accepted} file.` };
  }
  const ext = extensionOf(input.fileName);
  if (!KIND_EXTENSIONS[kind].includes(ext)) {
    return { ok: false, message: `The file's name doesn't match its contents (a ${KIND_LABEL[kind]} file must end in .${KIND_EXTENSIONS[kind][0]}). Upload a ${accepted} file with its real extension.` };
  }
  const declared = normaliseDeclared(input.declaredType);
  if (declared && declared !== "application/octet-stream" && !KIND_DECLARED_TYPES[kind].includes(declared)) {
    return { ok: false, message: `The file was sent as "${declared}", which isn't a ${KIND_LABEL[kind]} type. Upload a ${accepted} file.` };
  }
  return { ok: true, kind, contentType: KIND_CONTENT_TYPE[kind] };
}
