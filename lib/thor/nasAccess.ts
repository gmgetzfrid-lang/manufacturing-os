// lib/thor/nasAccess.ts — open an original THOR file in the browser, read-only.
//
// No gateway, no installed helper, no upload. The person grants the browser
// READ access to a THOR folder once (File System Access API,
// showDirectoryPicker with mode "read"); the handle is kept in this browser's
// IndexedDB so later visits only re-confirm. A search result's path relative
// to the share is walked inside that granted folder and the File is read
// locally — its bytes never leave the machine and nothing is ever written
// back (no write permission is requested, no writable is ever created).
//
// Browser limits are real and are reported, not worked around: only
// Chromium-based browsers have the API; a browser may refuse to hand out a
// network folder; a grant can lapse. Each failure comes back as a reason the
// UI can show next to the exact UNC path to copy instead.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ThorGrant {
  /** Share-relative path the granted folder corresponds to ('' = the share root). */
  base: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  grantedAt: string;
}

export type NasFailure =
  | "unsupported"     // no File System Access API in this browser
  | "no-grant"        // nothing granted that covers this path
  | "denied"          // permission refused or lapsed
  | "cancelled"       // the person closed the picker
  | "rejected"        // the browser refused that folder (system / network restriction)
  | "unrecognised"    // the picked folder is not a folder THOR knows
  | "missing";        // the file is not there any more (moved, renamed, deleted)

export class NasError extends Error {
  constructor(public reason: NasFailure, message: string) { super(message); }
}

export function nasSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as any).showDirectoryPicker === "function";
}

// ── Grants, kept per browser in IndexedDB ───────────────────────────────────

const DB = "thor-nas";
const STORE = "grants";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "key" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise<T>((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const grantKey = (orgId: string, base: string) => `${orgId}:${base}`;

export async function listGrants(orgId: string): Promise<ThorGrant[]> {
  if (typeof indexedDB === "undefined") return [];
  try {
    const all = (await tx("readonly", (s) => s.getAll())) as Array<ThorGrant & { key: string }>;
    return all.filter((g) => g.key.startsWith(`${orgId}:`));
  } catch { return []; }
}

export async function forgetGrant(orgId: string, base: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(grantKey(orgId, base)));
}

/** Children of a granted directory, by name (for recognising what was picked). */
async function childNames(dir: FileSystemDirectoryHandle, cap = 400): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const [name] of (dir as any).entries()) { out.add(String(name).toLowerCase()); if (out.size >= cap) break; }
  return out;
}

/**
 * Ask for read access to a THOR folder. `knownFolder(name)` returns the
 * share-relative paths THOR has for a folder of that name, with each one's
 * child names, so the pick can be placed: the share root itself, a unit
 * folder, anything the crawl walked.
 */
export async function grantFolder(
  orgId: string,
  rootName: string,
  knownFolder: (name: string) => Promise<Array<{ rel: string; children: string[] }>>,
): Promise<ThorGrant> {
  if (!nasSupported()) throw new NasError("unsupported", "This browser cannot open local or network folders. Use Chrome or Edge on a computer that can reach THOR.");
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await (window as any).showDirectoryPicker({ id: "thor", mode: "read" });
  } catch (e) {
    const n = (e as DOMException)?.name;
    if (n === "AbortError") throw new NasError("cancelled", "No folder was picked.");
    if (n === "SecurityError" || n === "NotAllowedError") throw new NasError("rejected", "The browser would not give access to that folder. It may block network shares or system folders — copy the path instead, or try a mapped drive letter for THOR.");
    throw new NasError("rejected", (e as Error).message || "The folder could not be opened.");
  }
  let base: string | null = null;
  if (handle.name.toLowerCase() === rootName.toLowerCase()) base = "";
  else {
    const candidates = await knownFolder(handle.name);
    if (candidates.length === 1) base = candidates[0].rel;
    else if (candidates.length > 1) {
      // Several folders share the name: the one whose contents match.
      const mine = await childNames(handle);
      let best = -1;
      for (const c of candidates) {
        const score = c.children.filter((n) => mine.has(n.toLowerCase())).length;
        if (score > best) { best = score; base = c.rel; }
      }
    }
  }
  if (base === null) throw new NasError("unrecognised", `"${handle.name}" is not a folder the THOR index knows. Pick "${rootName}" (the top of the share) or one of the folders inside it.`);
  const grant: ThorGrant = { base, name: handle.name, handle, grantedAt: new Date().toISOString() };
  await tx("readwrite", (s) => s.put({ ...grant, key: grantKey(orgId, base!) }));
  return grant;
}

