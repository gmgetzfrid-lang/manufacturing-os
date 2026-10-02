// @vitest-environment jsdom
//
// document-control Round F wave 2 — P13 STATUS-TRANSITION, second review fix
// (REV-18): the un-archive dialog is no dead end. After 20261144 a restore to
// Issued is a controlled issue the database decides, so a non-controller in
// a library that requires sign-off cannot un-archive an archived Draft (or
// an unreviewed revision retired before the paste) AS Issued. The dialog now
// asks what the document comes back as (UNARCHIVE_RESTORE_STATUSES), offers
// first what the guard's retirement stamp says it WAS (unarchiveRestoreDefault:
// an archived issue -> Issued; a Draft -> Draft), and a refused restore to
// Issued says the Draft restore is still open.
//
// Third review fix: anything the stamp does not record (archived before
// 20261144, by the service role, the app ahead of the paste) keeps the
// default every un-archive had before — Issued, decided by the database —
// never a silent Draft.
//
// Final review fix: the Draft restore is offered only where it would land —
// after the require limb's sentence, and after the new-door hold's only for
// a controller. The publisher tier's refusals (OWN-15: no authority, a hold)
// refuse a Draft restore the same way, so the dialog says to release the
// hold first or ask Document Control instead.
//
// REV-23 (P19 review fix): Document Control's restore of a held archived
// issue is a recorded override of the hold, and an override is chosen: the
// dialog names the active holds and requires an explicit confirmation before
// it sends forceHold; without one no force is sent (the guard refuses over
// the hold and the dialog offers the Draft restore).
//
// Driven as rendered (jsdom); the data layer is mocked (its behaviour is
// driven end to end in dcRoundFRevUpFirstIssue.test.ts and, for the hold
// override, dcRoundFStampedPutBack.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  defaultAnswer: { status: "Issued", basis: "unknown" } as { status: string; basis: string },
  /** when set, the default read waits for it (the dialog's loading state) */
  gate: null as null | Promise<void>,
  unarchiveDocument: vi.fn(),
  archiveDocument: vi.fn(),
  /** the actor's role collection, as the membership row holds it */
  roles: ["Engineer"] as string[],
  resolveActorPrincipal: vi.fn(),
  /** lib/holdGate readActiveHolds — the active holds the dialog reads (REV-23, P19 review fix) */
  readActiveHolds: vi.fn(),
}));

vi.mock("@/lib/revisions", () => ({
  UNARCHIVE_RESTORE_STATUSES: ["Issued", "Draft", "In Review"],
  unarchiveRestoreDefault: vi.fn(async () => { if (s.gate) await s.gate; return s.defaultAnswer; }),
  unarchiveDocument: (...a: unknown[]) => s.unarchiveDocument(...a),
  archiveDocument: (...a: unknown[]) => s.archiveDocument(...a),
}));
vi.mock("@/lib/principal", () => ({
  resolveActorPrincipal: (...a: unknown[]) => s.resolveActorPrincipal(...a),
}));
vi.mock("@/lib/holdGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/holdGate")>()),
  readActiveHolds: (...a: unknown[]) => s.readActiveHolds(...a),
}));

