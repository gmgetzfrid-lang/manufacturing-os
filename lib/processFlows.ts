// lib/processFlows.ts — the plant's flow topology, client side.
//
// A flow is a DIRECTIONAL edge: something feeds something else. Two ways in:
// drawn by hand on the graph, or read off a process flow diagram by AI
// ('proposed' until a human accepts). The graph's Process lens renders
// confirmed flows; the unit hub reviews proposals where the equipment lives,
// and the operating-areas page lists every proposal in the plant (FLOW-1).
//
// Who decides (FLOW-2 / FLOW-3, 20261155, DEC-44 (I-09)): the shared map is
// asserted by the CONTROLLER tier — Admin / DocCtrl held anywhere in the
// role collection, what is_org_controller means. A controller's hand-drawn
// flow is confirmed on arrival; anyone else's lands as a proposal for a
// controller to confirm. Confirming, dismissing and removing a decided flow
// are the controller tier's; the database stamps who decided and when.
// Every write here is CHECKED: a refusal (or an RLS filter that changed no
// row) is an error the person reads, never a silent success.

import { supabase } from "@/lib/supabase";
import { LOW_CONFIDENCE } from "@/lib/flowsRead";

export type FlowEndpointKind = "asset" | "unit";
export type FlowStatus = "proposed" | "confirmed" | "dismissed";

export interface ProcessFlow {
  id: string;
  org_id: string;
  from_kind: FlowEndpointKind;
  from_ref: string;
  to_kind: FlowEndpointKind;
  to_ref: string;
  label: string | null;
  status: FlowStatus;
  origin: "manual" | "ai";
  source_document_id: string | null;
  source_page: number | null;
  /** The knowledge document's revision the proposal was read from (20261155). */
  source_version_id?: string | null;
  evidence: { docName?: string; note?: string; confidence?: number | null } | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  decided_by?: string | null;
  decided_by_name?: string | null;
  decided_at?: string | null;
}

/** A pre-migration database: the TABLE is missing (not a column — a missing
 *  column is a real error, never "not installed"). */
const missingTable = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205"
    || /relation "?[\w.]+"? does not exist/i.test(e.message ?? "")
    || /could not find the table/i.test(e.message ?? ""));

/** FLOW-9: the review surfaces read every flow, newest first, in pages — up
 *  to this many, and say so past it. */
export const FLOW_PAGE = 1000;
export const FLOW_READ_CAP = 20_000;

export interface FlowListing {
  flows: ProcessFlow[];
  /** More than FLOW_READ_CAP non-dismissed flows exist; the oldest are not listed. */
  truncated: boolean;
}

/** Every non-dismissed flow for the org, newest first, paged to completion
 *  (FLOW-9: the old single read kept the 4,000 OLDEST, so the newest
 *  proposals — the ones a reviewer is waiting on — fell off first). Null
 *  pre-migration. */
export async function listProcessFlowsPaged(orgId: string): Promise<FlowListing | null> {
  const flows: ProcessFlow[] = [];
  for (let from = 0; from < FLOW_READ_CAP; from += FLOW_PAGE) {
    const { data, error } = await supabase
      .from("process_flows").select("*")
      .eq("org_id", orgId)
      .neq("status", "dismissed")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + FLOW_PAGE - 1);
    if (error) {
      if (missingTable(error)) return null;
      throw new Error(error.message);
    }
    const rows = (data as ProcessFlow[]) ?? [];
    flows.push(...rows);
    if (rows.length < FLOW_PAGE) return { flows, truncated: false };
  }
  return { flows, truncated: true };
}

/** All non-dismissed flows for the org (newest first). Null pre-migration. */
export async function listProcessFlows(orgId: string): Promise<ProcessFlow[] | null> {
  const listing = await listProcessFlowsPaged(orgId);
  return listing ? listing.flows : null;
}

/** What a person reads when a flow write is refused by the database. */
export function flowWriteMessage(error: { code?: string; message?: string }): string {
  const msg = error.message ?? "";
  const guard = msg.match(/process_flows_\w+: (.+)$/);
  if (guard) return guard[1].charAt(0).toUpperCase() + guard[1].slice(1) + ".";
  if (error.code === "42501" || /row-level security/i.test(msg)) {
    return "You can't change process flows in this workspace — only a document controller (Admin or DocCtrl) confirms or removes flows.";
  }
  return msg || "The flow could not be saved.";
}

export const FLOW_PROPOSED_MESSAGE =
  "Saved as a proposed flow — a document controller (Admin or DocCtrl) confirms it from the operating area's flow panel before it joins the process map.";
export const FLOW_DECIDE_REFUSED =
  "That flow wasn't changed — only a document controller (Admin or DocCtrl) confirms or dismisses flows (or someone already removed it). Refresh to see where it stands.";
export const FLOW_DELETE_REFUSED =
  "That flow wasn't removed — only a document controller (Admin or DocCtrl) removes a decided flow; you can withdraw your own proposal (or someone already removed it). Refresh to see where it stands.";

/** The database turned a hand-drawn flow into a proposal: its author is not
 *  in the controller tier (FLOW-2). The row IS written — a controller
 *  decides it. Thrown so a caller that would otherwise draw the edge as part
 *  of the map shows this sentence instead. */
export class FlowProposedNotice extends Error {
  readonly landed = "proposed" as const;
  constructor() {
    super(FLOW_PROPOSED_MESSAGE);
    this.name = "FlowProposedNotice";
  }
}

