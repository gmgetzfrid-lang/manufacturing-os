// /api/orchestrator — the document controller you can talk to.
//
// POST { orgId, question } →
//   { answer, steps, pending, provider, model, budget, skills? }
//
// Everything the knowledge ask route enforces, this enforces too, because it
// spends the same money on the same key: per-user BYO key, the acceptable-use
// agreement, the monthly cap checked BEFORE the first provider call, and one
// metering row per run. The only difference is what happens in the middle —
// instead of one retrieval and one answer, the model drives a tool loop.
//
// GOV-13 / ORCH-7: every round of the loop reserves its worst case (its
// prompt at 3 characters a token, 2,000 tokens out) BEFORE it is made —
// refused when it does not fit beside the month's spend and every other
// call in flight — and folds its real tokens into the run's ONE metering
// row (the first round's reservation, settled after every round, so a run
// killed part-way leaves what it spent recorded, never less). The first
// round also carries the in-flight limit: a person runs at most
// ORCHESTRATOR_MAX_IN_FLIGHT assistant runs at once (429 for the next). A
// refusal before the first call is answered with its own status; one
// later stops the run with what it gathered.
//
// A run never executes a write (ORCH-10). Write tools only PROPOSE; each
// proposal is stored server-side for this person (ORCH-4) and runs, once,
// only through /api/orchestrator/execute, which writes AI_ACTION_ATTEMPTED
// before the tool acts and AI_ACTION_EXECUTED / AI_ACTION_FAILED after it.
// There is no in-run approval: an `approved` field in the body is ignored,
// and the tools run with an empty approval set.
//
// IRLS-13: the Reasoning Skills that rode the run's prompt come back as
// `skills` (id, name, builtinKey — the ask route's shape), so the answer
// can say which packs shaped it. No pack, no field.

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { loadOrgInstructionsBlock } from "@/lib/aiInstructionsServer";
import { loadAnswerSkills } from "@/lib/answerSkillsServer";
import { atlasForPrompt } from "@/lib/featureAtlas";
import { callAiModel, AiCallError, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, estimateCostUsd, worstCaseCostUsd, AGREEMENT_VERSION, buildAgreementText } from "@/lib/ai/pricing";
import {
  getMonthUsage, getCapUsd, recordAskUsage, reserveWithinCap, settleUsage, releaseUsage, type UsageReservation,
} from "@/lib/ai/usageServer";
import { GovernedCallError } from "@/lib/ai/gateError";
import { runOrchestrator, type ModelCall } from "@/lib/orchestrator/loop";
import type { ToolContext } from "@/lib/orchestrator/tools";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { storeProposals } from "@/lib/orchestrator/proposals";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Wall clock for the loop. Comfortably inside maxDuration so the run always
 *  gets to write its metering row and return prose rather than being killed. */
