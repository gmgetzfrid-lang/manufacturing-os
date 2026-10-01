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
  /** ORCH-4: the server-side record of this proposal. Confirming sends this
   *  id — never the tool or its parameters — and runs the stored action once. */
  proposalId?: string;
  /** When the stored proposal stops being confirmable (ISO). */
  expiresAt?: string;
  /** Set when the proposal could not be stored: it cannot be confirmed. */
  unavailable?: string;
  /** ORCH-9: the stored proposal was suggested after the assistant read
   *  document text written like an instruction to it. Informational — the
   *  card says so; confirming works exactly as for any other proposal. */
  tainted?: boolean;
}

/** A document the answer names, resolved to something clickable. */
export interface MentionedDoc {
  id: string;
  number: string | null;
  title: string;
  /** The exact designation string as it appears in the answer text. */
  mention: string;
  openUrl: string;
}

export interface OrchestratorReply {
  answer: string;
  steps: RunStep[];
  pending: PendingAction[];
  stoppedBecause: string | null;
  /** Documents the answer names — rendered as inline show-me chips. */
  mentionedDocs?: MentionedDoc[];
  provider: string;
  model: string;
  budget: { spentUsd: number; capUsd: number };
}

/**
 * Ask the controller. A run never executes a write (ORCH-10): write tools
 * come back as pending proposals, confirmed one at a time through
 * executeAction.
 */
export async function askOrchestrator(
  orgId: string,
  question: string,
  signal?: AbortSignal,
): Promise<OrchestratorReply> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");

  const res = await fetch("/api/orchestrator", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ orgId, question }),
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

/**
 * Execute one proposed write action, exactly as proposed (ORCH-4). No model
 * call, and nothing the browser holds decides what runs: the request names
 * the stored proposal, and the server runs ITS tool and parameters, once,
 * under the caller's own checks. A refusal (expired, already run, not
 * yours, a page opened before an update) throws with the server's reason.
 */
export async function executeAction(
  orgId: string,
  action: Pick<PendingAction, "proposalId" | "fingerprint" | "unavailable">,
): Promise<Record<string, unknown>> {
  if (!action.proposalId) {
    throw new Error(action.unavailable || "This proposal can't be confirmed. Ask the assistant again.");
  }
  const data = await postExecute({ orgId, proposalId: action.proposalId, fingerprint: action.fingerprint });
  return (data.result as Record<string, unknown> | undefined) ?? {};
}

/** Dismiss a proposal: it can never be run afterwards (ORCH-4). */
export async function dismissAction(
  orgId: string,
  action: Pick<PendingAction, "proposalId">,
): Promise<void> {
  if (!action.proposalId) return;
  await postExecute({ orgId, proposalId: action.proposalId, decision: "dismiss" });
}

async function postExecute(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");
  const res = await fetch("/api/orchestrator/execute", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null;
  if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
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
