// @vitest-environment jsdom
//
// projects Round G — J14 PROJECTS FOLLOW-UPS, driven through the rendered
// Intake tab (components/projects/IntakePanel.tsx):
//
//   * projects-and-cost INTK-18 — after document-control P14's 20261151 an
//     active hold refuses a controller's review promote unless it carries the
//     recorded force. The Intake tab's approve now offers a controller (Admin
//     / DocCtrl held in the role COLLECTION) that force after — and only
//     after — a hold refusal, with the HLD-2 "Proceed over the active hold"
//     acknowledgement, as the document's review panel does
//     (dcRoundFReviewHoldForce.test.ts). Anyone else, and any other refusal,
//     is told as before, and the call without a force is unchanged.
//   * projects-tab SAF-9 — a decision that lands (an approval that made the
//     submission current, a rejection) asks J12's notice route to email the
//     link's contact (notifyIntakeOutcome), and the notice says what became
//     of it.
//
// finalizeReviewedRevision and notifyIntakeOutcome are mocked (the force is
// driven in dcRoundFPromoteTransaction.test.ts, the route in
// intakeOutcomeNoticeRoute.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Res = { data: unknown; error: null | { code?: string; message: string } };
const s = vi.hoisted(() => ({
  roles: ["Engineer", "DocCtrl"] as string[],
  finalize: vi.fn(),
  notify: vi.fn(),
  appPrompt: vi.fn(),
  appConfirm: vi.fn(),
  /** documents.pending_version_id as the approve's re-read sees it. */
  pending: "v2" as string | null,
  current: "v1",
  writes: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

vi.mock("@/lib/supabase", () => {
  const answer = (table: string, methods: string[], args: unknown[][]): Res => {
    const sel = String(args[methods.indexOf("select")]?.[0] ?? "");
    const single = methods.includes("maybeSingle") || methods.includes("single");
    if (methods[0] === "update" || methods[0] === "insert") {
      s.writes.push({ table, method: methods[0], args: args[0] });
      return { data: table === "document_versions" ? [{ id: "v2" }] : null, error: null };
    }
    if (table === "project_intake_links") return { data: [{ id: "l1", company_name: "Gulf Mechanical", contact_email: "pm@gulf.example", token_prefix: "abc123", allow_auto_supersede: false, expires_at: null, revoked_at: null, submission_count: 1, last_used_at: null, assigned_doc_ids: [] }], error: null };
    if (table === "projects") return { data: { intake_library_id: "lib1", intake_collection_id: null }, error: null };
    if (table === "libraries") return { data: [{ id: "lib1", name: "Intake" }], error: null };
    if (table === "document_versions" && single) return { data: { moc_reference: null, file_hash: "h1" }, error: null };
    if (table === "document_versions") return { data: [{ id: "v2", record_id: "d1", revision_label: "B", created_by_name: "Gulf Mechanical", created_at: "2026-10-01T00:00:00Z", change_log: null }], error: null };
    if (table === "documents" && sel.startsWith("rev")) return { data: { rev: "B", current_version_id: s.current }, error: null };
    if (table === "documents" && single) return { data: { id: "d1", library_id: "lib1", collection_id: null, review_control: null, pending_version_id: s.pending }, error: null };
    if (table === "documents") return { data: [{ id: "d1", document_number: "P-101", pending_version_id: "v2" }], error: null };
    return { data: [], error: null };
  };
  const chain = (table: string): unknown => {
    const methods: string[] = []; const args: unknown[][] = [];
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(answer(table, methods, args));
        return (...a: unknown[]) => { methods.push(prop); args.push(a); return new Proxy({}, h); };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/components/providers/DialogProvider", () => ({ appPrompt: (...a: unknown[]) => s.appPrompt(...a), appConfirm: (...a: unknown[]) => s.appConfirm(...a), appAlert: vi.fn() }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return {
    ...real,
    finalizeReviewedRevision: (...a: unknown[]) => s.finalize(...a),
    effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })),
    listDraftRoster: vi.fn(async () => []),
    openReviewRoster: vi.fn(),
  };
});
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => "document") }));
vi.mock("@/lib/checklists", () => ({ describeProjectSweep: vi.fn(() => null) }));
vi.mock("@/lib/transitionIn", () => ({ flagCollisionToDrafting: vi.fn() }));
vi.mock("@/components/projects/TransitionInPanel", () => ({ default: () => null }));
vi.mock("@/lib/intakeOutcomeNotice", () => ({ notifyIntakeOutcome: (...a: unknown[]) => s.notify(...a) }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ hasAnyRole: (rs: string[]) => rs.some((r) => s.roles.includes(r)), roles: s.roles, activeRole: s.roles[0] }),
}));

