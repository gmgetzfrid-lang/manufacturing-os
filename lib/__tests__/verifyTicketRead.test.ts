// public-surfaces Round F PS-VERIFY review fix — /api/verify-ticket's READ
// (VFY-12 evidence, VFY-14's route). The verdict is drafting-flow's and is
// untouched (lib/__tests__/sweepRoundE_A.test.ts pins it); this pins only
// how the route answers when the tickets read itself fails: an outage is
// 503 "try again" with an 'error' scan row — never 404 "Unknown ticket"
// with an 'unknown' row, which would make an outage read as enumeration in
// the scan evidence, as the other three verify routes already separate.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const T = "55555555-5555-5555-5555-555555555555";

const state = vi.hoisted(() => ({
  ticket: null as Record<string, unknown> | null,
  ticketError: false as boolean,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

function chain(table: string) {
  let head = false;
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") {
        return (resolve: (v: unknown) => void) => resolve(head ? { data: null, error: null, count: 0 } : { data: null, error: null });
      }
      return (...args: unknown[]) => {
        if (p === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (p === "insert") {
          state.inserts.push({ table, row: args[0] as Record<string, unknown> });
          return Promise.resolve({ error: null });
        }
        if (p === "maybeSingle") {
          if (table === "tickets") {
            return Promise.resolve(state.ticketError
              ? { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }
              : { data: state.ticket, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  state.ticket = null;
  state.ticketError = false;
  state.inserts = [];
});

async function call(rev = "2") {
  const { GET } = await import("@/app/api/verify-ticket/route");
  const u = new URL("https://app/api/verify-ticket");
  u.searchParams.set("t", T);
  u.searchParams.set("r", rev);
  return GET(new NextRequest(u));
}
const scanVerdicts = () => state.inserts.filter((i) => i.table === "verify_scans").map((i) => i.row.verdict);

describe("/api/verify-ticket — an unreadable ticket is an outage, not an unknown code", () => {
  it("a tickets read that ERRORS → 503 'try again', no-store, and the scan row says 'error' (never 'unknown')", async () => {
    state.ticketError = true;
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toBe("Verification unavailable — try again");
    expect(scanVerdicts()).toEqual(["error"]);
  });
  it("a ticket that is genuinely not there is still 404 'Unknown ticket' with an 'unknown' row", async () => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("Unknown ticket");
    expect(scanVerdicts()).toEqual(["unknown"]);
  });
  it("a readable ticket still gets drafting-flow's verdict, recorded as shown", async () => {
    state.ticket = { id: T, ticket_id: "DR-7", title: "Iso", unit: "U-200", status: "APPROVED", deliverable_rev: "2", last_modified: null, history: [] };
    const res = await call("2");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { verdict: string }).verdict).toBe("current");
    expect(scanVerdicts()).toEqual(["current"]);
  });
});
