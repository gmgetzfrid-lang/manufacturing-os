// Signup route — the duplicate-email refusals (audit findings IDENT-3 and
// refuted IDENT-5's surviving copy fix).
//
// Contracts pinned here:
//  · the profile pre-check matches case-insensitively and refuses with the
//    friendly 409 on any existing row (limit(2) — pre-index data may hold
//    two profiles on one address, which the old maybeSingle choked on);
//  · the auth layer's duplicate rejection (code email_exists, or the
//    "already been registered" message) maps to the SAME friendly 409, not
//    a raw 400 relay;
//  · an unrelated auth failure still surfaces as a 400.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type QueuedResult = { data?: unknown; error?: unknown; count?: number };

const mockState = vi.hoisted(() => ({
  createUserResult: { data: { user: null as null | { id: string } }, error: null as null | { message: string; code?: string } },
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
  supabaseAdmin: {
    auth: {
      admin: {
        createUser: vi.fn(async () => mockState.createUserResult),
        deleteUser: vi.fn(async () => ({ data: null, error: null })),
      },
    },
    from: (table: string) => makeChain(table),
  },
}));

import { POST } from "@/app/api/auth/signup/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BODY = { email: "Greg@Corp.com", password: "hunter22", displayName: "Greg", companyName: "Acme Refining" };

beforeEach(() => {
  mockState.createUserResult = { data: { user: null }, error: { message: "should not be called" } };
  mockState.queues = {
    // signupRateLimited counts signup_attempts; recordSignupAttempt inserts.
    signup_attempts: [{ count: 0 }, { data: null }],
    orgs: [{ data: null }], // no existing org
  };
  mockState.calls = [];
});

describe("POST /api/auth/signup — duplicate-email refusals", () => {
  it("refuses with the friendly 409 when the profile pre-check finds the address, case-insensitively", async () => {
    mockState.queues.users = [{ data: [{ id: "uid-a" }] }];
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(409);
    expect(String((await res.json()).error)).toContain("already exists");
    const ilikeCall = mockState.calls.find((c) => c.table === "users" && c.method === "ilike");
    expect(ilikeCall).toBeDefined();
    expect(ilikeCall!.args).toEqual(["email", "greg@corp.com"]);
  });

  it("maps the auth layer's email_exists code to the friendly 409, not a raw 400", async () => {
    mockState.queues.users = [{ data: [] }];
    mockState.createUserResult = { data: { user: null }, error: { message: "User already registered", code: "email_exists" } };
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(409);
    expect(String((await res.json()).error)).toContain("Please sign in instead");
  });

  it("maps the 'already been registered' message shape to the friendly 409 too", async () => {
    mockState.queues.users = [{ data: [] }];
    mockState.createUserResult = { data: { user: null }, error: { message: "A user with this email address has already been registered" } };
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(409);
  });

  it("still surfaces an unrelated auth failure as a 400", async () => {
    mockState.queues.users = [{ data: [] }];
    mockState.createUserResult = { data: { user: null }, error: { message: "Password should be at least 6 characters" } };
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain("Password");
  });
});
