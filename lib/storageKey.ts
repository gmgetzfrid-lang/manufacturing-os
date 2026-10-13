// lib/storageKey.ts — one gate every storage route runs a caller-supplied
// R2 key through before it reaches the bucket. Pure (no server imports): the
// workspace-logo rule below is also the logo modal's pre-check.
//
// R2 (the S3 API) treats object keys as opaque byte strings — it does NOT
// collapse "../" the way a filesystem does, so a literal key like
// orgs/A/../../orgs/B/secret.pdf never resolves to another org's real
// object. But the org-membership gate in every route authorizes the caller
// against the FIRST "orgs/<uuid>/" segment it can parse, then signs the key
// verbatim. A key that starts with one org's prefix but continues with
// "../" segments would pass that gate while naming something else — so the
// safe move is to refuse traversal outright rather than reason about
// whether the downstream store happens to normalize it today.
//
// Keys the app itself mints are always clean (orgs/<uuid>/<area>/<name>),
// so this only ever rejects hand-crafted input.

export class UnsafeStorageKeyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "UnsafeStorageKeyError";
  }
}

/** Backslash, or any control byte (NUL..0x1F, DEL) — none belong in a key. */
function hasIllegalChar(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x5c /* backslash */) return true;
  }
  return false;
}

/**
 * Throw if `key` is anything other than a plain, forward-only object key.
 * Rejects: empty, too long, leading slash, backslashes, NUL / control
 * bytes, any "." or ".." path segment, and doubled slashes (empty
 * segments). Returns the key unchanged when safe, so call sites can inline
 * the result.
 */
export function assertSafeStorageKey(key: string): string {
  if (!key) throw new UnsafeStorageKeyError("path is required");
  if (key.length > 2048) throw new UnsafeStorageKeyError("path is too long");
  if (hasIllegalChar(key)) throw new UnsafeStorageKeyError("path contains illegal characters");
  if (key.startsWith("/")) throw new UnsafeStorageKeyError("path must not start with /");
  for (const seg of key.split("/")) {
    if (seg === "") throw new UnsafeStorageKeyError("path has an empty segment");
    if (seg === "." || seg === "..") {
      throw new UnsafeStorageKeyError("path traversal is not allowed");
    }
  }
  return key;
}

/** Non-throwing variant for call sites that prefer a boolean. */
export function isSafeStorageKey(key: string): boolean {
  try { assertSafeStorageKey(key); return true; } catch { return false; }
}

// ── admin-and-org ORG-5: the workspace-logo area ────────────────────────────
// The workspace logo lives DIRECTLY under orgs/<org>/branding/ (the branding
// page and the sidebar's logo modal both mint orgs/<org>/branding/logo-<uuid>.<ext>).
// Its pointer (org_configurations key='branding', data.logoPath) is Admin-only
// at the database (20260713) and readable by every member, so the bytes at
// that key must be Admin-only too, or any member could overwrite the logo
// every member sees. The sub-folders branding/covers/ and
// branding/backgrounds/ are a folder's or library's cover and page
// background (components/documents/CustomizeNodeModal.tsx), written by
// whoever customizes that node — they are NOT the logo area; their rule is
// the node editor's (ORG-16, below). Pure (no server imports): the logo
// modal reads the same allow-list and cap for its pre-check.

/** The image types a logo may be stored as. SVG is refused: it can carry
 *  script, and a presigned PUT never passes its bytes through the server, so
 *  it cannot be sanitised on the way in. Exact strings: the PUT must send the
 *  same Content-Type the server signs. */
export const LOGO_CONTENT_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

/** The largest logo the server signs a PUT for (5 MB). */
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

/** True when `key` is a file directly under orgs/<uuid>/branding/ — the
 *  workspace-logo area (not its covers/ or backgrounds/ sub-folders). */
export function isWorkspaceLogoKey(key: string): boolean {
  return /^orgs\/[0-9a-fA-F-]{36}\/branding\/[^/]+$/.test(key);
}

/** Why a logo upload of this type and size is refused (with the HTTP status
 *  the route answers), or null when it may be signed. `size` is the byte
 *  count the client declares; the server signs it as the PUT's
 *  Content-Length, so a body of any other length is refused by storage. */
