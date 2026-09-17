// GET /api/share/list?documentId=<id> — a document's share links, listed by
// the server under the CALLER's own read decision (EGRESS-8).
//
// document_shares' SELECT policy used to admit any active member of the row's
// org, so a member denied read on a restricted drawing could still enumerate
// its live share tokens through PostgREST and fetch /api/share/file?token=….
// The listing now happens here, with the service role, and applies the same
// read decision the share routes enforce for a share's CREATOR
// (lib/knowledgeAccess — the single ACL truth):
//   * the caller can read the document → every row, tokens included;
//   * the caller cannot → only the rows the caller created come back, and
//     with NO token. They minted it, but it no longer serves (the /api/share/*
//     routes re-check the creator's current authority), so the only use left
//     is revoking it by id — which needs no token.
// Fails CLOSED: an unreadable decision (lookup error) is "cannot read".
// 20261066 states the same rule at the database for direct PostgREST reads.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";

export const runtime = "nodejs";

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  const documentId = (req.nextUrl.searchParams.get("documentId") ?? "").trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(documentId)) return bad("documentId is required", 400);

  const { data: doc } = await supabaseAdmin
    .from("documents")
    .select("id, org_id")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) return bad("Document not found", 404);
  const orgId = doc.org_id as string;

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not an active member of this document's organization", 403);

  // The caller's read decision on THIS document. Controllers read everything
  // (node_visible's short-circuit); everyone else goes through the ACL chain.
  let readable = false;
  try {
    readable = principal.isController || (await readableControlledDocIds(principal, [documentId])).has(documentId);
  } catch {
    readable = false;
  }

  const { data: rows, error } = await supabaseAdmin
    .from("document_shares")
    .select("*")
    .eq("document_id", documentId)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error) return bad("Failed to load share links", 500);

  const all = (rows ?? []) as Array<Record<string, unknown>>;
  const shares = readable
    ? all
    : all.filter((r) => r.created_by === user.id).map((r) => ({ ...r, token: null }));
  return NextResponse.json({ readable, shares });
}
