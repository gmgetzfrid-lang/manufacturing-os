// /api/knowledge/eval — answer tests for a library (document controllers).
//
//   GET  ?orgId&libraryId           → { cases, runs, results (latest run) }
//   GET  ?orgId&libraryId&runId     → that run's results
//   POST { action: "saveCase", orgId, libraryId, id?, question, expect, tags?, status?, notes?, sourceQuestionId? }
//   POST { action: "deleteCase", orgId, id }
//   POST { action: "startRun", orgId, libraryId, caseIds?, tag?, costCapUsd? } → { run, caseIds }
//   POST { action: "runCase", orgId, runId, caseId }   → one case asked and scored
//   POST { action: "stopRun" | "setBaseline", orgId, runId }
//
// Runs ask on the caller's own AI key and count against their monthly cap,
// like any question; each run also stops at its own dollar limit.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  cleanExpect, libraryDocuments, runCase, startRun, recordOutcome, type EvalCase,
} from "@/lib/eval/evalServer";

export const runtime = "nodejs";
export const maxDuration = 120;

const UUID = /^[0-9a-f-]{36}$/i;
const bad = (msg: string, status = 400) => NextResponse.json({ error: msg }, { status });
const missingTables = (m?: string) => /knowledge_eval|does not exist|schema cache/i.test(m ?? "");
const MIGRATION = "Answer tests need migration 20261025_answer_tests.sql - run it in Supabase.";

