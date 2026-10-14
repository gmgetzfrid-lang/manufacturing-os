// /api/orchestrator — the document controller you can talk to.
//
// POST { orgId, question, approved?: string[] } →
//   { answer, steps, pending, provider, model, budget }
//
// The engine lives in lib/ask/orchestratorHandler.ts so the chat shell can
// drive it over a stream (/api/chat/ask). This route is the plain-JSON face.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { handleOrchestrator } from "@/lib/ask/orchestratorHandler";
import { noopEmit } from "@/lib/ask/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Expected JSON body" }, { status: 400 }); }

  const result = await handleOrchestrator({ user: { id: user.id }, body, emit: noopEmit });
  return NextResponse.json(result.json, { status: result.status });
}
