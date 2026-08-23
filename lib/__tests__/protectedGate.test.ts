// Pins the protected layout's gating contract (audit findings SESS-1 / SESS-3).
//
// The defect being pinned: the old layout ladder was
//   loading → "none" → "error" → render the app
// with NO branch for membershipState === "resolving". RoleContext seeds
// `activeRole` to the literal "Viewer" and `roles` to [], and two watchdogs
// deliberately force `loading` false while resolution is still in flight —
// so the input { loading: false, uid set, membershipState: "resolving" }
// was reachable and rendered the full app as a fake Viewer. Under the old
// ladder that input mapped to "app"; the contract here is that it can never
// be "app" again.

import { describe, it, expect } from "vitest";
import { resolveProtectedView, type MembershipState } from "@/lib/protectedGate";

describe("resolveProtectedView", () => {
  it("never renders the app while a signed-in user's membership is still resolving (SESS-1)", () => {
    // The exact reproduction: watchdog fired (loading force-cleared), uid
    // known, answer not yet landed. The old layout rendered "app" here.
    const view = resolveProtectedView({ loading: false, uid: "u1", membershipState: "resolving" });
    expect(view).toBe("resolving");
    expect(view).not.toBe("app");
  });

  it("keeps the authenticating spinner while loading, whatever the membership state", () => {
    const states: MembershipState[] = ["resolving", "member", "none", "error"];
    for (const membershipState of states) {
      expect(resolveProtectedView({ loading: true, uid: "u1", membershipState })).toBe("authenticating");
      expect(resolveProtectedView({ loading: true, uid: null, membershipState })).toBe("authenticating");
    }
  });

  it("hard-stops a signed-in account with no membership", () => {
    expect(resolveProtectedView({ loading: false, uid: "u1", membershipState: "none" })).toBe("no-membership");
  });

  it("offers retry when the lookup itself failed", () => {
    expect(resolveProtectedView({ loading: false, uid: "u1", membershipState: "error" })).toBe("membership-error");
  });

  it("renders the app only once membership is resolved", () => {
    expect(resolveProtectedView({ loading: false, uid: "u1", membershipState: "member" })).toBe("app");
  });

  it("exhaustively: 'app' is reachable for a signed-in user ONLY via membershipState 'member'", () => {
    const states: MembershipState[] = ["resolving", "member", "none", "error"];
    for (const membershipState of states) {
      const view = resolveProtectedView({ loading: false, uid: "u1", membershipState });
      if (membershipState === "member") expect(view).toBe("app");
      else expect(view).not.toBe("app");
    }
  });

  it("preserves the signed-out passthrough (route guards elsewhere own that case)", () => {
    // uid null, not loading → the layout renders children; per-page guards
    // and the SIGNED_OUT redirect handle unauthenticated visitors. This test
    // pins that the SESS-1 fix did not change that existing behavior.
    const states: MembershipState[] = ["resolving", "member", "none", "error"];
    for (const membershipState of states) {
      expect(resolveProtectedView({ loading: false, uid: null, membershipState })).toBe("app");
    }
  });
});
