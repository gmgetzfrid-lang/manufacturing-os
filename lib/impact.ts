// lib/impact.ts
//
// WHERE-USED / IMPACT ANALYSIS — "if I change this drawing, what else does
// it touch?" The one question an engineer has before revving a P&ID, and
// the thing that turns a filing cabinet into the tool you consult BEFORE
// deciding.
//
// Read-only. Pulls together joins that already exist:
//   * document_assets      → equipment on this drawing
//   * document_assets      → OTHER documents that carry the same equipment
//   * tickets.metadata     → open drafting work raised from this document
//   * document_holds       → active holds
//   * project_documents    → projects actively using this document
//   * revision_branches    → unreconciled parallel work
//   * checkout state       → which sibling docs are mid-change right now

import { supabase } from "@/lib/supabase";

export interface ImpactSiblingDoc {
  id: string;
  label: string;
  libraryId: string | null;
  rev: string | null;
  checkedOutByName: string | null;
  sharedTags: string[];
}

export interface DocumentImpact {
  assets: Array<{ id: string; tag: string }>;
  siblingDocs: ImpactSiblingDoc[];
  openTickets: Array<{ id: string; ticketId: string | null; title: string; status: string }>;
  activeHoldCount: number;
  projects: Array<{ id: string; name: string }>;
  openBranchCount: number;
  /** Open work packages that pin this document — a change strands their paper. */
  workPackages: Array<{ id: string; name: string }>;
  /** Outstanding "I have this revision" confirmations on the current rev. */
  pendingDistributionAcks: number;
}

const OPEN_TICKET_STATUSES = [
  "NEW", "PENDING_ENG_INITIAL", "PENDING_ENG_TEAM", "PENDING_ASSIGNMENT",
  "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL",
  "PENDING_IFC", "FINAL_DRAFT",
];

/** Everything changing this document would touch. Each source is best-effort:
 *  a missing table (pre-migration env) contributes an empty slice, never an
 *  error — the panel renders what it can see. */
export async function getDocumentImpact(
  documentId: string,
  orgId: string,
): Promise<DocumentImpact> {
  const out: DocumentImpact = {
    assets: [],
    siblingDocs: [],
    openTickets: [],
    activeHoldCount: 0,
    projects: [],
    openBranchCount: 0,
    workPackages: [],
    pendingDistributionAcks: 0,
  };

  // 1. Equipment on this drawing.
  try {
    const { data: links } = await supabase
      .from("document_assets")
      .select("asset_id, tag_text")
      .eq("document_id", documentId);
    const assetRows = (links as Array<{ asset_id: string; tag_text: string | null }>) ?? [];
    out.assets = assetRows.map((r) => ({ id: r.asset_id, tag: r.tag_text || "tag" }));

    // 2. Sibling documents sharing that equipment (the blast radius).
    if (assetRows.length > 0) {
      const assetIds = assetRows.map((r) => r.asset_id);
      const tagByAsset = new Map(assetRows.map((r) => [r.asset_id, r.tag_text || "tag"]));
      const { data: sibLinks } = await supabase
        .from("document_assets")
        .select("document_id, asset_id")
        .in("asset_id", assetIds)
        .neq("document_id", documentId)
        .limit(200);
      const byDoc = new Map<string, Set<string>>();
      for (const l of (sibLinks as Array<{ document_id: string; asset_id: string }>) ?? []) {
        const tags = byDoc.get(l.document_id) ?? new Set<string>();
        tags.add(tagByAsset.get(l.asset_id) ?? "tag");
        byDoc.set(l.document_id, tags);
      }
      if (byDoc.size > 0) {
        const { data: docs } = await supabase
          .from("documents")
          .select("id, document_number, title, name, rev, library_id, checked_out_by_name, status")
          .in("id", [...byDoc.keys()].slice(0, 50));
        out.siblingDocs = ((docs as Array<Record<string, unknown>>) ?? [])
          .filter((d) => d.status !== "Superseded" && d.status !== "Archived")
          .map((d) => ({
            id: String(d.id),
            label: String(d.document_number || d.title || d.name || "Document"),
            libraryId: (d.library_id as string | null) ?? null,
            rev: (d.rev as string | null) ?? null,
            checkedOutByName: (d.checked_out_by_name as string | null) ?? null,
            sharedTags: [...(byDoc.get(String(d.id)) ?? [])],
          }))
          // Mid-change siblings first — they're the coordination risk.
          .sort((a, b) => Number(!!b.checkedOutByName) - Number(!!a.checkedOutByName));
      }
    }
  } catch { /* slice empty */ }

  // 3. Open drafting tickets raised from this document.
  try {
    const { data: tickets } = await supabase
      .from("tickets")
      .select("id, ticket_id, title, status")
      .eq("org_id", orgId)
      .eq("metadata->source_document->>id", documentId)
      .in("status", OPEN_TICKET_STATUSES)
      .limit(10);
    out.openTickets = ((tickets as Array<Record<string, unknown>>) ?? []).map((t) => ({
      id: String(t.id),
      ticketId: (t.ticket_id as string | null) ?? null,
      title: String(t.title ?? "Ticket"),
      status: String(t.status ?? ""),
    }));
  } catch { /* slice empty */ }

  // 4. Active holds.
  try {
    const { count } = await supabase
      .from("document_holds")
      .select("id", { count: "exact", head: true })
      .eq("document_id", documentId)
      .is("released_at", null);
    out.activeHoldCount = count ?? 0;
  } catch { /* slice empty */ }

  // 5. Projects actively using this document.
  try {
    const { data: pd } = await supabase
      .from("project_documents")
      .select("project_id")
      .eq("document_id", documentId)
      .limit(20);
    const projectIds = [...new Set(((pd as Array<{ project_id: string }>) ?? []).map((r) => r.project_id))];
    if (projectIds.length > 0) {
      const { data: projects } = await supabase
        .from("projects")
        .select("id, name, status")
        .in("id", projectIds);
      out.projects = ((projects as Array<Record<string, unknown>>) ?? [])
        .filter((p) => p.status !== "completed" && p.status !== "archived")
        .map((p) => ({ id: String(p.id), name: String(p.name ?? "Project") }));
    }
  } catch { /* slice empty */ }

  // 6. Unreconciled branches.
  try {
    const { count } = await supabase
      .from("revision_branches")
      .select("id", { count: "exact", head: true })
      .eq("document_id", documentId)
      .is("resolved_at", null);
    out.openBranchCount = count ?? 0;
  } catch { /* slice empty */ }

  // 7. Open work packages pinning this document.
  try {
    const { data: members } = await supabase
      .from("work_package_documents")
      .select("package_id")
      .eq("document_id", documentId);
    const pkgIds = [...new Set(((members as Array<{ package_id: string }>) ?? []).map((m) => m.package_id))];
    if (pkgIds.length) {
      const { data: pkgs } = await supabase
        .from("work_packages")
        .select("id, name")
        .in("id", pkgIds)
        .neq("status", "closed");
      out.workPackages = (((pkgs as Array<{ id: string; name: string }>) ?? [])).slice(0, 10);
    }
  } catch { /* pre-migration */ }

  // 8. Outstanding distribution confirmations (people who haven't confirmed
  //    they hold the current revision — they'll all need the new one).
  try {
    const { count } = await supabase
      .from("distribution_acks")
      .select("id", { count: "exact", head: true })
      .eq("document_id", documentId)
      .is("acknowledged_at", null);
    out.pendingDistributionAcks = count ?? 0;
  } catch { /* pre-migration */ }

  return out;
}
