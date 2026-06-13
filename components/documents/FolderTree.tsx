"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { LibraryCollection, NodeVisibility } from "@/types/schema";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Search } from "lucide-react";

type FolderTreeProps = {
  collections: LibraryCollection[];
  currentFolderId?: string | null;
  onSelect: (folderId: string | null) => void;
  onCreate?: (parentId: string | null) => void;
  onMove?: (folderId: string) => void;
  canSeeCollection?: (c: LibraryCollection) => boolean;
  showRoot?: boolean;
  rootLabel?: string;
};

type Node = LibraryCollection & { children: Node[] };

function normParentId(v: unknown): string {
  return v ? String(v) : "__root__";
}

function cx(...s: Array<string | false | undefined | null>) {
  return s.filter(Boolean).join(" ");
}

export default function FolderTree({
  collections,
  currentFolderId,
  onSelect,
  onCreate,
  onMove,
  canSeeCollection,
  showRoot = true,
  rootLabel = "All folders",
}: FolderTreeProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const visibleCollections = useMemo(() => {
    const base = Array.isArray(collections) ? collections : [];
    return canSeeCollection ? base.filter(canSeeCollection) : base;
  }, [collections, canSeeCollection]);

  const { byId, roots } = useMemo(() => {
    const idMap = new Map<string, LibraryCollection>();
    for (const c of visibleCollections) {
      if (c?.id) idMap.set(c.id, c);
    }

    const childrenByParent = new Map<string, LibraryCollection[]>();
    for (const c of visibleCollections) {
      const pid = normParentId(c.parentId);
      const arr = childrenByParent.get(pid) ?? [];
      arr.push(c);
      childrenByParent.set(pid, arr);
    }

    const makeNode = (c: LibraryCollection): Node => {
      const kids = (childrenByParent.get(c.id!) ?? [])
        .slice()
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
      return { ...c, children: kids.map(makeNode) } as Node;
    };

    const rootKids = (childrenByParent.get("__root__") ?? [])
      .slice()
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
      .map(makeNode);

    return { byId: idMap, roots: rootKids };
  }, [visibleCollections]);

  useEffect(() => {
    if (!currentFolderId) return;
    const target = byId.get(currentFolderId);
    if (!target) return;

    setExpanded(prev => {
      // Check if already expanded to avoid unnecessary updates
      let isChanged = false;
      const next = { ...prev };

      const ensureExpanded = (id: string) => {
        if (!next[id]) {
          next[id] = true;
          isChanged = true;
        }
      };

      const pathIds = Array.isArray(target.pathIds) ? target.pathIds : [];
      if (pathIds.length) {
        for (const id of pathIds) ensureExpanded(id);
        ensureExpanded(currentFolderId);
      } else {
        // Fallback for legacy data without pathIds
        let cur: LibraryCollection | undefined = target;
        let guard = 0;
        while (cur?.parentId && guard < 200) {
          ensureExpanded(cur.parentId);
          cur = byId.get(cur.parentId);
          guard++;
        }
      }

      return isChanged ? next : prev;
    });
  }, [currentFolderId, byId]);

  const filteredRoots = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return roots;

    const filterNode = (n: Node): Node | null => {
      const name = (n.name ?? "").toLowerCase();
      const matches = name.includes(q);

      const keptChildren: Node[] = [];
      for (const ch of n.children) {
        const kept = filterNode(ch);
        if (kept) keptChildren.push(kept);
      }

      if (matches || keptChildren.length) {
        return { ...n, children: keptChildren } as Node;
      }
      return null;
    };

    return roots
      .map(filterNode)
      .filter(Boolean)
      .map((x) => x as Node);
  }, [roots, query]);

  const isExpanded = (id: string) => !!expanded[id];

  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const Row = ({ node, depth, forceOpen }: { node: Node; depth: number; forceOpen?: boolean }) => {
    const hasKids = node.children.length > 0;
    const open = forceOpen ? true : isExpanded(node.id!);
    const selected = currentFolderId === node.id;

    const visibility = (node.visibility ?? "normal") as NodeVisibility;

    return (
      <div>
        <div
          className={cx(
            "group flex items-center gap-2 rounded-xl px-2 py-2 cursor-pointer",
            "hover:bg-[var(--color-surface-2)]",
            selected ? "bg-[var(--color-surface-2)]" : ""
          )}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => onSelect(node.id!)}
        >
          <button
            type="button"
            className={cx(
              "h-7 w-7 grid place-items-center rounded-lg border border-[var(--color-border)]",
              "hover:bg-[var(--color-surface-2)]",
              hasKids ? "opacity-100" : "opacity-0 pointer-events-none"
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggle(node.id!);
            }}
            aria-label={open ? "Collapse folder" : "Expand folder"}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>

          {open ? <FolderOpen className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" /> : <Folder className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />}

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-[var(--color-text)]">{node.name}</div>
            {Array.isArray(node.pathNames) && node.pathNames.length > 1 ? (
              <div className="truncate text-[11px] text-[var(--color-text-muted)]">
                {node.pathNames.slice(0, -1).join(" / ")}
              </div>
            ) : null}
          </div>

          {visibility !== "normal" && (
            <span className="text-[10px] px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-700">
              {visibility}
            </span>
          )}

          {(onCreate || onMove) && (
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
              {onCreate && (
                <button
                  type="button"
                  className="text-[11px] px-2 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCreate(node.id!);
                  }}
                >
                  + Folder
                </button>
              )}
              {onMove && (
                <button
                  type="button"
                  className="text-[11px] px-2 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(node.id!);
                  }}
                >
                  Move
                </button>
              )}
            </div>
          )}
        </div>

        {hasKids && open ? (
          <div>
            {node.children.map((ch) => (
              <Row key={ch.id} node={ch} depth={depth + 1} forceOpen={!!query.trim()} />
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <Search className="h-4 w-4 text-[var(--color-text-muted)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search folders"
          className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--color-text-faint)]"
        />
      </div>

      <div className="space-y-1">
        {showRoot ? (
          <div
            className={cx(
              "flex items-center gap-2 rounded-xl px-2 py-2 cursor-pointer",
              "hover:bg-[var(--color-surface-2)]",
              !currentFolderId ? "bg-[var(--color-surface-2)]" : ""
            )}
            onClick={() => onSelect(null)}
          >
            <div className="h-7 w-7" />
            <Folder className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
            <div className="truncate text-sm font-semibold text-[var(--color-text)]">{rootLabel}</div>
          </div>
        ) : null}

        {filteredRoots.length ? (
          filteredRoots.map((n) => <Row key={n.id} node={n} depth={0} />)
        ) : (
          <div className="px-2 py-6 text-center text-sm text-[var(--color-text-muted)]">No folders found.</div>
        )}
      </div>
    </div>
  );
}
