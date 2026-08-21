// lib/libraryCollections.ts
// Supabase implementation — replaces Firestore version

import { supabase } from "@/lib/supabase";
import { buildAclIndex } from "@/lib/acl";
import type { LibraryCollection, NodeVisibility, AccessControl, AclIndex, LibraryCustomColumn, PageConfig, LibraryHomeConfig } from "@/types/schema";

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
    description: (row.description as string | null) ?? undefined,
    color: (row.color as string | null) ?? undefined,
    icon: (row.icon as string | null) ?? undefined,
    coverImageUrl: (row.cover_image_url as string | null) ?? undefined,
    coverTint: (row.cover_tint as LibraryCollection["coverTint"]) ?? undefined,
    pageConfig: (row.page_config as LibraryCollection["pageConfig"]) ?? undefined,
    homeConfig: (row.home_config as LibraryCollection["homeConfig"]) ?? undefined,
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

/** Create a new library inline (Save-As style), mirroring the admin form's insert
 *  with sensible defaults. Gated to users who may create libraries. */
export async function createLibrary(input: { orgId: string; name: string; type?: string; createdBy: string }): Promise<{ id: string; name: string }> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("libraries")
    .insert({
      name: input.name.trim(),
      type: input.type ?? "Engineering",
      description: "",
      custom_columns: [],
      write_access: [],
      admin_access: [],
      read_access: "ALL",
      visible_to: [],
      folder_security: "Inherited",
      default_new_visibility: "normal",
      default_new_acl: null,
      acl: null,
      org_id: input.orgId,
      created_at: now,
      created_by: input.createdBy,
      updated_at: now,
      updated_by: input.createdBy,
    })
    .select("id, name")
    .single();
  if (error || !data) throw new Error(error?.message || "Failed to create library");
  return data as { id: string; name: string };
}

/** Flat list of a library's folders for a picker (one-time fetch). */
export interface PickerFolder { id: string; name: string; parentId: string | null; pathNames: string[] }
export async function listLibraryFoldersOnce(libraryId: string): Promise<PickerFolder[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, name, parent_id, path_names")
    .eq("library_id", libraryId)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data as Array<{ id: string; name: string; parent_id: string | null; path_names: unknown }>) ?? []).map((r) => ({
    id: r.id, name: r.name, parentId: r.parent_id,
    pathNames: Array.isArray(r.path_names) ? (r.path_names as string[]) : [],
  }));
}

/** Update a folder's presentational customization (color/icon/cover/desc
 *  and optional page_config for the hero header / background). */
export async function updateCollectionAppearance(
  collectionId: string,
  appearance: { description?: string | null; color?: string | null; icon?: string | null; coverImageUrl?: string | null; coverTint?: "none" | "brand" | "mono" | null },
  updatedBy?: string,
  pageConfig?: PageConfig | null,
): Promise<void> {
  const patch: Record<string, unknown> = {
    description: appearance.description ?? null,
    color: appearance.color ?? null,
    icon: appearance.icon ?? null,
    cover_image_url: appearance.coverImageUrl ?? null,
    cover_tint: appearance.coverTint ?? null,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy ?? null,
  };
  if (pageConfig !== undefined) patch.page_config = pageConfig;
  const { error } = await supabase.from(TABLE).update(patch).eq("id", collectionId);
  if (error) throw new Error(error.message);
}

/** Save a folder's customizable web-part home. */
export async function updateCollectionHomeConfig(collectionId: string, config: LibraryHomeConfig): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ home_config: config, updated_at: new Date().toISOString() })
    .eq("id", collectionId);
  if (error) throw new Error(error.message);
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
    if (nextParentId === collectionId) throw new Error("A folder can't be moved into itself.");
    const parent = await getCollectionById(nextParentId);
    if (!parent) throw new Error("Destination folder not found.");
    if (parent.libraryId !== node.libraryId) throw new Error("Destination folder belongs to a different library.");
    parentPathNames = normalizePathNames(parent);
    parentPathIds = normalizePathIds(parent);
    // THE guard that keeps folders findable. Moving a folder into its own
    // subtree detaches the whole branch from the root: nothing lists it,
    // nothing can navigate to it, and to the person who owns it the folder
    // has simply ceased to exist — which is exactly how it was reported.
    // path_ids can be stale, so the parent CHAIN is walked as well.
    if (parentPathIds.includes(collectionId)) {
      throw new Error("That folder is inside this one — moving it there would orphan both.");
    }
    let cursor = parent;
    for (let hops = 0; cursor?.parentId && hops < 100; hops++) {
      if (cursor.parentId === collectionId) {
        throw new Error("That folder is inside this one — moving it there would orphan both.");
      }
      cursor = (await getCollectionById(cursor.parentId))!;
      if (!cursor) break;
    }
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

