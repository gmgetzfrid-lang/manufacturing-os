// lib/subscription.ts
//
// Helpers for figuring out an org's current subscription state. The
// data lives on the orgs table (subscription_status, trial_ends_at,
// current_period_end) and is fetched by the SubscriptionProvider.
//
// Status meaning:
//   trialing  - inside the free trial window. Full access.
//   active    - paying customer with current subscription. Full access.
//   past_due  - subscription renewal payment failed. Grace period; warn but allow access.
//   canceled  - subscription canceled or trial expired without subscribing. Read-only or blocked.
//   unpaid    - multiple failed payments. Blocked.
//   paused    - manual admin pause. Blocked.

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export interface SubscriptionInfo {
  status: SubscriptionStatus;
  plan?: string | null;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}

export function trialDaysRemaining(info: SubscriptionInfo | null): number | null {
  if (!info || info.status !== "trialing" || !info.trialEndsAt) return null;
  const ms = new Date(info.trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export function isTrialExpired(info: SubscriptionInfo | null): boolean {
  if (!info) return false;
  if (info.status !== "trialing") return false;
  if (!info.trialEndsAt) return false;
  return new Date(info.trialEndsAt).getTime() < Date.now();
}

export function hasAccess(info: SubscriptionInfo | null): boolean {
  // No subscription info loaded yet — fail-open so the app doesn't lock
  // users out during a transient lookup failure.
  if (!info) return true;
  if (info.status === "active") return true;
  if (info.status === "past_due") return true; // grace period
  if (info.status === "trialing") return !isTrialExpired(info);
  return false;
}

export function shouldShowTrialBanner(info: SubscriptionInfo | null): boolean {
  if (!info) return false;
  if (info.status !== "trialing") return false;
  const days = trialDaysRemaining(info);
  return days !== null;
}
