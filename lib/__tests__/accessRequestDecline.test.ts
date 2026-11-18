// /api/admin/access-requests decline (EGRESS-5 follow-through).
//
// The public request door 409s while a request is pending, so decline is the
// only way to unblock an address the org will not admit. Authority is the
// org the STORED request names — not anything in the body — checked against
// the caller's active membership, additively.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "admin1" } as { id: string } | null,
  request: null as Record<string, unknown> | null,
  member: null as Record<string, unknown> | null,
  updates: [] as Array<{ patch: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  /** SAF-22 (J15e): false = the decline's guarded UPDATE matches no row (the request is no longer pending). */
  updateMatches: true,
  outcomes: [] as unknown[],
}));

function chain(table: string) {
  let pendingPatch: Record<string, unknown> | null = null;
  let filters: Array<[string, unknown]> = [];
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => {
          if (pendingPatch) {
            state.updates.push({ patch: pendingPatch, filters });
            pendingPatch = null;
            // SAF-22 (J15e): PostgREST answers `.select("id")` with the matched row
            return resolve({ data: state.updateMatches ? [{ id: "req1" }] : [], error: null });
          }
          resolve({ data: null, error: null });
        };
      }
      return (...args: unknown[]) => {
        if (prop === "update") { pendingPatch = args[0] as Record<string, unknown>; filters = []; }
        if (prop === "eq") filters.push(args as [string, unknown]);
        if (prop === "maybeSingle") {
          const d = table === "access_requests" ? state.request : table === "org_members" ? state.member : null;
          return Promise.resolve({ data: d, error: null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () =>
        state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
    from: (t: string) => chain(t),
  },
}));

vi.mock("@/lib/accessRequestOutcome", () => ({
  queueAccessRequestOutcome: vi.fn(async (_sb: unknown, o: unknown) => { state.outcomes.push(o); }),
  clearAccessRequestNotices: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/admin/access-requests/route";

function decline(id: string, token = "Bearer t"): Promise<Response> {
  return POST(new NextRequest("https://app/api/admin/access-requests", {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify({ id, action: "decline" }),
  }));
}

beforeEach(() => {
  state.user = { id: "admin1" };
  state.request = { id: "req1", org_id: "org1", status: "pending" };
  state.member = { role: "Admin", roles: [] };
  state.updates = [];
  state.updateMatches = true;
  state.outcomes = [];
});

describe("POST /api/admin/access-requests", () => {
  it("refuses without a token", async () => {
    const res = await POST(new NextRequest("https://app/api/admin/access-requests", {
      method: "POST", body: JSON.stringify({ id: "req1", action: "decline" }),
    }));
    expect(res.status).toBe(401);
    expect(state.updates).toHaveLength(0);
  });

  it("refuses a non-controller of the request's org", async () => {
    state.member = { role: "Viewer", roles: ["Viewer"] };
    const res = await decline("req1");
    expect(res.status).toBe(403);
    expect(state.updates).toHaveLength(0);
  });

  it("admits a member holding DocCtrl only additively", async () => {
    state.member = { role: "Manager", roles: ["Manager", "DocCtrl"] };
    const res = await decline("req1");
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
  });

  it("404s an unknown request id", async () => {
    state.request = null;
    const res = await decline("ghost");
    expect(res.status).toBe(404);
    expect(state.updates).toHaveLength(0);
  });

  it("declines only the named PENDING row", async () => {
    const res = await decline("req1");
    expect(res.status).toBe(200);
    const [u] = state.updates;
    expect(u.patch).toEqual({ status: "declined" });
    expect(u.filters).toContainEqual(["id", "req1"]);
    expect(u.filters).toContainEqual(["status", "pending"]);
  });
});

// projects-joint J15e (projects-tab SAF-22): the decline reads its matched row.
describe("SAF-22 (J15e) — a decline that matched no pending row", () => {
  it("regression: a pending request is declined and its outcome queued, as before", async () => {
    const res = await decline("req1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.outcomes).toHaveLength(1);
  });
  it("already declined (a second click): the decline holds, 200, nothing re-announced", async () => {
    state.updateMatches = false;
    state.request = { id: "req1", org_id: "org1", status: "declined" };
    const res = await decline("req1");
    expect(res.status).toBe(200);
    expect(state.outcomes).toEqual([]);
  });
  it("REPRODUCED: answered otherwise meanwhile (granted through Add member) — before, 200 'ok'; now a 409 that says it was not declined", async () => {
    state.updateMatches = false;
    state.request = { id: "req1", org_id: "org1", status: "approved" };
    const res = await decline("req1");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This request was already answered (it is no longer pending), so it was not declined. Reload to see where it stands.");
    expect(state.outcomes).toEqual([]);
  });
});
