// lib/libraryCollections.ts
// Supabase implementation — replaces Firestore version

import { supabase } from "@/lib/supabase";
import { buildAclIndex } from "@/lib/acl";
import type { LibraryCollection, NodeVisibility, AccessControl, AclIndex, LibraryCustomColumn } from "@/types/schema";

const TABLE = "collections";

export type CreateFolderInput = {
  orgId?: string;
  libraryId: string;
  parentId?: string | null;
  name: string;
  visibility?: NodeVisibility;
  acl?: AccessControl;
  createdBy: string;
};

function fromDb(row: Record<string, unknown>): LibraryCollection {
  return {
    id: row.id as string,
    orgId: row.org_id as string | undefined,
    libraryId: row.library_id as string,
    parentId: (row.parent_id as string | null) ?? null,
    name: row.name as string,
    path: (row.path as string[]) ?? [],
    pathIds: (row.path_ids as string[]) ?? [],
    pathNames: (row.path_names as string[]) ?? [],
    visibility: (row.visibility as NodeVisibility) ?? "normal",
    acl: (row.acl as AccessControl) ?? undefined,
    aclIndex: (row.acl_index as AclIndex) ?? undefined,
    columnOverrides: (row.column_overrides as LibraryCustomColumn[]) ?? undefined,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string,
    updatedAt: row.updated_at as string | undefined,
    updatedBy: row.updated_by as string | undefined,
  };
}

export async function getCollectionById(collectionId: string): Promise<LibraryCollection | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", collectionId)
    .single();

  if (error || !data) return null;
  return fromDb(data as Record<string, unknown>);
}

function normalizeParentId(parentId?: string | null) {
  return parentId ?? null;
}

function normalizePathNames(node?: LibraryCollection | null): string[] {
  if (!node) return [];
  if (Array.isArray(node.pathNames) && node.pathNames.length) return node.pathNames;
  if (Array.isArray(node.path) && node.path.length) return node.path;
  return [];
}

function normalizePathIds(node?: LibraryCollection | null): string[] {
  if (!node) return [];
  if (Array.isArray(node.pathIds) && node.pathIds.length) return node.pathIds;
  return [];
}

