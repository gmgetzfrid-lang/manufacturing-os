"use client";

// CollectionsStrip — horizontal scrollable strip of curated collection
// cards displayed at the top of a library page.
//
// Two flavors of cards:
//   - org (admin-pinned): purple-accented, visible to everyone in the org
//   - user (personal): slate-accented, visible only to the owner
//
// Click a card → opens CollectionModal in view mode (shows the curated
// document list with notes). Admins/owners get an Edit button on the
// card itself.

import React, { useEffect, useState, useCallback } from "react";
import {
  Plus, ListChecks, User as UserIcon,
  Loader2, FolderKanban,
} from "lucide-react";
import {
  listCollections, type CuratedCollection,
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
  /** Called when the user clicks "Open as Book" inside a collection
   *  view. The parent stages the docs and opens MultiDocViewer. */
  onOpenAsBook?: (docIds: string[]) => void;
}

const ADMIN_ROLES = ["Admin", "Manager", "Supervisor"];

export default function CollectionsStrip({
  orgId, libraryId, userId, userRole, libraryDocs, onOpenAsBook,
}: CollectionsStripProps) {
  const [collections, setCollections] = useState<CuratedCollection[]>([]);
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
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, [orgId, libraryId, userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (loading && collections.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-slate-500 flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading collections…
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-b border-slate-200 bg-gradient-to-b from-purple-50/40 to-white">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <FolderKanban className="w-4 h-4 text-purple-700" />
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-700">
            Curated Collections
          </span>
          {collections.length > 0 && (
            <span className="text-[10px] text-slate-400">· {collections.length}</span>
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
        <div className="text-[11px] text-slate-500 italic py-1">
          No collections yet. Use <b>+ New Collection</b> to group related documents into a named playbook
          (e.g., &quot;Crude Cold Side Flow&quot; or &quot;Unit 200 MOC Phase 3&quot;).
        </div>
      ) : (
        <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1">
          {collections.map((c) => (
            <CollectionCard
              key={c.id}
              collection={c}
              onClick={() => setOpenCollectionId(c.id)}
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
  collection, onClick,
}: { collection: CuratedCollection; onClick: () => void }) {
  const isOrg = collection.scope === "org";
  return (
    <button
      onClick={onClick}
      className={`shrink-0 w-56 text-left rounded-xl border p-3 shadow-sm hover:shadow-md hover:-translate-y-px transition-all relative ${
        isOrg
          ? "bg-white border-purple-200 hover:border-purple-300"
          : "bg-white border-slate-200 hover:border-slate-300"
      }`}
    >
      <div className="flex items-start justify-between mb-1.5">
        <div className={`p-1.5 rounded-lg ${isOrg ? "bg-purple-100" : "bg-slate-100"}`}>
          <ListChecks className={`w-3.5 h-3.5 ${isOrg ? "text-purple-700" : "text-slate-600"}`} />
        </div>
        <div className="flex items-center gap-1">
          {isOrg ? (
            <span className="text-[9px] font-black uppercase tracking-widest text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded border border-purple-200">Pinned</span>
          ) : (
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-600 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-200 flex items-center gap-0.5">
              <UserIcon className="w-2.5 h-2.5" /> Personal
            </span>
          )}
        </div>
      </div>
      <div className="text-xs font-black text-slate-900 line-clamp-1">{collection.name}</div>
      {collection.description && (
        <div className="text-[10px] text-slate-500 mt-0.5 line-clamp-2 leading-snug">{collection.description}</div>
      )}
    </button>
  );
}
