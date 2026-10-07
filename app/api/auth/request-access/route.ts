import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeEmail, applyEmailLookup } from "@/lib/identity";
import { notifyMany } from "@/lib/inAppNotifications";
import { queueEmail } from "@/lib/notifications";
import { resolveRoleRecipients } from "@/lib/notify/recipients";
import { runWithServerClient } from "@/lib/serverClientScope";
import {
  ACCESS_REQUEST_AUDIENCE, ACCESS_REQUEST_EMAILS_PER_ORG_HOUR, noticeSafeName, wellFormedAddress,
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

/** The email leg's per-org cap: how many requests this org received in the
 *  last hour, the new one included. null when the count cannot be read —
 *  the caller then sends the bell row only (the cap fails closed: the bell
 *  still tells the pool). */
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
 *  (wellFormedAddress); and past ACCESS_REQUEST_EMAILS_PER_ORG_HOUR requests
 *  to the org in an hour the pool gets the bell row only. */
async function notifyAccessRequest(input: {
  orgId: string; orgName: string; displayName: string; email: string; requestId: string | null;
}): Promise<void> {
  try {
    await runWithServerClient(supabaseAdmin, async () => {
      const recipients = await resolveRoleRecipients(input.orgId, [...ACCESS_REQUEST_AUDIENCE]);
      if (recipients.length === 0) return;
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
      // The email leg: only for a well-formed address, and only while the
      // org's hourly request count is within the cap (read failure: none).
      if (!address) {
        console.warn("[request-access] the request's address is not a single well-formed address — the pool was told by bell only");
        return;
      }
      const recent = await requestsToOrgLastHour(input.orgId);
      if (recent === null || recent > ACCESS_REQUEST_EMAILS_PER_ORG_HOUR) {
        console.warn(`[request-access] ${recent === null ? "the org's request count could not be read" : `${recent} requests to this org in the last hour`} — the pool was told by bell only`);
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
