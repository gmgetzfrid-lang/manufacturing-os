"use client";

import React, { useState, useRef, useEffect } from "react";
import { 
  Plus, 
  Type, 
  Hash, 
  Calendar, 
  CheckSquare, 
  List, 
  User, 
  Link as LinkIcon 
} from "lucide-react";
import { MetadataFieldType } from "@/types/schema";

interface ColumnHeaderMenuProps {
  onAdd: (type: MetadataFieldType) => void;
  isController: boolean;
}

const FIELD_TYPES: { type: MetadataFieldType; label: string; icon: any }[] = [
  { type: 'text', label: 'Single Line of Text', icon: Type },
  { type: 'number', label: 'Number', icon: Hash },
  { type: 'select', label: 'Choice', icon: List },
  { type: 'date', label: 'Date & Time', icon: Calendar },
  { type: 'user', label: 'Person', icon: User },
  { type: 'boolean', label: 'Yes / No', icon: CheckSquare },
  { type: 'link', label: 'Hyperlink', icon: LinkIcon },
];

export default function ColumnHeaderMenu({ onAdd, isController }: ColumnHeaderMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (!isController) return null;

  return (
    <div className="relative inline-block text-left" ref={menuRef}>
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        title="Add Column"
      >
        <Plus className="w-4 h-4" />
        <span className="ml-2 text-xs font-bold uppercase hidden sm:inline">Add Column</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-56 origin-top-right rounded-xl bg-white shadow-xl ring-1 ring-black/5 focus:outline-none z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-100">
          <div className="p-2">
            <h4 className="px-3 py-2 text-xs font-bold text-slate-400 uppercase tracking-wider">Select Type</h4>
            <div className="space-y-1">
              {FIELD_TYPES.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.type}
                    onClick={() => { onAdd(t.type); setIsOpen(false); }}
                    className="w-full flex items-center px-3 py-2 text-sm text-slate-700 rounded-lg hover:bg-slate-50 transition-colors group"
                  >
                    <div className="mr-3 p-1.5 bg-slate-50 rounded-md text-slate-400 group-hover:text-blue-600 group-hover:bg-blue-50">
                      <Icon className="w-4 h-4" />
                    </div>
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="border-t border-slate-100 p-2 bg-slate-50">
             <button 
               className="w-full text-center text-xs font-bold text-slate-500 hover:text-blue-600 py-1"
               onClick={() => { onAdd('text'); setIsOpen(false); }} // Should trigger full wizard step 1 ideally, but text is fine default
             >
               More...
             </button>
          </div>
        </div>
      )}
    </div>
  );
}
