"use client";

// Pick several roles at once, grouped: a group's box picks or clears the
// whole group (a dash when only some are picked). Real checkboxes, so the
// keyboard and screen readers work; groups fold with a turning chevron and
// their roles sit 16 px in, along a guide line.

import React, { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Role } from "@/types/schema";

export const ROLE_HIERARCHY: { name: string; roles: Role[] }[] = [
  { name: "Leadership", roles: ["Admin", "DocCtrl", "Manager", "Supervisor"] },
  { name: "Engineering", roles: ["Engineer-1", "Engineer-2", "Engineer-3", "Engineer-4", "Drafter"] },
  { name: "Operations", roles: ["Operations", "Maintenance", "Safety"] },
  { name: "Business", roles: ["Accounting", "HR", "Auditor", "Requester"] },
  { name: "External", roles: ["Contractor", "Viewer"] },
];

interface RoleTreeSelectorProps {
  selected: Role[];
  onChange: (roles: Role[]) => void;
  disabled?: boolean;
}

function GroupBox({ all, some, disabled, label, onChange }: { all: boolean; some: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = some; }, [some]);
  return <input ref={ref} type="checkbox" className="w-4 h-4" checked={all} disabled={disabled} onChange={onChange} aria-label={`All of ${label}`} />;
}

export function RoleTreeSelector({ selected, onChange, disabled }: RoleTreeSelectorProps) {
  const [expanded, setExpanded] = useState<string[]>(ROLE_HIERARCHY.map((g) => g.name)); // all open at first

  const toggleExpand = (groupName: string) => {
    setExpanded((prev) => (prev.includes(groupName) ? prev.filter((n) => n !== groupName) : [...prev, groupName]));
  };

  const handleGroup = (groupRoles: Role[]) => {
    if (disabled) return;
    const allSelected = groupRoles.every((r) => selected.includes(r));
    onChange(allSelected ? selected.filter((r) => !groupRoles.includes(r)) : Array.from(new Set([...selected, ...groupRoles])));
  };

  const handleRole = (role: Role) => {
    if (disabled) return;
    onChange(selected.includes(role) ? selected.filter((r) => r !== role) : [...selected, role]);
  };

  return (
    <div className="divide-y divide-[var(--color-border)] bg-[var(--color-surface)]">
      {ROLE_HIERARCHY.map((group) => {
        const isExpanded = expanded.includes(group.name);
        const count = group.roles.filter((r) => selected.includes(r)).length;
        const isAll = count === group.roles.length;
        const isSome = count > 0 && !isAll;
        return (
          <div key={group.name}>
            <div className="flex items-center gap-2 px-2 min-h-10 pointer-coarse:min-h-11">
              <button type="button" onClick={() => toggleExpand(group.name)} aria-expanded={isExpanded} aria-label={`${isExpanded ? "Close" : "Open"} ${group.name}`}
                className="ui-hit w-7 h-7 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]">
                <ChevronRight aria-hidden className={`ui-chevron w-4 h-4 ${isExpanded ? "rotate-90" : ""}`} />
              </button>
              <label className="flex-1 flex items-center gap-2 cursor-pointer text-body font-medium text-[var(--color-text)]">
                <GroupBox all={isAll} some={isSome} disabled={disabled} label={group.name} onChange={() => handleGroup(group.roles)} />
                {group.name}
              </label>
              <span className="text-body text-[var(--color-text-muted)] tabular-nums">{count} of {group.roles.length}</span>
            </div>
            {isExpanded && (
              <ul className="ml-[22px] pl-4 border-l border-[var(--color-border)] pb-1.5">
                {group.roles.map((role) => (
                  <li key={role}>
                    <label className={`flex items-center gap-2.5 px-2 min-h-9 pointer-coarse:min-h-11 rounded-md cursor-pointer hover:bg-[var(--color-surface-2)] text-body ${selected.includes(role) ? "text-[var(--color-text)] font-medium" : "text-[var(--color-text-muted)]"} ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
                      <input type="checkbox" className="w-4 h-4" checked={selected.includes(role)} disabled={disabled} onChange={() => handleRole(role)} />
                      {role}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
