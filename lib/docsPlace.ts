// lib/docsPlace.ts - getting back to where you were in a library.
//
// Where you are is in the address: the library, the folder (?folderId=),
// the filter typed over the list (?filter=) and the search (?find=). Back,
// Forward and a refresh all land on the same list. What the address does
// not carry - the sort you picked, how far down you had scrolled, the row
// you were on - is kept for the tab (sessionStorage), per folder, and put
// back when you come back to that folder: from a document, the graph, the
// map, another page, or Back.

export interface Place {
  /** How far down the list was scrolled. */
  top?: number;
  /** The row you were on. */
  row?: string | null;
  /** The sort you picked here. */
  sort?: { key: string; dir: "asc" | "desc" } | null;
  at?: number;
}

const KEEP_MS = 4 * 60 * 60_000;
const key = (libraryId: string, folderId: string | null) => `docs:place:${libraryId}:${folderId ?? "root"}`;

export function readPlace(libraryId: string, folderId: string | null): Place | null {
  try {
    const raw = window.sessionStorage.getItem(key(libraryId, folderId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Place;
    return p.at && Date.now() - p.at < KEEP_MS ? p : null;
  } catch { return null; }
}

export function writePlace(libraryId: string, folderId: string | null, patch: Place) {
  try {
    const prev = readPlace(libraryId, folderId) ?? {};
    window.sessionStorage.setItem(key(libraryId, folderId), JSON.stringify({ ...prev, ...patch, at: Date.now() }));
  } catch { /* private window or full: the place is simply not kept */ }
}

/** The address's query with some params set (a value) or removed (null or
 *  empty). Order of the rest is kept, so an unchanged address compares equal. */
export function withParams(search: string, set: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [k, v] of Object.entries(set)) {
    if (v == null || v === "") sp.delete(k); else sp.set(k, v);
  }
  const out = sp.toString();
  return out ? `?${out}` : "";
}

// Was the last move a step through history (Back / Forward)? Next's router
// handles the step itself; this only notes when it happened, so a page can
// tell "came back here" (put the scroll back) from "went somewhere new"
// (start at the top).
let lastPopAt = 0;
if (typeof window !== "undefined") window.addEventListener("popstate", () => { lastPopAt = Date.now(); });
export function steppedThroughHistory(withinMs = 2500): boolean {
  return Date.now() - lastPopAt < withinMs;
}
