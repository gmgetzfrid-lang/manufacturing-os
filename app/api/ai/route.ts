// /api/ai — server-side proxy for the AI provider.
//
// Why this exists: the Gemini SDK and the GEMINI_API_KEY env var are
// server-only. Client components can't talk to the SDK directly
// without leaking the API key to every visitor of the site. This
// route is the seam — clients POST { op, payload } and the server
// runs the real provider, returning the result as JSON.
//
// Auth: requires a Supabase bearer token (same pattern as the
// storage routes). No role check beyond "signed-in user" — the AI
// surfaces are non-mutating and a logged-in member can already see
// the source content these calls summarize.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { geminiProvider } from "@/lib/ai/geminiProvider";
import { mockProvider } from "@/lib/ai/mockProvider";
import type { BriefContext, ScheduleBrief } from "@/lib/ai/types";

type Op =
  | "summarize"
  | "extractEntities"
  | "suggestFollowups"
  | "generateHandoff"
  | "analyzeNote"
  | "briefMe"
  | "clarifySchedule"
  | "generateSchedule";
const VALID_OPS: Op[] = [
  "summarize", "extractEntities", "suggestFollowups",
  "generateHandoff", "analyzeNote", "briefMe",
  "clarifySchedule", "generateSchedule",
];

export async function POST(req: NextRequest) {
  // 1. Auth check
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = authHeader.slice(7);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Validate payload
  let body: { op?: string; payload?: { text?: string; ctx?: BriefContext; brief?: ScheduleBrief }; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const op = body.op as Op;
  // Back-compat: older clients send { text } at the top level.
  const text = body.payload?.text ?? body.text;
  const ctx = body.payload?.ctx;
  const brief = body.payload?.brief;
  if (!VALID_OPS.includes(op)) {
    return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
  }

  // 3. Pick the real provider when the key is configured, mock when
  //    it isn't. The route itself degrades gracefully — a client
  //    asking for "gemini" still gets a useful response if the
  //    server isn't configured.
  const provider = process.env.GEMINI_API_KEY ? geminiProvider : mockProvider;
  const isReal = provider === geminiProvider;

  try {
    let result: unknown;
    switch (op) {
      case "summarize":
        if (typeof text !== "string") return NextResponse.json({ error: "text required" }, { status: 400 });
        result = await provider.summarize(text); break;
      case "extractEntities":
        if (typeof text !== "string") return NextResponse.json({ error: "text required" }, { status: 400 });
        result = await provider.extractEntities(text); break;
      case "suggestFollowups":
        if (typeof text !== "string") return NextResponse.json({ error: "text required" }, { status: 400 });
        result = await provider.suggestFollowups(text); break;
      case "generateHandoff":
        if (typeof text !== "string") return NextResponse.json({ error: "text required" }, { status: 400 });
        result = await provider.generateHandoff(text); break;
      case "analyzeNote":
        if (typeof text !== "string") return NextResponse.json({ error: "text required" }, { status: 400 });
        result = await provider.analyzeNote(text); break;
      case "briefMe":
        if (!ctx) return NextResponse.json({ error: "ctx required" }, { status: 400 });
        result = await provider.briefMe(ctx); break;
      case "clarifySchedule":
        if (!brief) return NextResponse.json({ error: "brief required" }, { status: 400 });
        result = await provider.clarifySchedule(brief); break;
      case "generateSchedule":
        if (!brief) return NextResponse.json({ error: "brief required" }, { status: 400 });
        result = await provider.generateSchedule(brief); break;
    }
    return NextResponse.json({ result, provider: provider.name, isReal });
  } catch (e) {
    console.error("[api/ai] provider error:", e);
    return NextResponse.json(
      { error: "AI provider failed", provider: provider.name, isReal },
      { status: 502 },
    );
  }
}

export async function GET() {
  const configured = !!process.env.GEMINI_API_KEY;
  return NextResponse.json({
    configured,
    provider: configured ? geminiProvider.name : mockProvider.name,
    isReal: configured,
  });
}
