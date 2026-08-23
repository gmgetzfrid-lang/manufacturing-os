// Pins the device-workspace ownership contract (audit finding IDENT-4).
//
// The defect being pinned: manufacturingos.activeOrgId was keyed by nothing
// but a constant string, so after user A signed out and user B signed in on
// the same browser, B's boot consulted A's workspace as its first candidate —
// found no membership for B's uid there — and dropped into the self-heal
// relocation (ORGSEL-1). The contract: a stored workspace owned by a
// different uid is invalid; an unowned (legacy) value stays accepted.

import { describe, it, expect, vi, afterEach } from "vitest";
import { validateStoredOrg, readStoredOrgId, readStoredOrgIdFor, writeStoredOrgId, clearStoredOrgId } from "@/lib/workspaceDeviceState";

/** Minimal in-memory localStorage so the storage-backed wrappers — the code
 *  RoleContext actually calls at resolution time — run for real, not just
 *  their SSR early-returns (adversarial-review coverage finding). */
function stubWindowWithStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  vi.stubGlobal("window", { localStorage });
  return store;
}

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

describe("storage wrappers against a real (stubbed) localStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("full cross-account cycle: write as A, read as B → null AND the stale value is cleared", () => {
    const store = stubWindowWithStorage();
    writeStoredOrgId("org-a", "uid-A");
    expect(readStoredOrgId()).toBe("org-a");
    expect(readStoredOrgIdFor("uid-A")).toBe("org-a");

    // Identity B on the same browser must not inherit A's workspace…
    expect(readStoredOrgIdFor("uid-B")).toBeNull();
    // …and the mismatch clears BOTH keys so it cannot keep resurfacing.
    expect(store.size).toBe(0);
    expect(readStoredOrgIdFor("uid-A")).toBeNull();
  });

  it("accepts a legacy unowned value written before the owner stamp existed", () => {
    const store = stubWindowWithStorage();
    store.set("manufacturingos.activeOrgId", "org-legacy"); // raw pre-fix write
    expect(readStoredOrgIdFor("uid-anyone")).toBe("org-legacy");
  });

  it("an unstamped write (uid not yet propagated) clears any stale owner stamp", () => {
    const store = stubWindowWithStorage();
    writeStoredOrgId("org-a", "uid-A");
    writeStoredOrgId("org-b", null); // early workspace switch, uid unknown
    expect(store.get("manufacturingos.activeOrgId")).toBe("org-b");
    expect(store.has("manufacturingos.activeOrgId.owner")).toBe(false);
    expect(readStoredOrgIdFor("uid-B")).toBe("org-b"); // unowned → accepted
  });

  it("clearStoredOrgId removes both keys", () => {
    const store = stubWindowWithStorage();
    writeStoredOrgId("org-a", "uid-A");
    clearStoredOrgId();
    expect(store.size).toBe(0);
  });
});
