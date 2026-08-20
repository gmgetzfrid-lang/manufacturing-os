// /api/orchestrator — the document controller you can talk to.
//
// POST { orgId, question, approved?: string[] } →
//   { answer, steps, pending, provider, model, budget }
//
// Everything the knowledge ask route enforces, this enforces too, because it
// spends the same money on the same key: per-user BYO key, the acceptable-use
// agreement, the monthly cap checked BEFORE the first provider call, and one
// metering row per run. The only difference is what happens in the middle —
// instead of one retrieval and one answer, the model drives a tool loop.
//
// `approved` carries fingerprints the user ticked in the UI. It is the ONLY
// way a write tool executes, and it is scoped to the run it's sent with: an
// approval is for a specific action with specific parameters, not a standing
// permission to act.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { loadOrgInstructionsBlock } from "@/lib/aiInstructionsServer";
import { loadAnswerSkillsBlock } from "@/lib/answerSkillsServer";
import { callAiModel, AiCallError, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, estimateCostUsd, AGREEMENT_VERSION, buildAgreementText } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { runOrchestrator, type ModelCall } from "@/lib/orchestrator/loop";
import type { ToolContext } from "@/lib/orchestrator/tools";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Wall clock for the loop. Comfortably inside maxDuration so the run always
 *  gets to write its metering row and return prose rather than being killed. */
