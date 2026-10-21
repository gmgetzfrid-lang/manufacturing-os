// lib/ticketProjectClient.ts
//
// drafting-flow Round G, DF-P8 PROJECTS — the browser's side of
// /api/tickets/project-link (GAP-114 / DEC-40): link a request to a project,
// unlink it, or record that a project was just created from it. Nothing here
// writes the ticket row: the route does, as the service role, with one
// compare-and-set and the request's one history line for the link.

import { supabase } from "@/lib/supabase";

export type ProjectLinkResult =
  | { ok: true; projectId: string | null; warning?: string; unchanged?: boolean }
  | { ok: false; status: number; error: string; notMigrated?: boolean };

async function bearer(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function postProjectLink(input: { ticketId: string; projectId: string | null; converted?: boolean }): Promise<ProjectLinkResult> {
  const token = await bearer();
  if (!token) return { ok: false, status: 401, error: "You're signed out — sign in again and retry." };
  let res: Response;
  try {
    res = await fetch("/api/tickets/project-link", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ ticketId: input.ticketId, projectId: input.projectId, ...(input.converted ? { converted: true } : {}) }),
    });
  } catch {
    return { ok: false, status: 0, error: "Couldn't reach the server — check your connection and try again." };
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false, status: res.status,
      error: typeof j.error === "string" && j.error ? j.error : `The change was not saved (HTTP ${res.status}).`,
      ...(j.code === "not_migrated" ? { notMigrated: true } : {}),
    };
  }
  return {
    ok: true,
    projectId: typeof j.projectId === "string" ? j.projectId : null,
    ...(typeof j.warning === "string" && j.warning ? { warning: j.warning } : {}),
    ...(j.unchanged === true ? { unchanged: true } : {}),
  };
}
