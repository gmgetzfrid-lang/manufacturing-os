// lib/ai/jobModelsServer.ts — SERVER-ONLY. The person's model per AI job.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { AiProviderId } from "@/lib/ai/providerCall";
import { cleanJobModels, modelForJob, type AiJob, type JobModels } from "@/lib/ai/jobModels";

/** Their saved choices. Before 20261108_job_models.sql the column doesn't
 *  exist: every job keeps its default — asking never breaks over it. */
export async function loadJobModels(orgId: string, userId: string): Promise<JobModels> {
  const { data, error } = await supabaseAdmin
    .from("ai_connections").select("job_models")
    .eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  if (error) return {};
  return cleanJobModels((data as { job_models?: unknown } | null)?.job_models);
}

/** The model this person's job runs on. */
export async function jobModel(
  orgId: string, userId: string,
  conn: { provider: AiProviderId | string; model: string },
  job: AiJob,
): Promise<string> {
  return modelForJob({
    provider: conn.provider as AiProviderId, model: String(conn.model),
    jobModels: await loadJobModels(orgId, userId),
  }, job);
}
