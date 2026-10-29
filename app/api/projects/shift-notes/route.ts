// POST /api/projects/shift-notes — draft the hour-by-hour shift notes.
//
// The browser sends the shift's entries as prompt lines (lib/shiftHourly
// hourlyPrompt: the same time log the Excel export carries) and gets back
// the model's lines. READ-ONLY: nothing is saved here — the report checks
// every line against the entries, shows it as a draft, and saves it to the
// shift's record when the person keeps it.
//
// Runs on the caller's own key through governedAiCall (agreement, monthly
// cap, metering), as the "shiftNotes" op — on the Shift notes job's model
// (AI settings; lib/ai/jobModels jobDefault when none is picked).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { AiCallError } from "@/lib/ai/providerCall";
import { HOURLY_SYSTEM } from "@/lib/shiftHourly";

export const runtime = "nodejs";
export const maxDuration = 90;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const MAX_PROMPT = 60_000;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; projectId?: string; prompt?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim();
  const projectId = (body.projectId ?? "").trim();
  const prompt = String(body.prompt ?? "").trim();
  if (!orgId || !projectId) return bad("orgId and projectId required", 400);
  if (!prompt) return bad("Nothing was entered on this shift to write notes from.", 400);
  if (prompt.length > MAX_PROMPT) return bad("Too many entries on one shift to write in one go.", 413);

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

  try {
    const out = await governedAiCall({
      orgId, userId, op: "shiftNotes",
      system: HOURLY_SYSTEM,
      user: prompt,
      maxTokens: 3000,
      timeoutMs: 75_000,
    });
    return NextResponse.json({ text: out.text, usage: out.usage, model: out.model });
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    if (e instanceof AiCallError) return bad(e.message, e.status);
    return bad(`Couldn't write the notes: ${(e as Error).message}`, 502);
  }
}
