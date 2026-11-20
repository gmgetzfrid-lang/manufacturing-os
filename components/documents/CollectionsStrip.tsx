"use client";

// CollectionsStrip — horizontal strip of curated "book" cards at the top of a
// library page. A curated collection is a named, ordered bundle of documents —
// effectively a PDF book / binder.
//
//   - org (admin-pinned): purple-accented, visible to everyone in the org
//   - user (personal): slate-accented, visible only to the owner
//
// Click a book → opens it straight in the multi-doc book viewer (Open as Book).
// Owners/admins get an Edit affordance to name + populate + reorder it. An
// empty book opens the manager so you can add documents.

import React, { useEffect, useState, useCallback } from "react";
import {
  Plus, BookOpen, Pencil, User as UserIcon, Loader2, FolderKanban,
} from "lucide-react";
import {
  listCollections, listItemsForCollections, type CuratedCollection,
} from "@/lib/collections";
import CollectionModal from "./CollectionModal";

interface CollectionsStripProps {
  orgId: string;
  libraryId: string;
  userId: string;
  userRole: string;
  /** Folder being viewed. null = library root. Books are scoped to it, so a
   *  book curated inside a folder only shows when you're in that folder. */
  folderId: string | null;
  /** Name of the current folder (for the strip's scope label). */
  folderName?: string | null;
  /** All folders in the library — for the "lives in" picker when editing. */
  folders?: Array<{ id?: string; name?: string; pathNames?: string[] }>;
  /** Bump to open "New collection" from elsewhere (the library's menu):
   *  with no collections yet the strip shows nothing at all. */
  createSignal?: number;
  /** Document records in the current library — passed in so we can
   *  show counts / pick from them when editing a collection. */
  libraryDocs: Array<{ id: string; documentNumber: string; title: string; rev?: string; status?: string; sheetNumber?: number | null }>;
  /** Called when the user opens a book — the parent stages the docs and
   *  opens MultiDocViewer. The collectionId lets the parent build a shareable
   *  ?book=<id> deep link. */
  onOpenAsBook?: (docIds: string[], collectionId?: string) => void;
}

const ADMIN_ROLES = ["Admin", "Manager", "Supervisor"];

/** Book cover in the collection's own color (flat, no gradient), else a
 *  plain slate book. */
function bookCover(color?: string | null): string {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) return color;
  return "#475569";
}

