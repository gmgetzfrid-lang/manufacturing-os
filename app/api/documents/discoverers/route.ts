// /api/documents/discoverers — NEDGE-6 done-when 3 (notifications Round G,
// N9): the server-side discover check for one document and a list of people,
// for a notifier that runs in the browser (emit() mostly does). The answer is
// lib/documentDiscoverers.ts discoverersOfDocument: who among `uids` may
// DISCOVER the document over its full library → folders → document chain,
// with the effective owner and the controller tier.
//
// Who may ask: an active member of the org, and only about a document their
// OWN session can read (the documents RLS — node_visible and the ACL —
// answers that through a client carrying their token). A document the caller
// cannot see is answered as if it did not exist (404), so the route never
// confirms a hidden document's existence or names who can see it to someone
// who cannot. What it answers is only the subset of the people the caller
// sent — the recipients the caller is already about to notify.
//
// Read-only; it writes nothing and records nothing.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerScopedClient } from "@/lib/serverAuth";
import { discoverersOfDocument, DISCOVERERS_MAX_UIDS } from "@/lib/documentDiscoverers";

export const runtime = "nodejs";

const bad = (error: string, status = 400) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Not authenticated", 401);

  let body: { orgId?: unknown; documentId?: unknown; uids?: unknown };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  const documentId = typeof body.documentId === "string" ? body.documentId.trim() : "";
  const uids = Array.isArray(body.uids)
    ? [...new Set((body.uids as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))]
    : null;
  if (!orgId || !documentId || uids === null) return bad("orgId, documentId and uids are required");
  if (uids.length > DISCOVERERS_MAX_UIDS) return bad(`Ask about up to ${DISCOVERERS_MAX_UIDS} people per call (got ${uids.length}).`);

  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members").select("uid").eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (memberErr) return bad("Couldn't confirm your membership — try again.", 503);
  if (!member) return bad("Not an active member of this organization.", 403);

  // Only a document the caller's own session can read (RLS decides).
  const caller = callerScopedClient(req);
  if ("error" in caller) return bad(caller.error, caller.status);
  const { data: seen, error: seenErr } = await caller.from("documents").select("id").eq("org_id", orgId).eq("id", documentId).maybeSingle();
  if (seenErr) return bad("Couldn't read the document — try again.", 503);
  if (!seen) return bad("No such document in this organization.", 404);

  const answer = await discoverersOfDocument({ orgId, documentId, uids });
  if (!answer.ok) return bad(answer.error, answer.status);
  return NextResponse.json(
    { discover: answer.discover, withheld: answer.withheld, ...(answer.brokenChain ? { brokenChain: true } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
