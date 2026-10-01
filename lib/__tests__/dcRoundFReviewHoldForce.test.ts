// @vitest-environment jsdom
//
// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS, final
// review (REV-20): 20261151's limb (b) refuses a controller's review promote
// of a held Draft / In Review document unless it carries a recorded override
// — a controller flow that worked before the paste would have had no way
// through but releasing the hold. finalize_reviewed_promote now carries its
// own recorded force, and the inspector offers it to a controller — only a
// controller, only when the refusal is the hold's — with the HLD-2
// "Proceed over the active hold" acknowledgement (HeldSourceNotice). Anyone
// else, and any other refusal, is told as before (finalizeReasonMessage).
//
// Driven as rendered (jsdom); finalizeReviewedRevision is mocked (its force
// is driven in dcRoundFPromoteTransaction.test.ts, the SQL on PostgreSQL 16 —
// REV-20's record).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  roles: ["DocCtrl"] as string[],
  finalize: vi.fn(),
  appAlert: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@/lib/supabase", () => {
  const rows: Record<string, Record<string, unknown>> = {
    documents: { pending_version_id: "v2", review_control: null, collection_id: null },
    document_versions: { file_url: null },
  };
  const chain = (t: string): unknown => {
    const h: ProxyHandler<object> = {
      get(_x, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: rows[t] ?? null, error: null });
        return () => new Proxy({}, h);
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return {
    ...real,
    finalizeReviewedRevision: (...a: unknown[]) => s.finalize(...a),
    effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "require" })),
    listDraftRoster: vi.fn(async () => [{
      id: "so1", documentVersionId: "v2", revisionLabel: "2A", contentHash: null, reviewerUserId: "rev1", reviewerName: "Rae Viewer",
      reviewerRole: "Engineer", slot: "primary", source: "person", activated: true, slotGroup: "person:rev1",
      status: "signed", signatureId: "sig1", signedAt: "2026-09-30T10:00:00Z", assignedAt: "2026-09-29T10:00:00Z",
    }]),
  };
});
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({
    uid: "u1", userEmail: "u1@example.com", activeRole: s.roles[0], roles: s.roles,
    hasAnyRole: (rs: string[]) => rs.some((r) => s.roles.includes(r)), member: { displayName: "U One" },
  }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: (...a: unknown[]) => s.appAlert(...a) }));
vi.mock("@/lib/storage", () => ({ resolveFileUrl: vi.fn(async () => null) }));
vi.mock("@/lib/teams", () => ({ getMyTeamIds: vi.fn(async () => []) }));
vi.mock("@/components/signatures/SignatureCeremony", () => ({ default: () => null }));
vi.mock("@/lib/checklists", () => ({ describeProjectSweep: vi.fn(() => null) }));

import ReviewGateSection from "@/components/documents/ReviewGateSection";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The guard's sentences (20261151): a controller's pointer-and-issue over a hold; the publisher tier's. */
const CONTROLLER_HOLD = "Document has an active hold; release the hold before issuing it, or publish over it with Document Control's recorded override.";
const PUBLISHER_HOLD = "Document has an active hold; release the hold before publishing a new revision.";
const RELEASE_FIRST = "This document has an active hold, so the reviewed revision was not published and nothing was changed. Release the hold, then publish the reviewed revision — its sign-offs stand.";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.roles = ["DocCtrl"];
  s.finalize.mockReset().mockResolvedValue({ published: true });
  s.appAlert.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await tick(); };
const panel = () => host.querySelector('[data-testid="review-hold-force"]');
const doc = { id: "d1", orgId: "o1", libraryId: "L1", collectionId: null, documentNumber: "P-101", title: "P-101", rev: "1" } as unknown as DocumentRecord;

async function render() {
  await act(async () => { root.render(React.createElement(ReviewGateSection, { doc, orgId: "o1", canManage: true })); });
  await tick();
  expect(button("Publish approved revision").disabled).toBe(false);
}

describe("REV-20 (P14 final review) — the inspector offers a controller the review promote's recorded force over a hold", () => {
  it("a controller refused by the hold: no dead end — 'Proceed over the active hold' is required, then the publish carries the force and its reason", async () => {
    s.finalize.mockResolvedValueOnce({ published: false, reason: CONTROLLER_HOLD });
    await render();
    await click(button("Publish approved revision"));
    expect(s.appAlert).not.toHaveBeenCalled();
    expect(panel()?.textContent).toContain("This document has an active hold, so the reviewed revision was not published and nothing was changed. Release the hold, or proceed over it as Document Control — the override is recorded on the document's history.");
    expect(panel()?.textContent).toContain("Required. Proceed over the active hold: publish the reviewed revision while the hold stays open. The holds you proceed over are named on the audit record.");
    // the force waits for the acknowledgement
    expect(button("Publish over the hold").disabled).toBe(true);
    const box = panel()!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await click(box);
    expect(button("Publish over the hold").disabled).toBe(false);
    const reason = panel()!.querySelector('input[aria-label="Reason for proceeding over the hold"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reason, "  shutdown pack under MOC-77 ");
    await act(async () => { reason.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(button("Publish over the hold"));
    expect(s.finalize).toHaveBeenCalledTimes(2);
    expect(s.finalize.mock.calls[0][0]).not.toHaveProperty("forceHold");
    expect(s.finalize.mock.calls[1][0]).toEqual({
      orgId: "o1", documentId: "d1", actorId: "u1", actorName: "u1@example.com", actorEmail: "u1@example.com",
      forceHold: true, overrideReason: "shutdown pack under MOC-77",
    });
    expect(panel()).toBeNull(); // published: the offer is gone
    expect(s.appAlert).not.toHaveBeenCalled();
  });

  it("anyone below a controller (an owner who may publish) is told to release the hold — no force is offered", async () => {
    s.roles = ["Engineer"];
    s.finalize.mockResolvedValueOnce({ published: false, reason: PUBLISHER_HOLD });
    await render();
    await click(button("Publish approved revision"));
    expect(s.appAlert).toHaveBeenCalledWith({ tone: "danger", message: RELEASE_FIRST });
    expect(panel()).toBeNull();
  });

  it("a controller's refusal that is NOT the hold's is said as before — no force is offered", async () => {
    s.finalize.mockResolvedValueOnce({ published: false, reason: "incomplete" });
    await render();
    await click(button("Publish approved revision"));
    expect(s.appAlert).toHaveBeenCalledWith({ tone: "danger", message: "Not all required reviewers have signed off yet." });
    expect(panel()).toBeNull();
  });

  it("regression — a publish that lands is called exactly as before (no force), says nothing, offers nothing", async () => {
    await render();
    await click(button("Publish approved revision"));
    expect(s.finalize).toHaveBeenCalledTimes(1);
    expect(s.finalize.mock.calls[0][0]).toEqual({ orgId: "o1", documentId: "d1", actorId: "u1", actorName: "u1@example.com", actorEmail: "u1@example.com" });
    expect(s.appAlert).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });
});
