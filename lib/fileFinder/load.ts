// lib/fileFinder/load.ts — the document estate, read once into finder shape.
//
// Libraries the person may read, every folder under them, every document
// with its folder chain and (where a current version exists) the source file
// name and byte hash. Everything else the finder does is in-memory on what
// this returns, so a search is a function call, not a round trip.

import { supabase } from "@/lib/supabase";
import { loadCodebook } from "@/lib/codebook";
import type { Role } from "@/types/schema";
import { entryFromDocument, type DocLike, type FolderLike, type IndexEntry, type LibraryLike, type VersionMeta } from "./fileIndex";
import type { UnitLike } from "./queryParse";

export interface FinderData {
  libraries: LibraryLike[];
  folders: Map<string, FolderLike>;
  entries: IndexEntry[];
  units: UnitLike[];
  /** Human notes about anything capped. */
  truncations: string[];
}

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

export async function loadFinderData(orgId: string, role: Role, controller: boolean): Promise<FinderData> {
  const truncations: string[] = [];
  const [libsRes, foldersRes, codebook] = await Promise.all([
    supabase.from("libraries").select("id, name, read_access, visible_to").eq("org_id", orgId),
    supabase.from("collections").select("*").eq("org_id", orgId),
    loadCodebook(orgId).catch(() => ({ units: [] as Array<{ code: string; label: string }> })),
  ]);
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
    });
  }

  // Documents, paged, capped.
  const docs: Array<DocLike & { current_version_id?: string | null }> = [];
  for (let from = 0; from < DOC_CAP; from += PAGE) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, library_id, collection_id, name, title, document_number, rev, status, effective_date, created_at, sheet_number, asset_tags, metadata, current_version_id")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data as Array<DocLike & { current_version_id?: string | null }>) ?? [];
    docs.push(...rows.filter((d) => libIds.has(d.library_id)));
    if (rows.length < PAGE) break;
    if (from + PAGE >= DOC_CAP) truncations.push(`Showing the newest ${DOC_CAP} documents.`);
  }

  // Current-version file facts, chunked by id.
  const versionIds = docs.map((d) => d.current_version_id).filter((v): v is string => !!v);
  const versions = new Map<string, VersionMeta>();
  for (let i = 0; i < versionIds.length; i += IN_CHUNK) {
    const chunk = versionIds.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase
      .from("document_versions")
      .select("id, source_file_name, file_hash, effective_date")
      .in("id", chunk);
    if (error) break; // a column missing on an older schema is not worth failing the page
    for (const v of (data as Record<string, unknown>[]) ?? []) {
      versions.set(String(v.id), {
        sourceFileName: (v.source_file_name as string | null) ?? null,
        fileHash: (v.file_hash as string | null) ?? null,
        effectiveDate: (v.effective_date as string | null) ?? null,
      });
    }
  }

  const entries = docs.map((d) =>
    entryFromDocument(d, { folders, libraries: libMap, version: d.current_version_id ? versions.get(d.current_version_id) : undefined }),
  );
  const units: UnitLike[] = (codebook.units ?? []).map((u) => ({ code: u.code, label: u.label }));
  return { libraries, folders, entries, units, truncations };
}
