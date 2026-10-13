// @vitest-environment jsdom
//
// document-control Round F wave 3 — P25 STATUS-SURFACE FOLLOW-UPS: REV-27,
// the un-archive dialog's half (decided with DEC-77: the restore to the
// stamped status is offered as the put-back of what the document was).
//
//   An archive whose retirement stamp names the current revision with a
//   status no gate reads as in force (an IFC drawing archived as IFC, a
//   library's own status, no status) is read as what it was —
//   unarchiveRestoreDefault's `not-in-force` basis. The dialog:
//     - pre-selects the stamped status (offered beside Issued / Draft /
//       In Review, for that stamp only) — or Draft when what it was cannot be
//       restored (a NULL or blank stamp) — never Issued;
//     - never calls the restore into Issued "the put-back of that issue", and
//       says instead that it is a first entry into force the database judges
//       as an issue (since 20261185);
//     - asks Document Control's hold-override confirmation only for the
//       put-back of the stamped status, never for Issued (20261185 refuses
//       Issued over a hold for everyone, whatever override is sent);
//     - after the require sentence, offers the stamped status as well as the
//       Draft.
//   Every other basis (issued / not-issued / unknown) answers exactly as
//   before (pinned in dcRoundFUnarchiveDialog.test.ts, unchanged).
//
// Driven as rendered (jsdom) with the data layer mocked; unarchiveDocument
// and unarchiveRestoreDefault are driven against the guard's transcription
// in dcRoundFStatusIntoForce.test.ts and dcRoundFStatusSurface.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  defaultAnswer: { status: "Issued", basis: "unknown" } as Record<string, unknown>,
  unarchiveDocument: vi.fn(),
  archiveDocument: vi.fn(),
  roles: ["Engineer"] as string[],
  resolveActorPrincipal: vi.fn(),
  readActiveHolds: vi.fn(),
}));

