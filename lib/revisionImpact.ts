// lib/revisionImpact.ts — the digital project manager.
//
// A P&ID revs. Who needs to know? Not just the people watching THAT sheet —
// the people holding the sheets it connects to. The continuation drawing.
// The doc that shares its equipment. The one someone pinned to it.
//
// Everything needed is already stored, so this is deterministic joins, not
// an agent re-deriving the plant every time: walk ONE hop out along the real
// link web, find who has those neighbours checked out or is watching them,
// and tell exactly those people — with the reason.
//
// One hop on purpose. Two hops in a tagged drawing set reaches most of the
// plant, and a notification that reaches everyone is one nobody reads.

import { supabase } from "@/lib/supabase";
import { emit } from "@/lib/notify/dispatch";

export interface NeighbourDoc {
  id: string;
  library_id: string;
  document_number: string | null;
  title: string | null;
  /** Why this document is downstream of the revised one. */
  reason: string;
}

/** One hop out from a document along every real relationship: curated and
 *  system-applied links (both directions), and shared equipment. */
export async function findConnectedDocuments(
  documentId: string,
  opts?: { limit?: number },
): Promise<NeighbourDoc[]> {
  const limit = opts?.limit ?? 40;
  const reasons = new Map<string, string>();

  // Curated + system-applied links, both directions.
  try {
    const [outbound, inbound] = await Promise.all([
      supabase.from("document_related_resources")
        .select("target_document_id, label, proposer")
        .eq("document_id", documentId).not("target_document_id", "is", null).limit(limit),
      supabase.from("document_related_resources")
        .select("document_id, label, proposer")
        .eq("target_document_id", documentId).limit(limit),
    ]);
    for (const r of (outbound.data as Array<{ target_document_id: string; label: string | null; proposer: string | null }>) ?? []) {
      reasons.set(r.target_document_id, r.proposer === "opc"
        ? "continuation sheet"
        : (r.label || "linked document"));
    }
    for (const r of (inbound.data as Array<{ document_id: string; label: string | null; proposer: string | null }>) ?? []) {
      if (!reasons.has(r.document_id)) {
        reasons.set(r.document_id, r.proposer === "opc"
          ? "continuation sheet"
          : (r.label || "linked document"));
      }
    }
  } catch { /* links are best-effort context */ }

  // Shared equipment — documents that carry the same tags.
  try {
    const { data: mine } = await supabase
      .from("document_assets").select("asset_id").eq("document_id", documentId).limit(60);
    const assetIds = [...new Set(((mine ?? []) as Array<{ asset_id: string }>).map((a) => a.asset_id))];
    if (assetIds.length > 0) {
      const { data: others } = await supabase
        .from("document_assets").select("document_id, asset_id")
        .in("asset_id", assetIds).limit(400);
      const counts = new Map<string, number>();
      for (const r of ((others ?? []) as Array<{ document_id: string }>)) {
        if (r.document_id === documentId) continue;
        counts.set(r.document_id, (counts.get(r.document_id) ?? 0) + 1);
      }
      // Rank by how much equipment they share; only the closest neighbours.
      for (const [docId, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
        if (!reasons.has(docId)) {
          reasons.set(docId, n === 1 ? "shares equipment" : `shares ${n} equipment items`);
        }
      }
    }
  } catch { /* equipment is best-effort context */ }

  const ids = [...reasons.keys()].slice(0, limit);
  if (ids.length === 0) return [];

  const { data: docs } = await supabase
    .from("documents").select("id, library_id, document_number, title").in("id", ids);
  return ((docs as Array<{ id: string; library_id: string; document_number: string | null; title: string | null }>) ?? [])
    .map((d) => ({ ...d, reason: reasons.get(d.id) ?? "connected" }));
}

/** After a publish: warn the people working on connected documents.
 *
 *  Targets are earned, not broadcast — someone must have the neighbouring
 *  document CHECKED OUT (they're actively drafting against it) for this to
 *  reach them. Watchers of the revised document already hear about it
 *  through the normal supersede signal; this is specifically the blind spot:
 *  you're drafting sheet 13 and sheet 12 just changed under you. */
export async function notifyConnectedWork(input: {
  orgId: string;
  documentId: string;
  libraryId: string;
  docLabel: string;
  newRev: string;
  actorUserId: string;
  actorName: string;
}): Promise<{ notified: number; neighbours: number }> {
  try {
    const neighbours = await findConnectedDocuments(input.documentId, { limit: 40 });
    if (neighbours.length === 0) return { notified: 0, neighbours: 0 };

    const { data: held } = await supabase
      .from("documents")
      .select("id, document_number, title, checked_out_by, checked_out_by_name")
      .in("id", neighbours.map((n) => n.id))
      .not("checked_out_by", "is", null);

    const holders = ((held as Array<{
      id: string; document_number: string | null; title: string | null;
      checked_out_by: string; checked_out_by_name: string | null;
    }>) ?? []).filter((h) => h.checked_out_by !== input.actorUserId);
    if (holders.length === 0) return { notified: 0, neighbours: neighbours.length };

    // Group by person: one clear message per affected user, naming the
    // document THEY hold and why it's downstream.
    const byUser = new Map<string, string[]>();
    for (const h of holders) {
      const n = neighbours.find((x) => x.id === h.id);
      const label = h.document_number || h.title || "a document";
      const line = `${label} (${n?.reason ?? "connected"})`;
      (byUser.get(h.checked_out_by) ?? byUser.set(h.checked_out_by, []).get(h.checked_out_by)!).push(line);
    }

    for (const [userId, lines] of byUser) {
      await emit({
        orgId: input.orgId,
        category: "watched",
        kind: "doc_superseded",
        title: `Upstream change: ${input.docLabel} is now Rev ${input.newRev}`,
        body:
          `${input.actorName} published Rev ${input.newRev} of ${input.docLabel}, which is connected to work you have checked out: ` +
          `${lines.slice(0, 4).join("; ")}${lines.length > 4 ? `; and ${lines.length - 4} more` : ""}. ` +
          `Check whether your drawing needs to follow.`,
        link: `/documents/${input.libraryId}?doc=${input.documentId}`,
        resource: { type: "document", id: input.documentId },
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        audience: { involved: [userId] },
      });
    }
    return { notified: byUser.size, neighbours: neighbours.length };
  } catch {
    // The publish already committed — impact signalling must never undo it.
    return { notified: 0, neighbours: 0 };
  }
}
