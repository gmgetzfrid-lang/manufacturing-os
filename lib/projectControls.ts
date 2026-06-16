// lib/projectControls.ts
//
// Persistence + IO for the project-controls cost model. The earned-value MATH
// lives in lib/evm.ts (pure, tested); this is the thin layer that reads/writes
// the model on the project and keeps the audit trail.
//
// Graceful degradation: the cost model lives in projects.controls_config, added
// by 20260801_project_controls_cost.sql. On environments where that migration
// hasn't run yet, the UPDATE fails with a "column does not exist" error — we
// catch it and fall back to a per-browser localStorage copy so the dashboard
// still works (and the UI honestly says the value is local-only). This mirrors
// how the scheduling layer shipped ahead of its own columns.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import type { Project, ProjectControlsConfig } from "@/types/schema";

const LOCAL_PREFIX = "refinery.projectControls.";

function localKey(projectId: string) {
  return `${LOCAL_PREFIX}${projectId}`;
}

function readLocal(projectId: string): ProjectControlsConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(localKey(projectId));
    return raw ? (JSON.parse(raw) as ProjectControlsConfig) : null;
  } catch {
    return null;
  }
}

function writeLocal(projectId: string, cfg: ProjectControlsConfig) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(localKey(projectId), JSON.stringify(cfg));
  } catch {
    /* storage full / disabled — nothing we can do, the in-memory state holds */
  }
}

/** True when an error means the controls_config column isn't there yet
 *  (pre-migration). Mirrors lib/checkoutEpisodes.ts:isMissingEpisodeSchema:
 *  42703 = raw Postgres undefined_column; PGRST204 = PostgREST unknown column
 *  (schema cache). The message fallback requires BOTH the column name AND a
 *  "missing" phrase so a real RLS/constraint error that merely echoes the
 *  column name isn't silently swallowed as "migration not run". */
function isMissingColumn(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const msg = (err.message ?? "").toLowerCase();
  return (
    msg.includes("controls_config") &&
    (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find"))
  );
}

export const DEFAULT_CONTROLS: ProjectControlsConfig = {
  blendedRate: null,
  budgetOverride: null,
  actualCost: null,
  contingency: null,
  currency: "USD",
};

/**
 * Resolve the effective cost model for a project. Prefers the server-persisted
 * controls_config (already mapped onto the Project by lib/projects.ts); falls
 * back to the per-browser local copy used on pre-migration environments.
 */
export function loadControlsConfig(project: Pick<Project, "id" | "controlsConfig">): {
  config: ProjectControlsConfig;
  source: "server" | "local" | "none";
} {
  // Server wins when present — and it stays fresh because a successful save
  // patches the parent's Project in place (ProjectControlsTab.onConfigPersisted),
  // so the prop is never a stale edit behind. `source` therefore honestly
  // reflects where the shown values live: "local" only when the DB has nothing
  // (the true pre-migration / unpersisted case).
  if (project.controlsConfig && Object.keys(project.controlsConfig).length > 0) {
    return { config: { ...DEFAULT_CONTROLS, ...project.controlsConfig }, source: "server" };
  }
  const local = project.id ? readLocal(project.id) : null;
  if (local) return { config: { ...DEFAULT_CONTROLS, ...local }, source: "local" };
  return { config: { ...DEFAULT_CONTROLS }, source: "none" };
}

export interface SaveControlsInput {
  projectId: string;
  orgId: string;
  config: ProjectControlsConfig;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

export interface SaveControlsResult {
  /** True when written to the database; false when it could only be stored
   *  locally because the migration hasn't run. */
  persisted: boolean;
  config: ProjectControlsConfig;
}

/**
 * Persist the cost model on the project. Always writes a local copy first (so
 * the value survives even if the network call fails), then tries the database.
 * Returns whether the server accepted it so the UI can be honest about scope.
 */
export async function saveControlsConfig(input: SaveControlsInput): Promise<SaveControlsResult> {
  const now = new Date().toISOString();
  const config: ProjectControlsConfig = {
    ...input.config,
    updatedAt: now,
    updatedBy: input.actorUserId,
  };

  // Local copy is the safety net — write it unconditionally.
  writeLocal(input.projectId, config);

  const { error } = await supabase
    .from("projects")
    .update({ controls_config: config, updated_at: now, updated_by: input.actorUserId })
    .eq("id", input.projectId);

  if (error) {
    if (isMissingColumn(error)) {
      // Pre-migration environment: the local copy is all we have. Not an error
      // the user needs to see as a failure — surface it as "local only" instead.
      return { persisted: false, config };
    }
    throw new Error(error.message);
  }

  await logAuditAction({
    action: "PROJECT_CONTROLS_UPDATED",
    resourceId: input.projectId,
    resourceType: "project",
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorEmail,
    userRole: input.actorRole,
    details: {
      blendedRate: config.blendedRate ?? null,
      budgetOverride: config.budgetOverride ?? null,
      actualCost: config.actualCost ?? null,
      contingency: config.contingency ?? null,
      currency: config.currency ?? null,
    },
  });

  return { persisted: true, config };
}
