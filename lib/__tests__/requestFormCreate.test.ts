// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P2 — the request form (app/(protected)/requests/new),
// AS RENDERED, filing through /api/tickets/create.
//
// REGRESSION first: a requester who fills the form and presses Submit still
// files their request and lands on the queue — the form now stages its files
// under the requester's pending prefix and posts the create contract; the
// route numbers, inserts and notifies (EDGE-8: no fan-out, no number, no
// insert left in the tab; the redirect follows the route's answer, not a
// 500 ms timer).
//
//   EDGE-13  every check the form can make runs before any upload — a missing
//            required field never uploads a byte;
//   FRIC-3   unit is optional: "Unit unknown — triage assigns" is an answer,
//            several units pre-select nothing, one unit is pre-selected, and
//            a refused submit names its field and puts the cursor there;
//   DCW-7    with no unit list, the free-text box says it is a setup gap;
//   GAP-8    every marked-up sheet of a hand-off is named, primary first.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  push: vi.fn(),
  params: "" as string,
  config: null as unknown,
  submit: vi.fn(),
  discard: vi.fn(),
  upload: vi.fn(),
  alert: vi.fn(),
  draft: null as unknown,
  discardDraft: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: s.push, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(s.params),
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeRole: "Requester", roles: ["Requester"], activeOrgId: "org-1", uid: "u-1", userEmail: "rita@plant.io" }),
}));
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.single = async () => ({ data: s.config ? { data: s.config } : null, error: s.config ? null : { message: "none" } });
  return { supabase: { from: () => chain } };
});
vi.mock("@/lib/codebook", () => ({ loadCodebook: async () => ({ units: [] }) }));
vi.mock("@/lib/storage", () => ({ uploadTicketAttachment: (...a: unknown[]) => s.upload(...a) }));
vi.mock("@/lib/draftHandoff", () => ({
  readDraft: async () => s.draft,
  discardDraft: (...a: unknown[]) => s.discardDraft(...a),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: (...a: unknown[]) => s.alert(...a) }));
vi.mock("@/components/ui/IsoGuidance", () => ({ default: () => null }));
vi.mock("@/lib/ticketCreateClient", () => ({
  submitTicketCreate: (...a: unknown[]) => s.submit(...a),
  discardStagedFiles: (...a: unknown[]) => s.discard(...a),
}));