const LOOP_BUDGET_MS = 75_000;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; question?: string; approved?: unknown };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const question = String(body.question ?? "").trim().slice(0, 2000);
  if (!orgId || !question) return bad("orgId and question are required");

  // Approvals arrive as opaque fingerprints. They're only ever compared, never
  // parsed, so a forged one can at worst approve an action the model didn't
  // propose — and the tool still re-checks role and org before it acts.
  const approved = new Set(
    Array.isArray(body.approved)
      ? body.approved.filter((a): a is string => typeof a === "string").slice(0, 20)
      : [],
  );

  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, role")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member) return bad("Not a member of this workspace", 403);
  const role = (member.role as string) ?? "Viewer";

  // ── Same key policy as every other AI surface: the asker's own. ──────────
  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("user_id, provider, model, api_key")
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  const usable = !!conn && ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId);
  if (!usable) {
    return bad(
      conn
        ? "Your saved key uses a blocked provider — only Anthropic (Claude) and OpenAI are allowed. "
          + "Save a Claude or OpenAI key in AI settings."
        : "You haven't added your API key yet — every member uses their own. Add a Claude or "
          + "OpenAI key in AI settings first.",
      412,
    );
  }
  const provider = conn.provider as AiProviderId;
  const model = conn.model as string;
  const apiKey = openAiKey(conn.api_key as string);

  {
    const { data: agree, error: agreeError } = await supabaseAdmin
      .from("ai_key_agreements").select("id")
      .eq("org_id", orgId).eq("user_id", user.id)
      .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION)
      .limit(1);
    const tableMissing = !!agreeError
      && (agreeError.code === "42P01" || /does not exist/i.test(agreeError.message));
    if (!tableMissing && (agree ?? []).length === 0) {
      return NextResponse.json({
        error: "Before your first question, read and accept the AI acceptable-use agreement.",
        agreementRequired: true,
        agreementText: buildAgreementText(provider),
        agreementVersion: AGREEMENT_VERSION,
      }, { status: 428 });
    }
  }

  const [monthSoFar, capUsd] = await Promise.all([
    getMonthUsage(orgId, user.id),
    getCapUsd(orgId, user.id),
  ]);
  if (capUsd > 0 && monthSoFar.spentUsd >= capUsd) {
    return bad(
      `Monthly AI budget reached — you've used $${monthSoFar.spentUsd.toFixed(2)} of your `
      + `$${capUsd.toFixed(2)} cap. It resets on the 1st; an Admin can raise the cap in AI settings.`,
      402,
    );
  }

  const playbook =
    (await loadOrgInstructionsBlock(supabaseAdmin, orgId, "knowledge")) +
    (await loadAnswerSkillsBlock(supabaseAdmin, orgId, user.id));

  const call: ModelCall = async (system, userTurn) => {
    const out = await callAiModel({
      provider, model, apiKey, system, user: userTurn,
      maxTokens: 2000,
      // Bound each turn so one slow call can't eat the whole loop budget.
      timeoutMs: 30_000,
    });
    return { text: out.text, usage: out.usage };
  };

  const ctx: ToolContext = { orgId, userId: user.id, role, approved };

  let run;
  try {
    run = await runOrchestrator({
      question, ctx, call, playbook, budgetMs: LOOP_BUDGET_MS,
    });
  } catch (e) {
    // runOrchestrator resolves on provider errors, so reaching here means a
    // genuine bug. Meter nothing and say so rather than billing for a crash.
    const message = e instanceof AiCallError ? e.message : "The assistant failed to run.";
    return bad(message, e instanceof AiCallError ? e.status : 500);
  }

  await recordAskUsage({
    orgId, userId: user.id, provider, model,
    usage: run.usage, ok: !run.stoppedBecause, op: "orchestrator",
  });

  // Show-me chips: every document the answer NAMES becomes a click — the
  // same designation squash-match the knowledge ask route uses. Checked
  // against the doc-control registry first (number, then title), then the
  // knowledge libraries (mirrors of AI-excluded documents skipped). An
  // answer citing "EP 5-6-2" with nothing to click is a dead end.
  const mentionedDocs: Array<{ id: string; number: string | null; title: string; mention: string; openUrl: string }> = [];
  try {
    const squash = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const designations = [...new Set(run.answer.match(/\b[A-Za-z]{1,8}[- ]?\d+(?:[-.]\d+)*[A-Za-z]?\b/g) ?? [])].slice(0, 24);
    if (designations.length > 0) {
      const [{ data: ctrlDocs }, { data: kDocs }, { data: exDocs }] = await Promise.all([
        supabaseAdmin.from("documents")
          .select("id, document_number, title, library_id")
          .eq("org_id", orgId).eq("ai_excluded", false).neq("status", "Archived").limit(3000),
        supabaseAdmin.from("knowledge_documents")
          .select("id, name, library_id, source_document_id")
          .eq("org_id", orgId).limit(3000),
        supabaseAdmin.from("documents").select("id")
          .eq("org_id", orgId).eq("ai_excluded", true).limit(2000),
      ]);
      const excludedSrc = new Set(((exDocs ?? []) as Array<{ id: string }>).map((r) => r.id));
      const seen = new Set<string>();
      for (const m of designations) {
        const key = squash(m);
        if (key.length < 4 || seen.has(key)) continue;
        seen.add(key);
        const ctrl = ((ctrlDocs ?? []) as Array<Record<string, unknown>>).find((d) => {
          const num = squash(String(d.document_number ?? ""));
          const title = squash(String(d.title ?? ""));
          return (num.length >= 4 && num.includes(key)) || (key.length >= 5 && title.includes(key));
        });
        if (ctrl) {
          mentionedDocs.push({
            id: String(ctrl.id), number: (ctrl.document_number as string | null) ?? null,
            title: String(ctrl.title ?? ""), mention: m,
            openUrl: `/documents/${ctrl.library_id}?doc=${ctrl.id}`,
          });
        } else {
          const kd = ((kDocs ?? []) as Array<Record<string, unknown>>).find((d) =>
            !excludedSrc.has(String(d.source_document_id ?? "")) && squash(String(d.name ?? "")).includes(key));
          if (kd) {
            mentionedDocs.push({
              id: String(kd.id), number: null, title: String(kd.name ?? ""), mention: m,
              openUrl: `/knowledge/${kd.library_id}?doc=${kd.id}&page=1`,
            });
          }
        }
        if (mentionedDocs.length >= 12) break;
      }
    }
  } catch { /* chips are decoration — never block the answer */ }

  return NextResponse.json({
    answer: run.answer,
    steps: run.steps,
    pending: run.pending,
    stoppedBecause: run.stoppedBecause ?? null,
    ...(mentionedDocs.length > 0 ? { mentionedDocs } : {}),
    provider, model,
    budget: {
      spentUsd: Math.round((monthSoFar.spentUsd + estimateCostUsd(model, run.usage)) * 100) / 100,
      capUsd,
    },
  });
}
