// @vitest-environment jsdom
//
// projects-joint Round G — J21 merge-time fix (DEC-90 ruling 5; drafting-flow
// PROJ-1 / PROJ-14): a drafting request's deliverable this review publish made
// current that could NOT be put on the request's project register is SAID ON
// SCREEN to the finalizer — ReviewGateSection passes onProjectReferenceNote to
// finalizeReviewedRevision, and the note (the route's warning, or the page's
// own "could not be reached" sentence) shows as a status line when it
// settles. The publish is never held up by it; a note for a document the
// panel no longer shows is not shown; nothing is said when nothing missed.
//
// Rendered (jsdom); finalizeReviewedRevision is mocked (the route and the
// note's wording are pinned in prjRoundGJ21DeliverableReferenceRoute.test.ts
// and prjRoundGJ21ReviewControl.test.ts).

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
import { PROJECT_REGISTER_MANAGERS_ONLY } from "@/lib/ticketProject";

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

let lastNote: ((note: string) => void) | undefined;
async function render(d: DocumentRecord = doc) {
  await act(async () => { root.render(React.createElement(ReviewGateSection, { doc: d, orgId: "o1", canManage: true })); });
  await tick();
}
async function approve() {
  await render();
  await act(async () => { button("Publish approved revision").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await tick();
  lastNote = (s.finalize.mock.calls.at(-1)?.[0] as { onProjectReferenceNote?: (n: string) => void } | undefined)?.onProjectReferenceNote;
}
const note = () => host.querySelector('[data-testid="review-project-reference-note"]');
/** The route's own warning for a finalizer without register authority. */
const MISS = PROJECT_REGISTER_MANAGERS_ONLY;

describe("J21 merge-time fix (ruling 5) — a project-reference miss is said on screen to the finalizer", () => {
  beforeEach(() => { s.rows.document_versions = { file_url: null, intake_link_id: null }; });

  it("the publish passes a note handler (and is otherwise the call it always was)", async () => {
    await approve();
    expect(s.finalize).toHaveBeenCalledTimes(1);
    const arg = s.finalize.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof arg.onProjectReferenceNote).toBe("function");
    const { onProjectReferenceNote: _h, ...rest } = arg;
    expect(rest).toEqual({ orgId: "o1", documentId: "d1", actorId: "u1", actorName: "u1@example.com", actorEmail: "u1@example.com" });
  });

  it("a miss that settles AFTER the publish shows as a status line; the publish was not held up", async () => {
    await approve();
    expect(host.textContent).not.toContain("Publish approved revision"); // published and reloaded
    expect(note()).toBeNull();
    await act(async () => { lastNote!(MISS); });
    expect(note()?.getAttribute("role")).toBe("status");
    expect(note()?.textContent).toBe(MISS);
    expect(s.appAlert).not.toHaveBeenCalled();
  });

  it("nothing missed: nothing is said", async () => {
    await approve();
    expect(note()).toBeNull();
  });

  it("shown with the contractor notice when both apply", async () => {
    s.rows.document_versions = { file_url: null, intake_link_id: "link-7" };
    await approve();
    await act(async () => { lastNote!(MISS); });
    expect(host.querySelector('[data-testid="review-intake-notice"]')).not.toBeNull();
    expect(note()?.textContent).toBe(MISS);
  });

  it("a note for a document the panel no longer shows is not shown on the next one", async () => {
    await approve();
    const handler = lastNote!;
    await render({ ...doc, id: "d2" } as unknown as DocumentRecord);
    await act(async () => { handler(MISS); });
    expect(note()).toBeNull();
  });
});
