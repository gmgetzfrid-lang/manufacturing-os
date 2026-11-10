// POST /api/projects/next-plan - "Tell the schedule": read a planner's
// instruction into changes to the suggested schedule. READ-ONLY: nothing is
// saved here; the page shows what the changes do and the person keeps them.
// Runs on the person's own AI key, under the org's cap (lib/ai/governedCall).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { TALK_SYSTEM } from "@/lib/nextPlanTalk";

export const runtime = "nodejs";
export const maxDuration = 90;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  let body: { orgId?: string; projectId?: string; text?: string; catalog?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim(), projectId = (body.projectId ?? "").trim();
  const text = (body.text ?? "").trim(), catalog = body.catalog ?? "";
  if (!orgId || !projectId) return bad("orgId and projectId required", 400);
  if (!text) return bad("Say what to change first.", 400);
  if (text.length > 2000) return bad("That's too long - say one or two things at a time.", 413);
  if (!catalog || catalog.length > 160_000) return bad("The schedule didn't come through - reload the page.", 400);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const userId = userData.user.id;
  const [{ data: member }, { data: project }] = await Promise.all([
    supabaseAdmin.from("org_members").select("status").eq("org_id", orgId).eq("uid", userId).maybeSingle(),
    supabaseAdmin.from("projects").select("id").eq("id", projectId).eq("org_id", orgId).maybeSingle(),
  ]);
  if (!member || (member as { status?: string }).status !== "active") return bad("Not a member of this workspace.", 403);
  if (!project) return bad("Project not found.", 404);

  let reply: string;
  try {
    const out = await governedAiCall({ orgId, userId, op: "nextPlan", system: TALK_SYSTEM, user: `THE SCHEDULE\n${catalog}\n\nWHAT THEY SAID\n${text}`, maxTokens: 3_000, timeoutMs: 80_000 });
    reply = out.text;
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    return bad(`The AI didn't answer: ${(e as Error).message}`, 502);
  }
  const block = extractJsonBlock(reply);
  let parsed: unknown;
  try { parsed = block ? JSON.parse(block) : null; } catch { parsed = null; }
  if (!parsed) return bad("Couldn't read the AI's answer. Try saying it a different way.", 422);
  return NextResponse.json(parsed);
}
