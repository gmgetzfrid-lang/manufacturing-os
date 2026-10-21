// @vitest-environment jsdom
//
// document-control Round G — P33: DCK-15 done-when 2. The Inspector's review
// panel says BEFORE the publish that someone else holds the document checked
// out — informational: a review stays finishable over a checkout (the publish
// guard's door (b), ratified under DEC-90); the button is not held back. The
// holder's own view, and an unlocked document, show nothing new.
//
// Rendered (jsdom); finalizeReviewedRevision is mocked (its notice to the
// holder is pinned in dcRoundGReviewPromoteOverCheckout.test.ts). The
// harness is dcRoundFReviewIntakeNotice.test.ts's.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  finalize: vi.fn(),
  notify: vi.fn(),
  appAlert: vi.fn(async (..._a: unknown[]) => undefined),
  rows: {} as Record<string, Record<string, unknown> | null>,
  readErrors: {} as Record<string, { message: string } | undefined>,
  reads: [] as Array<{ table: string; cols: string }>,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (t: string): unknown => {
    let cols = "";
    const h: ProxyHandler<object> = {
      get(_x, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        if (prop === "maybeSingle" || prop === "single") {
          return () => {
            s.reads.push({ table: t, cols });
            const err = s.readErrors[`${t}:${cols}`];
            return Promise.resolve(err ? { data: null, error: err } : { data: s.rows[t] ?? null, error: null });
          };
        }
        if (prop === "select") return (c: string) => { cols = c; return new Proxy({}, h); };
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
      status: "signed", signatureId: "sig1", signedAt: "2026-10-12T10:00:00Z", assignedAt: "2026-10-11T10:00:00Z",
    }]),
  };
});
vi.mock("@/lib/intakeOutcomeNotice", () => ({ notifyIntakeOutcome: (...a: unknown[]) => s.notify(...a) }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({
    uid: "u1", userEmail: "u1@example.com", activeRole: "DocCtrl", roles: ["DocCtrl"],
    hasAnyRole: (rs: string[]) => rs.includes("DocCtrl"), member: { displayName: "U One" },
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

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.finalize.mockReset().mockImplementation(async () => {
    // the promote landed: v2 is now current, nothing in review
    s.rows.documents = { pending_version_id: null, current_version_id: "v2", review_control: null, collection_id: null };
    return { published: true };
  });
  s.notify.mockReset().mockResolvedValue({ sent: true });
  s.appAlert.mockClear();
  s.readErrors = {};
  s.reads = [];
  s.rows = {
    documents: { pending_version_id: "v2", current_version_id: "v1", review_control: null, collection_id: null },
    document_versions: { file_url: null, intake_link_id: "link-7" },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tick = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
const doc = { id: "d1", orgId: "o1", libraryId: "L1", collectionId: null, documentNumber: "P-101", title: "P-101", rev: "1" } as unknown as DocumentRecord;


const note = () => host.querySelector('[data-testid="review-checkout-holder"]');
const render = async (d: DocumentRecord) => {
  await act(async () => { root.render(React.createElement(ReviewGateSection, { doc: d, orgId: "o1", canManage: true })); });
  await tick();
};

describe("DCK-15 (P33) — the Inspector says before the click that someone else holds the checkout", () => {
  it("held by someone else: a note names the holder, says their checkout stays open and that they are told and it is recorded — and the publish stays available and runs as before", async () => {
    await render({ ...doc, checkedOutBy: "drafter1", checkedOutByName: "Dana Drafter" } as DocumentRecord);
    expect(note()?.getAttribute("role")).toBe("note");
    expect(note()?.textContent).toBe("This document is checked out by Dana Drafter. Publishing the approved revision makes it current while their checkout stays open — they are told on their checkout thread and in-app, and the document's history records it.");
    const b = button("Publish approved revision");
    expect(b.disabled).toBe(false);
    await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick();
    expect(s.finalize).toHaveBeenCalledTimes(1);
  });

  it("a holder with no recorded name is 'another user'", async () => {
    await render({ ...doc, checkedOutBy: "drafter1", checkedOutByName: null } as DocumentRecord);
    expect(note()?.textContent).toContain("checked out by another user.");
  });

  it("REGRESSION: the holder's own view, and a document nobody holds, show no note", async () => {
    await render({ ...doc, checkedOutBy: "u1", checkedOutByName: "U One" } as DocumentRecord);
    expect(note()).toBeNull();
    act(() => root.unmount()); root = createRoot(host);
    await render(doc);
    expect(note()).toBeNull();
    expect(button("Publish approved revision").disabled).toBe(false);
  });
});
