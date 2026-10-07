import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeEmail, applyEmailLookup } from "@/lib/identity";
import { notifyMany, notifyBatchWithReason } from "@/lib/inAppNotifications";
import { queueEmail } from "@/lib/notifications";
import { resolveRoleRecipients } from "@/lib/notify/recipients";
import { runWithServerClient } from "@/lib/serverClientScope";
import {
  ACCESS_REQUEST_AUDIENCE, ACCESS_REQUEST_BURST_RESOURCE_TYPE, ACCESS_REQUEST_NOTICES_PER_ORG_HOUR,
  noticeSafeName, wellFormedAddress,
} from "@/lib/accessRequestOutcome";

// This public, unauthenticated endpoint was the one door in the auth pair with
// no rate limit — its neighbour /api/auth/signup carries the full
// signup_attempts throttle. Unthrottled, it is an org-name existence oracle
// (404 vs 200) and a request-spam vector. Mirror the signup pattern exactly,
// sharing the same per-IP bucket (EGRESS-5 / DEC-19).
const REQUEST_ACCESS_MAX_PER_HOUR = 8;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

async function requestAccessRateLimited(ip: string): Promise<boolean> {
  if (ip === "unknown") return false; // don't punish everyone if IP is missing
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from("signup_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("created_at", since);
  if (error) return false; // table absent / transient — fail open
  return (count ?? 0) >= REQUEST_ACCESS_MAX_PER_HOUR;
}

async function recordAttempt(ip: string, email: string | null, outcome: string): Promise<void> {
  await supabaseAdmin.from("signup_attempts").insert({ ip, email, outcome })
    .then(() => undefined, () => undefined);
}

/** The notice's per-org cap: how many requests this org received in the
 *  last hour, the new one included. null when the count cannot be read —
 *  the caller then treats the org as past the cap (it fails closed: one
 *  burst notice per pool member at most, never a row per request). */
async function requestsToOrgLastHour(orgId: string): Promise<number | null> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from("access_requests")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .gte("created_at", since);
  if (error || typeof count !== "number") return null;
  return count;
}

/** PROD-2 (N8's review fix): past the per-org cap, the pool is told ONCE
 *  that more requests are waiting — not once per request. Each pool member
 *  holds at most one UNREAD burst row for the org (resource_type 'org',
 *  resource_id = the org id): a member who already has one gets nothing
 *  more (no row, no toast) until they have read it. The open-row read
 *  matches only rows with NO actor — the server's own: 20261160 stamps
 *  every signed-in writer as the row's actor, so no member's browser can
 *  forge the row that would silence this notice. One typed statement on
 *  the service role (notifyBatchWithReason). If the open rows cannot be read,
 *  nothing is written — never a row per request. The pending list on
 *  Admin → Users lists every request either way. Never throws. */
async function notifyAccessRequestBurst(orgId: string, orgName: string, recipients: string[], recent: number | null): Promise<void> {
  const why = recent === null ? "the org's request count could not be read" : `${recent} requests to this org in the last hour`;
  const { data: open, error: openErr } = await supabaseAdmin
    .from("notifications")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("kind", "access_request_pending")
    .eq("resource_type", ACCESS_REQUEST_BURST_RESOURCE_TYPE)
    .eq("resource_id", orgId)
    .is("read_at", null)
    .is("actor_user_id", null)
    .in("user_id", recipients);
  if (openErr) {
    console.warn(`[request-access] ${why}, and the pool's open notices could not be read (${openErr.message}) — no notice was written for this request`);
    return;
  }
  const told = new Set(((open as Array<{ user_id: string }> | null) ?? []).map((r) => r.user_id));
  const rest = recipients.filter((u) => !told.has(u));
  if (rest.length > 0) {
    const { error } = await notifyBatchWithReason(rest.map((uid) => ({
      orgId,
      userId: uid,
      kind: "access_request_pending" as const,
      title: `More access requests are waiting for ${orgName}`,
      body: `More than ${ACCESS_REQUEST_NOTICES_PER_ORG_HOUR} people asked to join ${orgName} within an hour, so they are no longer announced one by one. Every request is listed under Admin → Users: review them there.`,
      link: "/admin/users",
      resourceType: ACCESS_REQUEST_BURST_RESOURCE_TYPE,
      resourceId: orgId,
      metadata: { accessRequestBurst: true },
    })), supabaseAdmin);
    if (error) console.warn(`[request-access] the pool's "more requests are waiting" notice was not written: ${error}`);
  }
  console.warn(`[request-access] ${why} — this request gets no notice of its own; ${rest.length} pool member(s) newly told that more are waiting, ${told.size} already were`);
}

/** PROD-2: a request nobody hears about is a request nobody answers. After
 *  the row is written, every active member of the org holding Admin or
 *  DocCtrl (headline or additive role, lib/notify/recipients.ts) gets a bell
 *  row (access_request_pending, linking to Admin → Users, where the pending
 *  requests are listed) and an email. The row names no actor — the person
 *  at the door has no account; a service-role row (20261160 passes it
 *  untouched). The email's subject names no one (a role pool, NEDGE-6);
 *  the requester's name and address are in its body. Best-effort and never
 *  thrown: the request is already recorded and the response is unchanged.
 *  The bound client is the service role (runWithServerClient), so the
 *  shared-client helpers write as the server.
 *
 *  This door is public and unauthenticated, and the notice multiplies one
 *  request into a message per pool member from the app's own sender — so
 *  nothing typed here reaches it unchecked (N8's review fix): the name is
 *  stripped of control and line-break characters and of anything that
 *  reads as a link (noticeSafeName); an address that is not ONE well-formed
 *  address is shown as "invalid address" and gets no email leg
 *  (wellFormedAddress); and past ACCESS_REQUEST_NOTICES_PER_ORG_HOUR
 *  requests to the org in an hour — or when that count cannot be read — a
 *  request gets neither a bell row nor an email of its own: the pool is
 *  told once that more are waiting (notifyAccessRequestBurst). The per-IP
 *  limiter (fails open, exempts an unknown IP, trusts the first
 *  x-forwarded-for entry) cannot bound this; the per-org count does. */
