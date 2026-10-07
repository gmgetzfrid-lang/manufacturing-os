// lib/stripe.ts
//
// Server-side Stripe client singleton + plan/price mapping.
// Pulls credentials from env vars set in Vercel:
//   STRIPE_SECRET_KEY        sk_test_... (or sk_live_... in prod)
//   STRIPE_PRICE_STARTER     price_... for Starter monthly
//   STRIPE_PRICE_GROWTH      price_... for Growth monthly
//
// If STRIPE_SECRET_KEY is missing, getStripe() throws a clear error
// the API routes surface as a 503. This means the rest of the app keeps
// working pre-Stripe-setup; only billing endpoints fail until env vars
// are added.

import Stripe from "stripe";
import { LIVE_STRIPE_STATUSES, holdsLiveSubscription, type SubscriptionStatus } from "@/lib/subscription";

let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  client = new Stripe(key, { apiVersion: "2024-11-20.acacia" as Stripe.LatestApiVersion });
  return client;
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export type PlanKey = "starter" | "growth";

export function getPriceIdForPlan(plan: PlanKey): string | null {
  if (plan === "starter") return process.env.STRIPE_PRICE_STARTER || null;
  if (plan === "growth") return process.env.STRIPE_PRICE_GROWTH || null;
  return null;
}

export const PLAN_LABELS: Record<PlanKey, string> = {
  starter: "Starter",
  growth: "Growth",
};

// ── XEDGE-14: price id → plan (the inverse of getPriceIdForPlan) ──────────
//
// CONFIGURATION. The webhook derives `subscribed_plan` from the price the
// subscription is billed on, NOT from the checkout-time metadata — a plan
// change made in the Stripe Customer Portal never rewrites subscription
// metadata, so metadata alone left the app on the old plan (and an update
// event without metadata nulled it). The map reads the same env vars
// checkout uses; when a new plan is sold, add its STRIPE_PRICE_<PLAN>
// variable here and set it in the deployment — nothing else has to change.
export const PRICE_ID_ENV_TO_PLAN: ReadonlyArray<readonly [envVar: string, plan: string]> = [
  ["STRIPE_PRICE_STARTER", "starter"],
  ["STRIPE_PRICE_GROWTH", "growth"],
  // Recognised by the cloud-bucket gate (lib/exportEntitlement.ts); set the
  // variable when an enterprise price exists in the Stripe account.
  ["STRIPE_PRICE_ENTERPRISE", "enterprise"],
];

/** The plan key sold under `priceId`, or null when the id is not one of ours. */
export function getPlanForPriceId(priceId: string | null | undefined): string | null {
  if (!priceId) return null;
  for (const [envVar, plan] of PRICE_ID_ENV_TO_PLAN) {
    const configured = process.env[envVar];
    if (configured && configured === priceId) return plan;
  }
  return null;
}

/** Minimal structural view of a Stripe subscription — what the webhook reads. */
export interface SubscriptionPlanSource {
  items?: { data?: Array<{ price?: { id?: string | null } | null }> } | null;
  metadata?: Record<string, string> | null;
}

/** The plan a subscription is on: the first of its items whose price id is
 *  in the map (a subscription may also carry seat add-ons or metered items,
 *  in any order), else the checkout-time metadata, else null — and null
 *  means "leave the stored plan untouched", never "write NULL". */
export function planFromSubscription(sub: SubscriptionPlanSource): { plan: string | null; source: "price" | "metadata" | null } {
  for (const item of sub.items?.data ?? []) {
    const fromPrice = getPlanForPriceId(item?.price?.id);
    if (fromPrice) return { plan: fromPrice, source: "price" };
  }
  const fromMeta = (sub.metadata?.plan ?? "").trim();
  if (fromMeta) return { plan: fromMeta, source: "metadata" };
  return { plan: null, source: null };
}

// ── admin-and-org P4 (BILL-6 / BILL-8): whose customer, which subscription ──

/** BILL-8 Done-when 3: the Stripe idempotency key for creating a workspace's
 *  customer. Two Subscribe clicks (or a retry after the org row refused the
 *  customer id) get the same customer back from Stripe for 24 hours instead
 *  of minting a second one; a second admin's concurrent click with other
 *  details is refused by Stripe rather than racing. */
export function customerIdempotencyKey(orgId: string): string {
  return `org-customer:${orgId}`;
}

type StripeRefusal = { status: number; error: string };
const isStripeMissing = (e: unknown) =>
  (e as { code?: string } | null)?.code === "resource_missing" || (e as { statusCode?: number } | null)?.statusCode === 404;

/** BILL-6 Done-when 4: may a Customer Portal session be opened for
 *  `customerId` on behalf of `orgId`? A customer whose metadata names another
 *  workspace, a deleted customer or one Stripe does not know is refused (409);
 *  a customer with no org metadata (made before checkout stamped it, or by
 *  hand in the dashboard) is allowed, as before. Null when allowed. */
export async function customerOwnershipRefusal(stripe: Stripe, customerId: string, orgId: string): Promise<StripeRefusal | null> {
  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await stripe.customers.retrieve(customerId);
  } catch (e) {
    if (isStripeMissing(e)) return { status: 409, error: "The Stripe customer on file for this workspace does not exist in Stripe, so the billing portal was not opened. Ask support to relink billing." };
    return { status: 502, error: `Could not confirm this workspace's Stripe customer (${(e as Error).message}). Try again.` };
  }
  if ((customer as Stripe.DeletedCustomer).deleted) {
    return { status: 409, error: "The Stripe customer on file for this workspace was deleted in Stripe, so the billing portal was not opened. Ask support to relink billing." };
  }
  const owner = (customer as Stripe.Customer).metadata?.org_id;
  if (owner && owner !== orgId) {
    return { status: 409, error: "The Stripe customer on file belongs to another workspace, so the billing portal was not opened. Ask support to relink billing." };
  }
  return null;
}

/** BILL-8 Done-when 1: the live subscription a second checkout would sit
 *  beside, or null. The org row is read first (no subscription id, or a
 *  canceled one: no Stripe call, as before); a row that names a live
 *  subscription is confirmed with Stripe, so a stale row (a cancellation
 *  whose event was lost, an incomplete subscription that never paid) does
 *  not block a legitimate subscribe. */
export async function liveSubscriptionRefusal(
  stripe: Stripe,
  row: { stripe_subscription_id?: string | null; subscription_status?: string | null },
): Promise<StripeRefusal | null> {
  const subscriptionId = row.stripe_subscription_id ?? null;
  if (!holdsLiveSubscription({ status: (row.subscription_status ?? "trialing") as SubscriptionStatus, stripeSubscriptionId: subscriptionId })) return null;
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(subscriptionId!);
  } catch (e) {
    if (isStripeMissing(e)) return null;
    return { status: 502, error: `Could not confirm this workspace's existing subscription with Stripe (${(e as Error).message}); nothing was started. Try again.` };
  }
  if (!LIVE_STRIPE_STATUSES.has(sub.status)) return null;
  return {
    status: 409,
    error: `This workspace already has a subscription (${sub.status.replace(/_/g, " ")}). Use "Manage subscription / payment" to change plan or update the card — subscribing again would bill the workspace twice.`,
  };
}
