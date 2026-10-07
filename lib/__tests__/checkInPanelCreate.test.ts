// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P2 — CheckInPanel, AS RENDERED: the check-in's
// drafting request goes through /api/tickets/create, and LEAK-6.
//
// REGRESSION first: a field engineer who reports a discrepancy on an as-built
// walkdown still gets their ticket, their uploads, their PSM escalation, the
// register entry and the redirect — the panel now describes the request in the
// create contract instead of inserting it, staging the redline under their
// pending prefix (EDGE-13).
//
// LEAK-6: the mount-time read of "the ticket this episode already filed" is
// AWAITED by the commit and its error READ: a pending read is waited for (a
// found ticket is reused, nothing is filed); a failed read is made once more,
// and if it still fails the route is asked — which resumes by the episode
// server-side (lib/__tests__/ticketCreateRoute.test.ts, "LEAK-6"), so a failed
// or slow read never files a second ticket.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Lookup = { data: unknown; error: { message: string } | null };
const s = vi.hoisted(() => ({
  push: vi.fn(),
  showToast: vi.fn(),
  submit: vi.fn(),
  discard: vi.fn(),
  upload: vi.fn(),
  finish: vi.fn(),
  emit: vi.fn(),
  lookups: [] as Array<() => Promise<Lookup>>,
  lookupCalls: 0,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: s.push }) }));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: s.showToast }) }));
vi.mock("@/components/documents/RevUpModal", () => ({ default: () => null }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: async () => "drawing" }));
vi.mock("@/lib/ownership", () => ({
  effectiveOwnerForDocument: async () => ({ userId: null, name: null }),
  getOrgControllers: async () => ["ctrl-1"],
}));
vi.mock("@/lib/checkoutEpisodes", () => ({
  finishMySession: (...a: unknown[]) => s.finish(...a),
  postEpisodeSystemMessage: async () => undefined,
}));
vi.mock("@/lib/intents", () => ({ endMyIntents: async () => undefined }));
vi.mock("@/lib/audit", () => ({ logAuditAction: async () => undefined, logCheckoutEvent: async () => undefined }));
vi.mock("@/lib/storage", () => ({ uploadTicketAttachment: (...a: unknown[]) => s.upload(...a) }));
vi.mock("@/lib/holds", () => ({ openHold: async () => ({ id: "hold-1" }) }));
vi.mock("@/lib/activityThread", () => ({ postHandoff: async () => undefined }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: (...a: unknown[]) => s.emit(...a) }));
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "order", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = () => {
    s.lookupCalls++;
    const next = s.lookups.shift();
    return next ? next() : Promise.resolve({ data: null, error: null });
  };
  return { supabase: { from: () => chain } };
});
vi.mock("@/lib/ticketCreateClient", async (orig) => ({
  ...(await orig<typeof import("@/lib/ticketCreateClient")>()),
  submitTicketCreate: (...a: unknown[]) => s.submit(...a),
  discardStagedFiles: (...a: unknown[]) => s.discard(...a),
}));

import CheckInPanel from "@/components/documents/CheckInPanel";
import type { CheckoutSession, DocumentRecord } from "@/types/schema";
import type { CheckoutEpisode } from "@/lib/checkoutEpisodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "11111111-1111-4111-8111-111111111111";
const EPISODE = "cccccccc-0000-4000-8000-000000000001";
const doc = {
  id: "dddddddd-0000-4000-8000-000000000001", orgId: ORG, libraryId: "lib-1", collectionId: null,
  documentNumber: "P-101", title: "Flare header", rev: "4", currentVersionId: "eeeeeeee-0000-4000-8000-000000000004",
  metadata: { Unit: "200" },
} as unknown as DocumentRecord;
const episode = { id: EPISODE, seq: 7 } as unknown as CheckoutEpisode;
const mySession = { userId: "u-1", purpose: "As-Built Verification" } as unknown as CheckoutSession;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onDone = vi.fn();

