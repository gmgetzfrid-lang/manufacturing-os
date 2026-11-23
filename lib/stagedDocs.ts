// lib/stagedDocs.ts
//
// The staged documents: a person's own working set, gathered from any folder
// or library to view side by side, mark up and send together. Kept per person
// and workspace in this browser (localStorage), in the order they were
// staged, with the markups drawn on each one. It survives leaving the library
// and closing the viewer; it is not on the server, so another device or
// browser has its own (and the Staged page says so).
//
// Every read and write is guarded: a private window, blocked site data or a
// full quota never breaks a page. A write that does not fit throws
// StagedStorageFullError with a message to show, and nothing already kept is
// lost (the old copy stays until a write succeeds).
//
// Tabs stay in step: another tab's change arrives as a `storage` event, and a
// change in this tab is announced with STAGED_CHANGE_EVENT.

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

/** A staged document: enough to list it and find it again. */
export interface StagedDoc {
  id: string;
  documentNumber: string | null;
  title: string | null;
  rev: string | null;
  libraryId: string;
  libraryName?: string;
  name?: string;
  status?: string;
  /** The sheet, for drawings that share one number. */
  sheet?: string;
}

/** One document's markups: the viewer's fabric page states, normalized to
 *  PDF points, keyed by 1-based page number. */
export type PageMarkups = Record<number, object>;
/** Markups by document id. */
export type StagedMarkups = Record<string, PageMarkups>;

export interface StagedState {
  docs: StagedDoc[];
  markups: StagedMarkups;
}

/** A write did not fit in this browser's storage. `message` is for people. */
export class StagedStorageFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagedStorageFullError";
  }
}

/** Fired on `window` after this tab changes a staged set (detail: { key }). */
export const STAGED_CHANGE_EVENT = "mfg-os:staged-change";

/** The most the markups may take, in characters (browsers allow about five
 *  million per site, shared with everything else the app keeps). */
export const MARKUP_BUDGET_CHARS = 3_000_000;

export const FULL_FOR_MARKUPS =
  "There is no room left on this device to keep these markups. They are still on the sheet until you close it: send them now, or clear markups on sheets you no longer need.";
export const FULL_FOR_LIST =
  "There is no room left on this device to keep the staged list. Clear markups on sheets you no longer need, then try again.";

// ─── Storage ───────────────────────────────────────────────────────────

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;
let storageOverride: KV | null | undefined;

/** Tests: use this storage instead of window.localStorage (undefined: back
 *  to the browser's). Clears the in-memory copies. */
export function setStagedStorageForTests(s: KV | null | undefined): void {
  storageOverride = s;
  cache.clear();
}

function storage(): KV | null {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // blocked site data
  }
}

/** The key one person's staged set lives under, in one workspace. */
export function stagedKey(orgId: string, uid: string): string {
  return `mfg-os.staged.v1:${orgId}:${uid}`;
}
const marksKeyOf = (key: string) => `${key}:markups`;

function getRaw(k: string): string | null {
  try {
    return storage()?.getItem(k) ?? null;
  } catch {
    return null;
  }
}

function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: string; code?: number };
  return err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED" || err.code === 22 || err.code === 1014;
}

function putRaw(k: string, value: string | null, fullMessage: string): void {
  const s = storage();
  if (!s) return; // nowhere to keep it: the page still works for this visit
  try {
    if (value === null) s.removeItem(k);
    else s.setItem(k, value);
  } catch (e) {
    if (isQuotaError(e)) throw new StagedStorageFullError(fullMessage);
    // Storage refused for another reason (blocked): nothing to keep it in.
  }
}

// ─── Reading ───────────────────────────────────────────────────────────

