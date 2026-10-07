// notifications Round G, N9 — the edit-overlap heads-up:
//
//   TAX-8 done-when 3: a re-declared EXPIRED intent is a new intent. Until N9
//     lib/intents.ts recordIntent upserted on (document, user, kind, source)
//     and kept created_at, so a lapsed row (kept until the daily prune) was
//     revived with its old start, and an overlap re-forming between the same
//     people kept its old formed time — an old dismissal or "Heads-up sent"
//     covered an episode nobody was told about. recordIntent now deletes the
//     caller's own LAPSED row for the key first; a live row is renewed in
//     place (its start kept).
//   TAX-16: "Heads-up sent" is read from the server — the overlap_advisory
//     rows the member wrote (notifications_i_sent, 20261191) — so it holds on
//     every device; sentToEveryoneSince decides it from those rows.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Call = { table: string; op: string; filters: Array<[string, string, unknown]>; payload?: unknown; selected?: string };
const state = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; filters: Array<[string, string, unknown]>; payload?: unknown; selected?: string }>,
  deleteResult: { data: [] as unknown[] | null, error: null as null | { code?: string; message: string } },
  upsertResult: { error: null as null | { code?: string; message: string } },
}));

vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    state.calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = (op: string) => (...args: unknown[]) => { call.filters.push([op, String(args[0]), args[1]]); return b; };
    for (const op of ["eq", "lte", "lt", "gt", "gte", "in", "is"]) b[op] = chain(op);
    b.delete = () => { call.op = "delete"; return b; };
    b.upsert = (payload: unknown) => { call.op = "upsert"; call.payload = payload; return Promise.resolve(state.upsertResult); };
    b.select = (cols: string) => { call.selected = cols; return call.op === "delete" ? Promise.resolve(state.deleteResult) : b; };
    b.maybeSingle = () => Promise.resolve({ data: { current_version_id: "v1" }, error: null });
    return b;
  };
  return { supabase: { from, rpc: vi.fn(async () => ({ data: [], error: null })) } };
});

import { recordIntent } from "@/lib/intents";
import { sentToEveryoneSince, overlapFormedAt } from "@/components/documents/EditOverlapBanner";

beforeEach(() => {
  state.calls = [];
  state.deleteResult = { data: [], error: null };
  state.upsertResult = { error: null };
});

const input = { orgId: "o1", documentId: "d1", libraryId: "lib1", userId: "u1", userName: "U", kind: "edit" as const, source: "checkout" as const, baseVersionId: "v1" };

describe("TAX-8 dw3 — recordIntent replaces an EXPIRED row instead of reviving it", () => {
  it("first deletes the caller's own row for the key whose expiry has passed, then upserts without created_at", async () => {
    const before = Date.now();
    await recordIntent(input as never);
    const intentCalls = state.calls.filter((c) => c.table === "document_intents");
    expect(intentCalls.map((c) => c.op)).toEqual(["delete", "upsert"]);
    const del = intentCalls[0];
    expect(del.filters.filter(([op]) => op === "eq")).toEqual([
      ["eq", "document_id", "d1"], ["eq", "user_id", "u1"], ["eq", "kind", "edit"], ["eq", "source", "checkout"],
    ]);
    const lte = del.filters.find(([op]) => op === "lte")!;
    expect(lte[1]).toBe("expires_at");
    expect(Date.parse(String(lte[2]))).toBeGreaterThanOrEqual(before);
    expect(del.selected).toBe("id");
    const payload = intentCalls[1].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ document_id: "d1", user_id: "u1", kind: "edit", source: "checkout" });
    expect("created_at" in payload).toBe(false);
  });

  it("a delete that is refused only logs — the intent is still recorded (best-effort, as before)", async () => {
    state.deleteResult = { data: null, error: { code: "42501", message: "permission denied" } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await recordIntent(input as never);
    expect(state.calls.filter((c) => c.table === "document_intents").map((c) => c.op)).toEqual(["delete", "upsert"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("a lapsed intent could not be cleared"), "permission denied");
    warn.mockRestore();
  });

  it("a re-formed overlap therefore has a NEW formed time: an old mark no longer covers it", () => {
    const old = [{ userId: "a", createdAt: "2026-09-19T08:00:00.000Z" }, { userId: "b", createdAt: "2026-09-20T09:00:00.000Z" }];
    const reformed = [{ userId: "a", createdAt: "2026-09-19T08:00:00.000Z" }, { userId: "b", createdAt: "2026-09-22T10:00:00.000Z" }];
    expect(overlapFormedAt(reformed)).toBeGreaterThan(overlapFormedAt(old));
  });
});

describe("TAX-16 — 'Heads-up sent' from the rows the member wrote", () => {
  const intents = [
    { userId: "me", createdAt: "2026-10-01T08:00:00.000Z" },
    { userId: "bob", createdAt: "2026-10-01T09:00:00.000Z" },
    { userId: "dee", createdAt: "2026-10-01T10:00:00.000Z" },
  ];
  const formed = Date.parse("2026-10-01T10:00:00.000Z");

  it("sent when every OTHER person in the overlap got one about this document after the overlap formed", () => {
    const sent = [
      { userId: "bob", resourceId: "d1", at: formed + 1000 },
      { userId: "dee", resourceId: "d1", at: formed + 2000 },
    ];
    expect(sentToEveryoneSince(sent, "d1", intents, "me")).toBe(true);
  });

  it("not sent when one person is missing, when the heads-up predates the overlap, or was about another document", () => {
    expect(sentToEveryoneSince([{ userId: "bob", resourceId: "d1", at: formed + 1 }], "d1", intents, "me")).toBe(false);
    expect(sentToEveryoneSince([
      { userId: "bob", resourceId: "d1", at: formed - 1 }, { userId: "dee", resourceId: "d1", at: formed + 1 },
    ], "d1", intents, "me")).toBe(false);
    expect(sentToEveryoneSince([
      { userId: "bob", resourceId: "d2", at: formed + 1 }, { userId: "dee", resourceId: "d1", at: formed + 1 },
    ], "d1", intents, "me")).toBe(false);
    expect(sentToEveryoneSince([], "d1", [{ userId: "me", createdAt: "2026-10-01T08:00:00.000Z" }], "me")).toBe(false);
  });

  it("the banner reads the member's own heads-ups from the server and shows 'Heads-up sent' from them (source pins)", () => {
    const banner = readFileSync(join(process.cwd(), "components/documents/EditOverlapBanner.tsx"), "utf8");
    expect(banner).toContain('import { readNoticesISent } from "@/lib/sentNotices";');
    expect(banner).toMatch(/readNoticesISent\(\{[\s\S]*?kind: "overlap_advisory"[\s\S]*?\}\)/);
    expect(banner).toMatch(/sentFromServer\.has\(/);
    expect(banner).toMatch(/sentToEveryoneSince\(/);
  });
});
