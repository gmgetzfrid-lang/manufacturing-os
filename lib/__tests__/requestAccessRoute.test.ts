// Request-access route — the fail-closed duplicate check (audit findings
// IDENT-3 / IDENT-6).
//
// Contracts pinned here:
//  · a failed duplicate lookup REFUSES (500, nothing inserted) instead of
//    reading as "no pending request" and stacking a duplicate row;
//  · an existing pending request refuses with the 409;
//  · the duplicate check matches case-insensitively on the normalized
//    address, and the inserted row stores the canonical form.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type QueuedResult = { data?: unknown; error?: unknown; count?: number };

const mockState = vi.hoisted(() => ({
  queues: {} as Record<string, QueuedResult[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

function nextResult(table: string): QueuedResult {
  const q = mockState.queues[table];
  return (q && q.shift()) ?? { data: null, error: null };
}

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = nextResult(table);
        return (resolve: (v: unknown) => void) =>
          resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
      }
      return (...args: unknown[]) => {
        mockState.calls.push({ table, method: prop, args });
        if (prop === "maybeSingle" || prop === "single") {
          const r = nextResult(table);
          return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
        }
        return new Proxy(chain, handler);
      };
    },
  };
  return new Proxy(chain, handler);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: { from: (table: string) => makeChain(table) },
}));

import { POST } from "@/app/api/auth/request-access/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/auth/request-access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BODY = { displayName: "Greg", email: "Greg@Corp.com", orgName: "Acme Refining" };

function accessInserts() {
  return mockState.calls.filter((c) => c.table === "access_requests" && c.method === "insert");
}

beforeEach(() => {
  mockState.queues = {
    orgs: [{ data: { id: "org-1", name: "Acme Refining" } }],
  };
  mockState.calls = [];
});

describe("POST /api/auth/request-access — fail-closed duplicate check", () => {
  it("refuses (500) and inserts NOTHING when the duplicate lookup errors", async () => {
    mockState.queues.access_requests = [{ error: { message: "connection reset" } }];
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(500);
    expect(accessInserts()).toHaveLength(0);
  });

  it("refuses (409) when a pending request already exists", async () => {
    mockState.queues.access_requests = [{ data: [{ id: "req-1", status: "pending" }] }];
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(409);
    expect(String((await res.json()).error)).toContain("pending request");
    expect(accessInserts()).toHaveLength(0);
  });

  it("matches the duplicate case-insensitively and stores the canonical email", async () => {
    mockState.queues.access_requests = [
      { data: [] },              // no pending request
      { data: null, error: null }, // the insert
    ];
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    const ilikeCall = mockState.calls.find((c) => c.table === "access_requests" && c.method === "ilike");
    expect(ilikeCall).toBeDefined();
    expect(ilikeCall!.args).toEqual(["email", "greg@corp.com"]);
    const insert = accessInserts()[0];
    expect((insert.args[0] as { email: string }).email).toBe("greg@corp.com");
  });

  // EGRESS-5 / DEC-19: the public door is rate-limited on the shared signup bucket.
  it("429s when the per-IP window is exhausted, before touching orgs or inserting", async () => {
    mockState.queues.signup_attempts = [{ count: 8 }];
    const req = new NextRequest("http://localhost/api/auth/request-access", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: JSON.stringify(BODY),
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(mockState.calls.filter((c) => c.table === "orgs")).toHaveLength(0);
    expect(accessInserts()).toHaveLength(0);
  });

  it("records an attempt against the window on a normal submission", async () => {
    mockState.queues.signup_attempts = [{ count: 0 }];
    mockState.queues.access_requests = [{ data: [] }, { data: null, error: null }];
    const req = new NextRequest("http://localhost/api/auth/request-access", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: JSON.stringify(BODY),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockState.calls.filter((c) => c.table === "signup_attempts" && c.method === "insert")).not.toHaveLength(0);
  });
});
