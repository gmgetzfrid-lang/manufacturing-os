// Ways back from what was entered: the award a quote posted, an approved
// change order, a closed project, a turnover decision, an intake link's end
// date, a shift's incidents and notes, and a progress reset.

import { describe, it, expect } from "vitest";
import { findDocEntries, type CostEntry } from "@/lib/costs";
import { lineOfDoc, type CostDocument } from "@/lib/costDocs";
import { voidedApprovalNote } from "@/lib/changeOrders";
import { canReopen, isReopen, statusChangePatch, statusActivityBody } from "@/lib/projectStatus";
import { orgRolesManage } from "@/lib/projectAccess";
import { reopenedTurnover } from "@/lib/turnover";
import { extendedExpiry, isExpired, endOfDayIso, dayOfIso } from "@/lib/intakeExpiry";
import { editIncident, restoreIncident, editNote, restoreNote, unclearNote, type ShiftRecord } from "@/lib/shiftRecord";
import { statusNotesToRestore } from "@/lib/milestones";

const entry = (over: Partial<CostEntry>): CostEntry => ({
  id: "e1", costAccountId: "a1", projectId: "p1", partyId: null,
  entryType: "commitment", amount: 182000, entryDate: "2026-11-01",
  description: "Award - Brand Scaffold (Scaffolding)", reference: "Q-1001", status: "posted",
  sourceDocumentId: null,
  ...over,
});

const doc = (over: Partial<CostDocument>): CostDocument => ({
  id: "d1", orgId: "o1", projectId: "p1", partyId: null, kind: "quote",
  fileUrl: null, fileName: "brand.pdf", mimeType: null, docNumber: "Q-1001", docDate: null,
  vendorName: "Brand Scaffold", currency: "USD", totalAmount: 182000, status: "awarded",
  parsed: null, rfqGroup: "Scaffolding", intakeLinkId: null, postedAt: null, createdAt: null,
  ...over,
});

describe("the entry an award or an invoice posted", () => {
  it("the linked entry wins, and a voided one never counts", () => {
    const linked = entry({ id: "e2", sourceDocumentId: "d1", amount: 175000 });
    const look = entry({ id: "e3" });
    expect(findDocEntries(doc({}), [look, linked]).map((e) => e.id)).toEqual(["e2"]);
    expect(findDocEntries(doc({}), [entry({ id: "e4", sourceDocumentId: "d1", status: "void" }), look]).map((e) => e.id)).toEqual(["e3"]);
  });
  it("older entries without the link: found by what the posting wrote", () => {
    expect(findDocEntries(doc({}), [entry({})]).map((e) => e.id)).toEqual(["e1"]);
    // Another vendor's award, or the wrong reference: not it.
    expect(findDocEntries(doc({}), [entry({ description: "Award - Other Co (Scaffolding)" })])).toEqual([]);
    expect(findDocEntries(doc({}), [entry({ reference: "Q-2002" })])).toEqual([]);
    // An actual is never an award's entry.
    expect(findDocEntries(doc({}), [entry({ entryType: "actual" })])).toEqual([]);
  });
  it("a revised amount is still found; look-alikes are told apart by amount, else none", () => {
    expect(findDocEntries(doc({}), [entry({ amount: 190000, description: "Award - Brand Scaffold (Scaffolding) · Revised from $182,000" })]).map((e) => e.id)).toEqual(["e1"]);
    const two = [entry({ id: "a" }), entry({ id: "b", amount: 99000 })];
    expect(findDocEntries(doc({}), two).map((e) => e.id)).toEqual(["a"]);
    expect(findDocEntries(doc({}), [entry({ id: "a" }), entry({ id: "b" })])).toEqual([]);
  });
  it("an invoice's actual, and which line it sits on", () => {
    const inv = doc({ id: "i1", kind: "invoice", status: "posted", docNumber: "INV-7", vendorName: "Acme", totalAmount: 5000 });
    const e = entry({ id: "x", entryType: "actual", amount: 5000, description: "Invoice - Acme", reference: "INV-7", costAccountId: "line-9" });
    expect(lineOfDoc(inv, [e])).toBe("line-9");
    expect(lineOfDoc(inv, [])).toBeNull();
  });
});

describe("voiding an approved change order", () => {
  it("keeps the approval it replaces, and why", () => {
    expect(voidedApprovalNote({ decidedByName: "alice", decidedAt: "2026-11-01T15:00:00Z", decisionNote: "ok per walkdown" }, " Wrong job "))
      .toBe('Voided after it was approved by alice on 2026-11-01 ("ok per walkdown"): Wrong job');
    expect(voidedApprovalNote({ decidedByName: null, decidedAt: null, decisionNote: null }, "")).toBe("Voided after it was approved");
  });
});

