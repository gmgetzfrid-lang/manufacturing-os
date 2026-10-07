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
// whoever customizes that node — they are NOT the logo area and keep the
// membership rule. Pure (no server imports): the logo modal reads the same
// allow-list and cap for its pre-check.

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