async function notifyAccessRequest(input: {
  orgId: string; orgName: string; displayName: string; email: string; requestId: string | null;
}): Promise<void> {
  try {
    await runWithServerClient(supabaseAdmin, async () => {
      const recipients = await resolveRoleRecipients(input.orgId, [...ACCESS_REQUEST_AUDIENCE]);
      if (recipients.length === 0) return;
      // The per-org cap gates BOTH legs (a count that cannot be read counts
      // as past it).
      const recent = await requestsToOrgLastHour(input.orgId);
      if (recent === null || recent > ACCESS_REQUEST_NOTICES_PER_ORG_HOUR) {
        await notifyAccessRequestBurst(input.orgId, input.orgName, recipients, recent);
        return;
      }
      // The name and the address are typed at a public door: made safe
      // before they reach a bell or an email.
      const address = wellFormedAddress(input.email);
      const name = noticeSafeName(input.displayName, 80) || address || "Someone";
      const title = `${name} asked to join ${input.orgName}`;
      const body = `${name} (${address ?? "invalid address"}) asked for access to ${input.orgName}. Review the request under Admin → Users: add them as a member, or decline it.`;
      await notifyMany({
        orgId: input.orgId,
        userIds: recipients,
        kind: "access_request_pending",
        title,
        body,
        link: "/admin/users",
        resourceType: "access_request",
        resourceId: input.requestId ?? undefined,
        metadata: input.requestId ? { accessRequestId: input.requestId } : undefined,
      });
      // The email leg: only for a well-formed address.
      if (!address) {
        console.warn("[request-access] the request's address is not a single well-formed address — the pool was told by bell only");
        return;
      }
      const { data: rows } = await supabaseAdmin
        .from("org_members")
        .select("uid, email")
        .eq("org_id", input.orgId)
        .eq("status", "active")
        .in("uid", recipients);
      await Promise.all(((rows as Array<{ uid: string; email: string | null }> | null) ?? [])
        .filter((m) => !!m.email)
        .map((m) => queueEmail({
          orgId: input.orgId,
          toUserId: m.uid,
          toEmail: m.email as string,
          subject: "Access request waiting for review",
          bodyText: `${title}.\n\n${body}`,
          eventType: "assignment",
          metadata: input.requestId ? { accessRequestId: input.requestId } : undefined,
        })));
    });
  } catch (e) {
    console.warn("[request-access] the access request was recorded but its notice was not sent", (e as Error).message);
  }
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  try {
    if (await requestAccessRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many access requests from this network. Please wait a while and try again." },
        { status: 429 },
      );
    }

    const { displayName, email: rawEmail, orgName } = await req.json();

    if (!displayName || !rawEmail || !orgName) {
      await recordAttempt(ip, null, "error");
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }
    // One canonical casing for identity (IDENT-3).
    const email = normalizeEmail(String(rawEmail));

    // Consume one attempt from the per-IP window BEFORE the org lookup, so
    // repeated 404 org-name probing and 409 duplicate probing both count
    // against the limit rather than being free.
    await recordAttempt(ip, email, "request-access");

    // 1. Find the organization (case-insensitive)
    const { data: org } = await supabaseAdmin
      .from("orgs")
      .select("id, name")
      .ilike("name", orgName.trim())
      .maybeSingle();

    if (!org) {
      return NextResponse.json(
        { error: `No organization named "${orgName}" was found. Check spelling, or create a new organization if you're the first admin.` },
        { status: 404 }
      );
    }

    const orgId = (org as { id: string; name: string }).id;
    const orgRealName = (org as { id: string; name: string }).name;

    // 2. Check for duplicate pending request — case-insensitively (IDENT-3),
    // and refuse on a failed lookup rather than reading it as "no pending
    // request" and stacking a duplicate row.
    const { data: existingReqs, error: dupCheckError } = await applyEmailLookup(
      supabaseAdmin.from("access_requests").select("id, status"),
      "email",
      email
    )
      .eq("org_id", orgId)
      .eq("status", "pending")
      .limit(1);
    if (dupCheckError) {
      return NextResponse.json(
        { error: "Couldn't check for an existing request — please try again." },
        { status: 500 }
      );
    }
    const existingReq = existingReqs?.[0] ?? null;

    if (existingReq) {
      return NextResponse.json(
        { error: `You already have a pending request to join "${orgRealName}". Please wait for an admin to respond.` },
        { status: 409 }
      );
    }

    // 3. Insert request linked to the org
    const { data: inserted, error: insertError } = await supabaseAdmin.from("access_requests").insert({
      org_id: orgId,
      org_name: orgRealName,
      display_name: displayName,
      email,
      status: "pending",
      created_at: new Date().toISOString(),
    }).select("id").maybeSingle();

    if (insertError) {
      return NextResponse.json({ error: `Failed to submit request: ${insertError.message}` }, { status: 500 });
    }

    // 4. Tell the people who can answer it (PROD-2).
    await notifyAccessRequest({
      orgId, orgName: orgRealName, displayName: String(displayName), email,
      requestId: ((inserted as { id?: string } | null)?.id) ?? null,
    });

    return NextResponse.json({ ok: true, orgName: orgRealName });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unexpected server error.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
