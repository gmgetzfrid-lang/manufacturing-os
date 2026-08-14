// lib/storageKey.ts — SERVER-ONLY. One gate every storage route runs a
// caller-supplied R2 key through before it reaches the bucket.
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