/** The deepest grant whose folder contains `relPath`. */
export function grantFor(grants: ThorGrant[], relPath: string): ThorGrant | null {
  let best: ThorGrant | null = null;
  for (const g of grants) {
    const inside = g.base === "" || relPath === g.base || relPath.toLowerCase().startsWith(g.base.toLowerCase() + "/");
    if (inside && (!best || g.base.length > best.base.length)) best = g;
  }
  return best;
}

async function ensureRead(handle: FileSystemDirectoryHandle): Promise<void> {
  const h = handle as any;
  if (typeof h.queryPermission !== "function") return;
  if ((await h.queryPermission({ mode: "read" })) === "granted") return;
  // Needs a click in the page (the caller is a click handler).
  if ((await h.requestPermission({ mode: "read" })) !== "granted") {
    throw new NasError("denied", "Read access to the THOR folder was not confirmed. Click Open again and choose Allow.");
  }
}

/** Find a child by exact name, then case-insensitively (Windows names are). */
async function child(dir: FileSystemDirectoryHandle, name: string, kind: "file" | "directory"): Promise<any> {
  try {
    return kind === "file" ? await dir.getFileHandle(name) : await dir.getDirectoryHandle(name);
  } catch (e) {
    if ((e as DOMException)?.name !== "NotFoundError" && (e as DOMException)?.name !== "TypeError") throw e;
  }
  const want = name.toLowerCase();
  for await (const [n, h] of (dir as any).entries()) {
    if (String(n).toLowerCase() === want && h.kind === kind) return h;
  }
  return null;
}

/** Read one THOR file through a grant. Read-only: returns the File, writes nothing. */
export async function readThorFile(grants: ThorGrant[], relPath: string): Promise<File> {
  if (!nasSupported()) throw new NasError("unsupported", "This browser cannot open THOR files directly. Copy the path and open it in File Explorer.");
  const g = grantFor(grants, relPath);
  if (!g) throw new NasError("no-grant", "Connect THOR first: pick the Equipment Files folder (or the folder this file is in) once, and files open from then on.");
  await ensureRead(g.handle);
  const rest = g.base ? relPath.slice(g.base.length + 1) : relPath;
  const segs = rest.split("/").filter(Boolean);
  let dir: FileSystemDirectoryHandle = g.handle;
  try {
    for (const s of segs.slice(0, -1)) {
      const next = await child(dir, s, "directory");
      if (!next) throw new NasError("missing", `The folder "${s}" is not on THOR any more — it may have been renamed or moved since the index was built.`);
      dir = next;
    }
    const fh = await child(dir, segs[segs.length - 1], "file");
    if (!fh) throw new NasError("missing", "This file is not at its indexed location any more — it may have been renamed, moved or deleted since the index was built.");
    return await (fh as FileSystemFileHandle).getFile();
  } catch (e) {
    if (e instanceof NasError) throw e;
    const n = (e as DOMException)?.name;
    if (n === "NotAllowedError" || n === "SecurityError") throw new NasError("denied", "The browser no longer has access to THOR. Click Open again to re-confirm.");
    if (n === "NotFoundError") throw new NasError("missing", "This file is not at its indexed location any more.");
    if (n === "NotReadableError") throw new NasError("missing", "THOR could not be read — the network share may be offline or the file is locked.");
    throw e;
  }
}

/** How a file can be shown without leaving the page or pretending it is something else. */
export function viewKind(ext: string): "pdf" | "image" | "text" | "none" {
  const e = ext.toLowerCase();
  if (e === "pdf") return "pdf";
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(e)) return "image";
  if (["txt", "log", "csv", "xml", "json", "dat"].includes(e)) return "text";
  return "none";
}