export function logoUploadProblem(contentType: unknown, size: unknown): { status: 400 | 413 | 415; error: string } | null {
  if (typeof contentType !== "string" || !LOGO_CONTENT_TYPES.includes(contentType)) {
    return { status: 415, error: "A workspace logo must be a PNG, JPEG or WebP image (SVG is not accepted)." };
  }
  const n = typeof size === "number" ? size : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) return { status: 400, error: "The logo's size is required to upload it." };
  if (n > LOGO_MAX_BYTES) return { status: 413, error: "A workspace logo can be at most 5 MB." };
  return null;
}

/** The extension a new logo's key is minted with, from its allow-listed type
 *  — never from the file's name, which can be anything (Windows names a JPEG
 *  "….jfif"; a name may have no extension at all). A key named by its type
 *  is one a backup restore can read the type back from. Null for a type the
 *  allow-list refuses. */
export function logoExtensionForType(contentType: unknown): "png" | "jpg" | "webp" | null {
  switch (contentType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    default: return null;
  }
}

/** An image's type read from its first bytes (12 are enough), or null when
 *  they are none of these: PNG (89 50 4E 47), JPEG (FF D8 FF), WebP
 *  ("RIFF" … "WEBP"), GIF ("GIF8"). The restore uses it for a logo whose key's
 *  extension does not say what the bytes are. */
export function sniffImageType(head: Uint8Array | null | undefined): string | null {
  if (!head || head.length < 3) return null;
  const at = (i: number) => (i < head.length ? head[i] : -1);
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
      at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  return null;
}

// ── admin-and-org ORG-16: a folder's or library's cover and background ─────
// CustomizeNodeModal uploads a node's cover to orgs/<org>/branding/covers/
// <uuid>.<ext> and its page background to …/branding/backgrounds/<uuid>.<ext>
// (the prefix handed in by app/(protected)/documents/page.tsx and
// documents/[libraryId]/page.tsx). Those bytes are what every member who can
// see the node is shown, so writing them is held to the authority that opens
// the node editor, and to image types (ORG-5's rule on the smaller surface).

/** True when `key` is under orgs/<uuid>/branding/covers/ or
 *  …/branding/backgrounds/ (any depth: the app mints one level, a hand-made
 *  deeper key is held to the same rule). */
export function isNodeImageKey(key: string): boolean {
  return /^orgs\/[0-9a-fA-F-]{36}\/branding\/(?:covers|backgrounds)\/.+$/.test(key);
}

/** Who may write a node's cover or background bytes: the node editor's gate.
 *  Both places that open CustomizeNodeModal offer it only when
 *  `hasAnyRole(["Admin", "DocCtrl"])` (the controller tier, by the full role
 *  collection: documents/page.tsx `isController` → LibraryAdminMenu
 *  onCustomize; documents/[libraryId]/page.tsx `isController` → the folder
 *  tree's onCustomize). A test pins both gates to this list, so the two
 *  cannot drift. */
export const NODE_CUSTOMIZE_ROLES: readonly string[] = ["Admin", "DocCtrl"];

/** The image types a cover or background may be stored as: the raster
 *  formats every current browser draws (BMP included: it carries no script).
 *  SVG is refused, as for the logo (it can carry script and a presigned PUT
 *  never passes the server); so is any non-image type (an HTML page at a
 *  cover key). Exact strings: the PUT must send the type the server signs.
 *  No size cap (a phone photo is fine). */
export const NODE_IMAGE_CONTENT_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"];

/** Why a cover / background upload of this type is refused (415), or null. */
export function nodeImageUploadProblem(contentType: unknown): { status: 415; error: string } | null {
  if (typeof contentType === "string" && NODE_IMAGE_CONTENT_TYPES.includes(contentType)) return null;
  return { status: 415, error: "A cover or background image must be a PNG, JPEG, WebP, GIF, AVIF or BMP image (SVG is not accepted)." };
}

/** A cover's or background's type read from its first bytes (12 are
 *  enough): the logo's four (sniffImageType), plus BMP ("BM") and AVIF (an
 *  ISO-BMFF "ftyp" box branded avif / avis). Null when none matches. Kept
 *  apart from sniffImageType so the logo's restore rule (ORG-5) is unchanged. */
export function sniffNodeImageType(head: Uint8Array | null | undefined): string | null {
  const known = sniffImageType(head);
  if (known || !head) return known;
  const at = (i: number) => (i < head.length ? head[i] : -1);
  if (at(0) === 0x42 && at(1) === 0x4d) return "image/bmp";
  const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70 && (brand === "avif" || brand === "avis")) return "image/avif";
  return null;
}

