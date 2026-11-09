"use client";

// EquipmentScope - who is working on which project, for the equipment field
// on work order cards and step panels (provided by the schedule tab).

import React, { createContext, useContext } from "react";

export interface EquipmentScopeValue {
  orgId: string;
  projectId: string;
  projectName: string;
  /** Can change the schedule: link work orders to equipment. */
  canEdit: boolean;
  /** Owner, co-owner (or an admin): can set the project's unit. */
  canManage: boolean;
  userId: string | null;
  userName: string | null;
  /** The schedule changed: read it again. */
  onChanged?: () => void;
}

const Ctx = createContext<EquipmentScopeValue | null>(null);

export function EquipmentScopeProvider({ value, children }: { value: EquipmentScopeValue; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useEquipmentScope = () => useContext(Ctx);