/** Draw a flow by hand. A controller's lands confirmed (a human with the
 *  authority said so); anyone else's lands as a proposal — the database
 *  decides (20261155) and this reports what landed: "confirmed", "exists"
 *  (the unique pair index makes a duplicate a no-op, not an error), or a
 *  thrown FlowProposedNotice for a proposal. */
export async function createManualFlow(input: {
  orgId: string;
  fromKind: FlowEndpointKind; fromRef: string;
  toKind: FlowEndpointKind; toRef: string;
  label?: string;
  userId: string; userName?: string;
}): Promise<"confirmed" | "exists"> {
  const { data, error } = await supabase.from("process_flows").insert({
    org_id: input.orgId,
    from_kind: input.fromKind, from_ref: input.fromRef,
    to_kind: input.toKind, to_ref: input.toRef,
    label: (input.label ?? "").trim() || null,
    status: "confirmed",
    origin: "manual",
    created_by: input.userId,
    created_by_name: input.userName ?? null,
  }).select("id, status").maybeSingle();
  if (error) {
    if (error.code === "23505") return "exists";
    throw new Error(flowWriteMessage(error));
  }
  if ((data as { status?: string } | null)?.status === "proposed") throw new FlowProposedNotice();
  return "confirmed";
}

/** Accept or dismiss a flow (the controller tier). Dismissals stay as rows —
 *  the reader must never re-propose a pair a human already rejected on the
 *  revision they judged (a new revision of the same drawing may). The
 *  decider is stamped by the database; a write RLS filtered out is an error,
 *  never a silent no-op (FLOW-3). */
export async function decideFlow(id: string, accept: boolean, actor: {
  userId: string; userName?: string;
}): Promise<void> {
  const { data, error } = await supabase.from("process_flows").update({
    status: accept ? "confirmed" : "dismissed",
    decided_by: actor.userId,
    decided_by_name: actor.userName ?? null,
    decided_at: new Date().toISOString(),
  }).eq("id", id).select("id");
  if (error) throw new Error(flowWriteMessage(error));
  if (!data || (data as unknown[]).length === 0) throw new Error(FLOW_DECIDE_REFUSED);
}

/** Remove a flow (the controller tier; an author withdraws their own
 *  proposal). Checked like decideFlow. */
export async function deleteFlow(id: string): Promise<void> {
  const { data, error } = await supabase.from("process_flows").delete().eq("id", id).select("id");
  if (error) throw new Error(flowWriteMessage(error));
  if (!data || (data as unknown[]).length === 0) throw new Error(FLOW_DELETE_REFUSED);
}

/** How many flows end at this equipment — what deleting it removes
 *  (20261155's cleanup) and what archiving it hides (FLOW-6). Null when the
 *  count cannot be read — never "none". */
export async function countAssetFlows(orgId: string, assetId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from("process_flows").select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .or(`and(from_kind.eq.asset,from_ref.eq.${assetId}),and(to_kind.eq.asset,to_ref.eq.${assetId})`);
  if (error) return missingTable(error) ? 0 : null;
  return count ?? 0;
}

// ── Endpoints, as the review surfaces show them (IRLS-7 / FLOW-6) ──────────

export type EndpointInfo =
  | { state: "ok"; tag: string; archived: boolean; unitCode: string | null }
  | { state: "missing" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve asset endpoints against the registry: each ref is equipment that
 *  exists (with its tag, archived or not) or equipment that no longer exists
 *  — validated on read, so a flow to a deleted asset is shown as broken,
 *  never as an unnamed chip. Null when the registry read failed (the panel
 *  then says it could not check, never "gone"). */
export async function resolveAssetEndpoints(
  refs: Iterable<string>,
  known: ReadonlyMap<string, { tag: string; archived?: boolean | null; unit_code?: string | null }> = new Map(),
): Promise<Map<string, EndpointInfo> | null> {
  const out = new Map<string, EndpointInfo>();
  const ask: string[] = [];
  for (const ref of new Set(refs)) {
    const k = known.get(ref);
    if (k) out.set(ref, { state: "ok", tag: k.tag, archived: !!k.archived, unitCode: k.unit_code ?? null });
    else if (!UUID.test(ref)) out.set(ref, { state: "missing" });
    else ask.push(ref);
  }
  for (let i = 0; i < ask.length; i += 200) {
    const chunk = ask.slice(i, i + 200);
    const { data, error } = await supabase.from("assets").select("id, tag, archived, unit_code").in("id", chunk);
    if (error) return null;
    for (const r of (data as Array<{ id: string; tag: string; archived: boolean | null; unit_code: string | null }>) ?? []) {
      out.set(r.id, { state: "ok", tag: r.tag, archived: !!r.archived, unitCode: r.unit_code ?? null });
    }
    for (const ref of chunk) if (!out.has(ref)) out.set(ref, { state: "missing" });
  }
  return out;
}

// ── Confidence (PR-7) ───────────────────────────────────────────────────────

// LOW_CONFIDENCE lives with the reader's pure decisions (lib/flowsRead).
export { LOW_CONFIDENCE };

/** The confidence the reader gave a proposal; null when it gave none (or a
 *  person drew it) — unknown, never a default. */
export function flowConfidence(f: Pick<ProcessFlow, "evidence">): number | null {
  const c = f.evidence?.confidence;
  return typeof c === "number" && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null;
}

/** An AI proposal the reader was unsure of, or gave no confidence for. */
export function isLowConfidence(f: Pick<ProcessFlow, "evidence" | "origin">): boolean {
  if (f.origin !== "ai") return false;
  const c = flowConfidence(f);
  return c === null || c < LOW_CONFIDENCE;
}
