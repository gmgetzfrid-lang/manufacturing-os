// public-surfaces Round F PS-VERIFY — /api/verify-hold (VFY-10 = PHYS-10,
// VFY-6, VFY-14, VFY-12 / VFY-13).
//
// A released hold card reads GREEN only when no other hold is active on the
// same document; released-with-siblings (or with siblings that could not be
// read) is AMBER. Operator text never leaves; the row is typed to the select.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const DOC = "22222222-2222-2222-2222-222222222222";
const HOLD = "33333333-3333-3333-3333-333333333333";
const SIB = "44444444-4444-4444-4444-444444444444";

const state = vi.hoisted(() => ({
  holds: [] as Array<Record<string, unknown>>,
  docs: [] as Array<Record<string, unknown>>,
  /** Fail the Nth document_holds read (1-based); 0 = never. */
  failHoldRead: 0 as number,
  holdReads: 0 as number,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  selects: [] as Array<{ table: string; cols: string }>,
}));

function chain(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const isNull: string[] = [];
  let head = false;
  let readNo = 0;
  const rows = () => {
    const src = table === "document_holds" ? state.holds : table === "documents" ? state.docs : [];
    return src.filter((r) => eqs.every(([k, v]) => r[k] === v) && isNull.every((k) => r[k] == null));
  };
  const failing = () => table === "document_holds" && state.failHoldRead > 0 && readNo === state.failHoldRead;
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") return (resolve: (v: unknown) => void) => {
        if (head) return resolve({ data: null, error: null, count: 0 });
        if (failing()) return resolve({ data: null, error: { message: "read failed" } });
        resolve({ data: rows(), error: null });
      };
      return (...args: unknown[]) => {
        if (p === "select") {
          state.selects.push({ table, cols: String(args[0]) });
          if ((args[1] as { head?: boolean } | undefined)?.head) head = true;
          if (table === "document_holds" && !head) readNo = ++state.holdReads;
        }
        if (p === "insert") state.inserts.push({ table, row: args[0] as Record<string, unknown> });
        if (p === "eq") eqs.push([String(args[0]), args[1]]);
        if (p === "is" && args[1] === null) isNull.push(String(args[0]));
        if (p === "maybeSingle") {
          if (failing()) return Promise.resolve({ data: null, error: { message: "read failed" } });
          return Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));

const hold = (over: Record<string, unknown> = {}) => ({
  id: HOLD, document_id: DOC, reason: "Missing Vendor Data", opened_at: "2026-09-01T00:00:00Z", released_at: null,
  held_rev_label: "3", notes: "waiting on legal", opened_by_name: "Pat", ...over,
});

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  state.holds = [];
  state.docs = [{ id: DOC, document_number: "V-101", title: "Vessel", name: "v", rev: "5" }];
  state.failHoldRead = 0;
  state.holdReads = 0;
  state.inserts = [];
  state.selects = [];
});

async function call(id = HOLD) {
  const { GET } = await import("@/app/api/verify-hold/route");
  const u = new URL("https://app/api/verify-hold"); u.searchParams.set("id", id);
  return GET(new NextRequest(u));
}
async function verify(id = HOLD) {
  const res = await call(id);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
}

describe("VFY-10 / PHYS-10 — green only when no hold at all remains on the document", () => {
  it("released, with another hold still active → released_others_active, the sibling counted and named by category", async () => {
    state.holds = [
      hold({ released_at: "2026-09-20T00:00:00Z" }),
      hold({ id: SIB, reason: "Field Verification Needed", released_at: null }),
    ];
    const { body } = await verify();
    expect(body.active).toBe(false);
    expect(body.verdict).toBe("released_others_active");
    expect(body.otherActiveHolds).toBe(1);
    expect(body.otherHoldReasons).toEqual(["Field Verification Needed"]);
  });
  it("released, nothing else active → released (the only green)", async () => {
    state.holds = [hold({ released_at: "2026-09-20T00:00:00Z" }), hold({ id: SIB, released_at: "2026-09-21T00:00:00Z" })];
    const { body } = await verify();
    expect(body.verdict).toBe("released");
    expect(body.otherActiveHolds).toBe(0);
  });
  it("an active hold never counts itself among the others", async () => {
    state.holds = [hold(), hold({ id: SIB, reason: "Client Review" })];
    const { body } = await verify();
    expect(body.verdict).toBe("active");
    expect(body.otherActiveHolds).toBe(1);
    expect(body.otherHoldReasons).toEqual(["Client Review"]);
  });
  it("a sibling read that fails → released_others_unknown (amber), never green", async () => {
    state.holds = [hold({ released_at: "2026-09-20T00:00:00Z" })];
    state.failHoldRead = 2; // the hold itself reads; the sibling read fails
    const { body } = await verify();
    expect(body.verdict).toBe("released_others_unknown");
    expect(body.otherActiveHolds).toBeNull();
  });
  it("the hold read itself failing is a 503 (the page says: treat the hold as ACTIVE)", async () => {
    state.holds = [hold()];
    state.failHoldRead = 1;
    const { status } = await verify();
    expect(status).toBe(503);
  });
});

describe("VFY-6 — operator text never leaves; the page is told it was withheld", () => {
  it("a custom reason → 'On hold' with reasonWithheld; a sibling's custom reason is a category too", async () => {
    state.holds = [
      hold({ reason: "Hold per legal — Fuller incident, do not distribute" }),
      hold({ id: SIB, reason: "ask Dana before lifting" }),
    ];
    const { body } = await verify();
    expect(body.reason).toBe("On hold");
    expect(body.reasonWithheld).toBe(true);
    expect(body.otherHoldReasons).toEqual(["On hold"]);
    const json = JSON.stringify(body);
    expect(json).not.toContain("Fuller");
    expect(json).not.toContain("Dana");
    expect(json).not.toContain("waiting on legal");
    expect(json).not.toContain("Pat");
  });
  it("a predefined reason is shown and not marked withheld", async () => {
    state.holds = [hold({ reason: "Client Review" })];
    const { body } = await verify();
    expect(body).toMatchObject({ reason: "Client Review", reasonWithheld: false });
  });
});

describe("VFY-14 — selects name only the published columns; the row is an explicit interface", () => {
  it("no notes / names / release reason are ever selected", async () => {
    state.holds = [hold()];
    await verify();
    for (const s of state.selects.filter((x) => x.table === "document_holds")) {
      expect(s.cols).not.toMatch(/notes|opened_by_name|released_by_name|released_reason/);
    }
    const src = readFileSync(join(process.cwd(), "app/api/verify-hold/route.ts"), "utf8");
    expect(src).not.toContain("as Record<string, unknown>");
    expect(src).toContain("const h = holdData as HoldRow;");
  });
});

describe("VFY-12 / VFY-13 — scan record and no-store", () => {
  it("records one row with the verdict; every answer (including 400 / 404) is no-store", async () => {
    state.holds = [hold({ released_at: "2026-09-20T00:00:00Z" })];
    const { res } = await verify();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bad = await call("nope");
    expect(bad.status).toBe(400);
    expect(bad.headers.get("cache-control")).toBe("no-store");
    state.holds = [];
    const missing = await call();
    expect(missing.status).toBe(404);
    expect(state.inserts.filter((i) => i.table === "verify_scans").map((i) => [i.row.endpoint, i.row.verdict, i.row.target_id])).toEqual([
      ["verify-hold", "released", HOLD],
      ["verify-hold", "invalid", null],
      ["verify-hold", "unknown", HOLD],
    ]);
  });
});
