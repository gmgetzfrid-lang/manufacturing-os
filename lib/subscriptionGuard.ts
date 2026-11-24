// lib/subscriptionGuard.ts
//
// The server half of "no subscription, no use": which requests proxy.ts
// checks, and the decision. Pure, so it is tested on its own.
//
// Only requests that CHANGE something are refused (POST, PUT, PATCH,
// DELETE under /api). Reading stays open, so a lapsed workspace can still
// see and export its own data. Paying, exporting, signing in and leaving
// are always allowed.

import { hasAccess, type SubscriptionStatus } from "@/lib/subscription";

/** Always allowed, lapsed or not. */
export const OPEN_WHEN_LAPSED = [
  "/api/stripe/",        // subscribe, billing portal, Stripe's own webhook
  "/api/data-export/",   // your data is yours
  "/api/auth/",          // sign-in, membership read
  "/api/signup/",        // a new workspace
  "/api/cron/",          // scheduled jobs (their own secret)
  "/api/admin/remove-member", // people can still be taken off
  "/api/brand/",
  "/api/version",
];

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Does this request need the workspace to have an active subscription? */
export function needsAccessCheck(method: string, path: string): boolean {
  if (!WRITES.has(method.toUpperCase())) return false;
  if (!path.startsWith("/api/")) return false;
  return !OPEN_WHEN_LAPSED.some((p) => p.endsWith("/")
    ? path.startsWith(p) || path === p.slice(0, -1)
    : path === p || path.startsWith(`${p}/`));
}

/** The signed-in user's id from "Bearer <jwt>", unverified. Only used to
 *  decide whether to refuse: a forged token gets past this check and is
 *  then refused by the route's own sign-in check. */
export function bearerUid(header: string | null | undefined): string | null {
  const m = /^Bearer\s+([^.\s]+)\.([^.\s]+)\.[^.\s]*$/i.exec(header ?? "");
  if (!m) return null;
  try {
    const json = JSON.parse(Buffer.from(m[2].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json?.sub === "string" && json.sub ? json.sub : null;
  } catch {
    return null;
  }
}

export interface OrgBilling { subscription_status: string | null; trial_ends_at: string | null }

/** Allowed when the user belongs to no workspace (the route decides), or
 *  when any of their workspaces has an active subscription or a trial
 *  still running. */
export function anyAccess(orgs: OrgBilling[]): boolean {
  if (orgs.length === 0) return true;
  return orgs.some((o) => hasAccess({
    status: ((o.subscription_status as SubscriptionStatus | null) || "trialing"),
    trialEndsAt: o.trial_ends_at,
  }));
}

export const LAPSED_MESSAGE =
  "This workspace has no active subscription, so changes are turned off. An admin can subscribe in Admin, Billing.";
