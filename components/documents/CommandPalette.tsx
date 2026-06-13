"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  FileText,
  Folder,
  UploadCloud,
  FolderPlus,
  Columns,
  Layers,
  Home,
  CornerDownLeft,
  Globe,
  Loader2,
} from "lucide-react";
import type { DocumentRecord, LibraryCollection } from "@/types/schema";
import { searchDocuments, type DocumentRow } from "@/lib/search";

type CommandAction =
  | { kind: "navigate"; id: string | null; label: string; path?: string }
  | { kind: "openDoc"; doc: DocumentRecord }
  | { kind: "stageDoc"; doc: DocumentRecord }
  | { kind: "orgDoc"; row: DocumentRow }
  | { kind: "action"; id: string; label: string; icon: React.ElementType; run: () => void };

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  libraryName: string;
  folders: LibraryCollection[];
  docs: DocumentRecord[];
  isController: boolean;
  onNavigateFolder: (id: string | null) => void;
  onSelectDoc: (doc: DocumentRecord) => void;
  onStageDoc: (doc: DocumentRecord) => void;
  onUpload: () => void;
  onCreateFolder: () => void;
  onColumnManager: () => void;
  /** Phase 2 — when set, queries of 2+ chars also fetch org-wide
   *  matches via lib/search.ts. Hits outside the current library
   *  navigate to that library on selection. Omit to disable. */
  orgId?: string;
  /** Current library id, used to dedupe org-wide hits against the
   *  in-memory list and to skip navigation when the hit is local. */
  currentLibraryId?: string;
}

function score(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t.startsWith(q)) return 100;
  if (t.includes(q)) return 50;
  // Simple subseq match
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) if (t[i] === q[qi]) qi++;
  return qi === q.length ? 10 : 0;
}

