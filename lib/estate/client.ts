// lib/estate/client.ts — the browser's side of the estate: authenticated
// calls to the estate routes, and reads/decisions on edges under RLS.

import { supabase } from "@/lib/supabase";
import { edgeFromRow, type EstateEdge } from "./ids";

async function token(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");
  return session.access_token;
}

export async function estatePost<T>(url: string, body: unknown): Promise<T> {
  const headers = { "content-type": "application/json", authorization: `Bearer ${await token()}` };
  const once = async () => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  let res: Response;
  try { res = await once(); }
  catch (e) {
    // "Failed to fetch": the connection dropped (QUIC resets, a flaky
    // network, the offline worker). One retry after a breath covers nearly
    // every one of these.
    await new Promise((r) => setTimeout(r, 1500));
    try { res = await once(); }
    catch { throw new Error(`The connection dropped twice talking to the server (${(e as Error).message}). Check the network and try again.`); }
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? (res.status === 503 ? "The app is offline right now (503). Reconnect and try again." : `Request failed (${res.status})`));
  return data;
}

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist|schema cache/i.test(e.message ?? ""));

/** Edges touching any of these node ids, in any status. */
export async function listEdgesFor(orgId: string, nodeIds: string[]): Promise<EstateEdge[]> {
  if (!nodeIds.length) return [];
  const list = nodeIds.map((x) => `"${x.replace(/"/g, "")}"`).join(",");
  const { data, error } = await supabase.from("estate_edges").select("*").eq("org_id", orgId)
    .or(`a.in.(${list}),b.in.(${list})`).order("created_at", { ascending: false }).limit(500);
  if (error) { if (missing(error)) return []; throw new Error(error.message); }
  return ((data as Record<string, unknown>[]) ?? []).map(edgeFromRow);
}

export async function listPendingEdges(orgId: string, limit = 200): Promise<EstateEdge[]> {
  const { data, error } = await supabase.from("estate_edges").select("*").eq("org_id", orgId).eq("status", "pending")
    .order("confidence", { ascending: false }).order("created_at", { ascending: false }).limit(limit);
  if (error) { if (missing(error)) return []; throw new Error(error.message); }
  return ((data as Record<string, unknown>[]) ?? []).map(edgeFromRow);
}

export async function decideEdge(id: string, decision: "applied" | "dismissed", actor: { userId: string | null; name: string | null }): Promise<void> {
  const { error } = await supabase.from("estate_edges").update({
    status: decision, decided_by: actor.userId, decided_by_name: actor.name, decided_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** A human draws an edge by hand. Always applied, always wins. */
export async function declareEdge(input: { orgId: string; a: string; b: string; type: string; summary: string; evidence?: Record<string, unknown>; actor: { userId: string | null; name: string | null } }): Promise<EstateEdge> {
  const row = {
    org_id: input.orgId, a: input.a, b: input.b, type: input.type, origin: "human", tier: "provable", confidence: 1,
    status: "applied", summary: input.summary, evidence: input.evidence ?? {},
    created_by: input.actor.userId, created_by_name: input.actor.name,
    decided_by: input.actor.userId, decided_by_name: input.actor.name, decided_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("estate_edges").upsert(row, { onConflict: "org_id,a,b,type" }).select("*").single();
  if (error) throw new Error(error.message);
  return edgeFromRow(data as Record<string, unknown>);
}

export async function removeEdge(id: string): Promise<void> {
  const { error } = await supabase.from("estate_edges").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Remember a "no" so the same suggestion is never made again. */
export async function dismissEdge(input: { orgId: string; a: string; b: string; type: string; summary: string; actor: { userId: string | null; name: string | null } }): Promise<void> {
  const { error } = await supabase.from("estate_edges").upsert({
    org_id: input.orgId, a: input.a, b: input.b, type: input.type, origin: "resolver", tier: "inferred", confidence: 0.5,
    status: "dismissed", summary: input.summary, evidence: {}, decided_by: input.actor.userId, decided_by_name: input.actor.name, decided_at: new Date().toISOString(),
  }, { onConflict: "org_id,a,b,type" });
  if (error) throw new Error(error.message);
}
