// POST /api/notifications/send-queued
//
// Drains the email_notifications queue. Called fire-and-forget by client
// code after queueing an email, AND by a Vercel/Supabase cron schedule
// as a safety net.
//
// Email delivery uses Resend (https://resend.com) — set RESEND_API_KEY +
// RESEND_FROM_EMAIL in your environment. If those aren't configured, rows
// stay queued (no errors logged at queue-write time; the sender just
// marks attempts as failed with a clear message).

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { publicOrigin } from "@/lib/publicOrigin";
import { wrapEmailBody } from "@/lib/emailRender";
import { addressIsOwn, unsubscribeUrl } from "@/lib/unsubscribeToken";
import { PREFERENCE_EXEMPT_EVENT_TYPES } from "@/lib/notificationPrefs";

// A full batch is up to MAX_BATCH sequential-ish Resend round-trips — far
// beyond the platform's default ~10s function budget. Without this, the
// batch bump to 100 made every full drain time out at iteration 1.
export const maxDuration = 300;

// We use the service-role key here because this endpoint may be called
// without a user session (e.g. by a scheduled cron). RLS would block
// otherwise. Make sure SUPABASE_SERVICE_ROLE_KEY is set in env.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

// Per-request cap — bounds one invocation, not the day: the maintenance cron
// loops this route until the queue is empty.
const MAX_BATCH = 100;
const MAX_ATTEMPTS = 5;

interface EmailNotificationRow {
  id: string;
  org_id?: string | null;
  to_user_id?: string | null;
  to_email: string;
  subject: string;
  body_text: string;
  body_html?: string | null;
  attempt_count?: number | null;
  event_type?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Event types the master switch never stops, so their mail carries no
 *  one-click unsubscribe — a link that would not stop the next one is a
 *  promise the app breaks (NEDGE-10, N6 fix pass): the preference-exempt
 *  recall and PSM alert (DEC-74 §9), and the transmittal route's notices to an
 *  issuer about an unstamped or refused PDF, which it queues on the service
 *  role without a preference read ("an unmarked or refused delivery is never
 *  muted" — app/api/transmittal/route.ts, notifications N9's). */
const NO_OPT_OUT_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...PREFERENCE_EXEMPT_EVENT_TYPES, "transmittal_unstamped", "transmittal_refused",
]);

/** What goes to the provider for one row (NEDGE-10, notifications Round G
 *  N6). A MEMBER's email (anything not metadata.external — external mail is
 *  the transmittal's own template, addressed to someone with no account, and
 *  its to_user_id is the sender) gets:
 *   - the one-click List-Unsubscribe header pair (RFC 8058) when the caller
 *     passes a link — listUnsubscribeFor() decides, and only for mail that
 *     goes to the recipient's own address;
 *   - the render layer's footer and mention rule (lib/emailRender.ts
 *     wrapEmailBody) when nothing rendered the row at queue time (no
 *     metadata.rendered: a row queued before the layer, or by a route
 *     outside it). The stored row is never rewritten.
 *  An external row is sent exactly as stored, as before. */
function outgoing(row: EmailNotificationRow, origin: string, orgName: string | null, unsubscribe: string | null): { text: string; html?: string; headers?: Record<string, string> } {
  const meta = row.metadata ?? {};
  if (meta.external === true) return { text: row.body_text, html: row.body_html || undefined };
  let text = row.body_text;
  let html = row.body_html || undefined;
  if (meta.rendered !== true) {
    try {
      const w = wrapEmailBody({ text: row.body_text, html: row.body_html, origin, orgName });
      text = w.bodyText;
      html = w.bodyHtml;
    } catch { /* no origin: sent as stored, as before */ }
  }
  return unsubscribe
    ? { text, html, headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }
    : { text, html };
}

/** The recipients' facts the header decision reads — one read each per
 *  batch, as the service role. A read that fails leaves its map null, and
 *  then no row of the batch carries the header (fail closed: the footer's
 *  settings link is still there). */
interface UnsubscribeFacts {
  /** uid → their own profile address (public.users.email). */
  profileAddress: Map<string, string | null> | null;
  /** uid → whether their master switch is on now (no row = on). */
  emailOn: Map<string, boolean> | null;
}

/** The one-click link for `row`, or null (NEDGE-10 dw1, N6 fix pass). A link
 *  turns off email for to_user_id, so it is issued only when all of these
 *  hold:
 *   - the row is a member's mail (not external) and names a recipient;
 *   - the master switch stops mail of its kind (not NO_OPT_OUT_EVENT_TYPES);
 *   - the recipient's switch is on now — mail that still reaches someone
 *     who already turned it off is mail it does not stop (the transmittal
 *     route's acknowledgment receipt, queued without a preference read);
 *   - to_email IS the recipient's own profile address. Any member can queue
 *     a row naming someone else's uid with their own address (the insert
 *     rail checks the address against the org's members, not against
 *     to_user_id); without this check the drain mailed them a working link
 *     to turn off the victim's email. The token also binds the address, and
 *     the route re-checks it (lib/unsubscribeToken.ts). */
