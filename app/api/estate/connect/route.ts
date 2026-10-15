// POST /api/estate/connect — one pass of "Connect everything": units, read
// library + sources, indexing, registry, links. Document control only; the
// browser calls it again while `more` is true and reads the queued copies
// with the caller's own AI key in between.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { connectEverything, setAutoRead } from "@/lib/estate/connectServer";
import { connectPlan } from "@/lib/estate/connectPlan";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; libraryIds?: string[]; visionAllPages?: boolean; rereadAll?: boolean; runId?: string; action?: string; libraryId?: string; on?: boolean; monthlyPages?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireMember(req, orgId, ["Admin", "DocCtrl"]);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  try {
    if (body.action === "plan") {
      return NextResponse.json(await connectPlan(supabaseAdmin, orgId, auth.caller!.userId, Array.isArray(body.libraryIds) ? body.libraryIds.map(String) : undefined));
    }
    if (body.action === "autoRead") {
      return NextResponse.json(await setAutoRead(supabaseAdmin, {
        orgId, libraryId: String(body.libraryId ?? ""), on: body.on === true,
        monthlyPages: typeof body.monthlyPages === "number" ? body.monthlyPages : undefined,
        actor: { userId: auth.caller!.userId, name: auth.caller!.email },
      }));
    }
    const status = await connectEverything(supabaseAdmin, {
      orgId, libraryIds: Array.isArray(body.libraryIds) ? body.libraryIds.map(String) : undefined,
      actor: { userId: auth.caller!.userId, name: auth.caller!.email }, budgetMs: 40_000,
      visionAllPages: typeof body.visionAllPages === "boolean" ? body.visionAllPages : undefined, rereadAll: !!body.rereadAll,
      runId: body.runId ? String(body.runId).slice(0, 80) : undefined,
    });
    return NextResponse.json(status);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
