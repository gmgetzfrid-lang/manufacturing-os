// POST /api/intake/upload  (multipart)
//
// The external door's submit endpoint. Token-gated (no account); the server
// does everything: stores the file in R2, creates the document/version with
// provenance 'external' and the company stamped, routes it through review
// (pending revision) or — for trusted links — auto-supersedes the link's OWN
// prior submission, and notifies the project team. A link can never touch a
// document it didn't author: own-work is proven by intake_link_id on the
// version chain, checked here on every call.
//
// Fields: token, file, and either docId (new revision of an existing intake
// document) or title [+ number] (brand-new document). Optional revLabel.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try { form = await req.formData(); } catch { return bad("Expected multipart form data"); }

  const token = String(form.get("token") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return bad("invalid token");

  const { data: link } = await supabaseAdmin
    .from("project_intake_links")
    .select("id, org_id, project_id, company_name, contact_email, allow_auto_supersede, expires_at, revoked_at, assigned_doc_ids")
    .eq("token", token)
    .maybeSingle();
  if (!link) return bad("notfound", 404);
  if (link.revoked_at) return bad("This link has been revoked.", 410);
  if (link.expires_at && Date.parse(link.expires_at as string) < Date.now()) return bad("This link has expired.", 410);

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return bad("A file is required.");
  if (file.size > MAX_BYTES) return bad("File exceeds the 100 MB limit.");

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

  // ── Quote branch: this link submits PRICES, not drawings. The file lands
  // as a cost_document (kind 'quote') for the project's bid tabulation —
  // it never touches document control. ──
  if (purpose === "quote") {
    const orgIdQ = String(link.org_id);
    const projectIdQ = String(link.project_id);
    const companyQ = String(link.company_name);
    const noteQ = String(form.get("changeNote") ?? "").trim().slice(0, 2000) || null;

    const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "quote";
    const key = `orgs/${orgIdQ}/project-costs/${projectIdQ}/quote-${crypto.randomUUID()}-${safeName}`;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: key, Body: bytes,
        ContentType: file.type || "application/octet-stream",
      }));
    } catch (e) {
      console.error("[intake/upload] R2 put failed (quote)", e);
      return bad("File storage failed — try again.", 502);
    }

    const { data: qdoc, error: qErr } = await supabaseAdmin.from("cost_documents").insert({
      org_id: orgIdQ, project_id: projectIdQ,
      kind: "quote",
      file_url: key, file_name: file.name, mime_type: file.type || null,
      vendor_name: companyQ,
      rfq_group: rfqGroup,
      intake_link_id: link.id,
      status: "draft",
      created_by: null,
    }).select("id").single();
    if (qErr || !qdoc) return bad(`Couldn't record the quote: ${qErr?.message ?? "unknown"}`, 500);
    const quoteId = String(qdoc.id);

    const { data: projQ } = await supabaseAdmin
      .from("projects").select("owner_user_id, name").eq("id", projectIdQ).maybeSingle();
    const { data: controllersQ } = await supabaseAdmin
      .from("org_members").select("uid").eq("org_id", orgIdQ).eq("status", "active").in("role", ["Admin", "DocCtrl"]);
    const targetsQ = [...new Set([
      ...(((controllersQ ?? []) as Array<{ uid: string }>).map((c) => c.uid)),
      ...(projQ?.owner_user_id ? [String(projQ.owner_user_id)] : []),
    ])];
    await supabaseAdmin.from("notifications").insert(targetsQ.map((uid) => ({
      org_id: orgIdQ, user_id: uid,
      kind: "review_requested",
      title: `Quote received: ${companyQ}${rfqGroup ? ` — ${rfqGroup}` : ""}`,
      body: `${companyQ} submitted a quote through their intake link.${noteQ ? ` Note: ${noteQ}` : ""} Run the AI read from the project's Costs tab to tabulate it.`,
      link: `/projects/${projectIdQ}?tab=costs`,
      resource_type: "cost", resource_id: quoteId,
      actor_name: companyQ,
      metadata: { intake: true, quote: true, rfqGroup },
    }))).then(() => undefined, () => undefined);

    await supabaseAdmin.from("audit_logs").insert({
      action: "INTAKE_QUOTE_SUBMISSION",
      resource_type: "cost", resource_id: quoteId,
      org_id: orgIdQ, user_id: null, user_email: link.contact_email ?? null,
      details: { company: companyQ, projectId: projectIdQ, rfqGroup, fileName: safeName, size: file.size, note: noteQ },
    }).then(() => undefined, () => undefined);
    await supabaseAdmin.rpc("bump_intake_use", { p_link: link.id }).then(() => undefined, () => undefined);

    return NextResponse.json({
      ok: true,
      quoteId,
      status: "quote_received",
      message: `Your quote is in — ${String(projQ?.name ?? "the project")}'s team has been notified. You'll be contacted about the award decision.`,
    });
  }

  const docId = String(form.get("docId") ?? "").trim() || null;
  const ticketId = String(form.get("ticketId") ?? "").trim() || null;
  const title = String(form.get("title") ?? "").trim() || null;
  const number = String(form.get("number") ?? "").trim() || null;
  const revLabel = (String(form.get("revLabel") ?? "").trim() || (docId ? "" : "A")).slice(0, 24);
  const changeNote = String(form.get("changeNote") ?? "").trim().slice(0, 2000) || null;
  if (!ticketId && !docId && !title) return bad("A title is required for a new document.");
  if (docId && !revLabel) return bad("A revision label is required.");

  const orgId = String(link.org_id);
  const projectId = String(link.project_id);
  const company = String(link.company_name);
  const nowIso = new Date().toISOString();

  // ── Redline branch: markups for a collision ticket that references this
  // link. The file attaches to the ticket (REDLINE_ prefix — the drafter's
  // revision banner surfaces it), never touches any document. ──
  if (ticketId) {
    const { data: ticket } = await supabaseAdmin
      .from("tickets")
      .select("id, ticket_id, title, attachments, history, metadata, assigned_drafter_id, requester_id")
      .eq("id", ticketId).eq("org_id", orgId).maybeSingle();
    if (!ticket) return bad("Ticket not found.", 404);
    const meta = (ticket.metadata ?? {}) as { intake_collision?: { intakeLinkId?: string | null } };
    if (String(meta.intake_collision?.intakeLinkId ?? "") !== String(link.id)) {
      return bad("This link may only attach redlines to its own collision tickets.", 403);
    }

    const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "redline";
    const key = `orgs/${orgId}/project-intake/${projectId}/redlines/${crypto.randomUUID()}-${safeName}`;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: key, Body: bytes,
        ContentType: file.type || "application/octet-stream",
      }));
    } catch (e) {
      console.error("[intake/upload] R2 put failed (redline)", e);
      return bad("File storage failed — try again.", 502);
    }

    const attachment = {
      id: crypto.randomUUID(),
      name: `REDLINE_${safeName}`,
      url: key,
      type: "Reference",
      status: "submitted",
      size: `${(file.size / (1024 * 1024)).toFixed(2)} MB`,
      uploadedBy: `${company} (intake)`,
      uploadedAt: nowIso,
    };
    const { error: updErr } = await supabaseAdmin.from("tickets").update({
      attachments: [...((ticket.attachments as unknown[] | null) ?? []), attachment],
      history: [...((ticket.history as unknown[] | null) ?? []), {
        action: "Redline markups received via intake portal",
        user: company, date: nowIso,
        details: changeNote || safeName,
      }],
      last_modified: nowIso,
    }).eq("id", ticketId);
    if (updErr) return bad(`Couldn't attach the redline: ${updErr.message}`, 500);

    const targets = [...new Set([
      ...(ticket.assigned_drafter_id ? [String(ticket.assigned_drafter_id)] : []),
      ...(ticket.requester_id ? [String(ticket.requester_id)] : []),
    ])];
    await supabaseAdmin.from("notifications").insert(targets.map((uidT) => ({
      org_id: orgId, user_id: uidT,
      kind: "ticket_comment",
      title: `Redlines received: ${String(ticket.title ?? "collision ticket")}`,
      body: `${company} uploaded redline markups through their intake portal.${changeNote ? ` Note: ${changeNote}` : ""}`,
      link: `/requests/${ticketId}`,
      resource_type: "ticket", resource_id: ticketId,
      actor_name: company,
      metadata: { intake: true, redline: true },
    }))).then(() => undefined, () => undefined);

    await supabaseAdmin.from("audit_logs").insert({
      action: "INTAKE_REDLINE",
      resource_type: "ticket", resource_id: ticketId,
      org_id: orgId, user_id: null, user_email: link.contact_email ?? null,
      details: { company, projectId, ticketNumber: ticket.ticket_id, fileName: safeName, size: file.size, note: changeNote },
    }).then(() => undefined, () => undefined);
    await supabaseAdmin.rpc("bump_intake_use", { p_link: link.id }).then(() => undefined, () => undefined);

    return NextResponse.json({
      ok: true,
      ticketId,
      status: "redline_received",
      message: `Redlines attached to ${String(ticket.ticket_id ?? "the ticket")} — the drafting team has been notified.`,
    });
  }

  // ── Resolve the project's intake home (library + folder) ──
  const { data: project } = await supabaseAdmin
    .from("projects").select("id, name, owner_user_id, intake_library_id, intake_collection_id")
    .eq("id", projectId).maybeSingle();
  if (!project) return bad("Project not found.", 404);
  const libraryId = (project.intake_library_id as string | null) ?? null;
  if (!libraryId) return bad("This link isn't fully configured yet — ask your contact to set the intake library.", 409);
  let collectionId = (project.intake_collection_id as string | null) ?? null;
  if (!collectionId) {
    const { data: col, error: colErr } = await supabaseAdmin
      .from("collections")
      .insert({ org_id: orgId, library_id: libraryId, name: `Intake — ${String(project.name ?? "Project")}` })
      .select("id").single();
    if (colErr || !col) return bad("Couldn't prepare the intake folder.", 500);
    collectionId = String(col.id);
    await supabaseAdmin.from("projects").update({ intake_collection_id: collectionId }).eq("id", projectId);
  }

  // ── Scope check for revisions: link-authored OR explicitly assigned ──
  let targetDoc: Record<string, unknown> | null = null;
  let linkAuthored = false;
  if (docId) {
    const { data: owned } = await supabaseAdmin
      .from("document_versions").select("id").eq("record_id", docId).eq("intake_link_id", link.id as string).limit(1);
    linkAuthored = !!owned?.length;
    const isAssigned = (((link.assigned_doc_ids as string[] | null) ?? [])).includes(docId);
    if (!linkAuthored && !isAssigned) {
      return bad("This link may only submit revisions to its own or assigned documents.", 403);
    }
    const { data: d } = await supabaseAdmin
      .from("documents").select("id, document_number, title, name, rev, current_version_id, pending_version_id")
      .eq("id", docId).maybeSingle();
    if (!d) return bad("Document not found.", 404);
    if (d.pending_version_id && !(link.allow_auto_supersede && linkAuthored)) {
      return bad("Your previous submission for this document is still in review — it must be approved or rejected first.", 409);
    }
    targetDoc = d as Record<string, unknown>;
  }

  // ── Store the bytes ──
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file";
  const key = `orgs/${orgId}/project-intake/${projectId}/${crypto.randomUUID()}-${safeName}`;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key, Body: bytes,
      ContentType: file.type || "application/octet-stream",
    }));
  } catch (e) {
    console.error("[intake/upload] R2 put failed", e);
    return bad("File storage failed — try again.", 502);
  }

  const label = targetDoc
    ? String(targetDoc.document_number || targetDoc.title || targetDoc.name || "Document")
    : (number || title || "Document");

  // ── Create document (new) ──
  let documentId = docId;
  if (!documentId) {
    const { data: doc, error: docErr } = await supabaseAdmin
      .from("documents")
      .insert({
        org_id: orgId, library_id: libraryId, collection_id: collectionId,
        name: title, title, document_number: number,
        status: "Draft",
        created_by_name: `${company} (intake)`,
        updated_at: nowIso,
      })
      .select("id").single();
    if (docErr || !doc) return bad(`Couldn't create the document: ${docErr?.message ?? "unknown"}`, 500);
    documentId = String(doc.id);
  }

  // ── Create the version ──
  // Auto-supersede is a trusted-link shortcut for LINK-AUTHORED documents
  // only; an assigned org-authored controlled drawing ALWAYS goes through
  // review, whatever the link's trust level.
  const autoNow = !!docId && !!link.allow_auto_supersede && linkAuthored;
  const { data: ver, error: verErr } = await supabaseAdmin
    .from("document_versions")
    .insert({
      org_id: orgId, record_id: documentId,
      revision_label: revLabel || "A",
      file_url: key, file_type: file.type || null, size: file.size,
      change_log: changeNote ?? `Submitted by ${company} via project intake`,
      created_by_name: company, created_at: nowIso,
      released_at: autoNow ? nowIso : null,
      review_state: autoNow ? "approved" : "in_review",
      provenance: "external",
      intake_link_id: link.id,
      supersedes_version_id: autoNow ? ((targetDoc?.current_version_id as string | null) ?? null) : null,
    })
    .select("id").single();
  if (verErr || !ver) return bad(`Couldn't record the submission: ${verErr?.message ?? "unknown"}`, 500);
  const versionId = String(ver.id);

  // ── Route it: pending review, or trusted own-work supersede ──
  if (autoNow) {
    const prevCurrent = (targetDoc?.current_version_id as string | null) ?? null;
    await supabaseAdmin.from("documents")
      .update({ current_version_id: versionId, rev: revLabel || "A", revision: revLabel || "A", status: "Issued", pending_version_id: null, updated_at: nowIso })
      .eq("id", documentId);
    if (prevCurrent) {
      await supabaseAdmin.from("document_versions").update({ superseded_at: nowIso }).eq("id", prevCurrent);
    }
  } else {
    await supabaseAdmin.from("documents")
      .update({ pending_version_id: versionId, updated_at: nowIso })
      .eq("id", documentId);
  }

  // ── Notify the project team + audit ──
  const { data: controllers } = await supabaseAdmin
    .from("org_members").select("uid").eq("org_id", orgId).eq("status", "active").in("role", ["Admin", "DocCtrl"]);
  const targets = [...new Set([
    ...(((controllers ?? []) as Array<{ uid: string }>).map((c) => c.uid)),
    ...(project.owner_user_id ? [String(project.owner_user_id)] : []),
  ])];
  const intakeTitle = autoNow
    ? `Intake: ${label} superseded to Rev ${revLabel || "A"} by ${company}`
    : `Intake submission awaiting review: ${label} (${company})`;
  const intakeBody = autoNow
    ? `${company} published a new revision through their trusted intake link. It is now current.`
    : `${company} submitted ${docId ? `Rev ${revLabel}` : "a new document"} on the project — review and approve it from the project's Intake tab.`;
  await supabaseAdmin.from("notifications").insert(targets.map((uid) => ({
    org_id: orgId, user_id: uid,
    kind: autoNow ? "doc_superseded" : "review_requested",
    title: intakeTitle,
    body: intakeBody,
    link: `/projects/${projectId}`,
    resource_type: "document", resource_id: documentId,
    actor_name: company,
    metadata: { intake: true, versionId },
  }))).then(() => undefined, () => undefined);

  // Email leg — an external submission sitting unreviewed is exactly what a
  // controller wants in their inbox, not just behind a bell icon. Queued
  // rows honor delivery config; the drain kick makes it land in seconds.
  try {
    const { data: targetMembers } = await supabaseAdmin
      .from("org_members").select("uid, email").eq("org_id", orgId).in("uid", targets);
    const rows = ((targetMembers ?? []) as Array<{ uid: string; email: string | null }>)
      .filter((m) => m.email)
      .map((m) => ({
        org_id: orgId, to_user_id: m.uid, to_email: m.email as string,
        subject: intakeTitle,
        body_text: `${intakeBody}\n\nOpen the project: /projects/${projectId}`,
        resource_type: "document", resource_id: documentId,
        event_type: "watcher_activity", status: "queued",
        metadata: { intake: true, versionId },
      }));
    if (rows.length > 0) {
      await supabaseAdmin.from("email_notifications").insert(rows);
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        void fetch(`${req.nextUrl.origin}/api/notifications/send-queued`, {
          method: "POST", headers: { Authorization: `Bearer ${cronSecret}` },
        }).catch(() => undefined);
      }
    }
  } catch { /* best-effort — the submission itself already succeeded */ }

  await supabaseAdmin.from("audit_logs").insert({
    action: autoNow ? "INTAKE_AUTO_SUPERSEDE" : "INTAKE_SUBMISSION",
    resource_type: "document", resource_id: documentId,
    org_id: orgId, user_id: null, user_email: link.contact_email ?? null,
    details: { company, projectId, versionId, revLabel: revLabel || "A", fileName: safeName, size: file.size },
  }).then(() => undefined, () => undefined);
  await supabaseAdmin.rpc("bump_intake_use", { p_link: link.id }).then(() => undefined, () => undefined);

  return NextResponse.json({
    ok: true,
    documentId,
    versionId,
    status: autoNow ? "published" : "in_review",
    message: autoNow
      ? `Rev ${revLabel || "A"} of ${label} is now the current revision.`
      : `Submitted — ${label} is with the project team for review. You'll see it marked approved here once accepted.`,
  });
}
