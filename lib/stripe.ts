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

/** The plan a subscription is on: its first item's price id through the
 *  map, else the checkout-time metadata, else null — and null means "leave
 *  the stored plan untouched", never "write NULL". */
export function planFromSubscription(sub: SubscriptionPlanSource): { plan: string | null; source: "price" | "metadata" | null } {
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  const fromPrice = getPlanForPriceId(priceId);
  if (fromPrice) return { plan: fromPrice, source: "price" };
  const fromMeta = (sub.metadata?.plan ?? "").trim();
  if (fromMeta) return { plan: fromMeta, source: "metadata" };
  return { plan: null, source: null };
}
