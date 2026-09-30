// GET /api/intake/resolve?token=<intake token>
//
// Public resolution for a project-intake submit link. Gated ONLY by
// possession of the unguessable token (the contracted company has no
// account). Returns the minimum the portal needs: project/company identity
// and the register of documents THIS LINK submitted or was assigned — never
// the org's other content. Revoked/expired links answer with their state so
// the portal can explain instead of 404ing; so does a link whose project is
// gone (PM-2) or closed (PM-1's route limb) — never a generic "Project".
// Every document read is scoped to the link's org (INTK-9 / SEC-11), and a
// rejected submission carries the reviewer's reason (SAF-9).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { parseSourceDocument } from "@/lib/sourceDocRef";
import { INTAKE_TOKEN_RE, CLOSED_PROJECT_STATUSES } from "@/lib/intakeLinks";

export const runtime = "nodejs";

export interface IntakeItem {
  docId: string;
  label: string;
  rev: string | null;
  status: string | null;
  pendingReview: boolean;
  /** The link's LAST submission outcome for this doc when nothing is
   *  pending: "rejected" | "approved" | null (no submission yet). */
  lastOutcome: "rejected" | "approved" | null;
  /** SAF-9: the reviewer's reason, when the last submission was rejected. */
  rejectionReason?: string | null;
  updatedAt: string | null;
}