function listUnsubscribeFor(row: EmailNotificationRow, origin: string, facts: UnsubscribeFacts): string | null {
  if ((row.metadata ?? {}).external === true || !row.to_user_id) return null;
  if (row.event_type && NO_OPT_OUT_EVENT_TYPES.has(row.event_type)) return null;
  if (!facts.profileAddress || !facts.emailOn) return null;
  if (facts.emailOn.get(row.to_user_id) === false) return null;
  const own = facts.profileAddress.get(row.to_user_id) ?? null;
  if (!addressIsOwn(row.to_email, own)) return null;
  return unsubscribeUrl(origin, row.to_user_id, own);
}

export async function POST(req: Request) {
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Supabase credentials missing" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // Authorize: this route uses the service-role key and drains the queue, so
  // it must not be world-callable. Accept either the shared CRON_SECRET
  // (internal cron drains EVERY org) or a valid user session — but a session
  // caller drains ONLY their own orgs' queue. Previously any signed-up account
  // (member of no org) passed `authorized = !!user` and drained every tenant's
  // mail, re-sending suppressed backlogs across the platform (SURF-5). The
  // per-org scope is applied to every queue query below via `scopeOrgIds`.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const isCron = cronSecret !== "" && token === cronSecret;
  let scopeOrgIds: string[] | null = null; // null = unscoped (cron only)
  if (!isCron) {
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: memberships } = await supabase
      .from("org_members")
      .select("org_id")
      .eq("uid", user.id)
      .eq("status", "active");
    scopeOrgIds = ((memberships ?? []) as Array<{ org_id: string }>).map((m) => m.org_id);
    if (scopeOrgIds.length === 0) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "notifications@manufacturing-os.app";

  // If email isn't configured, DEFER: leave rows queued untouched so the
  // entire backlog flows the moment the operator sets RESEND_API_KEY.
  // (An earlier version flipped them to a terminal 'suppressed' state,
  // which permanently destroyed every email queued before configuration —
  // deferral costs nothing since nothing retries without a drain call.)
  if (!resendKey) {
    let countQ = supabase
      .from("email_notifications")
      .select("id", { count: "exact", head: true })
      .in("status", ["queued", "failed"]);
    if (scopeOrgIds) countQ = countQ.in("org_id", scopeOrgIds);
    const { count } = await countQ;
    return NextResponse.json({
      processed: 0,
      sent: 0,
      failed: 0,
      deferred: count ?? 0,
      configured: false,
      note: "RESEND_API_KEY is not set — emails left queued (no delivery attempted). Set the env var and the backlog sends on the next drain.",
    });
  }

  // Recover rows the pre-deferral code destroyed: 'suppressed' was only ever
  // written by the old not-configured path, so with a key now present those
  // rows are the backlog the operator expected to send. Only the last 7 days —
  // older notifications are stale enough that a surprise blast hurts more
  // than the silence did.
  {
    let unsuppress = supabase
      .from("email_notifications")
      .update({ status: "queued", attempt_count: 0, error_message: null })
      .eq("status", "suppressed")
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    if (scopeOrgIds) unsuppress = unsuppress.in("org_id", scopeOrgIds);
    await unsuppress;
  }

  // Reclaim orphans: rows stranded in 'sending' by a previous run that crashed
  // between claiming and completing. 15 min is far longer than any real send,
  // so this never steals a row another run is actively processing.
  {
    let reclaim = supabase
      .from("email_notifications")
      .update({ status: "queued" })
      .eq("status", "sending")
      .lt("last_attempted_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());
    if (scopeOrgIds) reclaim = reclaim.in("org_id", scopeOrgIds);
    await reclaim;
  }

  // Find candidate work.
  let candidateQ = supabase
    .from("email_notifications")
    .select("*")
    .in("status", ["queued", "failed"])
    .lt("attempt_count", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(MAX_BATCH);
  if (scopeOrgIds) candidateQ = candidateQ.in("org_id", scopeOrgIds);
  const { data: candidates, error: claimErr } = await candidateQ;

  if (claimErr) return NextResponse.json({ error: claimErr.message }, { status: 500 });
  if (!candidates || candidates.length === 0) return NextResponse.json({ processed: 0 });

  // Atomically CLAIM: flip to 'sending' only for rows STILL queued/failed, and
  // .select() back exactly the rows THIS invocation won. A concurrent drain
  // that raced us to the same rows finds them already 'sending', so its guard
  // matches nothing and it returns an empty set — no email is ever sent twice.
  const candidateIds = candidates.map((r: EmailNotificationRow) => r.id);
  const { data: claimed } = await supabase
    .from("email_notifications")
    .update({ status: "sending", last_attempted_at: new Date().toISOString() })
    .in("id", candidateIds)
    .in("status", ["queued", "failed"])
    .select("*");

  const queued = (claimed ?? []) as EmailNotificationRow[];
  if (queued.length === 0) return NextResponse.json({ processed: 0 });

  let sent = 0;
  let failed = 0;
  // DELIV-11: one provider message, so the cron can say WHY a batch failed.
  let errorSample: string | null = null;
  // The public origin the unsubscribe link and the footer are built on — the
  // configured site, else the origin this request arrived on.
  const origin = publicOrigin() || new URL(req.url).origin;
  // The workspace names a backstop footer carries — one read for the batch; a
  // failed read leaves "your workspace".
  const orgNames = new Map<string, string>();
  const orgIds = [...new Set(queued.map((r) => r.org_id).filter((o): o is string => !!o))];
  if (orgIds.length > 0) {
    const { data: orgRows } = await supabase.from("orgs").select("id, name").in("id", orgIds);
    for (const o of (orgRows as Array<{ id: string; name: string | null }> | null) ?? []) if (o.name) orgNames.set(o.id, o.name);
  }
  // NEDGE-10 (N6 fix pass): the recipients' own addresses and master
  // switches, for the one-click header — read only for member mail.
  const facts: UnsubscribeFacts = { profileAddress: new Map(), emailOn: new Map() };
  const recipientIds = [...new Set(queued
    .filter((r) => (r.metadata ?? {}).external !== true && !!r.to_user_id)
    .map((r) => r.to_user_id as string))];
  if (recipientIds.length > 0) {
    const [profiles, prefs] = await Promise.all([
      supabase.from("users").select("id, email").in("id", recipientIds),
      supabase.from("notification_preferences").select("user_id, email_enabled").in("user_id", recipientIds),
    ]);
    if (profiles.error) {
      facts.profileAddress = null;
      console.warn(`[send-queued] recipients' addresses unreadable — no List-Unsubscribe header this batch: ${profiles.error.message}`);
    } else {
      for (const u of (profiles.data as Array<{ id: string; email: string | null }> | null) ?? []) facts.profileAddress!.set(u.id, u.email);
    }
    if (prefs.error) {
      facts.emailOn = null;
      console.warn(`[send-queued] recipients' email switches unreadable — no List-Unsubscribe header this batch: ${prefs.error.message}`);
    } else {
      for (const p of (prefs.data as Array<{ user_id: string; email_enabled: boolean | null }> | null) ?? []) facts.emailOn!.set(p.user_id, p.email_enabled !== false);
    }
  }

  // Small parallel chunks: 5-wide keeps a 100-row batch under ~30s without
  // slamming Resend's rate limit (a 429 lands in the failed/retry path, so
  // even a burst degrades to a later attempt, never a lost email).
  const sendOne = async (row: EmailNotificationRow) => {
    try {
      const out = outgoing(row, origin, (row.org_id && orgNames.get(row.org_id)) || null, listUnsubscribeFor(row, origin, facts));
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: fromEmail,
          to: row.to_email,
          subject: row.subject,
          text: out.text,
          html: out.html,
          ...(out.headers ? { headers: out.headers } : {}),
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Resend ${resp.status}: ${errBody}`);
      }

      await supabase
        .from("email_notifications")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          attempt_count: (row.attempt_count || 0) + 1,
        })
        .eq("id", row.id);
      sent++;
    } catch (e) {
      failed++;
      const msg = (e as Error).message || String(e);
      if (!errorSample) errorSample = msg.slice(0, 200);
      await supabase
        .from("email_notifications")
        .update({
          status: (row.attempt_count || 0) + 1 >= MAX_ATTEMPTS ? "failed" : "queued",
          attempt_count: (row.attempt_count || 0) + 1,
          error_message: msg.slice(0, 500),
        })
        .eq("id", row.id);
    }
  };
  for (let i = 0; i < queued.length; i += 5) {
    await Promise.all(queued.slice(i, i + 5).map(sendOne));
  }

  return NextResponse.json({ processed: queued.length, sent, failed, ...(errorSample ? { errorSample } : {}) });
}

export async function GET(req: Request) {
  // Allow GET so a cron service can ping us without changing method
  return POST(req);
}
