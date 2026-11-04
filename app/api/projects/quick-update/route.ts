// POST /api/projects/quick-update - Update by note: read a supervisor's
// field note into proposed step updates. READ-ONLY: nothing is saved here.
// The app checks every line (lib/quickUpdate) and the person saves.
//
// The steps come from the person's own schedule (sent by the page, which
// already holds it); the call runs on the person's own AI key, under the
// org's cap and metering (lib/ai/governedCall).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { QUICK_SYSTEM, quickUserPrompt, parseReply } from "@/lib/quickUpdate";

export const runtime = "nodejs";
export const maxDuration = 90;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const MAX_NOTE = 6_000;
const MAX_CATALOG = 160_000;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; projectId?: string; note?: string; catalog?: string; now?: number; tz?: string; shift?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim(), projectId = (body.projectId ?? "").trim();
  const note = (body.note ?? "").trim(), catalog = body.catalog ?? "";
  const tz = (body.tz ?? "").trim(), now = Number(body.now);
  if (!orgId || !projectId) return bad("orgId and projectId required", 400);
  if (!note) return bad("Say or type what happened first.", 400);
  if (note.length > MAX_NOTE) return bad("That note is too long - split it into a few.", 413);
  if (!catalog || catalog.length > MAX_CATALOG) return bad("The schedule didn't come through - reload the page.", 400);
  if (!tz || !Number.isFinite(now)) return bad("The time didn't come through - reload the page.", 400);
  // The page's clock: a phone set to the wrong day would put every time wrong.
  if (Math.abs(now - Date.now()) > 15 * 60_000) return bad("This device's clock is off by more than 15 minutes. Fix the phone's time, then try again.", 409);

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

  let text: string;
  try {
    const out = await governedAiCall({
      orgId, userId, op: "quickUpdate",
      system: QUICK_SYSTEM,
      user: quickUserPrompt({ note, catalog, now, tz, shift: (body.shift ?? "").slice(0, 300) }),
      maxTokens: 4_000,
      timeoutMs: 75_000,
    });
    text = out.text;
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    return bad(`The AI didn't answer: ${(e as Error).message}`, 502);
  }
  const block = extractJsonBlock(text);
  let parsed: unknown;
  try { parsed = block ? JSON.parse(block) : null; } catch { parsed = null; }
  if (!parsed) return bad("Couldn't read the AI's answer. Try again, or say it a different way.", 422);
  return NextResponse.json(parseReply(parsed));
}
