import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { WorkflowEngine } from "@/lib/workflow";
import { loadCapabilityPolicy, policyAllows } from "@/lib/capabilityPolicy";
import {
  computeTransition,
  classifyTransitionNotification,
  rowToTicket,
  escapeHtml,
  type TransitionInput,
} from "@/lib/ticketTransitions";
import type { Role, TicketAttachment } from "@/types/schema";
import { TICKET_INTENT_TTL_MS } from "@/lib/intents";

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
  /** LIFE-6 / DEC-25: how the closer addressed the hold(s) this ticket
   *  opened — release them now, or keep them with a stated reason. Absent
   *  when a close would leave one open, the close is refused (409 holds_open). */
  holdResolution?: { action: "release" | "keep"; reason?: string | null } | null;
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
  if ((row as { archived_at?: string | null }).archived_at) {
    return NextResponse.json(
      { error: "This ticket is archived; restore it from its archive before acting on it." },
      { status: 409 },
    );
  }
  const ticket = rowToTicket(row as Record<string, unknown>);

  // Active membership in the ticket's org + the caller's role.
  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, roles, email, display_name")
    .eq("org_id", ticket.orgId)
    .eq("uid", caller.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "Forbidden: not an active member of this workspace" }, { status: 403 });
  }
  const callerRole = (member.role as Role) ?? "Viewer";
  const callerEmail = (member.email as string | null) || caller.email || "Unknown";
  // WF-7: authority is evaluated against the FULL additive collection —
  // the headline alone SUBTRACTED authority from multi-role people.
  const callerRoles: Role[] = Array.isArray(member.roles) && (member.roles as Role[]).length > 0
    ? (member.roles as Role[])
    : [callerRole];

  // GAP-2/DEC-12: the independence predicates bind at >= 3 active members.
  const { count: activeMemberCount } = await supabaseAdmin
    .from("org_members")
    .select("uid", { count: "exact", head: true })
    .eq("org_id", ticket.orgId)
    .eq("status", "active");
  const sodActive = (activeMemberCount ?? 0) >= 3;

  // WF-15: close-without-review is a property of the CONFIGURED type.
  let closeWithoutReviewTypes: string[] = ["RFI"];
  try {
    const { data: cfgRow } = await supabaseAdmin
      .from("org_configurations")
      .select("data")
      .eq("org_id", ticket.orgId)
      .eq("key", "drafting")
      .maybeSingle();
    const opts = ((cfgRow?.data as { requestTypes?: { options?: Array<{ value?: string; closeWithoutReview?: boolean }> } } | null)
      ?.requestTypes?.options) ?? [];
    const flagged = opts.filter((o) => o.closeWithoutReview === true).map((o) => String(o.value ?? "")).filter(Boolean);
    if (flagged.length > 0) closeWithoutReviewTypes = flagged;
  } catch { /* default stands */ }

  // THE enforcement: the action must be one the state machine offers this
  // caller at the ticket's current status — evaluated with the ORG'S OWN
  // capability policy, so admin-configured authority is enforced here, not
  // just drawn in the UI.
  const capPolicy = await loadCapabilityPolicy(ticket.orgId, supabaseAdmin);
  const allowed = WorkflowEngine.getActions(ticket, callerRole, caller.id, capPolicy, {
    userRoles: callerRoles,
    activeMemberCount: activeMemberCount ?? 0,
    closeWithoutReviewTypes,
  });
  const action = allowed.find((a) => a.action === body.actionType);
  if (!action) {
    return NextResponse.json(
      { error: `Action "${body.actionType}" is not available to you at status ${ticket.status}` },
      { status: 403 },
    );
  }
  // GAP-2: a separation-of-duties block is rendered disabled in the UI and
  // REFUSED here — the reason travels with it.
  if (action.disabledReason) {
    return NextResponse.json({ error: action.disabledReason }, { status: 403 });
  }
  if (action.requiresComment && !body.comment?.trim()) {
    return NextResponse.json({ error: "This action requires a comment" }, { status: 400 });
  }
  if (action.requiresEngineerPick && !body.engineer?.id) {
    return NextResponse.json({ error: "This action requires picking an engineer" }, { status: 400 });
  }
  // WF-6: the file precondition is enforced HERE, not only in the browser —
  // a direct POST could previously mint a "Final package issued" ticket with
  // no deliverable at all.
  if (action.requiresFile && action.action === "submit_final" && !body.finalAttachment?.url) {
    return NextResponse.json({ error: "Issuing the final IFC package requires the deliverable file" }, { status: 400 });
  }
  // WF-22: a transition that requires an input is refused when it is missing —
  // an assignment-less "assign" used to no-op while still writing a success
  // audit row.
  if (action.action === "assign" && !body.assignment?.id) {
    return NextResponse.json({ error: "Assigning requires picking a drafter" }, { status: 400 });
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
    const held: string[] = Array.isArray(refMember.roles) && refMember.roles.length > 0
      ? (refMember.roles as string[])
      : [String(refMember.role ?? "")];
    if (ref === body.engineer?.id) {
      if (!held.some((r) => r.includes("Engineer"))) {
        return NextResponse.json({ error: "The selected reviewer does not hold an Engineer role" }, { status: 400 });
      }
      // WF-14 (+DEC-12, +DEC-37): the reviewer slot is INDEPENDENT of the
      // deliverable's producer and its beneficiary. In orgs of 3+ the picked
      // engineer may not be the requester, the assigned drafter, or the
      // caller — otherwise "two-stage engineering sign-off" can be one
      // person wearing every hat on the same ticket. Below 3 members the
      // single-person loop stays legal (DEC-12).
      if (sodActive) {
        if (ref === ticket.requesterId) {
          return NextResponse.json({ error: "Needs a second person: the requester can't be the engineer who reviews their own request (orgs of 3+)." }, { status: 403 });
        }
        if (ref === ticket.assignedDrafterId) {
          return NextResponse.json({ error: "Needs a second person: the drafter can't be the engineer who reviews their own deliverable (orgs of 3+)." }, { status: 403 });
        }
        if (ref === caller.id) {
          return NextResponse.json({ error: "Needs a second person: you can't pick yourself as the reviewing engineer (orgs of 3+)." }, { status: 403 });
        }
      }
    }
    if (ref === body.assignment?.id) {
      // WF-14 done-when 3: the assignee must actually hold drafting
      // authority under the org's policy — membership alone was the only
      // check before.
      const mayDraft = policyAllows(capPolicy, "ticket.draft_work",
        (held[0] ?? "Viewer") as Role, held as Role[], ref);
      if (!mayDraft) {
        return NextResponse.json({ error: "The selected drafter does not hold drafting authority (ticket.draft_work)" }, { status: 400 });
      }
      // GAP-2/DEC-12: the assigned drafter may not be the requester (3+).
      if (sodActive && ref === ticket.requesterId) {
        return NextResponse.json({ error: "Needs a second person: the requester can't draft their own request (orgs of 3+)." }, { status: 403 });
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
  const { updates, newStatus, recipients, newComment } = computeTransition(ticket, input);

  // LIFE-6 / DEC-25: a ticket cannot close silently over a hold it opened.
  // The closer releases it now, or records why it stays — never auto-release.
  if (body.actionType === "close_ticket" || body.actionType === "close_rfi") {
    const { data: openHolds, error: holdsErr } = await supabaseAdmin
      .from("document_holds")
      .select("id, document_id, reason, notes")
      .eq("origin_ticket_id", body.ticketId)
      .is("released_at", null);
    if (holdsErr && !/origin_ticket_id/.test(holdsErr.message)) {
      return NextResponse.json({ error: `Couldn't check this ticket's holds: ${holdsErr.message}` }, { status: 500 });
    }
    const holds = (openHolds ?? []) as Array<{ id: string; document_id: string; reason: string; notes: string | null }>;
    if (holds.length > 0) {
      const resolution = body.holdResolution ?? null;
      const reason = (resolution?.reason ?? "").trim();
      if (!resolution || (resolution.action === "keep" && !reason)) {
        return NextResponse.json({
          error: "This request opened a hold that is still active. Release it, or record why it stays, before closing.",
          code: "holds_open",
          holds: holds.map((h) => ({ id: h.id, documentId: h.document_id, reason: h.reason })),
        }, { status: 409 });
      }
      const nowIso = new Date().toISOString();
      if (resolution.action === "release") {
        const { data: released, error: relErr } = await supabaseAdmin
          .from("document_holds")
          .update({ released_at: nowIso, released_by: caller.id, released_by_name: callerEmail ?? null,
                    released_reason: reason || `Released on close of ticket ${ticket.ticketId ?? body.ticketId}` })
          .in("id", holds.map((h) => h.id)).is("released_at", null).select("id");
        if (relErr) return NextResponse.json({ error: `Couldn't release the hold: ${relErr.message}` }, { status: 500 });
        for (const h of holds) {
          await supabaseAdmin.from("audit_logs").insert({
            action: "HOLD_RELEASED", resource_type: "document", resource_id: h.document_id, org_id: ticket.orgId,
            user_id: caller.id, user_email: callerEmail ?? null,
            details: { holdId: h.id, reason: h.reason, releasedReason: reason || null, viaTicketClose: body.ticketId, released: (released ?? []).length },
          }).then(() => undefined, () => undefined);
        }
      } else {
        for (const h of holds) {
          await supabaseAdmin.from("audit_logs").insert({
            action: "HOLD_KEPT_ON_CLOSE", resource_type: "document", resource_id: h.document_id, org_id: ticket.orgId,
            user_id: caller.id, user_email: callerEmail ?? null,
            details: { holdId: h.id, reason: h.reason, keptBecause: reason, ticketId: body.ticketId },
          }).then(() => undefined, () => undefined);
        }
      }
    }
  }

  // Compare-and-set on the status we validated against. If another reviewer
  // moved the ticket since, refuse to clobber their transition.
  // CAS on status AND last-modified: status alone let two no-status-change
  // actions (save_progress, comments) interleave and clobber each other's
  // whole-array attachments/comments/history writes.
  let baseQuery = supabaseAdmin
    .from("tickets")
    .update(updates)
    .eq("id", body.ticketId)
    .eq("status", ticket.status);
  baseQuery = ticket.lastModified
    ? baseQuery.eq("last_modified", String(ticket.lastModified))
    : baseQuery;
  let { data: updated, error: updErr } = await baseQuery
    .select("id")
    .maybeSingle();
  // Pre-migration tolerance: if the deliverable-rev columns (20260827) aren't
  // deployed yet, retry without them so the workflow itself never blocks on a
  // pending migration.
  if (updErr && (updErr.code === "PGRST204" || updErr.code === "42703") &&
      ("deliverable_rev" in updates || "draft_iteration" in updates)) {
    const { deliverable_rev: _dr, draft_iteration: _di, ...tolerant } = updates;
    void _dr; void _di;
    let tolerantQuery = supabaseAdmin
      .from("tickets")
      .update(tolerant)
      .eq("id", body.ticketId)
      .eq("status", ticket.status);
    tolerantQuery = ticket.lastModified
      ? tolerantQuery.eq("last_modified", String(ticket.lastModified))
      : tolerantQuery;
    ({ data: updated, error: updErr } = await tolerantQuery
      .select("id")
      .maybeSingle());
  }
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  if (!updated) {
    return NextResponse.json(
      { error: "The ticket changed while you were acting — refresh and try again", conflict: true },
      { status: 409 },
    );
  }

  // Mirror the action's comment into the ticket_comments table so the two comment
  // stores stay in sync — computeTransition only appends to the JSONB thread, and
  // until now workflow comments never reached the table. Best-effort: the JSONB is
  // what the UI renders, so a table hiccup must not fail the transition.
  if (newComment) {
    await supabaseAdmin.from("ticket_comments").insert({
      id: newComment.id as string,
      org_id: ticket.orgId,
      ticket_id: body.ticketId,
      author_uid: (newComment.authorUid as string) ?? caller.id,
      author_email: (newComment.user as string) ?? callerEmail,
      author_role: (newComment.role as string) ?? callerRole,
      body: (newComment.text as string) ?? "",
      type: (newComment.type as string) ?? "General",
      category: (newComment.category as string | null) ?? null,
      mentioned_uids: [],
      created_at: (newComment.date as string) ?? new Date().toISOString(),
    }).then(() => {}, () => {});
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

  // Ticket ⇄ intent bridge: a ticket entering DRAFTING registers the drafter's
  // EDIT INTENT on the source document — visible on the coordination surfaces
  // and feeding overlap advisories, WITHOUT taking a lock (intent decays on
  // its own; no zombie-lock factory). Ticket closure clears it. Best-effort:
  // never fails the transition; no-op on pre-migration envs.
  try {
    const srcDoc = (ticket.metadata as Record<string, unknown> | undefined)
      ?.source_document as { id?: string } | undefined;
    if (srcDoc?.id) {
      if (newStatus === "DRAFTING" || newStatus === "REVISION_REQ") {
        const drafterId =
          (updates.assigned_drafter_id as string | undefined) ?? ticket.assignedDrafterId;
        const drafterName =
          (updates.assigned_drafter_name as string | undefined) ?? ticket.assignedDrafterName;
        if (drafterId) {
          const { data: docRow } = await supabaseAdmin
            .from("documents")
            .select("current_version_id, library_id")
            .eq("id", srcDoc.id)
            .maybeSingle();
          await supabaseAdmin.from("document_intents").upsert(
            {
              org_id: ticket.orgId,
              document_id: srcDoc.id,
              library_id: (docRow as { library_id?: string | null } | null)?.library_id ?? null,
              user_id: drafterId,
              user_name: drafterName ?? null,
              kind: "edit",
              source: "ticket",
              base_version_id:
                (docRow as { current_version_id?: string | null } | null)?.current_version_id ?? null,
              ticket_id: body.ticketId,
              refreshed_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + TICKET_INTENT_TTL_MS).toISOString(),
            },
            { onConflict: "document_id,user_id,kind,source" },
          );
        }
      } else if (newStatus === "CLOSED" || newStatus === "FINAL_DRAFT") {
        await supabaseAdmin
          .from("document_intents")
          .delete()
          .eq("document_id", srcDoc.id)
          .eq("ticket_id", body.ticketId)
          .eq("source", "ticket");
      }
    }
  } catch (e) {
    console.warn("[workflow-action] intent bridge failed (non-blocking)", e);
  }

  // Fan-out — also server-side, so it survives the client closing the tab.
  // Failures here never fail the action (the transition is already committed);
  // they're logged for the maintenance cron's visibility.
  try {
    await fanOut({ ticket, ticketId: body.ticketId, action: { type: action.action, label: action.label }, newStatus: String(newStatus), recipients, actorUid: caller.id, actorEmail: callerEmail, comment: body.comment ?? null });
    // Kick the email drain AFTER the response is sent (the daily cron is the
    // fallback, not the primary path — recipients should get email in seconds).
    const drainUrl = new URL("/api/notifications/send-queued", req.url);
    after(async () => {
      try {
        await fetch(drainUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET || ""}` },
        });
      } catch { /* cron fallback */ }
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

  // 0) Supersede earlier unread WORKFLOW alerts for this ticket. A workflow
  //    notification (one carrying metadata.action) says "the ticket is in state
  //    X, act on it". The moment it transitions, that's no longer true, so we
  //    retire the old rows for everyone — otherwise a stale "issue the IFC" /
  //    "needs assignment" alert lingers in the recipient's bell long after the
  //    work moved on. Comment/mention rows have no metadata.action and are
  //    intentionally left untouched. Best-effort: never block the transition.
  try {
    await supabaseAdmin.from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("resource_id", ticketId)
      .is("read_at", null)
      .not("metadata->>action", "is", null);
  } catch (e) {
    console.warn("[workflow-action] superseding stale notifications failed:", e);
  }

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