beforeEach(() => {
  for (const f of [s.push, s.showToast, s.submit, s.discard, s.upload, s.finish, s.emit, onDone]) f.mockReset();
  s.lookups = [];
  s.lookupCalls = 0;
  s.finish.mockResolvedValue(undefined);
  s.upload.mockImplementation(async ({ ticketId, file }: { ticketId: string; file: File }) => ({ url: `orgs/${ORG}/tickets/${ticketId}/1_${file.name}` }));
  s.submit.mockResolvedValue({ ok: true, id: "t-new", ticketNumber: "KE-DDRT-26-0009", resumed: false, notified: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount() {
  await act(async () => {
    root!.render(React.createElement(CheckInPanel, {
      document: doc, currentUser: { uid: "u-1", email: "rita@plant.io", role: "Requester" },
      episode, mySession, activeSessions: [mySession], canPublish: false, onDone,
    }));
  });
  await flush();
}
const button = (text: string) => [...host!.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const type = async (el: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
async function reportDiscrepancy(withFile = false) {
  await act(async () => { button("Field is different — report it").click(); });
  await type(host!.querySelector("textarea")!, "Valve moved 2 m east of the drawn position");
  await act(async () => { button("No MOC exists").click(); });
  if (withFile) {
    const input = host!.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "redline.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  }
  await act(async () => { button("Send request & release").click(); });
  await flush();
  await flush();
}

describe("REGRESSION — a reported discrepancy files its drafting request through the create route", () => {
  it("one request: the check-in contract, the staged redline, the PSM escalation, the register entry and the redirect", async () => {
    await mount();
    await reportDiscrepancy(true);
    expect(s.submit).toHaveBeenCalledTimes(1);
    const body = s.submit.mock.calls[0][0];
    expect(body).toMatchObject({
      orgId: ORG, title: "As-Built Discrepancy: Flare header", requestType: "ASBUILT", priority: 1, unit: null, requesterRole: "Requester",
      description: "Valve moved 2 m east of the drawn position\n\nMOC: NONE ON RECORD — flagged as an undocumented field change.",
      sourceDocuments: [{ id: doc.id, documentNumber: "P-101", title: "Flare header", rev: "4", versionId: "eeeeeeee-0000-4000-8000-000000000004" }],
      origin: {
        kind: "checkin", episodeId: EPISODE, checkoutNumber: 7, purpose: "As-Built Verification", outcome: "discrepancy",
        moc: { status: "none", number: null }, minorCorrection: false, undocumentedChange: true,
      },
    });
    // EDGE-13: the redline was staged under the requester's pending prefix
    expect(s.upload.mock.calls[0][0].ticketId).toMatch(/^pending\/u-1\/[0-9a-f-]{36}$/);
    expect(body.attachments).toEqual([{ kind: "staged", key: expect.stringMatching(/^orgs\/.*\/tickets\/pending\/u-1\/.+\/1_redline\.pdf$/), name: "redline.pdf" }]);
    // the PSM escalation still goes to the controllers on the safety category
    expect(s.emit).toHaveBeenCalledWith(expect.objectContaining({ category: "safety", resource: { type: "ticket", id: "t-new" }, audience: { involved: ["ctrl-1"] } }));
    // the register entry names the ticket; the requester lands on it
    expect(s.finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: expect.objectContaining({ outcome: "discrepancy", ref: expect.objectContaining({ ticketId: "t-new", ticketNumber: "KE-DDRT-26-0009" }) }) }));
    expect(s.push).toHaveBeenCalledWith("/requests/t-new");
    expect(onDone).toHaveBeenCalled();
  });

  it("a refused request is a visible failure — nothing recorded, no redirect", async () => {
    s.submit.mockResolvedValue({ ok: false, status: 400, error: "A linked source document is not in this workspace." });
    await mount();
    await reportDiscrepancy();
    expect(s.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", title: "Check-in failed", message: "A linked source document is not in this workspace." }));
    expect(s.finish).not.toHaveBeenCalled();
    expect(s.push).not.toHaveBeenCalled();
  });

  it("a staging upload that fails is discarded and nothing is filed", async () => {
    s.upload.mockRejectedValue(new Error("network"));
    await mount();
    await reportDiscrepancy(true);
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.discard).toHaveBeenCalledWith(ORG, []);
  });
});

describe("LEAK-6 — the resume read is awaited and its error read", () => {
  it("a PENDING read is waited for: the ticket it finds is reused and nothing is filed", async () => {
    let release!: (v: Lookup) => void;
    s.lookups.push(() => new Promise<Lookup>((r) => { release = r; }));
    await mount();
    await act(async () => { button("Field is different — report it").click(); });
    await type(host!.querySelector("textarea")!, "Valve moved 2 m east of the drawn position");
    await act(async () => { button("No MOC exists").click(); });
    await act(async () => { button("Send request & release").click(); });
    await flush();
    expect(s.submit).not.toHaveBeenCalled();      // still waiting on the read
    expect(s.finish).not.toHaveBeenCalled();
    await act(async () => { release({ data: { id: "t-old", ticket_id: "KE-DDRT-26-0042" }, error: null }); });
    await flush();
    await flush();
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.emit).not.toHaveBeenCalled();         // no second PSM alert
    expect(s.finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: expect.objectContaining({ ref: expect.objectContaining({ ticketId: "t-old" }) }) }));
    expect(s.push).toHaveBeenCalledWith("/requests/t-old");
  });

  it("a FAILED read is made once more; when the second read finds the ticket, nothing is filed", async () => {
    s.lookups.push(async () => ({ data: null, error: { message: "timeout" } }));
    s.lookups.push(async () => ({ data: { id: "t-old", ticket_id: "KE-DDRT-26-0042" }, error: null }));
    await mount();
    await reportDiscrepancy();
    expect(s.lookupCalls).toBe(2);
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.push).toHaveBeenCalledWith("/requests/t-old");
  });

  it("a read that fails twice hands over to the route — which resumes by the episode server-side — exactly once", async () => {
    s.lookups.push(async () => ({ data: null, error: { message: "timeout" } }));
    s.lookups.push(async () => ({ data: null, error: { message: "timeout" } }));
    s.submit.mockResolvedValue({ ok: true, id: "t-old", ticketNumber: "KE-DDRT-26-0042", resumed: true });
    await mount();
    await reportDiscrepancy();
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.submit.mock.calls[0][0].origin.episodeId).toBe(EPISODE);
    expect(s.emit).not.toHaveBeenCalled();         // a resumed ticket re-fires no PSM alert
    expect(s.push).toHaveBeenCalledWith("/requests/t-old");
  });

  it("a retry after a failed session close reuses the ticket already filed in this mount — never a second request", async () => {
    s.finish.mockRejectedValueOnce(new Error("session close failed")).mockResolvedValue(undefined);
    await mount();
    await reportDiscrepancy();
    expect(s.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    await act(async () => { button("Send request & release").click(); });
    await flush();
    await flush();
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.push).toHaveBeenCalledWith("/requests/t-new");
  });
});
