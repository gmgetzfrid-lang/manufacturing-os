// /api/links/invalidate — publish-time proposal sweep (LNK-1 / LNK-11).
//
// POST { documentId } → retires the PENDING link proposals whose evidence
// was read from THIS document at a revision other than the one it carries
// NOW. Called by lib/postPublish.ts after every publish path.
//
// The sweep used to run in the publisher's browser under proposed_links
// RLS, which only the proposal-writer tier passes — a library-granted or
// owner publisher staled nothing, silently. It now runs on the service role,
// org-scoped, after the caller is verified:
//   * the caller is signed in and can READ the document (their own RLS
//     session resolves it — a document they cannot see is a 404, so the
//     route says nothing about it);
//   * the caller is an active member of the document's org AND could have
//     published it or may already write proposals: the proposal-writer tier
//     (proposed_links_write, 20261046), a publish grant on its library
//     (user_can_publish_on_library), or its effective owner
//     (user_is_effective_owner) — the publish guard's own tiers. A reader
//     cannot empty a document's review queue;
//   * the revision compared against is the document's current one, read
//     here — never a value the client sends — and only proposals whose
//     evidence came from this document are compared with it (the other
//     endpoint's revision is not this document's; see
//     invalidateProposalsForRevision). It is idempotent.
// A retired ('stale') proposal is not a dismissal: the next "Find
// connections" run re-derives it from the new text and it re-enters the
// queue (DEC-55).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerScopedClient } from "@/lib/serverAuth";
import { invalidateProposalsForRevision } from "@/lib/linkProposerServer";
import { memberHoldsAny } from "@/lib/roleHeld";

export const runtime = "nodejs";

/** The tier proposed_links_write admits (20261046, caller_holds_any_role). */
const PROPOSAL_WRITER_ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor"];

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  let body: { documentId?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const documentId = (body.documentId ?? "").trim();
  if (!documentId) return bad("documentId required", 400);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);

  const caller = callerScopedClient(req);
  if ("error" in caller) return bad(caller.error, caller.status);
  const { data: doc, error: docErr } = await caller
    .from("documents").select("id, org_id, rev, library_id, collection_id, owner_user_id")
    .eq("id", documentId).maybeSingle();
  if (docErr) return bad(docErr.message, 500);
  if (!doc) return bad("Document not found", 404);
  const { org_id: orgId, rev, library_id: libraryId, collection_id: collectionId, owner_user_id: ownerId } = doc as {
    org_id: string; rev: string | null; library_id: string | null; collection_id: string | null; owner_user_id: string | null;
  };
  const uid = userData.user.id;

  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles, status")
    .eq("org_id", orgId).eq("uid", uid).maybeSingle();
  const m = member as { role?: unknown; roles?: unknown; status?: string } | null;
  if (m?.status !== "active") return bad("Not permitted", 403);

  // ADD-1: the role COLLECTION; then the publish guard's grant and owner tiers.
  let may = memberHoldsAny(m, PROPOSAL_WRITER_ROLES);
  if (!may && libraryId) {
    const { data: canPublish, error } = await supabaseAdmin.rpc("user_can_publish_on_library", {
      p_library: libraryId, p_uid: uid, p_org: orgId,
    });
    if (error) console.warn("[links/invalidate] publish grant unreadable — treated as no grant", { documentId, error: error.message });
    may = canPublish === true;
  }
  if (!may) {
    const { data: isOwner, error } = await supabaseAdmin.rpc("user_is_effective_owner", {
      p_doc_owner: ownerId, p_collection: collectionId, p_library: libraryId, p_uid: uid,
    });
    if (error) console.warn("[links/invalidate] effective owner unreadable — treated as not the owner", { documentId, error: error.message });
    may = isOwner === true;
  }
  if (!may) return bad("Only someone who can publish this document may retire its proposals", 403);

  const res = await invalidateProposalsForRevision(supabaseAdmin, { orgId, documentId, newRev: rev });
  if (res.error) {
    console.warn("[links/invalidate] sweep failed", { documentId, error: res.error });
    return bad(res.error, 500);
  }
  return NextResponse.json({ staled: res.staled });
}
