// POST /api/knowledge/feedback — thumbs-up/down on an answer.
//
// The rating lands on the answer's knowledge_questions row; the ask route's
// proven-ground pass then pulls the cited pages of 👍 answers into future
// similar questions. This is the entire "gets smarter with use" loop:
// deterministic, inspectable, no model retraining involved.
//
// Only the asker may rate their own answer — a rating is a personal
// verdict, and it steers everyone's retrieval, so it must come from the
// person who actually judged the answer against reality.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return bad("Unauthorized", 401);

  let body: { questionId?: string; rating?: number; reasons?: unknown; note?: unknown };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const questionId = String(body.questionId ?? "").trim();
  const rating = Number(body.rating);
  if (!questionId) return bad("questionId is required");
  if (rating !== 1 && rating !== -1 && rating !== 0) return bad("rating must be 1, -1, or 0");

  const { data: row } = await supabaseAdmin
    .from("knowledge_questions").select("id, user_id")
    .eq("id", questionId).maybeSingle();
  if (!row) return bad("Answer not found", 404);
  if (row.user_id !== user.id) return bad("You can only rate your own answers", 403);

  // What went wrong, in the same terms the answer tests check — so a
  // thumbs-down says where to look, not just that something did.
  const reasons = Array.isArray(body.reasons)
    ? body.reasons.filter((r): r is string => typeof r === "string" && /^[a-z_]{3,30}$/.test(r)).slice(0, 8) : null;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : null;
  const update: Record<string, unknown> = { rating: rating === 0 ? null : rating, rated_at: rating === 0 ? null : new Date().toISOString() };
  if (reasons !== null || note !== null) { update.feedback_reasons = reasons; update.feedback_note = note || null; }
  let { error: upErr } = await supabaseAdmin.from("knowledge_questions").update(update).eq("id", questionId);
  if (upErr && /feedback_/i.test(upErr.message)) {
    // Reasons need the newer migration; the rating itself still saves.
    ({ error: upErr } = await supabaseAdmin.from("knowledge_questions")
      .update({ rating: update.rating, rated_at: update.rated_at }).eq("id", questionId));
  }
  if (upErr) {
    if (/rating|rated_at|column/i.test(upErr.message)) {
      return bad("Feedback requires migration 20261013_answer_feedback.sql — run it in Supabase.", 409);
    }
    return bad(upErr.message, 500);
  }
  return NextResponse.json({ ok: true });
}