/** Persist a manual order for SIBLING folders (same parent). Index in the
 *  array becomes sort_order. Best-effort per row — one failed write must
 *  not scramble the rest. */
export async function reorderFolders(orderedIds: string[]): Promise<void> {
  await Promise.all(orderedIds.map((id, i) =>
    supabase.from(TABLE).update({ sort_order: i }).eq("id", id)
      .then(() => undefined, () => undefined)));
}

/** Server-side folder move (subtree re-parent + denorm path rebuild).
 *  Same authority model as deleteFolder: the route runs on the service role
 *  behind the additive-role controller check, so a raw client update can't
 *  bypass it and stale path denorms self-heal on every move. */
export async function moveFolderServer(params: {
  orgId: string;
  collectionId: string;
  newParentId: string | null;
}): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not signed in.");
  const res = await fetch("/api/collections/move", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
  const out = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(out?.error ?? "Couldn't move the folder.");
}

/** Server-side bulk document move: authority check (additive roles),
 *  same-library validation, retention re-clock against the destination,
 *  audit entry. Returns how many retention clocks changed. */
export async function moveDocumentsServer(params: {
  orgId: string;
  docIds: string[];
  targetFolderId: string | null;
}): Promise<{ moved: number; retentionRecomputed: number }> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not signed in.");
  const res = await fetch("/api/documents/move", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
  const out = (await res.json().catch(() => null)) as
    { error?: string; moved?: number; retentionRecomputed?: number } | null;
  if (!res.ok) throw new Error(out?.error ?? "Couldn't move the documents.");
  return { moved: out?.moved ?? params.docIds.length, retentionRecomputed: out?.retentionRecomputed ?? 0 };
}

export async function deleteFolder(collectionId: string, orgId: string): Promise<void> {
  // NOT a client-side supabase call, deliberately. collections carries a
  // RESTRICTIVE delete policy with no permissive one, so an anon-key DELETE
  // matches zero rows and reports success — a Delete that visibly does
  // nothing (shipped once; reported within the hour). The server route runs
  // on the service role behind the same controller check, and steps the
  // folder's contents up a level before the row goes.
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not signed in.");
  const res = await fetch("/api/collections/delete", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ orgId, collectionId }),
  });
  const out = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(out?.error ?? "Couldn't delete the folder.");
}

export function listenLibraryFolders(
  libraryId: string,
  cb: (folders: LibraryCollection[]) => void,
  opts?: { orgId?: string; onError?: (msg: string) => void; hideHidden?: boolean }
): () => void {
  let alive = true;

  const fetch = async () => {
    // Manual order first (NULLs last, so untouched folders stay A-Z), name
    // as the tiebreak. A DB that hasn't run 20261009 yet errors on the
    // column — retry by name so folders never vanish over an ORDER BY.
    const build = (withOrder: boolean) => {
      let q = supabase.from(TABLE).select("*").eq("library_id", libraryId);
      if (withOrder) q = q.order("sort_order", { ascending: true, nullsFirst: false });
      q = q.order("name");
      if (opts?.orgId) q = q.eq("org_id", opts.orgId);
      if (opts?.hideHidden) q = q.eq("visibility", "normal");
      return q;
    };
    let { data, error } = await build(true);
    if (error && /sort_order|column/i.test(error.message)) {
      ({ data, error } = await build(false));
    }
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
    .on(
      "postgres_changes",
      // DELETE events carry ONLY the old row's primary key — never
      // library_id — so the filtered listener above can not match them and
      // a deleted folder sat on screen until reload. Deletes are rare;
      // refetching this library's list on ANY collections delete is cheap
      // and keeps every viewer's tree honest, not just the deleter's.
      { event: "DELETE", schema: "public", table: TABLE },
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