import NewTicketPage from "@/app/(protected)/requests/new/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIG = (units: Array<{ label: string; value: string }>, required = false) => ({
  requestTypes: { label: "Request Type", enabled: true, options: [{ label: "ISO", value: "ISO" }] },
  units: { label: "Unit / Area", enabled: true, options: units },
  priorities: { label: "Priority", enabled: true, options: [{ label: "2", value: 2 }, { label: "3", value: 3 }, { label: "4", value: 4 }] },
  customCategories: required ? [{ id: "wo", label: "Work order", enabled: true, fields: [{ key: "wo_number", label: "Work Order #", type: "text", required: true }] }] : [],
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  for (const f of [s.push, s.submit, s.discard, s.upload, s.alert, s.discardDraft]) f.mockReset();
  s.params = "";
  s.draft = null;
  s.config = CONFIG([{ label: "Unit 100", value: "100" }, { label: "Unit 200", value: "200" }]);
  s.alert.mockResolvedValue(undefined);
  s.discardDraft.mockResolvedValue(undefined);
  s.upload.mockImplementation(async ({ ticketId, file }: { ticketId: string; file: File }) => ({ url: `orgs/org-1/tickets/${ticketId}/1_${file.name}` }));
  s.submit.mockResolvedValue({ ok: true, id: "t-1", ticketNumber: "KE-DDRT-26-0001", resumed: false, notified: true });
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
  await act(async () => { root!.render(React.createElement(NewTicketPage)); });
  await flush();
  await flush();
}
const el = <T extends HTMLElement>(sel: string) => host!.querySelector(sel) as T;
async function setValue(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function fillBasics() {
  await setValue(el<HTMLInputElement>("#request-title"), "Re-route the flare header");
  await setValue(el<HTMLTextAreaElement>("#request-description"), "Move the tie-in 2 m east.");
}
async function submit() {
  await act(async () => { el<HTMLFormElement>("form").requestSubmit(); });
  await flush();
  await flush();
}

describe("REGRESSION — the form files its request through the create route", () => {
  it("fill, pick a unit, attach a file, submit: staged upload, the contract, the redirect on the route's answer", async () => {
    await mount();
    await fillBasics();
    await setValue(el<HTMLSelectElement>("#request-unit"), "200");
    const input = el<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input, "files", { value: [new File(["x"], "redline.pdf", { type: "application/pdf" })], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await submit();
    expect(s.upload).toHaveBeenCalledTimes(1);
    expect(s.upload.mock.calls[0][0]).toMatchObject({ orgId: "org-1", ticketId: expect.stringMatching(/^pending\/u-1\/[0-9a-f-]{36}$/) });
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.submit.mock.calls[0][0]).toEqual({
      orgId: "org-1", title: "Re-route the flare header", description: "Move the tie-in 2 m east.",
      requestType: "ISO", priority: 3, unit: "200", targetCompletionAt: null, requesterRole: "Requester",
      customCategories: null, sourceDocuments: [],
      attachments: [{ kind: "staged", key: expect.stringMatching(/^orgs\/org-1\/tickets\/pending\/u-1\/.+\/1_redline\.pdf$/), name: "redline.pdf" }],
      origin: { kind: "portal" },
    });
    expect(s.push).toHaveBeenCalledWith("/requests");
    expect(s.alert).not.toHaveBeenCalled();
  });

  it("a viewer hand-off: the source document and its library file ride in the contract", async () => {
    s.params = new URLSearchParams({ sourceDocId: "doc-1", sourceDocNum: "P-101", sourceDocTitle: "Flare header", sourceDocRev: "4", sourceFileUrl: "orgs/org-1/libraries/l1/p101.pdf", sourceFileName: "p101.pdf" }).toString();
    await mount();
    await fillBasics();
    await submit();
    expect(s.submit.mock.calls[0][0]).toMatchObject({
      sourceDocuments: [{ id: "doc-1", documentNumber: "P-101", title: "Flare header", rev: "4", versionId: null }],
      attachments: [{ kind: "source_reference", key: "orgs/org-1/libraries/l1/p101.pdf", name: "p101.pdf" }],
    });
  });

  it("GAP-8: a book-viewer hand-off of several sheets names every sheet, primary first; the stash is dropped after the route answers", async () => {
    s.params = "draft=k1";
    s.draft = { files: [
      { name: "a.pdf", blob: new Blob(["a"], { type: "application/pdf" }), docId: "doc-a", docNumber: "P-1" },
      { name: "b.pdf", blob: new Blob(["b"], { type: "application/pdf" }), docId: "doc-b", docNumber: "P-2" },
      { name: "c.pdf", blob: new Blob(["c"], { type: "application/pdf" }), docId: "doc-a", docNumber: "P-1" },
    ] };
    await mount();
    await fillBasics();
    await submit();
    expect(s.submit.mock.calls[0][0].sourceDocuments.map((d: { id: string }) => d.id)).toEqual(["doc-a", "doc-b"]);
    expect(s.upload).toHaveBeenCalledTimes(3);
    expect(s.discardDraft).toHaveBeenCalledWith("k1");
  });
});

describe("FRIC-3 / DCW-7 — the unit is optional and never silently guessed", () => {
  it("several units: the select opens on 'Unit unknown — triage assigns', and submitting it sends null", async () => {
    await mount();
    const sel = el<HTMLSelectElement>("#request-unit");
    expect(sel.value).toBe("");
    expect(sel.options[0].textContent).toBe("Unit unknown — triage assigns");
    await fillBasics();
    await submit();
    expect(s.submit.mock.calls[0][0].unit).toBeNull();
  });

  it("one unit: it is the only honest answer and is pre-selected", async () => {
    s.config = CONFIG([{ label: "Unit 100", value: "100" }]);
    await mount();
    expect(el<HTMLSelectElement>("#request-unit").value).toBe("100");
  });

  it("no unit list: the box is optional and says it is a setup gap", async () => {
    s.config = CONFIG([]);
    await mount();
    const input = el<HTMLInputElement>("#request-unit");
    expect(input.required).toBe(false);
    expect(host!.textContent).toContain("This workspace has no unit list yet");
    await fillBasics();
    await submit();
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.submit.mock.calls[0][0].unit).toBeNull();
  });

  it("a title of only spaces is named and focused — never a silent return", async () => {
    await mount();
    await fillBasics();
    await setValue(el<HTMLInputElement>("#request-title"), "   ");
    await submit();
    expect(s.alert).toHaveBeenCalledWith("A title is required.");
    expect(document.activeElement?.id).toBe("request-title");
    expect(s.submit).not.toHaveBeenCalled();
  });

  it("a refused submit names the field and moves the cursor to it; the button comes back", async () => {
    s.submit.mockResolvedValue({ ok: false, status: 400, error: '"999" is not on this workspace\'s unit list', field: "unit" });
    await mount();
    await fillBasics();
    await submit();
    expect(s.alert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("is not on this workspace's unit list") }));
    expect(document.activeElement?.id).toBe("request-unit");
    expect(s.push).not.toHaveBeenCalled();
    expect((el<HTMLButtonElement>('button[type="submit"]')).disabled).toBe(false);
  });
});

describe("EDGE-13 — the form's own checks run before any upload", () => {
  it("a required custom field left empty: the message, the cursor on the field, no upload and nothing posted", async () => {
    s.config = CONFIG([{ label: "Unit 100", value: "100" }], true);
    await mount();
    await fillBasics();
    const input = el<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input, "files", { value: [new File(["x"], "redline.pdf")], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await submit();
    expect(s.alert).toHaveBeenCalledWith('"Work Order #" (Work order) is required.');
    expect(document.activeElement?.id).toBe("custom-wo-wo_number");
    expect(s.upload).not.toHaveBeenCalled();
    expect(s.submit).not.toHaveBeenCalled();
  });

  it("an upload that fails part-way discards what was staged and posts nothing", async () => {
    s.upload.mockImplementationOnce(async ({ ticketId, file }: { ticketId: string; file: File }) => ({ url: `orgs/org-1/tickets/${ticketId}/1_${file.name}` }))
      .mockRejectedValueOnce(new Error("network"));
    await mount();
    await fillBasics();
    const input = el<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input, "files", { value: [new File(["x"], "a.pdf"), new File(["y"], "b.pdf")], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await submit();
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.discard).toHaveBeenCalledWith("org-1", [expect.stringMatching(/1_a\.pdf$/)]);
    expect(s.alert).toHaveBeenCalledWith(expect.objectContaining({ message: "Failed to create ticket: network" }));
  });
});