export default function CommandPalette({
  isOpen,
  onClose,
  libraryName,
  folders,
  docs,
  isController,
  onNavigateFolder,
  onSelectDoc,
  onStageDoc,
  onUpload,
  onCreateFolder,
  onColumnManager,
  orgId,
  currentLibraryId,
}: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Phase 2 — debounced org-wide search. Only fires when orgId is
  // provided and the query is meaningful (>=2 chars). Results are
  // deduped against the in-memory `docs` list so a hit doesn't show
  // up twice (once local, once org-wide).
  const [orgResults, setOrgResults] = useState<DocumentRow[]>([]);
  const [orgSearching, setOrgSearching] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setActiveIdx(0);
      setOrgResults([]);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    if (!orgId) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setOrgResults([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      setOrgSearching(true);
      try {
        const rows = await searchDocuments({ orgId, query: trimmed, limit: 8 });
        const localIds = new Set(docs.map((d) => d.id));
        setOrgResults(rows.filter((r) => !localIds.has(r.id)));
      } catch {
        setOrgResults([]);
      } finally {
        setOrgSearching(false);
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query, orgId, docs]);

  const items = useMemo<CommandAction[]>(() => {
    const actions: CommandAction[] = [
      { kind: "action", id: "upload", label: "Upload files", icon: UploadCloud, run: onUpload },
      ...(isController
        ? [
            { kind: "action" as const, id: "new-folder", label: "New folder", icon: FolderPlus, run: onCreateFolder },
            { kind: "action" as const, id: "columns", label: "Manage columns", icon: Columns, run: onColumnManager },
          ]
        : []),
      { kind: "navigate", id: null, label: `Go to ${libraryName} (Home)` },
    ];

    const folderItems: CommandAction[] = folders.map((f) => ({
      kind: "navigate",
      id: f.id!,
      label: f.name,
      path: f.pathNames?.join(" / "),
    }));

    const docItems: CommandAction[] = docs.map((d) => ({ kind: "openDoc", doc: d }));

    const stageItems: CommandAction[] = docs.map((d) => ({ kind: "stageDoc", doc: d }));

    const orgItems: CommandAction[] = orgResults.map((r) => ({ kind: "orgDoc", row: r }));

    const all = [...actions, ...folderItems, ...docItems, ...stageItems];

    if (!query.trim()) {
      // Show actions + folders + top 12 docs
      return [...actions, ...folderItems.slice(0, 6), ...docItems.slice(0, 12)];
    }

    const scored = all
      .map((item) => {
        let label = "";
        if (item.kind === "navigate") label = item.label + " " + (item.path || "");
        else if (item.kind === "openDoc") label = `${item.doc.documentNumber || ""} ${item.doc.title || item.doc.name || ""}`;
        else if (item.kind === "stageDoc") label = `Stage ${item.doc.documentNumber || ""} ${item.doc.title || ""}`;
        else if (item.kind === "orgDoc") label = `${item.row.document_number || ""} ${item.row.title || item.row.name || ""}`;
        else label = item.label;
        return { item, s: score(label, query) };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.item)
      .slice(0, 25);

    // Org-wide hits land in a labelled section *after* local hits —
    // local context wins, server hits supplement.
    return [...scored, ...orgItems];
  }, [query, folders, docs, libraryName, isController, onUpload, onCreateFolder, onColumnManager, orgResults]);

  useEffect(() => setActiveIdx(0), [query]);

  const execute = useCallback(
    (item: CommandAction) => {
      if (item.kind === "navigate") onNavigateFolder(item.id);
      else if (item.kind === "openDoc") onSelectDoc(item.doc);
      else if (item.kind === "stageDoc") onStageDoc(item.doc);
      else if (item.kind === "orgDoc") {
        // Same library? Just open the inspector. Different library?
        // Navigate to that library's page; deep-linking to the
        // inspector for an out-of-context doc is a follow-up (the
        // library page would need to accept `?doc=<id>` and auto-
        // select). Today the user lands on the right library and
        // can click the row.
        if (item.row.library_id === currentLibraryId) {
          // Construct a minimal DocumentRecord-shaped object so the
          // inspector can open without a full row mapping round-trip.
          onSelectDoc({
            id: item.row.id,
            libraryId: item.row.library_id,
            documentNumber: item.row.document_number ?? undefined,
            title: item.row.title ?? undefined,
            name: item.row.name ?? undefined,
            rev: item.row.rev ?? undefined,
            status: (item.row.status as DocumentRecord["status"]) ?? undefined,
            createdBy: "",
            createdAt: item.row.created_at ?? null,
          } as DocumentRecord);
        } else {
          router.push(`/documents/${item.row.library_id}`);
        }
      } else item.run();
      onClose();
    },
    [onNavigateFolder, onSelectDoc, onStageDoc, onClose, currentLibraryId, router]
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(items.length - 1, i + 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)); }
      if (e.key === "Enter") { e.preventDefault(); if (items[activeIdx]) execute(items[activeIdx]); }
    },
    [items, activeIdx, execute, onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center pt-[12vh] px-4 bg-slate-900/50 backdrop-blur-[3px] animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-2xl shadow-xl overflow-hidden animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-200"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--color-border)]">
          <Search className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search documents, folders, or actions…"
            className="flex-1 bg-transparent text-[var(--color-text)] text-sm placeholder-[var(--color-text-faint)] focus:outline-none"
          />
          <kbd className="text-[10px] font-mono text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1.5 py-0.5 rounded">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto py-2 custom-scrollbar">
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-[var(--color-text-muted)] text-sm">No results</div>
          ) : (
            items.map((item, idx) => {
              const active = activeIdx === idx;
              let icon: React.ElementType = FileText;
              let primary = "";
              let secondary = "";
              let kindLabel = "";

              if (item.kind === "navigate") {
                icon = item.id === null ? Home : Folder;
                primary = item.label;
                secondary = item.path || "";
                kindLabel = "Folder";
              } else if (item.kind === "openDoc") {
                icon = FileText;
                primary = item.doc.title || item.doc.name || "Untitled";
                secondary = item.doc.documentNumber || "—";
                kindLabel = "Open";
              } else if (item.kind === "stageDoc") {
                icon = Layers;
                primary = `Stage ${item.doc.title || item.doc.name || "doc"}`;
                secondary = item.doc.documentNumber || "—";
                kindLabel = "Stage";
              } else if (item.kind === "orgDoc") {
                icon = Globe;
                primary = item.row.title || item.row.name || "Untitled";
                secondary = `${item.row.document_number || "—"} · ${item.row.library_id === currentLibraryId ? "this library" : "other library"}`;
                kindLabel = "Org-wide";
              } else {
                icon = item.icon;
                primary = item.label;
                kindLabel = "Action";
              }
              const Icon = icon;

              return (
                <button
                  key={`${item.kind}-${idx}`}
                  onClick={() => execute(item)}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                    active ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "hover:bg-[var(--color-surface-2)]"
                  }`}
                >
                  <div
                    className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                      active ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate ${active ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>
                      {primary}
                    </div>
                    {secondary && (
                      <div className="text-[11px] font-mono text-[var(--color-text-muted)] truncate">{secondary}</div>
                    )}
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    <span className="text-[9px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider">{kindLabel}</span>
                    {active && <CornerDownLeft className="w-3 h-3 text-[var(--color-text-muted)]" />}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-[var(--color-border)] flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="font-mono bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1 rounded">↑</kbd>
              <kbd className="font-mono bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1 rounded">↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="font-mono bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1 rounded">↵</kbd> select
            </span>
          </div>
          <span className="flex items-center gap-2 font-mono">
            {orgSearching && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-muted)]" />}
            {items.length} results
          </span>
        </div>
      </div>
    </div>
  );
}
