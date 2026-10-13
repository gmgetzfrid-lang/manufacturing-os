// @vitest-environment jsdom
//
// admin-and-org Round G, package P4 — BILL-8 Done-when 1, the page half: the
// billing page (app/(protected)/admin/billing/page.tsx) sends a workspace
// that holds a subscription Stripe still bills (past due, unpaid, a Stripe
// trial — lib/subscription.ts holdsLiveSubscription) to the Customer Portal
// instead of showing the plans grid, since subscribing again would start a
// second subscription beside it. A workspace with no billed subscription (the
// app's own trial, a canceled one, an incomplete first checkout that never
// paid, and — review fix pass — a paused one, which raises no invoice and
// which the portal cannot resume) still sees the plans.
// Rendered: the page is mounted with the subscription context answering.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SubscriptionInfo } from "@/lib/subscription";

const ctx = vi.hoisted(() => ({ info: null as SubscriptionInfo | null, roles: ["Admin"] as string[] }));

vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "org-1", activeRole: ctx.roles[0], hasAnyRole: (r: string[]) => r.some((x) => ctx.roles.includes(x)) }),
}));
vi.mock("@/components/providers/SubscriptionProvider", () => ({
  useSubscription: () => ({ info: ctx.info, loading: false, refresh: async () => undefined }),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } },
}));

import BillingPage from "@/app/(protected)/admin/billing/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  ctx.roles = ["Admin"];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(info: SubscriptionInfo | null) {
  ctx.info = info;
  await act(async () => { root.render(React.createElement(BillingPage)); });
  const text = container.textContent ?? "";
  return {
    text,
    plans: Array.from(container.querySelectorAll("h2")).some((h) => h.textContent === "Plans")
      && Array.from(container.querySelectorAll("button")).some((x) => x.textContent === "Subscribe"),
    portal: Array.from(container.querySelectorAll("button")).some((b) => /Manage subscription \/ payment/.test(b.textContent ?? "")),
  };
}

const future = new Date(Date.now() + 20 * 86400_000).toISOString();
const past = new Date(Date.now() - 20 * 86400_000).toISOString();

describe("BILL-8 — a workspace with a live subscription is sent to the portal, not the plans grid", () => {
  it("past due on a Stripe subscription: the portal, no plans", async () => {
    const r = await render({ status: "past_due", plan: "growth", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    expect(r.portal).toBe(true);
    expect(r.plans).toBe(false);
  });

  it("unpaid on a Stripe subscription: the portal from the red card, no plans", async () => {
    const r = await render({ status: "unpaid", plan: null, stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    expect(r.portal).toBe(true);
    expect(r.plans).toBe(false);
    expect(r.text).toMatch(/Payment Failed/);
    expect(r.text).toMatch(/Update your payment method in the billing portal to restore access\./);
  });

  it("a Stripe trial (trialing with a subscription id): the portal, no plans", async () => {
    const r = await render({ status: "trialing", trialEndsAt: future, stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    expect(r.portal).toBe(true);
    expect(r.plans).toBe(false);
  });

  it("a Stripe trial after the app's own trial clock lapsed (trialing, past trialEndsAt, a subscription id): the portal, no plans, and the red card points at the portal, not at a plans grid that is not there (third review fix pass)", async () => {
    const r = await render({ status: "trialing", trialEndsAt: past, stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    expect(r.portal).toBe(true);
    expect(r.plans).toBe(false);
    expect(r.text).toMatch(/Manage your subscription in the billing portal\./);
    expect(r.text).not.toMatch(/Pick a plan below/);
  });

  it("active: the portal and no plans, as before", async () => {
    const r = await render({ status: "active", plan: "growth", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    expect(r.portal).toBe(true);
    expect(r.plans).toBe(false);
  });
});

describe("regression — a workspace with no live subscription still sees the plans", () => {
  it("the app's own trial (no subscription id): plans", async () => {
    const r = await render({ status: "trialing", trialEndsAt: future, stripeSubscriptionId: null });
    expect(r.plans).toBe(true);
    expect(r.portal).toBe(false);
  });

  it("the app's own trial, expired (no subscription id): 'Trial Expired', the plans and the 'Pick a plan below' line, as before", async () => {
    const r = await render({ status: "trialing", trialEndsAt: past, stripeSubscriptionId: null });
    expect(r.plans).toBe(true);
    expect(r.portal).toBe(false);
    expect(r.text).toMatch(/Trial Expired/);
    expect(r.text).toMatch(/Your free trial has ended\. Pick a plan below to continue\./);
  });

  it("canceled (the subscription id cleared by the deleted event): plans", async () => {
    const r = await render({ status: "canceled", plan: null, stripeSubscriptionId: null, stripeCustomerId: "cus_1" });
    expect(r.plans).toBe(true);
    expect(r.text).toMatch(/Subscription Canceled/);
  });

  it("paused on a Stripe subscription (review fix pass): the plans, and a line saying the portal cannot resume it", async () => {
    const r = await render({ status: "paused", plan: null, stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    expect(r.plans).toBe(true);
    expect(r.portal).toBe(false);
    expect(r.text).toMatch(/Subscription Paused/);
    expect(r.text).toMatch(/Stripe raises no invoice on a paused subscription, and the billing portal cannot resume it\. Pick a plan below to subscribe again, or ask support to resume it\./);
  });

  it("an unpaid row with no subscription id (no subscription to manage in the portal): plans, so the admin can subscribe", async () => {
    const r = await render({ status: "unpaid", plan: null, stripeSubscriptionId: null, stripeCustomerId: "cus_1" });
    expect(r.plans).toBe(true);
    expect(r.portal).toBe(false);
  });

  it("a Viewer sees neither the plans nor the portal button", async () => {
    ctx.roles = ["Viewer"];
    const r = await render({ status: "unpaid", stripeSubscriptionId: "sub_1" });
    expect(r.plans).toBe(false);
    expect(r.portal).toBe(false);
  });
});
