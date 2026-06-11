import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { WorkflowEngine } from "@/lib/workflow";
import {
  computeTransition,
  classifyTransitionNotification,
  rowToTicket,
  escapeHtml,
  type TransitionInput,
} from "@/lib/ticketTransitions";
import type { Role, TicketAttachment } from "@/types/schema";

// POST /api/tickets/workflow-action
//
// SERVER-SIDE workflow enforcement. The client sends only its inputs (action
// name + comment/picks/uploads); this route:
//   1. authenticates the caller (bearer token)
//   2. verifies active org membership and reads their role
//   3. validates the action against WorkflowEngine.getActions — the same
//      state machine the UI renders, now enforced where the client can't lie
//   4. recomputes the full update server-side (lib/ticketTransitions)
//   5. applies it compare-and-set on status (concurrent transitions -> 409)
//   6. writes the audit row and fans out notifications + emails server-side,
//      so neither can be skipped by a closed tab or a tampered client.

interface Body {
  ticketId: string;
  actionType: string;
  comment?: string | null;
  preFilledComment?: string | null;
  category?: string | null;
  isReassigning?: boolean;
  assignment?: { id: string; name: string } | null;
  engineer?: { id: string; name: string; email: string } | null;
  redlineAttachment?: TicketAttachment | null;
  finalAttachment?: TicketAttachment | null;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.ticketId || !body.actionType) {
    return NextResponse.json({ error: "ticketId and actionType are required" }, { status: 400 });
  }

  // Load the ticket (service role — RLS doesn't apply; we enforce explicitly).
  const { data: row, error: loadErr } = await supabaseAdmin
    .from("tickets")
    .select("*")
    .eq("id", body.ticketId)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  const ticket = rowToTicket(row as Record<string, unknown>);

  // Active membership in the ticket's org + the caller's role.
  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, email, display_name")
    .eq("org_id", ticket.orgId)
    .eq("uid", caller.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "Forbidden: not an active member of this workspace" }, { status: 403 });
  }
  const callerRole = (member.role as Role) ?? "Viewer";
  const callerEmail = (member.email as string | null) || caller.email || "Unknown";

  // THE enforcement: the action must be one the state machine offers this
  // caller at the ticket's current status.
  const allowed = WorkflowEngine.getActions(ticket, callerRole, caller.id);
  const action = allowed.find((a) => a.action === body.actionType);
  if (!action) {
    return NextResponse.json(
      { error: `Action "${body.actionType}" is not available to you at status ${ticket.status}` },
      { status: 403 },
    );
  }
  if (action.requiresComment && !body.comment?.trim()) {
    return NextResponse.json({ error: "This action requires a comment" }, { status: 400 });
  }
  if (action.requiresEngineerPick && !body.engineer?.id) {
    return NextResponse.json({ error: "This action requires picking an engineer" }, { status: 400 });
  }

  // Referenced people must be active members of the same org — and a picked
  // "engineer" must actually hold an engineer role (headline or additive).
  for (const ref of [body.engineer?.id, body.assignment?.id].filter(Boolean) as string[]) {
    const { data: refMember } = await supabaseAdmin
      .from("org_members")
      .select("uid, role, roles")
      .eq("org_id", ticket.orgId)
      .eq("uid", ref)
      .eq("status", "active")
      .maybeSingle();
    if (!refMember) {
      return NextResponse.json({ error: "Referenced user is not an active member of this workspace" }, { status: 400 });
    }
    if (ref === body.engineer?.id) {
      const held: string[] = Array.isArray(refMember.roles) && refMember.roles.length > 0
        ? (refMember.roles as string[])
        : [String(refMember.role ?? "")];
      if (!held.some((r) => r.includes("Engineer"))) {
        return NextResponse.json({ error: "The selected reviewer does not hold an Engineer role" }, { status: 400 });
      }
    }
  }

  const input: TransitionInput = {
    actionType: action.action,
    actionLabel: action.label,
    variant: action.variant,
    comment: body.comment ?? undefined,
    preFilledComment: body.preFilledComment ?? undefined,
    category: body.category ?? undefined,
    isReassigning: body.isReassigning,
    assignment: body.assignment ?? undefined,
    engineer: body.engineer ?? undefined,
    redlineAttachment: body.redlineAttachment ?? undefined,
    finalAttachment: body.finalAttachment ?? undefined,
    actor: { uid: caller.id, email: callerEmail, role: callerRole },
  };
  const { updates, newStatus, recipients } = computeTransition(ticket, input);

  // Compare-and-set on the status we validated against. If another reviewer
  // moved the ticket since, refuse to clobber their transition.
  const { data: updated, error: updErr } = await supabaseAdmin
    .from("tickets")
    .update(updates)
    .eq("id", body.ticketId)
    .eq("status", ticket.status)
    .select("id")
    .maybeSingle();
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  if (!updated) {
    return NextResponse.json(
      { error: "The ticket changed while you were acting — refresh and try again", conflict: true },
      { status: 409 },
    );
  }

  // Audit — server-written, cannot be skipped by the client.
  await supabaseAdmin.from("audit_logs").insert({
    action: `TICKET_${action.action.toUpperCase()}`,
    resource_id: body.ticketId,
    resource_type: "ticket",
    org_id: ticket.orgId,
    user_id: caller.id,
    user_email: callerEmail,
    user_role: callerRole,
    details: { from: ticket.status, to: newStatus, label: action.label },
  });

  // Fan-out — also server-side, so it survives the client closing the tab.
  // Failures here never fail the action (the transition is already committed);
  // they're logged for the maintenance cron's visibility.
  try {
    await fanOut({ ticket, ticketId: body.ticketId, action: { type: action.action, label: action.label }, newStatus: String(newStatus), recipients, actorUid: caller.id, actorEmail: callerEmail, comment: body.comment ?? null });
    // Kick the email drain AFTER the response is sent (the daily cron is the
    // fallback, not the primary path — recipients should get email in seconds).
    const drainUrl = new URL("/api/notifications/send-queued", req.url);
    after(async () => {
      try { await fetch(drainUrl, { method: "POST" }); } catch { /* cron fallback */ }
    });
  } catch (e) {
    console.error("[workflow-action] fan-out failed (transition committed):", e);
  }

  return NextResponse.json({ ok: true, status: newStatus });
}

