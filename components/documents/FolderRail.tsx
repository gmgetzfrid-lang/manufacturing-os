"use client";

import React, { useState } from "react";
import { Home, FolderPlus, ChevronRight, Folder, PanelLeftOpen } from "lucide-react";
import type { LibraryCollection } from "@/types/schema";

interface FolderRailProps {
  libraryName: string;
  folders: LibraryCollection[];
  currentFolderId: string | null;
  isController: boolean;
  onNavigate: (id: string | null) => void;
  onCreateFolder: () => void;
}

function TreeNode({
  folder,
  allFolders,
  depth,
  currentFolderId,
  onNavigate,
}: {
  folder: LibraryCollection;
  allFolders: LibraryCollection[];
  depth: number;
  currentFolderId: string | null;
  onNavigate: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const children = allFolders.filter((f) => f.parentId === folder.id);
  const isActive = currentFolderId === folder.id;

  return (
    <div>
      <div
        className={`flex items-center gap-0.5 rounded-lg transition-all ${
          isActive
            ? "bg-[var(--color-accent)]/12 text-[var(--color-accent)]"
            : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        }`}
        style={{ paddingLeft: `${4 + depth * 12}px`, paddingRight: 6, paddingTop: 4, paddingBottom: 4 }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className={`shrink-0 p-0.5 rounded ${children.length === 0 ? "invisible" : ""}`}
        >
          <ChevronRight className={`w-3 h-3 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`} />
        </button>
        <button
          onClick={() => onNavigate(folder.id!)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left py-0.5"
        >
          <Folder className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-[var(--color-accent)]" : "text-amber-500"}`} />
          <span className="text-xs font-medium truncate">{folder.name}</span>
        </button>
      </div>
      {expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.id}
              folder={child}
              allFolders={allFolders}
              depth={depth + 1}
              currentFolderId={currentFolderId}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FolderRail({
  libraryName,
  folders,
  currentFolderId,
  isController,
  onNavigate,
  onCreateFolder,
}: FolderRailProps) {
  const [hovered, setHovered] = useState(false);
  const rootFolders = folders.filter((f) => !f.parentId);
  const topVisible = rootFolders.slice(0, 7);
  const overflow = rootFolders.length - topVisible.length;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group/rail relative z-30 h-full shrink-0"
    >
      {/* COLLAPSED RAIL — always visible, theme-toned */}
      <div className={`w-12 h-full bg-[var(--color-surface-2)] border-r flex flex-col items-center py-2 gap-1 transition-colors ${hovered ? "border-[var(--color-accent)]/40" : "border-[var(--color-border)]"}`}>
        {/* Discoverability: an obvious "open folders" affordance at the top. */}
        <div
          className={`flex flex-col items-center gap-1 mb-1 transition-colors ${hovered ? "text-[var(--color-accent)]" : "text-[var(--color-text-faint)]"}`}
          title="Folders — hover to browse"
        >
          <PanelLeftOpen className="w-4 h-4" />
          <span className="text-[8px] font-black uppercase tracking-[0.15em] leading-none" style={{ writingMode: "vertical-rl" }}>Folders</span>
        </div>

        <div className="w-6 h-px bg-[var(--color-border)] my-1" />

        <button
          onClick={() => onNavigate(null)}
          className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
            !currentFolderId
              ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/40"
              : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          }`}
          title={libraryName}
        >
          <Home className="w-4 h-4" />
        </button>

        {topVisible.map((folder) => {
          const isActive = currentFolderId === folder.id;
          return (
            <button
              key={folder.id}
              onClick={() => onNavigate(folder.id!)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all relative ${
                isActive
                  ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/40"
                  : "text-amber-500 hover:bg-[var(--color-surface)] hover:text-amber-600"
              }`}
              title={folder.name}
            >
              <Folder className="w-3.5 h-3.5" />
              {isActive && (
                <span className="absolute -left-0.5 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-[var(--color-accent)] rounded-r-full" />
              )}
            </button>
          );
        })}

        {overflow > 0 && (
          <div className="text-[9px] font-bold text-[var(--color-text-faint)] mt-0.5">+{overflow}</div>
        )}

        <div className="flex-1" />

        {isController && (
          <button
            onClick={onCreateFolder}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] transition-all"
            title="New folder"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* EXPANDED OVERLAY — slides out on hover, theme surface */}
      <div
        className={`absolute top-0 left-12 h-full transition-all duration-300 pointer-events-none ${
          hovered ? "w-60 opacity-100" : "w-0 opacity-0"
        }`}
        style={{ transitionTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)" }}
      >
        <div
          className={`h-full w-60 bg-[var(--color-surface)] border-r border-[var(--color-border)] shadow-xl overflow-hidden ${
            hovered ? "pointer-events-auto" : ""
          }`}
        >
          <div className="h-full flex flex-col">
            <div className="px-3 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between">
              <div>
                <div className="text-[9px] font-black text-[var(--color-text-faint)] uppercase tracking-widest">Library</div>
                <div className="text-xs font-bold text-[var(--color-text)] truncate max-w-[180px]">{libraryName}</div>
              </div>
              {isController && (
                <button
                  onClick={onCreateFolder}
                  className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] transition-colors"
                  title="New folder"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto py-2 px-1.5 custom-scrollbar">
              <button
                onClick={() => onNavigate(null)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-all mb-1 ${
                  !currentFolderId
                    ? "bg-[var(--color-accent)]/12 text-[var(--color-accent)] font-bold"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                }`}
              >
                <Home className="w-3.5 h-3.5 shrink-0" />
                <span className="text-xs font-medium truncate">{libraryName}</span>
              </button>

              {rootFolders.map((folder) => (
                <TreeNode
                  key={folder.id}
                  folder={folder}
                  allFolders={folders}
                  depth={0}
                  currentFolderId={currentFolderId}
                  onNavigate={onNavigate}
                />
              ))}

              {folders.length === 0 && (
                <p className="text-[11px] text-[var(--color-text-faint)] text-center py-6 px-2">No folders yet</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
