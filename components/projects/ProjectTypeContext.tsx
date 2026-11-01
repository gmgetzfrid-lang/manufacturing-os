"use client";

// The project's type (Setup › Project type, lib/projectType) for every view
// of its schedule: the word they say for the project as a whole.

import React, { createContext, useContext } from "react";
import { DEFAULT_PROJECT_TYPE, typeWord, type ProjectType } from "@/lib/projectType";
import { useProjectType } from "@/lib/shiftTimesStore";

const Ctx = createContext<ProjectType>(DEFAULT_PROJECT_TYPE);

export function ProjectTypeProvider({ projectId, projectName, groups, children }: { projectId: string; projectName?: string;
  /** The schedule's group names (phases, tasks with steps): read for the type until it's set. */
  groups?: string[]; children: React.ReactNode }) {
  const t = useProjectType(projectId, projectName, groups);
  return <Ctx.Provider value={t}>{children}</Ctx.Provider>;
}

/** "Turnaround" / "TA". */
export const useProjectTypeCtx = () => useContext(Ctx);
/** In a sentence: "turnaround". */
export const useProjectWord = () => typeWord(useContext(Ctx));
