// lib/__tests__/documentGuards.test.ts
//
// Exhaustive tests for the PURE publish-guard decision. These encode the
// document-control invariants: you cannot publish a new revision of a
// document that is locked by someone else or sitting on an active hold,
// unless you are a controller explicitly forcing it.

import { describe, it, expect } from "vitest";
import {
  evaluatePublishGuard,
  isControllerRoleName,
  isDocumentCheckedOut,
  hasStaleCollaborators,
  type PublishGuardState,
} from "@/lib/documentGuards";
import type { DocumentHold } from "@/types/schema";

const ME = "user-me";
const OTHER = "user-other";

function hold(reason: string): DocumentHold {
  return {
    id: `hold-${reason}`,
    orgId: "org-1",
    documentId: "doc-1",
    reason,
    notes: null,
    expectedReleaseAt: null,
    openedBy: OTHER,
    openedByName: "Other",
    openedAt: new Date().toISOString(),
    releasedBy: null,
    releasedByName: null,
    releasedAt: null,
    releasedReason: null,
  } as DocumentHold;
}

const unlockedNoHolds: PublishGuardState = { checkedOutBy: null, activeHolds: [] };

describe("isControllerRoleName", () => {
  it("recognizes Admin and DocCtrl only", () => {
    expect(isControllerRoleName("Admin")).toBe(true);
    expect(isControllerRoleName("DocCtrl")).toBe(true);
    expect(isControllerRoleName("Engineer")).toBe(false);
    expect(isControllerRoleName("Drafter")).toBe(false);
    expect(isControllerRoleName(null)).toBe(false);
    expect(isControllerRoleName(undefined)).toBe(false);
  });
});

describe("evaluatePublishGuard — happy paths", () => {
  it("allows publishing an unlocked, hold-free document", () => {
    expect(evaluatePublishGuard(unlockedNoHolds, { actorUserId: ME }).ok).toBe(true);
  });

  it("allows the lock holder to publish their own checked-out document", () => {
    const state: PublishGuardState = { checkedOutBy: ME, checkedOutByName: "Me", activeHolds: [] };
    expect(evaluatePublishGuard(state, { actorUserId: ME }).ok).toBe(true);
  });

  it("compares lock holder loosely (string/uuid mismatch tolerated)", () => {
    const state: PublishGuardState = { checkedOutBy: ME, activeHolds: [] };
    // actorUserId passed as the same value — must match even if types differ upstream
    expect(evaluatePublishGuard(state, { actorUserId: `${ME}` }).ok).toBe(true);
  });
});

describe("evaluatePublishGuard — lock blocking", () => {
  it("blocks when the document is locked by another user", () => {
    const state: PublishGuardState = { checkedOutBy: OTHER, checkedOutByName: "Dana", activeHolds: [] };
    const d = evaluatePublishGuard(state, { actorUserId: ME });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("locked_by_other");
    expect(d.message).toContain("Dana");
  });

  it("names 'another user' when the holder name is unknown", () => {
    const state: PublishGuardState = { checkedOutBy: OTHER, activeHolds: [] };
    const d = evaluatePublishGuard(state, { actorUserId: ME });
    expect(d.message).toContain("another user");
  });

  it("lets a controller force past a foreign lock", () => {
    const state: PublishGuardState = { checkedOutBy: OTHER, activeHolds: [] };
    expect(evaluatePublishGuard(state, { actorUserId: ME, actorRole: "Admin", force: true }).ok).toBe(true);
    expect(evaluatePublishGuard(state, { actorUserId: ME, actorRole: "DocCtrl", force: true }).ok).toBe(true);
  });

  it("does NOT let a non-controller force past a foreign lock", () => {
    const state: PublishGuardState = { checkedOutBy: OTHER, activeHolds: [] };
    expect(evaluatePublishGuard(state, { actorUserId: ME, actorRole: "Engineer", force: true }).ok).toBe(false);
  });

  it("requires force=true even for controllers (a controller without force is still blocked)", () => {
    const state: PublishGuardState = { checkedOutBy: OTHER, activeHolds: [] };
    expect(evaluatePublishGuard(state, { actorUserId: ME, actorRole: "Admin" }).ok).toBe(false);
  });
});

