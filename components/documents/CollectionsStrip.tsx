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
  /** Document records in the current library — passed in so we can
   *  show counts / pick from them when editing a collection. */
  libraryDocs: Array<{ id: string; documentNumber: string; title: string; rev?: string; status?: string }>;
  /** Called when the user opens a book — the parent stages the docs and
   *  opens MultiDocViewer. */
  onOpenAsBook?: (docIds: string[]) => void;
}

const ADMIN_ROLES = ["Admin", "Manager", "Supervisor"];

/** Book-cover gradient from the collection's color, else a purple book. */
function bookCover(color?: string | null): string {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
    return `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 55%, #000))`;
  }
  return "linear-gradient(135deg, #7c3aed, #4c1d95)";
}

export default function CollectionsStrip({
  orgId, libraryId, userId, userRole, libraryDocs, onOpenAsBook,
}: CollectionsStripProps) {
  const [collections, setCollections] = useState<CuratedCollection[]>([]);
  const [itemsMap, setItemsMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openCollectionId, setOpenCollectionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const isAdmin = ADMIN_ROLES.includes(userRole);

  const refresh = useCallback(async () => {
    if (!orgId || !libraryId || !userId) return;
    setLoading(true);
    try {
      const list = await listCollections({ orgId, libraryId, userId });
      setCollections(list);
      setItemsMap(await listItemsForCollections(list.map((c) => c.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, [orgId, libraryId, userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const canManage = (c: CuratedCollection) =>
    isAdmin || (c.scope === "user" && c.owner_user_id === userId);

  // Primary click: open the book. An empty book has nothing to show, so it
  // opens the manager instead (so you can populate it).
  const openBook = (c: CuratedCollection) => {
    const ids = itemsMap[c.id] ?? [];
    if (ids.length > 0 && onOpenAsBook) onOpenAsBook(ids);
    else setOpenCollectionId(c.id);
  };

  if (loading && collections.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-[var(--color-text-muted)] flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading books…
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)] bg-gradient-to-b from-purple-50/40 to-white">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <FolderKanban className="w-4 h-4 text-purple-700" />
          <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text)]">
            Curated Collections
          </span>
          {collections.length > 0 && (
            <span className="text-[10px] text-[var(--color-text-faint)]">· {collections.length}</span>
          )}
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold bg-purple-600 hover:bg-purple-500 text-white shadow-sm transition-colors"
        >
          <Plus className="w-3 h-3" /> New Collection
        </button>
      </div>

      {error && (
        <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-700">{error}</div>
      )}

      {collections.length === 0 ? (
        <div className="text-[11px] text-[var(--color-text-muted)] italic py-1">
          No books yet. Use <b>+ New Collection</b> to combine related documents into one named book
          (e.g., &quot;Crude Unit P&amp;ID Book&quot;) you can open and read end-to-end.
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
      className={`group shrink-0 w-60 rounded-2xl border p-3 shadow-sm hover-lift transition-all relative cursor-pointer ${
        isOrg
          ? "bg-[var(--color-surface)] border-purple-200 hover:border-purple-300"
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
          <div className="text-xs font-black text-[var(--color-text)] line-clamp-2 leading-snug">{collection.name}</div>
          <div className="mt-1 text-[10px] font-bold text-[var(--color-text-muted)]">
            {count} {count === 1 ? "sheet" : "sheets"}
          </div>
          <div className="mt-1.5">
            {isOrg ? (
              <span className="text-[9px] font-black uppercase tracking-widest text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded border border-purple-200">Pinned</span>
            ) : (
              <span className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded border border-[var(--color-border)] inline-flex items-center gap-0.5">
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
          className="absolute top-2 right-2 p-1 rounded-md text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] transition-all"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
