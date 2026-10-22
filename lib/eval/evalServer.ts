// lib/eval/evalServer.ts — SERVER-ONLY: answer tests for a library.
//
// A test case is a real question an engineer marked with what a right answer
// must do. A run asks every case again, on the asker's own key, with the
// engine running clean (no conversation, no 👍 pages from earlier answers),
// scores each answer with the fixed checks, and keeps the research record so
// a failure says where the right page dropped out.
//
// One case per request: a case is one full ask, and an ask can take a
// minute. The page drives the run case by case, two at a time.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { handleKnowledgeAsk } from "@/lib/ask/knowledgeAskHandler";
import { noopEmit } from "@/lib/ask/types";
import { funnelFor, engineVersion, type TraceStage } from "@/lib/ask/askTrace";
import { runChecks, passed, type CaseExpect, type CheckResult } from "@/lib/eval/checks";
import { docsNamedIn } from "@/lib/ask/designations";

export interface EvalCase {
  id: string; org_id: string; library_id: string; question: string;
  expect: CaseExpect; tags: string[]; status: "draft" | "active" | "archived";
  notes: string | null; source_question_id: string | null;
  created_by_name: string | null; created_at: string;
}

const UUID = /^[0-9a-f-]{36}$/i;

/** Keep only well-formed expectations — the page writes this JSON. */
export function cleanExpect(raw: unknown): CaseExpect {
  const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strs = (v: unknown, max: number) => Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 200)).filter(Boolean).slice(0, max) : [];
  const mustCite = Array.isArray(e.mustCite) ? e.mustCite.flatMap((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const document = typeof o.document === "string" ? o.document.trim().slice(0, 200) : "";
    const page = Number(o.page);
    if (!document || !Number.isInteger(page) || page < 1) return [];
    const tolerance = Number(o.tolerance);
    return [{ document, page, ...(Number.isInteger(tolerance) && tolerance >= 0 && tolerance <= 5 ? { tolerance } : {}) }];
  }).slice(0, 12) : [];
  const termRules = Array.isArray(e.termRules) ? e.termRules.flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const term = typeof o.term === "string" ? o.term.trim().slice(0, 80) : "";
    const mustNotEquate = strs(o.mustNotEquate, 6);
    return term && mustNotEquate.length ? [{ term, mustNotEquate }] : [];
  }).slice(0, 6) : [];
  const askedClass = typeof e.askedClass === "string" && /^\d{3,4}$/.test(e.askedClass) ? e.askedClass : undefined;
  const skip = strs(e.skip, 8) as CaseExpect["skip"];
  return {
    ...(mustCite.length ? { mustCite } : {}),
    ...(strs(e.mustContain, 12).length ? { mustContain: strs(e.mustContain, 12) } : {}),
    ...(strs(e.mustNot, 12).length ? { mustNot: strs(e.mustNot, 12) } : {}),
    ...(askedClass ? { askedClass } : {}),
    ...(termRules.length ? { termRules } : {}),
    ...(skip && skip.length ? { skip } : {}),
  };
}

/** Names of every document a library and the libraries linked to it hold. */
export async function libraryDocuments(orgId: string, libraryId: string): Promise<Array<{ id: string; name: string }>> {
  const { data: links } = await supabaseAdmin
    .from("knowledge_library_links").select("linked_library_id").eq("library_id", libraryId);
  const libIds = [libraryId, ...((links ?? []) as Array<{ linked_library_id: string }>).map((l) => l.linked_library_id)];
  const { rows } = await fetchAllRows<{ id: string; name: string }>((from, to) => supabaseAdmin
    .from("knowledge_documents").select("id, name")
    .eq("org_id", orgId).in("library_id", libIds).neq("status", "retired")
    .order("id").range(from, to), 60_000);
  return rows;
}

export interface CaseOutcome {
  pass: boolean;
  checks: CheckResult[];
  answer: string;
  citations: unknown[];
  costUsd: number;
  traceId: string | null;
  error: string | null;
}