export async function createFolder(input: CreateFolderInput): Promise<string> {
  const parentId = normalizeParentId(input.parentId);

  let parentPathNames: string[] = [];
  let parentPathIds: string[] = [];

  if (parentId) {
    const parent = await getCollectionById(parentId);
    if (!parent) throw new Error("Parent folder not found.");
    if (parent.libraryId !== input.libraryId) throw new Error("Parent folder belongs to a different library.");
    parentPathNames = normalizePathNames(parent);
    parentPathIds = normalizePathIds(parent);
  }

  const name = input.name.trim();
  const nextPathNames = [...parentPathNames, name].filter(Boolean);
  const nextPathIds = parentId ? [...parentPathIds, parentId] : [];

  const aclIndex = input.acl ? buildAclIndex(input.acl) : null;

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      org_id: input.orgId ?? null,
      library_id: input.libraryId,
      parent_id: parentId,
      name,
      path: nextPathNames,
      path_names: nextPathNames,
      path_ids: nextPathIds,
      visibility: input.visibility ?? "normal",
      acl: input.acl ?? null,
      acl_index: aclIndex,
      created_by: input.createdBy,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export async function updateFolder(
  collectionId: string,
  patch: Partial<Pick<LibraryCollection, "visibility" | "acl" | "columnOverrides" | "name">>
) {
  const update: Record<string, unknown> = {};
  if (patch.visibility !== undefined) update.visibility = patch.visibility;
  if (patch.acl !== undefined) update.acl = patch.acl;
  if (patch.columnOverrides !== undefined) update.column_overrides = patch.columnOverrides;
  if (patch.name !== undefined) update.name = patch.name;

  const { error } = await supabase.from(TABLE).update(update).eq("id", collectionId);
  if (error) throw new Error(error.message);
}

export async function renameFolderAndDescendants(collectionId: string, newNameRaw: string) {
  const newName = newNameRaw.trim();
  if (!newName) throw new Error("New name is empty.");

  const node = await getCollectionById(collectionId);
  if (!node) throw new Error("Folder not found.");

  const oldPath = normalizePathNames(node);
  const oldLeafName = oldPath[oldPath.length - 1];
  if (oldLeafName === newName) return;

  const parentPath = oldPath.slice(0, -1);
  const newPath = [...parentPath, newName];

  await supabase.from(TABLE).update({ name: newName, path: newPath, path_names: newPath }).eq("id", collectionId);

  // Find descendants
  const { data: descendants } = await supabase
    .from(TABLE)
    .select("id, path_names, path_ids")
    .filter("path_ids", "cs", `{${collectionId}}`);

  if (!descendants?.length) return;

  for (const item of descendants as Array<{ id: string; path_names: string[]; path_ids: string[] }>) {
    const childPath = item.path_names ?? [];
    const isPrefix =
      oldPath.length <= childPath.length &&
      oldPath.every((seg, i) => childPath[i] === seg);
    if (!isPrefix) continue;

    const updated = [...newPath, ...childPath.slice(oldPath.length)];
    await supabase.from(TABLE).update({ path: updated, path_names: updated }).eq("id", item.id);
  }
}

export async function moveFolderAndDescendants(params: {
  collectionId: string;
  newParentId: string | null;
}) {
  const { collectionId, newParentId } = params;

  const node = await getCollectionById(collectionId);
  if (!node) throw new Error("Folder not found.");

  const nextParentId = normalizeParentId(newParentId);

  let parentPathNames: string[] = [];
  let parentPathIds: string[] = [];

  if (nextParentId) {
    const parent = await getCollectionById(nextParentId);
    if (!parent) throw new Error("Destination folder not found.");
    if (parent.libraryId !== node.libraryId) throw new Error("Destination folder belongs to a different library.");
    parentPathNames = normalizePathNames(parent);
    parentPathIds = normalizePathIds(parent);
  }

  const oldPathNames = normalizePathNames(node);
  const oldPathIds = normalizePathIds(node);

  const newPathNames = [...parentPathNames, node.name];
  const newPathIds = nextParentId ? [...parentPathIds, nextParentId] : [];

  await supabase
    .from(TABLE)
    .update({ parent_id: nextParentId, path: newPathNames, path_names: newPathNames, path_ids: newPathIds })
    .eq("id", collectionId);

  const { data: descendants } = await supabase
    .from(TABLE)
    .select("id, path_names, path_ids")
    .filter("path_ids", "cs", `{${collectionId}}`);

  if (!descendants?.length) return;

  for (const item of descendants as Array<{ id: string; path_names: string[]; path_ids: string[] }>) {
    const childPath = item.path_names ?? [];
    const childPathIds = item.path_ids ?? [];

    const isPrefix =
      oldPathNames.length <= childPath.length &&
      oldPathNames.every((seg, i) => childPath[i] === seg);
    if (!isPrefix) continue;

    const updatedNames = [...newPathNames, ...childPath.slice(oldPathNames.length)];

    const oldIdsPrefix = [...oldPathIds, collectionId];
    const isIdPrefix =
      oldIdsPrefix.length <= childPathIds.length &&
      oldIdsPrefix.every((seg, i) => childPathIds[i] === seg);
    if (!isIdPrefix) continue;

    const updatedIds = [...newPathIds, collectionId, ...childPathIds.slice(oldIdsPrefix.length)];

    await supabase
      .from(TABLE)
      .update({ path: updatedNames, path_names: updatedNames, path_ids: updatedIds })
      .eq("id", item.id);
  }
}

export async function deleteFolder(collectionId: string, opts?: { cascade?: boolean }) {
  if (opts?.cascade) {
    const { data: descendants } = await supabase
      .from(TABLE)
      .select("id")
      .filter("path_ids", "cs", `{${collectionId}}`);

    if (descendants?.length) {
      const ids = (descendants as { id: string }[]).map((d) => d.id);
      await supabase.from(TABLE).delete().in("id", ids);
    }
  }

  await supabase.from(TABLE).delete().eq("id", collectionId);
}

export function listenLibraryFolders(
  libraryId: string,
  cb: (folders: LibraryCollection[]) => void,
  opts?: { orgId?: string; onError?: (msg: string) => void; hideHidden?: boolean }
): () => void {
  let alive = true;

  const fetch = async () => {
    let q = supabase.from(TABLE).select("*").eq("library_id", libraryId).order("name");
    if (opts?.orgId) q = q.eq("org_id", opts.orgId);
    if (opts?.hideHidden) q = q.eq("visibility", "normal");

    const { data, error } = await q;
    if (error) { opts?.onError?.(error.message); return; }
    if (alive) cb((data || []).map((r) => fromDb(r as Record<string, unknown>)));
  };

  fetch();

  const channel = supabase
    .channel(`library-folders-${libraryId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: TABLE, filter: `library_id=eq.${libraryId}` },
      () => { if (alive) fetch(); }
    )
    .subscribe();

  return () => {
    alive = false;
    supabase.removeChannel(channel);
  };
}

export type FolderNode = LibraryCollection & { children: FolderNode[] };

export function buildFolderTree(folders: LibraryCollection[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];

  for (const f of folders) {
    if (!f.id) continue;
    byId.set(f.id, { ...f, children: [] });
  }

  for (const f of folders) {
    if (!f.id) continue;
    const node = byId.get(f.id)!;
    const pid = f.parentId ?? null;

    if (!pid) { roots.push(node); continue; }

    const parent = byId.get(pid);
    if (!parent) { roots.push(node); continue; }
    parent.children.push(node);
  }

  return roots;
}