async function authController(req: NextRequest, orgId: string) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ") || !UUID.test(orgId)) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return null;
  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, role, roles, display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (!member) return null;
  const roles = new Set<string>([member.role as string, ...((member.roles as string[]) ?? [])]);
  if (!roles.has("Admin") && !roles.has("DocCtrl")) return null;
  return { userId: user.id, name: (member.display_name as string) || (member.email as string) || "Member" };
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") ?? "";
  const libraryId = req.nextUrl.searchParams.get("libraryId") ?? "";
  const runId = req.nextUrl.searchParams.get("runId") ?? "";
  const who = await authController(req, orgId);
  if (!who) return bad("Answer tests are for document controllers (Admin or DocCtrl).", 403);
  if (!UUID.test(libraryId)) return bad("libraryId is required");

  const [cases, runs] = await Promise.all([
    supabaseAdmin.from("knowledge_eval_cases").select("*")
      .eq("org_id", orgId).eq("library_id", libraryId).neq("status", "archived")
      .order("created_at", { ascending: true }).limit(500),
    supabaseAdmin.from("knowledge_eval_runs").select("*")
      .eq("org_id", orgId).eq("library_id", libraryId)
      .order("created_at", { ascending: false }).limit(20),
  ]);
  if (cases.error) return bad(missingTables(cases.error.message) ? MIGRATION : cases.error.message, missingTables(cases.error.message) ? 409 : 500);
  const runList = (runs.data ?? []) as Array<{ id: string; is_baseline: boolean }>;
  const shown = UUID.test(runId) ? runId : runList[0]?.id;
  const baseline = runList.find((r) => r.is_baseline && r.id !== shown)?.id;
  const resultsFor = async (id?: string) => id
    ? ((await supabaseAdmin.from("knowledge_eval_results").select("*").eq("run_id", id).limit(1000)).data ?? [])
    : [];
  const [results, baselineResults] = await Promise.all([resultsFor(shown), resultsFor(baseline)]);
  return NextResponse.json({
    cases: cases.data ?? [], runs: runList, results, runId: shown ?? null,
    baseline: baseline ? { runId: baseline, results: baselineResults.map((r) => ({ case_id: r.case_id, pass: r.pass })) } : null,
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "");
  const who = await authController(req, orgId);
  if (!who) return bad("Answer tests are for document controllers (Admin or DocCtrl).", 403);
  const action = String(body.action ?? "");

  try {
    if (action === "saveCase") {
      let libraryId = String(body.libraryId ?? "");
      const question = String(body.question ?? "").trim().slice(0, 2000);
      // From under an answer, the library is the one the answer came from.
      if (!UUID.test(libraryId) && typeof body.sourceQuestionId === "string" && UUID.test(body.sourceQuestionId)) {
        const { data: src } = await supabaseAdmin.from("knowledge_questions").select("library_id")
          .eq("id", body.sourceQuestionId).eq("org_id", orgId).maybeSingle();
        libraryId = (src?.library_id as string | undefined) ?? "";
      }
      if (!UUID.test(libraryId) || !question) return bad("libraryId and question are required");
      const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().slice(0, 30)).filter(Boolean).slice(0, 8) : [];
      const status = body.status === "draft" || body.status === "archived" ? body.status : "active";
      const row = {
        org_id: orgId, library_id: libraryId, question, expect: cleanExpect(body.expect), tags, status,
        notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : null,
        source_question_id: typeof body.sourceQuestionId === "string" && UUID.test(body.sourceQuestionId) ? body.sourceQuestionId : null,
        updated_at: new Date().toISOString(),
      };
      const id = typeof body.id === "string" && UUID.test(body.id) ? body.id : null;
      const res = id
        ? await supabaseAdmin.from("knowledge_eval_cases").update(row).eq("id", id).eq("org_id", orgId).select("*").single()
        : await supabaseAdmin.from("knowledge_eval_cases").insert({ ...row, created_by: who.userId, created_by_name: who.name }).select("*").single();
      if (res.error) return bad(missingTables(res.error.message) ? MIGRATION : res.error.message, missingTables(res.error.message) ? 409 : 500);
      return NextResponse.json({ case: res.data });
    }

    if (action === "deleteCase") {
      const id = String(body.id ?? "");
      if (!UUID.test(id)) return bad("id is required");
      await supabaseAdmin.from("knowledge_eval_cases").update({ status: "archived", updated_at: new Date().toISOString() }).eq("id", id).eq("org_id", orgId);
      return NextResponse.json({ ok: true });
    }

    if (action === "startRun") {
      const libraryId = String(body.libraryId ?? "");
      if (!UUID.test(libraryId)) return bad("libraryId is required");
      const cap = Number(body.costCapUsd);
      const out = await startRun(orgId, libraryId, who.userId, who.name, {
        caseIds: Array.isArray(body.caseIds) ? body.caseIds.filter((x): x is string => typeof x === "string") : undefined,
        tag: typeof body.tag === "string" && body.tag ? body.tag : undefined,
        costCapUsd: Number.isFinite(cap) && cap > 0 ? Math.min(cap, 100) : 5,
      });
      return NextResponse.json(out);
    }

    if (action === "runCase") {
      const runId = String(body.runId ?? ""), caseId = String(body.caseId ?? "");
      if (!UUID.test(runId) || !UUID.test(caseId)) return bad("runId and caseId are required");
      const [{ data: run }, { data: c }] = await Promise.all([
        supabaseAdmin.from("knowledge_eval_runs").select("*").eq("id", runId).eq("org_id", orgId).maybeSingle(),
        supabaseAdmin.from("knowledge_eval_cases").select("*").eq("id", caseId).eq("org_id", orgId).maybeSingle(),
      ]);
      if (!run || !c) return bad("Run or case not found", 404);
      if (run.status !== "running") return NextResponse.json({ skipped: true, run });
      const docs = await libraryDocuments(orgId, (c as EvalCase).library_id);
      const outcome = await runCase(who.userId, runId, c as EvalCase, docs);
      await recordOutcome(runId, c as EvalCase, outcome);
      const { data: after } = await supabaseAdmin.from("knowledge_eval_runs").select("*").eq("id", runId).single();
      return NextResponse.json({ caseId, pass: outcome.pass, checks: outcome.checks, error: outcome.error, costUsd: outcome.costUsd, run: after });
    }

    if (action === "stopRun" || action === "setBaseline") {
      const runId = String(body.runId ?? "");
      if (!UUID.test(runId)) return bad("runId is required");
      if (action === "stopRun") {
        await supabaseAdmin.from("knowledge_eval_runs").update({ status: "stopped", stop_reason: `Stopped by ${who.name}.`, finished_at: new Date().toISOString() })
          .eq("id", runId).eq("org_id", orgId).eq("status", "running");
      } else {
        const { data: run } = await supabaseAdmin.from("knowledge_eval_runs").select("library_id").eq("id", runId).eq("org_id", orgId).maybeSingle();
        if (!run) return bad("Run not found", 404);
        await supabaseAdmin.from("knowledge_eval_runs").update({ is_baseline: false }).eq("org_id", orgId).eq("library_id", run.library_id);
        await supabaseAdmin.from("knowledge_eval_runs").update({ is_baseline: true }).eq("id", runId);
      }
      return NextResponse.json({ ok: true });
    }

    return bad(`Unknown action "${action}"`);
  } catch (e) {
    const m = (e as Error).message;
    return bad(missingTables(m) ? MIGRATION : m, missingTables(m) ? 409 : 500);
  }
}
