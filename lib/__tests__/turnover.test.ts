// projects Round G — J2 QUALITY, the turnover + punch data layer.
//
//   SAF-4 / GAP-405  reject, waive, reopen and void refuse a blank, short or
//                    canned reason SERVER-SIDE; waived is its own bucket.
//   SAF-3 / GAP-402  an RLS-refused decision returns an error and writes no
//                    audit row (turnover review, reopen, punch status, seed).
//   QUAL-11          every decision appends a turnover_review_events row; a
//                    rejection is a nonconformance event; an accepted or
//                    waived item can be reopened and the acceptance survives.
//   QUAL-13          document_id is written on accept and carried into the
//                    event row.
//   QUAL-7           closing a punch item stamps closed_by_name and the
//                    closure note; done and void are distinguishable.
//   UX-10            list reads throw on error instead of returning [].

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetState, type MemoryState } from "./helpers/memoryDb";

const state = vi.hoisted<MemoryState>(() => ({
  tables: {}, calls: [], writes: [], refuse: false, writeError: null, readError: {}, nextId: 1,
}));
vi.mock("@/lib/supabase", async () => {
  const { makeSupabase } = await import("./helpers/memoryDb");
  return { supabase: makeSupabase(state) };
});

import {
  addPunchItem, computeTurnoverProgress, listPunchItems, listTurnoverItems, listTurnoverReviewEvents,
  reopenTurnoverItem, reviewTurnoverItem, seedTurnoverItems, setPunchStatus,
  type PunchItem, type TurnoverItem,
} from "@/lib/turnover";

const actor = { uid: "u1", email: "jchen@plant.io" };
const audits = () => state.writes.filter((w) => w.table === "audit_logs").map((w) => w.payload as Record<string, unknown>);
const events = () => state.tables.turnover_review_events ?? [];

const item = (over: Partial<TurnoverItem> = {}): TurnoverItem => ({
  id: "t1", orgId: "o1", projectId: "p1", partyId: null, name: "Material certs (MTRs)", description: null,
  required: true, status: "received", documentId: null, reviewedAt: null, reviewedByName: null, reviewNote: null, createdAt: null, ...over,
});
const punch = (over: Partial<PunchItem> = {}): PunchItem => ({
  id: "pi1", orgId: "o1", projectId: "p1", partyId: null, title: "Reinstall insulation at E-301 north nozzle",
  description: null, location: null, status: "open", dueDate: null, closedAt: null, closedByName: null, closureNote: null,
  createdByName: "mreyes", createdAt: null, ...over,
});

beforeEach(() => {
  resetState(state);
  state.tables.turnover_items = [{ id: "t1", org_id: "o1", project_id: "p1", name: "Material certs (MTRs)", status: "received", document_id: null }];
  state.tables.punch_items = [{ id: "pi1", org_id: "o1", project_id: "p1", title: "Reinstall insulation", status: "open" }];
});

describe("reads fail loudly (UX-10)", () => {
  it("listTurnoverItems / listPunchItems throw on a read error", async () => {
    state.readError.turnover_items = { message: "permission denied for table turnover_items", code: "42501" };
    await expect(listTurnoverItems("o1", "p1")).rejects.toThrow(/permission/);
    state.readError.punch_items = { message: 'relation "public.punch_items" does not exist', code: "42P01" };
    await expect(listPunchItems("o1", "p1")).rejects.toThrow(/migration/);
  });
  it("the review history is empty (not an error) before the migration", async () => {
    state.readError.turnover_review_events = { message: 'relation "public.turnover_review_events" does not exist', code: "42P01" };
    expect(await listTurnoverReviewEvents("o1", "p1")).toEqual([]);
  });
});

