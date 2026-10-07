// lib/libraryNotify.ts
//
// "New documents in a library you watch" — ONE helper for every path that
// inserts documents into a library (notifications PROD-5, N8 PRODUCERS-FREE).
// Extracted verbatim from the staged-upload path's closure
// (app/(protected)/documents/[libraryId]/page.tsx handleStagedUpload
// notifyLibrarySubscribers): kind library_doc_added, category 'watched', the
// same title / body / link / resource, audience = the library's followers
// (WatchButton → subscriptions), the actor dropped by the dispatcher. One
// change, PROD-7 done-when 3: channels ['inapp'] — a bulk import is chatty,
// so a follower's bell carries it and their inbox does not.
//
// Callers: components/documents/CsvImportModal.tsx (after a batch that
// inserted at least one row). The staged-upload page still calls its own
// closure (dual channel); swapping it onto this helper is N9's (after DC P6 /
// IS-P1, which edit that page), so a third insert path has one call to make.
//
// The actor is named the way the staged-upload closure names them — by the
// signed-in member's email (RoleContext's userEmail). A caller that passes no
// name (the CSV import: the library page hands the modal a uid alone) gets
// the actor's email in this org from org_members, then their display name;
// "Someone" only when neither is known (N8's final review fix — every CSV
// import used to read "Someone added …").
//
// Fire-and-forget by contract: never throws, never blocks the import.

import { emit } from "@/lib/notify/dispatch";
import { supabase } from "@/lib/supabase";

export interface LibraryDocsAddedInput {
  orgId: string | null | undefined;
  libraryId: string | null | undefined;
  /** How many documents the batch inserted; 0 notifies nobody. */
  count: number;
  /** The first document's number (or name) — the title when count is 1. */
  firstLabel: string;
  /** The signed-in member who added them (DEC-86 §2: the session's uid). */
  actorUserId: string | null | undefined;
  /** How the notice names them — the staged-upload path passes the
   *  member's email. Absent: looked up (actorEmailInOrg). */
  actorName?: string | null;
}

/** The actor's email in this org, else their display name (org_members) —
 *  the name the staged-upload path's notice uses (the session's email).
 *  null when neither is known; a failed read is never thrown. */
async function actorEmailInOrg(orgId: string, uid: string): Promise<string | null> {
  try {
    const { data } = await supabase.from("org_members").select("email, display_name").eq("org_id", orgId).eq("uid", uid).maybeSingle();
    const row = data as { email?: string | null; display_name?: string | null } | null;
    return row?.email?.trim() || row?.display_name?.trim() || null;
  } catch {
    return null;
  }
}

export async function notifyLibraryDocsAdded(input: LibraryDocsAddedInput): Promise<void> {
  const { orgId, libraryId, count, firstLabel, actorUserId } = input;
  if (!orgId || !libraryId || !actorUserId || !(count > 0)) return;
  try {
    const name = input.actorName || (await actorEmailInOrg(orgId, actorUserId));
    await emit({
      orgId,
      category: "watched",
      kind: "library_doc_added",
      title: count === 1 ? `New document: ${firstLabel}` : `${count} new documents added`,
      body: `${name ?? "Someone"} added ${count === 1 ? firstLabel : `${count} documents`} to a library you subscribe to.`,
      link: `/documents/${libraryId}`,
      resource: { type: "library", id: libraryId },
      actorUserId,
      actorName: name ?? "someone",
      audience: { followers: true },
      channels: ["inapp"],
    });
  } catch (e) {
    console.warn("[libraryNotify] the library followers' notice was not sent (non-blocking)", e);
  }
}
