// lib/fileFinder/load.ts — the document estate, read once into finder shape.
//
// Libraries the person may read, every folder under them, every document
// with its folder chain and (where a current version exists) the source file
// name and byte hash. Everything else the finder does is in-memory on what
// this returns, so a search is a function call, not a round trip.

import { supabase } from "@/lib/supabase";
import { loadCodebook } from "@/lib/codebook";
import type { Role } from "@/types/schema";
import { entryFromDocument, type DocLike, type FolderLike, type IndexEntry, type LibraryLike, type VersionMeta, type LinkMeta } from "./fileIndex";
import type { UnitLike } from "./queryParse";

export interface FinderData {
  libraries: LibraryLike[];
  folders: Map<string, FolderLike>;
  entries: IndexEntry[];
  units: UnitLike[];
  /** Human notes about anything capped. */
  truncations: string[];
  /** Applied estate edges, by node id, for the lenses. */
  edges: Array<{ a: string; b: string; type: string; summary: string }>;
  /** True when the One Estate migration has not been applied. */
  estateMissing: boolean;
  /** The equipment registry, light: enough to draw and name it on the map. */
  assets: AssetLite[];
}

export interface AssetLite { id: string; tag: string; description: string | null; unitCode: string | null; coverPhotoId: string | null }

export const DOC_CAP = 4000;
const PAGE = 1000;
const IN_CHUNK = 200;

const toRoles = (v: unknown): Role[] => (Array.isArray(v) ? (v as Role[]) : []);

function libraryReadable(row: Record<string, unknown>, role: Role, controller: boolean): boolean {
  if (controller) return true;
  const read = row.read_access;
  if (read === "ALL" || read == null) return true;
  return toRoles(read).includes(role) || toRoles(row.visible_to).includes(role);
}

type Client = Pick<typeof supabase, "from">;

