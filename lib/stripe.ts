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
