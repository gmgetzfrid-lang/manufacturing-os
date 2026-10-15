// POST /api/estate/runs — the AI runs that changed drawings, and undo.
//   { orgId, action: "list" }           → recent runs
//   { orgId, action: "undo", runId }     → put back what that run changed
// Admin and Doc Control only.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { listRuns, undoRun } from "@/lib/estate/runJournal";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; action?: string; runId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId, ["Admin", "DocCtrl"]);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  try {
    if (body.action === "undo") {
      if (!body.runId) return NextResponse.json({ error: "runId is required" }, { status: 400 });
      return NextResponse.json(await undoRun(supabaseAdmin, orgId, String(body.runId), { userId: auth.caller!.userId }));
    }
    return NextResponse.json(await listRuns(supabaseAdmin, orgId));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
