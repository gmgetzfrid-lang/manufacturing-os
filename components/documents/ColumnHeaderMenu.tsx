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
  Tags,
  Link as LinkIcon
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MetadataFieldType } from "@/types/schema";

interface ColumnHeaderMenuProps {
  onAdd: (type: MetadataFieldType) => void;
  isController: boolean;
}

const FIELD_TYPES: { type: MetadataFieldType; label: string; icon: LucideIcon }[] = [
  { type: 'text', label: 'Single Line of Text', icon: Type },
  { type: 'number', label: 'Number', icon: Hash },
  { type: 'select', label: 'Choice', icon: List },
  { type: 'tags', label: 'Tags / Equipment', icon: Tags },
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
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Add a column"
        className="w-8 h-8 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
        title="Add a column"
      >
        <Plus className="w-4 h-4" />
      </button>

      {isOpen && (
        <div role="menu" aria-label="Add a column" className="ui-float ui-float-in absolute right-0 top-full mt-1.5 w-56 origin-top-right rounded-xl bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] z-50 overflow-hidden">
          <div className="py-1">
            <div className="px-3 pt-1.5 pb-1 text-caption font-normal text-[var(--color-text-muted)]">Add a column of</div>
            <div>
              {FIELD_TYPES.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.type}
                    onClick={() => { onAdd(t.type); setIsOpen(false); }}
                    role="menuitem"
                    className="w-full flex items-center gap-2.5 px-3 min-h-10 text-body font-normal text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
                  >
                    <Icon aria-hidden className="w-4 h-4 text-[var(--color-text-faint)]" />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="border-t border-[var(--color-border)] py-1">
             <button
               type="button"
               role="menuitem"
               className="w-full flex items-center px-3 min-h-10 text-body font-normal text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
               onClick={() => { onAdd('text'); setIsOpen(false); }} // Should trigger full wizard step 1 ideally, but text is fine default
             >
               Other kinds…
             </button>
          </div>
        </div>
      )}
    </div>
  );
}
