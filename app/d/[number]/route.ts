// /d/[number] — document short links.
//
// Typeable from a title block, pasteable in an email, printable next to a
// QR: yourdomain/d/2002-D-10001 hands the drawing number to the documents
// page, which resolves it CLIENT-SIDE under the caller's own session — so
// org scoping and the document ACL are enforced by RLS, exactly as they are
// for every other document view.
//
// This route performs NO database lookup and holds NO service-role client:
// an earlier version resolved the number here with the admin client and no
// org filter, which turned an unauthenticated GET into a cross-tenant
// existence/UUID oracle (audit finding EGRESS-2). It now only forwards the
// raw string; a signed-out caller lands on the protected documents route and
// is sent to sign-in, learning nothing about whether the number exists.

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ number: string }> },
) {
  const { number } = await ctx.params;
  const raw = decodeURIComponent(number ?? "").trim();
  const dest = new URL("/documents", req.url);
  // Bounds only — no lookup. The documents page decides what (if anything)
  // this resolves to, under the caller's own RLS.
  const norm = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (norm.length >= 2 && norm.length <= 40) dest.searchParams.set("d", raw);
  return NextResponse.redirect(dest);
}
