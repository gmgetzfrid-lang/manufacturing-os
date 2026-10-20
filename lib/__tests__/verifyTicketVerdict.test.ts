// drafting-flow Round G, DF-P10 DELIVERABLE-PRINT (public-surfaces PKG-5 folded in).
//
//   PHYS-2   a printed ticket file's QR and footer carry the FILE's revision,
//            never the ticket's live deliverable_rev; no recorded revision →
//            no ?r= and "cannot confirm".
//   PHYS-9   one control state drives both marks; no "CONTROLLED COPY" caller
//            literal; the record names the watermark actually printed.
//   EDGE-2   CANCELED, and a request that ended on a review label with no issue
//            anywhere, answer "withdrawn" — never current; a closed ticket with
//            no label → "cannot confirm" whatever its history says (the
//            integrator's ruling), as does a closed review label with a
//            set-aside issue line; one force-closed on a review label after
//            a proven issue keeps the ladder; reject_final rework → in review; a
//            reopened legacy row (issued label at a review status) → in
//            review; archived → "cannot confirm".
//   SM-5 / PHYS-2 trust boundary: an "issued Rev N" history line above
//            revision_count + 1, or above the bound the row's own label
//            proves (N − 1 under N<letters>, N under N, revision_count with
//            no label), never counts.
//   PHYS-2 / EDGE-2  a deliverable of a withdrawn request is stamped REQUEST
//            WITHDRAWN, confirmed first.
//   AUTHZ-12 the public answer carries revision-status facts only (no workflow
//            status, no unit, no activity time); scans stay logged.
//   EVID-5 / PHYS-8  the copy's record is awaited and checked, written in the
//            columns download_audits has, with the file named on an audit row.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { ticketVerdict, ticketVerifyUrl, lastIssuedFromHistory, ticketFactsState, ticketRevInReview, issueBoundFromLabel, issueOnRecord } from "@/lib/verifyTicketVerdict";
import { computeTransition } from "@/lib/ticketTransitions";
import type { Ticket, TicketAttachment, TicketHistoryEntry } from "@/types/schema";
import { ticketCopyPlan, ticketCopyControlState, ticketCopySource, recordTicketCopy, isMissingSourceColumn, ticketCopyStanding, type TicketCopyLiveFacts } from "@/lib/ticketDeliverableCopy";
import { stampWatermark, withoutScanInstruction } from "@/lib/stamping";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ORIGIN = "https://plant.example.com";
const T = "77777777-7777-7777-7777-777777777777";
const issued = (n: number) => ({ action: `Approve (Issue for Construction) — issued Rev ${n}` });

