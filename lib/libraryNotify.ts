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
// inserted at least one row) and, since notifications N9 (PROD-5 dw2), the
// staged-upload path (app/(protected)/documents/[libraryId]/page.tsx
// handleStagedUpload, which passes the member's email) — so a third insert
// path has one call to make.
//
// The actor is named the way the staged-upload closure names them — by the
// signed-in member's email (RoleContext's userEmail). A caller that passes no
// name (the CSV import: the library page hands the modal a uid alone) gets
// the actor's email in this org from org_members, then their display name;
// "Someone" only when neither is known (N8's final review fix — every CSV
// import used to read "Someone added …").
//
// NEDGE-22 (notifications N16): a notice that names ONE document carries its
// id (`firstDocumentId`, passed by both callers), and the dispatcher tells the
// name only to a follower who may discover it; the others read "New document
// added". A notice about several documents names none, as before.
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
  /** NEDGE-22 (notifications N16): the id of the document `firstLabel`
   *  names. With count 1 the notice names that document, so a follower who
   *  may not discover it reads the notice without the name (the
   *  dispatcher's discover check, DEC-106). Absent with count 1: the notice
   *  names no document to anyone — nothing to check it against (fail safe:
   *  a notice without the name, never a name unchecked). */
  firstDocumentId?: string | null;
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
    // NEDGE-22 (notifications N16): with one document the notice names it.
    // The name goes only to a follower who may discover that document (the
    // dispatcher's check, namesDocuments); the others read UNNAMED. With no
    // id to check against, nobody reads the name. A batch of several names
    // none (as before).
    const unnamed = { title: "New document added", body: `${name ?? "Someone"} added a document to a library you subscribe to.` };
    const namesOne = count === 1 && !!input.firstDocumentId;
    await emit({
      orgId,
      category: "watched",
      kind: "library_doc_added",
      title: count === 1 ? (namesOne ? `New document: ${firstLabel}` : unnamed.title) : `${count} new documents added`,
      body: count === 1 ? (namesOne ? `${name ?? "Someone"} added ${firstLabel} to a library you subscribe to.` : unnamed.body) : `${name ?? "Someone"} added ${count} documents to a library you subscribe to.`,
      link: `/documents/${libraryId}`,
      resource: { type: "library", id: libraryId },
      actorUserId,
      actorName: name ?? "someone",
      audience: { followers: true },
      channels: ["inapp"],
      ...(namesOne ? { namesDocuments: { ids: [input.firstDocumentId as string], unnamed } } : {}),
    });
  } catch (e) {
    console.warn("[libraryNotify] the library followers' notice was not sent (non-blocking)", e);
  }
}

/** NEDGE-22 (notifications N16): what a staged upload's notice names — the
 *  FIRST staged file (`staged[0]`): its label (its document number, else its
 *  original name, else "document") and, only when THAT file landed, the id
 *  its document got (`landedIds`, keyed by the file's index in `staged`).
 *  The label and the id always describe the same file: when the first file
 *  failed while another landed, the id is null, so the notice names no
 *  document (notifyLibraryDocsAdded's rule) — never another file's id, which
 *  would run the discover check against a document the title does not name.
 *  Pure; the library page's handleStagedUpload calls it. */
export function firstNoticeTarget(
  staged: ReadonlyArray<{ docNumber?: string | null; original?: string | null }>,
  landedIds: ReadonlyMap<number, string>,
): { label: string; id: string | null } {
  const first = staged[0];
  const label = first?.docNumber || first?.original || "document";
  return { label, id: (first && landedIds.get(0)) || null };
}
