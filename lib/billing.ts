// lib/billing.ts — the org's billing (Stripe subscription) state. TABLE:
// public.orgs (its subscription_status, trial_ends_at, current_period_end and
// Stripe columns — DEC-98). It is NOT the watch / follow list: that is the
// `subscriptions` table, read by lib/watches.ts.
//
// Renamed from lib/subscription.ts (NEDGE-21, notifications Round G N15):
// the old name was one letter from the watch module (lib/subscriptions.ts,
// now lib/watches.ts) — the collision that hid NEDGE-8.
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

// ── admin-and-org P4 (BILL-1 / BILL-8): the Stripe status, read once ──────
//
// The orgs column takes only the six values of its CHECK constraint
// (20260601_billing.sql); Stripe has more, and may add others. The webhook
// maps every Stripe status through mapStripeStatus, and the rule is the
// conservative one (DEC-98 §1): a status that means "no payment has
// been taken" (incomplete, incomplete_expired) or one this code does not know
// maps to a value that grants NO access — never to active or trialing.

/** The app statuses that grant access (hasAccess, before the trial clock). */
export const ACCESS_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(["active", "trialing", "past_due"]);

/** Stripe statuses under which Stripe keeps the subscription: the webhook
 *  records it as the workspace's stripe_subscription_id. incomplete (never
 *  paid; it expires on its own), incomplete_expired and canceled are not live. */
export const LIVE_STRIPE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

/** The live statuses under which Stripe keeps billing the subscription, or
 *  raising its invoices (unpaid): checkout refuses a second subscription beside
 *  one of these (BILL-8). A paused subscription raises no invoice and the
 *  Customer Portal cannot resume it, so a paused workspace may subscribe again
 *  (review fix pass). */
export const BILLED_STRIPE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due", "unpaid"]);

/** Stripe statuses of a subscription that never started: its first invoice was
 *  never paid (incomplete), and Stripe then gave up on it (incomplete_expired).
 *  Such a subscription, and one in a status this code does not know, changes
 *  only a workspace already on it: never the app's own trial (DEC-98
 *  §6, review fix pass). */
export const UNSTARTED_STRIPE_STATUSES: ReadonlySet<string> = new Set(["incomplete", "incomplete_expired"]);

/** Stripe statuses on which the subscription's plan is written to the org
 *  (BILL-1 Done-when 2): the subscription has been paid for, or is in a
 *  Stripe trial of it, or is past due on a plan it paid for. */
export const PLAN_HOLDING_STRIPE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);

/** Stripe subscription status → the orgs.subscription_status value.
 *  `known` is false for a status this code does not know (it maps to
 *  `unpaid`, no access, and the webhook records that it did). */
export function mapStripeStatus(stripeStatus: string | null | undefined): { status: SubscriptionStatus; known: boolean } {
  switch (stripeStatus) {
    case "active": return { status: "active", known: true };
    case "trialing": return { status: "trialing", known: true };
    case "past_due": return { status: "past_due", known: true };
    case "canceled":
    case "incomplete_expired":
      return { status: "canceled", known: true };
    case "unpaid": return { status: "unpaid", known: true };
    case "paused": return { status: "paused", known: true };
    // The first invoice was never paid (declined, or 3-D Secure abandoned):
    // no money has moved, so it is not a trial and not a plan.
    case "incomplete": return { status: "unpaid", known: true };
    default: return { status: "unpaid", known: false };
  }
}

/** Does the workspace hold a subscription Stripe still bills (BILL-8)? Read
 *  from the org row: a subscription id with any status but canceled or paused
 *  (BILLED_STRIPE_STATUSES). The checkout route confirms it with Stripe before
 *  refusing. */
export function holdsLiveSubscription(info: Pick<SubscriptionInfo, "status" | "stripeSubscriptionId"> | null): boolean {
  return !!info?.stripeSubscriptionId && info.status !== "canceled" && info.status !== "paused";
}