// ─── the verdict (pure) ─────────────────────────────────────────────────────
describe("EDGE-2 — the verdict reads the request's state, not the label alone", () => {
  it("CANCELED is never current — {status: CANCELED, deliverable_rev: 1, printed 1} → withdrawn", () => {
    const v = ticketVerdict({ status: "CANCELED", deliverable_rev: "1", history: [issued(1)] }, "1");
    expect(v.verdict).toBe("withdrawn");
    expect(v.verdict).not.toBe("current");
    for (const printed of ["", "1", "1A", "2", "0"]) {
      expect(ticketVerdict({ status: "CANCELED", deliverable_rev: "1", history: [] }, printed).verdict, printed).toBe("withdrawn");
      expect(ticketVerdict({ status: "CANCELED", deliverable_rev: null, history: [] }, printed).verdict, printed).toBe("withdrawn");
    }
  });
  it("a request that ENDED on a review label with no issue anywhere (row or history) is withdrawn", () => {
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: "1A", history: [] }, "1A").verdict).toBe("withdrawn");
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: "1A", history: [] }, "1").verdict).toBe("withdrawn");
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: "2B", history: [{ action: "Submitted for review — Rev 1A" }, { action: "Reject" }, { action: "Submitted for review — Rev 2B" }] }, "1")).toMatchObject({ verdict: "withdrawn", latestIssuedRev: null });
    // …but a QR naming no revision stays "cannot confirm" ahead of every terminal branch except CANCELED
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: "1A", history: [] }, "").verdict).toBe("unknown");
  });
  it("no false 'withdrawn': a CLOSED ticket with no label and no issue line (closed before 20260827, a closed RFI) is 'cannot confirm'", () => {
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: null, history: [] }, "1").verdict).toBe("unknown");
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: null, history: null }, "1").verdict).toBe("unknown");
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: null, history: [{ action: "Close RFI" }] }, "1").verdict).toBe("unknown");
  });
  it("a CLOSED ticket with NO label answers 'cannot confirm' whatever its history says (the integrator's ruling, DEC-90 fail-safe; base behaviour)", () => {
    // issued Rev 2, reopened, closed again by Force Close (Admin): the label is null and a history line is the only evidence —
    // which any member may append — so the scan cannot confirm, never green and never withdrawn
    const reclosed = { status: "CLOSED", deliverable_rev: null, history: [issued(1), issued(2), { action: "Reopen Ticket" }, { action: "Force Close (Admin)" }], revision_count: 2 };
    for (const printed of ["2", "1", "3A", ""]) {
      expect(ticketVerdict(reclosed, printed), printed).toMatchObject({ verdict: "unknown", latestIssuedRev: null, inReview: false });
    }
    expect(ticketFactsState(ticketVerdict(reclosed, "2"))).toEqual({ label: "Revision status", value: "Cannot confirm" });
    // the copy follows: no standing from the history on a closed no-label row — never SUPERSEDED, never withdrawn
    const liveReclosed: TicketCopyLiveFacts = { status: "CLOSED", deliverableRev: null, history: reclosed.history, revisionCount: 2 };
    expect(ticketCopyStanding("1", liveReclosed)).toBeNull();
    expect(ticketCopyStanding("2", liveReclosed)).toBeNull();
    expect(ticketCopyPlan({ file: { type: "Final", rev: "1" }, ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: liveReclosed }).footerNotice).not.toMatch(/SUPERSEDED|WITHDRAWN/);
    // the reviewer's probe: Rev 1 issued, reopened, force-closed, reopened, force-closed, a member appends "issued Rev 2"
    // (revision_count 2) — the real Rev 1 is never read superseded, the forged Rev 2 never current
    const probe = { status: "CLOSED", deliverable_rev: null, revision_count: 2,
      history: [issued(1), { action: "Reopen Ticket" }, { action: "Force Close (Admin)" }, { action: "Reopen Ticket" }, { action: "Force Close (Admin)" }, { action: "note — issued Rev 2", user: "member@x.com" }] };
    expect(ticketVerdict(probe, "1").verdict).toBe("unknown");
    expect(ticketVerdict(probe, "2").verdict).toBe("unknown");
    expect(ticketCopyStanding("1", { status: "CLOSED", deliverableRev: null, history: probe.history, revisionCount: 2 })).toBeNull();
  });
  it("no false 'withdrawn': a CLOSED ticket force-closed on a review label after a proven issue keeps the ladder", () => {
    // Rev 1 issued, force-closed at PENDING_REVIEW on 2A: Rev 1 is the issue in force
    const forced = { status: "CLOSED", deliverable_rev: "2A", history: [issued(1), { action: "Submitted for review — Rev 2A" }] };
    expect(ticketVerdict(forced, "1")).toMatchObject({ verdict: "current", latestIssuedRev: "1" });
    expect(ticketVerdict(forced, "2A").verdict).toBe("draft_copy");
  });
  it("reject_final → REVISION_REQ keeps the issued label: the last issue reads revision_in_progress, never green; older superseded", () => {
    const rejected = { status: "REVISION_REQ", deliverable_rev: "1", history: [issued(1), { action: "Reject Final" }] };
    expect(ticketVerdict(rejected, "1")).toMatchObject({ verdict: "revision_in_progress", latestIssuedRev: "1", inReview: true });
    const rejected2 = { status: "REVISION_REQ", deliverable_rev: "2", history: [issued(1), issued(2)] };
    expect(ticketVerdict(rejected2, "2").verdict).toBe("revision_in_progress");
    expect(ticketVerdict(rejected2, "1").verdict).toBe("superseded");
    expect(ticketVerdict({ status: "FINAL_DRAFT", deliverable_rev: "1", history: [issued(1)] }, "1").verdict).toBe("current");
  });
  it("LEAK-7 (a): a ticket reopened before Round E keeps its issued label while a new revision is reviewed — revision_in_progress, never current", () => {
    for (const status of ["PENDING_REVIEW", "PENDING_FINAL_APPROVAL"]) {
      const legacy = { status, deliverable_rev: "1", history: [{ action: "Approve — issued Rev 1" }, { action: "Reopen Ticket" }] };
      expect(ticketVerdict(legacy, "1")).toMatchObject({ verdict: "revision_in_progress", latestIssuedRev: "1", inReview: true });
      expect(ticketFactsState(ticketVerdict(legacy, "1"))).toEqual({ label: "In review now", value: "New revision" });
      // the print / download footer and confirmation agree with the scan
      expect(ticketCopyStanding("1", { status, deliverableRev: "1", history: legacy.history })).toEqual({ kind: "in_progress" });
    }
    // the statuses that leave an issued package in force still read current
    for (const status of ["PENDING_IFC", "FINAL_DRAFT", "CLOSED"]) {
      expect(ticketVerdict({ status, deliverable_rev: "1", history: [issued(1)] }, "1").verdict).toBe("current");
    }
  });
  it("trust boundary: a history 'issued Rev N' line above revision_count + 1 is a member's own append, never an issue", () => {
    const forged = { action: "note — issued Rev 9", user: "member@x.com" };
    expect(lastIssuedFromHistory([issued(1), forged], 0)).toBe("1");
    expect(lastIssuedFromHistory([issued(1), forged], 8)).toBe("9");
    expect(lastIssuedFromHistory([forged], 0)).toBeNull();
    // the issued Final in force stays current — never "superseded by Rev 9"
    expect(ticketVerdict({ status: "FINAL_DRAFT", deliverable_rev: "1", history: [issued(1), forged], revision_count: 0 }, "1").verdict).toBe("current");
    expect(ticketCopyStanding("1", { status: "FINAL_DRAFT", deliverableRev: "1", history: [issued(1), forged], revisionCount: 0 })).toBeNull();
    // a closed ticket with only a forged line has no revision record: cannot confirm, never "current" for Rev 9
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: null, history: [forged], revision_count: 0 }, "9").verdict).toBe("unknown");
    // a reopened ticket's forged line neither invents an issue nor supersedes the real one
    const reopened = { status: "PENDING_REVIEW", deliverable_rev: null, history: [issued(1), { action: "Reopen Ticket" }, forged], revision_count: 1 };
    expect(ticketVerdict(reopened, "1")).toMatchObject({ verdict: "revision_in_progress", latestIssuedRev: "1" });
    expect(ticketCopyStanding("1", { status: "PENDING_REVIEW", deliverableRev: null, history: reopened.history, revisionCount: 1 })).toEqual({ kind: "in_progress" });
    // a review label's "last issue" is read under the same cap
    expect(ticketVerdict({ status: "PENDING_REVIEW", deliverable_rev: "2A", history: [issued(1), forged], revision_count: 1 }, "1").latestIssuedRev).toBe("1");
  });
  it("trust boundary: the row's own label bounds the history — a review label N<letters> proves issue N never happened", () => {
    const forged = (n: number) => ({ action: `note — issued Rev ${n}`, user: "member@x.com" });
    expect([issueBoundFromLabel("2A"), issueBoundFromLabel("1B"), issueBoundFromLabel("3"), issueBoundFromLabel(null), issueBoundFromLabel("x")]).toEqual([1, 0, 3, null, null]);
    expect(issueOnRecord([issued(1), forged(2)], 1, "2A")).toBe("1");
    expect(issueOnRecord([forged(1)], 0, "1A")).toBeNull();
    expect(issueOnRecord([issued(1), forged(2)], 1, null)).toBe("1"); // no label: bounded by revision_count itself
    expect(issueOnRecord([issued(2), forged(3)], 2, "2")).toBe("2");
    // probed row 1: 2A in review, real Rev 1, a member appends "issued Rev 2" (within revision_count + 1)
    const review2A = { status: "PENDING_REVIEW", deliverable_rev: "2A", history: [issued(1), forged(2)], revision_count: 1 };
    expect(ticketVerdict(review2A, "1")).toMatchObject({ verdict: "revision_in_progress", latestIssuedRev: "1", inReview: true });
    expect(ticketVerdict(review2A, "1").verdict).not.toBe("superseded");
    expect(ticketVerdict(review2A, "2").verdict).toBe("unknown"); // never a Rev 2 the label proves was not issued
    // the copy footer agrees: the real latest issue is never stamped "SUPERSEDED by Rev 2"
    const live2A: TicketCopyLiveFacts = { status: "PENDING_REVIEW", deliverableRev: "2A", history: review2A.history, revisionCount: 1 };
    expect(ticketCopyStanding("1", live2A)).toEqual({ kind: "in_progress" });
    expect(ticketCopyPlan({ file: { type: "Final", rev: "1" }, ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: live2A }).footerNotice).not.toMatch(/SUPERSEDED/);
    // probed row 2: CLOSED on 1A plus an "issued Rev 1" line the label sets aside — a forgery, or a real legacy issue
    // (below): the row cannot tell which, so "cannot confirm" (never red withdrawn, never green), naming no issue
    const closed1A = { status: "CLOSED", deliverable_rev: "1A", history: [forged(1)], revision_count: 0 };
    for (const printed of ["1", "1A"]) {
      expect(ticketVerdict(closed1A, printed), printed).toMatchObject({ verdict: "unknown", latestIssuedRev: null });
    }
    expect(ticketFactsState(ticketVerdict(closed1A, "1"))).toEqual({ label: "Revision status", value: "Cannot confirm" });
    expect(ticketCopyStanding("1", { status: "CLOSED", deliverableRev: "1A", history: closed1A.history, revisionCount: 0 })).toBeNull();
    // a CANCELED row names no issue its label rules out
    expect(ticketVerdict({ status: "CANCELED", deliverable_rev: "1A", history: [forged(1)], revision_count: 0 }, "1").latestIssuedRev).toBeNull();
    // an issued label N bounds the copy standing at N: a forged "issued Rev 2" never supersedes the Rev 1 in force
    expect(ticketCopyStanding("1", { status: "FINAL_DRAFT", deliverableRev: "1", history: [issued(1), forged(2)], revisionCount: 1 })).toBeNull();
    // a live review label with a set-aside issue line (forged, or a pre-Round-E collision): a print of it is "cannot confirm", never "review draft"
    expect(ticketVerdict({ status: "PENDING_REVIEW", deliverable_rev: "1B", history: [issued(1)], revision_count: 0 }, "1")).toMatchObject({ verdict: "unknown", latestIssuedRev: null });
  });
  it("trust boundary: a row with NO label bounds the history at revision_count — a reopen nulls the label AND bumps the count after a real issue", () => {
    const forged = (n: number) => ({ action: `x — issued Rev ${n}`, user: "member@x.com" });
    expect([issueBoundFromLabel(null, 0), issueBoundFromLabel(null, 2), issueBoundFromLabel(undefined, 1), issueBoundFromLabel("x", 1), issueBoundFromLabel("2A", 5)]).toEqual([0, 2, 1, 1, 1]);
    // probed row: a CLOSED RFI (no label, revision_count 0) that never issued anything; a member appends "issued Rev 1"
    const closedRfi = { status: "CLOSED", deliverable_rev: null, history: [forged(1)], revision_count: 0 };
    expect(issueOnRecord(closedRfi.history, 0, null)).toBeNull();
    expect(ticketVerdict(closedRfi, "1")).toMatchObject({ verdict: "unknown", latestIssuedRev: null }); // base's "cannot confirm", never green
    expect(ticketFactsState(ticketVerdict(closedRfi, "1"))).toEqual({ label: "Revision status", value: "Cannot confirm" });
    // live, the same forged line never makes the row read "reopened"
    expect(ticketVerdict({ ...closedRfi, status: "PENDING_ENG_TEAM" }, "1")).toMatchObject({ verdict: "unknown", latestIssuedRev: null, inReview: false });
    // probed row: reopened after a REAL Rev 1 (revision_count 1, no label); a member appends "issued Rev 2" (within revision_count + 1)
    const reopened1 = { status: "PENDING_REVIEW", deliverable_rev: null, history: [issued(1), { action: "Reopen Ticket" }, forged(2)], revision_count: 1 };
    expect(ticketVerdict(reopened1, "1")).toMatchObject({ verdict: "revision_in_progress", latestIssuedRev: "1", inReview: true });
    expect(ticketVerdict(reopened1, "2").verdict).toBe("unknown"); // never a Rev 2 the count proves was not issued
    const live1: TicketCopyLiveFacts = { status: reopened1.status, deliverableRev: null, history: reopened1.history, revisionCount: 1 };
    expect(ticketCopyStanding("1", live1)).toEqual({ kind: "in_progress" });
    expect(ticketCopyPlan({ file: { type: "Final", rev: "1" }, ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: live1 }).footerNotice).not.toMatch(/SUPERSEDED/);
    // …and closed again with no label: "cannot confirm" (the integrator's ruling) — never "superseded by Rev 2", never green
    expect(ticketVerdict({ ...reopened1, status: "CLOSED" }, "1")).toMatchObject({ verdict: "unknown", latestIssuedRev: null });
    expect(ticketCopyStanding("1", { ...live1, status: "CLOSED" })).toBeNull();
  });
  it("the legitimate reopen walks are unchanged under the revision_count bound (driven through computeTransition)", () => {
    const actor = { uid: "a-1", email: "a@x.io", role: "Admin" };
    const NOW = "2026-10-13T12:00:00.000Z";
    type Row = { status: string; deliverable_rev: string | null; revision_count: number; history: TicketHistoryEntry[] };
    const toTicket = (r: Row) => ({ id: T, orgId: "o", ticketId: "KE-1", title: "x", unit: "U", requestType: "ISO", requesterId: "u", requesterRole: "Viewer",
      attachments: [], comments: [], unreadBy: [], watchers: [], createdAt: NOW, assignedDrafterId: "d",
      status: r.status, deliverableRev: r.deliverable_rev, revisionCount: r.revision_count, draftIteration: 1, history: r.history }) as unknown as Ticket;
    const step = (r: Row, actionType: string, actionLabel: string): Row => {
      const t = computeTransition(toTicket(r), { actionType, actionLabel, actor, now: NOW } as Parameters<typeof computeTransition>[1]);
      const u = t.updates as Record<string, unknown>;
      return {
        status: t.newStatus ?? r.status,
        deliverable_rev: "deliverable_rev" in u ? (u.deliverable_rev as string | null) : r.deliverable_rev,
        revision_count: "revision_count" in u ? (u.revision_count as number) : r.revision_count,
        history: [...r.history, t.historyEntry as TicketHistoryEntry],
      };
    };
    // issue 2 (2A approved at revision_count 1) → closed → reopened: revision_count 2, no label
    let r: Row = step({ status: "PENDING_REVIEW", deliverable_rev: "2A", revision_count: 1, history: [{ action: "Approve — issued Rev 1" } as TicketHistoryEntry] }, "approve_draft_ifc", "Approve (Issue for Construction)");
    expect(r.deliverable_rev).toBe("2");
    r = step({ ...r, status: "CLOSED" }, "reopen_ticket", "Reopen Ticket");
    expect([r.deliverable_rev, r.revision_count]).toEqual([null, 2]);
    expect(ticketVerdict(r, "2")).toMatchObject({ verdict: "revision_in_progress", latestIssuedRev: "2" });
    expect(ticketVerdict(r, "1").verdict).toBe("superseded");
    // closed again with no label: "cannot confirm" (the integrator's ruling), never green
    expect(ticketVerdict({ ...r, status: "CLOSED" }, "2")).toMatchObject({ verdict: "unknown", latestIssuedRev: null });
    // an SM-5 re-cycle (a pre-Round-E reopened row: revision_count 0, label 1, Rev 1 already issued) → Rev 2 at revision_count 1 → reopened
    let legacy: Row = step({ status: "PENDING_REVIEW", deliverable_rev: "1", revision_count: 0, history: [{ action: "Approve — issued Rev 1" } as TicketHistoryEntry, { action: "Reopen Ticket" } as TicketHistoryEntry] }, "approve_draft_ifc", "Approve (Issue for Construction)");
    expect([legacy.deliverable_rev, legacy.revision_count]).toEqual(["2", 1]);
    legacy = step({ ...legacy, status: "CLOSED" }, "reopen_ticket", "Reopen Ticket");
    expect([legacy.deliverable_rev, legacy.revision_count]).toEqual([null, 2]);
    expect(ticketVerdict(legacy, "2")).toMatchObject({ verdict: "revision_in_progress", latestIssuedRev: "2" });
    expect(ticketVerdict(legacy, "1").verdict).toBe("superseded");
  });
  it("no phantom issue: a review label after a reject before any issue reports no latest issue when the history shows none", () => {
    // 1A rejected (cycle bumped, nothing issued) → resubmitted as 2A: cycle − 1 = 1 was never issued
    const phantom = { status: "PENDING_REVIEW", deliverable_rev: "2A", history: [{ action: "Submitted for review — Rev 1A" }, { action: "Reject" }, { action: "Submitted for review — Rev 2A" }] };
    expect(ticketVerdict(phantom, "1")).toMatchObject({ verdict: "draft_copy", latestIssuedRev: null, inReview: true });
    // Rev 1 issued, reject_final, 2A rejected, now 3A: the latest issue is 1, not a phantom 2
    const skip = { status: "PENDING_REVIEW", deliverable_rev: "3A", history: [issued(1), { action: "Reject Final" }, { action: "Submitted for review — Rev 2A" }, { action: "Reject" }] };
    expect(ticketVerdict(skip, "1")).toMatchObject({ verdict: "revision_in_progress", latestIssuedRev: "1" });
    // a row with no history at all keeps the cycle inference
    expect(ticketVerdict({ status: "PENDING_REVIEW", deliverable_rev: "3A", history: [] }, "2").latestIssuedRev).toBe("2");
  });
  it("the facts card's right cell carries the coarse state — never 'Latest issue' on a withdrawn or unconfirmable copy", () => {
    const canceled = ticketVerdict({ status: "CANCELED", deliverable_rev: "1", history: [issued(1)] }, "1");
    expect(ticketFactsState(canceled)).toEqual({ label: "Request", value: "Withdrawn" });
    expect(ticketFactsState(ticketVerdict({ status: "CLOSED", deliverable_rev: null, history: [] }, "1"))).toEqual({ label: "Revision status", value: "Cannot confirm" });
    expect(ticketFactsState(ticketVerdict({ status: "PENDING_IFC", deliverable_rev: "2", history: [] }, "2"))).toEqual({ label: "Latest issue", value: "Rev 2" });
    expect(ticketFactsState(ticketVerdict({ status: "CLOSED", deliverable_rev: null, history: [issued(2)] }, "2"))).toEqual({ label: "Revision status", value: "Cannot confirm" });
    expect(ticketFactsState(ticketVerdict({ status: "CLOSED", deliverable_rev: "2", history: [issued(2)] }, "2"))).toEqual({ label: "Latest issue", value: "Rev 2" });
    expect(ticketFactsState(ticketVerdict({ status: "PENDING_REVIEW", deliverable_rev: "3A", history: [issued(2)] }, "2"))).toEqual({ label: "In review now", value: "Rev 3A" });
    // reject_final: the row still carries the issued "1" — the card must not say "Rev 1 in review"
    const rejected = ticketVerdict({ status: "REVISION_REQ", deliverable_rev: "1", history: [issued(1)] }, "1");
    expect(ticketFactsState(rejected)).toEqual({ label: "In review now", value: "New revision" });
    expect(ticketRevInReview(rejected)).toBeNull();
  });
  it("a request CLOSED on its issue keeps the ordinary ladder: current / superseded / review draft", () => {
    const row = { status: "CLOSED", deliverable_rev: "2", history: [issued(1), issued(2)] };
    expect(ticketVerdict(row, "2").verdict).toBe("current");
    expect(ticketVerdict(row, "1").verdict).toBe("superseded");
    expect(ticketVerdict(row, "2A").verdict).toBe("draft_copy");
  });
  it("live statuses are unchanged (WF-21 / DEC-15 kept): reopened → revision_in_progress, older → superseded; no rev on the QR → unknown", () => {
    const reopened = { status: "PENDING_REVIEW", deliverable_rev: null, history: [issued(2), { action: "Reopen Ticket" }] };
    expect(ticketVerdict(reopened, "2")).toMatchObject({ verdict: "revision_in_progress", latestIssuedRev: "2", inReview: true });
    expect(ticketVerdict(reopened, "1").verdict).toBe("superseded");
    expect(ticketVerdict({ status: "PENDING_IFC", deliverable_rev: "2", history: [] }, "2").verdict).toBe("current");
    expect(ticketVerdict({ status: "PENDING_REVIEW", deliverable_rev: "3A", history: [] }, "2").verdict).toBe("revision_in_progress");
    expect(ticketVerdict({ status: "PENDING_IFC", deliverable_rev: "2", history: [] }, "").verdict).toBe("unknown");
    expect(ticketVerdict({ status: "REVISION_REQ", deliverable_rev: null, history: [{ action: "Return with Questions" }] }, "1").verdict).toBe("unknown");
  });
  it("an archived ticket answers 'cannot confirm' with every revision fact withheld", () => {
    const v = ticketVerdict({ status: "CLOSED", deliverable_rev: "2", history: [], archived_at: "2026-09-01T00:00:00Z" }, "2");
    expect(v).toEqual({ verdict: "unknown", currentRev: null, latestIssuedRev: null, inReview: false });
  });
  it("lastIssuedFromHistory reads the highest issue line only", () => {
    expect(lastIssuedFromHistory([issued(1), { action: "x" }, issued(3), issued(2)])).toBe("3");
    expect(lastIssuedFromHistory(null)).toBeNull();
  });
});

