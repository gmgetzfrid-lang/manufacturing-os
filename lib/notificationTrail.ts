// lib/notificationTrail.ts
//
// TRAIL-4 (notifications Round G, N9): visiting the thing a notification is
// about marks that notification read — the rule the ticket page has had
// since the cold-trail audit (app/(protected)/requests/[id]/page.tsx: opening
// a ticket marks its rows read), now for a document (the library page's
// ?doc= deep link, which every row click and every document selection goes
// through) and for a project (its detail page).
//
// What it changes: read_at on the signed-in member's OWN unread rows about
// that one resource (resource_type + resource_id) — the column 20261161's
// read_at-only rule lets a recipient change, nothing else. The bell, the
// sidebar badge and the Center refetch on the UPDATE (the attention hook
// subscribes to the member's notification rows), so the count drops without
// "Mark all read". An obligation is not discharged by it: the acknowledgment,
// the sign-off and the review stay on /inbox and the document's own panel,
// exactly as when the row is clicked in the bell today (the row click marks
// it read before navigating — TRAIL-4's verifier note).
//
// Best-effort: never throws, never blocks the page; a refusal or a failure
// is logged and answers 0.

import { supabase } from "@/lib/supabase";

export type TrailResourceType = "document" | "project";

/** Mark the member's unread notifications about one resource read. Answers
 *  how many rows the database marked (0 when none was unread, when the call
 *  was refused, or when it could not run). */
export async function markResourceNotificationsRead(input: {
  uid: string | null | undefined;
  resourceType: TrailResourceType;
  resourceId: string | null | undefined;
}): Promise<number> {
  if (!input.uid || !input.resourceId) return 0;
  try {
    const { data, error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() })
      .eq("user_id", input.uid)
      .eq("resource_type", input.resourceType)
      .eq("resource_id", input.resourceId)
      .is("read_at", null)
      .select("id");
    if (error) {
      console.warn(`[notificationTrail] the ${input.resourceType}'s notifications were not marked read (non-blocking)`, error.message);
      return 0;
    }
    const marked = ((data as Array<{ id: string }> | null) ?? []).length;
    return marked;
  } catch (e) {
    console.warn(`[notificationTrail] the ${input.resourceType}'s notifications were not marked read (non-blocking)`, (e as Error)?.message ?? e);
    return 0;
  }
}
