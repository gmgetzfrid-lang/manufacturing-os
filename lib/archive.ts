// lib/archive.ts
//
// Archive identity + the in-memory lookup brain for Machine A. All pure and
// deterministic so it's unit-tested without a DB or a real zip.
//
//   makeArchiveId   — the stable human label an admin quotes to a user
//                     ("provide archive MOS-2026Q2-A1B2").
//   archivedNotice  — the friendly message a REGULAR user sees when a file was
//                     shed for space ("archived for storage/cost — provide X").
//   findInBackup    — given the file list of a dropped backup zip and a storage
//                     key, find the matching entry so we can read it in memory
//                     and show it, then discard (never re-upload).

export interface ArchiveIdParts {
  /** When the archive was produced. */
  at: Date;
  /** A short disambiguator — typically the last few chars of a uuid. */
  token: string;
}

/** Stable, human, sortable archive label, e.g. "MOS-2026Q2-A1B2". */
export function makeArchiveId({ at, token }: ArchiveIdParts): string {
  const year = at.getUTCFullYear();
  const quarter = Math.floor(at.getUTCMonth() / 3) + 1;
  const short = (token || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4)
    .padEnd(4, "0");
  return `MOS-${year}Q${quarter}-${short}`;
}

export interface ArchivedNotice {
  archiveId: string;
  locationHint?: string;
  /** One-line, regular-user-friendly explanation + call to action. */
  message: string;
}

/** The message shown when someone opens a file whose binary was shed for space.
 *  Deliberately blame-free and actionable, for any user — not just admins. */
export function archivedNotice(opts: {
  archiveId: string | null | undefined;
  locationHint?: string | null;
  fileName?: string | null;
}): ArchivedNotice {
  const id = (opts.archiveId || "").trim();
  const where = (opts.locationHint || "").trim();
  const what = (opts.fileName || "This file").trim();
  if (!id) {
    return {
      archiveId: "",
      locationHint: where || undefined,
      message:
        `${what} was archived to free storage and isn't kept on our servers. ` +
        `Ask an admin which backup holds it, then drop that file here to view it.`,
    };
  }
  const wherePart = where ? ` (kept at ${where})` : "";
  return {
    archiveId: id,
    locationHint: where || undefined,
    message:
      `${what} was archived for storage & cost reasons, so it lives in your ` +
      `offline backup rather than on our servers. To view it, provide archive ` +
      `${id}${wherePart} — drop that backup file here and it opens instantly, ` +
      `without being re-saved.`,
  };
}

/** Normalize a path for comparison: drop a leading slash and a leading
 *  "files/" folder (the zip wraps binaries under /files/<storage-key>). */
function normalizePath(p: string): string {
  let s = p.replace(/^\/+/, "");
  if (s.toLowerCase().startsWith("files/")) s = s.slice("files/".length);
  return s;
}

/**
 * Find the zip entry that corresponds to a storage key, tolerant of the
 * "files/" wrapper, leading slashes, and a future layout that strips the common
 * "orgs/<id>/" prefix. Returns the ORIGINAL entry path (to read from the zip),
 * or null if not present.
 */
export function findInBackup(entryPaths: string[], storageKey: string): string | null {
  const key = normalizePath(storageKey);
  if (!key) return null;

  let suffixMatch: string | null = null;
  for (const entry of entryPaths) {
    const norm = normalizePath(entry);
    if (norm === key) return entry; // exact — best
    // Suffix match handles a stripped "orgs/<id>/" prefix on either side.
    if (suffixMatch === null && (norm.endsWith("/" + key) || key.endsWith("/" + norm))) {
      suffixMatch = entry;
    }
  }
  return suffixMatch;
}
