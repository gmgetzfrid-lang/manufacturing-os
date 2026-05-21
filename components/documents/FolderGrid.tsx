"use client";

import React, { useState, useRef, useEffect } from "react";
import { 
  Folder, 
  MoreVertical, 
  FolderOpen, 
  Pencil, 
  Lock, 
  ArrowRight, 
  Trash2 
} from "lucide-react";
import { LibraryCollection } from "@/types/schema";

interface FolderGridProps {
  folders: LibraryCollection[];
  onOpen: (id: string) => void;
  onRename?: (id: string) => void;
  onMove?: (id: string) => void;
  onPermissions?: (id: string) => void;
  isController: boolean;
}

export default function FolderGrid({ 
  folders, 
  onOpen, 
  onRename, 
  onMove, 
  onPermissions,
  isController 
}: FolderGridProps) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menus on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextMenu({ id, x: e.clientX, y: e.clientY });
    setMenuOpenId(null);
  };

  const renderMenu = (id: string) => (
    <div 
      ref={menuRef}
      onClick={(e) => e.stopPropagation()}
      className="absolute z-50 bg-white rounded-lg shadow-xl border border-slate-100 w-48 py-1 overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-top-right"
      style={contextMenu?.id === id ? { top: 0, left: 0, position: 'relative' } : { top: '100%', right: 0 }}
    >
      <button onClick={() => { onOpen(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center font-medium">
        <FolderOpen className="w-4 h-4 mr-2 text-slate-400" /> Open
      </button>
      {isController && (
        <>
          <div className="h-px bg-slate-100 my-1" />
          <button onClick={() => { onRename?.(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center font-medium">
            <Pencil className="w-4 h-4 mr-2 text-slate-400" /> Rename
          </button>
          <button onClick={() => { onMove?.(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center font-medium">
            <ArrowRight className="w-4 h-4 mr-2 text-slate-400" /> Move
          </button>
          <button onClick={() => { onPermissions?.(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center font-medium">
            <Lock className="w-4 h-4 mr-2 text-slate-400" /> Permissions
          </button>
        </>
      )}
    </div>
  );

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {folders.map(folder => (
        <div 
          key={folder.id}
          onClick={() => onOpen(folder.id!)}
          onContextMenu={(e) => handleContextMenu(e, folder.id!)}
          className={`
            group relative flex flex-col p-4 rounded-xl border transition-all duration-200 cursor-pointer
            ${(menuOpenId === folder.id || contextMenu?.id === folder.id) 
              ? 'bg-blue-50/50 border-blue-200 shadow-md ring-1 ring-blue-200' 
              : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-md hover:-translate-y-0.5'}
          `}
        >
          <div className="flex items-start justify-between mb-3">
            <div className={`p-2.5 rounded-lg transition-colors ${(menuOpenId === folder.id || contextMenu?.id === folder.id) ? 'bg-blue-100 text-blue-600' : 'bg-slate-50 text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-500'}`}>
              <Folder className="w-6 h-6 fill-current" />
            </div>
            
            <div className="relative">
              <button 
                onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === folder.id ? null : folder.id!); setContextMenu(null); }}
                className={`p-1.5 rounded-lg hover:bg-slate-100 transition-colors ${(menuOpenId === folder.id) ? 'bg-slate-100 text-slate-900' : 'text-slate-400 opacity-0 group-hover:opacity-100'}`}
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {menuOpenId === folder.id && renderMenu(folder.id!)}
            </div>
          </div>

          <h3 className="text-sm font-bold text-slate-700 truncate mb-0.5 select-none">{folder.name}</h3>
          <p className="text-[10px] text-slate-400 font-medium truncate select-none">
            {folder.pathNames?.length ? folder.pathNames.slice(0, -1).join('/') : 'Root'}
          </p>

          {/* Custom Context Menu Overlay */}
          {contextMenu?.id === folder.id && (
            <div 
              className="fixed z-[100]" 
              style={{ top: contextMenu?.y, left: contextMenu?.x }}
              onClick={(e) => e.stopPropagation()} // Prevent closing immediately
            >
              {renderMenu(folder.id!)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
