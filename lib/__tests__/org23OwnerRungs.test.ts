// admin-and-org ORG-23 (fleet F3 fix pass, DEC-90): the document-ownership
// rungs OUTSIDE lib/permissions.ts — each asks isEffectiveOwnerOfDocument
// after resolving the actor's principal — are a member's too. A principal
// known not to be an active member (resolveActorPrincipal's successful read
// with no active row, ORG-22) is not asked about ownership and is refused in
// plain words (NOT_ACTIVE_MEMBER_MESSAGE) before anything is written; an
// active member and an unknown status (no flag) pass the rung exactly as
// before, and a non-owner keeps today's refusal.
//
// Each door is driven to the first step after its authority check, which
// the mocks make throw PAST_GATE: reaching it means the gate admitted.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  principal: {} as Record<string, unknown>,
  isOwner: true,
  ownerAsked: 0,
}));

vi.mock("@/lib/principal", () => ({
  resolveActorPrincipal: vi.fn(async () => ({ ...state.principal })),
}));
vi.mock("@/lib/ownership", () => ({
  isEffectiveOwnerOfDocument: vi.fn(async () => { state.ownerAsked++; return state.isOwner; }),
  effectiveOwnerForDocument: vi.fn(async () => null),
  getOrgControllers: vi.fn(async () => []),
}));
vi.mock("@/lib/documentGuards", () => ({
  resolveCanControlLibrary: vi.fn(async () => false),
  fetchPublishGuardState: vi.fn(async () => { throw new Error("PAST_GATE"); }),
  evaluatePublishGuard: () => ({ ok: true }),
  DocumentMutationBlockedError: class DocumentMutationBlockedError extends Error {},
}));
vi.mock("@/lib/holdGate", async (orig) => ({
  ...(await orig<typeof import("@/lib/holdGate")>()),
  assertNotOnHold: vi.fn(async () => { throw new Error("PAST_GATE"); }),
  readActiveHolds: vi.fn(async () => { throw new Error("PAST_GATE"); }),
}));
vi.mock("@/lib/storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage")>()),
  uploadToPath: vi.fn(async () => { throw new Error("PAST_GATE"); }),
  makeLibraryStoragePath: () => "org1/lib1/x.pdf",
}));
vi.mock("@/lib/audit", () => ({ logRevisionEvent: vi.fn(async () => {}), logAuditAction: vi.fn(async () => {}) }));
/** Reads answer per table; any write is past every authority check. */
vi.mock("@/lib/supabase", () => {
  const rowFor = (table: string) =>
    table === "audit_logs"
      ? { id: "ev1", action: "DOC_RENUMBERED", resource_id: "doc1", details: { previousDocumentNumber: "P-1", newDocumentNumber: "P-2" }, timestamp: "2026-11-01T00:00:00Z" }
      : { document_number: "P-2", library_id: "lib1", legal_hold: false, status: "Released" };
  const chain = (table: string): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "order", "limit", "neq", "contains"]) q[m] = () => q;
    for (const w of ["update", "insert", "upsert", "delete"]) q[w] = () => { throw new Error("PAST_GATE"); };
    q.maybeSingle = async () => ({ data: rowFor(table), error: null });
    q.single = async () => ({ data: rowFor(table), error: null });
    q.then = (res: (v: unknown) => void) => res({ data: [rowFor(table)], error: null });
    return q;
  };
  return { supabase: { from: (t: string) => chain(t), rpc: async () => { throw new Error("PAST_GATE"); } } };
});

import { authorizePublish, correctRevisionLabel, authorizeArchive, backfillVersion } from "@/lib/revisions";
import { setRetentionPolicy, disposeDocument } from "@/lib/retention";
import { renumberDocument } from "@/lib/documentLifecycle/renumber";
import { reverseRenumber } from "@/lib/documentLifecycle/reverse";
import { NOT_ACTIVE_MEMBER_MESSAGE, knownInactive } from "@/lib/permissions";
import type { DocumentRecord } from "@/types/schema";

const doc = { id: "doc1", libraryId: "lib1", documentNumber: "P-2" } as unknown as DocumentRecord;
const actor = { orgId: "org1", actorUserId: "u1", actorRole: "Drafter" };