const EMPTY: StagedState = Object.freeze({ docs: [], markups: {} }) as StagedState;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function parseDocs(raw: string | null): StagedDoc[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { docs?: unknown };
    if (!Array.isArray(v?.docs)) return [];
    const seen = new Set<string>();
    const out: StagedDoc[] = [];
    for (const d of v.docs as Array<Record<string, unknown>>) {
      const id = str(d?.id), libraryId = str(d?.libraryId);
      if (!id || !libraryId || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id, libraryId,
        documentNumber: str(d.documentNumber), title: str(d.title), rev: str(d.rev),
        ...(str(d.libraryName) ? { libraryName: str(d.libraryName)! } : {}),
        ...(str(d.name) ? { name: str(d.name)! } : {}),
        ...(str(d.status) ? { status: str(d.status)! } : {}),
        ...(str(d.sheet) ? { sheet: str(d.sheet)! } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function parseMarkups(raw: string | null): StagedMarkups {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: StagedMarkups = {};
    for (const [id, pages] of Object.entries(v as Record<string, unknown>)) {
      if (pages && typeof pages === "object" && !Array.isArray(pages)) out[id] = pages as PageMarkups;
    }
    return out;
  } catch {
    return {};
  }
}

// One copy in memory per key, so a render reads no storage and the hook gets
// the same object until something changes.
const cache = new Map<string, StagedState>();

function load(key: string): StagedState {
  const hit = cache.get(key);
  if (hit) return hit;
  const docs = parseDocs(getRaw(key));
  const all = parseMarkups(getRaw(marksKeyOf(key)));
  // Markups only for what is still staged.
  const ids = new Set(docs.map((d) => d.id));
  const markups: StagedMarkups = {};
  for (const [id, pages] of Object.entries(all)) if (ids.has(id) && hasMarkups(pages)) markups[id] = pages;
  const state = docs.length === 0 && Object.keys(markups).length === 0 ? EMPTY : { docs, markups };
  cache.set(key, state);
  return state;
}

/** The staged set for this person and workspace. */
export function readStaged(orgId: string, uid: string): StagedState {
  return load(stagedKey(orgId, uid));
}

/** True when a document's markups hold at least one drawn object. */
export function hasMarkups(pages: PageMarkups | null | undefined): boolean {
  if (!pages) return false;
  return Object.values(pages).some((p) => ((p as { objects?: unknown[] })?.objects?.length ?? 0) > 0);
}

/** The staged documents that have markups, in staged order. */
export function markedUpIds(state: StagedState): string[] {
  return state.docs.filter((d) => hasMarkups(state.markups[d.id])).map((d) => d.id);
}

/** Characters a document's markups take when kept. */
export function markupSize(pages: PageMarkups | null | undefined): number {
  return pages ? JSON.stringify(compactMarkups(pages)).length : 0;
}

/** Rounds every number to 3 decimals (a thousandth of a point is far finer
 *  than any pen), which keeps a page of freehand lines much smaller. */
export function compactMarkups(pages: PageMarkups): PageMarkups {
  const round = (v: unknown): unknown => {
    if (typeof v === "number") return Number.isFinite(v) && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
    if (Array.isArray(v)) return v.map(round);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = round(x);
      return o;
    }
    return v;
  };
  const out: PageMarkups = {};
  for (const [pn, st] of Object.entries(pages)) {
    if (((st as { objects?: unknown[] })?.objects?.length ?? 0) > 0) out[Number(pn)] = round(st) as object;
  }
  return out;
}

// ─── Writing ───────────────────────────────────────────────────────────

function announce(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(STAGED_CHANGE_EVENT, { detail: { key } }));
  } catch { /* old browser: other hooks catch up on their next read */ }
}

function commit(key: string, next: StagedState, write: { docs?: boolean; markups?: boolean }): StagedState {
  // Markups first: the larger write, and the one most likely not to fit.
  if (write.markups) {
    const raw = Object.keys(next.markups).length ? JSON.stringify(next.markups) : null;
    if (raw && raw.length > MARKUP_BUDGET_CHARS) throw new StagedStorageFullError(FULL_FOR_MARKUPS);
    putRaw(marksKeyOf(key), raw, FULL_FOR_MARKUPS);
  }
  if (write.docs) putRaw(key, next.docs.length ? JSON.stringify({ v: 1, docs: next.docs }) : null, FULL_FOR_LIST);
  const state = next.docs.length === 0 && Object.keys(next.markups).length === 0 ? EMPTY : next;
  cache.set(key, state);
  announce(key);
  return state;
}

