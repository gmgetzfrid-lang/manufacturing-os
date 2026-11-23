// POST /api/share/revoke - turn off a link sent outside the company.
//
//   { orgId, id }
//
// Any active member of the workspace can turn a link off: it only ever
// takes access away. The link stops working at once, for every document on
// it, and the audit log records who did it.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { UUID_RE } from "@/lib/shareLinks";

export const runtime = "nodejs";

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return bad("Sign in again.", 401);
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return bad("The request wasn't readable."); }
  const orgId = String(body.orgId ?? "");
  const id = String(body.id ?? "");
  if (!UUID_RE.test(orgId)) return bad("Which workspace?");
  if (!UUID_RE.test(id)) return bad("Which link?");

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(auth.slice(7));
  if (authErr || !user) return bad("Sign in again.", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("You're not a member of this workspace.", 403);

  const { data: share, error } = await supabaseAdmin.from("document_shares")
    .select("id, org_id, revoked_at, document_id")
    .eq("id", id).eq("org_id", orgId).maybeSingle();
  if (error) return bad(`The link couldn't be read: ${error.message}`, 500);
  if (!share) return bad("That link isn't in this workspace.", 404);
  const s = share as { id: string; revoked_at: string | null; document_id: string };
  if (s.revoked_at) return NextResponse.json({ ok: true, revokedAt: s.revoked_at });

  const revokedAt = new Date().toISOString();
  const { error: upErr } = await supabaseAdmin.from("document_shares")
    .update({ revoked_at: revokedAt, revoked_by: user.id })
    .eq("id", id).eq("org_id", orgId);
  if (upErr) return bad(`The link couldn't be turned off: ${upErr.message}`, 500);

  await supabaseAdmin.from("audit_logs").insert({
    action: "SHARE_LINK_TURNED_OFF",
    resource_type: "document_share", resource_id: id,
    org_id: orgId, user_id: user.id, user_email: user.email ?? null,
    details: { documentId: s.document_id },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, revokedAt });
}