/** A query that never answers must not hang the page: name it and give up. */
function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} took longer than ${Math.round(ms / 1000)}s — check the browser console and Supabase status`)), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
/** Optional data: a failure or a stall degrades to "none", never to a hung page. */
async function optional<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, ms: number, label: string): Promise<{ data: T | null; error: { message: string } | null }> {
  try { return await withTimeout(p, ms, label); }
  catch (e) { console.warn(`[finder] ${label}:`, (e as Error).message); return { data: null, error: { message: (e as Error).message } }; }
}

export async function loadFinderData(orgId: string, role: Role, controller: boolean, client: Client = supabase): Promise<FinderData> {
  const truncations: string[] = [];
  const t0 = Date.now();
  const [libsRes, foldersRes, codebook, edgesRes, mirrorsRes, assetsRes] = await Promise.all([
    withTimeout(client.from("libraries").select("id, name, read_access, visible_to").eq("org_id", orgId), 25_000, "Loading libraries"),
    withTimeout(client.from("collections").select("*").eq("org_id", orgId), 25_000, "Loading folders"),
    withTimeout(loadCodebook(orgId, client), 15_000, "Loading the codebook").catch(() => ({ units: [] as Array<{ code: string; label: string }> })),
    optional<Array<{ a: string; b: string; type: string; summary: string }>>(client.from("estate_edges").select("a, b, type, summary").eq("org_id", orgId).eq("status", "applied").limit(20000), 15_000, "Loading estate links"),
    optional<Array<{ id: string; source_document_id: string | null; file_hash: string | null; status: string; pages_indexed: number; file_key?: string | null }>>(client.from("knowledge_documents").select("id, source_document_id, file_hash, status, pages_indexed, file_key").eq("org_id", orgId).limit(20000), 15_000, "Loading read copies"),
    optional<Array<{ id: string; tag: string; description: string | null; unit_code: string | null; cover_photo_id: string | null }>>(client.from("assets").select("id, tag, description, unit_code, cover_photo_id").eq("org_id", orgId).eq("archived", false).limit(20000), 15_000, "Loading equipment"),
  ]);
  const assets: AssetLite[] = (assetsRes.error ? [] : ((assetsRes.data ?? []) as Array<{ id: string; tag: string; description: string | null; unit_code: string | null; cover_photo_id: string | null }>))
    .map((a) => ({ id: a.id, tag: a.tag, description: a.description, unitCode: a.unit_code, coverPhotoId: a.cover_photo_id }));
  const estateMissing = !!edgesRes.error;
  const edges = estateMissing ? [] : (((edgesRes.data as Array<{ a: string; b: string; type: string; summary: string }> | null) ?? []));
  const folderUnit = new Map<string, string>();
  const docUnits = new Map<string, string[]>();
  const docAssets = new Map<string, string[]>();
  const docProjects = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type === "belongs_to_unit" && e.a.startsWith("folder:") && e.b.startsWith("cbunit:")) folderUnit.set(e.a.slice(7), e.b.slice(7));
    if (e.type === "belongs_to_unit" && e.a.startsWith("doc:") && e.b.startsWith("cbunit:")) docUnits.set(e.a.slice(4), [...(docUnits.get(e.a.slice(4)) ?? []), e.b.slice(7)]);
    if (e.type === "tagged_to" && e.a.startsWith("doc:") && e.b.startsWith("asset:")) docAssets.set(e.a.slice(4), [...(docAssets.get(e.a.slice(4)) ?? []), e.b.slice(6)]);
    if (e.type === "in_project" && e.a.startsWith("doc:") && e.b.startsWith("proj:")) docProjects.set(e.a.slice(4), [...(docProjects.get(e.a.slice(4)) ?? []), e.b.slice(5)]);
  }
  // The AI-readable copies: by source document, and by bytes.
  type Mirror = { id: string; source_document_id: string | null; file_hash: string | null; status: string; pages_indexed: number; file_key?: string | null };
  const mirrors = (mirrorsRes.error ? [] : ((mirrorsRes.data as Mirror[] | null) ?? []));
  const mirrorByDoc = new Map<string, Mirror>();
  const mirrorByHash = new Map<string, Mirror>();
  for (const m of mirrors) {
    if (m.source_document_id) mirrorByDoc.set(m.source_document_id, m);
    if (m.file_hash) mirrorByHash.set(m.file_hash, m);
  }
  if (libsRes.error) throw new Error(libsRes.error.message);
  if (foldersRes.error) throw new Error(foldersRes.error.message);

  const libraries: LibraryLike[] = [];
  const libIds = new Set<string>();
  for (const row of (libsRes.data as Record<string, unknown>[]) ?? []) {
    if (!libraryReadable(row, role, controller)) continue;
    libraries.push({ id: String(row.id), name: String(row.name ?? "Library") });
    libIds.add(String(row.id));
  }
  const libMap = new Map(libraries.map((l) => [l.id, l]));

  const folders = new Map<string, FolderLike>();
  for (const c of (foldersRes.data as Record<string, unknown>[]) ?? []) {
    if (c.deleted_at) continue;
    const libraryId = String(c.library_id);
    if (!libIds.has(libraryId)) continue;
    folders.set(String(c.id), {
      id: String(c.id), libraryId, parentId: (c.parent_id as string | null) ?? null, name: String(c.name ?? "Folder"),
      unitCode: folderUnit.get(String(c.id)),
    });
  }

  // Documents: the count first, then every page at once. Paging one after
  // another was the slowest part of "Reading the estate".
  type DocRow = DocLike & { current_version_id?: string | null };
  const docs: DocRow[] = [];
  const DOC_SEL = "id, library_id, collection_id, name, title, document_number, rev, status, effective_date, created_at, sheet_number, asset_tags, metadata, current_version_id";
  const countRes = await optional<unknown[]>(client.from("documents").select("id", { count: "exact", head: true }).eq("org_id", orgId) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, 15_000, "Counting documents");
  const total = Math.min(DOC_CAP, ((countRes as unknown as { count?: number | null }).count ?? DOC_CAP));
  if (total >= DOC_CAP) truncations.push(`Showing the newest ${DOC_CAP} documents.`);
  const pageAt = (from: number) => withTimeout(client.from("documents").select(DOC_SEL).eq("org_id", orgId).order("created_at", { ascending: false }).range(from, from + PAGE - 1), 30_000, `Loading documents ${from + 1}–${from + PAGE}`);
  const starts: number[] = [];
  for (let from = 0; from < Math.max(1, total); from += PAGE) starts.push(from);
  const pages = await Promise.all(starts.map(pageAt));
  for (const { data, error } of pages) {
    if (error) throw new Error(error.message);
    docs.push(...(((data as DocRow[]) ?? []).filter((d) => libIds.has(d.library_id))));
  }

  // Current-version file facts, chunked by id.
  const versionIds = docs.map((d) => d.current_version_id).filter((v): v is string => !!v);
  const versions = new Map<string, VersionMeta>();
  const chunks: string[][] = [];
  for (let i = 0; i < versionIds.length; i += IN_CHUNK) chunks.push(versionIds.slice(i, i + IN_CHUNK));
  const facts = await Promise.all(chunks.map((chunk) => optional<Record<string, unknown>[]>(client
    .from("document_versions")
    .select("id, source_file_name, file_hash, effective_date")
    .in("id", chunk), 20_000, "Loading file facts")));
  for (const { data, error } of facts) {
    if (error) continue; // a column missing on an older schema is not worth failing the page
    for (const v of (data as Record<string, unknown>[]) ?? []) {
      versions.set(String(v.id), {
        sourceFileName: (v.source_file_name as string | null) ?? null,
        fileHash: (v.file_hash as string | null) ?? null,
        effectiveDate: (v.effective_date as string | null) ?? null,
      });
    }
  }

  const entries = docs.map((d) => {
    const v = d.current_version_id ? versions.get(d.current_version_id) : undefined;
    const m = mirrorByDoc.get(d.id) ?? (v?.fileHash ? mirrorByHash.get(v.fileHash) : undefined);
    const links: LinkMeta = {
      unitCodes: docUnits.get(d.id), assets: docAssets.get(d.id), projects: docProjects.get(d.id),
      read: m ? { knowledgeDocId: m.id, status: m.status, pages: m.pages_indexed, byHash: !mirrorByDoc.has(d.id), fileKey: m.file_key ?? undefined } : undefined,
    };
    return entryFromDocument(d, { folders, libraries: libMap, version: v, links });
  });
  const units: UnitLike[] = (codebook.units ?? []).map((u) => ({ code: u.code, label: u.label }));
  console.info(`[finder] loaded ${libraries.length} libraries, ${folders.size} folders, ${entries.length} files, ${edges.length} links, ${mirrors.length} read copies in ${Date.now() - t0}ms${estateMissing ? " (estate links off)" : ""}`);
  return { libraries, folders, entries, units, truncations, edges, estateMissing, assets };
}


// ── Snapshot: the last map paints at once, the fresh one swaps in ─────────
const SNAP_VERSION = 2;
type Snap = { v: number; at: number; libraries: LibraryLike[]; folders: Array<[string, FolderLike]>; entries: IndexEntry[]; units: UnitLike[]; truncations: string[]; edges: FinderData["edges"]; estateMissing: boolean; assets: AssetLite[] };
const snapKey = (orgId: string) => `finder:snap:${SNAP_VERSION}:${orgId}`;

export function saveFinderSnapshot(orgId: string, d: FinderData): void {
  try {
    const snap: Snap = { v: SNAP_VERSION, at: Date.now(), libraries: d.libraries, folders: [...d.folders.entries()], entries: d.entries, units: d.units, truncations: d.truncations, edges: d.edges, estateMissing: d.estateMissing, assets: d.assets };
    const text = JSON.stringify(snap);
    if (text.length < 4_000_000) window.localStorage.setItem(snapKey(orgId), text);
  } catch { /* quota or private mode: the fresh load still paints */ }
}

export function loadFinderSnapshot(orgId: string): { data: FinderData; at: number } | null {
  try {
    const raw = window.localStorage.getItem(snapKey(orgId));
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snap;
    if (snap.v !== SNAP_VERSION) return null;
    return { at: snap.at, data: { libraries: snap.libraries, folders: new Map(snap.folders), entries: snap.entries, units: snap.units, truncations: snap.truncations, edges: snap.edges, estateMissing: snap.estateMissing, assets: snap.assets ?? [] } };
  } catch { return null; }
}