vi.mock("@/lib/revisions", () => ({
  UNARCHIVE_RESTORE_STATUSES: ["Issued", "Draft", "In Review"],
  unarchiveRestoreDefault: vi.fn(async () => s.defaultAnswer),
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
const refused = (sentence: string) => new Error(`The document was NOT restored (${sentence}) — nothing was changed.`);
const IFC_DEFAULT = { status: "IFC", basis: "not-in-force", stampedStatus: "IFC", stampedRestore: "IFC" };
const hold = (id: string, reason: string) => ({ id, reason, notes: null, openedAt: "2026-09-01", openedByName: "Dana" });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.unarchiveDocument.mockReset().mockResolvedValue(undefined);
  s.archiveDocument.mockReset().mockResolvedValue(undefined);
  s.defaultAnswer = { ...IFC_DEFAULT };
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
const select = () => host.querySelector('select[aria-label="Restore as"]') as HTMLSelectElement;
const checkbox = () => host.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
const entryNote = () => host.querySelector('[data-testid="unarchive-entry-into-force-note"]');
function choose(value: string) {
  const el = select();
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  return act(async () => { el.dispatchEvent(new Event("change", { bubbles: true })); });
}
const doc = { id: "d1", documentNumber: "P-101", title: "P-101", status: "Archived", currentVersionId: "v1" } as unknown as DocumentRecord;
async function open(actorRole?: string) {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    root.render(React.createElement(ArchiveConfirmModal, {
      isOpen: true, onClose, doc, mode: "unarchive", orgId: "o1", actorUserId: "u1", actorRole, onSuccess,
    }));
  });
  await tick();
  return { onSuccess, onClose };
}

describe("REV-27 (P25) — an archive stamped with a status no gate reads as in force is offered back as what it was", () => {
  it("an IFC-stamped archive: IFC is offered (for that stamp only) and pre-selected; nothing calls Issued the put-back of an issue; restoring it sends IFC and reports it", async () => {
    const { onSuccess, onClose } = await open();
    expect([...select().options].map((o) => o.value)).toEqual(["Issued", "Draft", "In Review", "IFC"]);
    expect([...select().options].map((o) => o.textContent)).toContain("IFC (what it was when archived)");
    expect(select().value).toBe("IFC");
    expect(host.textContent).toContain('It was "IFC" when it was archived — not a status any gate reads as in force (the field pack does not print it and the verify page does not recognise it). Restoring it as "IFC" puts back what it was; that is the default.');
    expect(host.textContent).not.toContain("puts that issue back");
    expect(entryNote()).toBeNull();
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[0][0]).toMatchObject({ restoreStatus: "IFC" });
    expect(s.unarchiveDocument.mock.calls[0][0].forceHold).toBeUndefined();
    expect(onSuccess).toHaveBeenCalledWith("IFC");
    expect(onClose).toHaveBeenCalled();
  });

  it("choosing Issued says what it is — a first entry into force the database judges as an issue — never a put-back", async () => {
    await open();
    await choose("Issued");
    const note = entryNote()!.textContent!;
    expect(note).toMatch(/^Restoring as Issued puts its current revision in force for the first time — an issue, not the\s+put-back of one/);
    expect(note).toMatch(/Since database update 20261185\s+the database judges it as an issue/);
    expect(note).toMatch(/an active hold refuses it for everyone, Document Control included\./);
    expect(host.textContent).not.toContain("puts that issue back");
  });

  it("Document Control over a hold: the recorded override is asked for the put-back of IFC only (in words that say it does not come into force) — never for Issued, which no override passes", async () => {
    s.roles = ["Manager", "DocCtrl"];
    s.readActiveHolds.mockResolvedValue({ readable: true, holds: [hold("h1", "Safety")] });
    await open("Manager");
    expect(select().value).toBe("IFC");
    expect(checkbox()).not.toBeNull();
    expect(host.textContent).toContain("Restore it as IFC over the active hold (Safety): it comes back as what it was when it was archived (not in force) while the hold stands. Restoring it as a Draft needs no override.");
    expect(host.textContent).not.toContain("it comes back into force");
    expect(button("Restore Document").disabled).toBe(true);
    await choose("Issued");
    expect(checkbox()).toBeNull(); // no override is offered for a first entry into force
    expect(button("Restore Document").disabled).toBe(false);
    s.unarchiveDocument.mockRejectedValueOnce(refused(HOLD_ISSUE));
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[0][0]).toMatchObject({ restoreStatus: "Issued" });
    expect(s.unarchiveDocument.mock.calls[0][0].forceHold).toBeUndefined();
    expect(host.textContent).toContain('You can restore it as "IFC" instead — what it was when it was archived; over the hold that is your recorded override, which the dialog asks you to confirm when you choose it above — or as a Draft (choose it above)');
    // back to IFC: confirmed, the override is sent
    await choose("IFC");
    await click(checkbox()!);
    await click(button("Restore Document"));
    expect(s.unarchiveDocument.mock.calls[1][0]).toMatchObject({ restoreStatus: "IFC", forceHold: true });
  });

  it("after the require sentence (a non-controller's restore into Issued), the stamped status is offered as well as the Draft", async () => {
    await open();
    await choose("Issued");
    s.unarchiveDocument.mockRejectedValueOnce(refused(UNREVIEWED));
    await click(button("Restore Document"));
    expect(host.textContent).toContain('You can restore it as "IFC" instead — what it was when it was archived (choose it above) — or as a Draft, then submit its revision for review.');
  });

  it("a stamp of no status (NULL) or an empty one cannot be put back by the un-archive: Draft is pre-selected, no extra option, never Issued", async () => {
    for (const stamped of [null, "  "]) {
      s.defaultAnswer = { status: "Draft", basis: "not-in-force", stampedStatus: stamped, stampedRestore: null };
      await open();
      expect([...select().options].map((o) => o.value)).toEqual(["Issued", "Draft", "In Review"]);
      expect(select().value).toBe("Draft");
      expect(host.textContent).toContain(`It was ${stamped === null ? "in no status" : "in an empty status"} when it was archived — not a status any gate reads as in force. The archive can't put that back, so it comes back as a Draft unless you choose otherwise.`);
      await act(async () => root.render(React.createElement("div")));
    }
  });

  it("a library's own status stamped is read the same way (offered as itself, pre-selected)", async () => {
    s.defaultAnswer = { status: "Approved for Construction", basis: "not-in-force", stampedStatus: "Approved for Construction", stampedRestore: "Approved for Construction" };
    await open();
    expect(select().value).toBe("Approved for Construction");
    expect(host.textContent).toContain('It was "Approved for Construction" when it was archived');
  });

  it("REGRESSION — an Issued-stamped archive still offers Issued as the put-back of that issue, with its override over a hold; no extra option", async () => {
    s.defaultAnswer = { status: "Issued", basis: "issued" };
    s.roles = ["DocCtrl"];
    s.readActiveHolds.mockResolvedValue({ readable: true, holds: [hold("h1", "Safety")] });
    await open("DocCtrl");
    expect([...select().options].map((o) => o.value)).toEqual(["Issued", "Draft", "In Review"]);
    expect(select().value).toBe("Issued");
    expect(host.textContent).toContain("It was issued when it was archived — restoring it as Issued puts that issue back.");
    expect(host.textContent).toContain("Restore it as Issued over the active hold (Safety): it comes back into force while the hold stands.");
    expect(entryNote()).toBeNull();
  });
});
