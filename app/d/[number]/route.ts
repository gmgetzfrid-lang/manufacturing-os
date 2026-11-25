// /d/[number] — document short links.
//
// Typeable from a title block, pasteable in an email, printable next to a
// QR: yourdomain/d/2002-D-10001 resolves the drawing number (punctuation-
// and case-forgiving, same normalization as search) and redirects into the
// viewer deep link. The target page enforces auth + RLS as always.
//
// The lookup runs on the service-role client, so it is limited to the
// caller's own active workspaces, and only a signed-in caller (bearer token)
// gets one. A plain browser visit carries no session (the app keeps it in
// browser storage, not cookies), so it goes to the documents page with the
// number pre-searched: that search runs as the user, under RLS, and a
// stranger learns nothing about any workspace.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

/** The signed-in caller's active workspaces, from a bearer token. None (or
 *  no valid token) means no lookup at all. */
async function callerOrgIds(req: NextRequest): Promise<string[]> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return [];
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(auth.slice(7));
  if (error || !user) return [];
  const { data: members } = await supabaseAdmin
    .from("org_members").select("org_id")
    .eq("uid", user.id).eq("status", "active");
  return [...new Set(((members ?? []) as Array<{ org_id: string | null }>)
    .map((m) => m.org_id).filter((id): id is string => !!id))];
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ number: string }> },
) {
  const { number } = await ctx.params;
  const raw = decodeURIComponent(number ?? "").trim();
  const norm = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const home = new URL("/documents", req.url);
  if (norm.length < 2 || norm.length > 40) return NextResponse.redirect(home);
  const searchPage = () => {
    const dest = new URL("/documents", req.url);
    dest.searchParams.set("q", raw);
    return NextResponse.redirect(dest);
  };

  const orgIds = await callerOrgIds(req);
  if (orgIds.length === 0) return searchPage();

  // Candidates by loose substring, then the exact normalized match wins
  // (same punctuation-forgiving identity search uses); newest update first.
  const { data: rows } = await supabaseAdmin
    .from("documents")
    .select("id, library_id, document_number, updated_at")
    .in("org_id", orgIds)
    .filter("document_number", "not.is", null)
    .ilike("document_number", `%${raw.replace(/[%_]/g, "")}%`)
    .order("updated_at", { ascending: false })
    .limit(25);

  const match = ((rows ?? []) as Array<{ id: string; library_id: string; document_number: string | null }>)
    .find((r) => (r.document_number ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "") === norm)
    ?? (rows ?? [])[0] as { id: string; library_id: string } | undefined;

  // No match — land on the documents page with the number pre-searched.
  if (!match) return searchPage();
  const dest = new URL(`/documents/${match.library_id}`, req.url);
  dest.searchParams.set("doc", match.id);
  return NextResponse.redirect(dest);
}
