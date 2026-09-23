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
import { assertOrgHasAccess, type AuthError } from "@/lib/serverAuth";

/** Plans that include cloud-bucket backup destinations. */
export const CLOUD_BUCKET_PLANS: ReadonlySet<string> = new Set(["growth", "enterprise"]);

/** Pure: may a workspace on `plan` / `status` hold an S3/R2 bucket
 *  destination? Trials may configure one to evaluate; Starter cannot. */
export function cloudBucketAllowed(plan: string | null | undefined, status: string | null | undefined): boolean {
  return (!!plan && CLOUD_BUCKET_PLANS.has(plan)) || status === "trialing";
}

export const CLOUD_BUCKET_REFUSAL =
  "Cloud backup destinations (S3/R2) require the Growth plan. Upgrade in Billing to enable scheduled cloud backups.";

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
 *  throws: a lookup ERROR on the membership check is a notice (fail-open on a
 *  transient database fault), a definite "no active row" is a skip. */
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
    notices.push(`configurer membership could not be checked (${memberErr.message}); proceeding`);
  } else if (!member) {
    return { ok: false, reason: "the member who last configured this destination is no longer active in this workspace — an active Admin must open it and save it again to re-confirm", notices };
  }

  // (2) Subscription (DEC-18: refusal behind the flag).
  const sub = await assertOrgHasAccess(admin, dest.org_id);
  if (sub) {
    if (enforceBilling) return { ok: false, reason: `workspace subscription inactive — ${sub.error}`, notices };
    notices.push(`subscription gate would skip this run (SUBSCRIPTION_ENFORCE off): ${sub.error}`);
  }

  // (3) Plan entitlement for a bucket destination (same rule as create/PATCH).
  if (dest.bucket) {
    const plan = await assertCloudBucketEntitlement(admin, dest.org_id);
    if (plan) {
      if (enforceBilling) return { ok: false, reason: `plan no longer includes cloud bucket destinations — ${plan.error}`, notices };
      notices.push(`plan gate would skip this run (SUBSCRIPTION_ENFORCE off): ${plan.error}`);
    }
  }

  return { ok: true, notices };
}
