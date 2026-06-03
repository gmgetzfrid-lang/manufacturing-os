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
import { hasAccess, type SubscriptionInfo } from "@/lib/subscription";

export type AuthorizedActor = {
  userId: string;
  email: string;
  orgId: string;
  role: string;
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
    .select("role, status")
    .eq("org_id", orgId)
    .eq("uid", data.user.id)
    .maybeSingle();
  const role = (member as { role?: string } | null)?.role;
  const status = (member as { status?: string } | null)?.status;
  if (status !== "active") return { error: "Not a member of this org", status: 403 };
  if (!allowedRoles.includes(role || "")) return { error: "Insufficient role", status: 403 };

  return {
    userId: data.user.id,
    email: data.user.email || "",
    orgId,
    role: role!,
    admin,
  };
}

/**
 * Server-side subscription gate for billable mutations (e.g. adding seats).
 * Returns null when the workspace may proceed, or an AuthError (402) when the
 * subscription has lapsed. Fail-open on lookup error so a transient DB issue
 * never blocks a paying customer.
 *
 * NOTE: data-export / data-portability routes intentionally do NOT call this —
 * a lapsed workspace must always be able to get its data out.
 */
export async function assertOrgHasAccess(
  admin: SupabaseClient,
  orgId: string,
): Promise<AuthError | null> {
  const { data, error } = await admin
    .from("orgs")
    .select("subscription_status, trial_ends_at")
    .eq("id", orgId)
    .maybeSingle();
  if (error || !data) return null; // fail-open
  const row = data as { subscription_status?: string; trial_ends_at?: string | null };
  const info: SubscriptionInfo = {
    status: (row.subscription_status as SubscriptionInfo["status"]) || "trialing",
    trialEndsAt: row.trial_ends_at ?? null,
  };
  if (hasAccess(info)) return null;
  return {
    error: "This workspace's subscription is inactive. Renew billing to continue.",
    status: 402,
  };
}
