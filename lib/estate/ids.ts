// lib/estate/ids.ts — one id per thing, shared by every lens.
//
// A unit is `cbunit:20` whether it is drawn on the Documents graph, the
// Intelligence graph, an asset page or a project page. Edges are strings
// to strings, so a lens never has to know which table a node came from.

export type NodeKind = "plant" | "unit" | "cbunit" | "system" | "asset" | "doc" | "folder" | "lib" | "proj" | "drive" | "extf" | "ext";

export const nid = {
  plant: (id: string) => `plant:${id}`,
  unit: (id: string) => `unit:${id}`,
  /** Site Codebook unit, by code — the id the org graph already uses. */
  cbunit: (code: string) => `cbunit:${code}`,
  system: (id: string) => `system:${id}`,
  asset: (id: string) => `asset:${id}`,
  doc: (id: string) => `doc:${id}`,
  folder: (id: string) => `folder:${id}`,
  lib: (id: string) => `lib:${id}`,
  proj: (id: string) => `proj:${id}`,
  drive: (id: string) => `drive:${id}`,
};

export function parseNid(id: string): { kind: NodeKind; ref: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  const kind = id.slice(0, i) as NodeKind;
  return { kind, ref: id.slice(i + 1) };
}

export type EdgeType =
  | "belongs_to_unit"  // folder/doc/asset/proj → cbunit
  | "in_project"       // folder/doc → proj
  | "project_scope"    // proj → cbunit/asset/doc (declared scope)
  | "about_asset"      // folder → asset (an equipment folder)
  | "of_type"          // folder → eqtype:LABEL (equipment under it is this type)
  | "tagged_to"        // doc → asset (a filing decision)
  | "filed_under"      // doc → folder, ALSO filed (the symbolic link)
  | "alias_of"
  | "related";

export type EdgeOrigin = "human" | "codebook" | "resolver" | "bridge" | "proposer" | "vision" | "scanner";
export type EdgeTier = "provable" | "strong" | "inferred";
export type EdgeStatus = "applied" | "pending" | "dismissed" | "stale";

export interface EstateEdge {
  id: string;
  orgId: string;
  a: string;
  b: string;
  type: EdgeType;
  origin: EdgeOrigin;
  tier: EdgeTier;
  confidence: number;
  status: EdgeStatus;
  summary: string;
  evidence: Record<string, unknown>;
  versionId: string | null;
  createdByName: string | null;
  createdAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
}

export function edgeFromRow(r: Record<string, unknown>): EstateEdge {
  return {
    id: String(r.id), orgId: String(r.org_id), a: String(r.a), b: String(r.b),
    type: r.type as EdgeType, origin: (r.origin as EdgeOrigin) ?? "human",
    tier: (r.tier as EdgeTier) ?? "provable", confidence: Number(r.confidence ?? 1),
    status: (r.status as EdgeStatus) ?? "applied", summary: String(r.summary ?? ""),
    evidence: (r.evidence as Record<string, unknown>) ?? {},
    versionId: (r.version_id as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: String(r.created_at ?? ""),
    decidedByName: (r.decided_by_name as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
  };
}
