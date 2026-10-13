// lib/sentNotices.ts
//
// The notices a member SENT, read back (notifications Round G, N9 — OS-6,
// TAX-16). A member reads only the rows addressed to them
// (notifications_own_select), so a nudge or a heads-up they sent could not be
// read back from any browser: "already sent" lived in one tab's state or one
// browser's storage, and a refresh or another device offered the button
// again. notifications_i_sent() (20261191, SECURITY DEFINER) answers, for an
// active member of the org, the rows THEY wrote of two kinds only — the
// edit-overlap heads-up (overlap_advisory) and the /checkouts coordination
// nudge (checkout_conflict) — recipient, resource and time, within 30 days.
//
// Before 20261191 is pasted the function does not exist (42883 / PGRST202):
// the read answers `available: false` and every caller keeps today's path
// (its own per-browser memory). A read that fails for another reason answers
// the same, with the error, so nothing is ever read as "never sent" from a
// failure.

import { supabase } from "@/lib/supabase";

/** The kinds notifications_i_sent() answers for — any other answers no rows. */
export type SentNoticeKind = "overlap_advisory" | "checkout_conflict";

export interface SentNotice {
  userId: string;
  resourceType: string | null;
  resourceId: string | null;
  /** Epoch ms. */
  at: number;
}

export type SentNoticesRead =
  | { available: true; rows: SentNotice[] }
  | { available: false; reason: "not_deployed" | "error"; error?: string };

/** notifications_i_sent() is not deployed yet: PostgREST PGRST202, or
 *  Postgres 42883 naming it. */
export function isMissingSentNotices(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "PGRST202") return true;
  return err.code === "42883" && /notifications_i_sent/.test(err.message ?? "");
}

/** The notices of `kind` the signed-in member sent in `orgId` since `since`
 *  (ISO; the database never looks back more than 30 days), optionally about
 *  one resource or carrying a metadata marker. Never throws. */
export async function readNoticesISent(input: {
  orgId: string;
  kind: SentNoticeKind;
  since: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<SentNoticesRead> {
  try {
    const { data, error } = await supabase.rpc("notifications_i_sent", {
      p_org: input.orgId,
      p_kind: input.kind,
      p_since: input.since,
      p_resource_type: input.resourceType ?? null,
      p_resource_id: input.resourceId ?? null,
      p_metadata: input.metadata ?? null,
    });
    if (error) {
      if (isMissingSentNotices(error)) return { available: false, reason: "not_deployed" };
      return { available: false, reason: "error", error: error.message };
    }
    const rows = ((data as Array<{ user_id: string; resource_type: string | null; resource_id: string | null; created_at: string }> | null) ?? [])
      .map((r) => ({ userId: String(r.user_id), resourceType: r.resource_type ?? null, resourceId: r.resource_id ?? null, at: Date.parse(r.created_at) }))
      .filter((r) => Number.isFinite(r.at));
    return { available: true, rows };
  } catch (e) {
    return { available: false, reason: "error", error: (e as Error)?.message ?? String(e) };
  }
}
