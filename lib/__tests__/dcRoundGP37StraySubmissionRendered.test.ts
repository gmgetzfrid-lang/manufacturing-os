// @vitest-environment jsdom
//
// document-control Round G — P37 DOOR B GUARD: DCK-18 (c), rendered. The
// Inspector's review panel (components/documents/ReviewGateSection.tsx) —
// where the document's pending draft is shown — offers Document Control, and
// nobody else, a recorded retire of a pending submission no Intake tab lists,
// with a required reason and a confirmation, through
// lib/strayPendingSubmission.ts retireStrayPendingSubmission (voidPendingDraft).
// A submission an Intake tab lists, and an ordinary draft, show nothing new.
//
// The read is the real module over a mocked client; the retire is mocked (its
// path is pinned in dcRoundGP37StraySubmission.test.ts). The harness is
// dcRoundGReviewGateCheckoutNote.test.ts's.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  retire: vi.fn(),
  prompt: vi.fn(),
  appAlert: vi.fn(async (..._a: unknown[]) => undefined),
  rows: {} as Record<string, Record<string, unknown> | null>,
  reads: [] as string[],
  roles: ["DocCtrl"] as string[],
}));

vi.mock("@/lib/supabase", () => {
  const chain = (t: string): unknown => {
    const h: ProxyHandler<object> = {
      get(_x, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        if (prop === "maybeSingle" || prop === "single") {
          return () => { s.reads.push(t); return Promise.resolve({ data: s.rows[t] ?? null, error: null }); };
        }
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
    finalizeReviewedRevision: vi.fn(async () => ({ published: false, reason: "not used" })),
    effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "publisher_choice" })),
    listDraftRoster: vi.fn(async () => []),
  };
});
vi.mock("@/lib/strayPendingSubmission", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/strayPendingSubmission")>();
  return { ...real, retireStrayPendingSubmission: (...a: unknown[]) => s.retire(...a) };
});
vi.mock("@/lib/intakeOutcomeNotice", () => ({ notifyIntakeOutcome: vi.fn() }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({
    uid: "u1", userEmail: "u1@example.com", activeRole: s.roles[0], roles: s.roles,
    hasAnyRole: (rs: string[]) => rs.some((r) => s.roles.includes(r)), member: { displayName: "U One" },
  }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: (...a: unknown[]) => s.appAlert(...a),
  appPrompt: (...a: unknown[]) => s.prompt(...a),
}));
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
  s.retire.mockReset().mockResolvedValue({ ok: true, voidedVersionId: "v2", recordError: null });
  s.prompt.mockReset().mockResolvedValue("quote link submission, not ours");
  s.appAlert.mockClear();
  s.reads = [];
  s.roles = ["DocCtrl"];
  s.rows = {
    documents: { pending_version_id: "v2", current_version_id: "v1", review_control: null, collection_id: null },
    document_versions: { id: "v2", file_url: null, review_state: "in_review", provenance: "external", intake_link_id: "L9", created_by: "L9", revision_label: "2A", superseded_at: null },
    project_intake_links: { id: "L9", purpose: "quote" },
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
const block = () => host.querySelector('[data-testid="review-stray-submission"]');
const button = (label: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
const doc = { id: "d1", orgId: "o1", libraryId: "L1", collectionId: null, documentNumber: "P-101", title: "P-101", rev: "1" } as unknown as DocumentRecord;
const render = async (canManage = true) => {
  await act(async () => { root.render(React.createElement(ReviewGateSection, { doc, orgId: "o1", canManage })); });
  await tick();
};

describe("DCK-18 (c) (P37) — Document Control's retire of a pending submission no Intake tab lists, where the pending draft is shown", () => {
  it("Document Control sees why no Intake tab can decide it, and the retire: a required reason with a confirmation, then the retire of exactly the submission shown — said on success", async () => {
    await render();
    expect(block()?.getAttribute("role")).toBe("note");
    expect(block()?.textContent).toContain("The pending submission 2A came through a quote link, so no project's Intake tab lists it — it can't be approved or rejected there.");
    await act(async () => { button("Retire this submission").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick();
    expect(s.prompt).toHaveBeenCalledTimes(1);
    expect(s.prompt.mock.calls[0][0]).toMatchObject({ title: "Retire this pending submission?", required: true, tone: "danger", confirmLabel: "Retire submission" });
    expect(s.prompt.mock.calls[0][0].message).toContain("cannot be undone");
    expect(s.retire).toHaveBeenCalledWith({
      orgId: "o1", documentId: "d1", expectedVersionId: "v2", reason: "quote link submission, not ours",
      actorIsController: true, actorUserId: "u1", actorEmail: "u1@example.com", actorRole: "DocCtrl",
    });
    expect(s.appAlert).toHaveBeenCalledWith({ message: "The submission was retired and recorded on the document's history." });
  });

  it("cancelling the reason retires nothing; a refused retire is said in its own words; a record that could not be written is said", async () => {
    s.prompt.mockResolvedValueOnce(null);
    await render();
    await act(async () => { button("Retire this submission").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick();
    expect(s.retire).not.toHaveBeenCalled();
    s.retire.mockResolvedValueOnce({ ok: false, reason: "The document's pending draft changed since it was shown — nothing was changed. Reload the document." });
    await act(async () => { button("Retire this submission").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick();
    expect(s.appAlert).toHaveBeenLastCalledWith({ tone: "danger", message: "The document's pending draft changed since it was shown — nothing was changed. Reload the document." });
  });

  it("REGRESSION: nobody but Document Control sees it — and their view reads no link", async () => {
    s.roles = ["Drafter"];
    await render();
    expect(block()).toBeNull();
    expect(s.reads).not.toContain("project_intake_links");
  });

  it("REGRESSION: a submission an Intake tab lists (a DOCUMENT link) is never offered here — the Intake tab's Reject decides it; nor an ordinary draft", async () => {
    s.rows.project_intake_links = { id: "L9", purpose: "documents" };
    await render();
    expect(block()).toBeNull();
    act(() => root.unmount()); root = createRoot(host);
    s.rows.document_versions = { id: "v2", file_url: null, review_state: "in_review", provenance: null, intake_link_id: null, created_by: "member-1", revision_label: "2A", superseded_at: null };
    await render();
    expect(block()).toBeNull();
  });

  it("a submission whose link no longer exists is offered, and says so", async () => {
    s.rows.project_intake_links = null;
    await render();
    expect(block()?.textContent).toContain("came through an intake link that no longer exists");
  });
});
