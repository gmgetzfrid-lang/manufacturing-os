// lib/serverAuth.ts
//
// Shared helper for API routes that need to verify the caller's identity
// AND their org-membership role. Pattern: pull bearer token from headers,
// resolve the user via Supabase anon client, then re-query org_members
// with service-role to get role + status.
//
// Service-role usage is gated behind the user-token check. We never act
// on behalf of a user we haven't verified.

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { hasAccess, type SubscriptionInfo } from "@/lib/billing";
import { normalizeRoles } from "@/lib/roleCapabilities";

export type AuthorizedActor = {
  userId: string;
  email: string;
  orgId: string;
  /** Headline role (kept for audit rows — unchanged by SURF-10). */
  role: string;
  /** SURF-10: the full held collection; the gate evaluates against it. */
  roles: string[];
  admin: SupabaseClient;   // service-role client, scoped to this request
};

export type AuthError = { error: string; status: number };

export async function authorizeOrgRole(
  req: Request,
  orgId: string,
  allowedRoles: string[],
): Promise<AuthorizedActor | AuthError> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return { error: "Server is missing Supabase credentials", status: 500 };
  }

  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) return { error: "Missing access token", status: 401 };
  if (!orgId) return { error: "orgId is required", status: 400 };

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) return { error: "Unauthorized", status: 401 };

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data: member } = await admin
    .from("org_members")
    .select("role, roles, status")
    .eq("org_id", orgId)
    .eq("uid", data.user.id)
    .maybeSingle();
  const role = (member as { role?: string } | null)?.role;
  const status = (member as { status?: string } | null)?.status;
  if (status !== "active") return { error: "Not a member of this org", status: 403 };
  // SURF-10: the gate reads the UNION of the headline and the additive
  // collection, matching the database's is_org_controller — a member holding
  // DocCtrl additively under a Manager headline is admitted to DocCtrl routes.
  // normalizeRoles seeds from the headline, so a pre-backfill `roles: []`
  // row still evaluates its headline.
  const held: string[] = normalizeRoles((member as { roles?: unknown } | null)?.roles, role);
  if (!held.some((r) => allowedRoles.includes(r))) return { error: "Insufficient role", status: 403 };

  return {
    userId: data.user.id,
    email: data.user.email || "",
    orgId,
    role: role || held[0] || "",
    roles: held,
    admin,
  };
}

/**
 * A PostgREST client that runs AS THE CALLER: the anon key plus the request's
 * own bearer, so every read passes through RLS exactly as the caller's
 * browser session would. For a route that decides ENTRY on the server but
 * must never hand back more rows than the caller's own session could see
 * (WF-20: the analytics data — `documents_acl_select` hides the private /
 * hidden nodes the ACL does not admit them to, and a service-role read would
 * not). Verify the caller with authorizeOrgRole / authorizeAdminSurface
 * FIRST — this helper only carries their token, it does not check it.
 */
export function callerScopedClient(req: Request): SupabaseClient | AuthError {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !anonKey) return { error: "Server is missing Supabase credentials", status: 500 };
  const accessToken = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return { error: "Missing access token", status: 401 };
  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  });
}

// ── Subscription enforcement (DEC-18; admin-and-org BILL-10 / ORG-9 / BILL-14,
//    Round G P5) ─────────────────────────────────────────────────────────────
//
// ONE switch: the server environment variable SUBSCRIPTION_ENFORCE. Exactly
// "true" turns enforcement on; anything else (unset by default) leaves it off.
// Flipping it is the operator's business decision (DEC-18), never a code
// change: with it off every flow is exactly as before, and the would-be
// refusals are only logged; with it on, a LAPSED workspace — a subscription
// that is canceled, unpaid or paused, or a free trial whose end has passed
// (hasAccess, lib/billing.ts; past_due is the grace period and keeps access)
// — is refused by the server on the routes that mint a seat or new stored
// bytes (create-user, storage/upload-url, storage/multipart create — the
// contractor intake door is not yet one of them: BILL-10), and the app shows
// a strip above every page saying so (components/subscription/
// SubscriptionGate.tsx, which asks /api/subscription/access); the pages
// themselves still render, for reading. Other row writes are NOT refused
// while lapsed (BILL-10's Partial). Nothing is ever deleted, and getting the
// data out is never gated: the data-export routes, /admin/storage's full
// backup and every download stay open.
// The scheduled-export sweep and Run Now read the same variable
// (lib/exportEntitlement.ts, app/api/data-export/run/route.ts).

/** Is subscription enforcement switched on? (SUBSCRIPTION_ENFORCE === "true") */
export function subscriptionEnforced(): boolean {
  return process.env.SUBSCRIPTION_ENFORCE === "true";
}

/** The refusal a lapsed workspace reads, naming why — one sentence for every
 *  route that refuses, and for the lapsed-workspace strip. Exported for the
 *  tests. */
