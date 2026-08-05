// lib/orchestratorClient.ts — browser side of the document controller.
//
// Thin on purpose: the API route owns every decision that matters. What lives
// here is the shape of a run, so the UI can render what the assistant DID and
// not just what it said. That transparency is the point — an answer you can't
// audit is a rumour with a nice font.

import { supabase } from "@/lib/supabase";

export interface RunStep {
  tool: string;
  parameters: Record<string, unknown>;
  result: unknown;
  error?: string;
}

export interface PendingAction {
  fingerprint: string;
  tool: string;
  summary: string;
  parameters: Record<string, unknown>;
  /** Set when confirming hands off to the real UI flow instead of executing. */
  href?: string;
}

export interface OrchestratorReply {
  answer: string;
  steps: RunStep[];
  pending: PendingAction[];
  stoppedBecause: string | null;
  provider: string;
  model: string;
  budget: { spentUsd: number; capUsd: number };
}

/**
 * Ask the controller.
 *
 * `approved` carries fingerprints the user ticked. It's deliberately per-call:
 * approving a checkout doesn't leave the door open for the next question.
 */
export async function askOrchestrator(
  orgId: string,
  question: string,
  approved: string[] = [],
  signal?: AbortSignal,
): Promise<OrchestratorReply> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");

  const res = await fetch("/api/orchestrator", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ orgId, question, approved }),
    signal,
  });
  const data = (await res.json().catch(() => null)) as (OrchestratorReply & { error?: string }) | null;
  if (!res.ok || !data) {
    throw Object.assign(
      new Error(data?.error || `HTTP ${res.status}`),
      data && typeof data === "object" ? data : {},
    );
  }
  return data;
}

/** Plain-language label for a tool name, for the "what I did" trace. */
export function describeTool(tool: string): string {
  switch (tool) {
    case "find_documents": return "Looked up documents";
    case "search_documents": return "Searched document text";
    case "query_equipment_by_unit": return "Listed equipment in a unit";
    case "equipment_mentions": return "Found where equipment is mentioned";
    case "check_permissions": return "Checked your access";
    case "check_audit_history": return "Checked the audit history";
    case "trace_pid_lines": return "Traced connections";
    case "checkout_document": return "Proposed a checkout";
    case "notify_personnel": return "Proposed a notification";
    case "log_audit_completion": return "Proposed an audit record";
    default: return tool;
  }
}