/** Stage documents, after the ones already staged. A document already staged
 *  keeps its place (its details are refreshed). */
export function stageDocs(orgId: string, uid: string, add: StagedDoc[]): StagedState {
  const key = stagedKey(orgId, uid);
  const cur = load(key);
  const byId = new Map<string, StagedDoc>();
  for (const d of add) if (d?.id && d.libraryId && !byId.has(d.id)) byId.set(d.id, d);
  if (byId.size === 0) return cur;
  const docs = cur.docs.map((d) => (byId.has(d.id) ? { ...d, ...clean(byId.get(d.id)!) } : d));
  const have = new Set(docs.map((d) => d.id));
  for (const d of byId.values()) if (!have.has(d.id)) { docs.push(clean(d)); have.add(d.id); }
  return commit(key, { docs, markups: cur.markups }, { docs: true });
}

/** Take a document off the staged list, with its markups. */
export function unstageDoc(orgId: string, uid: string, id: string): StagedState {
  const key = stagedKey(orgId, uid);
  const cur = load(key);
  if (!cur.docs.some((d) => d.id === id)) return cur;
  const markups = { ...cur.markups };
  const hadMarks = id in markups;
  delete markups[id];
  return commit(key, { docs: cur.docs.filter((d) => d.id !== id), markups }, { docs: true, markups: hadMarks });
}

/** Stage it, or take it off when it is staged. Returns whether it is staged now. */
export function toggleStaged(orgId: string, uid: string, doc: StagedDoc): boolean {
  const cur = readStaged(orgId, uid);
  if (cur.docs.some((d) => d.id === doc.id)) { unstageDoc(orgId, uid, doc.id); return false; }
  stageDocs(orgId, uid, [doc]);
  return true;
}

/** Move a staged document one place up (-1) or down (+1). */
export function moveStaged(orgId: string, uid: string, id: string, dir: -1 | 1): StagedState {
  const key = stagedKey(orgId, uid);
  const cur = load(key);
  const i = cur.docs.findIndex((d) => d.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cur.docs.length) return cur;
  const docs = [...cur.docs];
  [docs[i], docs[j]] = [docs[j], docs[i]];
  return commit(key, { docs, markups: cur.markups }, { docs: true });
}

/** Empty the staged list and its markups. */
export function clearStaged(orgId: string, uid: string): StagedState {
  const key = stagedKey(orgId, uid);
  return commit(key, { docs: [], markups: {} }, { docs: true, markups: true });
}

/** Keep a staged document's markups (null or no objects: clear them). A
 *  document that is not staged is left alone. Throws StagedStorageFullError
 *  when they do not fit; what was kept before stays. */
export function setDocMarkups(orgId: string, uid: string, docId: string, pages: PageMarkups | null | undefined): StagedState {
  const key = stagedKey(orgId, uid);
  const cur = load(key);
  if (!cur.docs.some((d) => d.id === docId)) return cur;
  const markups = { ...cur.markups };
  if (pages && hasMarkups(pages)) markups[docId] = compactMarkups(pages);
  else if (docId in markups) delete markups[docId];
  else return cur;
  return commit(key, { docs: cur.docs, markups }, { markups: true });
}

function clean(d: StagedDoc): StagedDoc {
  return {
    id: d.id, libraryId: d.libraryId,
    documentNumber: d.documentNumber ?? null, title: d.title ?? null, rev: d.rev ?? null,
    ...(d.libraryName ? { libraryName: d.libraryName } : {}),
    ...(d.name ? { name: d.name } : {}),
    ...(d.status ? { status: d.status } : {}),
    ...(d.sheet ? { sheet: d.sheet } : {}),
  };
}

/** The sheet a document record is: its sheet number, else a "sheet" field. */
export function sheetOfRecord(doc: { sheetNumber?: number | null; metadata?: Record<string, unknown> | null }): string | undefined {
  if (doc.sheetNumber != null) return String(doc.sheetNumber);
  const v = doc.metadata?.sheet ?? doc.metadata?.Sheet;
  return typeof v === "string" || typeof v === "number" ? String(v).trim() || undefined : undefined;
}