const LOOP_BUDGET_MS = 75_000;
/** ORCH-7: assistant runs one person may have in flight at once. */
const ORCHESTRATOR_MAX_IN_FLIGHT = 3;
/** Each round's output ceiling — what its reservation prices. */
const ROUND_MAX_TOKENS = 2000;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; question?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const question = String(body.question ?? "").trim().slice(0, 2000);
  if (!orgId || !question) return bad("orgId and question are required");

  // SURF-7 / EGRESS-3: the caller's ACL principal — role COLLECTION, teams,
  // controller tier — is what every tool filters through. The service-role
  // key fetches; the principal decides what the caller may see or do.
  const [principal, { data: member }] = await Promise.all([
    loadPrincipal(orgId, user.id),
    supabaseAdmin.from("org_members").select("uid, role, display_name, email")
      .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle(),
  ]);
  if (!principal || !member) return bad("Not a member of this workspace", 403);
  const role = principal.role;
  const actorName = ((member.display_name as string | null) || (member.email as string | null)?.split("@")[0] || "A colleague");

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

  const instructionsBlock = await loadOrgInstructionsBlock(supabaseAdmin, orgId, "knowledge");
  const answerSkills = await loadAnswerSkills(supabaseAdmin, orgId, user.id);
  const playbook = instructionsBlock + answerSkills.block + atlasForPrompt();

  // GOV-13 / ORCH-7: reserve each round before it is made; fold every
  // round's real tokens into ONE row per run (the first reservation).
  const runUsage = { inputTokens: 0, outputTokens: 0 };
  let runRow: UsageReservation | null = null;
  const call: ModelCall = async (system, userTurn) => {
    const reservation = await reserveWithinCap({
      orgId, userId: user.id, op: "orchestrator", provider, model,
      worstCaseUsd: worstCaseCostUsd(model, { inputChars: system.length + userTurn.length, maxTokens: ROUND_MAX_TOKENS }),
      capUsd,
      // The run's first round is its admission: at most this many at once.
      maxInFlight: runRow ? undefined : ORCHESTRATOR_MAX_IN_FLIGHT,
    });
    try {
      const out = await callAiModel({
        provider, model, apiKey, system, user: userTurn,
        maxTokens: ROUND_MAX_TOKENS,
        // Bound each turn so one slow call can't eat the whole loop budget.
        timeoutMs: 30_000,
      });
      runUsage.inputTokens += out.usage.inputTokens;
      runUsage.outputTokens += out.usage.outputTokens;
      return { text: out.text, usage: out.usage };
    } catch (e) {
      // A call that failed may still carry what the provider billed (GOV-8).
      const spent = (e as { usage?: { inputTokens?: number; outputTokens?: number } } | null)?.usage;
      if (spent) {
        runUsage.inputTokens += spent.inputTokens ?? 0;
        runUsage.outputTokens += spent.outputTokens ?? 0;
      }
      throw e;
    } finally {
      if (!runRow) runRow = reservation;
      else await releaseUsage(reservation.id);
      await settleUsage(runRow.id, { model, usage: runUsage, ok: true });
    }
  };

  // ORCH-10: nothing is pre-approved in a run — every write tool proposes.
  const ctx: ToolContext = { orgId, userId: user.id, role, approved: new Set<string>(), principal, actorName };

  let run;
  try {
    run = await runOrchestrator({
      question, ctx, call, playbook, budgetMs: LOOP_BUDGET_MS,
    });
  } catch (e) {
    // GOV-13 / ORCH-7: the first round's reservation was refused — the cap
    // (402), the in-flight limit (429) or an unreadable ledger (503) —
    // before any provider call: answered with its own status.
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    // runOrchestrator resolves on provider errors, so reaching here means a
    // genuine bug: say so. What its rounds spent is already on the run's row
    // (settled after every round) — recorded as a failed run.
    const ranRow = runRow as UsageReservation | null;
    if (ranRow) await settleUsage(ranRow.id, { model, usage: runUsage, ok: false });
    const message = e instanceof AiCallError ? e.message : "The assistant failed to run.";
    return bad(message, e instanceof AiCallError ? e.status : 500);
  }

  // The run's ONE metering row: its first round's reservation, settled to
  // every round's tokens. A run that made no call writes the row it always
  // wrote.
  const meteredRow = runRow as UsageReservation | null;
  if (meteredRow) {
    await settleUsage(meteredRow.id, { model, usage: runUsage, ok: !run.stoppedBecause });
  } else {
    await recordAskUsage({
      orgId, userId: user.id, provider, model,
      usage: run.usage, ok: !run.stoppedBecause, op: "orchestrator",
    });
  }

  // ORCH-4: every proposal that executes server-side is stored for THIS
  // user in THIS org with a 15-minute expiry; the card carries its id, and
  // /api/orchestrator/execute runs only the stored row, once. A proposal
  // that could not be stored comes back marked unavailable — never
  // confirmable from what the browser holds.
  const pending = await storeProposals(orgId, user.id, randomUUID(), run.pending);

  // Show-me chips: every document the answer NAMES becomes a click — the
  // same designation squash-match the knowledge ask route uses. Checked
  // against the doc-control registry first (number, then title), then the
  // knowledge libraries (mirrors of AI-excluded documents skipped). An
  // answer citing "EP 5-6-2" with nothing to click is a dead end.
  let mentionedDocs: Array<{ id: string; number: string | null; title: string; mention: string; openUrl: string }> = [];
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
      // SURF-7: the chips are a second read of every document in the org —
      // keep only the controlled documents the CALLER may read (and knowledge
      // mirrors of readable ones). Fails closed.
      try {
        const ctrlIds = mentionedDocs.filter((d) => d.openUrl.startsWith("/documents/")).map((d) => d.id);
        const mirrorIds = mentionedDocs.filter((d) => d.openUrl.startsWith("/knowledge/")).map((d) => d.id);
        const mirrorSrc = new Map<string, string>();
        if (mirrorIds.length > 0) {
          const { data: mirrors } = await supabaseAdmin.from("knowledge_documents").select("id, source_document_id")
            .in("id", mirrorIds).not("source_document_id", "is", null);
          for (const m of (mirrors ?? []) as Array<{ id: string; source_document_id: string }>) mirrorSrc.set(m.id, m.source_document_id);
        }
        const readable = await readableControlledDocIds(principal, [...new Set([...ctrlIds, ...mirrorSrc.values()])]);
        mentionedDocs = mentionedDocs.filter((d) =>
          d.openUrl.startsWith("/documents/") ? readable.has(d.id)
          : !mirrorSrc.has(d.id) || readable.has(mirrorSrc.get(d.id) as string));
      } catch { mentionedDocs = []; }
    }
  } catch { /* chips are decoration — never block the answer */ }

  return NextResponse.json({
    answer: run.answer,
    steps: run.steps,
    pending,
    stoppedBecause: run.stoppedBecause ?? null,
    ...(mentionedDocs.length > 0 ? { mentionedDocs } : {}),
    provider, model,
    budget: {
      spentUsd: Math.round((monthSoFar.spentUsd + estimateCostUsd(model, run.usage)) * 100) / 100,
      capUsd,
    },
    ...(answerSkills.skills.length > 0 ? { skills: answerSkills.skills } : {}),
  });
}
