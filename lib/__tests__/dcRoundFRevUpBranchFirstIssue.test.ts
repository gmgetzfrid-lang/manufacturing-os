// @vitest-environment jsdom
//
// document-control Round F wave 2 — P13 STATUS-TRANSITION, third review fix
// (REV-18): the first-issue rule routes a rev-up that ISSUES the document to
// review (a Minor / Correction change does not exempt it). A BRANCH publish
// moves neither the pointer nor the status — revUpDocument does not ask the
// first-issue gate for it — so the rule must not route a branch either: its
// mode is the policy's after the hatch, as before P13. REV-7 still binds it
// (a branch can't skip a review the CHANGE needs).
//
// effectiveModeForRevUp is the real one (lib/reviewControl.ts); RevUpModal is
// driven as rendered (jsdom) with the data layer mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  gate: { firstIssue: false, retired: false, hasCurrentRevision: true, status: "Issued" as string | null, requiresSignOff: false, mustReview: false },
  revUpDocument: vi.fn(),
  submitForReview: vi.fn(),
  logAuditAction: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/revisions", () => {
  class StaleBaseError extends Error {
    info: unknown;
    constructor(info: unknown) { super("stale"); this.info = info; }
  }
  class DuplicateLabelError extends Error {}
  return {
    StaleBaseError, DuplicateLabelError,
    revUpDocument: (...a: unknown[]) => s.revUpDocument(...a),
    submitForReview: (...a: unknown[]) => s.submitForReview(...a),
    suggestNextRevisionLabel: () => "2",
    listVersions: vi.fn(async () => []),
    firstIssueGateForRevUp: vi.fn(async () => s.gate),
    describeRetiredRevUp: () => "retired",
  };
});
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "require" })) };
});
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: (...a: unknown[]) => s.logAuditAction(...a) }));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined) }));
vi.mock("@/lib/activityThread", () => ({ postActivity: vi.fn(async () => {}) }));
vi.mock("@/components/documents/CompareRevisionsModal", () => ({ default: () => null }));
vi.mock("@/components/ui/IsoGuidance", () => ({ default: () => null }));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn(async () => {}) }));

import RevUpModal from "@/components/documents/RevUpModal";
import { effectiveModeForRevUp } from "@/lib/reviewControl";
import { StaleBaseError } from "@/lib/revisions";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("effectiveModeForRevUp — the first-issue rule does not route a branch (P13 third review fix)", () => {
  const require = { mode: "require" } as never;
  it("a first issue the actor may not publish unreviewed is 'require' whatever the change type — but not for a branch", () => {
    expect(effectiveModeForRevUp({ control: require, changeType: "Minor", firstIssueMustReview: true })).toBe("require");
    expect(effectiveModeForRevUp({ control: require, changeType: "Minor", firstIssueMustReview: true, asBranch: true })).toBe("none");
    expect(effectiveModeForRevUp({ control: require, changeType: "Correction", firstIssueMustReview: true, asBranch: true })).toBe("none");
  });
  it("REV-7 still binds a branch: a change that needs review (Major) under require / publisher_choice keeps its mode", () => {
    expect(effectiveModeForRevUp({ control: require, changeType: "Major", firstIssueMustReview: true, asBranch: true })).toBe("require");
    expect(effectiveModeForRevUp({ control: { mode: "publisher_choice" } as never, changeType: "Major", asBranch: true })).toBe("publisher_choice");
    expect(effectiveModeForRevUp({ control: { mode: "none" } as never, changeType: "Major", firstIssueMustReview: false, asBranch: true })).toBe("none");
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.gate = { firstIssue: false, retired: false, hasCurrentRevision: true, status: "Issued", requiresSignOff: false, mustReview: false };
  s.revUpDocument.mockReset();
  s.submitForReview.mockReset();
  s.logAuditAction.mockReset();
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
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
async function typeInto(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  await act(async () => { el.dispatchEvent(new Event("input", { bubbles: true })); });
}

const PDF = new File([new Uint8Array([1])], "p101.pdf", { type: "application/pdf" }); // one object: a new preset re-opens the form
const baseDoc = { id: "d1", orgId: "o1", documentNumber: "P-101", title: "P-101", rev: "1", status: "Issued", currentVersionId: "v1" } as unknown as DocumentRecord;
function render(doc: DocumentRecord) {
  return act(async () => {
    root.render(React.createElement(RevUpModal, {
      isOpen: true, onClose: () => {}, doc, libraryId: "lib1", orgId: "o1", actorUserId: "u1", actorRole: "Engineer",
      onSuccess: () => {}, presetChangeType: "Minor", presetChangeLog: "replacement in kind",
      presetFile: PDF,
    }));
  });
}

describe("RevUpModal — a Minor branch after a stale base is not refused by the first-issue rule (P13 third review fix)", () => {
  it("the document turns out to be a first issue the engineer may not publish unreviewed: the branch still publishes (as before P13), and the hatch is recorded", async () => {
    await render(baseDoc);
    await tick();
    // the direct Minor publish meets a stale base (someone published meanwhile)
    s.revUpDocument.mockRejectedValueOnce(new StaleBaseError({ currentVersionId: "v2", currentRev: "2", currentBy: "u2", currentByName: "Ana", currentAt: null, currentChangeLog: null }));
    await click(button("Publish Revision"));
    expect(s.revUpDocument).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("This document changed while you were working");

    // meanwhile the row the page holds says it is a Draft: the gate now answers a first issue the engineer may not publish unreviewed
    s.gate = { firstIssue: true, retired: false, hasCurrentRevision: true, status: "Draft", requiresSignOff: true, mustReview: true };
    await render({ ...baseDoc, status: "Draft" } as DocumentRecord);
    await tick();
    expect(host.textContent).toContain("This document changed while you were working");

    await click(button("publish as an unreconciled branch"));
    await typeInto(host.querySelector("textarea[placeholder^=\"Why are you branching\"]") as HTMLTextAreaElement, "parallel field change");
    const publishBranch = button("Publish branch");
    expect(publishBranch.disabled).toBe(false); // before the fix: disabled ("a branch can't skip it")
    s.revUpDocument.mockResolvedValueOnce({ newVersion: { id: "b1", revisionLabel: "2" }, branched: true });
    await click(publishBranch);
    expect(s.revUpDocument).toHaveBeenCalledTimes(2);
    expect(s.revUpDocument.mock.calls[1][0]).toMatchObject({ asBranch: true, branchReason: "parallel field change", changeType: "Minor" });
    expect(s.submitForReview).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("a branch can't skip it");
    // RG-11: the branch took the Minor hatch in a gated library — recorded, judged by the branch's own mode
    expect(s.logAuditAction).toHaveBeenCalledWith(expect.objectContaining({ action: "REVIEW_GATE_SKIPPED", details: expect.objectContaining({ branched: true }) }));
  });
});
