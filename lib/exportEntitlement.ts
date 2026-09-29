// lib/exportEntitlement.ts
//
// XEDGE-8: the ONE plan gate for cloud-bucket (S3/R2) backup destinations,
// shared by POST (create), PATCH (edit) and the scheduled runner. The gate
// used to live on create only, so a Starter org could create a bucket-less
// destination and PATCH the bucket (and credentials, and a daily schedule)
// onto it afterwards — arming the paid feature the create refused.
//
// XEDGE-7: the scheduled runner's whole-workspace gate. An unattended nightly
// push of the entire document-control database must not outlive (1) the
// person who configured the destination, (2) the workspace's subscription or
// (3) the plan the bucket feature is sold on. (2) and (3) are billing-webhook-
// derived state, so per DEC-18 their REFUSAL rides SUBSCRIPTION_ENFORCE:
// with the flag off the would-be skip is logged and recorded on the run and
// the export proceeds, byte-identical to before. (1) is not billing state and
// always applies — a departed engineer's private bucket must stop receiving
// the plant's database the night they are deactivated, and the fix is an
// active Admin re-saving the destination.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthError } from "@/lib/serverAuth";
import { hasAccess, type SubscriptionInfo } from "@/lib/subscription";

/** Plans that include cloud-bucket backup destinations. */
export const CLOUD_BUCKET_PLANS: ReadonlySet<string> = new Set(["growth", "enterprise"]);

/** Pure: may a workspace on `plan` / `status` hold an S3/R2 bucket
 *  destination? Trials may configure one to evaluate; Starter cannot. */
export function cloudBucketAllowed(plan: string | null | undefined, status: string | null | undefined): boolean {
  return (!!plan && CLOUD_BUCKET_PLANS.has(plan)) || status === "trialing";
}

export const CLOUD_BUCKET_REFUSAL =
  "Cloud backup destinations (S3/R2) require the Growth plan. Upgrade in Billing to enable scheduled cloud backups.";

/** Same wording as `assertOrgHasAccess` (lib/serverAuth.ts) — one message
 *  for a lapsed workspace wherever it is refused. */
export const SUBSCRIPTION_INACTIVE_REFUSAL =
  "This workspace's subscription is inactive. Renew billing to continue.";

/** The org columns the scheduled gate reads — ONCE — for both billing limbs. */
interface OrgBillingRow {
  subscription_status?: string | null;
  subscribed_plan?: string | null;
  trial_ends_at?: string | null;
}

/** Null when the org may hold a bucket destination; a 402 AuthError otherwise. */
export async function assertCloudBucketEntitlement(admin: SupabaseClient, orgId: string): Promise<AuthError | null> {
  const { data: org } = await admin
    .from("orgs").select("subscription_status, subscribed_plan").eq("id", orgId).maybeSingle();
  const row = (org as { subscribed_plan?: string | null; subscription_status?: string | null } | null) ?? null;
  if (cloudBucketAllowed(row?.subscribed_plan, row?.subscription_status)) return null;
  return { error: CLOUD_BUCKET_REFUSAL, status: 402 };
}

export interface ScheduledGateDestination {
  id: string;
  org_id: string;
  bucket?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
}

export type ScheduledRunVerdict =
  | { ok: true; notices: string[] }
  | { ok: false; reason: string; notices: string[] };

/** Decide whether a due scheduled destination may run right now. Never
 *  throws. One error rule for all three limbs: a lookup that errors (or finds
 *  no row) cannot prove entitlement, so it is treated exactly like a definite
 *  refusal on that limb — the membership limb skips; the subscription and
 *  plan limbs skip under SUBSCRIPTION_ENFORCE and notice without it. The
 *  claim already advanced `next_run_at`, so a transient database fault costs
 *  one cycle, never a push a person could not have vetted. (This gate does
 *  NOT call `assertOrgHasAccess`, whose fail-open on lookup error is meant
 *  for interactive billable mutations, not an unattended export.) */
export async function scheduledRunGate(
  admin: SupabaseClient,
  dest: ScheduledGateDestination,
  enforceBilling: boolean,
): Promise<ScheduledRunVerdict> {
  const notices: string[] = [];

  // (1) The person who last confirmed this configuration must still be an
  //     active member. `updated_by` is stamped on every PATCH, `created_by`
  //     on create, so the last saver is the last confirmer.
  const configurer = dest.updated_by || dest.created_by || null;
  if (!configurer) {
    return { ok: false, reason: "this destination has no recorded configurer — an active Admin must open it and save it again to re-confirm", notices };
  }
  const { data: member, error: memberErr } = await admin
    .from("org_members").select("uid")
    .eq("org_id", dest.org_id).eq("uid", configurer).eq("status", "active")
    .maybeSingle();
  if (memberErr) {
    return { ok: false, reason: `the configurer's membership could not be verified (${memberErr.message}); retried next cycle`, notices };
  }
  if (!member) {
    return { ok: false, reason: "the member who last configured this destination is no longer active in this workspace — an active Admin must open it and save it again to re-confirm", notices };
  }

  // (2) + (3) Billing state, read ONCE (DEC-18: refusal behind the flag).
  const billing = (limb: string, reason: string): ScheduledRunVerdict | null => {
    if (enforceBilling) return { ok: false, reason, notices };
    notices.push(`${limb} gate would skip this run (SUBSCRIPTION_ENFORCE off): ${reason}`);
    return null;
  };
  const { data: orgData, error: orgErr } = await admin
    .from("orgs").select("subscription_status, subscribed_plan, trial_ends_at")
    .eq("id", dest.org_id).maybeSingle();
  const org = (orgData as OrgBillingRow | null) ?? null;
  if (orgErr || !org) {
    // Neither limb can be proven from an unreadable or missing row.
    const verdict = billing("billing", `the workspace's subscription could not be verified (${orgErr?.message ?? "no workspace row"}); retried next cycle`);
    return verdict ?? { ok: true, notices };
  }

  // (2) Subscription — the same status rule as assertOrgHasAccess.
  const info: SubscriptionInfo = {
    status: (org.subscription_status as SubscriptionInfo["status"]) || "trialing",
    trialEndsAt: org.trial_ends_at ?? null,
  };
  if (!hasAccess(info)) {
    const verdict = billing("subscription", `workspace subscription inactive — ${SUBSCRIPTION_INACTIVE_REFUSAL}`);
    if (verdict) return verdict;
  }

  // (3) Plan entitlement for a bucket destination (same rule as create/PATCH).
  if (dest.bucket && !cloudBucketAllowed(org.subscribed_plan, org.subscription_status)) {
    const verdict = billing("plan", `plan no longer includes cloud bucket destinations — ${CLOUD_BUCKET_REFUSAL}`);
    if (verdict) return verdict;
  }

  return { ok: true, notices };
}
