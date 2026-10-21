// document-control Round G — P36 STATUS EDITOR PARITY III: REV-35 in
// lib/staleCopies.ts (ruled by the integrator at the P34 merge, DEC-90).
//
//   A status editor fires its retirement recall BEFORE its duties (P31 ruling
//   4: a closed tab never loses the recall), and its duties tell the checkout
//   holder personally. The recall's watchers' FYI now takes the duties' answer
//   — `personallyToldElsewhere.checkoutHolder` may be a promise — and leaves
//   the holder out of it only when the answer is true (one notice per person);
//   no answer in time, a rejection or `false` leaves them in (a second notice
//   is better than none). Every other recipient exactly as today: the copy
//   holders' recall goes first and is not held back by the wait; the package
//   owners stay in the FYI for the status editors (packageOwners: false); the
//   supersede door's default (both on) is unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  emits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const rows = () => state.tables[table] ?? [];
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null });
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
        return () => new Proxy(c, handler);
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/notify/dispatch", () => ({
  emit: vi.fn(async (payload: Record<string, unknown>) => { state.emits.push(payload); }),
}));
vi.mock("@/lib/audit", () => ({
  logRevisionEvent: vi.fn(async () => ({ ok: true })),
  logAuditAction: vi.fn(async () => ({ ok: true })),
}));

import { recallRetiredDocument, recallRetiredBatch, HOLDER_TOLD_WAIT_MS } from "@/lib/staleCopies";

const fyi = () => state.emits.filter((e) => e.kind === "doc_retired") as Array<{ audience: { followers?: boolean; exclude?: string[] } }>;
const recalls = () => state.emits.filter((e) => e.kind === "doc_recalled");

beforeEach(() => {
  state.tables = {
    // Eli holds a copy? no — the copy holder is u-copy; Eli (eli) has the document checked out
    download_audits: [{ user_id: "u-copy" }],
    documents: [{ id: "d1", status: "Superseded", checked_out_by: "eli" }],
    audit_logs: [],
  };
  state.emits = [];
});

const base = {
  orgId: "org1", documentId: "d1", libraryId: "lib1", docLabel: "P-101",
  newStatus: "Superseded", actorUserId: "dc", actorName: "Document Control",
  recallCopyHolders: true,
} as const;

describe("REV-35 (P36) — recallRetiredDocument: the holder told personally by the door's duties is left out of the watchers' FYI", () => {
  it("the duties answer TRUE: the holder (the live checkout) is excluded from the FYI — one notice per person; the copy holders' recall went first, as before", async () => {
    await recallRetiredDocument({ ...base, personallyToldElsewhere: { checkoutHolder: Promise.resolve(true), packageOwners: false } });
    expect(recalls()).toHaveLength(1);
    expect(fyi()).toHaveLength(1);
    expect(fyi()[0].audience.exclude).toEqual(expect.arrayContaining(["u-copy", "eli"]));
    expect(state.emits.findIndex((e) => e.kind === "doc_recalled")).toBeLessThan(state.emits.findIndex((e) => e.kind === "doc_retired"));
  });

  it("the duties answer FALSE (the notice did not reach them, or nobody was told): the holder stays in the FYI audience, as before", async () => {
    await recallRetiredDocument({ ...base, personallyToldElsewhere: { checkoutHolder: Promise.resolve(false), packageOwners: false } });
    expect(fyi()[0].audience.exclude).toEqual(["u-copy"]);
  });

  it("a rejected answer leaves the holder in (fail-safe: a second notice is better than none)", async () => {
    await recallRetiredDocument({ ...base, personallyToldElsewhere: { checkoutHolder: Promise.reject(new Error("tab closed")), packageOwners: false } });
    expect(fyi()[0].audience.exclude).toEqual(["u-copy"]);
  });

  describe("an answer that never comes", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    it("waits HOLDER_TOLD_WAIT_MS at most, then sends the FYI with the holder in it — the copy holders' recall is never held back", async () => {
      const never = new Promise<boolean>(() => {});
      const run = recallRetiredDocument({ ...base, personallyToldElsewhere: { checkoutHolder: never, packageOwners: false } });
      await vi.advanceTimersByTimeAsync(10);
      expect(recalls()).toHaveLength(1);
      expect(fyi()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(HOLDER_TOLD_WAIT_MS);
      await run;
      expect(fyi()).toHaveLength(1);
      expect(fyi()[0].audience.exclude).toEqual(["u-copy"]);
    });
  });

  it("REGRESSION: `checkoutHolder: false` (every status-door caller with no holder told) leaves the holder in, exactly as before", async () => {
    await recallRetiredDocument({ ...base, personallyToldElsewhere: { checkoutHolder: false, packageOwners: false } });
    expect(fyi()[0].audience.exclude).toEqual(["u-copy"]);
  });

  it("REGRESSION: the supersede door's default (no personallyToldElsewhere — both its notices are its own) still leaves the holder out", async () => {
    await recallRetiredDocument({ ...base });
    expect(fyi()[0].audience.exclude).toEqual(expect.arrayContaining(["u-copy", "eli"]));
  });
});

describe("REV-35 (P36) — recallRetiredBatch: each row's `checkoutHolderTold` decides its own FYI", () => {
  it("a row whose holder was told leaves them out of that row's FYI; a row with no answer keeps its holder in — every other recipient as before", async () => {
    state.tables.download_audits = [];
    await recallRetiredBatch({
      orgId: "org1", newStatus: "Superseded", actorUserId: "dc", actorName: "Document Control",
      docs: [
        { documentId: "d1", libraryId: null, docLabel: "P-101", recallCopyHolders: false, checkoutHolderTold: Promise.resolve(true) },
      ],
    });
    expect(fyi()).toHaveLength(1);
    expect(fyi()[0].audience.exclude).toEqual(["eli"]);
    state.emits = [];
    await recallRetiredBatch({
      orgId: "org1", newStatus: "Superseded", actorUserId: "dc", actorName: "Document Control",
      docs: [{ documentId: "d1", libraryId: null, docLabel: "P-101", recallCopyHolders: false }],
    });
    expect(fyi()[0].audience.exclude).toEqual([]);
  });
});
