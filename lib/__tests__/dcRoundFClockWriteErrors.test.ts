// document-control Round F wave 2 — P12 WAVE-2 RESIDUALS, integration fix
// (REV-15 done-when 1): the compliance-clock helpers REPORT the write errors
// they do not throw on, to a caller that asks — and behave exactly as before
// for every caller that does not.
//
//   onDocumentIssued (lib/reviewCycles.ts)       the review-basis reset and
//       the next_review_date write (unchecked before) → `writeErrors`; the
//       certification event still THROWS (DRLS-4), with or without it.
//   onDocumentIssuedAck (lib/acknowledgments.ts)  each roster write's error
//       (the stale-revision void, the no-policy void, the roster insert) and
//       a recompute that stopped on an error → `writeErrors`; it still never
//       throws.
//
// Driven against the in-memory PostgREST (helpers/fakeSupabase) with the
// REAL helpers; only the bell, the audit row and the owner lookup are stubbed.
// "Unchanged" is proven by running each scenario twice — once with no sink
// (what lib/postPublish.ts and every other existing caller passes) and once
// with one — and comparing every database call, the outcome and the logs.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  notifyThrows: false,
  notified: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() { return makeFakeSupabase(state.db); },
}));
vi.mock("@/lib/inAppNotifications", () => ({
  notify: vi.fn(async (n: Record<string, unknown>) => {
    if (state.notifyThrows) throw new Error("bell unavailable");
    state.notified.push(n);
  }),
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn() }));
vi.mock("@/lib/ownership", () => ({
  resolveEffectiveOwner: vi.fn(),
  teamSupervisorMap: vi.fn(),
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: "owner1" })),
  getOrgControllers: vi.fn(async () => ["dc1"]),
}));

import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";

const ORG = "o1";
const DOC = "d1";
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const T = (t: string) => (state.db.tables[t] ??= []);
const raise = (message: string) => { throw { code: "42501", message }; };

function seed(opts: { review?: boolean; ack?: boolean } = {}) {
  state.db = newFakeDb();
  state.notifyThrows = false;
  state.notified = [];
  T("libraries").push({
    id: "lib1", org_id: ORG,
    review_policy: opts.review === false ? null : { enabled: true, intervalCount: 2, intervalUnit: "years" },
    ack_policy: opts.ack === false ? null : { enabled: true, assigneeIds: ["op1"] },
  });
  T("documents").push({
    id: DOC, org_id: ORG, library_id: "lib1", collection_id: null, status: "Issued", current_version_id: "v1",
    document_number: "P-101", title: "P-101", name: "P-101", review_policy: null, ack_policy: null,
    owner_user_id: "owner1", owner_name: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  });
  T("document_versions").push({ id: "v1", record_id: DOC, revision_label: "0", file_hash: "h" });
  T("org_members").push({ org_id: ORG, uid: "op1", display_name: "Op One", email: "op1@x", status: "active" });
}

/** Run a scenario twice — no sink, then a sink — on identically seeded
 *  databases; return both runs' database calls, outcomes and logs. */
async function twice(
  arrange: () => void,
  act: (writeErrors?: string[]) => Promise<void>,
) {
  const runs: Array<{ calls: string[]; outcome: string; warned: string[]; tables: string; sink?: string[] }> = [];
  for (const withSink of [false, true]) {
    arrange();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink: string[] | undefined = withSink ? [] : undefined;
    let outcome = "resolved";
    try { await act(sink); } catch (e) { outcome = `threw: ${(e as Error).message}`; }
    const warned = warn.mock.calls.map((c) => c.map(String).join(" "));
    warn.mockRestore();
    runs.push({
      calls: state.db.calls.map((c) => `${c.table}.${c.method}`),
      outcome, warned,
      // the writes that LANDED (timestamps stripped — two runs, two clocks)
      tables: JSON.stringify(state.db.tables, (k, v) => (/_at$/.test(k) ? "<t>" : v)),
      sink,
    });
  }
  const [without, withSink] = runs;
  // the sink changes nothing but itself
  expect(withSink.calls).toEqual(without.calls);
  expect(withSink.outcome).toBe(without.outcome);
  expect(withSink.warned).toEqual(without.warned);
  expect(withSink.tables).toBe(without.tables);
  return { without, sink: withSink.sink! };
}

