// projects Round G — J2 QUALITY, the turnover + punch data layer.
//
//   SAF-4 / GAP-405  reject, waive, reopen and void refuse a blank, short or
//                    canned reason SERVER-SIDE; waived is its own bucket.
//   SAF-3 / GAP-402  an RLS-refused decision returns an error and writes no
//                    audit row (turnover review, reopen, punch status, seed).
//   QUAL-11          the history is the DATABASE's to write (20261091's
//                    trigger, in the same statement as the decision): the lib
//                    never inserts a turnover_review_events row, and each
//                    decision / reopen write carries what the trigger records
//                    (a fresh reviewed_at, the name, the note or the reason).
//                    A failed history read throws unless the table is missing.
//   QUAL-13          document_id is written on accept.
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
  it("the review history is empty (not an error) before the migration — in every missing-table shape", async () => {
    for (const e of [
      { message: 'relation "public.turnover_review_events" does not exist', code: "42P01" },
      { message: "Could not find the table 'public.turnover_review_events' in the schema cache", code: "PGRST205" },
    ]) {
      state.readError.turnover_review_events = e;
      expect(await listTurnoverReviewEvents("o1", "p1")).toEqual([]);
    }
  });
  it("any OTHER history read failure throws — a denial or an outage never reads as an empty history (UX-10)", async () => {
    state.readError.turnover_review_events = { message: "permission denied for table turnover_review_events", code: "42501" };
    await expect(listTurnoverReviewEvents("o1", "p1")).rejects.toThrow(/don't have permission/);
    state.readError.turnover_review_events = { message: "upstream request timeout", code: "PGRST000" };
    await expect(listTurnoverReviewEvents("o1", "p1")).rejects.toThrow(/upstream request timeout/);
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

  it("a rejection lands with the reviewer, a fresh date and the note on the row (what the history trigger records as a NONCONFORMANCE), and audits after the confirmed match", async () => {
    const res = await reviewTurnoverItem({ item: item(), status: "rejected", note: "Heat numbers on the MTRs do not trace to the installed spools", actor });
    expect(res).toEqual({ ok: true });
    const r = state.tables.turnover_items[0];
    expect(r).toMatchObject({ status: "rejected", reviewed_by: "u1", reviewed_by_name: "jchen", review_note: "Heat numbers on the MTRs do not trace to the installed spools" });
    expect(typeof r.reviewed_at).toBe("string");
    expect(audits().map((a) => a.action)).toEqual(["TURNOVER_REVIEWED"]);
    // the lib never writes the history itself — the database does, atomically
    expect(state.writes.filter((w) => w.table === "turnover_review_events")).toHaveLength(0);
  });

  it("an accept after a rejection carries the reviewed document and a fresh stamp; the lib writes one request per decision (no second, failable history insert)", async () => {
    await reviewTurnoverItem({ item: item(), status: "rejected", note: "Heat numbers on the MTRs do not trace to the installed spools", actor });
    const firstStamp = state.tables.turnover_items[0].reviewed_at;
    await new Promise((r) => setTimeout(r, 2));
    const res = await reviewTurnoverItem({ item: item({ status: "rejected" }), status: "accepted", note: "Resubmitted with the traceability matrix", documentId: "doc-mtr-2", actor });
    expect(res.ok).toBe(true);
    expect(state.tables.turnover_items[0]).toMatchObject({ status: "accepted", document_id: "doc-mtr-2", review_note: "Resubmitted with the traceability matrix" });
    expect(state.tables.turnover_items[0].reviewed_at).not.toBe(firstStamp);   // the trigger carries name + note only on a fresh stamp
    expect(state.writes.filter((w) => w.table !== "audit_logs").map((w) => `${w.table}.${w.method}`)).toEqual(["turnover_items.update", "turnover_items.update"]);
  });

  it("before 20261091 a decision still lands and reports success — there is no client history insert to fail", async () => {
    state.tableWriteError = { turnover_review_events: { message: "Could not find the table 'public.turnover_review_events' in the schema cache", code: "PGRST205" } };
    const res = await reviewTurnoverItem({ item: item(), status: "accepted", actor });
    expect(res).toEqual({ ok: true });
    expect(state.tables.turnover_items[0].status).toBe("accepted");
  });

  it("an RLS-refused decision returns the refusal and writes NO audit row (SAF-3)", async () => {
    state.refuse = true;
    const res = await reviewTurnoverItem({ item: item(), status: "accepted", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/don't have permission|someone else changed/);
    expect(audits()).toHaveLength(0);
    expect(state.tables.turnover_items[0].status).toBe("received");
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

  it("reopens to received with the reopener, a fresh date and the REASON on the row (what the database requires and records as the reopen event); the audit row carries the decision being reopened", async () => {
    state.tables.turnover_items[0] = { ...state.tables.turnover_items[0], status: "accepted", reviewed_by: "u0", reviewed_by_name: "qa.lead", review_note: "looks good", reviewed_at: "2026-08-31T00:00:00Z", document_id: "doc-1" };
    const res = await reopenTurnoverItem({
      item: item({ status: "accepted", documentId: "doc-1", reviewedByName: "qa.lead", reviewNote: "looks good", reviewedAt: "2026-08-31T00:00:00Z" }),
      reason: "Heat numbers found not to trace after acceptance", actor,
    });
    expect(res).toEqual({ ok: true });
    const r = state.tables.turnover_items[0];
    expect(r).toMatchObject({ status: "received", reviewed_by: "u1", reviewed_by_name: "jchen", review_note: "Heat numbers found not to trace after acceptance", document_id: "doc-1" });
    expect(r.reviewed_at).not.toBe("2026-08-31T00:00:00Z");
    const a = audits();
    expect(a.map((x) => x.action)).toEqual(["TURNOVER_REOPENED"]);
    expect((a[0].details as { prior: unknown }).prior).toEqual({ reviewedByName: "qa.lead", reviewedAt: "2026-08-31T00:00:00Z", note: "looks good", documentId: "doc-1" });
    expect(state.writes.filter((w) => w.table === "turnover_review_events")).toHaveLength(0);
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
  it("a plain punch item names no 20261091 column, so adding one works before the migration", async () => {
    const res = await addPunchItem({ orgId: "o1", projectId: "p1", title: "Tag the new PSV", location: "  ", description: null, actor });
    expect(res.ok).toBe(true);
    const payload = state.writes.find((w) => w.table === "punch_items" && w.method === "insert")!.payload as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain("description");
    expect(Object.keys(payload)).not.toContain("location");
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

  it("before 20261091 a close meets PostgREST's unknown-column error (PGRST204) — the migration message, not raw text, and nothing audited", async () => {
    state.tableWriteError = { punch_items: { message: "Could not find the 'closed_by_name' column of 'punch_items' in the schema cache", code: "PGRST204" } };
    const res = await setPunchStatus({ item: punch(), status: "done", note: "Insulation reinstalled, verified by ops", actor });
    expect(res).toEqual({ ok: false, error: "This needs the latest database migration applied — nothing was changed." });
    expect(audits()).toHaveLength(0);
  });
});
