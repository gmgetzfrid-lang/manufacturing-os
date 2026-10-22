// drafting-flow Round G, DF-P26 — GAP-102 acceptance 2 (DEC-90 ruling (3)
// for DF-P26): the issue notice carries the request's recorded examination
// data — names and counts only — and a request with none sends exactly
// today's notice (lib/issueNoticeExamination.ts, the pure rules and reads).

import { describe, it, expect } from "vitest";
import { issueExaminationLine, issueExaminationMayExist, readIssueExamination, issueExaminationNote } from "@/lib/issueNoticeExamination";
import type { Ticket, TicketReviewRoster } from "@/types/schema";

const DOC = "d0c00000-0000-4000-8000-000000000001";
type Row = Record<string, unknown>;
const pathGet = (r: Row, key: string): unknown => {
  if (!key.includes("->")) return r[key];
  const parts = key.split(/->>?/);
  let v: unknown = r[parts[0]];
  for (const p of parts.slice(1)) v = v && typeof v === "object" ? (v as Row)[p] : undefined;
  return v;
};
function fakeDb(tables: Record<string, Row[]>, errors: Record<string, { message: string }> = {}, opts: { hang?: string } = {}) {
  const reads: string[] = [];
  const db = {
    from(t: string) {
      reads.push(t);
      const filters: Array<(r: Row) => boolean> = [];
      const b: Record<string, unknown> = {
        select: () => b, order: () => b, limit: () => b,
        eq: (k: string, v: unknown) => { filters.push((r) => pathGet(r, k) === v); return b; },
        is: (k: string, v: unknown) => { filters.push((r) => (pathGet(r, k) ?? null) === v); return b; },
        in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(pathGet(r, k))); return b; },
        maybeSingle: async () => (errors[t] ? { data: null, error: errors[t] } : { data: (tables[t] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => {
          if (opts.hang === t) return undefined;
          return resolve(errors[t] ? { data: null, error: errors[t] } : { data: (tables[t] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
        },
      };
      return b;
    },
  };
  return { db, reads };
}

const CFG = { examinationScope: { fields: [
  { key: "exam", label: "Examination scope", options: [{ value: "rt5", label: "5% RT" }] },
  { key: "gov", label: "Governing code", options: [{ value: "c1", label: "Code one" }] },
], requirements: [] } };
const QA = { id: "s-qa", kind: "qa", label: "Quality", mode: "blocking", primaries: ["q-1"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "satisfied", recordsExamination: true };
const WATCH = { id: "s-w", kind: "watch", label: "Inspection notice", mode: "notify_only", primaries: ["q-2"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "open", recordsExamination: true };
const CHECK = { id: "s-c", kind: "check", label: "Check", mode: "blocking", primaries: ["e-1"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "satisfied" };
const roster = (slots: unknown[]): TicketReviewRoster => ({ v: 1, id: "R1", openedAt: "x", openedBy: "d-1", level: "library", cycle: "1A", contentHash: "h", files: [], slots } as unknown as TicketReviewRoster);
const ticket = (metadata: Row = {}): Ticket => ({ id: "t1", orgId: "o1", requesterId: "req-1", metadata } as unknown as Ticket);
const rec = (files: number, of: number, extra: Row = {}) => ({ examination: { v: 1, act: "sign_off", contentHash: "h", cycle: "1A", files: Array.from({ length: files }, (_, i) => ({ id: `f${i}`, name: `secret-name-${i}.pdf`, sha256: null })), ofFiles: of, allFiles: files === of, note: "a private note", ...extra } });

describe("issueExaminationLine — names and counts only", () => {
  it("nothing recorded → null (today's notice)", () => {
    expect(issueExaminationLine({ scope: [], assurance: [], holds: { total: 0, open: 0 } })).toBeNull();
  });
  it("each part, worded plainly", () => {
    expect(issueExaminationLine({ scope: [{ field: "Examination scope", value: "5% RT" }, { field: "Governing code", value: "Code one" }], assurance: [], holds: { total: 0, open: 0 } }))
      .toBe("Examination data: Examination scope: 5% RT; Governing code: Code one.");
    expect(issueExaminationLine({ scope: [], assurance: [{ slot: "Quality", examined: 2, of: 3, defaulted: false }, { slot: "Weld", examined: 1, of: 1, defaulted: false }, { slot: "Rec", examined: 3, of: 3, defaulted: true }, { slot: "Empty", examined: 0, of: 0, defaulted: false }], holds: { total: 0, open: 0 } }))
      .toBe("Assurance records: Quality (examined 2 of 3 files); Weld (examined all 1 file); Rec (files under review: 3 files, not narrowed); Empty (no files were under review).");
    expect(issueExaminationLine({ scope: [], assurance: [], holds: { total: 2, open: 0 } })).toBe("Holds placed on the source document with what was examined: 2 (released).");
    expect(issueExaminationLine({ scope: [], assurance: [], holds: { total: 2, open: 1 } })).toBe("Holds placed on the source document with what was examined: 2 (1 still in force).");
  });
});

describe("issueExaminationMayExist — no read where nothing could be recorded", () => {
  it("unconfigured: false; any one source: true", () => {
    expect(issueExaminationMayExist({ ticket: ticket(), draftingCfg: null, roster: null })).toBe(false);
    expect(issueExaminationMayExist({ ticket: ticket(), draftingCfg: { requestTypes: { options: [] } }, roster: roster([CHECK]) })).toBe(false);
    expect(issueExaminationMayExist({ ticket: ticket(), draftingCfg: CFG, roster: null })).toBe(true);
    expect(issueExaminationMayExist({ ticket: ticket(), draftingCfg: null, roster: roster([CHECK, QA]) })).toBe(true);
    expect(issueExaminationMayExist({ ticket: ticket({ source_document: { id: DOC }, review_roster: roster([CHECK, WATCH]) }), draftingCfg: null, roster: null })).toBe(true);
    expect(issueExaminationMayExist({ ticket: ticket({ review_roster: roster([CHECK, WATCH]) }), draftingCfg: null, roster: null })).toBe(false);
  });
  it("issueExaminationNote makes NO read where nothing could exist", async () => {
    const { db, reads } = fakeDb({});
    expect(await issueExaminationNote(db, { ticket: ticket(), ticketId: "t1", orgId: "o1", draftingCfg: null, roster: roster([CHECK]) })).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe("readIssueExamination", () => {
  it("scope values by the workspace's labels (a value since dropped from the list is shown as recorded); a field not configured is left out", async () => {
    const { db } = fakeDb({ ticket_examination_scopes: [{ ticket_id: "t1", field_values: { exam: { value: "rt5", by: "e-1", at: "x" }, gov: { value: "old-code", by: "e-1", at: "x" }, gone: { value: "z", by: "e-1", at: "x" } } }] });
    const s = await readIssueExamination(db, { ticket: ticket(), ticketId: "t1", orgId: "o1", draftingCfg: CFG, roster: null });
    expect(s.scope).toEqual([{ field: "Examination scope", value: "5% RT" }, { field: "Governing code", value: "old-code" }]);
  });
  it("assurance: the latest record per assurance slot of the issuing roster; never a note or a file name", async () => {
    const { db } = fakeDb({ ticket_review_slot_events: [
      { ticket_id: "t1", roster_id: "R1", event: "satisfied", slot_kind: "qa", details: rec(1, 2) },
      { ticket_id: "t1", roster_id: "R1", event: "satisfied", slot_kind: "qa", details: rec(2, 2) },
      { ticket_id: "t1", roster_id: "R0", event: "satisfied", slot_kind: "qa", details: rec(0, 9) },
    ] });
    const s = await readIssueExamination(db, { ticket: ticket(), ticketId: "t1", orgId: "o1", draftingCfg: null, roster: roster([CHECK, QA]) });
    expect(s.assurance).toEqual([{ slot: "Quality", examined: 2, of: 2, defaulted: false }]);
    const line = issueExaminationLine(s)!;
    expect(line).toBe("Assurance records: Quality (examined all 2 files).");
    expect(line).not.toMatch(/secret-name|private note/);
  });
  it("holds: only those whose opener is the notify-only slot's person count (released or not)", async () => {
    const examination = { stop: "hold", ticketId: "t1", rosterId: "R1", slotKind: "watch", contentHash: "h", files: [], ofFiles: 0, note: "private" };
    const t = ticket({ source_document: { id: DOC }, review_roster: roster([CHECK, WATCH]) });
    const { db } = fakeDb({ document_holds: [
      { org_id: "o1", document_id: DOC, opened_by: "q-2", released_at: "2026-10-21T00:00:00Z", examination },
      { org_id: "o1", document_id: DOC, opened_by: "q-1", released_at: null, examination },
      { org_id: "o1", document_id: DOC, opened_by: "q-2", released_at: null, examination: { ...examination, ticketId: "t-other" } },
    ] });
    const s = await readIssueExamination(db, { ticket: t, ticketId: "t1", orgId: "o1", draftingCfg: null, roster: null });
    expect(s.holds).toEqual({ total: 1, open: 0 });
  });
  it("DF-P26 fix pass 3: an earlier round's hold is judged against that round's ledger slots, as the stop judges it — counted; a failed ledger read leaves only it out", async () => {
    const examination = { stop: "hold", ticketId: "t1", rosterId: "R0", slotKind: "watch", contentHash: "h", files: [], ofFiles: 0, note: "private" };
    // round 2 carries no opted-in slot of its own, only the mark that an earlier round did
    const t = ticket({ source_document: { id: DOC }, review_roster: { ...roster([CHECK]), notifyHoldRecordsEarlier: true } });
    const holds = [
      { org_id: "o1", document_id: DOC, opened_by: "q-2", released_at: "2026-10-21T00:00:00Z", examination },
      { org_id: "o1", document_id: DOC, opened_by: "q-1", released_at: null, examination },
    ];
    const ledger = [{ org_id: "o1", ticket_id: "t1", roster_id: "R0", slot_kind: "watch", label: "Inspection notice", mode: "notify_only", primaries: ["q-2"], alternates: [] }];
    const ok = fakeDb({ document_holds: holds, ticket_review_slots: ledger });
    const s = await readIssueExamination(ok.db, { ticket: t, ticketId: "t1", orgId: "o1", draftingCfg: null, roster: null });
    expect(s.holds).toEqual({ total: 1, open: 0 });
    expect(ok.reads).toEqual(["document_holds", "ticket_review_slots"]);
    const down = fakeDb({ document_holds: holds }, { ticket_review_slots: { message: "timeout" } });
    expect((await readIssueExamination(down.db, { ticket: t, ticketId: "t1", orgId: "o1", draftingCfg: null, roster: null })).holds).toEqual({ total: 0, open: 0 });
    // REGRESSION: a hold of the current round reads no ledger
    const cur = fakeDb({ document_holds: [{ ...holds[0], examination: { ...examination, rosterId: "R1" } }] });
    expect((await readIssueExamination(cur.db, { ticket: ticket({ source_document: { id: DOC }, review_roster: roster([CHECK, WATCH]) }), ticketId: "t1", orgId: "o1", draftingCfg: null, roster: null })).holds).toEqual({ total: 1, open: 0 });
    expect(cur.reads).toEqual(["document_holds"]);
  });
  it("a read that fails leaves its part out — never throws; a request with configured fields but nothing recorded has no line", async () => {
    const { db } = fakeDb({ ticket_review_slot_events: [{ ticket_id: "t1", roster_id: "R1", event: "satisfied", slot_kind: "qa", details: rec(1, 1) }] }, { ticket_examination_scopes: { message: "timeout" } });
    const s = await readIssueExamination(db, { ticket: ticket(), ticketId: "t1", orgId: "o1", draftingCfg: CFG, roster: roster([CHECK, QA]) });
    expect(s.scope).toEqual([]);
    expect(s.assurance).toHaveLength(1);
    const none = fakeDb({});
    expect(await issueExaminationNote(none.db, { ticket: ticket(), ticketId: "t1", orgId: "o1", draftingCfg: CFG, roster: null })).toBeNull();
    expect(none.reads).toEqual(["ticket_examination_scopes"]);
  });
  it("past the deadline the notice goes out as today's (null)", async () => {
    const { db } = fakeDb({}, {}, { hang: "ticket_review_slot_events" });
    expect(await issueExaminationNote(db, { ticket: ticket(), ticketId: "t1", orgId: "o1", draftingCfg: null, roster: roster([CHECK, QA]) }, 20)).toBeNull();
  });
});
