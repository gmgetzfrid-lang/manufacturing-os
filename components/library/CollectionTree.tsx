"use client";

// components/library/CollectionTree.tsx
// Folder tree UI for Library Collections (nested folders).

import React, { useEffect, useMemo, useState } from "react";
import type { LibraryCollection, NodeVisibility, AccessControl } from "@/types/schema";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  listenLibraryFolders,
  buildFolderTree,
  createFolder,
  renameFolderAndDescendants,
  deleteFolder,
  type FolderNode,
} from "@/lib/libraryCollections";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";

type Props = {
  libraryId: string;
  orgId?: string;
  currentUid: string;
  selectedId?: string | null;
  onSelect?: (folder: LibraryCollection | null) => void;
  allowEdits?: boolean;
  defaultNewVisibility?: NodeVisibility;
  defaultNewAcl?: AccessControl;
};

type ExpandState = Record<string, boolean>;

function cx(...s: Array<string | false | undefined | null>) {
  return s.filter(Boolean).join(" ");
}

function indentPx(depth: number) {
  return 10 + depth * 14;
}

export default function CollectionTree({
  libraryId,
  orgId,
  currentUid,
  selectedId,
  onSelect,
  allowEdits = false,
  defaultNewVisibility = "normal",
  defaultNewAcl,
}: Props) {
  const [folders, setFolders] = useState<LibraryCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [expand, setExpand] = useState<ExpandState>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const unsub = listenLibraryFolders(
      libraryId,
      (items) => {
        setFolders(items);
        setLoading(false);
      },
      { orgId }
    );

    return () => unsub?.();
  }, [libraryId, orgId]);

  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return folders.find((f) => f.id === selectedId) ?? null;
  }, [folders, selectedId]);

  useEffect(() => {
    if (!selected) return;
    const ancestors = selected.pathIds ?? [];
    if (!ancestors.length) return;

    setExpand((prev) => {
      const next = { ...prev };
      for (const id of ancestors) next[id] = true;
      return next;
    });
  }, [selected]);

  const toggle = (id: string) => {
    setExpand((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSelect = (f: LibraryCollection | null) => {
    onSelect?.(f);
  };

  const createAt = async (parentId: string | null) => {
    try {
      setError(null);
      const name = await appPrompt({
        title: parentId ? "New subfolder name" : "New folder name",
        placeholder: "Folder name",
        defaultValue: "",
      });
      if (!name) return;

      setBusyId(parentId ?? "root");

      const id = await createFolder({
        orgId,
        libraryId,
        parentId: parentId ?? null,
        name,
        visibility: defaultNewVisibility,
        acl: defaultNewAcl,
        createdBy: currentUid,
      });

      if (parentId) setExpand((prev) => ({ ...prev, [parentId]: true }));
      handleSelect({ id, libraryId, parentId: parentId ?? undefined, name } as LibraryCollection);
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message;
      setError(msg ?? "Failed to create folder.");
    } finally {
      setBusyId(null);
    }
  };

  const renameNode = async (node: LibraryCollection) => {
    try {
      setError(null);
      const name = await appPrompt({ title: "Rename folder", defaultValue: node.name });
      if (!name || name === node.name) return;

      setBusyId(node.id!);
      await renameFolderAndDescendants(node.id!, name);
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message;
      setError(msg ?? "Failed to rename folder.");
    } finally {
      setBusyId(null);
    }
  };

  const deleteNode = async (node: LibraryCollection) => {
    const ok = await appConfirm({
      title: `Delete folder "${node.name}"?`,
      message: "Choose OK to delete this folder. You will be prompted next if you also want to delete descendants.",
      tone: "danger",
    });
    if (!ok) return;

    const cascade = await appConfirm({
      title: "Cascade delete",
      message: "Also delete all subfolders under this folder? (Cascade delete)",
      tone: "danger",
    });
    try {
      setError(null);
      setBusyId(node.id!);
      await deleteFolder(node.id!, { cascade });
      if (selectedId === node.id) handleSelect(null);
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message;
      setError(msg ?? "Failed to delete folder.");
    } finally {
      setBusyId(null);
    }
  };

  const renderNode = (node: FolderNode, depth: number) => {
    const isExpanded = !!expand[node.id!];
    const isSelected = !!selectedId && node.id === selectedId;
    const hasChildren = (node.children?.length ?? 0) > 0;
    const isBusy = busyId === node.id;
    const visibility = (node.visibility ?? "normal") as NodeVisibility;

    return (
      <div key={node.id}>
        <div
          className={cx(
            "group flex items-center gap-2 rounded-lg px-2 py-2 text-sm",
            "hover:bg-[var(--color-surface-2)]",
            isSelected && "bg-[var(--color-surface-2)]"
          )}
          style={{ marginLeft: indentPx(depth) }}
        >
          <button
            type="button"
            className={cx(
              "h-7 w-7 shrink-0 rounded-md border border-[var(--color-border)]",
              "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
            )}
            onClick={() => (hasChildren ? toggle(node.id!) : handleSelect(node))}
            title={hasChildren ? (isExpanded ? "Collapse" : "Expand") : "Select"}
            aria-label={hasChildren ? (isExpanded ? "Collapse" : "Expand") : "Select"}
          >
            {hasChildren ? (isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />) : null}
          </button>

          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => handleSelect(node)}
            title={node.pathNames?.join(" / ") ?? node.name}
          >
            {isExpanded ? <FolderOpen className="h-4 w-4 text-[var(--color-text-muted)]" /> : <Folder className="h-4 w-4 text-[var(--color-text-muted)]" />}
            <span className="truncate font-semibold text-[var(--color-text)]">{node.name}</span>
            {visibility !== "normal" && (
              <span className="rounded-full border border-amber-200 px-2 py-0.5 text-[10px] text-amber-700 bg-amber-50">
                {visibility}
              </span>
            )}
          </button>

          {allowEdits && (
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                className={cx(
                  "rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)]",
                  "hover:bg-[var(--color-surface-2)]",
                  isBusy && "opacity-60"
                )}
                onClick={() => createAt(node.id!)}
                disabled={isBusy || busyId === "root"}
                title="New subfolder"
              >
                <Plus className="h-3 w-3" />
              </button>

              <button
                type="button"
                className={cx(
                  "rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)]",
                  "hover:bg-[var(--color-surface-2)]",
                  isBusy && "opacity-60"
                )}
                onClick={() => renameNode(node)}
                disabled={isBusy}
                title="Rename folder"
              >
                <Pencil className="h-3 w-3" />
              </button>

              <button
                type="button"
                className={cx(
                  "rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-red-600",
                  "hover:bg-red-50",
                  isBusy && "opacity-60"
                )}
                onClick={() => deleteNode(node)}
                disabled={isBusy}
                title="Delete folder"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>

        {hasChildren && isExpanded && (
          <div className="mt-1">
            {node.children.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--color-text)]">Folders</div>
          <div className="text-xs text-[var(--color-text-muted)]">Library collections (nested folders)</div>
        </div>

        {allowEdits && (
          <button
            type="button"
            className={cx(
              "rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text)]",
              "hover:bg-[var(--color-surface-2)]",
              (busyId === "root" || !!busyId) && "opacity-60"
            )}
            onClick={() => createAt(null)}
            disabled={busyId === "root" || !!busyId}
            title="Create root folder"
          >
            + Root Folder
          </button>
        )}
      </div>

      {error && (
        <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-6 text-sm text-[var(--color-text-muted)]">Loading folders...</div>
      ) : tree.length === 0 ? (
        <div className="py-6 text-sm text-[var(--color-text-muted)]">
          No folders yet. {allowEdits ? "Create one to get started." : ""}
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-auto pr-1">
          {tree.map((n) => renderNode(n, 0))}
        </div>
      )}
    </div>
  );
}
