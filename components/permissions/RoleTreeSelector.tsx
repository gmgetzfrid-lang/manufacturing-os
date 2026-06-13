"use client";

import React, { useState } from "react";
import { ChevronRight, ChevronDown, CheckSquare, Square, MinusSquare } from "lucide-react";
import { Role } from "@/types/schema";

export const ROLE_HIERARCHY: { name: string; roles: Role[] }[] = [
  { 
    name: "Leadership", 
    roles: ["Admin", "DocCtrl", "Manager", "Supervisor"] 
  },
  { 
    name: "Engineering", 
    roles: ["Engineer-1", "Engineer-2", "Engineer-3", "Engineer-4", "Drafter"] 
  },
  { 
    name: "Operations", 
    roles: ["Operations", "Maintenance", "Safety"] 
  },
  { 
    name: "Business", 
    roles: ["Accounting", "HR", "Auditor", "Requester"] 
  },
  { 
    name: "External", 
    roles: ["Contractor", "Viewer"] 
  },
];

interface RoleTreeSelectorProps {
  selected: Role[];
  onChange: (roles: Role[]) => void;
  disabled?: boolean;
}

export function RoleTreeSelector({ selected, onChange, disabled }: RoleTreeSelectorProps) {
  const [expanded, setExpanded] = useState<string[]>(ROLE_HIERARCHY.map(g => g.name)); // Default expand all

  const toggleExpand = (groupName: string) => {
    setExpanded(prev => 
      prev.includes(groupName) ? prev.filter(n => n !== groupName) : [...prev, groupName]
    );
  };

  const handleGroupClick = (groupRoles: Role[]) => {
    if (disabled) return;
    
    const allSelected = groupRoles.every(r => selected.includes(r));
    let newSelected = [...selected];

    if (allSelected) {
      // Deselect all
      newSelected = newSelected.filter(r => !groupRoles.includes(r));
    } else {
      // Select all (merge unique)
      newSelected = Array.from(new Set([...newSelected, ...groupRoles]));
    }
    onChange(newSelected);
  };

  const handleRoleClick = (role: Role) => {
    if (disabled) return;
    
    if (selected.includes(role)) {
      onChange(selected.filter(r => r !== role));
    } else {
      onChange([...selected, role]);
    }
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden bg-[var(--color-surface)] select-none">
      {ROLE_HIERARCHY.map((group) => {
        const isExpanded = expanded.includes(group.name);
        
        // Group State
        const groupSelectedCount = group.roles.filter(r => selected.includes(r)).length;
        const isAll = groupSelectedCount === group.roles.length;
        const isSome = groupSelectedCount > 0 && !isAll;

        return (
          <div key={group.name} className="border-b border-[var(--color-border)] last:border-0">
            {/* Group Header */}
            <div className="flex items-center bg-slate-50/50 hover:bg-slate-100/80 transition-colors py-2 px-3 cursor-pointer">
              <button 
                onClick={(e) => { e.stopPropagation(); toggleExpand(group.name); }}
                className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] mr-1"
              >
                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
              
              <div 
                className="flex-1 flex items-center"
                onClick={() => handleGroupClick(group.roles)}
              >
                 <div className={`mr-2 ${disabled ? 'opacity-50' : ''}`}>
                    {isAll ? <CheckSquare className="w-4 h-4 text-blue-600" /> : 
                     isSome ? <MinusSquare className="w-4 h-4 text-blue-600" /> : 
                     <Square className="w-4 h-4 text-slate-300" />}
                 </div>
                 <span className="text-sm font-bold text-[var(--color-text)]">{group.name}</span>
                 <span className="ml-auto text-xs text-[var(--color-text-faint)] font-medium">{groupSelectedCount} / {group.roles.length}</span>
              </div>
            </div>

            {/* Roles List */}
            {isExpanded && (
              <div className="bg-[var(--color-surface)] py-1">
                {group.roles.map(role => {
                  const isSelected = selected.includes(role);
                  return (
                    <div 
                      key={role} 
                      onClick={() => handleRoleClick(role)}
                      className={`flex items-center pl-10 pr-4 py-1.5 cursor-pointer hover:bg-blue-50 transition-colors ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
                    >
                      <div className="mr-3">
                        {isSelected ? <CheckSquare className="w-4 h-4 text-blue-500" /> : <Square className="w-4 h-4 text-slate-200" />}
                      </div>
                      <span className={`text-sm ${isSelected ? 'font-semibold text-blue-900' : 'text-[var(--color-text-muted)]'}`}>{role}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