import ArchiveConfirmModal from "@/components/documents/ArchiveConfirmModal";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UNREVIEWED = "This library requires reviewer sign-off, so a revision that was not reviewed can't be made a controlled issue; submit it for review, or ask Document Control.";
const HOLD_ISSUE = "Document has an active hold; release the hold before issuing it.";
const NO_AUTHORITY = "You do not have authority to publish revisions in this library.";
const HOLD_PUBLISH = "Document has an active hold; release the hold before publishing a new revision.";
/** unarchiveDocument's wrapping of the guard's sentence (lib/revisions.ts) */
const refused = (sentence: string) => new Error(`The document was NOT restored (${sentence}) — nothing was changed.`);
const DRAFT_HINT = "You can restore it as a Draft instead";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.unarchiveDocument.mockReset().mockResolvedValue(undefined);
  s.archiveDocument.mockReset().mockResolvedValue(undefined);
  s.defaultAnswer = { status: "Issued", basis: "unknown" };
  s.gate = null;
  s.roles = ["Engineer"];
  s.readActiveHolds.mockReset().mockResolvedValue({ readable: true, holds: [] });
  s.resolveActorPrincipal.mockReset().mockImplementation(async (i: { uid: string; orgId?: string; headlineRole?: string }) => ({
    uid: i.uid, orgId: i.orgId, role: (i.headlineRole ?? s.roles[0]), roles: s.roles,
  }));
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
async function open(mode: "archive" | "unarchive", actorRole?: string) {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    root.render(React.createElement(ArchiveConfirmModal, {
      isOpen: true, onClose, doc, mode, orgId: "o1", actorUserId: "u1", actorRole, onSuccess,
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

  it("an archived Draft offered as a Draft: choosing Issued warns that it would be a first controlled issue", async () => {
    s.defaultAnswer = { status: "Draft", basis: "not-issued" };
    await open("unarchive");
    await tick();
    expect(select()!.value).toBe("Draft");
    expect(host.textContent).not.toContain("makes its current revision a controlled issue");
    await choose("Issued");
    expect(host.textContent).toContain("makes its current revision a controlled issue");
  });

  it("unrecorded (third review fix): Issued first, as every un-archive was before — never a silent Draft; a refused restore to Issued keeps the dialog open and says the Draft restore is still open — which then lands", async () => {
    const { onSuccess, onClose } = await open("unarchive");
    await tick();
    expect(select()!.value).toBe("Issued");
    expect(host.textContent).toContain("returned to Issued status");
    expect(host.textContent).toContain("isn't recorded, so it comes back as Issued, as un-archiving always has");
    expect(host.textContent).not.toContain("makes its current revision a controlled issue");
    s.unarchiveDocument.mockRejectedValueOnce(new Error(`The document was NOT restored (${UNREVIEWED}) — nothing was changed.`));
    await click(button("Restore Document"));
    expect(host.textContent).toContain(UNREVIEWED);
    expect(host.textContent).toContain("nothing was changed. You can restore it as a Draft instead");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await choose("Draft");
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[1][0]).toMatchObject({ restoreStatus: "Draft" });
    expect(onSuccess).toHaveBeenCalledWith("Draft");
  });

  it("a default read that throws (the stamp columns missing before the paste) keeps Issued — the user clicks Restore as they always have", async () => {
    const { unarchiveRestoreDefault } = await import("@/lib/revisions");
    (unarchiveRestoreDefault as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("column documents.retired_issue_status does not exist"));
    const { onSuccess } = await open("unarchive");
    await tick();
    expect(select()!.value).toBe("Issued");
    expect(button("Restore Document").disabled).toBe(false);
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[0][0]).toMatchObject({ restoreStatus: "Issued" });
    expect(onSuccess).toHaveBeenCalledWith("Issued");
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

describe("REV-18 (P13 final review fix) — the Draft restore is offered only where it would land", () => {
  async function refuseIssued(sentence: string, actorRole?: string) {
    const { onSuccess, onClose } = await open("unarchive", actorRole);
    await tick();
    expect(select()!.value).toBe("Issued");
    s.unarchiveDocument.mockRejectedValueOnce(refused(sentence));
    await click(button("Restore Document"));
    expect(host.textContent).toContain(sentence); // the guard's own sentence is always shown
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  }

  it("the publisher tier's refusals (OWN-15) refuse a Draft restore the same way: no authority -> ask Document Control; the publish hold -> release the hold first — never the Draft hint", async () => {
    await refuseIssued(NO_AUTHORITY);
    expect(host.textContent).not.toContain(DRAFT_HINT);
    expect(host.textContent).toContain("Restoring it as a Draft needs the same authority — ask Document Control to restore it.");

    act(() => root.unmount());
    root = createRoot(host);
    await refuseIssued(HOLD_PUBLISH);
    expect(host.textContent).not.toContain(DRAFT_HINT);
    expect(host.textContent).toContain("Restoring it as a Draft is refused the same way: the hold must be released first (or ask Document Control).");
    // neither asks who the actor is: the publisher tier binds everyone short of a controller, and a controller never meets it
    expect(s.resolveActorPrincipal).not.toHaveBeenCalled();
  });

  it("the new-door hold refuses only the issue: a controller (read from the role collection, not the headline) is offered the Draft restore; anyone else is told to release the hold first", async () => {
    await refuseIssued(HOLD_ISSUE, "Engineer");
    expect(host.textContent).not.toContain(DRAFT_HINT);
    expect(host.textContent).toContain("the hold must be released first (or ask Document Control)");
    expect(s.resolveActorPrincipal).toHaveBeenCalledWith({ uid: "u1", orgId: "o1", headlineRole: "Engineer" });

    act(() => root.unmount());
    root = createRoot(host);
    s.roles = ["Manager", "DocCtrl"]; // an additively-held DocCtrl under a Manager headline is a controller (OWN-3)
    await refuseIssued(HOLD_ISSUE, "Manager");
    expect(host.textContent).toContain(`${DRAFT_HINT} (choose Draft above) — the hold refuses only the issue — and issue it once the hold is released.`);
    expect(host.textContent).not.toContain("the hold must be released first");
    // …and the Draft restore it offers is the one that lands
    await choose("Draft");
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls.at(-1)![0]).toMatchObject({ restoreStatus: "Draft" });
  });

  it("the require limb's sentence keeps the Draft hint (a Draft restore is never decided by it), and asks nothing more", async () => {
    await refuseIssued(UNREVIEWED);
    expect(host.textContent).toContain(`nothing was changed. ${DRAFT_HINT} (choose Draft above), then submit its revision for review.`);
    expect(s.resolveActorPrincipal).not.toHaveBeenCalled();
  });
});

describe("REV-19 (P14 final review) — a landed restore says what did not follow it before the dialog closes", () => {
  const outcome = (o: Partial<{ putBack: boolean | null; complianceClockErrors: string[]; recordError: string | null }>) =>
    ({ issued: true, putBack: null, complianceClockErrors: [], recordError: null, ...o });

  it("a review clock / acknowledgment roster that did not start is named; the dialog stays until Done, which finishes the restore", async () => {
    s.defaultAnswer = { status: "Issued", basis: "unknown" };
    s.unarchiveDocument.mockResolvedValueOnce(outcome({ complianceClockErrors: ["the acknowledgment roster could not be saved (permission denied)"] }));
    const { onSuccess, onClose } = await open("unarchive");
    await tick();
    await click(button("Restore Document"));
    const dialog = host.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Restored as Issued — 1 follow-up step did not complete");
    expect(dialog?.textContent).toContain("The restore stands and is not rolled back — do not restore it again.");
    expect(host.querySelector('[data-testid="restore-follow-ups"]')?.textContent).toBe("the acknowledgment roster could not be saved (permission denied)");
    expect(dialog?.textContent).toContain("recorded on the document's history");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await click(button("Done"));
    expect(onSuccess).toHaveBeenCalledWith("Issued");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an issue record that could not be written is named — and the dialog does not claim the history holds it", async () => {
    s.defaultAnswer = { status: "Issued", basis: "issued" };
    s.unarchiveDocument.mockResolvedValueOnce(outcome({ putBack: true, recordError: "permission denied for table audit_logs" }));
    const { onSuccess } = await open("unarchive");
    await tick();
    await click(button("Restore Document"));
    expect(host.querySelector('[data-testid="restore-follow-ups"]')?.textContent).toBe("The issue record could not be written (permission denied for table audit_logs), so this issue is not on the document's history.");
    expect(host.querySelector('[role="alertdialog"]')?.textContent).not.toContain("recorded on the document's history;");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("regression — an outcome with nothing outstanding closes at once, as before", async () => {
    s.unarchiveDocument.mockResolvedValueOnce(outcome({ putBack: false }));
    const { onSuccess, onClose } = await open("unarchive");
    await tick();
    await click(button("Restore Document"));
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onSuccess).toHaveBeenCalledWith("Issued");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("REV-23 (P19 review fix) — Document Control's restore over an active hold is confirmed, never implied", () => {
  const hold = (id: string, reason: string, notes: string | null = null) => ({ id, reason, notes, openedAt: "2026-09-01", openedByName: "Dana" });
  const checkbox = () => host.querySelector('input[type="checkbox"]') as HTMLInputElement | null;

  it("a controller restoring the held archived issue as Issued sees the holds (an Other hold by its description) and must tick the Required confirmation; only then is the restore sent, with forceHold", async () => {
    s.defaultAnswer = { status: "Issued", basis: "issued" };
    s.roles = ["Manager", "DocCtrl"]; // the role collection, not the headline
    s.readActiveHolds.mockResolvedValue({ readable: true, holds: [hold("h1", "Safety"), hold("h2", "Other", "waiting on vendor weld map")] });
    const { onSuccess } = await open("unarchive", "Manager");
    await tick();
    expect(s.readActiveHolds).toHaveBeenCalledWith("d1");
    expect(s.resolveActorPrincipal).toHaveBeenCalledWith({ uid: "u1", orgId: "o1", headlineRole: "Manager" });
    expect(host.textContent).toContain("Required. Restore it as Issued over the active holds (Safety, Other: waiting on vendor weld map): it comes back into force while they stand. Restoring it as a Draft needs no override.");
    expect(host.textContent).toContain("The holds you proceed over are named on the audit record.");
    expect(checkbox()!.checked).toBe(false);
    expect(button("Restore Document").disabled).toBe(true);
    await click(checkbox()!);
    expect(checkbox()!.checked).toBe(true);
    expect(button("Restore Document").disabled).toBe(false);
    await click(button("Restore Document"));
    expect(s.unarchiveDocument).toHaveBeenCalledTimes(1);
    expect(s.unarchiveDocument.mock.calls[0][0]).toMatchObject({ restoreStatus: "Issued", forceHold: true });
    expect(onSuccess).toHaveBeenCalledWith("Issued");
  });

  it("the Draft restore needs no override: no confirmation is asked, and no force is sent", async () => {
    s.defaultAnswer = { status: "Issued", basis: "issued" };
    s.roles = ["DocCtrl"];
    s.readActiveHolds.mockResolvedValue({ readable: true, holds: [hold("h1", "Safety")] });
    await open("unarchive", "DocCtrl");
    await tick();
    expect(checkbox()).not.toBeNull();
    expect(host.textContent).toContain("over the active hold (Safety): it comes back into force while the hold stands.");
    await choose("Draft");
    expect(checkbox()).toBeNull();
    expect(button("Restore Document").disabled).toBe(false);
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[0][0]).toMatchObject({ restoreStatus: "Draft" });
    expect(s.unarchiveDocument.mock.calls[0][0].forceHold).toBeUndefined();
  });

  it("below Document Control nothing is offered (the publisher tier refuses any un-archive over a hold, in words the dialog already answers) and no force is sent", async () => {
    s.defaultAnswer = { status: "Issued", basis: "issued" };
    s.roles = ["Engineer"];
    s.readActiveHolds.mockResolvedValue({ readable: true, holds: [hold("h1", "Safety")] });
    await open("unarchive", "Engineer");
    await tick();
    expect(checkbox()).toBeNull();
    expect(button("Restore Document").disabled).toBe(false);
    s.unarchiveDocument.mockRejectedValueOnce(refused(HOLD_PUBLISH));
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[0][0].forceHold).toBeUndefined();
    expect(host.textContent).toContain("Restoring it as a Draft is refused the same way: the hold must be released first (or ask Document Control).");
  });

  it("holds that cannot be read: a controller is told so and the restore is sent WITHOUT a force — over a hold the guard refuses it in the new-door sentence, and the dialog offers the Draft restore", async () => {
    s.defaultAnswer = { status: "Issued", basis: "issued" };
    s.roles = ["DocCtrl"];
    s.readActiveHolds.mockResolvedValue({ readable: false, error: "permission denied for table document_holds" });
    await open("unarchive", "DocCtrl");
    await tick();
    expect(host.textContent).toContain("Couldn't check for active holds (permission denied for table document_holds). The operation still checks them itself and refuses a held document.");
    expect(checkbox()).toBeNull();
    expect(button("Restore Document").disabled).toBe(false);
    s.unarchiveDocument.mockRejectedValueOnce(refused(HOLD_ISSUE));
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[0][0].forceHold).toBeUndefined();
    expect(host.textContent).toContain(`${DRAFT_HINT} (choose Draft above) — the hold refuses only the issue — and issue it once the hold is released.`);
  });

  it("only the restore of the archived issue (the stamp names the current revision) is asked about: an unrecorded or not-issued archive reads no holds and asks no one — any restore of it to Issued over a hold is refused for everyone, and the dialog answers after", async () => {
    for (const basis of ["unknown", "not-issued"] as const) {
      act(() => root.unmount());
      root = createRoot(host);
      s.defaultAnswer = { status: basis === "unknown" ? "Issued" : "Draft", basis };
      s.roles = ["DocCtrl"];
      s.readActiveHolds.mockClear();
      s.resolveActorPrincipal.mockClear();
      await open("unarchive", "DocCtrl");
      await tick();
      expect(s.readActiveHolds, basis).not.toHaveBeenCalled();
      expect(s.resolveActorPrincipal, basis).not.toHaveBeenCalled();
      expect(checkbox(), basis).toBeNull();
    }
  });

  it("no active hold: nothing asked — the holds are read, the actor never resolved, and the restore is sent as before (no force)", async () => {
    s.defaultAnswer = { status: "Issued", basis: "issued" };
    s.roles = ["DocCtrl"];
    await open("unarchive", "DocCtrl");
    await tick();
    expect(s.readActiveHolds).toHaveBeenCalledTimes(1);
    expect(s.resolveActorPrincipal).not.toHaveBeenCalled();
    expect(checkbox()).toBeNull();
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[0][0].forceHold).toBeUndefined();
  });
});