export default function CollectionsStrip({
  orgId, libraryId, userId, userRole, folderId, folderName, folders, libraryDocs, onOpenAsBook, createSignal,
}: CollectionsStripProps) {
  const [collections, setCollections] = useState<CuratedCollection[]>([]);
  const [itemsMap, setItemsMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openCollectionId, setOpenCollectionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (createSignal) setCreating(true); }, [createSignal]);

  const isAdmin = ADMIN_ROLES.includes(userRole);

  const refresh = useCallback(async () => {
    if (!orgId || !libraryId || !userId) return;
    setLoading(true);
    try {
      const list = await listCollections({ orgId, libraryId, userId, folderId });
      setCollections(list);
      setItemsMap(await listItemsForCollections(list.map((c) => c.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, [orgId, libraryId, userId, folderId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const canManage = (c: CuratedCollection) =>
    isAdmin || (c.scope === "user" && c.owner_user_id === userId);

  // Primary click: open the book. An empty book has nothing to show, so it
  // opens the manager instead (so you can populate it).
  const openBook = (c: CuratedCollection) => {
    const ids = itemsMap[c.id] ?? [];
    if (ids.length > 0 && onOpenAsBook) onOpenAsBook(ids, c.id);
    else setOpenCollectionId(c.id);
  };

  // No books here: nothing in the way of the documents (New collection is
  // in the library's menu); only the create dialog when asked for.
  if (collections.length === 0 && !openCollectionId && !creating) return null;

  return (
    <div className="px-4 sm:px-5 py-3.5 border-b border-[var(--color-border)] last:border-b-0">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <FolderKanban className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
          <span className="text-[13px] font-semibold text-[var(--color-text-muted)] shrink-0">
            Collections
          </span>
          {/* Scope chip — makes it obvious these books belong to THIS folder. */}
          <span className="text-[13px] font-bold text-[var(--color-text)] bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded px-1.5 py-px truncate max-w-[180px]" title={folderId && folderName ? `Books in “${folderName}”` : "Books at the library root"}>
            {folderId && folderName ? folderName : "Library root"}
          </span>
          {collections.length > 0 && (
            <span className="text-[13px] text-[var(--color-text-faint)] shrink-0">· {collections.length}</span>
          )}
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 h-8 px-3 rounded-lg text-[13px] font-bold border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> New collection
        </button>
      </div>

      {error && (
        <div className="mb-2 text-[13px] border-l-2 border-rose-500 pl-3 text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {collections.length === 0 ? (
        <div className="text-[13px] text-[var(--color-text-muted)] italic py-1">
          No books {folderId && folderName ? <>in <b>{folderName}</b></> : "at the library root"} yet.
        </div>
      ) : (
        <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1">
          {collections.map((c) => (
            <CollectionCard
              key={c.id}
              collection={c}
              count={(itemsMap[c.id] ?? []).length}
              canManage={canManage(c)}
              onOpen={() => openBook(c)}
              onManage={() => setOpenCollectionId(c.id)}
            />
          ))}
        </div>
      )}

      {(openCollectionId || creating) && (
        <CollectionModal
          mode={creating ? "create" : "view"}
          collectionId={openCollectionId ?? undefined}
          orgId={orgId}
          libraryId={libraryId}
          folderId={folderId}
          folders={folders}
          userId={userId}
          isAdmin={isAdmin}
          libraryDocs={libraryDocs}
          onClose={() => { setOpenCollectionId(null); setCreating(false); }}
          onChanged={() => { void refresh(); }}
          onOpenAsBook={onOpenAsBook}
        />
      )}
    </div>
  );
}

function CollectionCard({
  collection, count, canManage, onOpen, onManage,
}: {
  collection: CuratedCollection;
  count: number;
  canManage: boolean;
  onOpen: () => void;
  onManage: () => void;
}) {
  const isOrg = collection.scope === "org";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      title={count > 0 ? "Open book" : "Add documents to this book"}
      className={`group shrink-0 w-60 rounded-lg border p-3 hover-lift transition-all relative cursor-pointer ${
        isOrg
          ? "bg-[var(--color-surface)] border-[var(--color-border)] hover:border-[var(--color-border)]"
          : "bg-[var(--color-surface)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
      }`}
    >
      <div className="flex items-start gap-3">
        {/* PDF book cover — spine + page edge + book icon, so it reads as a
            bound book, not a file. */}
        <div className="relative w-12 h-16 rounded-md shadow-md shrink-0 overflow-hidden ring-1 ring-black/10" style={{ background: bookCover(collection.color) }}>
          <div className="absolute left-0 inset-y-0 w-1.5 bg-black/25" />
          <div className="absolute right-[3px] inset-y-1.5 w-[3px] bg-white/70 rounded-[1px]" />
          <div className="absolute inset-0 grid place-items-center">
            <BookOpen className="w-5 h-5 text-white drop-shadow" />
          </div>
        </div>

        <div className="min-w-0 flex-1 pr-4">
          <div className="text-[13px] font-semibold text-[var(--color-text)] line-clamp-2 leading-snug">{collection.name}</div>
          <div className="mt-1 text-[13px] font-bold text-[var(--color-text-muted)]">
            {count} {count === 1 ? "sheet" : "sheets"}
          </div>
          <div className="mt-1.5">
            {isOrg ? (
              <span className="text-[13px] font-semibold text-[var(--color-text)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">Pinned</span>
            ) : (
              <span className="text-[13px] font-semibold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded border border-[var(--color-border)] inline-flex items-center gap-0.5">
                <UserIcon className="w-2.5 h-2.5" /> Personal
              </span>
            )}
          </div>
        </div>
      </div>

      {canManage && (
        <button
          onClick={(e) => { e.stopPropagation(); onManage(); }}
          title="Edit book (name · add · reorder)"
          className="absolute top-2 right-2 p-1 rounded-md text-[var(--color-text-faint)] opacity-60 sm:opacity-0 group-hover:opacity-100 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] transition-all"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
