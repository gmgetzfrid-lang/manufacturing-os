// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS, final
// review: GAP-9's register read (lib/docControlRegister.ts loadFieldOutcomes)
// ran its 150-document chunks strictly one after another, every page asking
// an exact count. It now reads up to a few chunks at once — bounded — and
// asks the count only until an answer carries it (the truncation check's
// input), while the answer is the serial read's: every row, in each
// document's order, and the first failing chunk's error.
//
// Timing-insensitive: every checkout_sessions read is held until the next
// macrotask (later chunks released FIRST), and the test counts how many are
// in flight at once — a strictly serial read never has more than one.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  inFlight: 0,
  maxInFlight: 0,
  reads: 0,
  /** document ids whose chunk's read answers an error */
  failFor: null as null | string,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return {
      ...base,
      from: (t: string) => {
        const b = base.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (t !== "checkout_sessions") return b;
        let fails = false;
        let chunkFirst = "";
        const p: Record<string, unknown> = new Proxy(b, {
          get(target, prop: string) {
            if (prop === "then") {
              return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
                state.inFlight += 1;
                state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
                const order = ++state.reads;
                // later reads are released first: completion order is the reverse of issue order
                return new Promise((r) => setTimeout(r, Math.max(1, 40 - order * 5))).then(() => {
                  state.inFlight -= 1;
                  if (fails) return { data: null, error: { message: `statement timeout (chunk from ${chunkFirst})` } };
                  return new Promise((r2) => (target.then as unknown as (a: (v: unknown) => void) => void)(r2));
                }).then(res, rej);
              };
            }
            return (...a: unknown[]) => {
              if (prop === "in" && a[0] === "document_id") {
                const ids = a[1] as string[];
                chunkFirst = ids[0];
                if (state.failFor && ids.includes(state.failFor)) fails = true;
              }
              target[prop](...a);
              return p;
            };
          },
        });
        return p;
      },
    };
  },
}));
vi.mock("@/lib/acknowledgments", () => ({ getAckSummaries: vi.fn(async () => new Map()), ackStatusFor: () => "none" }));
vi.mock("@/lib/reviewControl", () => ({ getReviewSummaries: vi.fn(async () => new Map()) }));
vi.mock("@/lib/ownership", () => ({
  resolveEffectiveOwner: () => ({ userId: null, name: null, source: null }),
  teamSupervisorMap: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn() }));

import { loadDocControlRegister } from "@/lib/docControlRegister";

const ORG = "o1";
const T = (t: string) => (state.db.tables[t] ??= []);
const EVERY_3Y = { enabled: true, intervalCount: 12, intervalUnit: "months", leadDays: 30, fieldVerifyIntervalCount: 3, fieldVerifyIntervalUnit: "years" };
const daysAgo = (days: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - days); return d.toISOString(); };

/** 1000 controlled documents (7 chunks: 6 × 150 + 100). Every 7th has a
 *  walkdown history: an old verification, a later discrepancy for every
 *  14th, and a fresh verification for every 21st. */
function seed() {
  T("libraries").push({ id: "L1", org_id: ORG, name: "P&IDs", retention_policy: null, review_policy: EVERY_3Y });
  T("collections"); T("org_members"); T("distribution_acks");
  for (let i = 0; i < 1000; i++) {
    const id = `d${String(i).padStart(4, "0")}`;
    T("documents").push({
      id, org_id: ORG, library_id: "L1", collection_id: null, status: null, document_number: id.toUpperCase(), title: null, name: null,
      rev: "3", updated_at: `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}Z`, owner_user_id: null, owner_name: null, next_review_date: null, pending_version_id: null,
      effective_date: null, retention_until: null, disposition_state: null, legal_hold: false, retention_policy: null, review_policy: null,
      origin: null, external_source: null, external_reference: null, current_version_id: `${id}-v`,
    });
    if (i % 7 !== 0) continue;
    const s = (sid: string, outcome: string, at: string) => T("checkout_sessions").push({ id: `${id}-${sid}`, org_id: ORG, document_id: id, outcome, ended_at: at, user_name: "Ann", outcome_ref: { rev: "3" } } as Row);
    s("a", "field_verified", daysAgo(400));
    if (i % 14 === 0) s("b", "discrepancy", daysAgo(200));
    if (i % 21 === 0) s("c", "field_verified", daysAgo(10));
  }
}
/** What the serial read answered for document i (the seed's own truth). */
function expected(i: number): string {
  if (i % 7 !== 0) return "never";
  if (i % 21 === 0) return "current";
  if (i % 14 === 0) return "discrepancy";
  return "current"; // verified 400 days ago, 3-year cadence
}

beforeEach(() => {
  state.db = newFakeDb();
  state.inFlight = 0; state.maxInFlight = 0; state.reads = 0; state.failFor = null;
});

describe("GAP-9 (P14 final review) — the register's walkdown chunks are read a few at a time, with the serial read's answer", () => {
  it("more than one chunk is in flight at once, and never more than the bound", async () => {
    seed();
    await loadDocControlRegister(ORG);
    const chunks = state.db.calls.filter((c) => c.table === "checkout_sessions" && c.method === "in" && c.args[0] === "document_id");
    expect(chunks.map((c) => (c.args[1] as string[]).length).sort((a, b) => b - a)).toEqual([150, 150, 150, 150, 150, 150, 100]);
    expect(state.maxInFlight).toBeGreaterThan(1); // the serial read: exactly 1
    expect(state.maxInFlight).toBeLessThanOrEqual(6);
  });

  it("the answer is the serial read's for every document, though later chunks completed first", async () => {
    seed();
    const { rows } = await loadDocControlRegister(ORG);
    expect(rows).toHaveLength(1000);
    for (const r of rows) {
      const i = Number(r.id.slice(1));
      expect(r.fieldVerification?.status, r.id).toBe(expected(i));
    }
    // a discrepancy-superseded verification and a fresh one each kept their own rows
    expect(rows.find((r) => r.id === "d0014")?.fieldVerification).toMatchObject({ status: "discrepancy" });
    expect(rows.find((r) => r.id === "d0021")?.fieldVerification).toMatchObject({ status: "current" });
  });

  it("the exact count is asked once per chunk (its first page), not on every page", async () => {
    seed();
    await loadDocControlRegister(ORG);
    const selects = state.db.calls.filter((c) => c.table === "checkout_sessions" && c.method === "select");
    expect(selects).toHaveLength(7); // one page per chunk here
    expect(selects.every((c) => (c.args[1] as { count?: string } | undefined)?.count === "exact")).toBe(true);
  });

  it("a chunk that fails is the register's error (every row unknown) — never 'never verified'", async () => {
    seed();
    state.failFor = "d0450";
    const { rows } = await loadDocControlRegister(ORG);
    for (const r of rows) expect(r.fieldVerification, r.id).toMatchObject({ status: "unknown" });
    // the failing chunk's own error (the register orders its documents by updated_at, so name the chunk by its first id)
    const failing = state.db.calls.find((c) => c.table === "checkout_sessions" && c.method === "in" && c.args[0] === "document_id" && (c.args[1] as string[]).includes("d0450"));
    const first = (failing!.args[1] as string[])[0];
    expect(rows[0].fieldVerification?.unknownReason).toBe(`the check-in register could not be read (statement timeout (chunk from ${first}))`);
  });
});
