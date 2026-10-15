// POST /api/estate/discovered — equipment read off a drawing by mistake.
//   { orgId, action: "list" }            → suspects, with the text each came from
//   { orgId, action: "remove", ids[] }   → remove those still suspect (re-checked)
// Document control only.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { findSuspects, removeSuspects } from "@/lib/estate/discoveredServer";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; action?: string; ids?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId, ["Admin", "DocCtrl"]);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  try {
    if (body.action === "remove") {
      const wanted = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 2000) : [];
      return NextResponse.json(await removeSuspects(supabaseAdmin, orgId, wanted, { userId: auth.caller!.userId, name: auth.caller!.email }));
    }
    return NextResponse.json(await findSuspects(supabaseAdmin, orgId));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