/** The type CustomizeNodeModal sends for a picked cover / background, or
 *  null when it is not an image the routes sign. The browser's own type
 *  when it is on the allow-list; the legacy JPEG aliases (image/jpg,
 *  image/pjpeg, which some desktop mime databases report) as image/jpeg;
 *  otherwise (an empty or unknown type) the type the file's first bytes
 *  show. */
export function nodeImageTypeFor(declared: unknown, head: Uint8Array | null | undefined): string | null {
  const t = typeof declared === "string" ? declared.trim().toLowerCase() : "";
  if (NODE_IMAGE_CONTENT_TYPES.includes(t)) return t;
  if (t === "image/jpg" || t === "image/pjpeg") return "image/jpeg";
  return sniffNodeImageType(head);
}

/** The extension a new cover's / background's key is minted with, from its
 *  allowed type — never from the file's name (which may have none, or say
 *  ".jfif"), so a backup restore can read the type back from the key. */
export function nodeImageExtensionForType(contentType: string): string {
  switch (contentType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    case "image/avif": return "avif";
    case "image/bmp": return "bmp";
    default: return "bin";
  }
}

// ── Putting a backup's files back (ORG-5, fix pass) ──────────────────────────
// The restore page (app/(protected)/admin/restore/page.tsx, "Put the files
// back") re-uploads every file a Full ZIP carries through
// /api/storage/upload-url, under the original (org-remapped) keys. A backup
// carries the workspace logo (lib/storageKeyRegistry.ts registers the
// branding logoPath for export), and upload-url signs a logo only with its
// type AND its size, so the restore's request must carry both, and its PUT
// must send the type the request named. One helper builds both, so the page
// and the test that drives upload-url with the page's body cannot drift.

/** The Content-Type a backup file is put back with, by its key's extension
 *  (the restore page's table; ORG-16 adds jfif, avif and bmp, so a cover or
 *  background stored under one — the modal named a key after the file — is
 *  put back as the image type upload-url now requires, not as
 *  application/octet-stream). */
const RESTORE_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg",
  gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", txt: "text/plain",
  csv: "text/csv", zip: "application/zip", dxf: "image/vnd.dxf", dwg: "application/acad",
  doc: "application/msword", xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function contentTypeForKey(key: string): string {
  return RESTORE_CONTENT_TYPES[(key.toLowerCase().split(".").pop() || "")] || "application/octet-stream";
}

/** What the restore page sends to put one backup file of `size` bytes back
 *  at `key`: the presign request's body and the PUT's Content-Type (the same
 *  type). `logoProblem` is set only for a workspace logo upload-url will not
 *  sign — an SVG or GIF logo uploaded before ORG-5, or one over 5 MB. The
 *  page does not ask for it, and says the logo must be uploaded again.
 *  `nodeImageProblem` is the same for a folder's or library's cover or
 *  background that upload-url will not sign (ORG-16): the page names it and
 *  says to pick the image again under Customize.
 *
 *  `head` (a logo's first bytes) decides a logo's type when they are a known
 *  image: logo keys used to be minted from the file's NAME, so a real JPEG
 *  can sit at "….jfif" or under no extension at all, and upload-url signed
 *  it by its declared type. A cover's or background's first bytes decide
 *  its type the same way (ORG-16): their keys were named after the file too
 *  ("<uuid>.photo" for a name with no extension), and upload-url now signs
 *  them only as an image type. Without the bytes, the key's extension
 *  decides, as for every other file. */
export function restoreUploadRequest(key: string, size: number, head?: Uint8Array | null): {
  contentType: string;
  body: { path: string; contentType: string; size: number };
  logoProblem: string | null;
  nodeImageProblem: string | null;
} {
  const sniffed = isWorkspaceLogoKey(key) ? sniffImageType(head)
    : isNodeImageKey(key) ? sniffNodeImageType(head)
    : null;
  const contentType = sniffed ?? contentTypeForKey(key);
  const problem = isWorkspaceLogoKey(key) ? logoUploadProblem(contentType, size) : null;
  // A cover or background upload-url will not sign (an SVG, HEIC or TIFF
  // stored before ORG-16, or bytes that are no allowed image under an
  // extension the table does not name) is not asked for: the restore page
  // names it, as it names a logo it cannot put back (ORG-16 review fix).
  const nodeProblem = isNodeImageKey(key) ? nodeImageUploadProblem(contentType) : null;
  return {
    contentType, body: { path: key, contentType, size },
    logoProblem: problem?.error ?? null, nodeImageProblem: nodeProblem?.error ?? null,
  };
}
