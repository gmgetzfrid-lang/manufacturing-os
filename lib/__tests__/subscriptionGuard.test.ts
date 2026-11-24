// lib/__tests__/subscriptionGuard.test.ts
//
// The server refuses changes from a workspace with no subscription. These
// check which requests are checked, the token read, and the decision.

import { describe, it, expect } from "vitest";
import { anyAccess, bearerUid, needsAccessCheck } from "@/lib/subscriptionGuard";

const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
const past = new Date(Date.now() - 5 * 86_400_000).toISOString();

describe("which requests are checked", () => {
  it("checks changes under /api", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(needsAccessCheck(m, "/api/tickets")).toBe(true);
  });
  it("leaves reading open", () => {
    expect(needsAccessCheck("GET", "/api/tickets")).toBe(false);
    expect(needsAccessCheck("HEAD", "/api/storage/download-url")).toBe(false);
  });
  it("always lets people pay, export, sign in, sign up and leave", () => {
    for (const p of ["/api/stripe/checkout", "/api/stripe/webhook", "/api/data-export/run", "/api/auth/membership",
      "/api/signup/checkout", "/api/cron/reminders", "/api/admin/remove-member", "/api/version"]) {
      expect(needsAccessCheck("POST", p)).toBe(false);
    }
  });
  it("doesn't confuse a longer name with an open one", () => {
    expect(needsAccessCheck("POST", "/api/admin/remove-members-bulk")).toBe(true);
    expect(needsAccessCheck("POST", "/api/stripe-like")).toBe(true);
  });
  it("only looks at /api", () => {
    expect(needsAccessCheck("POST", "/documents")).toBe(false);
  });
});

describe("the signed-in user", () => {
  const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  it("reads the user id from the token", () => {
    expect(bearerUid(`Bearer ${jwt({ sub: "u-1" })}`)).toBe("u-1");
  });
  it("is nobody without a usable token", () => {
    expect(bearerUid(null)).toBeNull();
    expect(bearerUid("Bearer nonsense")).toBeNull();
    expect(bearerUid(`Bearer ${jwt({ role: "anon" })}`)).toBeNull();
    expect(bearerUid("Basic abc.def.ghi")).toBeNull();
  });
});

describe("the decision", () => {
  it("refuses an ended trial", () => {
    expect(anyAccess([{ subscription_status: "trialing", trial_ends_at: past }])).toBe(false);
  });
  it("refuses canceled, unpaid and paused", () => {
    for (const s of ["canceled", "unpaid", "paused"]) expect(anyAccess([{ subscription_status: s, trial_ends_at: null }])).toBe(false);
  });
  it("allows active, past due (grace) and a running trial", () => {
    expect(anyAccess([{ subscription_status: "active", trial_ends_at: past }])).toBe(true);
    expect(anyAccess([{ subscription_status: "past_due", trial_ends_at: null }])).toBe(true);
    expect(anyAccess([{ subscription_status: "trialing", trial_ends_at: future }])).toBe(true);
    expect(anyAccess([{ subscription_status: null, trial_ends_at: null }])).toBe(true);
  });
  it("allows when any of the user's workspaces is paid", () => {
    expect(anyAccess([{ subscription_status: "canceled", trial_ends_at: null }, { subscription_status: "active", trial_ends_at: null }])).toBe(true);
  });
  it("leaves a user with no workspace to the route's own check", () => {
    expect(anyAccess([])).toBe(true);
  });
});
