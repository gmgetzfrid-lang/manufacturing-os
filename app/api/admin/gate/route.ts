// /api/admin/gate — SURF-9 / WF-20: the admin layout asks this before it
// renders any /admin/* page.
//
//   GET ?orgId=&surface=<key>  → 200 { allowed: true, surface }   may enter
//                              → 403 { error, surface }           may not
//                              → 503 { error }                    could not verify (FAIL CLOSED)
//                              → 400 unknown surface / 401 no session
//
// The decision is computed here, from the caller's active membership, its
// FULL role collection and — for a capability surface — the org's capability
// policy read with the service client, per-person grants included. The
// client renders the answer; it never computes one.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const surface = req.nextUrl.searchParams.get("surface") || "";
  const actor = await authorizeAdminSurface(req, orgId, surface);
  if ("error" in actor) return NextResponse.json({ error: actor.error, surface }, { status: actor.status });
  return NextResponse.json({ allowed: true, surface: actor.surface.key });
}
