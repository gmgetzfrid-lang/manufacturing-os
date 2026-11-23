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
  Plus, Pencil, User as UserIcon, FolderKanban,
} from "lucide-react";
import {
  listCollections, listItemsForCollections, type CuratedCollection,
} from "@/lib/collections";
import CollectionModal from "./CollectionModal";

import { friendlyError } from "@/lib/friendlyError";
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
      setError(friendlyError(e));
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

  // One slim row: the label and where it applies, each book as a small
  // cover and its name (open it as a book), and New collection at the end.
  return (
    <div className="border-b border-[var(--color-border)] last:border-b-0">
      <div className="flex items-center gap-3 px-4 sm:px-5 min-h-11 py-1">
        <span className="shrink-0 inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-heading)]"
          title={folderId && folderName ? `Books in ${folderName}` : "Books at the library root"}>
          <span className="ui-icon-tile is-sm" aria-hidden><FolderKanban className="w-4 h-4" /></span>
          Collections
          {collections.length > 0 && <span className="ui-count">{collections.length}</span>}
          <span className="font-normal text-[13px] text-[var(--color-text-muted)] max-sm:hidden truncate max-w-[160px]">in {folderId && folderName ? folderName : "the library root"}</span>
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {collections.length === 0 ? (
            <span className="text-[13px] text-[var(--color-text-muted)]">No books here yet.</span>
          ) : collections.map((c) => (
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
        <button type="button" onClick={() => setCreating(true)}
          className="shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[13px] font-semibold text-[var(--color-text)] transition-colors">
          <Plus className="w-3.5 h-3.5" /><span className="max-sm:sr-only">New collection</span>
        </button>
      </div>
      {error && <p role="alert" className="px-4 sm:px-5 pb-2 text-[13px] text-[var(--state-overdue)]">{error}</p>}

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
    <span className="group shrink-0 inline-flex items-center gap-0.5">
      {/* The book as a pill: its cover, its name, how many sheets; press it
          to open the book. */}
      <button type="button" onClick={onOpen}
        title={count > 0 ? `Open ${collection.name} as a book (${count} sheet${count === 1 ? "" : "s"}${isOrg ? "" : ", personal"})` : "Add documents to this book"}
        className="ui-tag !h-8 !pl-1.5 !font-sans !text-[14px]">
        {/* A small book cover in the book's own color. */}
        <span aria-hidden className="relative w-[14px] h-[18px] rounded-[2px] shrink-0 ring-1 ring-black/10" style={{ background: bookCover(collection.color) }}>
          <span className="absolute left-0 inset-y-0 w-[3px] bg-black/25" />
        </span>
        <span className="truncate max-w-[16rem]">{collection.name}</span>
        <span className="font-display text-[13px] font-bold tabular-nums opacity-75">{count}</span>
        {!isOrg && <UserIcon className="w-3.5 h-3.5 opacity-70" aria-label="Personal" />}
      </button>
      {canManage && (
        <button type="button" onClick={onManage} aria-label={`Edit ${collection.name}`} title="Edit the book: name, add, reorder"
          className="w-7 h-8 grid place-items-center rounded-md text-[var(--color-text-muted)] sm:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 hover:text-[var(--color-main)] hover:bg-[var(--color-accent-soft)] transition-opacity">
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}
    </span>
  );
}
