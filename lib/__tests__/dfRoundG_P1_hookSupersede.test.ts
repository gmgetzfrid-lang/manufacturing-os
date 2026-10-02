// @vitest-environment jsdom
//
// Drafting-flow Round G, DF-P1 RAILS fix pass — EVID-13: the badge hook
// (hooks/useTicketNotifications.ts) retires a stale workflow alert the route
// never superseded (a ticket the shed archived, a status reached by a path
// that does not fan out) with metadata.superseded_at, in the recipient's own
// session on their own unread row. It never stamps read_at (the recipient's
// own act), and it marks nothing when the ticket read fails (a failed read
// proves nothing about the ticket's status).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const fixture = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  tickets: [] as Array<Record<string, unknown>>,
  ticketsError: null as null | { message: string },
  updates: [] as Array<{ table: string; values: Record<string, unknown>; filters: Array<[string, string, unknown]> }>,
  role: { roles: ["Requester"], activeOrgId: "o1", uid: "u1", membershipState: "member" },
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): Record<string, unknown> => {
    let update: { table: string; values: Record<string, unknown>; filters: Array<[string, string, unknown]> } | null = null;
    const q: Record<string, unknown> = {};
    for (const m of ["select", "not", "in", "order", "limit", "or", "gte"]) q[m] = () => q;
    for (const m of ["eq", "is"]) q[m] = (k: string, v: unknown) => { update?.filters.push([m, k, v]); return q; };
    q.update = (values: Record<string, unknown>) => {
      update = { table, values, filters: [] };
      fixture.updates.push(update);
      return q;
    };
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const result = update
        ? { data: null, error: null }
        : table === "tickets"
          ? (fixture.ticketsError ? { data: null, error: fixture.ticketsError } : { data: fixture.tickets, error: null })
          : { data: [], error: null, count: 0 };
      return Promise.resolve(result).then(ok, ko);
    };
    return q;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  return { supabase: { from: (t: string) => chain(t), channel: () => channel, removeChannel: () => {} } };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => fixture.role }));
vi.mock("@/lib/capabilityPolicy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCapabilityPolicy: async () => undefined,
}));
vi.mock("@/lib/inAppNotifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listMyNotifications: async () => fixture.rows,
  markRead: async () => {},
  markAllRead: async () => {},
}));

import { useTicketNotifications } from "@/hooks/useTicketNotifications";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const seen: Array<ReturnType<typeof useTicketNotifications>> = [];
function Probe() {
  const v = useTicketNotifications();
  React.useEffect(() => { seen.push(v); });
  return null;
}
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const alert = (id: string, ticket: string, status: string) => ({
  id, orgId: "o1", userId: "u1", kind: "ticket_status", title: `t ${id}`, body: null, link: `/requests/${ticket}`,
  resourceType: "ticket", resourceId: ticket, actorUserId: null, actorName: null,
  metadata: { action: "assign", status, extra: "kept" }, readAt: null, createdAt: "2026-10-01T00:00:00Z",
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  seen.length = 0;
  fixture.updates = [];
  fixture.ticketsError = null;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("EVID-13 — the badge hook retires stale workflow alerts with the marker", () => {
  it("a stale alert (ticket moved on, or no longer live) is marked superseded on the recipient's own unread row and left out; a live one is untouched", async () => {
    fixture.rows = [alert("n-live", "t-live", "DRAFTING"), alert("n-moved", "t-moved", "DRAFTING"), alert("n-gone", "t-gone", "PENDING_REVIEW")];
    fixture.tickets = [{ id: "t-live", status: "DRAFTING" }, { id: "t-moved", status: "PENDING_REVIEW" }];
    await act(async () => { root.render(React.createElement(Probe)); });
    await flush();
    const marks = fixture.updates.filter((u) => u.table === "notifications");
    expect(marks.map((u) => u.filters.find(([op, k]) => op === "eq" && k === "id")?.[2]).sort()).toEqual(["n-gone", "n-moved"]);
    for (const m of marks) {
      expect(m.values).not.toHaveProperty("read_at");
      expect(m.values.metadata).toMatchObject({ action: "assign", extra: "kept" });
      expect(typeof (m.values.metadata as Record<string, unknown>).superseded_at).toBe("string");
      expect(m.filters).toEqual(expect.arrayContaining([["eq", "user_id", "u1"], ["is", "read_at", null]]));
    }
    expect(fixture.updates.filter((u) => u.table !== "notifications")).toEqual([]);
  });

  it("a ticket read that fails marks nothing (and leaves nothing out)", async () => {
    fixture.rows = [alert("n-moved", "t-moved", "DRAFTING")];
    fixture.tickets = [];
    fixture.ticketsError = { message: "connection reset" };
    await act(async () => { root.render(React.createElement(Probe)); });
    await flush();
    expect(fixture.updates).toEqual([]);
  });
});
