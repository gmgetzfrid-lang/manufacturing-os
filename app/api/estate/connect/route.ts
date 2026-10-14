// POST /api/estate/connect — one pass of "Connect everything": units, read
// library + sources, indexing, registry, links. Document control only; the
// browser calls it again while `more` is true and reads the queued copies
// with the caller's own AI key in between.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { connectEverything } from "@/lib/estate/connectServer";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; libraryIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId, ["Admin", "DocCtrl"]);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  try {
    const status = await connectEverything(supabaseAdmin, {
      orgId, libraryIds: Array.isArray(body.libraryIds) ? body.libraryIds.map(String) : undefined,
      actor: { userId: auth.caller!.userId, name: auth.caller!.email }, budgetMs: 40_000,
    });
    return NextResponse.json(status);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
