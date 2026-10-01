// @vitest-environment jsdom
//
// document-control Round F wave 2 — P13 STATUS-TRANSITION, second review fix
// (REV-18): the un-archive dialog is no dead end. After 20261144 a restore to
// Issued is a controlled issue the database decides, so a non-controller in
// a library that requires sign-off cannot un-archive an archived Draft (or
// an unreviewed revision retired before the paste) AS Issued. The dialog now
// asks what the document comes back as (UNARCHIVE_RESTORE_STATUSES), offers
// first what the guard's retirement stamp says it WAS (unarchiveRestoreDefault:
// an archived issue -> Issued; a Draft, or anything unrecorded -> Draft), and
// a refused restore to Issued says the Draft restore is still open.
//
// Driven as rendered (jsdom); the data layer is mocked (its behaviour is
// driven end to end in dcRoundFRevUpFirstIssue.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  defaultAnswer: { status: "Draft", basis: "unknown" } as { status: string; basis: string },
  /** when set, the default read waits for it (the dialog's loading state) */
  gate: null as null | Promise<void>,
  unarchiveDocument: vi.fn(),
  archiveDocument: vi.fn(),
}));

vi.mock("@/lib/revisions", () => ({
  UNARCHIVE_RESTORE_STATUSES: ["Issued", "Draft", "In Review"],
  unarchiveRestoreDefault: vi.fn(async () => { if (s.gate) await s.gate; return s.defaultAnswer; }),
  unarchiveDocument: (...a: unknown[]) => s.unarchiveDocument(...a),
  archiveDocument: (...a: unknown[]) => s.archiveDocument(...a),
}));

import ArchiveConfirmModal from "@/components/documents/ArchiveConfirmModal";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UNREVIEWED = "This library requires reviewer sign-off, so a revision that was not reviewed can't be made a controlled issue; submit it for review, or ask Document Control.";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.unarchiveDocument.mockReset().mockResolvedValue(undefined);
  s.archiveDocument.mockReset().mockResolvedValue(undefined);
  s.defaultAnswer = { status: "Draft", basis: "unknown" };
  s.gate = null;
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
const select = () => host.querySelector('select[aria-label="Restore as"]') as HTMLSelectElement | null;
function choose(value: string) {
  const el = select()!;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  return act(async () => { el.dispatchEvent(new Event("change", { bubbles: true })); });
}

const doc = { id: "d1", documentNumber: "P-101", title: "P-101", status: "Archived", currentVersionId: "v1" } as unknown as DocumentRecord;
async function open(mode: "archive" | "unarchive") {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    root.render(React.createElement(ArchiveConfirmModal, {
      isOpen: true, onClose, doc, mode, orgId: "o1", actorUserId: "u1", onSuccess,
    }));
  });
  return { onSuccess, onClose };
}

describe("REV-18 (P13 second review fix) — the un-archive dialog asks what the document comes back as", () => {
  it("an archived Draft (stamped not-issued) is offered back as a Draft, and restored as one", async () => {
    s.defaultAnswer = { status: "Draft", basis: "not-issued" };
    let release!: () => void;
    s.gate = new Promise<void>((r) => { release = r; });
    const { onSuccess, onClose } = await open("unarchive");
    expect(button("Restore Document").disabled).toBe(true); // held until the default is known
    expect(host.textContent).toContain("Checking what it was before it was archived");
    release();
    await tick();
    expect(button("Restore Document").disabled).toBe(false);
    expect(select()!.value).toBe("Draft");
    expect([...select()!.options].map((o) => o.value)).toEqual(["Issued", "Draft", "In Review"]);
    expect(host.textContent).toContain("returned to Draft status");
    expect(host.textContent).toContain("It was not issued when it was archived");
    await click(button("Restore Document"));
    expect(s.unarchiveDocument).toHaveBeenCalledTimes(1);
    expect(s.unarchiveDocument.mock.calls[0][0]).toMatchObject({ restoreStatus: "Draft", doc: { id: "d1" } });
    expect(onSuccess).toHaveBeenCalledWith("Draft");
    expect(onClose).toHaveBeenCalled();
  });

  it("an archived issue is offered back as Issued — the put-back — with no warning", async () => {
    s.defaultAnswer = { status: "Issued", basis: "issued" };
    const { onSuccess } = await open("unarchive");
    await tick();
    expect(select()!.value).toBe("Issued");
    expect(host.textContent).toContain("It was issued when it was archived");
    expect(host.textContent).not.toContain("makes its current revision a controlled issue");
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[0][0]).toMatchObject({ restoreStatus: "Issued" });
    expect(onSuccess).toHaveBeenCalledWith("Issued");
  });

  it("unrecorded: Draft first; choosing Issued warns; a refused restore to Issued keeps the dialog open and says the Draft restore is still open — which then lands", async () => {
    const { onSuccess, onClose } = await open("unarchive");
    await tick();
    expect(select()!.value).toBe("Draft");
    expect(host.textContent).toContain("isn't recorded");
    await choose("Issued");
    expect(host.textContent).toContain("makes its current revision a controlled issue");
    s.unarchiveDocument.mockRejectedValueOnce(new Error(UNREVIEWED));
    await click(button("Restore Document"));
    expect(host.textContent).toContain(UNREVIEWED);
    expect(host.textContent).toContain("Nothing was restored. You can restore it as a Draft instead");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await choose("Draft");
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[1][0]).toMatchObject({ restoreStatus: "Draft" });
    expect(onSuccess).toHaveBeenCalledWith("Draft");
  });

  it("any other refusal is shown as it is (no Draft hint), and the archive side is unchanged (no status choice)", async () => {
    s.defaultAnswer = { status: "Issued", basis: "issued" };
    await open("unarchive");
    await tick();
    s.unarchiveDocument.mockRejectedValueOnce(new Error("network down"));
    await click(button("Restore Document"));
    expect(host.textContent).toContain("network down");
    expect(host.textContent).not.toContain("restore it as a Draft instead");

    act(() => root.unmount());
    root = createRoot(host);
    const { onSuccess } = await open("archive");
    expect(select()).toBeNull();
    const textarea = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "obsolete");
    await act(async () => { textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(button("Archive Document"));
    expect(s.archiveDocument).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith();
  });
});
