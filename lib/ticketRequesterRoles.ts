// lib/ticketRequesterRoles.ts
//
// drafting-flow Round G, DF-P9 TICKET-PAGE — FRIC-7: the requesters' CURRENT
// role collections, for the attention badge.
//
// The workflow route and the ticket page give the engine the requester's
// current collection (DEC-16 / WF-24): an active member's held roles, or `[]`
// when the requester is no longer an active member — and then the engine
// requires a co-reviewer to act on their behalf (`requesterCanAct` false,
// lib/workflow.ts). The badge had no such input, so a departed requester's
// review was required on the page and counted by no badge (an under-count:
// it could stall unseen by everyone who works from the badge).
//
// One batched read of the active members among the tickets' requesters, in
// slices (a PostgREST `in` list travels in the URL). The answer holds EVERY
// requester asked about: an active member's held roles, or `[]` for one the
// read did not return (not an active member). A requester it was not asked
// about is absent — unknown, assumed present (lib/ticketAttention.ts
// requesterRolesFor). A read that fails returns null — "unknown" for all, so
// nothing invents a departure — and the badge then evaluates as it did
// before (every requester assumed present). Read only; no writes.

import { supabase } from "@/lib/supabase";
import { heldRoles } from "@/lib/roleHeld";

/** Requester ids per `in` read (the repo's URL budget, as the create route's
 *  SOURCE_READ_CHUNK). */
export const REQUESTER_ROLES_CHUNK = 100;

type Client = Pick<typeof supabase, "from">;

/** Each requester's held roles (headline + collection) when they are an
 *  ACTIVE member of `orgId`, else `[]` — one entry per id asked about; null
 *  when the members could not be read. Ids are de-duplicated; blanks
 *  dropped. */
export async function loadRequesterRoles(
  orgId: string,
  requesterIds: ReadonlyArray<string | null | undefined>,
  client: Client = supabase,
): Promise<Map<string, string[]> | null> {
  const ids = Array.from(new Set(requesterIds.filter((v): v is string => typeof v === "string" && v.trim() !== "")));
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += REQUESTER_ROLES_CHUNK) {
      const slice = ids.slice(i, i + REQUESTER_ROLES_CHUNK);
      const { data, error } = await client
        .from("org_members")
        .select("uid, role, roles")
        .eq("org_id", orgId)
        .eq("status", "active")
        .in("uid", slice);
      if (error) return null;
      for (const row of (data ?? []) as Array<{ uid?: unknown; role?: unknown; roles?: unknown }>) {
        if (typeof row.uid === "string") out.set(row.uid, heldRoles(row));
      }
    }
    for (const id of ids) if (!out.has(id)) out.set(id, []);
    return out;
  } catch {
    return null;
  }
}
