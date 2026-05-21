// lib/libraryCollections.ts
// Firestore helpers for Library folder hierarchy ("collections").
// - Supports nested folders via parentId
// - Maintains pathNames[] + pathIds[]
// - Rename/move update descendant paths using pathIds[] array-contains queries

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  DocumentData,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { buildAclIndex } from "@/lib/acl";
import type { LibraryCollection, NodeVisibility, AccessControl } from "@/types/schema";

const COLLECTIONS = "collections";

export type CreateFolderInput = {
  orgId?: string;
  libraryId: string;
  parentId?: string | null;
  name: string;
  visibility?: NodeVisibility;
  acl?: AccessControl;
  createdBy: string;
};

export async function getCollectionById(collectionId: string) {
  const ref = doc(db, COLLECTIONS, collectionId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const data = snap.data() as Record<string, unknown>;
  return { id: snap.id, ...data } as LibraryCollection;
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

export async function createFolder(input: CreateFolderInput) {
  const parentId = normalizeParentId(input.parentId);

  let parentPathNames: string[] = [];
  let parentPathIds: string[] = [];

  if (parentId) {
    const parent = await getCollectionById(parentId);
    if (!parent) throw new Error("Parent folder not found.");

    if (parent.libraryId !== input.libraryId) {
      throw new Error("Parent folder belongs to a different library.");
    }

    parentPathNames = normalizePathNames(parent);
    parentPathIds = normalizePathIds(parent);
  }

  const name = input.name.trim();
  const nextPathNames = [...parentPathNames, name].filter(Boolean);
  const nextPathIds = parentId ? [...parentPathIds, parentId] : [];

  const newDoc = {
    orgId: input.orgId,
    libraryId: input.libraryId,
    parentId,
    name,
    pathNames: nextPathNames,
    path: nextPathNames,
    pathIds: nextPathIds,
    visibility: input.visibility ?? "normal",
    acl: input.acl,
    aclIndex: input.acl ? buildAclIndex(input.acl) : null,
    createdAt: serverTimestamp(),
    createdBy: input.createdBy,
  };

  const ref = await addDoc(collection(db, COLLECTIONS), newDoc);
  return ref.id;
}

export async function updateFolder(
  collectionId: string,
  patch: Partial<Pick<LibraryCollection, "visibility" | "acl" | "columnOverrides" | "name">>
) {
  const ref = doc(db, COLLECTIONS, collectionId);
  await updateDoc(ref, {
    ...patch,
  } as Record<string, unknown>);
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

  await updateDoc(doc(db, COLLECTIONS, collectionId), {
    name: newName,
    path: newPath,
    pathNames: newPath,
  } as Record<string, unknown>);

  const q = query(
    collection(db, COLLECTIONS),
    where("pathIds", "array-contains", collectionId)
  );
  const snap = await getDocs(q);

  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() as DocumentData }));
  if (docs.length === 0) return;

  const BATCH_LIMIT = 450;
  let batch = writeBatch(db);
  let ops = 0;

  const flush = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = writeBatch(db);
    ops = 0;
  };

  for (const item of docs) {
    const childPath: string[] = Array.isArray(item.data.pathNames)
      ? (item.data.pathNames as string[])
      : Array.isArray(item.data.path)
      ? (item.data.path as string[])
      : [];

    const isPrefix =
      oldPath.length <= childPath.length &&
      oldPath.every((seg, i) => childPath[i] === seg);

    if (!isPrefix) continue;

    const updated = [...newPath, ...childPath.slice(oldPath.length)];

    batch.update(doc(db, COLLECTIONS, item.id), {
      path: updated,
      pathNames: updated,
    } as Record<string, unknown>);
    ops++;

    if (ops >= BATCH_LIMIT) {
      await flush();
    }
  }

  await flush();
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
    if (parent.libraryId !== node.libraryId) {
      throw new Error("Destination folder belongs to a different library.");
    }
    parentPathNames = normalizePathNames(parent);
    parentPathIds = normalizePathIds(parent);
  }

  const oldPathNames = normalizePathNames(node);
  const oldPathIds = normalizePathIds(node);

  const newPathNames = [...parentPathNames, node.name];
  const newPathIds = nextParentId ? [...parentPathIds, nextParentId] : [];

  await updateDoc(doc(db, COLLECTIONS, collectionId), {
    parentId: nextParentId,
    path: newPathNames,
    pathNames: newPathNames,
    pathIds: newPathIds,
  } as Record<string, unknown>);

  const q = query(
    collection(db, COLLECTIONS),
    where("pathIds", "array-contains", collectionId)
  );
  const snap = await getDocs(q);

  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() as DocumentData }));
  if (docs.length === 0) return;

  const BATCH_LIMIT = 450;
  let batch = writeBatch(db);
  let ops = 0;

  const flush = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = writeBatch(db);
    ops = 0;
  };

  for (const item of docs) {
    const childPath: string[] = Array.isArray(item.data.pathNames)
      ? (item.data.pathNames as string[])
      : Array.isArray(item.data.path)
      ? (item.data.path as string[])
      : [];

    const childPathIds: string[] = Array.isArray(item.data.pathIds)
      ? (item.data.pathIds as string[])
      : [];

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

    batch.update(doc(db, COLLECTIONS, item.id), {
      path: updatedNames,
      pathNames: updatedNames,
      pathIds: updatedIds,
    } as Record<string, unknown>);
    ops++;

    if (ops >= BATCH_LIMIT) {
      await flush();
    }
  }

  await flush();
}

export async function deleteFolder(collectionId: string, opts?: { cascade?: boolean }) {
  const cascade = opts?.cascade ?? false;

  if (cascade) {
    const q = query(
      collection(db, COLLECTIONS),
      where("pathIds", "array-contains", collectionId)
    );
    const snap = await getDocs(q);

    const ids = snap.docs.map((d) => d.id);

    const BATCH_LIMIT = 450;
    let batch = writeBatch(db);
    let ops = 0;

    const flush = async () => {
      if (ops === 0) return;
      await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    };

    for (const id of ids) {
      batch.delete(doc(db, COLLECTIONS, id));
      ops++;
      if (ops >= BATCH_LIMIT) await flush();
    }

    await flush();
  }

  await deleteDoc(doc(db, COLLECTIONS, collectionId));
}

export function listenLibraryFolders(
  libraryId: string,
  cb: (folders: LibraryCollection[]) => void,
  opts?: { orgId?: string; onError?: (msg: string) => void; hideHidden?: boolean }
) {
  const base = collection(db, COLLECTIONS);

  const filters = [where("libraryId", "==", libraryId)];
  if (opts?.orgId) filters.push(where("orgId", "==", opts.orgId));
  if (opts?.hideHidden) filters.push(where("visibility", "==", "normal"));

  const q = query(base, ...filters, orderBy("name", "asc"));

  return onSnapshot(q, (snap) => {
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as LibraryCollection));
    cb(list);
  }, (err) => {
    console.error("listenLibraryFolders error:", err);
    opts?.onError?.(err.message);
    cb([]);
  });
}

export type FolderNode = LibraryCollection & { children: FolderNode[] };

export function buildFolderTree(folders: LibraryCollection[]) {
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

    if (!pid) {
      roots.push(node);
      continue;
    }

    const parent = byId.get(pid);
    if (!parent) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  return roots;
}
