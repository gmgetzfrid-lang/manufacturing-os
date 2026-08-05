// /d/[number] — document short links.
//
// Typeable from a title block, pasteable in an email, printable next to a
// QR: yourdomain/d/2002-D-10001 resolves the drawing number (punctuation-
// and case-forgiving, same normalization as search) and redirects into the
// viewer deep link. The target page enforces auth + RLS as always — this
// route only translates a number into a location; it reveals nothing.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ number: string }> },
) {
  const { number } = await ctx.params;
  const raw = decodeURIComponent(number ?? "").trim();
  const norm = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const home = new URL("/documents", req.url);
  if (norm.length < 2 || norm.length > 40) return NextResponse.redirect(home);

  // Candidates by loose substring, then the exact normalized match wins
  // (same punctuation-forgiving identity search uses); newest update first.
  const { data: rows } = await supabaseAdmin
    .from("documents")
    .select("id, library_id, document_number, updated_at")
    .filter("document_number", "not.is", null)
    .ilike("document_number", `%${raw.replace(/[%_]/g, "")}%`)
    .order("updated_at", { ascending: false })
    .limit(25);

  const match = ((rows ?? []) as Array<{ id: string; library_id: string; document_number: string | null }>)
    .find((r) => (r.document_number ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "") === norm)
    ?? (rows ?? [])[0] as { id: string; library_id: string } | undefined;

  if (!match) {
    // No match — land on the documents page with the number pre-searched.
    const dest = new URL("/documents", req.url);
    dest.searchParams.set("q", raw);
    return NextResponse.redirect(dest);
  }
  const dest = new URL(`/documents/${match.library_id}`, req.url);
  dest.searchParams.set("doc", match.id);
  return NextResponse.redirect(dest);
}
