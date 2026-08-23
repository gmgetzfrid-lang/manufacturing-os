// Pins the device-workspace ownership contract (audit finding IDENT-4).
//
// The defect being pinned: manufacturingos.activeOrgId was keyed by nothing
// but a constant string, so after user A signed out and user B signed in on
// the same browser, B's boot consulted A's workspace as its first candidate —
// found no membership for B's uid there — and dropped into the self-heal
// relocation (ORGSEL-1). The contract: a stored workspace owned by a
// different uid is invalid; an unowned (legacy) value stays accepted.

import { describe, it, expect } from "vitest";
import { validateStoredOrg, readStoredOrgId, readStoredOrgIdFor, writeStoredOrgId, clearStoredOrgId } from "@/lib/workspaceDeviceState";

describe("validateStoredOrg", () => {
  it("rejects a workspace stored by a different identity — the cross-account bleed", () => {
    expect(validateStoredOrg("org-a", "uid-microsoft", "uid-password")).toBeNull();
  });

  it("accepts the owner's own stored workspace", () => {
    expect(validateStoredOrg("org-a", "uid-1", "uid-1")).toBe("org-a");
  });

  it("accepts a legacy unowned value — the stamp invalidates, it does not gate", () => {
    expect(validateStoredOrg("org-a", null, "uid-1")).toBe("org-a");
  });

  it("returns null when nothing is stored", () => {
    expect(validateStoredOrg(null, null, "uid-1")).toBeNull();
    expect(validateStoredOrg(null, "uid-1", "uid-1")).toBeNull();
  });
});

describe("storage wrappers without a window (SSR / node)", () => {
  it("no-op safely so shared import graphs never throw at module scope", () => {
    expect(readStoredOrgId()).toBeNull();
    expect(readStoredOrgIdFor("uid-1")).toBeNull();
    expect(() => writeStoredOrgId("org-a", "uid-1")).not.toThrow();
    expect(() => clearStoredOrgId()).not.toThrow();
  });
});