import IntakePanel, { outcomeNoticeSentence } from "@/components/projects/IntakePanel";
import { finalizeReasonMessage } from "@/lib/reviewControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The guard's sentences (20261151): a controller's pointer-and-issue over a hold; the publisher tier's. */
const CONTROLLER_HOLD = "Document has an active hold; release the hold before issuing it, or publish over it with Document Control's recorded override.";
const PUBLISHER_HOLD = "Document has an active hold; release the hold before publishing a new revision.";
const ARGS = { orgId: "o1", documentId: "d1", actorId: "u1", actorName: "u1@example.com", actorEmail: "u1@example.com", requireRosterComplete: false };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.roles = ["Engineer", "DocCtrl"];
  s.pending = "v2"; s.current = "v1"; s.writes = [];
  s.finalize.mockReset().mockImplementation(async () => { s.current = "v2"; return { published: true }; });
  s.notify.mockReset().mockResolvedValue({ sent: true });
  s.appPrompt.mockReset(); s.appConfirm.mockReset();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async () => {
  await act(async () => {
    root.render(React.createElement(IntakePanel, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1", userEmail: "u1@example.com" }));
  });
  await settle();
};
const button = (label: string) => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent?.trim().endsWith(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await settle(); };
const notice = () => host.querySelector("[data-tone]")?.textContent ?? "";
const panel = () => host.querySelector('[data-testid="intake-hold-force"]');

describe("INTK-18 (J14) — the Intake tab offers a controller the review promote's recorded force over a hold", () => {
  it("a controller (DocCtrl in the role collection) refused by the hold: the acknowledgement is required, then the approve carries the force and the trimmed reason", async () => {
    s.finalize.mockReset()
      .mockResolvedValueOnce({ published: false, reason: CONTROLLER_HOLD })
      .mockImplementationOnce(async () => { s.current = "v2"; return { published: true }; });
    await render();
    await click(button("Approve"));
    expect(panel()).not.toBeNull();
    expect(notice()).toContain("was not approved: the document has an active hold, and nothing was changed");
    expect(panel()!.textContent).toContain("Required. Proceed over the active hold: approve this submission while the hold stays open. The holds you proceed over are named on the audit record.");
    expect(s.notify).not.toHaveBeenCalled();
    // the force waits for the acknowledgement
    expect(button("Approve over the hold").disabled).toBe(true);
    await click(panel()!.querySelector('input[type="checkbox"]')!);
    expect(button("Approve over the hold").disabled).toBe(false);
    const reason = panel()!.querySelector('input[aria-label="Reason for proceeding over the hold"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reason, "  quality hold answered by this revision ");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Approve over the hold"));
    expect(s.finalize).toHaveBeenCalledTimes(2);
    expect(s.finalize.mock.calls[0][0]).toEqual(ARGS);
    expect(s.finalize.mock.calls[0][0]).not.toHaveProperty("forceHold");
    expect(s.finalize.mock.calls[1][0]).toEqual({ ...ARGS, forceHold: true, overrideReason: "quality hold answered by this revision" });
    expect(panel()).toBeNull();
    expect(notice()).toContain("P-101 Rev B approved — it is now the current revision.");
    // SAF-9: the forced approval landed — the contractor is told
    expect(s.notify).toHaveBeenCalledWith("o1", "v2");
  });

  it("the forced approve re-checks that the submission on screen is still the pending one (SAF-15) — a moved pointer forces nothing", async () => {
    s.finalize.mockReset().mockResolvedValueOnce({ published: false, reason: CONTROLLER_HOLD });
    await render();
    await click(button("Approve"));
    await click(panel()!.querySelector('input[type="checkbox"]')!);
    s.pending = "v9";
    await click(button("Approve over the hold"));
    expect(s.finalize).toHaveBeenCalledTimes(1);
    expect(notice()).toContain("changed since this list loaded");
  });

  it("anyone below a controller is told to release the hold, as before — no force is offered", async () => {
    s.roles = ["Engineer"];
    s.finalize.mockReset().mockResolvedValueOnce({ published: false, reason: PUBLISHER_HOLD });
    await render();
    await click(button("Approve"));
    expect(panel()).toBeNull();
    expect(notice()).toBe(finalizeReasonMessage(PUBLISHER_HOLD));
    expect(s.finalize).toHaveBeenCalledTimes(1);
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("a controller's refusal that is NOT the hold's is said as before — no force is offered", async () => {
    s.finalize.mockReset().mockResolvedValueOnce({ published: false, reason: "incomplete" });
    await render();
    await click(button("Approve"));
    expect(panel()).toBeNull();
    expect(notice()).toBe("Not all required reviewers have signed off yet.");
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("regression — an approve that lands is called exactly as before (no force) and offers nothing; the contractor is told", async () => {
    await render();
    await click(button("Approve"));
    expect(s.finalize).toHaveBeenCalledTimes(1);
    expect(s.finalize.mock.calls[0][0]).toEqual(ARGS);
    expect(panel()).toBeNull();
    expect(s.notify).toHaveBeenCalledWith("o1", "v2");
    expect(notice()).toBe("P-101 Rev B approved — it is now the current revision. The company's contact was emailed the outcome.");
    expect(host.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("success");
  });
});

describe("SAF-9 (J14) — the Intake tab tells the contractor how their submission was decided", () => {
  it("a rejection that landed asks the notice route for that submission, and the notice says it was emailed", async () => {
    s.appPrompt.mockResolvedValue("The weld map is missing from sheet 2");
    await render();
    await click(button("Reject"));
    const versionWrite = s.writes.find((w) => w.table === "document_versions");
    expect(versionWrite?.args[0]).toEqual({ review_state: "rejected", review_note: "The weld map is missing from sheet 2" });
    expect(s.notify).toHaveBeenCalledWith("o1", "v2");
    // the notice comes after the rejection and its audit row are written
    expect(s.writes.map((w) => w.table)).toContain("audit_logs");
    expect(notice()).toBe("P-101 Rev B rejected — the company sees it as not accepted, with your reason, on their portal. The company's contact was emailed the outcome.");
  });

  it("a send that failed, or a link with no contact, is said — the portal still shows the outcome", async () => {
    s.appPrompt.mockResolvedValue("The weld map is missing from sheet 2");
    s.notify.mockResolvedValueOnce({ sent: false, reason: "send_failed" });
    await render();
    await click(button("Reject"));
    expect(notice()).toContain("The email to the company's contact could not be sent (send_failed) — they still see the outcome on their portal.");
    s.notify.mockResolvedValueOnce({ sent: false, reason: "no_contact" });
    await click(button("Approve"));
    expect(notice()).toContain("Their link carries no contact email, so they see the outcome on their portal only.");
  });

  it("a cancelled rejection, and an approval that did not make the submission current, tell nobody", async () => {
    s.appPrompt.mockResolvedValue(null);
    await render();
    await click(button("Reject"));
    expect(s.notify).not.toHaveBeenCalled();
    s.finalize.mockReset().mockResolvedValue({ published: true });   // current stays v1
    await click(button("Approve"));
    expect(notice()).toContain("the approval went through, but the current revision is not the submission you approved");
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("outcomeNoticeSentence words every answer the route gives", () => {
    expect(outcomeNoticeSentence({ sent: true })).toBe(" The company's contact was emailed the outcome.");
    expect(outcomeNoticeSentence({ sent: false, reason: "already" })).toBe("");
    expect(outcomeNoticeSentence({ sent: false, reason: "not_configured" })).toContain("Email is not configured here");
    expect(outcomeNoticeSentence({ sent: false, reason: "in_progress" })).toContain("already being sent");
    expect(outcomeNoticeSentence({ sent: false, reason: "HTTP 403" })).toContain("could not be sent (HTTP 403)");
  });
});
