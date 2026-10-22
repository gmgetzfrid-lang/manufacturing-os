// lib/ask/askTraceServer.ts — SERVER-ONLY: saving the research record.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { AskHandlerInput, AskHandlerResult } from "@/lib/ask/types";
import { AskTrace, engineVersion } from "@/lib/ask/askTrace";

export { AskTrace };

/** One row per answer in knowledge_ask_traces. A database without the table
 *  (migration not yet run) simply keeps no records. */
export async function saveAskTrace(input: AskHandlerInput, trace: AskTrace, result: AskHandlerResult): Promise<string | null> {
  const body = input.body as { orgId?: unknown; libraryId?: unknown; question?: unknown };
  const orgId = typeof body.orgId === "string" ? body.orgId : "";
  const libraryId = typeof body.libraryId === "string" ? body.libraryId : null;
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return null;
  const json = result.json as { questionId?: unknown; error?: unknown; citations?: unknown };
  const evalRunId = input.evalRun?.runId ?? null;
  const { data, error } = await supabaseAdmin.from("knowledge_ask_traces").insert({
    org_id: orgId,
    library_id: libraryId && /^[0-9a-f-]{36}$/i.test(libraryId) ? libraryId : null,
    user_id: input.user.id,
    question_id: typeof json.questionId === "string" ? json.questionId : null,
    eval_run_id: evalRunId,
    question: String(body.question ?? "").slice(0, 2000),
    status: result.status,
    error: typeof json.error === "string" ? json.error.slice(0, 500) : null,
    engine_version: engineVersion(),
    trace: trace.toJSON(),
  }).select("id").maybeSingle();
  if (error) return null;
  return (data?.id as string | undefined) ?? null;
}