export async function GET(req: NextRequest) {
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  if (!INTAKE_TOKEN_RE.test(token)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const { data: link, error: linkErr } = await supabaseAdmin
    .from("project_intake_links")
    .select("id, org_id, project_id, company_name, allow_auto_supersede, expires_at, revoked_at, assigned_doc_ids")
    .eq("token", token)
    .maybeSingle();
  if (linkErr) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  if (!link) return NextResponse.json({ error: "notfound" }, { status: 404 });
  if (link.revoked_at) return NextResponse.json({ error: "revoked" }, { status: 410 });
  if (link.expires_at && Date.parse(link.expires_at as string) < Date.now()) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  const orgId = String(link.org_id);

  const { data: project, error: projErr } = await supabaseAdmin
    .from("projects").select("name, status").eq("id", link.project_id as string).eq("org_id", orgId).maybeSingle();
  if (projErr) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  // PM-2: a link whose project is gone opens nothing — a definite answer,
  // not a portal that still lists the org's documents under "Project".
  if (!project) return NextResponse.json({ error: "link_gone" }, { status: 410 });
  if (CLOSED_PROJECT_STATUSES.has(String((project as { status?: string | null }).status ?? ""))) {
    return NextResponse.json({ error: "project_closed" }, { status: 410 });
  }
  const { data: org } = await supabaseAdmin
    .from("orgs").select("name").eq("id", link.org_id as string).maybeSingle();

  // Link purpose, fetched tolerantly — the column arrives with 20261013 and
  // a pre-migration deployment must keep serving document links unchanged.
  let purpose = "documents";
  let rfqGroup: string | null = null;
  {
    const { data: p, error: pErr } = await supabaseAdmin
      .from("project_intake_links").select("purpose, rfq_group").eq("id", link.id as string).maybeSingle();
    if (!pErr && p) {
      purpose = String((p as { purpose?: string | null }).purpose ?? "documents");
      rfqGroup = ((p as { rfq_group?: string | null }).rfq_group ?? null);
    }
  }

  // ── Quote links: the register is the company's own quote submissions,
  // not a document list. ──
  if (purpose === "quote") {
    const { data: quotes } = await supabaseAdmin
      .from("cost_documents")
      .select("id, file_name, status, total_amount, created_at")
      .eq("intake_link_id", link.id as string)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }).limit(50);
    return NextResponse.json({
      purpose: "quote",
      rfqGroup,
      expiresAt: (link.expires_at as string | null) ?? null,
      projectName: (project?.name as string | null) ?? "Project",
      orgName: (org?.name as string | null) ?? null,
      companyName: link.company_name,
      allowAutoSupersede: false,
      items: [],
      redlineRequests: [],
      quotes: (((quotes ?? []) as Array<Record<string, unknown>>)).map((q) => ({
        id: String(q.id),
        fileName: (q.file_name as string | null) ?? "Quote",
        // The company sees whether their price was picked — not the numbers.
        // A voided (withdrawn) quote reads as not selected, never as a bid
        // that is still live.
        status: q.status === "awarded" ? "awarded"
          : q.status === "declined" || q.status === "void" ? "not_selected"
          : "under_review",
        submittedAt: (q.created_at as string | null) ?? null,
      })),
    });
  }

  // The register: every document this link has ever submitted a version of.
  // SAF-9: the reviewer's note travels with a rejection (tolerant of a
  // database without the 20261105 column).
  const readVersions = (cols: string) => supabaseAdmin
    .from("document_versions")
    .select(cols)
    .eq("intake_link_id", link.id as string)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  let { data: vers, error: versErr } = await readVersions("record_id, review_state, review_note, released_at, created_at");
  if (versErr && /review_note/.test(versErr.message ?? "")) {
    ({ data: vers, error: versErr } = await readVersions("record_id, review_state, released_at, created_at"));
  }
  if (versErr) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  // Latest submission outcome per doc (rows arrive newest-first). A
  // submission published directly by a trusted link (no review_state, a
  // release date) counts as approved; a displaced one ('superseded') has
  // no outcome of its own.
  const latestOutcome = new Map<string, { outcome: "rejected" | "approved" | null; reason: string | null }>();
  for (const v of ((vers ?? []) as unknown as Array<{ record_id: string; review_state: string | null; review_note?: string | null; released_at?: string | null }>)) {
    if (latestOutcome.has(v.record_id)) continue;
    latestOutcome.set(v.record_id, {
      outcome: v.review_state === "rejected" ? "rejected"
        : v.review_state === "approved" || (v.review_state == null && v.released_at != null) ? "approved"
        : null,
      reason: v.review_state === "rejected" ? (v.review_note ?? null) : null,
    });
  }
  // Documents this link CREATED (INTK-1's authorship fact) — so a
  // published revision whose provenance stamp failed still lists.
  const authored: string[] = [];
  {
    const { data: own, error: ownErr } = await supabaseAdmin
      .from("documents").select("id").eq("org_id", orgId).eq("authored_by_link_id", link.id as string).limit(500);
    if (!ownErr) authored.push(...(((own ?? []) as Array<{ id: string }>).map((d) => String(d.id))));
  }
  // Register = documents this link authored PLUS documents assigned to it
  // ("revise these drawings of ours" — always via review).
  const assigned = ((link.assigned_doc_ids as string[] | null) ?? []);
  const docIds = [...new Set([
    ...((vers ?? []) as unknown as Array<{ record_id: string }>).map((v) => v.record_id),
    ...authored,
    ...assigned,
  ])];

  let items: IntakeItem[] = [];
  if (docIds.length) {
    // INTK-9 / SEC-11: an id in the list that is not the link's org's
    // resolves to nothing.
    const { data: docs, error: docsErr } = await supabaseAdmin
      .from("documents")
      .select("id, document_number, title, name, rev, status, pending_version_id, updated_at")
      .in("id", docIds)
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false });
    if (docsErr) return NextResponse.json({ error: "unavailable" }, { status: 503 });
    items = (((docs ?? []) as Array<Record<string, unknown>>)).map((d) => {
      const last = latestOutcome.get(String(d.id));
      return {
        docId: String(d.id),
        label: String(d.document_number || d.title || d.name || "Document"),
        rev: (d.rev as string | null) ?? null,
        status: (d.status as string | null) ?? null,
        pendingReview: !!d.pending_version_id,
        lastOutcome: last?.outcome ?? null,
        rejectionReason: last?.reason ?? null,
        updatedAt: (d.updated_at as string | null) ?? null,
      };
    });
  }

  // Redline requests: open collision tickets that reference this link —
  // the org asking the company for markups against the conflict.
  const OPEN_STATUSES = [
    "PENDING_ENG_TEAM", "PENDING_ASSIGNMENT",
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
      // LIFE-15: the parser accepts the canonical shape and every legacy one.
      const src = parseSourceDocument((t.metadata ?? null) as Record<string, unknown> | null);
      return {
        ticketRef: String(t.id),
        ticketNumber: (t.ticket_id as string | null) ?? null,
        title: String(t.title ?? "Collision ticket"),
        docLabel: src?.documentNumber || src?.title || null,
      };
    });
  } catch { /* slice empty */ }

  return NextResponse.json({
    purpose: "documents",
    expiresAt: (link.expires_at as string | null) ?? null,
    projectName: (project?.name as string | null) ?? "Project",
    orgName: (org?.name as string | null) ?? null,
    companyName: link.company_name,
    allowAutoSupersede: !!link.allow_auto_supersede,
    items,
    redlineRequests,
  });
}
