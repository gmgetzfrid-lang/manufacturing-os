// lib/ask/orchestratorHandler.ts — the document controller you can talk to.
//
// Served by /api/orchestrator (plain JSON) and /api/chat/ask (streamed,
// persisted). Input { orgId, question, approved?: string[] } →
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

import { ok, fail, type AskHandlerInput, type AskHandlerResult } from "@/lib/ask/types";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { loadOrgInstructionsBlock } from "@/lib/aiInstructionsServer";
import { loadAnswerSkillsBlock } from "@/lib/answerSkillsServer";
import { atlasForPrompt } from "@/lib/featureAtlas";
import { callAiModel, AiCallError, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, estimateCostUsd, AGREEMENT_VERSION, buildAgreementText } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { runOrchestrator, type ModelCall } from "@/lib/orchestrator/loop";
import type { ToolContext } from "@/lib/orchestrator/tools";
import { fetchAllRows } from "@/lib/fetchAllRows";

/** Wall clock for the loop. Comfortably inside maxDuration so the run always
 *  gets to write its metering row and return prose rather than being killed. */
const LOOP_BUDGET_MS = 75_000;

const bad = fail;

export async function handleOrchestrator(input: AskHandlerInput): Promise<AskHandlerResult> {
  const { user, emit } = input;
  const extraSystem = input.extraSystem ?? "";
  const userImages = input.userImages ?? [];
  const priorTurns = (input.priorTurns ?? []).slice(-4);
  const body = input.body as { orgId?: string; question?: string; approved?: unknown };
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
      return {
        status: 428,
        json: {
          error: "Before your first question, read and accept the AI acceptable-use agreement.",
          agreementRequired: true,
          agreementText: buildAgreementText(provider),
          agreementVersion: AGREEMENT_VERSION,
        },
      };
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
    (await loadAnswerSkillsBlock(supabaseAdmin, orgId, user.id)) +
    atlasForPrompt() +
    extraSystem +
    (userImages.length > 0
      ? `\n\nASKER ATTACHMENTS: ${userImages.length} image${userImages.length === 1 ? "" : "s"} attached ` +
        "by the asker for this question (a photo, a marked-up drawing, a screenshot, or PDF pages). " +
        "Read them as context — e.g. a tag on a nameplate photo is the tag to look up."
      : "");

  // The conversation so far rides on the question, so "what about the other
  // exchanger?" has an antecedent. Bounded: four turns, answers abridged.
  const conversationBlock = priorTurns.length > 0
    ? "CONVERSATION SO FAR (the question may refer back to it):\n" +
      priorTurns.map((t) => `Q: ${t.question.slice(0, 500)}\nA: ${t.answer.slice(0, 900)}`).join("\n---\n") +
      "\n\n"
    : "";

  const call: ModelCall = async (system, userTurn) => {
    // Stream the turn to the client ONLY once it is clearly prose. A tool
    // call is JSON, which the reader never needs to watch being typed; the
    // first dozen characters decide. Each turn starts the client buffer over.
    let buffered = "";
    let decided: "prose" | "json" | null = null;
    let announced = false;
    const onDelta = (text: string) => {
      if (decided === "json") return;
      if (decided === "prose") { emit({ t: "delta", text }); return; }
      buffered += text;
      const head = buffered.trimStart();
      if (head.length < 12) return;
      if (head.startsWith("{") || head.startsWith("```")) { decided = "json"; return; }
      decided = "prose";
      if (!announced) { emit({ t: "reset" }); announced = true; }
      emit({ t: "delta", text: buffered });
    };
    const out = await callAiModel({
      provider, model, apiKey, system, user: conversationBlock + userTurn,
      maxTokens: 2000,
      // Bound each turn so one slow call can't eat the whole loop budget.
      timeoutMs: 30_000,
      ...(userImages.length > 0 ? { images: userImages } : {}),
      onDelta,
    });
    // A short prose turn that never crossed the threshold still shows.
    if (decided === null && !out.text.trimStart().startsWith("{")) {
      emit({ t: "reset" });
      emit({ t: "delta", text: out.text });
    }
    return { text: out.text, usage: out.usage };
  };

  const ctx: ToolContext = { orgId, userId: user.id, role, approved };

  let run;
  try {
    run = await runOrchestrator({
      question, ctx, call, playbook, budgetMs: LOOP_BUDGET_MS,
      onStep: (step) => emit({ t: "status", text: describeStep(step.tool, step.parameters) }),
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
      // Paged — a single read stops at 1,000 rows.
      const all = <T,>(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) =>
        fetchAllRows<T>(build, 50_000).then((r) => ({ data: r.rows }));
      const [{ data: ctrlDocs }, { data: kDocs }, { data: exDocs }] = await Promise.all([
        all<{ id: string; document_number: string | null; title: string | null; library_id: string | null }>((from, to) => supabaseAdmin.from("documents")
          .select("id, document_number, title, library_id")
          .eq("org_id", orgId).eq("ai_excluded", false).neq("status", "Archived").order("id").range(from, to)),
        all<{ id: string; name: string; library_id: string; source_document_id: string | null }>((from, to) => supabaseAdmin.from("knowledge_documents")
          .select("id, name, library_id, source_document_id")
          .eq("org_id", orgId).neq("status", "retired").order("id").range(from, to)),
        all<{ id: string }>((from, to) => supabaseAdmin.from("documents").select("id")
          .eq("org_id", orgId).eq("ai_excluded", true).order("id").range(from, to)),
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

  return ok({
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

/** Plain-language status line for a tool step, shown while the loop runs. */
function describeStep(tool: string, parameters: Record<string, unknown>): string {
  const p = (k: string) => (parameters[k] !== undefined ? String(parameters[k]) : "");
  switch (tool) {
    case "find_documents": return `Looking up documents — "${p("query")}"`;
    case "search_documents": return `Searching document text — "${p("query")}"`;
    case "query_equipment_by_unit": return `Listing equipment in ${p("unit_name")}`;
    case "equipment_mentions": return `Finding where ${p("tag")} is mentioned`;
    case "check_permissions": return "Checking your access";
    case "check_audit_history": return `Checking the audit history of ${p("sheet_number")}`;
    case "trace_pid_lines": return p("end_tag") ? `Tracing ${p("start_tag")} → ${p("end_tag")}` : `Tracing around ${p("start_tag")}`;
    case "checkout_document": return "Preparing a checkout proposal";
    case "notify_personnel": return "Preparing a notification";
    case "log_audit_completion": return "Preparing an audit record";
    default: return `Running ${tool}`;
  }
}
