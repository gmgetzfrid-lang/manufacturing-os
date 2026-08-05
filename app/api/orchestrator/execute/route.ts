// /api/orchestrator/execute — run ONE approved write action, exactly as
// proposed.
//
// The confirm button used to re-run the whole question with the approval
// attached and hope the model reached the same tool with byte-identical
// parameters. If it rephrased anything, the fingerprint never matched and
// the approved action silently never happened — while billing a second full
// model run. This route removes the model from the confirmation entirely:
// the client sends back the stored tool + parameters, and the SAME tool
// handler executes them under the same org/role checks. Deterministic, free,
// and auditable.
//
// POST { orgId, tool, parameters } → { ok, result }

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { toolByName, fingerprint, type ToolContext } from "@/lib/orchestrator/tools";
import { validateParams } from "@/lib/orchestrator/protocol";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; tool?: string; parameters?: unknown };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const toolName = String(body.tool ?? "").trim();
  if (!orgId || !toolName) return bad("orgId and tool are required");
  const rawParams = (body.parameters && typeof body.parameters === "object")
    ? body.parameters as Record<string, unknown>
    : {};

  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, role")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member) return bad("Not a member of this workspace", 403);
  const role = (member.role as string) ?? "Viewer";

  const def = toolByName(toolName);
  if (!def || !def.writes) return bad("That isn't an executable action.", 400);

  const checked = validateParams(rawParams, def.params);
  if (!checked.ok) return bad(checked.error, 400);

  // Pre-approve exactly this action. The tool's own proposal gate sees the
  // fingerprint and executes; every role/org/membership check inside the
  // handler still runs — this route grants confirmation, not authority.
  const ctx: ToolContext = {
    orgId, userId: user.id, role,
    approved: new Set([fingerprint(def.name, checked.values)]),
  };

  let out;
  try {
    out = await def.run(checked.values, ctx);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "The action failed.", 500);
  }

  // A handoff action (href) never executes server-side; the tool re-proposes
  // it no matter what. Tell the client to use the link instead.
  if (out.pending) {
    return bad("This action completes in the app, not here — use its link.", 409);
  }
  const result = (out.data ?? {}) as Record<string, unknown>;
  if (typeof result.error === "string" && result.error) {
    return bad(result.error, 409);
  }

  await supabaseAdmin.from("audit_logs").insert({
    action: "AI_ACTION_EXECUTED",
    resource_type: "orchestrator", resource_id: orgId,
    org_id: orgId, user_id: user.id,
    details: { tool: def.name, parameters: checked.values },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, result });
}
