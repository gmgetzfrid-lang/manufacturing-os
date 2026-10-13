// @vitest-environment jsdom
//
// document-control Round F wave 3 — P23: projects-tab SAF-19. A contractor's
// submission approved from the document's review surface (ReviewGateSection's
// "Publish approved revision") tells the contractor, through the same notice
// route the project's Intake tab uses (/api/intake/outcome-notice via
// notifyIntakeOutcome — DEC-56: one notice per submission, the link's contact
// only), without holding up the decision; an ordinary revision asks nothing.
//
// Rendered (jsdom); finalizeReviewedRevision and notifyIntakeOutcome are
// mocked (the route's claim-once is projects-tab SAF-9's, J12 / J14).

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
const notice = () => host.querySelector('[data-testid="review-intake-notice"]');
const doc = { id: "d1", orgId: "o1", libraryId: "L1", collectionId: null, documentNumber: "P-101", title: "P-101", rev: "1" } as unknown as DocumentRecord;

async function approve() {
  await act(async () => { root.render(React.createElement(ReviewGateSection, { doc, orgId: "o1", canManage: true })); });
  await tick();
  await act(async () => { button("Publish approved revision").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await tick();
}

describe("projects-tab SAF-19 (P23) — the review surface's approval of a contractor's submission tells the contractor", () => {
  it("an intake-born version (its intake_link_id set) approved here: the notice route is asked once, for that version, and its answer is said", async () => {
    await approve();
    expect(s.finalize).toHaveBeenCalledTimes(1);
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify).toHaveBeenCalledWith("o1", "v2");
    expect(notice()?.getAttribute("role")).toBe("status");
    expect(notice()?.textContent).toBe("The contractor's submission was approved — it is now the current revision. The company's contact was emailed the outcome.");
    expect(s.appAlert).not.toHaveBeenCalled();
  });

  it("each answer of the route is worded as the Intake tab words it (already told: nothing more)", async () => {
    s.notify.mockResolvedValueOnce({ sent: false, reason: "no_contact" });
    await approve();
    expect(notice()?.textContent).toContain("Their link carries no contact email, so they see the outcome on their portal only.");
    act(() => root.unmount()); root = createRoot(host);
    s.rows.documents = { pending_version_id: "v2", current_version_id: "v1", review_control: null, collection_id: null };
    s.notify.mockResolvedValueOnce({ sent: false, reason: "already" });
    await approve();
    expect(notice()?.textContent).toBe("The contractor's submission was approved — it is now the current revision.");
  });

  it("the decision is not held up by the notice: the panel refreshes while the route has not answered", async () => {
    let answer: (v: unknown) => void = () => {};
    s.notify.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    await approve();
    // the publish finished and the panel reloaded (nothing in review now) while the notice is pending
    expect(host.textContent).not.toContain("Publish approved revision");
    expect(notice()?.textContent).toBe("The contractor's submission was approved — it is now the current revision.");
    await act(async () => { answer({ sent: true }); });
    await tick();
    expect(notice()?.textContent).toContain("The company's contact was emailed the outcome.");
  });

  it("an ordinary revision (no intake link) approved here asks nothing and says nothing", async () => {
    s.rows.document_versions = { file_url: null, intake_link_id: null };
    await approve();
    expect(s.finalize).toHaveBeenCalledTimes(1);
    expect(s.notify).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it("a promote that did not make the approved version current, or a refused publish, tells nobody", async () => {
    s.finalize.mockImplementationOnce(async () => {
      s.rows.documents = { pending_version_id: null, current_version_id: "v9", review_control: null, collection_id: null };
      return { published: true };
    });
    await approve();
    expect(s.notify).not.toHaveBeenCalled();
    act(() => root.unmount()); root = createRoot(host);
    s.rows.documents = { pending_version_id: "v2", current_version_id: "v1", review_control: null, collection_id: null };
    s.finalize.mockResolvedValueOnce({ published: false, reason: "incomplete" });
    await approve();
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("the intake link cannot be read: said (the contractor may not have been told), never a silent success", async () => {
    s.readErrors["document_versions:intake_link_id"] = { message: "connection reset" };
    await approve();
    expect(s.notify).not.toHaveBeenCalled();
    expect(notice()?.textContent).toMatch(/whether this revision came through a contractor's intake link could not be read/);
  });
});