/** Every door with an owner rung, and the refusal it gave a non-owner on base. */
const DOORS: Array<{ name: string; run: () => Promise<unknown>; refusal: RegExp }> = [
  { name: "authorizePublish (lib/revisions.ts)", refusal: /authority to publish revisions in this library/,
    run: () => authorizePublish({ documentId: "doc1", libraryId: "lib1", ...actor }) },
  { name: "correctRevisionLabel (lib/revisions.ts)", refusal: /authority to correct revision labels/,
    run: () => correctRevisionLabel({ doc, versionId: "v1", newLabel: "B", libraryId: "lib1", actorEmail: "u1@x.io", ...actor } as unknown as Parameters<typeof correctRevisionLabel>[0]) },
  { name: "authorizeArchive (lib/revisions.ts)", refusal: /was NOT archived — archiving takes publish authority/,
    run: () => authorizeArchive({ documentId: "doc1", libraryId: "lib1", ...actor }) },
  { name: "backfillVersion (lib/revisions.ts)", refusal: /authority to backfill revisions/,
    run: () => backfillVersion({ doc, libraryId: "lib1", file: new File(["x"], "x.pdf", { type: "application/pdf" }), revisionLabel: "3", changeLog: "historic", actorEmail: "u1@x.io", ...actor } as unknown as Parameters<typeof backfillVersion>[0]) },
  { name: "setRetentionPolicy, document level (lib/retention.ts)", refusal: /Retention settings can only be changed by a controller, the document's owner/,
    run: () => setRetentionPolicy({ level: "document", id: "doc1", orgId: "org1", policy: null, actorId: "u1" }) },
  { name: "disposeDocument (lib/retention.ts)", refusal: /Retention settings can only be changed by a controller, the document's owner/,
    run: () => disposeDocument({ documentId: "doc1", orgId: "org1", actorId: "u1" }) },
  { name: "renumberDocument (lib/documentLifecycle/renumber.ts)", refusal: /authority to renumber this document\. Ask/,
    run: () => renumberDocument({ doc, newDocumentNumber: "P-3", reason: "typo", actorEmail: "u1@x.io", ...actor } as unknown as Parameters<typeof renumberDocument>[0]) },
  { name: "reverseRenumber (lib/documentLifecycle/reverse.ts)", refusal: /so you can't reverse its renumber either/,
    run: () => reverseRenumber({ renumberAuditEventId: "ev1", reason: "undo", ...actor }) },
];

const principal = (flag: { isActiveMember?: boolean }) => ({ uid: "u1", role: "Drafter", roles: ["Drafter"], orgId: "org1", teamIds: [], ...flag });
const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return "resolved"; } catch (e) { return (e as Error).message; }
};

beforeEach(() => { state.isOwner = true; state.ownerAsked = 0; });

describe("ORG-23 — the document-ownership rungs outside lib/permissions.ts are a member's", () => {
  it("knownInactive is the one rule: false only for isActiveMember === false", () => {
    expect(knownInactive({ isActiveMember: false })).toBe(true);
    expect(knownInactive({ isActiveMember: true })).toBe(false);
    expect(knownInactive({})).toBe(false);
  });

  for (const door of DOORS) {
    describe(door.name, () => {
      it("REGRESSION — an owner who is an active member, or whose status is unknown, passes the rung as before", async () => {
        for (const flag of [{ isActiveMember: true }, {}]) {
          state.principal = principal(flag); state.ownerAsked = 0;
          expect(await outcome(door.run), JSON.stringify(flag)).toBe("PAST_GATE");
          expect(state.ownerAsked).toBe(1);
        }
      });

      it("REGRESSION — a non-owner (active or unknown status) gets today's refusal", async () => {
        state.isOwner = false;
        for (const flag of [{ isActiveMember: true }, {}]) {
          state.principal = principal(flag);
          expect(await outcome(door.run)).toMatch(door.refusal);
        }
      });

      it("an owner known not to be an active member is not asked about ownership and is told why, before anything is written", async () => {
        state.principal = principal({ isActiveMember: false });
        expect(await outcome(door.run)).toBe(NOT_ACTIVE_MEMBER_MESSAGE);
        expect(state.ownerAsked).toBe(0);
        // a suspended controller too (its tier is gone — lib/permissions isControllerPrincipal)
        state.principal = { ...principal({ isActiveMember: false }), role: "DocCtrl", roles: ["DocCtrl"] };
        expect(await outcome(door.run)).toBe(NOT_ACTIVE_MEMBER_MESSAGE);
      });
    });
  }
});
