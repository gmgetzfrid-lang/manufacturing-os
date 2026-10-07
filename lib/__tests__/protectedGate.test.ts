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
//
// The `booted` dimension (added after adversarial review of the fix): before
// getSession settles, a null uid means "not known yet", not "signed out" —
// the 6s watchdog can clear `loading` while an expired token is still being
// refreshed, and rendering the app then is the same placeholder render.

import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProtectedView, type MembershipState } from "@/lib/protectedGate";
import type { useRole } from "@/components/providers/RoleContext";
import type { Role } from "@/types/schema";

const STATES: MembershipState[] = ["resolving", "member", "none", "error"];

describe("resolveProtectedView", () => {
  it("never renders the app while a signed-in user's membership is still resolving (SESS-1)", () => {
    // The exact reproduction: watchdog fired (loading force-cleared), uid
    // known, answer not yet landed. The old layout rendered "app" here.
    const view = resolveProtectedView({ loading: false, uid: "u1", membershipState: "resolving", booted: true });
    expect(view).toBe("resolving");
    expect(view).not.toBe("app");
  });

  it("keeps the authenticating spinner while loading, whatever the membership state", () => {
    for (const membershipState of STATES) {
      for (const booted of [true, false]) {
        expect(resolveProtectedView({ loading: true, uid: "u1", membershipState, booted })).toBe("authenticating");
        expect(resolveProtectedView({ loading: true, uid: null, membershipState, booted })).toBe("authenticating");
      }
    }
  });

  it("keeps the spinner when boot hasn't identified anyone yet, even after the loading watchdog fires", () => {
    // Adversarial-review quadrant: 6s watchdog cleared `loading` while
    // getSession is still refreshing an expired token — uid null is "not
    // known yet", and rendering the app would be the placeholder render.
    for (const membershipState of STATES) {
      expect(resolveProtectedView({ loading: false, uid: null, membershipState, booted: false })).toBe("authenticating");
    }
  });

  it("hard-stops a signed-in account with no membership", () => {
    expect(resolveProtectedView({ loading: false, uid: "u1", membershipState: "none", booted: true })).toBe("no-membership");
  });

  it("offers retry when the lookup itself failed", () => {
    expect(resolveProtectedView({ loading: false, uid: "u1", membershipState: "error", booted: true })).toBe("membership-error");
  });

  it("renders the app only once membership is resolved", () => {
    expect(resolveProtectedView({ loading: false, uid: "u1", membershipState: "member", booted: true })).toBe("app");
  });

  it("exhaustively: 'app' is reachable for a signed-in user ONLY via membershipState 'member'", () => {
    for (const membershipState of STATES) {
      for (const booted of [true, false]) {
        const view = resolveProtectedView({ loading: false, uid: "u1", membershipState, booted });
        if (membershipState === "member") expect(view).toBe("app");
        else expect(view).not.toBe("app");
      }
    }
  });

  it("preserves the settled signed-out passthrough (route guards elsewhere own that case)", () => {
    // Boot finished, genuinely no session → the layout renders children;
    // per-page guards and the SIGNED_OUT redirect handle unauthenticated
    // visitors. Pinned so the SESS-1 fix's scope stays explicit.
    for (const membershipState of STATES) {
      expect(resolveProtectedView({ loading: false, uid: null, membershipState, booted: true })).toBe("app");
    }
  });
});

// SESS-6 (identity-and-session Round G, IS-P1): the placeholder this gate
// exists to keep off the screen is gone at its source — RoleContext seeds
// `activeRole` with null, not the literal "Viewer", and the type says so, so
// a consumer that reads it as a Role without a null branch fails tsc.
describe("SESS-6 — the role the gate withholds is null until resolved, not a placeholder Viewer", () => {
  const roleContext = readFileSync(join(process.cwd(), "components/providers/RoleContext.tsx"), "utf8");
  it("the seed is null and no reset writes \"Viewer\"", () => {
    expect(roleContext).toMatch(/useState<Role \| null>\(null\)/);
    expect(roleContext).not.toMatch(/useState<Role>\("Viewer"\)/);
    expect(roleContext).not.toMatch(/setActiveRole\("Viewer"\)/);
  });
  it("tsc shape: activeRole is Role | null, and an unchecked Role-typed read does not compile", () => {
    type Ctx = ReturnType<typeof useRole>;
    expectTypeOf<Ctx["activeRole"]>().toEqualTypeOf<Role | null>();
    const read = (c: Ctx): Role | null => c.activeRole;
    // @ts-expect-error — SESS-6: no Role-typed use of activeRole without a null branch
    const unchecked = (c: Ctx): Role => c.activeRole;
    expect(typeof read).toBe("function");
    expect(typeof unchecked).toBe("function");
  });
});
