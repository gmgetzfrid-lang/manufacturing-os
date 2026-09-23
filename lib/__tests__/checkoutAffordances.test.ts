// Document-control Round F — DCK-13 / HLD-8 (checkout half): the force-release
// button and the Inspector's hold controls read the SAME capability policy
// the database enforces — role tokens, the additive roles[] collection and
// live per-person grants — instead of a hardcoded role pair. The controller
// vocabulary in lib/documentGuards.ts is sourced from lib/permissions.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { canForceReleaseCheckout, holdAffordances } from "@/lib/checkoutAffordances";
import { isControllerRoleName } from "@/lib/documentGuards";
import { isControllerRole } from "@/lib/permissions";
import type { CapabilityPolicy } from "@/lib/capabilityPolicy";
import type { Role } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("canForceReleaseCheckout — the checkout.force_release capability, not a role pair", () => {
  it("no policy loaded yet = the shipped default (Admin, DocCtrl), so an unconfigured org is byte-identical to before", () => {
    expect(canForceReleaseCheckout(null, "Admin", null, "a")).toBe(true);
    expect(canForceReleaseCheckout(null, "DocCtrl", [], "c")).toBe(true);
    expect(canForceReleaseCheckout(null, "Drafter", [], "d")).toBe(false);
    expect(canForceReleaseCheckout(undefined, "Manager", ["Supervisor"], "m")).toBe(false);
  });

  it("honours the additive collection the way is_org_controller does: a Manager who also holds DocCtrl may force-release", () => {
    expect(canForceReleaseCheckout(null, "Manager", ["Manager", "DocCtrl"], "m")).toBe(true);
    expect(canForceReleaseCheckout(null, null, ["DocCtrl"], "m")).toBe(true);
  });

  it("NARROWING removes the button: checkout.force_release = [Admin] hides it from every DocCtrl (the DB would refuse them)", () => {
    const narrowed: CapabilityPolicy = { caps: { "checkout.force_release": ["Admin"] } };
    expect(canForceReleaseCheckout(narrowed, "DocCtrl", ["DocCtrl"], "c")).toBe(false);
    expect(canForceReleaseCheckout(narrowed, "Admin", ["Admin"], "a")).toBe(true);
  });

  it("WIDENING shows the button: delegating to DraftingSupervisor is no longer inert; a personal grant lights it for that person only", () => {
    const widened: CapabilityPolicy = { caps: { "checkout.force_release": ["Admin", "DocCtrl", "DraftingSupervisor"] } };
    expect(canForceReleaseCheckout(widened, "DraftingSupervisor", null, "ds")).toBe(true);
    const granted: CapabilityPolicy = { grants: [{ cap: "checkout.force_release", uid: "turnaround-lead", expiresAt: null }] };
    expect(canForceReleaseCheckout(granted, "Drafter", ["Drafter"], "turnaround-lead")).toBe(true);
    expect(canForceReleaseCheckout(granted, "Drafter", ["Drafter"], "someone-else")).toBe(false);
    const expired: CapabilityPolicy = { grants: [{ cap: "checkout.force_release", uid: "turnaround-lead", expiresAt: "2000-01-01T00:00:00Z" }] };
    expect(canForceReleaseCheckout(expired, "Drafter", ["Drafter"], "turnaround-lead")).toBe(false);
  });
});