// ─── fix pass 6: regression first, then the integrator's rulings ────────────
describe("fix pass 6 — a legitimately issued, current deliverable still scans current; the closed-row rulings fail safe", () => {
  const actor = { uid: "a-1", email: "a@x.io", role: "Admin" };
  const NOW = "2026-10-13T12:00:00.000Z";
  type Row = { status: string; deliverable_rev: string | null; revision_count: number; draft_iteration: number; history: TicketHistoryEntry[] };
  const toTicket = (r: Row) => ({ id: T, orgId: "o", ticketId: "KE-1", title: "x", unit: "U", requestType: "ISO", requesterId: "u", requesterRole: "Viewer",
    attachments: [], comments: [], unreadBy: [], watchers: [], createdAt: NOW, assignedDrafterId: "d",
    status: r.status, deliverableRev: r.deliverable_rev, revisionCount: r.revision_count, draftIteration: r.draft_iteration, history: r.history }) as unknown as Ticket;
  const step = (r: Row, actionType: string, actionLabel: string): Row => {
    const t = computeTransition(toTicket(r), { actionType, actionLabel, actor, now: NOW } as Parameters<typeof computeTransition>[1]);
    const u = t.updates as Record<string, unknown>;
    return {
      status: t.newStatus ?? r.status,
      deliverable_rev: "deliverable_rev" in u ? (u.deliverable_rev as string | null) : r.deliverable_rev,
      revision_count: "revision_count" in u ? (u.revision_count as number) : r.revision_count,
      draft_iteration: "draft_iteration" in u ? (u.draft_iteration as number) : r.draft_iteration,
      history: [...r.history, t.historyEntry as TicketHistoryEntry],
    };
  };
  const liveOf = (r: Row): TicketCopyLiveFacts => ({ status: r.status, deliverableRev: r.deliverable_rev, history: r.history, revisionCount: r.revision_count });
  const expectCurrentAndPrintable = (r: Row, rev: string) => {
    expect(ticketVerdict(r, rev), `${r.status} Rev ${rev}`).toMatchObject({ verdict: "current", latestIssuedRev: rev, inReview: false });
    expect(ticketFactsState(ticketVerdict(r, rev))).toEqual({ label: "Latest issue", value: `Rev ${rev}` });
    for (const channel of ["print", "download"] as const) {
      const plan = ticketCopyPlan({ file: { type: "Final", rev }, ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel, live: liveOf(r) });
      // never blocked, never a warning: no standing, no confirmation, the QR names the file's own rev
      expect([plan.standing, plan.confirmMessage]).toEqual([null, null]);
      expect(plan.verifyUrl).toBe(`${ORIGIN}/verify-ticket/${T}?r=${rev}`);
      expect(plan.footerNotice).toBe(`This file is KE-1 deliverable Rev ${rev} — not a controlled document revision — scan the QR to confirm it is still the latest.`);
    }
  };

  it("REGRESSION: Rev 1 and then Rev 2, each issued through the workflow, scan current at PENDING_IFC, FINAL_DRAFT and CLOSED-with-label", () => {
    let r: Row = { status: "DRAFTING", deliverable_rev: null, revision_count: 0, draft_iteration: 0, history: [] };
    r = step(r, "submit_draft", "Submit for Review");
    expect(r.deliverable_rev).toBe("1A");
    r = step(r, "approve_draft_ifc", "Approve (Issue for Construction)");
    expect([r.status, r.deliverable_rev]).toEqual(["PENDING_IFC", "1"]);
    expectCurrentAndPrintable(r, "1");
    r = step(r, "submit_final", "Submit Final");
    expect(r.status).toBe("FINAL_DRAFT");
    expectCurrentAndPrintable(r, "1");
    const closed1 = step(r, "close_ticket", "Close");
    expect([closed1.status, closed1.deliverable_rev]).toEqual(["CLOSED", "1"]);
    expectCurrentAndPrintable(closed1, "1");
    // a second revision: reject_final → 2A → approved → final → closed; Rev 2 current everywhere, Rev 1 superseded
    r = step(r, "reject_final", "Reject Final");
    r = step({ ...r, status: "DRAFTING" }, "submit_draft", "Submit for Review");
    expect(r.deliverable_rev).toBe("2A");
    r = step(r, "approve_draft_ifc", "Approve (Issue for Construction)");
    expect([r.status, r.deliverable_rev]).toEqual(["PENDING_IFC", "2"]);
    expectCurrentAndPrintable(r, "2");
    expect(ticketVerdict(r, "1").verdict).toBe("superseded");
    r = step(r, "submit_final", "Submit Final");
    expectCurrentAndPrintable(r, "2");
    r = step(r, "close_ticket", "Close");
    expect([r.status, r.deliverable_rev]).toEqual(["CLOSED", "2"]);
    expectCurrentAndPrintable(r, "2");
    expect(ticketVerdict(r, "1").verdict).toBe("superseded");
    // the superseded copy still prints — confirmed and stamped, never blocked
    const old = ticketCopyPlan({ file: { type: "Final", rev: "1" }, ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: liveOf(r) });
    expect(old.standing).toEqual({ kind: "superseded", by: "2" });
    expect(old.confirmMessage).toBe("This file is Rev 1, but KE-1 has since issued Rev 2. The copy will be stamped SUPERSEDED. Print it anyway?");
  });
  it("ruling 1: the same issued package, reopened and force-closed with no label, answers 'cannot confirm' (base behaviour) — never green", () => {
    let r: Row = { status: "PENDING_REVIEW", deliverable_rev: "1A", revision_count: 0, draft_iteration: 1, history: [] };
    r = step(r, "approve_draft_ifc", "Approve (Issue for Construction)");
    r = step({ ...r, status: "CLOSED" }, "reopen_ticket", "Reopen Ticket");
    expect([r.deliverable_rev, r.revision_count]).toEqual([null, 1]);
    const closed = step(r, "close_ticket", "Force Close (Admin)");
    expect([closed.status, closed.deliverable_rev]).toEqual(["CLOSED", null]);
    expect(ticketVerdict(closed, "1")).toMatchObject({ verdict: "unknown", latestIssuedRev: null });
    expect(ticketCopyStanding("1", liveOf(closed))).toBeNull();
    // a never-issued RFI closed with no label, a member line appended: cannot confirm too
    const rfi = { status: "CLOSED", deliverable_rev: null, revision_count: 1, history: [{ action: "Return with Questions" }, { action: "Close RFI" }, { action: "note — issued Rev 1", user: "member@x.com" }] };
    expect(ticketVerdict(rfi, "1")).toMatchObject({ verdict: "unknown", latestIssuedRev: null });
  });
  it("ruling 2: a real legacy Rev 1 (reopened before Round E, label 1 kept, 1B submitted, force-closed at PENDING_REVIEW) answers 'cannot confirm', never red withdrawn", () => {
    let legacy: Row = { status: "DRAFTING", deliverable_rev: "1", revision_count: 0, draft_iteration: 1,
      history: [{ action: "Approve (Issue for Construction) — issued Rev 1" } as TicketHistoryEntry, { action: "Reopen Ticket" } as TicketHistoryEntry] };
    legacy = step(legacy, "submit_draft", "Submit for Review");
    expect([legacy.status, legacy.deliverable_rev]).toEqual(["PENDING_REVIEW", "1B"]);
    legacy = step(legacy, "close_ticket", "Force Close (Admin)");
    expect([legacy.status, legacy.deliverable_rev]).toEqual(["CLOSED", "1B"]);
    for (const printed of ["1", "1B"]) {
      expect(ticketVerdict(legacy, printed), printed).toMatchObject({ verdict: "unknown", latestIssuedRev: null });
      expect(ticketVerdict(legacy, printed).verdict).not.toBe("withdrawn");
    }
    expect(ticketFactsState(ticketVerdict(legacy, "1"))).toEqual({ label: "Revision status", value: "Cannot confirm" });
    expect(ticketCopyStanding("1", liveOf(legacy))).toBeNull();
    const plan = ticketCopyPlan({ file: { type: "Final", rev: "1" }, ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: liveOf(legacy) });
    expect(plan.footerNotice).not.toMatch(/WITHDRAWN|SUPERSEDED/);
    expect(plan.confirmMessage).toBeNull();
    // withdrawn stays for a request that issued nothing anywhere (row or history)
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: "1B", revision_count: 0, history: [{ action: "Submitted for review — Rev 1A" }] }, "1").verdict).toBe("withdrawn");
  });
  it("issue 3 (recorded, not closed by code): under a review label a member-forged line at or below the label's bound still supersedes a real issue — owned by DF-P12's guard limb", () => {
    const row = { status: "PENDING_REVIEW", deliverable_rev: "3A", revision_count: 2,
      history: [issued(1), { action: "Reject Final" }, { action: "Submitted for review — Rev 2A" }, { action: "Reject" }, { action: "Submitted for review — Rev 3A" }, { action: "note — issued Rev 2", user: "member@x.com" }] };
    // pinned so the records stay honest (DEC-29): this is what the code does today
    expect(ticketVerdict(row, "1").verdict).toBe("superseded");
    expect(ticketCopyStanding("1", { status: row.status, deliverableRev: row.deliverable_rev, history: row.history, revisionCount: 2 })).toEqual({ kind: "superseded", by: "2" });
  });
  it("no ?r= on the QR: only CANCELED answers withdrawn; a CLOSED request answers 'cannot confirm'", () => {
    expect(ticketVerdict({ status: "CANCELED", deliverable_rev: "1A", history: [] }, "").verdict).toBe("withdrawn");
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: "1A", history: [] }, "").verdict).toBe("unknown");
    expect(ticketVerdict({ status: "CLOSED", deliverable_rev: "1A", history: [] }, "1").verdict).toBe("withdrawn");
  });
});