describe("reviewTurnoverItem — the reason bar (SAF-4) and the history (QUAL-11 / QUAL-13)", () => {
  it("reject and waive refuse a blank, whitespace, short or canned reason — nothing written, nothing audited", async () => {
    for (const status of ["rejected", "waived"] as const) {
      for (const note of [null, undefined, "", "   ", "n/a", "ok", "too short"]) {
        const res = await reviewTurnoverItem({ item: item(), status, note, actor });
        expect(res.ok, `${status} / ${JSON.stringify(note)}`).toBe(false);
        expect(res.error).toMatch(/reason|Say why/);
      }
    }
    expect(state.writes).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("a rejection lands, audits after the confirmed match, and appends a NONCONFORMANCE event with reviewer, date and note", async () => {
    const res = await reviewTurnoverItem({ item: item(), status: "rejected", note: "Heat numbers on the MTRs do not trace to the installed spools", actor });
    expect(res).toEqual({ ok: true });
    expect(state.tables.turnover_items[0]).toMatchObject({ status: "rejected", reviewed_by: "u1", reviewed_by_name: "jchen", review_note: "Heat numbers on the MTRs do not trace to the installed spools" });
    expect(audits().map((a) => a.action)).toEqual(["TURNOVER_REVIEWED"]);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      org_id: "o1", project_id: "p1", item_id: "t1", from_status: "received", to_status: "rejected", kind: "nonconformance",
      reviewer: "u1", reviewer_name: "jchen", note: "Heat numbers on the MTRs do not trace to the installed spools",
    });
  });

  it("the rejection survives a later acceptance as history (not an overwrite), and the accept carries the reviewed document", async () => {
    await reviewTurnoverItem({ item: item(), status: "rejected", note: "Heat numbers on the MTRs do not trace to the installed spools", actor });
    const res = await reviewTurnoverItem({ item: item({ status: "rejected" }), status: "accepted", note: "Resubmitted with the traceability matrix", documentId: "doc-mtr-2", actor });
    expect(res.ok).toBe(true);
    expect(state.tables.turnover_items[0]).toMatchObject({ status: "accepted", document_id: "doc-mtr-2" });
    expect(events().map((e) => [e.kind, e.from_status, e.to_status, e.document_id])).toEqual([
      ["nonconformance", "received", "rejected", null],
      ["review", "rejected", "accepted", "doc-mtr-2"],
    ]);
    expect(events()[0].note).toBe("Heat numbers on the MTRs do not trace to the installed spools");
  });

  it("an RLS-refused decision returns the refusal, writes NO audit row and NO history row (SAF-3)", async () => {
    state.refuse = true;
    const res = await reviewTurnoverItem({ item: item(), status: "accepted", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/don't have permission|someone else changed/);
    expect(audits()).toHaveLength(0);
    expect(events()).toHaveLength(0);
    expect(state.tables.turnover_items[0].status).toBe("received");
  });

  it("a history row that cannot be written is reported, never silently dropped", async () => {
    state.refuse = ["turnover_review_events"];
    const res = await reviewTurnoverItem({ item: item(), status: "accepted", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/now accepted, but the review history row was not written/);
  });
});

describe("reopenTurnoverItem (QUAL-11)", () => {
  it("only an accepted or waived item can be reopened, and only with a real reason", async () => {
    expect((await reopenTurnoverItem({ item: item({ status: "received" }), reason: "wrong package was accepted", actor })).ok).toBe(false);
    const short = await reopenTurnoverItem({ item: item({ status: "accepted" }), reason: "oops", actor });
    expect(short.ok).toBe(false);
    expect(short.error).toMatch(/Say why/);
    expect(state.writes).toHaveLength(0);
  });

  it("reopens to received, clears the row's decision, audits, and keeps the acceptance as a reopen event", async () => {
    state.tables.turnover_items[0] = { ...state.tables.turnover_items[0], status: "accepted", reviewed_by: "u0", reviewed_by_name: "old", review_note: "fine", document_id: "doc-1" };
    const res = await reopenTurnoverItem({ item: item({ status: "accepted", documentId: "doc-1" }), reason: "Heat numbers found not to trace after acceptance", actor });
    expect(res).toEqual({ ok: true });
    expect(state.tables.turnover_items[0]).toMatchObject({ status: "received", reviewed_by: null, reviewed_by_name: null, review_note: null });
    expect(audits().map((a) => a.action)).toEqual(["TURNOVER_REOPENED"]);
    expect(events()[0]).toMatchObject({ kind: "reopen", from_status: "accepted", to_status: "received", note: "Heat numbers found not to trace after acceptance", document_id: "doc-1" });
    // the guard: the reopen is conditional on the status as read
    const w = state.writes.find((x) => x.table === "turnover_items" && x.method === "update")!;
    expect(w.filters).toContainEqual(["status", "accepted"]);
  });

  it("a refused reopen audits nothing", async () => {
    state.refuse = true;
    const res = await reopenTurnoverItem({ item: item({ status: "waived" }), reason: "The item turned out to be required after all", actor });
    expect(res.ok).toBe(false);
    expect(audits()).toHaveLength(0);
  });
});

describe("computeTurnoverProgress — waived is its own bucket (SAF-4 dw4)", () => {
  it("reports accepted and waived separately; pct still counts both as met", () => {
    const p = computeTurnoverProgress([
      item({ id: "1", status: "accepted" }), item({ id: "2", status: "waived" }),
      item({ id: "3", status: "received" }), item({ id: "4", status: "rejected" }),
      item({ id: "5", status: "open", required: false }),
    ]);
    expect(p).toEqual({ required: 4, accepted: 1, waived: 1, received: 1, rejected: 1, outstanding: ["Material certs (MTRs)"], pct: 50 });
  });
});

describe("seedTurnoverItems / addPunchItem — checked inserts", () => {
  it("a refused seed returns the refusal and audits nothing", async () => {
    state.tables.turnover_items = [];
    state.refuse = true;
    const res = await seedTurnoverItems({ orgId: "o1", projectId: "p1", jobKind: "small", actor });
    expect(res).toMatchObject({ ok: false, added: 0 });
    expect(audits()).toHaveLength(0);
  });
  it("a landed seed reports the real count", async () => {
    state.tables.turnover_items = [];
    const res = await seedTurnoverItems({ orgId: "o1", projectId: "p1", jobKind: "small", actor });
    expect(res).toEqual({ ok: true, added: 3 });
  });
  it("a punch item records location and description", async () => {
    const res = await addPunchItem({ orgId: "o1", projectId: "p1", title: "Reinstall insulation", location: "E-301 N nozzle", description: "insulation removed for hydro", actor });
    expect(res.ok).toBe(true);
    expect(state.tables.punch_items.at(-1)).toMatchObject({ location: "E-301 N nozzle", description: "insulation removed for hydro", created_by_name: "jchen" });
  });
});

describe("setPunchStatus (SAF-4 / QUAL-7 / SAF-3)", () => {
  it("void refuses a blank or canned reason; nothing written", async () => {
    for (const note of [null, "", "  ", "none", "not real"]) {
      const res = await setPunchStatus({ item: punch(), status: "void", note, actor });
      expect(res.ok, JSON.stringify(note)).toBe(false);
    }
    expect(state.writes).toHaveLength(0);
  });

  it("done stamps closed_by_name + closure_note; void is distinguishable on the row; reopen clears them", async () => {
    const done = await setPunchStatus({ item: punch(), status: "done", note: "Insulation reinstalled, verified by ops", actor });
    expect(done.ok).toBe(true);
    expect(state.tables.punch_items[0]).toMatchObject({ status: "done", closed_by: "u1", closed_by_name: "jchen", closure_note: "Insulation reinstalled, verified by ops" });
    expect(typeof state.tables.punch_items[0].closed_at).toBe("string");

    const back = await setPunchStatus({ item: punch({ status: "done" }), status: "open", actor });
    expect(back.ok).toBe(true);
    expect(state.tables.punch_items[0]).toMatchObject({ status: "open", closed_by: null, closed_by_name: null, closure_note: null, closed_at: null });

    const voided = await setPunchStatus({ item: punch(), status: "void", note: "Duplicate of the E-301 south nozzle item", actor });
    expect(voided.ok).toBe(true);
    expect(state.tables.punch_items[0]).toMatchObject({ status: "void", closure_note: "Duplicate of the E-301 south nozzle item", closed_by_name: "jchen" });
    expect(audits().map((a) => (a.details as { status: string }).status)).toEqual(["done", "open", "void"]);
  });

  it("an RLS-refused close returns the refusal and audits nothing", async () => {
    state.refuse = true;
    const res = await setPunchStatus({ item: punch(), status: "done", actor });
    expect(res.ok).toBe(false);
    expect(audits()).toHaveLength(0);
    expect(state.tables.punch_items[0].status).toBe("open");
  });
});