/** A document record (the library's row) as a staged document. */
export function toStagedDoc(
  doc: {
    id?: string; documentNumber?: string | null; title?: string | null; rev?: string | null; libraryId?: string | null;
    name?: string | null; status?: string | null; sheetNumber?: number | null; metadata?: Record<string, unknown> | null;
  },
  libraryName?: string | null,
): StagedDoc {
  return clean({
    id: doc.id ?? "", libraryId: doc.libraryId ?? "",
    documentNumber: doc.documentNumber || null, title: doc.title || null, rev: doc.rev || null,
    libraryName: libraryName || undefined, name: doc.name || undefined, status: doc.status || undefined,
    sheet: sheetOfRecord(doc),
  });
}

/** How a staged document is named in a short list: its number (and sheet). */
export function stagedLabel(d: Pick<StagedDoc, "documentNumber" | "title" | "name" | "sheet">): string {
  const base = d.documentNumber || d.title || d.name || "No number";
  return d.documentNumber && d.sheet ? `${base} Sheet ${d.sheet}` : base;
}

// ─── Subscribing ───────────────────────────────────────────────────────

/** Calls `cb` when this key's staged set changes in this tab or another. */
export function subscribeStaged(key: string, cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === key || e.key === marksKeyOf(key)) { cache.delete(key); cb(); }
  };
  const onLocal = (e: Event) => {
    if ((e as CustomEvent<{ key?: string }>).detail?.key === key) cb();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(STAGED_CHANGE_EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(STAGED_CHANGE_EVENT, onLocal);
  };
}

const noop = () => () => {};
const emptySnapshot = () => EMPTY;

/** The staged set for this person and workspace, kept in step across tabs,
 *  with the ways to change it. A change that does not fit sets `error`. */
export function useStagedDocs(orgId: string | null | undefined, uid: string | null | undefined) {
  const key = orgId && uid ? stagedKey(orgId, uid) : null;
  const subscribe = useCallback((cb: () => void) => (key ? subscribeStaged(key, cb) : noop()), [key]);
  const snapshot = useCallback(() => (key ? load(key) : EMPTY), [key]);
  const state = useSyncExternalStore(subscribe, snapshot, emptySnapshot);
  const [error, setError] = useState<string | null>(null);

  return useMemo(() => {
    const run = (fn: (o: string, u: string) => void): boolean => {
      if (!orgId || !uid) return false;
      try {
        fn(orgId, uid);
        setError(null);
        return true;
      } catch (e) {
        setError(e instanceof StagedStorageFullError ? e.message : "This device would not keep the change. Try again.");
        return false;
      }
    };
    const ids = new Set(state.docs.map((d) => d.id));
    const marked = markedUpIds(state);
    return {
      docs: state.docs,
      markups: state.markups,
      count: state.docs.length,
      markedUpIds: marked,
      /** False until the person and workspace are known. */
      ready: !!key,
      isStaged: (id: string | null | undefined) => !!id && ids.has(id),
      hasMarkups: (id: string) => hasMarkups(state.markups[id]),
      add: (docs: StagedDoc[]) => run((o, u) => { stageDocs(o, u, docs); }),
      remove: (id: string) => run((o, u) => { unstageDoc(o, u, id); }),
      toggle: (doc: StagedDoc) => run((o, u) => { toggleStaged(o, u, doc); }),
      move: (id: string, dir: -1 | 1) => run((o, u) => { moveStaged(o, u, id, dir); }),
      clear: () => run((o, u) => { clearStaged(o, u); }),
      setMarkups: (docId: string, pages: PageMarkups | null | undefined) => run((o, u) => { setDocMarkups(o, u, docId, pages); }),
      clearMarkups: (docId: string) => run((o, u) => { setDocMarkups(o, u, docId, null); }),
      error,
      dismissError: () => setError(null),
    };
  }, [state, orgId, uid, key, error]);
}

export type StagedStore = ReturnType<typeof useStagedDocs>;