describe("holdAffordances — holds.open / holds.release from the policy (HLD-8 done-when 1 & 3)", () => {
  it("default policy is '*': every active member may place and release", () => {
    expect(holdAffordances(null, "Viewer", [], "v")).toEqual({ canOpen: true, canRelease: true });
  });

  it("a user holding ONLY a UserGrant for holds.release sees the Release control; without it the narrowed org hides it", () => {
    const policy: CapabilityPolicy = {
      caps: { "holds.release": ["Admin", "DocCtrl"] },
      grants: [{ cap: "holds.release", uid: "coordinator", expiresAt: null, note: "turnaround" }],
    };
    expect(holdAffordances(policy, "Requester", ["Requester"], "coordinator")).toEqual({ canOpen: true, canRelease: true });
    expect(holdAffordances(policy, "Requester", ["Requester"], "someone-else")).toEqual({ canOpen: true, canRelease: false });
  });

  it("a role outside the literal lists but inside the policy is admitted (the old UI blocked people the policy allowed)", () => {
    const policy: CapabilityPolicy = { caps: { "holds.open": ["Auditor"] } };
    expect(holdAffordances(policy, "Auditor", ["Auditor"], "au").canOpen).toBe(true);
    expect(holdAffordances(policy, "Manager", ["Manager"], "m").canOpen).toBe(false);
  });
});

describe("the controller vocabulary is spelled once (DCK-13 done-when 3)", () => {
  it("documentGuards.isControllerRoleName agrees with lib/permissions.isControllerRole for every role", () => {
    const roles: Role[] = ["Admin", "DocCtrl", "Manager", "Supervisor", "Drafter", "Viewer", "Auditor", "Requester", "Engineer-1"] as Role[];
    for (const r of roles) expect(isControllerRoleName(r), r).toBe(isControllerRole(r));
    expect(isControllerRoleName(null)).toBe(false);
    expect(isControllerRoleName(undefined)).toBe(false);
  });

  it("source pins: no literal controller pair in documentGuards; the two checkout surfaces gate on the capability", () => {
    const guards = src("lib/documentGuards.ts");
    expect(guards).not.toMatch(/new Set\(\["Admin", "DocCtrl"\]\)/);
    expect(guards).toMatch(/isControllerRole\(role as Role\)/);
    // the stale "a defense-in-depth trigger enforces the same rule" claim is gone (DCK-6)
    expect(guards).not.toMatch(/enforces the same rule at the DB layer for any path that bypasses/);
    expect(guards).toMatch(/lives only in the publish_revision RPC/);

    const cell = src("components/documents/CheckoutStatusCell.tsx");
    expect(cell).toMatch(/useForceReleaseAllowed\(docRecord\.orgId/);
    expect(cell).toMatch(/canForceReleaseCheckout\(policy, role, roles, uid\)/);
    expect(cell).not.toMatch(/r === 'Admin' \|\| r === 'DocCtrl'/);
    // DCK-5: no FORCE_RELEASE pre-write on the surface; the reason is collected
    expect(cell).not.toMatch(/type: "FORCE_RELEASE"/);
    expect(cell).toMatch(/placeholder: "Reason for releasing this lock \(required\)"/);
    expect(cell).toMatch(/reason: reason\.trim\(\)/);

    const inspector = src("components/documents/InspectorPanel.tsx");
    expect(inspector).toMatch(/\{canForceRelease && isCheckedOut && onForceUnlock && \(/);
    expect(inspector).not.toMatch(/\{isController && isCheckedOut && onForceUnlock && \(/);
    expect(inspector).toMatch(/canEdit=\{canOpenHold \|\| canReleaseHold\}/);
    expect(inspector).toMatch(/activeHoldCount === 0 && canOpenHold && \(/);
    expect(inspector).not.toMatch(/activeHoldCount === 0 && \(canManageAssets \|\| isOwner\)/);

    const lib = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(lib).toMatch(/actorEmail: userEmail \?\? null,\s*\n\s*actorRole: activeRole \?\? null,\s*\n\s*reason: reason\.trim\(\),/);
  });

  it("forceReleaseDocument is the one FORCE_RELEASE writer under app/, components/ and lib/", () => {
    const out = execSync(`grep -rln 'type: "FORCE_RELEASE"' app components lib --include=*.ts --include=*.tsx | grep -v __tests__ || true`, { cwd: process.cwd() }).toString().trim().split("\n").filter(Boolean);
    expect(out).toEqual(["lib/checkoutEpisodes.ts"]);
  });
});
