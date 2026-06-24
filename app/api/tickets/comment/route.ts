import { NextRequest, NextResponse, after } from "next/server";
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
  if ((row as { archived_at?: string | null }).archived_at) {
    return NextResponse.json({ error: "This ticket is archived; restore it from its archive before commenting." }, { status: 409 });
  }
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
    // Only fall back when the RPC is genuinely absent (migration not applied):
    // PostgREST signals that as PGRST202 / "Could not find the function".
    // A real exception raised INSIDE the function must surface, not be
    // swallowed into the legacy path.
    const missing =
      (rpcErr as { code?: string }).code === "PGRST202" ||
      /could not find the function|does not exist in the schema cache/i.test(rpcErr.message ?? "");
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
    // Kick the email drain AFTER the response is sent (the daily cron is the
    // fallback, not the primary path — recipients should get email in seconds).
    const drainUrl = new URL("/api/notifications/send-queued", req.url);
    after(async () => {
      try { await fetch(drainUrl, { method: "POST" }); } catch { /* cron fallback */ }
    });
  } catch (e) {
    console.error("[ticket-comment] fan-out failed (comment committed):", e);
  }

  return NextResponse.json({ ok: true, comment });
}

// ─── Edit / delete ───────────────────────────────────────────────────────────
// Server-enforced (author or Admin only) so the JSONB and the ticket_comments
// table stay in lockstep — the previous client-side writes updated only the
// JSONB and silently diverged the table.

type JsonComment = Record<string, unknown> & { id?: string };

async function authorizeCommentChange(req: NextRequest, body: { ticketId?: string; commentId?: string }) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return { error: "Unauthorized", status: 401 as const };
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) return { error: "Unauthorized", status: 401 as const };
  if (!body.ticketId || !body.commentId) return { error: "ticketId and commentId are required", status: 400 as const };

  const { data: row } = await supabaseAdmin.from("tickets").select("*").eq("id", body.ticketId).maybeSingle();
  if (!row) return { error: "Ticket not found", status: 404 as const };
  if ((row as { archived_at?: string | null }).archived_at) {
    return { error: "This ticket is archived; restore it before editing its comments.", status: 409 as const };
  }
  const ticket = rowToTicket(row as Record<string, unknown>);

  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, email")
    .eq("org_id", ticket.orgId)
    .eq("uid", caller.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member) return { error: "Forbidden: not an active member of this workspace", status: 403 as const };

  const comments = (ticket.comments ?? []) as unknown as JsonComment[];
  const target = comments.find((c) => c.id === body.commentId);
  if (!target) return { error: "Comment not found", status: 404 as const };

  const callerEmail = (member.email as string | null) || caller.email || "";
  const isAuthor = target.authorUid === caller.id || (!!callerEmail && target.user === callerEmail);
  const isAdmin = member.role === "Admin";
  if (!isAuthor && !isAdmin) return { error: "Only the author or an Admin can change this comment", status: 403 as const };

  return { ticket, comments, target, callerId: caller.id };
}

export async function PATCH(req: NextRequest) {
  let body: { ticketId?: string; commentId?: string; text?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const text = (body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const auth = await authorizeCommentChange(req, body);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const editedAt = new Date().toISOString();
  const next = auth.comments.map((c) => (c.id === body.commentId ? { ...c, text, editedAt } : c));
  const { error: updErr } = await supabaseAdmin
    .from("tickets")
    .update({ comments: next, last_modified: editedAt })
    .eq("id", body.ticketId!);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Keep the table in lockstep (best-effort pre-migration).
  await supabaseAdmin.from("ticket_comments").update({ body: text, edited_at: editedAt }).eq("id", body.commentId!).then(() => {});

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  let body: { ticketId?: string; commentId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const auth = await authorizeCommentChange(req, body);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const next = auth.comments.filter((c) => c.id !== body.commentId);
  const { error: updErr } = await supabaseAdmin
    .from("tickets")
    .update({ comments: next, last_modified: new Date().toISOString() })
    .eq("id", body.ticketId!);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  await supabaseAdmin.from("ticket_comments").update({ deleted_at: new Date().toISOString() }).eq("id", body.commentId!).then(() => {});

  return NextResponse.json({ ok: true });
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
