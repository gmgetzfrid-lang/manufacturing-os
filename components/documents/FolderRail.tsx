"use client";

import React, { useState } from "react";
import { Home, FolderPlus, ChevronRight, Folder } from "lucide-react";
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
            ? "bg-blue-500/10 text-blue-300"
            : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
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
          <Folder className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-blue-400" : "text-amber-400/80"}`} />
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
      className="relative z-30 h-full shrink-0"
    >
      {/* COLLAPSED RAIL — always visible */}
      <div className="w-11 h-full bg-slate-950 border-r border-slate-800/80 flex flex-col items-center py-2 gap-1">
        <button
          onClick={() => onNavigate(null)}
          className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
            !currentFolderId
              ? "bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/40"
              : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
          }`}
          title={libraryName}
        >
          <Home className="w-4 h-4" />
        </button>

        <div className="w-6 h-px bg-slate-800 my-1" />

        {topVisible.map((folder) => {
          const isActive = currentFolderId === folder.id;
          return (
            <button
              key={folder.id}
              onClick={() => onNavigate(folder.id!)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all relative group ${
                isActive
                  ? "bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/40"
                  : "text-amber-400/70 hover:bg-white/5 hover:text-amber-300"
              }`}
              title={folder.name}
            >
              <Folder className="w-3.5 h-3.5" />
              {isActive && (
                <span className="absolute -left-0.5 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-blue-400 rounded-r-full" />
              )}
            </button>
          );
        })}

        {overflow > 0 && (
          <div className="text-[9px] font-bold text-slate-600 mt-0.5">+{overflow}</div>
        )}

        <div className="flex-1" />

        {isController && (
          <button
            onClick={onCreateFolder}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-white/5 hover:text-slate-200 transition-all"
            title="New folder"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* EXPANDED OVERLAY — slides out on hover */}
      <div
        className={`absolute top-0 left-11 h-full transition-all duration-300 pointer-events-none ${
          hovered ? "w-60 opacity-100" : "w-0 opacity-0"
        }`}
        style={{ transitionTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)" }}
      >
        <div
          className={`h-full w-60 bg-slate-950/95 border-r border-slate-800/80 overflow-hidden ${
            hovered ? "pointer-events-auto" : ""
          }`}
          style={{ backdropFilter: "blur(20px) saturate(180%)" }}
        >
          <div className="h-full flex flex-col">
            <div className="px-3 py-2.5 border-b border-slate-800/80 flex items-center justify-between">
              <div>
                <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Library</div>
                <div className="text-xs font-bold text-slate-200 truncate max-w-[180px]">{libraryName}</div>
              </div>
              {isController && (
                <button
                  onClick={onCreateFolder}
                  className="p-1.5 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-200 transition-colors"
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
                    ? "bg-blue-500/15 text-blue-300 font-bold"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
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
                <p className="text-[11px] text-slate-600 text-center py-6 px-2">No folders yet</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
