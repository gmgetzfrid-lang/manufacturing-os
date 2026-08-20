// lib/processFlows.ts — the plant's flow topology, client side.
//
// A flow is a DIRECTIONAL edge: something feeds something else. Two ways in:
// drawn by hand on the graph (status 'confirmed' immediately — a human said
// so), or read off a process flow diagram by AI ('proposed' until a human
// accepts). The graph's Process lens renders confirmed flows; the unit hub
// reviews proposals where the equipment lives.

import { supabase } from "@/lib/supabase";

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
  evidence: { docName?: string; note?: string } | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist/i.test(e.message ?? ""));

/** All non-dismissed flows for the org. Null pre-migration. */
export async function listProcessFlows(orgId: string): Promise<ProcessFlow[] | null> {
  const { data, error } = await supabase
    .from("process_flows").select("*")
    .eq("org_id", orgId)
    .neq("status", "dismissed")
    .order("created_at", { ascending: true })
    .limit(4000);
  if (error) {
    if (missing(error)) return null;
    throw new Error(error.message);
  }
  return (data as ProcessFlow[]) ?? [];
}

/** Draw a flow by hand — a human said so, so it is confirmed on arrival.
 *  The unique pair index makes a duplicate a no-op, not an error. */
export async function createManualFlow(input: {
  orgId: string;
  fromKind: FlowEndpointKind; fromRef: string;
  toKind: FlowEndpointKind; toRef: string;
  label?: string;
  userId: string; userName?: string;
}): Promise<void> {
  const { error } = await supabase.from("process_flows").insert({
    org_id: input.orgId,
    from_kind: input.fromKind, from_ref: input.fromRef,
    to_kind: input.toKind, to_ref: input.toRef,
    label: (input.label ?? "").trim() || null,
    status: "confirmed",
    origin: "manual",
    created_by: input.userId,
    created_by_name: input.userName ?? null,
  });
  if (error && error.code !== "23505") throw new Error(error.message);
}

/** Accept or dismiss an AI-proposed flow. Dismissals stay as rows — the
 *  reader must never re-propose a pair a human already rejected. */
export async function decideFlow(id: string, accept: boolean, actor: {
  userId: string; userName?: string;
}): Promise<void> {
  const { error } = await supabase.from("process_flows").update({
    status: accept ? "confirmed" : "dismissed",
    decided_by: actor.userId,
    decided_by_name: actor.userName ?? null,
    decided_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteFlow(id: string): Promise<void> {
  const { error } = await supabase.from("process_flows").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