// ─── the copy (PHYS-2 / PHYS-9 / HAND-3) ────────────────────────────────────
describe("PHYS-2 — the QR and footer carry the printed FILE's revision", () => {
  const final = (rev?: string | null): Pick<TicketAttachment, "type" | "rev"> => (rev === undefined ? { type: "Final" } : { type: "Final", rev });

  it("a historical Final opened on a ticket at a later rev: the verifyUrl names the FILE's rev, not the ticket's current rev", () => {
    // Ticket now at Rev 2; the PM opens the Rev 1 Final still listed under Final files.
    const ticketCurrentRev = "2";
    const plan = ticketCopyPlan({ file: final("1"), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print" });
    expect(plan.verifyUrl).toBe(`${ORIGIN}/verify-ticket/${T}?r=1`);
    expect(plan.verifyUrl).not.toContain(`r=${ticketCurrentRev}`);
    expect(plan.footerNotice).toContain("This file is KE-1 deliverable Rev 1");
    expect(plan.footerNotice).not.toContain("at time of"); // never "the deliverable at time of printing"
    expect(plan.footerNotice).not.toContain(`Rev ${ticketCurrentRev}`);
    // …and the scan of that paper answers superseded, never current.
    expect(ticketVerdict({ status: "FINAL_DRAFT", deliverable_rev: ticketCurrentRev, history: [issued(1), issued(2)] }, plan.rev!).verdict).toBe("superseded");
  });
  it("a file with no recorded revision gets NO ?r= — so the endpoint answers unknown, not a green current — and a 'cannot confirm' footer", () => {
    for (const rev of [undefined, null, "", "  "]) {
      const plan = ticketCopyPlan({ file: final(rev as string | null | undefined), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "download" });
      expect(plan.verifyUrl).toBe(`${ORIGIN}/verify-ticket/${T}`);
      expect(plan.rev).toBeNull();
      expect(plan.footerNotice).toMatch(/no deliverable revision is recorded for this file, so which printing this is cannot be confirmed/);
      expect(ticketVerdict({ status: "PENDING_IFC", deliverable_rev: "2", history: [] }, "").verdict).toBe("unknown");
    }
  });
  it("no public origin → no QR (DEC-64 §2), and a rev'd footer then loses only its scan instruction", () => {
    const plan = ticketCopyPlan({ file: final("3"), ticketNumber: "KE-1", ticketRowId: T, origin: "", channel: "download" });
    expect(plan.verifyUrl).toBeUndefined();
    expect(withoutScanInstruction(plan.footerNotice)).toBe("This file is KE-1 deliverable Rev 3 — not a controlled document revision. Confirm the current revision before use.");
  });
  // Reviewer PHYS-2 (fix pass 2): a file the page KNOWS is superseded never
  // prints as if it were the deliverable at time of printing.
  const live = (over: Partial<TicketCopyLiveFacts>): TicketCopyLiveFacts => ({ status: "FINAL_DRAFT", deliverableRev: "2", history: [issued(1), issued(2)], ...over });
  it("Rev 1 Final, ticket at Rev 2 → the stamp says SUPERSEDED by Rev 2, the QR still asks about Rev 1, and the page confirms first", () => {
    for (const channel of ["print", "download"] as const) {
      const plan = ticketCopyPlan({ file: final("1"), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel, live: live({}) });
      expect(plan.verifyUrl).toBe(`${ORIGIN}/verify-ticket/${T}?r=1`); // a warning input only
      expect(plan.standing).toEqual({ kind: "superseded", by: "2" });
      expect(plan.footerNotice).toMatch(/^SUPERSEDED by Rev 2 at time of (printing|download) — this file is KE-1 deliverable Rev 1, not the current revision/);
      expect(plan.footerNotice).not.toMatch(/Rev 1 at time of/);
      expect(plan.confirmMessage).toMatch(/This file is Rev 1, but KE-1 has since issued Rev 2\. The copy will be stamped SUPERSEDED\./);
      // with no QR on the page the SUPERSEDED words survive the scan-clause strip
      expect(withoutScanInstruction(plan.footerNotice)).toBe(`SUPERSEDED by Rev 2 at time of ${channel === "print" ? "printing" : "download"} — this file is KE-1 deliverable Rev 1, not the current revision — not a controlled document revision. Confirm the current revision before use.`);
    }
  });
  it("superseded is read from the history too — a reopened ticket (label nulled) that issued Rev 2, or a closed one", () => {
    expect(ticketCopyPlan({ file: final("1"), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: live({ status: "PENDING_REVIEW", deliverableRev: null }) }).standing)
      .toEqual({ kind: "superseded", by: "2" });
    expect(ticketCopyPlan({ file: final("1"), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: live({ status: "CLOSED", deliverableRev: "3A" }) }).standing)
      .toEqual({ kind: "superseded", by: "2" });
  });
  it("the last issue while the ticket is re-worked → 'a newer revision is in progress', confirmed first; agrees with the scan", () => {
    for (const l of [
      live({ status: "REVISION_REQ", deliverableRev: "2" }),          // reject_final keeps the label
      live({ status: "PENDING_REVIEW", deliverableRev: "3A" }),       // a review label on the row
      live({ status: "PENDING_REVIEW", deliverableRev: null }),       // reopened (WF-21)
    ]) {
      const plan = ticketCopyPlan({ file: final("2"), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: l });
      expect(plan.standing).toEqual({ kind: "in_progress" });
      expect(plan.footerNotice).toBe("This file is KE-1 deliverable Rev 2 — a newer revision is in progress at time of printing — not a controlled document revision — scan the QR to confirm it is still the latest.");
      expect(plan.confirmMessage).toMatch(/a newer revision is in progress/);
      expect(ticketVerdict({ status: l.status, deliverable_rev: l.deliverableRev, history: l.history }, "2").verdict).toBe("revision_in_progress");
    }
  });
  it("a deliverable of a WITHDRAWN request (EDGE-2) → stamped REQUEST WITHDRAWN, confirmed first; agrees with the scan", () => {
    for (const l of [
      live({ status: "CANCELED", deliverableRev: "1", history: [issued(1)] }),        // canceled after its issue
      live({ status: "CANCELED", deliverableRev: "2", history: [issued(1), issued(2)] }), // withdrawn outranks superseded, as the scan does
      live({ status: "CANCELED", deliverableRev: "1A", history: [] }),               // canceled before any issue
    ]) {
      for (const channel of ["print", "download"] as const) {
        const plan = ticketCopyPlan({ file: final("1"), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel, live: l });
        const when = channel === "print" ? "printing" : "download";
        expect(plan.standing).toEqual({ kind: "withdrawn" });
        expect(plan.footerNotice).toBe(`REQUEST WITHDRAWN at time of ${when} — this file is KE-1 deliverable Rev 1 — do not work from it — not a controlled document revision — scan the QR for the current status.`);
        expect(plan.confirmMessage).toBe(`This file is Rev 1, but the KE-1 request was withdrawn. The copy will be stamped WITHDRAWN. ${channel === "print" ? "Print" : "Download"} it anyway?`);
        expect(plan.verifyUrl).toBe(`${ORIGIN}/verify-ticket/${T}?r=1`); // the QR stays the file's own
        expect(ticketVerdict({ status: l.status, deliverable_rev: l.deliverableRev, history: l.history }, "1").verdict).toBe("withdrawn");
        // with no QR on the page the WITHDRAWN words survive the scan-clause strip
        expect(withoutScanInstruction(plan.footerNotice)).toMatch(/^REQUEST WITHDRAWN at time of .* — do not work from it — not a controlled document revision\. Confirm the current revision before use\.$/);
      }
    }
    // a request CLOSED on a review label with no issue anywhere answers withdrawn too
    expect(ticketCopyStanding("1", { status: "CLOSED", deliverableRev: "1A", history: [], revisionCount: 0 })).toEqual({ kind: "withdrawn" });
    // a Draft or a rev-less file of a withdrawn request keeps no standing (its watermark / "cannot confirm" footer speak)
    expect(ticketCopyPlan({ file: { type: "Draft", rev: "1A" }, ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: live({ status: "CANCELED" }) }).standing).toBeNull();
    expect(ticketCopyPlan({ file: final(null), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: live({ status: "CANCELED" }) }).confirmMessage).toBeNull();
  });
  it("the latest issue, a Draft, a rev-less file or no live facts: no standing, no confirmation", () => {
    const cur = ticketCopyPlan({ file: final("2"), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: live({}) });
    expect([cur.standing, cur.confirmMessage]).toEqual([null, null]);
    expect(cur.footerNotice).toBe("This file is KE-1 deliverable Rev 2 — not a controlled document revision — scan the QR to confirm it is still the latest.");
    const draft = ticketCopyPlan({ file: { type: "Draft", rev: "1A" }, ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "download", live: live({}) });
    expect([draft.standing, draft.confirmMessage]).toEqual([null, null]);
    expect(draft.footerNotice).toContain("This file is KE-1 review draft Rev 1A");
    expect(ticketCopyPlan({ file: final(null), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print", live: live({}) }).standing).toBeNull();
    expect(ticketCopyPlan({ file: final("1"), ticketNumber: "KE-1", ticketRowId: T, origin: ORIGIN, channel: "print" }).standing).toBeNull();
    expect(ticketCopyStanding("1", null)).toBeNull();
  });
  it("ticketVerifyUrl only carries a well-formed rev", () => {
    expect(ticketVerifyUrl(ORIGIN, T, "2A")).toBe(`${ORIGIN}/verify-ticket/${T}?r=2A`);
    expect(ticketVerifyUrl(ORIGIN, T, "../x")).toBe(`${ORIGIN}/verify-ticket/${T}`);
    expect(ticketVerifyUrl(ORIGIN, undefined, "1")).toBeUndefined();
  });
});

describe("PHYS-9 / HAND-3 — one control state per file; never 'CONTROLLED COPY'; 'not a controlled document revision'", () => {
  it("a Draft is a review copy, everything else uncontrolled — print and download agree", () => {
    for (const type of ["Draft", "Final", "Source", "Reference"] as const) {
      const p = ticketCopyPlan({ file: { type, rev: "1" }, ticketRowId: T, origin: ORIGIN, channel: "print" });
      const d = ticketCopyPlan({ file: { type, rev: "1" }, ticketRowId: T, origin: ORIGIN, channel: "download" });
      expect(p.controlState).toBe(d.controlState);
      expect(p.controlState).toBe(type === "Draft" ? "review" : "uncontrolled");
      expect(ticketCopyControlState({ type })).toBe(p.controlState);
      expect(p.watermark).toBe(stampWatermark(undefined, p.controlState));
      expect(p.watermark).not.toMatch(/(^|[^N])CONTROLLED COPY/i);
      expect(p.footerNotice).toMatch(/not a controlled document revision/i);
    }
  });
});

// ─── the record (EVID-5 / PHYS-8) ───────────────────────────────────────────
describe("EVID-5 / PHYS-8 — the copy's record is awaited, checked and in the table's real columns", () => {
  const file = { id: "a-1", name: "IFC.pdf", type: "Final" as const, rev: "1" };
  const base = { orgId: "org-1", userId: "u-1", userEmail: "u@x.io", userRole: "Engineer", ticketRowId: T, ticketNumber: "KE-1", file, channel: "download" as const, stamped: true, watermark: "UNCONTROLLED COPY", expiresAt: new Date("2026-11-12T00:00:00Z") };
  const mkClient = (results: Array<{ error: { code?: string; message?: string } | null }>) => {
    const rows: Array<Record<string, unknown>> = [];
    return { rows, client: { from: (t: string) => ({ insert: async (row: Record<string, unknown>) => { expect(t).toBe("download_audits"); rows.push(row); return results.shift() ?? { error: null }; } }) } };
  };

  it("writes download_audits with ONLY columns the table has (20261068's source; DF-P12's 20261223 ticket_id / attachment_id; never attachment_type / filename / watermark_text) and an audit row naming the file", async () => {
    const { rows, client } = mkClient([{ error: null }]);
    const logAudit = vi.fn(async () => ({ ok: true, error: null }));
    const res = await recordTicketCopy(client, logAudit, base);
    expect(res).toEqual({ recorded: true, error: null });
    expect(rows).toHaveLength(1);
    // PHYS-17 (DF-P12): the row names the ticket and the file (20261223's columns).
    expect(Object.keys(rows[0]).sort()).toEqual(["attachment_id", "expires_at", "org_id", "source", "ticket_id", "user_email", "user_id"]);
    expect(rows[0]).toMatchObject({ org_id: "org-1", user_id: "u-1", source: "drafting", ticket_id: T, attachment_id: "a-1" });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "DOWNLOAD", resourceType: "ticket", resourceId: T, orgId: "org-1", userId: "u-1",
      details: expect.objectContaining({ attachmentId: "a-1", fileName: "IFC.pdf", rev: "1", watermark: "UNCONTROLLED COPY", channel: "download", source: "drafting" }),
    }));
  });
  it("channel names: drafting / drafting_print, _unstamped when the stamp failed (the audit row says UNSTAMPED)", async () => {
    expect([ticketCopySource("download", true), ticketCopySource("print", true), ticketCopySource("download", false), ticketCopySource("print", false)])
      .toEqual(["drafting", "drafting_print", "drafting_unstamped", "drafting_print_unstamped"]);
    const { rows, client } = mkClient([{ error: null }]);
    const logAudit = vi.fn(async () => ({ ok: true, error: null }));
    await recordTicketCopy(client, logAudit, { ...base, channel: "print", stamped: false, watermark: null });
    expect(rows[0].source).toBe("drafting_print_unstamped");
    expect((logAudit.mock.calls[0] as unknown as [{ details: Record<string, unknown> }])[0].details.watermark).toBe("UNSTAMPED (stamping failed)");
  });
  it("before 20261068 (no source column): retried once in the table's original shape — the pull is still recorded", async () => {
    const { rows, client } = mkClient([{ error: { code: "PGRST204", message: "Could not find the 'source' column of 'download_audits' in the schema cache" } }, { error: null }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await recordTicketCopy(client, async () => ({ ok: true, error: null }), base);
    expect(res.recorded).toBe(true);
    expect(rows).toHaveLength(2);
    expect("source" in rows[1]).toBe(false);
    expect(isMissingSourceColumn({ code: "42703", message: 'column "source" of relation "download_audits" does not exist' })).toBe(true);
    expect(isMissingSourceColumn({ code: "42501", message: "new row violates row-level security policy" })).toBe(false);
  });
  it("a refused record is REPORTED (never a silent success): the distribution row, or the audit row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = mkClient([{ error: { code: "42501", message: "new row violates row-level security policy for table \"download_audits\"" } }]);
    const a = await recordTicketCopy(refused.client, async () => ({ ok: true, error: null }), base);
    expect(a.recorded).toBe(false);
    expect(a.error).toMatch(/distribution record refused it/);
    const ok = mkClient([{ error: null }]);
    const b = await recordTicketCopy(ok.client, async () => ({ ok: false, error: "audit insert refused" }), base);
    expect(b).toEqual({ recorded: false, error: "the audit trail refused it (audit insert refused)" });
    const thrown = await recordTicketCopy({ from: () => ({ insert: async () => { throw new Error("fetch failed"); } }) }, async () => ({ ok: true, error: null }), base);
    expect(thrown.recorded).toBe(false);
  });
});