async function fanOut(params: {
  ticket: ReturnType<typeof rowToTicket>;
  ticketId: string;
  action: { type: string; label: string };
  newStatus: string;
  recipients: string[];
  actorUid: string;
  actorEmail: string;
  comment: string | null;
}) {
  const { ticket, ticketId, action, newStatus, recipients, actorUid, actorEmail, comment } = params;
  if (recipients.length === 0) return;

  const ticketLabel = `${ticket.ticketId || ""} ${ticket.title}`.trim();
  const link = `/requests/${ticketId}`;
  const cls = classifyTransitionNotification({ actionType: action.type, actionLabel: action.label, ticketLabel });
  const actorName = actorEmail.split("@")[0];

  // 1) In-app bell rows.
  await supabaseAdmin.from("notifications").insert(
    recipients.map((uid) => ({
      org_id: ticket.orgId,
      user_id: uid,
      kind: cls.inAppKind,
      title: cls.inAppTitle,
      body: comment || `Status: ${newStatus}`,
      link,
      resource_type: "ticket",
      resource_id: ticketId,
      actor_user_id: actorUid,
      actor_name: actorName,
      metadata: { action: action.type, status: newStatus },
    })),
  );

  // 2) Email queue — preference-aware (defaults all-on when no prefs row).
  const [{ data: members }, { data: prefs }] = await Promise.all([
    supabaseAdmin.from("org_members").select("uid, email").eq("org_id", ticket.orgId).in("uid", recipients),
    supabaseAdmin.from("notification_preferences").select("*").in("user_id", recipients),
  ]);
  const emailByUid = new Map<string, string>();
  ((members as Array<{ uid: string; email: string | null }>) ?? []).forEach((m) => {
    if (m.email) emailByUid.set(m.uid, m.email);
  });
  const prefByUid = new Map<string, Record<string, unknown>>();
  ((prefs as Array<Record<string, unknown>>) ?? []).forEach((p) => prefByUid.set(p.user_id as string, p));

  const wantsEmail = (uid: string): boolean => {
    const p = prefByUid.get(uid);
    if (!p) return true;
    if (p.email_enabled === false) return false;
    if (p.digest_frequency === "never") return false;
    switch (cls.eventType) {
      case "assignment":
      case "engineer_review_requested":
        return p.email_on_assignment !== false;
      case "ticket_status_changed":
      case "ticket_approved":
      case "ticket_revision_requested":
      case "ticket_closed":
        return p.email_on_status_change !== false;
      default:
        return true;
    }
  };

  const emailRows = recipients
    .filter((uid) => emailByUid.has(uid) && wantsEmail(uid))
    .map((uid) => ({
      org_id: ticket.orgId,
      to_user_id: uid,
      to_email: emailByUid.get(uid)!,
      subject: cls.emailSubject,
      body_text: `${actorEmail} performed: ${action.label}\n\nStatus is now: ${newStatus}\n${comment ? `\nNote: ${comment}\n` : ""}\n${link}`,
      body_html: `
        <p><b>${escapeHtml(actorEmail)}</b> performed <b>${escapeHtml(action.label)}</b> on <a href="${link}">${escapeHtml(ticketLabel)}</a>.</p>
        <p>Status: <b>${escapeHtml(newStatus)}</b></p>
        ${comment ? `<blockquote style="border-left:3px solid #cbd5e1;padding-left:12px;color:#475569;white-space:pre-wrap">${escapeHtml(comment)}</blockquote>` : ""}
        <p><a href="${link}">Open ticket</a></p>`,
      resource_type: "ticket",
      resource_id: ticketId,
      event_type: cls.eventType,
      metadata: { action: action.type, status: newStatus },
      status: "queued",
    }));
  if (emailRows.length > 0) {
    await supabaseAdmin.from("email_notifications").insert(emailRows);
  }
}
