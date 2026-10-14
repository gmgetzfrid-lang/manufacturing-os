// /api/knowledge/ask — the question-answering seam for knowledge libraries.
//
// POST { orgId, libraryId, question, mode?, focus?, inputs?, history?, threadId? }
//   → { answer, citations, provider, model, mode, … }
//
// The engine lives in lib/ask/knowledgeAskHandler.ts so the chat shell can
// drive the same pipeline over a stream (/api/chat/ask). This route is the
// plain-JSON face of it: authenticate, parse, run, respond.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { handleKnowledgeAsk } from "@/lib/ask/knowledgeAskHandler";
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

  const result = await handleKnowledgeAsk({ user: { id: user.id }, body, emit: noopEmit });
  return NextResponse.json(result.json, { status: result.status });
}