describe("reopening a project", () => {
  it("completed, cancelled or archived reopen; paused resumes", () => {
    expect(["completed", "cancelled", "archived"].every((s) => canReopen(s as never))).toBe(true);
    expect(canReopen("active")).toBe(false);
    expect(isReopen("paused", "active")).toBe(false);
    expect(isReopen("cancelled", "active")).toBe(true);
  });
  it("clears what said it was over", () => {
    expect(statusChangePatch("completed", "active", undefined, "T")).toEqual({ status: "active", completed_at: null, cancelled_at: null, cancelled_reason: null });
    expect(statusChangePatch("paused", "active", undefined, "T")).toEqual({ status: "active" });
    expect(statusChangePatch("active", "cancelled", " scope moved ", "T")).toEqual({ status: "cancelled", cancelled_at: "T", cancelled_reason: "scope moved" });
    expect(statusChangePatch("active", "completed", undefined, "T")).toEqual({ status: "completed", completed_at: "T" });
  });
  it("says so in Activity", () => {
    expect(statusActivityBody("archived", "active", "work came back")).toBe("Project reopened (was archived): work came back");
    expect(statusActivityBody("active", "paused")).toBe("Project paused");
  });
});

describe("org roles that manage a project", () => {
  it("the headline role or any of the extra ones", () => {
    expect(orgRolesManage(["Engineer", "DocCtrl"])).toBe(true);
    expect(orgRolesManage(["Admin"])).toBe(true);
    expect(orgRolesManage(["Manager", "Supervisor", null, undefined])).toBe(false);
  });
});

describe("reopening a turnover item", () => {
  it("accepted goes back to review; waived back to not received unless a document is on it", () => {
    const base = { documentId: null, reviewedByName: "bob", reviewedAt: "2026-10-30T12:00:00Z", reviewNote: null };
    expect(reopenedTurnover({ ...base, status: "accepted" })).toEqual({ status: "received", note: "Reopened - was accepted by bob on 2026-10-30" });
    expect(reopenedTurnover({ ...base, status: "waived", reviewNote: "not on this job" }).status).toBe("open");
    expect(reopenedTurnover({ ...base, status: "waived", reviewNote: "not on this job" }).note).toBe('Reopened - was waived by bob on 2026-10-30 ("not on this job")');
    expect(reopenedTurnover({ ...base, status: "waived", documentId: "doc1" }).status).toBe("received");
  });
});

describe("extending an intake link", () => {
  const now = new Date(2026, 10, 3, 9, 0).getTime(); // Nov 3, 9 AM here
  it("an expired link gets the days from today", () => {
    const expired = endOfDayIso("2026-10-20");
    expect(isExpired(expired, now)).toBe(true);
    expect(dayOfIso(extendedExpiry(expired, 7, now))).toBe("2026-11-10");
  });
  it("one still running gets them on top of its end date", () => {
    const running = endOfDayIso("2026-11-05");
    expect(isExpired(running, now)).toBe(false);
    expect(dayOfIso(extendedExpiry(running, 7, now))).toBe("2026-11-12");
    expect(isExpired(null, now)).toBe(false);
  });
  it("runs to the end of its last day", () => {
    const end = new Date(endOfDayIso("2026-11-12"));
    expect([end.getHours(), end.getMinutes()]).toEqual([23, 59]);
  });
});

describe("a shift's incidents and notes, changed after", () => {
  const rec: ShiftRecord = {
    incidents: { none: null, items: [{ id: "i1", at: 1000, kind: "Near miss", text: "dropped wrench", by: "sam" }] },
    notes: [
      { id: "n1", at: 2000, text: "pump seal leaking", followUp: true, by: "sam", cleared: { at: 3000, by: "lee" } },
      { id: "n2", at: 2500, text: "crane on site 7 AM", by: "sam" },
    ],
  };
  it("an edit keeps the id and who wrote it, and stamps the edit", () => {
    const r = editIncident(rec, "i1", { at: 1100, kind: "First aid", text: "cut hand, band-aid" }, "lee", 9);
    expect(r.incidents?.items?.[0]).toEqual({ id: "i1", at: 1100, kind: "First aid", text: "cut hand, band-aid", by: "sam", edited: { at: 9, by: "lee" } });
    const n = editNote(rec, "n2", { at: 2600, text: "crane on site 8 AM", followUp: false }, "lee", 9);
    expect(n.notes?.find((x) => x.id === "n2")).toMatchObject({ text: "crane on site 8 AM", by: "sam", edited: { at: 9, by: "lee" } });
    expect(n.notes?.find((x) => x.id === "n1")).toEqual(rec.notes?.[0]);
  });
  it("Undo puts a removed one back as it was, once", () => {
    const gone: ShiftRecord = { ...rec, incidents: { none: null, items: [] }, notes: [rec.notes![1]] };
    expect(restoreIncident(gone, rec.incidents!.items![0]).incidents?.items).toEqual(rec.incidents?.items);
    expect(restoreIncident(rec, rec.incidents!.items![0])).toBe(rec);
    expect(restoreNote(gone, rec.notes![0]).notes?.map((x) => x.id)).toEqual(["n2", "n1"]);
    expect(restoreNote(rec, rec.notes![0])).toBe(rec);
  });
  it("Undo clear opens a follow-up again", () => {
    expect(unclearNote(rec, "n1").notes?.[0].cleared).toBeNull();
    expect(unclearNote(rec, "n1").notes?.[0].followUp).toBe(true);
  });
});

describe("undoing a progress reset", () => {
  it("puts back only the status notes the reset removed", () => {
    const before = [
      { id: "s1", kind: "status" }, { id: "s2", kind: "status" }, { id: "f1", kind: "note" },
    ];
    expect(statusNotesToRestore(before, new Set(["f1", "s2"])).map((n) => n.id)).toEqual(["s1"]);
  });
});
