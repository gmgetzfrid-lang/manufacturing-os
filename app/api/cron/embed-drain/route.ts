// GET/POST /api/cron/embed-drain — background continuation of meaning-index
// builds, so a 25,000-passage library doesn't depend on a browser tab
// surviving for hours. Auth + budget here; the drain loop lives in
// lib/knowledgeEmbedDrain (shared with the daily maintenance cron).
//
// TRIGGERS — either alone suffices:
//   - the daily maintenance cron calls drainEmbedBacklog directly
//     (NOT a vercel.json cron of its own: a third/hourly cron entry fails
//     every deployment on this plan — see lib/knowledgeEmbedDrain.ts)
//   - a fire-and-forget nudge from the knowledge library page on load, so
//     merely opening the app advances the index for up to ~4 minutes
//
// Auth: CRON_SECRET bearer (server-to-server) OR a signed-in user — a user
// trigger drains only the orgs they belong to.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { drainEmbedBacklog } from "@/lib/knowledgeEmbedDrain";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Whole-run budget: stop starting new work at 240s so every library's last
 *  slice commits and the response returns inside maxDuration. */
const RUN_BUDGET_MS = 240_000;

async function handle(req: NextRequest) {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const cronSecret = process.env.CRON_SECRET || "";

  // Who may trigger: a server holding the secret, or a signed-in member
  // (scoped to their own workspaces).
  let scopeOrgIds: string[] | null = null; // null = all orgs
  if (!cronSecret || bearer !== cronSecret) {
    if (!bearer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(bearer);
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: memberships } = await supabaseAdmin
      .from("org_members").select("org_id")
      .eq("uid", user.id).eq("status", "active");
    scopeOrgIds = ((memberships ?? []) as Array<{ org_id: string }>).map((m) => m.org_id);
    if (scopeOrgIds.length === 0) return NextResponse.json({ drained: [] });
  }

  const out = await drainEmbedBacklog({ scopeOrgIds, budgetMs: RUN_BUDGET_MS });
  return NextResponse.json(out);
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
