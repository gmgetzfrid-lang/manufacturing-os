// GET /api/intake/resolve?token=<intake token>
//
// Public resolution for a project-intake submit link. Gated ONLY by
// possession of the unguessable token (the contracted company has no
// account). Returns the minimum the portal needs: project/company identity
// and the register of documents THIS LINK submitted — never the org's other
// content. Revoked/expired links answer with their state so the portal can
// explain instead of 404ing.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

export interface IntakeItem {
  docId: string;
  label: string;
  rev: string | null;
  status: string | null;
  pendingReview: boolean;
  updatedAt: string | null;
}

export async function GET(req: NextRequest) {
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const { data: link } = await supabaseAdmin
    .from("project_intake_links")
    .select("id, org_id, project_id, company_name, allow_auto_supersede, expires_at, revoked_at, assigned_doc_ids")
    .eq("token", token)
    .maybeSingle();
  if (!link) return NextResponse.json({ error: "notfound" }, { status: 404 });
  if (link.revoked_at) return NextResponse.json({ error: "revoked" }, { status: 410 });
  if (link.expires_at && Date.parse(link.expires_at as string) < Date.now()) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  const { data: project } = await supabaseAdmin
    .from("projects").select("name").eq("id", link.project_id as string).maybeSingle();
  const { data: org } = await supabaseAdmin
    .from("orgs").select("name").eq("id", link.org_id as string).maybeSingle();

  // The register: every document this link has ever submitted a version of.
  const { data: vers } = await supabaseAdmin
    .from("document_versions")
    .select("record_id")
    .eq("intake_link_id", link.id as string);
  // Register = documents this link authored PLUS documents assigned to it
  // ("revise these drawings of ours" — always via review).
  const assigned = ((link.assigned_doc_ids as string[] | null) ?? []);
  const docIds = [...new Set([
    ...((vers ?? []) as Array<{ record_id: string }>).map((v) => v.record_id),
    ...assigned,
  ])];

  let items: IntakeItem[] = [];
  if (docIds.length) {
    const { data: docs } = await supabaseAdmin
      .from("documents")
      .select("id, document_number, title, name, rev, status, pending_version_id, updated_at")
      .in("id", docIds)
      .order("updated_at", { ascending: false });
    items = (((docs ?? []) as Array<Record<string, unknown>>)).map((d) => ({
      docId: String(d.id),
      label: String(d.document_number || d.title || d.name || "Document"),
      rev: (d.rev as string | null) ?? null,
      status: (d.status as string | null) ?? null,
      pendingReview: !!d.pending_version_id,
      updatedAt: (d.updated_at as string | null) ?? null,
    }));
  }

  // Redline requests: open collision tickets that reference this link —
  // the org asking the company for markups against the conflict.
  const OPEN_STATUSES = [
    "NEW", "PENDING_ENG_INITIAL", "PENDING_ENG_TEAM", "PENDING_ASSIGNMENT",
    "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL",
    "PENDING_IFC", "FINAL_DRAFT",
  ];
  let redlineRequests: Array<{ ticketRef: string; ticketNumber: string | null; title: string; docLabel: string | null }> = [];
  try {
    const { data: tickets } = await supabaseAdmin
      .from("tickets")
      .select("id, ticket_id, title, status, metadata")
      .eq("org_id", link.org_id as string)
      .eq("metadata->intake_collision->>intakeLinkId", link.id as string)
      .in("status", OPEN_STATUSES)
      .limit(20);
    redlineRequests = (((tickets ?? []) as Array<Record<string, unknown>>)).map((t) => {
      const meta = (t.metadata ?? {}) as { source_document?: { number?: string | null; title?: string | null } };
      return {
        ticketRef: String(t.id),
        ticketNumber: (t.ticket_id as string | null) ?? null,
        title: String(t.title ?? "Collision ticket"),
        docLabel: meta.source_document?.number || meta.source_document?.title || null,
      };
    });
  } catch { /* slice empty */ }

  return NextResponse.json({
    projectName: (project?.name as string | null) ?? "Project",
    orgName: (org?.name as string | null) ?? null,
    companyName: link.company_name,
    allowAutoSupersede: !!link.allow_auto_supersede,
    items,
    redlineRequests,
  });
}