// ─── the page (source pins: the FileViewerModal region) ─────────────────────
describe("the ticket page's FileViewerModal — wired to the rules above", () => {
  const page = src("app/(protected)/requests/[id]/page.tsx");
  const modal = page.slice(page.indexOf("const FileViewerModal = ("), page.indexOf("<DownloadComplianceModal"));
  it("no ticket-level deliverableRev reaches the QR; the plan reads the file, with the live ticket as a warning input only", () => {
    expect(modal).not.toMatch(/deliverableRev/);
    expect(page).not.toContain("deliverableRev={ticket?.deliverableRev}");
    expect(modal).toContain("ticketCopyPlan({ file, ticketNumber: ticketId, ticketRowId, origin: publicOrigin(), channel, live: liveTicket })");
    expect(page).toContain("liveTicket={ticket ? { status: ticket.status, deliverableRev: ticket.deliverableRev ?? null, history: ticket.history, revisionCount: ticket.revisionCount ?? null } : null}");
  });
  it("a superseded or re-worked file is confirmed before stamping, on both paths", () => {
    expect(modal).toContain('!plan.confirmMessage || (await appConfirm({ message: plan.confirmMessage, tone: "danger" }))');
    // DF-P15 third fix pass: both browser paths still confirm, unless the server copy route already asked this copy's question (an oversize PDF's fallback carries `acknowledged`)
    expect(modal.match(/if \(!opts\.standingConfirmed && !\(await confirmStanding\(plan\)\)\)/g)).toHaveLength(2);
  });
  it("both paths stamp with the plan's control state, QR and footer — no watermark literal", () => {
    expect(modal.match(/controlState: plan\.controlState,/g)).toHaveLength(2);
    expect(modal.match(/verifyUrl: plan\.verifyUrl,/g)).toHaveLength(2);
    expect(modal.match(/footerNotice: plan\.footerNotice,/g)).toHaveLength(2);
    expect(modal).not.toMatch(/watermarkText:/);
    expect(modal).not.toMatch(/"CONTROLLED COPY"|"UNCONTROLLED COPY"/);
  });
  it("the record is awaited and checked on both paths — no `void` insert, no swallowed promise, no non-existent columns", () => {
    expect(modal).not.toMatch(/void supabase\.from\("download_audits"\)/);
    expect(modal).not.toMatch(/\.then\(\(\) => \{\}, \(\) => \{\}\)/);
    expect(modal).not.toMatch(/ticket_id:|attachment_id:|attachment_type:|watermark_text:/);
    expect(modal).toContain('await recordCopy("print", stamped, plan.watermark,');
    // the print starts BEFORE its record is awaited — a slow record never delays paper
    expect(modal.indexOf("document.body.appendChild(iframe);")).toBeLessThan(modal.indexOf('await recordCopy("print"'));
    expect(modal).toContain('await recordCopy("download", stamped, plan.watermark, expiresAt);');
    expect(modal).toContain("if (!res.recorded) {");
  });
  it("the PDF frame keeps its reviewed inline signing (DEC-49)", () => {
    expect(modal).toContain("getSignedUrlForPath(file.url, undefined, { inline: true })");
  });
});

