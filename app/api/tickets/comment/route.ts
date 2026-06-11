import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { extractMentionUids } from "@/lib/notifications";
import { rowToTicket, escapeHtml } from "@/lib/ticketTransitions";

// POST /api/tickets/comment
//
// SERVER-SIDE comment posting. Replaces the client's read-modify-write of the
// tickets.comments JSONB array (which lost comments under concurrency) with:
//
//   1. auth + active-membership enforcement
//   2. an ATOMIC write via the post_ticket_comment RPC — inserts into the
//      ticket_comments table AND appends to the legacy JSONB with `||` in one
//      transaction, so two simultaneous commenters can never clobber each other
//      (graceful fallback to the legacy single-statement update if the
//      migration hasn't been applied yet — never worse than before)
//   3. server-side fan-out (bell rows + preference-aware emails) with the
//      ?c=<commentId> deep-link, so notifications survive a closed tab.

interface Body {
  ticketId: string;
  text: string;
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
  const text = (body.text ?? "").trim();
  if (!body.ticketId || !text) {
    return NextResponse.json({ error: "ticketId and text are required" }, { status: 400 });
  }
  if (text.length > 10_000) {
    return NextResponse.json({ error: "Comment is too long" }, { status: 400 });
  }

  const { data: row, error: loadErr } = await supabaseAdmin
    .from("tickets")
    .select("*")
    .eq("id", body.ticketId)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  const ticket = rowToTicket(row as Record<string, unknown>);

  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, email")
    .eq("org_id", ticket.orgId)
    .eq("uid", caller.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "Forbidden: not an active member of this workspace" }, { status: 403 });
  }
  const callerEmail = (member.email as string | null) || caller.email || "Unknown";
  const callerRole = (member.role as string) || "Viewer";
  const now = new Date().toISOString();

  const mentions = extractMentionUids(text);
  const comment = {
    id: crypto.randomUUID(),
    text,
    user: callerEmail,
    role: callerRole,
    date: now,
    type: "General" as const,
    mentionedUserIds: mentions,
    authorUid: caller.id,
  };

  // Everyone with a stake: requester + drafter + engineer + watchers + mentions,
  // always excluding the poster. Commenting also makes the poster a watcher.
  const involved = new Set<string>();
  if (ticket.requesterId) involved.add(ticket.requesterId);
  if (ticket.assignedDrafterId) involved.add(ticket.assignedDrafterId);
  if (ticket.assignedEngineerId) involved.add(ticket.assignedEngineerId);
  (ticket.watchers ?? []).forEach((w) => involved.add(w));
  mentions.forEach((m) => involved.add(m));
  involved.delete(caller.id);
  const newUnreadBy = Array.from(involved);
  const nextWatchers = Array.from(new Set([...(ticket.watchers ?? []), caller.id]));

  // Atomic post via the RPC; if the 20260726 migration isn't applied yet, fall
  // back to the legacy single-statement JSONB update (same behavior as before).
  const { error: rpcErr } = await supabaseAdmin.rpc("post_ticket_comment", {
    p_ticket_id: body.ticketId,
    p_comment: comment,
    p_unread: newUnreadBy,
    p_watchers: nextWatchers,
  });
  if (rpcErr) {
    const missing = /post_ticket_comment|function|schema cache/i.test(rpcErr.message ?? "");
    if (!missing) return NextResponse.json({ error: rpcErr.message }, { status: 500 });
    const { error: updErr } = await supabaseAdmin
      .from("tickets")
      .update({
        comments: [...(ticket.comments || []), comment],
        unread_by: newUnreadBy,
        watchers: nextWatchers,
        last_modified: now,
      })
      .eq("id", body.ticketId);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  // Server-side fan-out. Never fails the post (it's already committed).
  try {
    await fanOut({ ticket, ticketId: body.ticketId, comment, mentions, recipients: newUnreadBy, actorUid: caller.id, actorEmail: callerEmail });
  } catch (e) {
    console.error("[ticket-comment] fan-out failed (comment committed):", e);
  }

  return NextResponse.json({ ok: true, comment });
}

async function fanOut(params: {
  ticket: ReturnType<typeof rowToTicket>;
  ticketId: string;
  comment: { id: string; text: string };
  mentions: string[];
  recipients: string[];
  actorUid: string;
  actorEmail: string;
}) {
  const { ticket, ticketId, comment, mentions, recipients, actorUid, actorEmail } = params;
  if (recipients.length === 0) return;

  const ticketLabel = `${ticket.ticketId || ""} ${ticket.title}`.trim();
  const link = `/requests/${ticketId}?c=${comment.id}`;
  const actorName = actorEmail.split("@")[0];
  const snippet = comment.text.length > 140 ? comment.text.slice(0, 137) + "…" : comment.text;
  const mentionSet = new Set(mentions);

  await supabaseAdmin.from("notifications").insert(
    recipients.map((uid) => ({
      org_id: ticket.orgId,
      user_id: uid,
      kind: mentionSet.has(uid) ? "ticket_mention" : "ticket_comment",
      title: mentionSet.has(uid) ? `${actorName} mentioned you · ${ticketLabel}` : `${actorName} commented · ${ticketLabel}`,
      body: snippet,
      link,
      resource_type: "ticket",
      resource_id: ticketId,
      actor_user_id: actorUid,
      actor_name: actorName,
    })),
  );

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
    return mentionSet.has(uid) ? p.email_on_mention !== false : p.email_on_watched_activity !== false;
  };

  const emailRows = recipients
    .filter((uid) => emailByUid.has(uid) && wantsEmail(uid))
    .map((uid) => ({
      org_id: ticket.orgId,
      to_user_id: uid,
      to_email: emailByUid.get(uid)!,
      subject: mentionSet.has(uid) ? `You were mentioned: ${ticketLabel}` : `New comment on ${ticketLabel}`,
      body_text: `${actorEmail} commented on ${ticketLabel}:\n\n${comment.text}\n\n${link}`,
      body_html: `
        <p><b>${escapeHtml(actorEmail)}</b> commented on <a href="${link}">${escapeHtml(ticketLabel)}</a>:</p>
        <blockquote style="border-left:3px solid #cbd5e1;padding-left:12px;color:#475569;white-space:pre-wrap">${escapeHtml(comment.text)}</blockquote>
        <p><a href="${link}">Open ticket</a></p>`,
      resource_type: "ticket",
      resource_id: ticketId,
      event_type: mentionSet.has(uid) ? "comment_mention" : "watcher_activity",
      metadata: { mention: mentionSet.has(uid), postedBy: actorUid, commentId: comment.id },
      status: "queued",
    }));
  if (emailRows.length > 0) {
    await supabaseAdmin.from("email_notifications").insert(emailRows);
  }
}
