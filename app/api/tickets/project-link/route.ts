import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerScopedClient } from "@/lib/serverAuth";
import { ticketReadScope } from "@/lib/ticketReadScope";
import { loadCapabilityPolicyStrict, policyAllows } from "@/lib/capabilityPolicy";
import { heldRoles } from "@/lib/roleHeld";
import { deliverableStateOf } from "@/lib/ticketHandback";
import {
  callerHoldsRegisterAuthority, isMissingProjectColumn, projectLinkAllowed, projectLinkHistoryEntry, projectsTouched,
  recordProjectActivity, referenceDeliverableInProject, PROJECT_LINK_CLOSED, PROJECT_REGISTER_MANAGERS_ONLY,
} from "@/lib/ticketProject";

// POST /api/tickets/project-link  { ticketId, projectId: uuid | null, converted?: boolean }
//
// drafting-flow Round G, DF-P8 PROJECTS — GAP-114 / DEC-40: a request names
// the project it belongs to BY REFERENCE (tickets.project_id, 20261256).
// This route is the one place that link is made or removed after filing (the
// create route sets it at filing). It:
//   1. authenticates the caller, requires active membership of the ticket's
//      workspace and that they can read the ticket (AUTHZ-13's read scope);
//   2. lets the request's requester, a member who manages requests
//      (ticket.manage — read fail-closed, DEC-89 item 3), or someone who
//      manages EVERY project the change touches (can_manage_project, asked
//      as the caller: the target on a link, the current project on an
//      unlink, BOTH on a move between projects) make the change (DEC-90
//      ruling (3) for DF-P8). "Create project from this request"
//      (`converted`) is the requester's or management's alone, and only for
//      a project that names this request as its origin
//      (projects.linked_ticket_id);
//   3. reads the target project AS THE CALLER (project visibility applies —
//      a project they cannot see is "not found"), in the ticket's workspace,
//      not closed;
//   4. writes the audit row first (the workflow route's discipline, DEC-89
//      item 2: a change whose record cannot be written is refused, nothing
//      applied), then ONE compare-and-set on last_modified carrying the
//      reference, the request's one history line for the link (LEAK-4 /
//      EVID-1 / PERS-2: written by the server — the old browser
//      read-modify-write of `history` in convertTicketToProject is gone) and
//      metadata.project_link (the choice, so the paste's backfill never
//      re-links a request somebody unlinked; who made it; and whether the
//      project register's policy admits them — `registerAuthority`, read by
//      the hand-back). The history line names its audit row (`attempt`) and
//      the audit row says so (`historyAttempt`), so the SM-7 drain
//      (lib/ticketAuditDrain.ts) writes the _NOT_APPLIED row this route
//      could only log, exactly as for a workflow transition. The line names
//      NO project (ticket history is read by members who may not see a
//      private project — PROJ-9); it carries the project's id;
//   5. writes the project feed row (request_linked / request_unlinked) and,
//      when the request's deliverable is already published AND the caller
//      is someone project_documents_insert admits (is_org_controller OR
//      can_manage_project, asked as the caller — 20261102, PM-8 / SEC-17),
//      the project's register REFERENCE to that controlled document (never
//      a copy). A requester who merely sees the project links the request
//      but puts nothing on its register: the answer says a project manager
//      can attach it (DF-P8 fix pass 2). Checked; a refusal is said in
//      `warning`, the link stands.
// `converted: true` is the "Create project from this request" flow: the
// browser created the project (projects.linked_ticket_id names this request,
// PROJ-13) and links it here; the history line reads "Converted to Project".

