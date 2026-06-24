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
    .slice(0, 8)
    .padEnd(8, "0");
  return `MOS-${year}Q${quarter}-${short}`;
}

export type ArchiveKind = "full" | "space";

/**
 * Compose the exact path an archive should live at, by convention, under the
 * org's chosen root folder:
 *   full backups        → <root>/full-backups/<id>.zip
 *   space-saver exports → <root>/data/<id>.zip
 * Separator style is inferred from the root (Windows UNC vs POSIX) so the hint
 * reads naturally on whatever system the admin uses.
 */
export function archiveLocation(root: string | null | undefined, kind: ArchiveKind, archiveId: string): string {
  const sub = kind === "full" ? "full-backups" : "data";
  const base = (root || "").trim().replace(/[/\\]+$/, "");
  const sep = base.includes("\\") ? "\\" : "/";
  const tail = `${sub}${sep}${archiveId}.zip`;
  return base ? `${base}${sep}${tail}` : tail;
}

export interface ArchivedNotice {
  archiveId: string;
  /** The full path the user should browse to (root + convention). */
  location?: string;
  /** One-line, regular-user-friendly explanation + call to action. */
  message: string;
}

/** The message shown when someone opens a file whose binary was shed for space.
 *  Deliberately blame-free and actionable, for any user — not just admins. It
 *  names the EXACT path to fetch (root/data/<id>.zip), not just the id. */
export function archivedNotice(opts: {
  archiveId: string | null | undefined;
  root?: string | null;
  kind?: ArchiveKind;
  fileName?: string | null;
}): ArchivedNotice {
  const id = (opts.archiveId || "").trim();
  const what = (opts.fileName || "This file").trim();
  if (!id) {
    return {
      archiveId: "",
      message:
        `${what} was archived to free storage and isn't kept on our servers. ` +
        `Ask an admin which backup holds it, then drop that file here to view it.`,
    };
  }
  const path = archiveLocation(opts.root, opts.kind ?? "space", id);
  return {
    archiveId: id,
    location: path,
    message:
      `${what} was archived for storage & cost reasons, so it lives in your ` +
      `offline backup rather than on our servers. To view it, browse for ` +
      `${path} and drop it here — it opens instantly, without being re-saved.`,
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
