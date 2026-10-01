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
//
// A cut-off answer is never ratable (ASK-3, intelligence Round G I-03): the
// ask route gives it no questionId, and a rating POSTed for it by id is
// refused (409) — the row says so in context.partial, or, on a database
// before 20261153, by the cut-off line its answer ends with. Clearing a
// rating (0) is always allowed.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { CUT_OFF_LINE } from "@/lib/knowledgeAskGuards";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return bad("Unauthorized", 401);

  let body: { questionId?: string; rating?: number };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const questionId = String(body.questionId ?? "").trim();
  const rating = Number(body.rating);
  if (!questionId) return bad("questionId is required");
  if (rating !== 1 && rating !== -1 && rating !== 0) return bad("rating must be 1, -1, or 0");

  const readRow = (cols: string) => supabaseAdmin
    .from("knowledge_questions").select(cols)
    .eq("id", questionId).maybeSingle();
  let read = await readRow("id, user_id, answer, context");
  // A database before 20261153 has no context column: the cut-off line decides.
  if (read.error && /context/.test(read.error.message ?? "")) read = await readRow("id, user_id, answer");
  const row = read.data as { id: string; user_id: string; answer?: string | null; context?: { partial?: unknown } | null } | null;
  if (!row) return bad("Answer not found", 404);
  if (row.user_id !== user.id) return bad("You can only rate your own answers", 403);
  if (rating !== 0 && (row.context?.partial === true || String(row.answer ?? "").includes(CUT_OFF_LINE))) {
    return bad("A cut-off answer cannot be rated — ask a narrower question for a complete one.", 409);
  }

  const { error: upErr } = await supabaseAdmin
    .from("knowledge_questions")
    .update({ rating: rating === 0 ? null : rating, rated_at: rating === 0 ? null : new Date().toISOString() })
    .eq("id", questionId);
  if (upErr) {
    if (/rating|rated_at|column/i.test(upErr.message)) {
      return bad("Feedback requires migration 20261013_answer_feedback.sql — run it in Supabase.", 409);
    }
    return bad(upErr.message, 500);
  }
  return NextResponse.json({ ok: true });
}