interface Body {
  ticketId?: unknown;
  projectId?: unknown;
  converted?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function insertAuditRowOnce(row: { id: string } & Record<string, unknown>): Promise<string | null> {
  const attempt = async (): Promise<string | null> => {
    try {
      const { error } = await supabaseAdmin.from("audit_logs").insert(row);
      if (!error || (error as { code?: string }).code === "23505") return null;
      return error.message || "insert refused";
    } catch (e) {
      return (e as Error)?.message ?? String(e);
    }
  };
  return (await attempt()) && (await attempt());
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
  const projectId = body.projectId === null ? null : typeof body.projectId === "string" ? body.projectId : undefined;
  const converted = body.converted === true;
  if (!UUID_RE.test(ticketId) || projectId === undefined || (projectId !== null && !UUID_RE.test(projectId)) || (converted && projectId === null)) {
    return NextResponse.json({ error: "ticketId and projectId (a project id, or null to unlink) are required" }, { status: 400 });
  }

  const { data: row, error: loadErr } = await supabaseAdmin
    .from("tickets")
    .select("id, org_id, ticket_id, title, project_id, metadata, history, last_modified, archived_at, requester_id, assigned_drafter_id, assigned_engineer_id, watchers")
    .eq("id", ticketId)
    .maybeSingle();
  if (loadErr) {
    if (isMissingProjectColumn(loadErr)) {
      return NextResponse.json({ error: "Linking requests to projects needs database update 20261256 — ask an Admin to apply it.", code: "not_migrated" }, { status: 503 });
    }
    return NextResponse.json({ error: "Couldn't read the request — try again in a moment." }, { status: 503 });
  }
  if (!row) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  const t = row as {
    id: string; org_id: string; ticket_id: string | null; title: string | null; project_id: string | null;
    metadata: Record<string, unknown> | null; history: unknown[] | null; last_modified: string | null; archived_at: string | null;
    requester_id: string | null; assigned_drafter_id: string | null; assigned_engineer_id: string | null; watchers: string[] | null;
  };
  if (t.archived_at) return NextResponse.json({ error: "This request is archived; restore it from its archive before changing its project." }, { status: 409 });

  const { data: member, error: memErr } = await supabaseAdmin
    .from("org_members").select("uid, role, roles, email")
    .eq("org_id", t.org_id).eq("uid", caller.id).eq("status", "active").maybeSingle();
  if (memErr) return NextResponse.json({ error: "Couldn't confirm your membership — try again in a moment." }, { status: 503 });
  if (!member) return NextResponse.json({ error: "Forbidden: not an active member of this workspace" }, { status: 403 });
  const m = member as { uid: string; role: string | null; roles: string[] | null; email: string | null };
  const scope = await ticketReadScope(supabaseAdmin, m, caller.id, {
    id: t.id, requesterId: t.requester_id, assignedDrafterId: t.assigned_drafter_id, assignedEngineerId: t.assigned_engineer_id, watchers: t.watchers,
  });
  if (scope === "unknown") return NextResponse.json({ error: "Couldn't confirm you can see this request — try again in a moment." }, { status: 503 });
  if (scope === "out") return NextResponse.json({ error: "Request not found" }, { status: 404 });

  if ((t.project_id ?? null) === projectId) {
    return NextResponse.json({ ok: true, projectId, unchanged: true });
  }

  const callerClient = callerScopedClient(req);
  if ("error" in callerClient) return NextResponse.json({ error: callerClient.error }, { status: callerClient.status });

  // The project this change touches: the target (link) or the current one
  // (unlink). The target is read AS THE CALLER — one they cannot see is not
  // found, never revealed.
  type ProjectRow = { id: string; org_id: string; name: string | null; status: string | null; linked_ticket_id?: string | null };
  let target: ProjectRow | null = null;
  if (projectId) {
    const { data: p, error: pErr } = await callerClient.from("projects").select("id, org_id, name, status, linked_ticket_id").eq("id", projectId).maybeSingle();
    if (pErr) return NextResponse.json({ error: "Couldn't read that project — try again in a moment." }, { status: 503 });
    if (!p) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const found = p as ProjectRow;
    if (found.org_id !== t.org_id) return NextResponse.json({ error: "That project is in another workspace." }, { status: 400 });
    if (PROJECT_LINK_CLOSED.has(String(found.status ?? ""))) {
      return NextResponse.json({ error: `That project is ${found.status} — reopen it before adding a request to it.` }, { status: 409 });
    }
    target = found;
  }
  // The current project, by id only — its name is never read here (the
  // service role would read it past the caller's project visibility).
  const previous: { id: string } | null = t.project_id ? { id: t.project_id } : null;

  // Authority (DEC-90 ruling (3)): the requester, ticket.manage, or the
  // manager of EVERY project this change touches — the target on a link, the
  // current project on an unlink, and BOTH on a move, so the manager of one
  // project cannot take a request off a project another team manages.
  const isRequester = !!t.requester_id && t.requester_id === caller.id;
  let managesTickets = false;
  if (!isRequester) {
    const loaded = await loadCapabilityPolicyStrict(t.org_id, supabaseAdmin);
    if (!loaded.ok) return NextResponse.json({ error: "Couldn't read this workspace's permissions — try again in a moment." }, { status: 503 });
    const held = heldRoles(m);
    managesTickets = policyAllows(loaded.policy, "ticket.manage", m.role, held, caller.id);
  }
  let managesProject = false;
  const touched = projectsTouched(t.project_id, projectId);
  if (!isRequester && !managesTickets && !converted && touched.length > 0) {
    managesProject = true;
    for (const p of touched) {
      const { data: can, error: canErr } = await callerClient.rpc("can_manage_project", { p_project: p });
      if (canErr || can !== true) { managesProject = false; break; }
    }
  }
  if (!projectLinkAllowed({ isRequester, managesTickets, managesProject, converted })) {
    return NextResponse.json({
      error: converted
        ? "Only the request's requester or someone who manages requests can create a project from it."
        : touched.length > 1
          ? "Only the request's requester, someone who manages requests, or someone who manages both projects can move it to another project."
          : "Only the request's requester, someone who manages requests, or the project's managers can change which project it belongs to.",
    }, { status: 403 });
  }
  // PROJ-13: "Create project from this request" records that the target was
  // created from THIS request — the project must name it as its origin.
  if (converted && (target?.linked_ticket_id ?? null) !== t.id) {
    return NextResponse.json({ error: "That project was not created from this request — link it instead." }, { status: 400 });
  }

  // PM-8 / SEC-17 (20261102): would the register's own policy admit this
  // caller on the target? Recorded on the link (the hand-back reads it) and
  // checked before the register reference below. A project manager of every
  // touched project already answered yes for the target.
  const registerAuthority: boolean | null = target
    ? (managesProject ? true : await callerHoldsRegisterAuthority(callerClient, t.org_id, target.id))
    : false;
  const authority = isRequester ? "requester" : managesTickets ? "ticket.manage" : "project_manager";

  const now = new Date().toISOString();
  const kind: "linked" | "unlinked" | "converted" = projectId ? (converted ? "converted" : "linked") : "unlinked";
  const auditId = crypto.randomUUID();
  // SM-7: the history line names its audit row, written in the same
  // compare-and-set as the reference — the ticket itself proves it landed.
  const entry = {
    ...projectLinkHistoryEntry({
      kind, projectId: kind === "unlinked" ? previous?.id ?? null : target?.id ?? null,
      email: m.email ?? caller.email ?? null, role: m.role ?? null, now,
    }),
    attempt: auditId,
  };
  const audit = {
    id: auditId,
    action: projectId ? "TICKET_PROJECT_LINKED" : "TICKET_PROJECT_UNLINKED",
    resource_id: t.id, resource_type: "ticket", org_id: t.org_id,
    user_id: caller.id, user_email: m.email ?? caller.email ?? null, user_role: m.role ?? null,
    details: {
      projectId, previousProjectId: t.project_id ?? null, converted,
      authority, registerAuthority: registerAuthority === true,
      recordedBeforeApply: true,
      historyAttempt: true,
    },
  };
  const auditErr = await insertAuditRowOnce(audit);
  if (auditErr) {
    console.error(`[project-link] AUDIT ROW NOT WRITTEN for ${audit.action} on ticket ${t.id}: ${auditErr} — nothing applied`);
    return NextResponse.json({ error: "The change was not applied: its audit record could not be written. Try again in a moment.", code: "audit_unwritable", applied: false }, { status: 500 });
  }

  const meta = { ...(t.metadata ?? {}), project_link: { projectId, at: now, by: caller.id, authority, registerAuthority: registerAuthority === true } };
  const history = [...(Array.isArray(t.history) ? t.history : []), entry];
  let cas = supabaseAdmin.from("tickets")
    .update({ project_id: projectId, metadata: meta, history, last_modified: now })
    .eq("id", t.id);
  cas = t.last_modified ? cas.eq("last_modified", t.last_modified) : cas.is("last_modified", null);
  const { data: landed, error: updErr } = await cas.select("id");
  if (updErr || !Array.isArray(landed) || landed.length === 0) {
    const reason = updErr ? (isMissingProjectColumn(updErr) ? "not_migrated" : "write_failed") : "conflict";
    const naErr = await insertAuditRowOnce({
      id: crypto.randomUUID(), action: `${audit.action}_NOT_APPLIED`, resource_id: t.id, resource_type: "ticket", org_id: t.org_id,
      user_id: caller.id, user_email: audit.user_email, user_role: audit.user_role,
      details: { attempt: audit.id, reason, ...(updErr ? { error: updErr.message } : {}) },
    });
    if (naErr) console.error(`[project-link] could not record that ${audit.action} (audit row ${audit.id}) was NOT applied (${reason}): ${naErr}`);
    if (reason === "conflict") return NextResponse.json({ error: "The request changed while you were acting — refresh and try again.", conflict: true }, { status: 409 });
    if (reason === "not_migrated") return NextResponse.json({ error: "Linking requests to projects needs database update 20261256 — ask an Admin to apply it.", code: "not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "The change was not saved — try again in a moment." }, { status: 500 });
  }

  // The project side: the feed row (and, on a link, the deliverable's
  // register reference when it is already published). Checked, said.
  const warnings: string[] = [];
  const label = `${t.ticket_id ?? "A drafting request"}${t.title ? ` — ${t.title}` : ""}`;
  const actorName = m.email ?? caller.email ?? null;
  if (previous) {
    // PROJ-13: a project created from this request names it (linked_ticket_id);
    // moving the request off that project clears the name, so a mislink is
    // corrected in one place. Only that exact pairing is touched; checked.
    const { error: chipErr } = await supabaseAdmin.from("projects")
      .update({ linked_ticket_id: null }).eq("id", previous.id).eq("linked_ticket_id", t.id).select("id");
    if (chipErr) warnings.push(`The previous project still names this request as its origin: ${chipErr.message}`);
    const err = await recordProjectActivity(supabaseAdmin, {
      projectId: previous.id, orgId: t.org_id, userId: caller.id, userName: actorName,
      type: "request_unlinked", body: `${label} no longer belongs to this project`,
      metadata: { ticketId: t.id, ticketNumber: t.ticket_id, movedTo: projectId },
    });
    if (err) warnings.push(`The previous project's feed was not told: ${err}`);
  }
  if (target) {
    const err = await recordProjectActivity(supabaseAdmin, {
      projectId: target.id, orgId: t.org_id, userId: caller.id, userName: actorName,
      type: "request_linked", body: converted ? `${label} — this project was created from it` : `${label} linked to this project`,
      metadata: { ticketId: t.id, ticketNumber: t.ticket_id, converted },
    });
    if (err) warnings.push(`The project's feed was not told: ${err}`);
    const d = deliverableStateOf(t.metadata);
    if (d?.state === "published" && typeof d.document_id === "string" && d.document_id) {
      if (registerAuthority === true) {
        const refErr = await referenceDeliverableInProject(supabaseAdmin, {
          orgId: t.org_id, projectId: target.id, documentId: d.document_id, ticketId: t.id, ticketNumber: t.ticket_id,
          revisionLabel: d.revision_label ?? null, actorId: caller.id, actorName,
        });
        if (refErr) warnings.push(`The request's published deliverable was not put on the project's register: ${refErr}`);
      } else {
        warnings.push(registerAuthority === null
          ? "The request's published deliverable was not put on the project's document register: your authority over the register could not be confirmed — a project manager can attach it from the project's Documents card."
          : PROJECT_REGISTER_MANAGERS_ONLY);
      }
    }
  }
  if (warnings.length) console.warn(`[project-link] ${t.id}: ${warnings.join(" | ")}`);
  return NextResponse.json({ ok: true, projectId, ...(warnings.length ? { warning: warnings.join(" ") } : {}) });
}
