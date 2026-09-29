// lib/restoreVerify.ts — the two pure checks the ticket-archive RESTORE path
// runs before a byte reaches authoritative storage (document-control RET-14).
//
// The read-only dropped-archive viewer (lib/archive.ts findInBackup) may
// tolerate a re-laid-out zip with a suffix match, because it only displays.
// The one path that WRITES bytes back into R2 may not: it takes the entry
// whose path IS the key, and only when the bytes match the sha256 + size the
// producer recorded in files-manifest.json.

import { createHash } from "node:crypto";

/** The zip entry whose path IS the storage key — tolerant only of a leading
 *  slash and the `files/` wrapper the producer writes, never a suffix match. */
export function exactEntryFor(entryPaths: readonly string[], storageKey: string): string | null {
  const norm = (p: string) => {
    let s = p.replace(/^\/+/, "");
    if (s.toLowerCase().startsWith("files/")) s = s.slice("files/".length);
    return s;
  };
  const key = norm(storageKey);
  if (!key) return null;
  for (const entry of entryPaths) if (norm(entry) === key) return entry;
  return null;
}

export type ManifestEntry = { sha256?: unknown; size?: unknown };

/** True when the bytes are exactly what the producer recorded for this key:
 *  a well-formed sha256 that matches, and (when recorded) the same size. */
export function bytesMatchManifest(bytes: Uint8Array, entry: ManifestEntry | undefined): boolean {
  if (!entry || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(entry.sha256)) return false;
  if (typeof entry.size === "number" && entry.size !== bytes.byteLength) return false;
  return createHash("sha256").update(bytes).digest("hex") === entry.sha256.toLowerCase();
}
