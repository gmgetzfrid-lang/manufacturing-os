// /api/links/invalidate — publish-time proposal sweep (LNK-1 / LNK-11).
//
// POST { documentId } → retires the PENDING link proposals touching that
// document whose evidence was read from a revision other than the one it
// carries NOW. Called by lib/postPublish.ts after every publish path.
//
// The sweep used to run in the publisher's browser under proposed_links
// RLS, which only the proposal-writer tier passes — a library-granted or
// owner publisher staled nothing, silently. It now runs on the service role,
// org-scoped, after the caller is verified:
//   * the caller is signed in and can READ the document (their own RLS
//     session resolves it — a document they cannot see is a 404, so the
//     route says nothing about it);
//   * the caller is an active member of the document's org;
//   * the revision compared against is the document's current one, read
//     here — never a value the client sends — so the call can only ever
//     retire proposals that really are stale. It is idempotent.
// A retired ('stale') proposal is not a dismissal: the next "Find
// connections" run re-derives it from the new text and it re-enters the
// queue (DEC-55).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerScopedClient } from "@/lib/serverAuth";
import { invalidateProposalsForRevision } from "@/lib/linkProposerServer";

export const runtime = "nodejs";

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
    .from("documents").select("id, org_id, rev").eq("id", documentId).maybeSingle();
  if (docErr) return bad(docErr.message, 500);
  if (!doc) return bad("Document not found", 404);
  const { org_id: orgId, rev } = doc as { org_id: string; rev: string | null };

  const { data: member } = await supabaseAdmin
    .from("org_members").select("status")
    .eq("org_id", orgId).eq("uid", userData.user.id).maybeSingle();
  if ((member as { status?: string } | null)?.status !== "active") return bad("Not permitted", 403);

  const res = await invalidateProposalsForRevision(supabaseAdmin, { orgId, documentId, newRev: rev });
  if (res.error) {
    console.warn("[links/invalidate] sweep failed", { documentId, error: res.error });
    return bad(res.error, 500);
  }
  return NextResponse.json({ staled: res.staled });
}
