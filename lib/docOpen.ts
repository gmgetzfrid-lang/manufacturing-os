// lib/docOpen.ts - opening a document fast, and again instantly.
//
// Opening a drawing used to be a waterfall run from scratch on every open:
// the version row, then a signed link (the server checks the session and
// the workspace, then signs), then the whole file, in the side panel; and
// the full-size viewer did the link and the file over again. Here each step
// is kept once it is fetched and shared by everyone who opens the same file:
//
//   the version to show     by document (and its current version)
//   the signed link         lib/storage's cache (shared with thumbnails)
//   the file's bytes        the last few files opened, by storage path
//
// A row being pointed at prefetches the cheap steps (version and link);
// pressing on it starts the file, so the preview is on its way before the
// click lands. Nothing here decides who may see what: the same reads and
// the same signing route as before, just not repeated.

import { supabase } from "@/lib/supabase";
import { versionFromRow, loadDocForViewing } from "@/lib/docRecord";
import { resolveFileUrlDetailed, type ResolvedFile } from "@/lib/storage";
import type { DocumentVersion } from "@/types/schema";

const MINUTE = 60_000;

/** A document as far as opening it goes. */
export type DocRef = { id?: string | null; currentVersionId?: string | null };

// ── The version to show ────────────────────────────────────────────────
type VersionEntry = { at: number; p: Promise<DocumentVersion | null>; value?: DocumentVersion | null };
const versions = new Map<string, VersionEntry>();
const versionKey = (doc: DocRef) => `${doc.id}|${doc.currentVersionId ?? ""}`;

async function readVersion(doc: DocRef): Promise<DocumentVersion | null> {
  if (doc.currentVersionId) {
    const { data } = await supabase.from("document_versions").select("*").eq("id", doc.currentVersionId).maybeSingle();
    if (data) return versionFromRow(data as Record<string, unknown>);
  }
  const { data } = await supabase.from("document_versions").select("*").eq("record_id", doc.id!)
    .or("review_state.is.null,review_state.eq.approved").order("created_at", { ascending: false }).limit(1);
  return data && data.length ? versionFromRow(data[0] as Record<string, unknown>) : null;
}

/** The version a document opens on: its current one, else the newest
 *  approved. Kept for a few minutes per (document, current version), so a
 *  new revision is never served from here. */
export function versionToShow(doc: DocRef): Promise<DocumentVersion | null> {
  if (!doc.id) return Promise.resolve(null);
  const key = versionKey(doc);
  const hit = versions.get(key);
  if (hit && Date.now() - hit.at < 5 * MINUTE) return hit.p;
  const entry: VersionEntry = { at: Date.now(), p: Promise.resolve(null) };
  entry.p = readVersion(doc).then((v) => { entry.value = v; return v; }, (e) => { versions.delete(key); throw e; });
  versions.set(key, entry);
  return entry.p;
}

/** The version, if it is already here (no waiting, no fetch). */
export function versionIfKnown(doc: DocRef | null | undefined): DocumentVersion | null | undefined {
  if (!doc?.id) return undefined;
  const hit = versions.get(versionKey(doc));
  return hit && Date.now() - hit.at < 5 * MINUTE ? hit.value : undefined;
}

/** A revision was published or reverted: read it fresh next time. */
export function forgetVersion(docId: string) {
  for (const k of [...versions.keys()]) if (k.startsWith(`${docId}|`)) versions.delete(k);
}

// ── A document opened by id (from the map, a search, a link) ──────────
const byId = new Map<string, { at: number; p: ReturnType<typeof loadDocForViewing> }>();
export function docForViewing(docId: string): ReturnType<typeof loadDocForViewing> {
  const hit = byId.get(docId);
  if (hit && Date.now() - hit.at < 2 * MINUTE) return hit.p;
  const p = loadDocForViewing(docId).catch((e) => { byId.delete(docId); throw e; });
  byId.set(docId, { at: Date.now(), p });
  return p;
}

// ── The file's bytes ───────────────────────────────────────────────────
// The last few files opened, by storage path. A drawing is a few MB; the
// cap keeps a long session from holding hundreds.
const MAX_FILES = 8;
const MAX_BYTES = 160 * 1024 * 1024;
type BlobEntry = { at: number; p: Promise<Blob>; size: number };
const blobs = new Map<string, BlobEntry>();

function trimBlobs() {
  let total = 0;
  for (const e of blobs.values()) total += e.size;
  // Oldest first (Map keeps insertion order; a hit re-inserts).
  for (const [k, e] of blobs) {
    if (blobs.size <= MAX_FILES && total <= MAX_BYTES) break;
    blobs.delete(k); total -= e.size;
  }
}

/** The signed link for a stored file (or the URL it already is). Cached in
 *  lib/storage for the life of the link. */
export function fileLink(path: string): Promise<ResolvedFile | null> {
  return resolveFileUrlDetailed(path);
}

/** The whole file, fetched once and kept. `link` is its http URL when the
 *  caller already has it. */
export function fileBlob(path: string, link?: string): Promise<Blob> {
  const hit = blobs.get(path);
  // Kept a few minutes: a file replaced under the same name is read again.
  if (hit && Date.now() - hit.at < 10 * MINUTE) { blobs.delete(path); blobs.set(path, hit); return hit.p; }
  if (hit) blobs.delete(path);
  const entry: BlobEntry = { at: Date.now(), p: Promise.resolve(new Blob()), size: 0 };
  entry.p = (async () => {
    let url = link;
    if (!url) {
      const r = await fileLink(path);
      if (!r || r.kind !== "url") throw new Error(r?.kind === "archived" ? "archived" : "no link");
      url = r.url;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = await res.blob();
    entry.size = b.size;
    trimBlobs();
    return b;
  })();
  entry.p.catch(() => { if (blobs.get(path) === entry) blobs.delete(path); });
  blobs.set(path, entry);
  trimBlobs();
  return entry.p;
}

/** The file, if it is here or on its way (never starts a download). */
export function fileBlobIfStarted(path: string | null | undefined): Promise<Blob> | null {
  const hit = path ? blobs.get(path) : undefined;
  return hit && Date.now() - hit.at < 10 * MINUTE ? hit.p : null;
}

const isStored = (v: string | null | undefined): v is string => !!v && !/^(https?:|blob:)/.test(v);

// ── Prefetch ───────────────────────────────────────────────────────────
/** Pointed at: the version and the signed link (small, cheap). */
export function prefetchDoc(doc: DocRef | null | undefined) {
  if (!doc?.id) return;
  void versionToShow(doc).then((v) => { if (isStored(v?.fileUrl)) void fileLink(v!.fileUrl); }).catch(() => undefined);
}

/** About to be opened (pressed): the file itself too. */
export function prefetchDocFile(doc: DocRef | null | undefined) {
  if (!doc?.id) return;
  void versionToShow(doc).then((v) => { if (v?.fileUrl) void fileBlob(v.fileUrl).catch(() => undefined); }).catch(() => undefined);
}

/** Pointed at by id (a search result): the row, its version and link. */
export function prefetchDocById(docId: string | null | undefined) {
  if (!docId) return;
  void docForViewing(docId).then((r) => { if (isStored(r?.version?.fileUrl)) void fileLink(r!.version!.fileUrl); }).catch(() => undefined);
}
