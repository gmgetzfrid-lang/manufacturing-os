"use client";

// The project's phases and the one picked, for the screens deep in the
// schedule (Reports' phase report) without passing them through each.

import { createContext, useContext } from "react";
import type { Milestone } from "@/types/schema";
import type { ProjectPhase } from "@/lib/projectPhases";

export interface PhaseCtx {
  phases: ProjectPhase[];
  /** The phase picked (null: all phases). */
  phase: string | null;
  /** Every step on the project, every phase. */
  all: Milestone[];
}

const Ctx = createContext<PhaseCtx>({ phases: [], phase: null, all: [] });
export const PhaseProvider = Ctx.Provider;
export const usePhases = () => useContext(Ctx);