describe("evaluatePublishGuard — hold blocking", () => {
  it("blocks when an active hold exists", () => {
    const state: PublishGuardState = { checkedOutBy: null, activeHolds: [hold("Client Review")] };
    const d = evaluatePublishGuard(state, { actorUserId: ME });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("on_hold");
    expect(d.message).toContain("Client Review");
    expect(d.blockingHolds).toHaveLength(1);
  });

  it("lists every active hold reason and pluralizes", () => {
    const state: PublishGuardState = {
      checkedOutBy: null,
      activeHolds: [hold("Awaiting Engineering"), hold("Missing Vendor Data")],
    };
    const d = evaluatePublishGuard(state, { actorUserId: ME });
    expect(d.message).toContain("Awaiting Engineering");
    expect(d.message).toContain("Missing Vendor Data");
    expect(d.message).toContain("holds"); // plural
  });

  it("blocks the lock holder too when there's an active hold", () => {
    const state: PublishGuardState = { checkedOutBy: ME, activeHolds: [hold("Client Review")] };
    expect(evaluatePublishGuard(state, { actorUserId: ME }).ok).toBe(false);
  });

  it("lets a controller force past an active hold", () => {
    const state: PublishGuardState = { checkedOutBy: null, activeHolds: [hold("Client Review")] };
    expect(evaluatePublishGuard(state, { actorUserId: ME, actorRole: "Admin", force: true }).ok).toBe(true);
  });
});

describe("evaluatePublishGuard — precedence", () => {
  it("reports the lock before the hold when both block", () => {
    const state: PublishGuardState = { checkedOutBy: OTHER, activeHolds: [hold("Client Review")] };
    const d = evaluatePublishGuard(state, { actorUserId: ME });
    expect(d.code).toBe("locked_by_other");
  });
});

describe("isDocumentCheckedOut — the authoritative lock signal", () => {
  it("is checked out when a lock holder is present", () => {
    expect(isDocumentCheckedOut({ checkedOutBy: ME })).toBe(true);
  });

  it("is NOT checked out when there is no lock holder", () => {
    expect(isDocumentCheckedOut({ checkedOutBy: null })).toBe(false);
    expect(isDocumentCheckedOut({ checkedOutBy: undefined })).toBe(false);
    expect(isDocumentCheckedOut({})).toBe(false);
    expect(isDocumentCheckedOut(null)).toBe(false);
    expect(isDocumentCheckedOut(undefined)).toBe(false);
  });

  it("treats an empty-string lock holder as NOT checked out", () => {
    expect(isDocumentCheckedOut({ checkedOutBy: "" })).toBe(false);
  });

  it("is NOT checked out for a zombie row: collaborators present but no lock", () => {
    // This is the exact phantom-checkout state: active_collaborators populated
    // (e.g. legacy data) while the lock columns are null.
    const zombie = { checkedOutBy: null, activeCollaborators: ["ggetzfrid"] } as {
      checkedOutBy: string | null;
      activeCollaborators: string[];
    };
    expect(isDocumentCheckedOut(zombie)).toBe(false);
  });
});

describe("hasStaleCollaborators — zombie detection", () => {
  it("flags a populated collaborator list with no lock holder", () => {
    expect(hasStaleCollaborators({ checkedOutBy: null, activeCollaborators: ["ggetzfrid"] })).toBe(true);
  });

  it("does NOT flag a properly locked document (collaborators + lock)", () => {
    expect(hasStaleCollaborators({ checkedOutBy: ME, activeCollaborators: ["ggetzfrid"] })).toBe(false);
  });

  it("does NOT flag a clean document (no lock, no collaborators)", () => {
    expect(hasStaleCollaborators({ checkedOutBy: null, activeCollaborators: [] })).toBe(false);
    expect(hasStaleCollaborators({ checkedOutBy: null })).toBe(false);
    expect(hasStaleCollaborators(null)).toBe(false);
    expect(hasStaleCollaborators(undefined)).toBe(false);
  });
});