/** Ask one case again and score it. */
export async function runCase(userId: string, runId: string, c: EvalCase, docs: Array<{ id: string; name: string }>): Promise<CaseOutcome> {
  const result = await handleKnowledgeAsk({
    user: { id: userId },
    body: { orgId: c.org_id, libraryId: c.library_id, question: c.question },
    emit: noopEmit,
    evalRun: { runId, caseId: c.id },
  });
  const json = result.json as {
    answer?: string; error?: string; clarification?: { question?: string };
    citations?: Array<{ n: number; documentId: string; documentName: string; page: number; quote?: string; highlight?: string; role?: string }>;
    evalTrace?: { stages: TraceStage[] }; costUsd?: number; traceId?: string | null;
  };
  const costUsd = Number(json.costUsd ?? 0) || 0;
  if (result.status !== 200 || (!json.answer && !json.clarification)) {
    return { pass: false, checks: [], answer: "", citations: [], costUsd, traceId: json.traceId ?? null, error: json.error ?? `HTTP ${result.status}` };
  }
  // A clarifying question instead of an answer is scored as an answer that
  // says only that — a case is written so that it shouldn't need one.
  const answer = json.answer ?? `**Answer:** (asked to clarify) ${json.clarification?.question ?? ""}`;
  const citations = json.citations ?? [];
  const docNames = new Map(docs.map((d) => [d.id, d.name]));
  const stages = json.evalTrace?.stages ?? [];
  const funnel = (c.expect.mustCite ?? []).map((want) => {
    const doc = docsNamedIn(want.document, docs, 1)[0] ?? docs.find((d) => d.name.toLowerCase().includes(want.document.toLowerCase()));
    return funnelFor(stages, { documentId: doc?.id, page: want.page, tolerance: want.tolerance }, docNames, citations);
  });
  const checks = runChecks({
    question: c.question, answer, citations, libraryDocNames: docs.map((d) => d.name), funnel,
  }, c.expect);
  return { pass: passed(checks), checks, answer, citations, costUsd, traceId: json.traceId ?? null, error: null };
}

export async function startRun(orgId: string, libraryId: string, userId: string, userName: string, opts: { caseIds?: string[]; tag?: string; costCapUsd: number }) {
  let q = supabaseAdmin.from("knowledge_eval_cases").select("id")
    .eq("org_id", orgId).eq("library_id", libraryId).eq("status", "active");
  if (opts.caseIds?.length) q = q.in("id", opts.caseIds.filter((id) => UUID.test(id)).slice(0, 200));
  if (opts.tag) q = q.contains("tags", [opts.tag]);
  const { data: cases, error } = await q.order("created_at").limit(200);
  if (error) throw new Error(error.message);
  const ids = ((cases ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) throw new Error("No active test cases to run.");
  const { data: run, error: runErr } = await supabaseAdmin.from("knowledge_eval_runs").insert({
    org_id: orgId, library_id: libraryId, engine_version: engineVersion(),
    scope: opts.caseIds?.length ? (ids.length === 1 ? "one" : "selected") : opts.tag ? `tag:${opts.tag}` : "all",
    started_by: userId, started_by_name: userName, cost_cap_usd: opts.costCapUsd, total: ids.length,
  }).select("*").single();
  if (runErr) throw new Error(runErr.message);
  return { run, caseIds: ids };
}

/** Record one case's outcome on its run, and stop the run at its cost cap. */
export async function recordOutcome(runId: string, c: EvalCase, o: CaseOutcome) {
  await supabaseAdmin.from("knowledge_eval_results").upsert({
    run_id: runId, case_id: c.id, org_id: c.org_id,
    answer: o.answer.slice(0, 20_000), citations: o.citations, trace_id: o.traceId,
    checks: o.checks, pass: o.error ? false : o.pass, cost_usd: o.costUsd, error: o.error,
  }, { onConflict: "run_id,case_id" });
  // Totals from the results themselves — two cases finishing at once can't
  // overwrite each other's count.
  const { data: rows } = await supabaseAdmin.from("knowledge_eval_results")
    .select("pass, cost_usd").eq("run_id", runId).limit(1000);
  const list = (rows ?? []) as Array<{ pass: boolean | null; cost_usd: number | string | null }>;
  const cost = list.reduce((n, r) => n + (Number(r.cost_usd) || 0), 0);
  const { data: run } = await supabaseAdmin.from("knowledge_eval_runs")
    .update({
      passed: list.filter((r) => r.pass).length,
      failed: list.filter((r) => r.pass === false).length,
      cost_usd: Math.round(cost * 10000) / 10000,
    })
    .eq("id", runId).select("cost_usd, cost_cap_usd, total, status").single();
  const r = run as { cost_usd: number; cost_cap_usd: number; total: number; status: string } | null;
  if (r && r.status === "running") {
    if (Number(r.cost_usd) >= Number(r.cost_cap_usd)) {
      await supabaseAdmin.from("knowledge_eval_runs").update({ status: "stopped", stop_reason: `Reached the $${Number(r.cost_cap_usd).toFixed(2)} limit for this run.`, finished_at: new Date().toISOString() }).eq("id", runId);
    } else if (list.length >= r.total) {
      await supabaseAdmin.from("knowledge_eval_runs").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", runId);
    }
  }
}