export function lapsedWorkspaceMessage(info: Pick<SubscriptionInfo, "status" | "trialEndsAt">): string {
  const why =
    info.status === "trialing" ? "This workspace's free trial has ended"
      : info.status === "canceled" ? "This workspace's subscription was canceled"
        : info.status === "unpaid" ? "This workspace has an unpaid invoice"
          : info.status === "paused" ? "This workspace's subscription is paused"
            : "This workspace's subscription is inactive";
  return `${why}, so adding members and uploading new files are paused until billing is renewed (an Admin or Manager can do that under Admin → Billing). Nothing has been deleted, and an Admin can still export the whole workspace from Admin → Data export or Admin → Storage & Backup.`;
}

/**
 * The subscription check for billable mutations (seats, new stored bytes).
 * Returns null when the workspace has access, or an AuthError (402) naming
 * why it has none. It does NOT look at the switch — callers use
 * enforceOrgAccess, which does.
 *
 * Fail-open on a lookup error, a missing row, or a thrown read: a transient
 * database fault must never lock a paying customer out of a regulated
 * document system (DEC-18's rationale). The scheduled-export gate chose the
 * opposite on purpose (lib/exportEntitlement.ts), because a skipped push is
 * retried the next night and harms nobody.
 *
 * NOTE: data-export / data-portability routes intentionally do NOT call this —
 * a lapsed workspace must always be able to get its data out.
 */
export async function assertOrgHasAccess(
  admin: SupabaseClient,
  orgId: string,
): Promise<AuthError | null> {
  let data: unknown = null;
  try {
    const res = await admin
      .from("orgs")
      .select("subscription_status, trial_ends_at")
      .eq("id", orgId)
      .maybeSingle();
    if (res.error || !res.data) return null; // fail-open
    data = res.data;
  } catch {
    return null; // fail-open: a thrown read is a transient fault too
  }
  const row = data as { subscription_status?: string; trial_ends_at?: string | null };
  const info: SubscriptionInfo = {
    status: (row.subscription_status as SubscriptionInfo["status"]) || "trialing",
    trialEndsAt: row.trial_ends_at ?? null,
  };
  if (hasAccess(info)) return null;
  return { error: lapsedWorkspaceMessage(info), status: 402 };
}

/** How often the switch-off "would refuse" line is written per workspace,
 *  per server process (the integrator's ruling 2 at the AO-P5 merge,
 *  2026-10-20, DEC-90): once an hour, so a lapsed workspace uploading a
 *  thousand files writes one line, not a thousand. */
export const WOULD_REFUSE_LOG_TTL_MS = 3600_000;

/** org id → when its last "would refuse" line was written, and how many
 *  would-refuse calls were not logged since (said on the next line). */
const wouldRefuseLog = new Map<string, { loggedAt: number; suppressed: number }>();

/** Clears the per-org log throttle. For the tests only. */
export function resetWouldRefuseLogForTests(): void {
  wouldRefuseLog.clear();
}

function logWouldRefuse(where: string, orgId: string, sentence: string): void {
  const now = Date.now();
  const last = wouldRefuseLog.get(orgId);
  if (last && now - last.loggedAt < WOULD_REFUSE_LOG_TTL_MS) {
    last.suppressed += 1;
    return;
  }
  // Bound the map: entries past their hour carry nothing worth keeping.
  if (wouldRefuseLog.size >= 10_000) {
    for (const [k, v] of wouldRefuseLog) if (now - v.loggedAt >= WOULD_REFUSE_LOG_TTL_MS) wouldRefuseLog.delete(k);
  }
  const quiet = last && last.suppressed > 0
    ? ` (${last.suppressed} more would-refuse call(s) for this workspace were not logged since the last line)`
    : "";
  wouldRefuseLog.set(orgId, { loggedAt: now, suppressed: 0 });
  console.warn(`[${where}] subscription gate would refuse org ${orgId} (SUBSCRIPTION_ENFORCE off): ${sentence}${quiet}`);
}

/**
 * The one call a route that mints a seat or new stored bytes makes (DEC-18).
 * Switch off: never refuses — a lapsed workspace's would-be refusal is logged
 * (`[where] subscription gate would refuse …`, at most once per workspace per
 * hour per server process, the next line counting the calls not logged) so
 * the operator can see the blast radius before switching it on. Switch on:
 * answers the 402 the route returns as it is (nothing is throttled).
 */
export async function enforceOrgAccess(
  admin: SupabaseClient,
  orgId: string,
  where: string,
): Promise<AuthError | null> {
  const gate = await assertOrgHasAccess(admin, orgId);
  if (!gate) return null;
  if (subscriptionEnforced()) return gate;
  logWouldRefuse(where, orgId, gate.error);
  return null;
}

/** The server's answer for the lapsed-workspace strip (GET /api/subscription/access). */
export type OrgAccessVerdict = { enforced: boolean; access: boolean; reason: string | null };

/** What the strip should say for this workspace. Switch off: `access: true`
 *  without reading anything — the app renders exactly as before. Switch on:
 *  the same check the billable routes make (fail-open on a fault). */
export async function orgAccessVerdict(admin: SupabaseClient, orgId: string): Promise<OrgAccessVerdict> {
  if (!subscriptionEnforced()) return { enforced: false, access: true, reason: null };
  const gate = await assertOrgHasAccess(admin, orgId);
  return gate ? { enforced: true, access: false, reason: gate.error } : { enforced: true, access: true, reason: null };
}
