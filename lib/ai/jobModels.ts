// lib/ai/jobModels.ts — which model each AI job runs on.
//
// One main model (ai_connections.model) covers everything; a person can
// point a job at a different model (ai_connections.job_models, from
// 20261108_job_models.sql) — the strongest model for Ask Knowledge, a
// lighter one for shift notes, a cheap tier for reading drawings. A job with
// no choice keeps its own default (jobDefault) or the main model.
// Client-safe: no server imports.

import type { AiProviderId } from "@/lib/ai/providerCall";
import { estimateCostUsd } from "@/lib/ai/pricing";

export type AiJob = "knowledge" | "shiftNotes" | "reading" | "drafting" | "projectDocs";

/** A stored choice: a model id, or "main" for the main model. */
export type JobModels = Partial<Record<AiJob, string>>;

export const MAIN = "main";

export interface AiJobInfo {
  id: AiJob;
  label: string;
  what: string;
  /** Usage-meter ops that belong to the job. */
  ops: string[];
  /** One use, for the cost line: tokens in/out and what one use is. */
  use: { inputTokens: number; outputTokens: number; per: string };
}

// Token sizes for the cost line: Ask Knowledge and reading are this app's
// own averages (ai_usage_events, Oct 2026); the rest are typical sizes.
// The settings panel swaps in the person's own averages when they have them.
export const AI_JOBS: AiJobInfo[] = [
  { id: "knowledge", label: "Ask Knowledge", what: "Questions answered from your documents", ops: ["knowledgeAsk", "orchestrator"], use: { inputTokens: 127_000, outputTokens: 3_700, per: "question" } },
  { id: "shiftNotes", label: "Shift notes", what: "The hour-by-hour notes for the shift report", ops: ["shiftNotes"], use: { inputTokens: 6_000, outputTokens: 800, per: "shift" } },
  { id: "reading", label: "Reading drawings & scans", what: "Pages with no text layer, read when a library is indexed", ops: ["knowledgeVision", "drawingLocate"], use: { inputTokens: 3_400, outputTokens: 620, per: "page" } },
  { id: "drafting", label: "Forms & templates", what: "Filling forms and drafting from templates", ops: ["formDraft", "templateDraft"], use: { inputTokens: 20_000, outputTokens: 3_000, per: "draft" } },
  { id: "projectDocs", label: "Project documents", what: "Quotes, invoices, budgets, checklists, quality manuals", ops: ["quoteParse", "invoiceParse", "budgetDocParse", "checklistSegment", "checklistAssess", "qualityManualReview"], use: { inputTokens: 15_000, outputTokens: 2_000, per: "document" } },
];

/** The cheap tier documents are read on unless someone picks otherwise. */
export const READING_DEFAULT: Record<AiProviderId, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
};

/** A job's model when nobody has picked one (undefined = the main model). */
export function jobDefault(job: AiJob, provider: AiProviderId): string | undefined {
  if (job === "reading") return READING_DEFAULT[provider];
  if (job === "shiftNotes" && provider === "anthropic") return "claude-sonnet-5-5";
  return undefined;
}

export const jobOfOp = (op: string): AiJob | null => AI_JOBS.find((j) => j.ops.includes(op))?.id ?? null;

/** A model id runs on this provider (a choice saved under another provider
 *  is ignored, never sent to the wrong API). */
export function modelFitsProvider(provider: AiProviderId, model: string): boolean {
  const id = model.trim().toLowerCase();
  if (provider === "anthropic") return id.startsWith("claude-");
  if (provider === "openai") return /^(gpt-|o\d|chatgpt-)/.test(id);
  return id.startsWith("gemini-");
}

/** The model a job runs on: the person's choice, else the job's default,
 *  else the main model. */
export function modelForJob(conn: { provider: AiProviderId; model: string; jobModels?: JobModels | null }, job: AiJob | null): string {
  if (!job) return conn.model;
  const pick = conn.jobModels?.[job]?.trim();
  if (pick === MAIN) return conn.model;
  if (pick && modelFitsProvider(conn.provider, pick)) return pick;
  return jobDefault(job, conn.provider) ?? conn.model;
}

/** Keep only well-formed choices (known job, short model id). */
export function cleanJobModels(raw: unknown): JobModels {
  const out: JobModels = {};
  if (!raw || typeof raw !== "object") return out;
  for (const j of AI_JOBS) {
    const v = (raw as Record<string, unknown>)[j.id];
    if (typeof v === "string" && /^[a-z0-9][a-z0-9.\-_:]{0,63}$/i.test(v.trim())) out[j.id] = v.trim();
  }
  return out;
}

/** A Claude model id as people say it ("Opus 5.5"); other ids as they are. */
export function modelName(model: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/.exec(model.trim().toLowerCase());
  if (!m) return model;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** Dollars for one use of a job on a model. */
export const costPerUse = (model: string, use: { inputTokens: number; outputTokens: number }) =>
  estimateCostUsd(model, { inputTokens: use.inputTokens, outputTokens: use.outputTokens });

/** "$0.58", "1.6¢", "<0.1¢". */
export function fmtCost(usd: number): string {
  if (usd >= 0.995) return `$${usd.toFixed(2)}`;
  const c = usd * 100;
  if (c < 0.1) return "<0.1¢";
  return `${c < 10 ? c.toFixed(1).replace(/\.0$/, "") : Math.round(c)}¢`;
}
