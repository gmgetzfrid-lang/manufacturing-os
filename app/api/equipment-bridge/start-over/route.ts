// POST /api/equipment-bridge/start-over - start the equipment over from the
// drawings. Admin only; everything it changes is audited (audit_logs).
//
//   { orgId, action: "preview", keepEdited? }        → what would change
//   { orgId, action: "run", planKey, keepEdited? }   → do exactly that (409
//                                                       with a new preview
//                                                       when the list changed)
//   { orgId, action: "reread", runId }               → match every read sheet
//                                                       again; call while left > 0
//
// lib/equipmentStartOverServer does the work with the service role, only
// after the caller is checked here.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireMember } from "@/lib/estate/serverAuth";
import { previewStartOver, runStartOver, rereadDrawings, PlanChanged } from "@/lib/equipmentStartOverServer";

export const runtime = "nodejs";
export const maxDuration = 60;

/** An Admin of this org (role, or Admin among the member's roles). */
async function requireAdmin(req: NextRequest, orgId: string) {
  const auth = await requireMember(req, orgId);
  if (auth.error) return auth;
  if (auth.caller!.role === "Admin") return auth;
  const { data } = await supabaseAdmin.from("org_members").select("roles").eq("org_id", orgId).eq("uid", auth.caller!.userId).maybeSingle();
  const roles = (data as { roles?: string[] | null } | null)?.roles ?? [];
  if (Array.isArray(roles) && roles.includes("Admin")) return auth;
  return { error: { status: 403, message: "Only admins can start the equipment over." } };
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: { orgId?: string; action?: string; planKey?: string; keepEdited?: boolean; runId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }
  const orgId = String(body.orgId ?? "");
  const auth = await requireAdmin(req, orgId);
  if (auth.error) return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  const actor = { userId: auth.caller!.userId, name: auth.caller!.email };
  try {
    if (body.action === "run") {
      if (!body.planKey) return NextResponse.json({ error: "Look at the preview first." }, { status: 400 });
      return NextResponse.json(await runStartOver(supabaseAdmin, orgId, { planKey: String(body.planKey), keepEdited: body.keepEdited === true, actor }));
    }
    if (body.action === "reread") {
      const runId = String(body.runId ?? "").slice(0, 80) || `start-over-${new Date().toISOString().slice(0, 16)}`;
      return NextResponse.json(await rereadDrawings(supabaseAdmin, orgId, { runId, actor, deadlineMs: t0 + 45_000 }));
    }
    return NextResponse.json(await previewStartOver(supabaseAdmin, orgId, { keepEdited: body.keepEdited === true }));
  } catch (e) {
    if (e instanceof PlanChanged) return NextResponse.json({ error: e.message, preview: e.preview }, { status: 409 });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
