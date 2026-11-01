"use client";

// The project's type (Setup › Project type, lib/projectType) for every view
// of its schedule: the word they say for the project as a whole.

import React, { createContext, useContext } from "react";
import { DEFAULT_PROJECT_TYPE, typeWord, type ProjectType } from "@/lib/projectType";
import { useProjectType } from "@/lib/shiftTimesStore";

const Ctx = createContext<ProjectType>(DEFAULT_PROJECT_TYPE);

export function ProjectTypeProvider({ projectId, projectName, children }: { projectId: string; projectName?: string; children: React.ReactNode }) {
  const t = useProjectType(projectId, projectName);
  return <Ctx.Provider value={t}>{children}</Ctx.Provider>;
}

/** "Turnaround" / "TA". */
export const useProjectTypeCtx = () => useContext(Ctx);
/** In a sentence: "turnaround". */
export const useProjectWord = () => typeWord(useContext(Ctx));