beforeEach(() => { seed(); vi.clearAllMocks(); });

describe("REV-15 — onDocumentIssued reports the two clock writes it does not throw on, and nothing else changes", () => {
  it("every write answers cleanly: the clock is reset, the next date and the 'issued' event written — the sink stays empty", async () => {
    const { without, sink } = await twice(() => seed(), (w) => onDocumentIssued({ orgId: ORG, documentId: DOC, userId: "u1", userName: "u1@x", writeErrors: w }));
    expect(without.outcome).toBe("resolved");
    expect(sink).toEqual([]);
    expect(T("documents")[0].last_reviewed_by).toBe("u1");
    expect(T("documents")[0].next_review_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(T("document_review_events").map((e) => e.action)).toEqual(["issued"]);
  });

  it("the review-basis reset and the next_review_date write each answer an error: both are reported; the call still resolves, as it did", async () => {
    const arrange = () => {
      seed();
      state.db.beforeUpdate!.documents = (next, old) => {
        if (next.last_reviewed_at !== old.last_reviewed_at) raise("reset refused");
        if (next.next_review_date !== old.next_review_date) raise("date refused");
        return next;
      };
    };
    const { without, sink } = await twice(arrange, (w) => onDocumentIssued({ orgId: ORG, documentId: DOC, userId: "u1", writeErrors: w }));
    expect(without.outcome).toBe("resolved"); // never threw on these two — unchanged
    expect(sink).toEqual([
      "the review clock could not be reset to this issue (reset refused)",
      "the next review date could not be saved (date refused)",
    ]);
  });

  it("a refused certification event still THROWS, with or without a sink (DRLS-4 — unchanged)", async () => {
    const arrange = () => { seed(); state.db.refuseWrites.add("document_review_events"); };
    const { without, sink } = await twice(arrange, (w) => onDocumentIssued({ orgId: ORG, documentId: DOC, userId: "u1", writeErrors: w }));
    expect(without.outcome).toMatch(/^threw: The review was applied but its certification event could NOT be written/);
    expect(sink).toEqual([]);
  });
});

describe("REV-15 — onDocumentIssuedAck reports each roster write error and a recompute that stopped; it still never throws", () => {
  it("the roster opens cleanly: one pending row for the assignee, notified — the sink stays empty", async () => {
    const { without, sink } = await twice(() => seed(), (w) => onDocumentIssuedAck({ orgId: ORG, documentId: DOC, actorId: "u1", writeErrors: w }));
    expect(without.outcome).toBe("resolved");
    expect(sink).toEqual([]);
    expect(T("document_acknowledgments").map((r) => [r.assignee_user_id, r.status])).toEqual([["op1", "pending"]]);
  });

  it("the roster insert is refused: reported (as the owner / controllers are already told), never thrown", async () => {
    const arrange = () => { seed(); state.db.refuseWrites.add("document_acknowledgments"); };
    const { without, sink } = await twice(arrange, (w) => onDocumentIssuedAck({ orgId: ORG, documentId: DOC, actorId: "u1", writeErrors: w }));
    expect(without.outcome).toBe("resolved");
    expect(sink).toEqual(["the acknowledgment roster could not be saved (new row violates row-level security policy)"]);
    // the existing gap notice to the owner + Document Control is still sent
    expect(state.notified.map((n) => n.kind)).toEqual(["ack_unsatisfiable", "ack_unsatisfiable"]);
  });

  it("the stale-revision void answers an error: reported, and the roster still opens", async () => {
    const arrange = () => {
      seed();
      T("document_acknowledgments").push({ id: "a0", document_id: DOC, document_version_id: "v0", assignee_user_id: "op1", status: "pending" });
      state.db.beforeUpdate!.document_acknowledgments = () => raise("void refused");
    };
    const { without, sink } = await twice(arrange, (w) => onDocumentIssuedAck({ orgId: ORG, documentId: DOC, actorId: "u1", writeErrors: w }));
    expect(without.outcome).toBe("resolved");
    expect(sink).toEqual(["the acknowledgment rows of an older revision could not be voided (void refused)"]);
  });

  it("no policy and the void of the pending rows answers an error: reported", async () => {
    const arrange = () => {
      seed({ ack: false });
      T("document_acknowledgments").push({ id: "a1", document_id: DOC, document_version_id: "v1", assignee_user_id: "op1", status: "pending" });
      state.db.beforeUpdate!.document_acknowledgments = () => raise("void refused");
    };
    const { without, sink } = await twice(arrange, (w) => onDocumentIssuedAck({ orgId: ORG, documentId: DOC, actorId: "u1", writeErrors: w }));
    expect(without.outcome).toBe("resolved");
    expect(sink).toEqual(["the pending acknowledgment rows could not be voided (void refused)"]);
  });

  it("the recompute throws part-way (here the bell, after the roster saved): still swallowed and logged as before, and now reported", async () => {
    const arrange = () => { seed(); state.notifyThrows = true; };
    const { without, sink } = await twice(arrange, (w) => onDocumentIssuedAck({ orgId: ORG, documentId: DOC, actorId: "u1", writeErrors: w }));
    expect(without.outcome).toBe("resolved");
    expect(without.warned.some((l) => l.startsWith("[ack] onDocumentIssued failed"))).toBe(true);
    expect(sink).toEqual(["opening the acknowledgment roster stopped on an error (bell unavailable)"]);
    expect(T("document_acknowledgments")).toHaveLength(1); // the roster itself had saved
  });
});

describe("REV-15 — every other caller of the two helpers passes no sink, so it runs the unchanged path above", () => {
  it("lib/postPublish.ts (a rev-up's pipeline) calls both without writeErrors, each in its own best-effort try", () => {
    const pp = src("lib/postPublish.ts");
    expect(pp).toMatch(/try \{\s*\n\s*await onDocumentIssued\(\{ orgId: input\.orgId, documentId: input\.documentId, userId: input\.actorUserId, userName: input\.actorEmail \?\? input\.actorName \}\);\s*\n\s*\} catch \{ \/\* best-effort \*\/ \}/);
    expect(pp).toMatch(/try \{\s*\n\s*await onDocumentIssuedAck\(\{ orgId: input\.orgId, documentId: input\.documentId, actorId: input\.actorUserId, actorName: input\.actorEmail \?\? input\.actorName \}\);\s*\n\s*\} catch \{ \/\* best-effort \*\/ \}/);
    expect(pp).not.toMatch(/writeErrors/);
  });
  it("the helpers' other internal callers (markReviewed, setReviewPolicy, setAckPolicy) pass no sink either", () => {
    const rc = src("lib/reviewCycles.ts");
    const calls = rc.match(/recomputeDocument\([^)]*\)/g) ?? [];
    expect(calls.filter((c) => !c.startsWith("recomputeDocument(documentId: string"))).toEqual([
      "recomputeDocument(input.documentId)",          // markReviewed
      "recomputeDocument(input.documentId, input.writeErrors)", // onDocumentIssued
      "recomputeDocument(input.id)",                  // setReviewPolicy (document)
      "recomputeDocument(id)",                        // setReviewPolicy (library / folder)
    ]);
    const ack = src("lib/acknowledgments.ts");
    const recomputes = ack.match(/await recomputeDocumentAck\(\{[^}]*\}\)|recomputeDocumentAck\(\{ orgId: input\.orgId, documentId: id[^}]*\}\)/g) ?? [];
    expect(recomputes.filter((c) => /writeErrors/.test(c))).toEqual([
      "await recomputeDocumentAck({ orgId: input.orgId, documentId: input.documentId, actorId: input.actorId, actorName: input.actorName, writeErrors: input.writeErrors })",
    ]);
    expect(recomputes.length).toBeGreaterThanOrEqual(3);
  });
});