// ─── the route (AUTHZ-12 / EDGE-2 at the door) ──────────────────────────────
const state = vi.hoisted(() => ({
  ticket: null as Record<string, unknown> | null,
  selects: [] as string[],
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));
function chain(table: string) {
  let head = false;
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") return (resolve: (v: unknown) => void) => resolve(head ? { data: null, error: null, count: 0 } : { data: null, error: null });
      return (...args: unknown[]) => {
        if (p === "select") {
          if ((args[1] as { head?: boolean } | undefined)?.head) head = true;
          else if (table === "tickets") state.selects.push(String(args[0]));
        }
        if (p === "insert") { state.inserts.push({ table, row: args[0] as Record<string, unknown> }); return Promise.resolve({ error: null }); }
        if (p === "maybeSingle") return Promise.resolve({ data: table === "tickets" ? state.ticket : null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));

describe("AUTHZ-12 / EDGE-2 — /api/verify-ticket answers revision-status facts only", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    state.ticket = null; state.selects = []; state.inserts = [];
  });
  async function call(rev: string | null) {
    const { GET } = await import("@/app/api/verify-ticket/route");
    const u = new URL("https://app/api/verify-ticket");
    u.searchParams.set("t", T);
    if (rev !== null) u.searchParams.set("r", rev);
    const res = await GET(new NextRequest(u));
    return { res, body: (await res.json()) as Record<string, unknown> };
  }
  const row = (over: Record<string, unknown>) => ({ id: T, ticket_id: "KE-9", title: "Tie-in iso", unit: "U-200", status: "PENDING_IFC", deliverable_rev: "1", last_modified: "2026-10-01T00:00:00Z", history: [], archived_at: null, ...over });
  const scans = () => state.inserts.filter((i) => i.table === "verify_scans").map((i) => i.row.verdict);

  it("the payload is exactly the revision-status fields — no ticketStatus, no unit, no lastActivityAt — and the select reads neither unit nor last_modified", async () => {
    state.ticket = row({});
    const { res, body } = await call("1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "currentRev", "inReview", "latestIssuedRev", "printedRev", "ticketNumber", "title", "verdict"]);
    expect(body.verdict).toBe("current");
    // DF-P12: 20261221's trust index is read for the verdict (never returned); attachments only for a QR naming a file.
    expect(state.selects).toEqual(["id, ticket_id, title, status, deliverable_rev, history, revision_count, archived_at, history_guarded_from"]);
    expect(scans()).toEqual(["current"]);
  });
  it("revision_count is read for the verdict, never returned: a member's forged history line cannot make a scan answer for it", async () => {
    state.ticket = row({ status: "CLOSED", deliverable_rev: null, revision_count: 0, history: [{ action: "note — issued Rev 9", user: "member@x.com" }] });
    const { body } = await call("9");
    expect(body.verdict).toBe("unknown");
    expect(body.latestIssuedRev).toBeNull();
    expect("revisionCount" in body || "revision_count" in body).toBe(false);
  });
  it("a CANCELED ticket's issued deliverable scans 'withdrawn', logged as shown", async () => {
    state.ticket = row({ status: "CANCELED" });
    const { body } = await call("1");
    expect(body.verdict).toBe("withdrawn");
    expect(scans()).toEqual(["withdrawn"]);
  });
  it("an archived ticket answers 'unknown' with no revision facts; a QR with no rev answers 'unknown' (still logged)", async () => {
    state.ticket = row({ archived_at: "2026-09-01T00:00:00Z", status: "CLOSED" });
    const a = await call("1");
    expect(a.body).toMatchObject({ verdict: "unknown", currentRev: null, latestIssuedRev: null, inReview: false, ticketNumber: "KE-9" });
    state.ticket = row({});
    const b = await call(null);
    expect(b.body.verdict).toBe("unknown");
    expect(scans()).toEqual(["unknown", "unknown"]);
  });
  it("the route header states the payload field for field", () => {
    const s = src("app/api/verify-ticket/route.ts");
    expect(s).toContain("ticketNumber, title, printedRev, currentRev, latestIssuedRev,");
    expect(s).toContain("inReview, verdict, checkedAt");
    expect(s).not.toMatch(/ticketStatus:|unit:|lastActivityAt:/);
  });
  it("the landing page paints 'withdrawn' red, never green, and no longer reads unit / status / activity", () => {
    const p = src("app/verify-ticket/[ticketId]/page.tsx");
    expect(p).toMatch(/withdrawn: \{\s*bg: "bg-red-600", icon: "stop", headline: "WITHDRAWN — DO NOT USE"/);
    expect(p).not.toMatch(/result\.unit|ticketStatus|lastActivityAt/);
    expect(p).toContain("VERDICT_UI[result.verdict] ?? VERDICT_UI.unknown");
    // EDGE-2 done-when 2: the facts card's right cell is the coarse state, not a hard-coded "Latest issue Rev N"
    expect(p).toContain("ticketFactsState(");
    expect(p).not.toContain('{result.inReview ? "In review now" : "Latest issue"}');
    expect(p).toContain("ticketRevInReview(r)");
  });
});
