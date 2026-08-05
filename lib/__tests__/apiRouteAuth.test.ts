// API-route authorization tests — the paths that must never regress silently.
//
// CI previously ran zero tests above lib/, so a broken auth check on a route
// shipped green. These tests exercise the route handlers directly with a
// mocked Supabase layer: who gets 401/403, what the no-config email path
// does to the queue, and that the AI execute endpoint refuses non-write
// tools and malformed parameters.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock the admin client the routes use ────────────────────────────────────
// A permissive chainable builder: every method returns the chain; awaiting it
// resolves the queued result for that table (default: empty). Tests set
// per-table results and the auth user.

const mockState = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  tables: {} as Record<string, { data?: unknown; error?: unknown; count?: number }>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

function makeChain(table: string) {
  const result = () => mockState.tables[table] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = result();
        return (resolve: (v: unknown) => void) =>
          resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
      }
      return (...args: unknown[]) => {
        mockState.calls.push({ table, method: prop, args });
        if (prop === "maybeSingle" || prop === "single") {
          const r = result();
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
      getUser: vi.fn(async () =>
        mockState.user
          ? { data: { user: mockState.user }, error: null }
          : { data: { user: null }, error: { message: "bad token" } }),
    },
    from: (table: string) => makeChain(table),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
}));

// send-queued builds its own client from @supabase/supabase-js.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: vi.fn(async () =>
        mockState.user
          ? { data: { user: mockState.user }, error: null }
          : { data: { user: null }, error: { message: "bad token" } }),
    },
    from: (table: string) => makeChain(table),
  }),
}));

function req(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]);
}

beforeEach(() => {
  mockState.user = null;
  mockState.tables = {};
  mockState.calls = [];
});

// ── /api/orchestrator/execute ───────────────────────────────────────────────

describe("POST /api/orchestrator/execute", () => {
  const load = () => import("@/app/api/orchestrator/execute/route");

  it("401s without a bearer token", async () => {
    const { POST } = await load();
    const res = await POST(req("http://test/api/orchestrator/execute", {
      method: "POST", body: JSON.stringify({ orgId: "o1", tool: "log_audit_completion" }),
    }));
    expect(res.status).toBe(401);
  });

  it("403s a non-member", async () => {
    mockState.user = { id: "u1" };
    mockState.tables["org_members"] = { data: null };
    const { POST } = await load();
    const res = await POST(req("http://test/api/orchestrator/execute", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
      body: JSON.stringify({ orgId: "o1", tool: "log_audit_completion", parameters: {} }),
    }));
    expect(res.status).toBe(403);
  });

  it("refuses read tools — only writes are executable", async () => {
    mockState.user = { id: "u1" };
    mockState.tables["org_members"] = { data: { uid: "u1", role: "Admin" } };
    const { POST } = await load();
    const res = await POST(req("http://test/api/orchestrator/execute", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
      body: JSON.stringify({ orgId: "o1", tool: "find_documents", parameters: { query: "x" } }),
    }));
    expect(res.status).toBe(400);
  });

  it("rejects missing required parameters before touching the tool", async () => {
    mockState.user = { id: "u1" };
    mockState.tables["org_members"] = { data: { uid: "u1", role: "Admin" } };
    const { POST } = await load();
    const res = await POST(req("http://test/api/orchestrator/execute", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
      body: JSON.stringify({ orgId: "o1", tool: "log_audit_completion", parameters: { revision: "C" } }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toMatch(/sheet_number/);
  });

  it("executes an approved write end-to-end (audit record logged)", async () => {
    mockState.user = { id: "u1" };
    mockState.tables["org_members"] = { data: { uid: "u1", role: "Admin" } };
    mockState.tables["drawing_audit_logs"] = { error: null };
    const { POST } = await load();
    const res = await POST(req("http://test/api/orchestrator/execute", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
      body: JSON.stringify({
        orgId: "o1", tool: "log_audit_completion",
        parameters: { sheet_number: "P-101", revision: "C", status: "passed" },
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.status).toBe("logged");
    expect(mockState.calls.some((c) => c.table === "drawing_audit_logs" && c.method === "upsert")).toBe(true);
    expect(mockState.calls.some((c) => c.table === "audit_logs" && c.method === "insert")).toBe(true);
  });
});

// ── /api/admin/schema-health ────────────────────────────────────────────────

describe("GET /api/admin/schema-health", () => {
  const load = () => import("@/app/api/admin/schema-health/route");

  it("401s without a bearer token", async () => {
    const { GET } = await load();
    const res = await GET(req("http://test/api/admin/schema-health?orgId=o1"));
    expect(res.status).toBe(401);
  });

  it("403s a member who isn't Admin", async () => {
    mockState.user = { id: "u1" };
    mockState.tables["org_members"] = { data: { role: "Viewer", roles: [] } };
    const { GET } = await load();
    const res = await GET(req("http://test/api/admin/schema-health?orgId=o1", {
      headers: { authorization: "Bearer tok" },
    }));
    expect(res.status).toBe(403);
  });

  it("reports healthy when every probe succeeds", async () => {
    mockState.user = { id: "u1" };
    mockState.tables["org_members"] = { data: { role: "Admin", roles: [] } };
    const { GET } = await load();
    const res = await GET(req("http://test/api/admin/schema-health?orgId=o1", {
      headers: { authorization: "Bearer tok" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthy).toBe(true);
    expect(body.checkedTables).toBeGreaterThan(50);
  });
});

// ── /api/notifications/send-queued ──────────────────────────────────────────

describe("POST /api/notifications/send-queued", () => {
  const load = async () => {
    vi.resetModules();
    return import("@/app/api/notifications/send-queued/route");
  };

  it("401s with neither CRON_SECRET nor a valid session", async () => {
    process.env.CRON_SECRET = "shh";
    delete process.env.RESEND_API_KEY;
    const { POST } = await load();
    const res = await POST(new Request("http://test/api/notifications/send-queued", {
      method: "POST", headers: { authorization: "Bearer wrong" },
    }));
    expect(res.status).toBe(401);
  });

  it("DEFERS (never suppresses) when RESEND_API_KEY is missing", async () => {
    process.env.CRON_SECRET = "shh";
    delete process.env.RESEND_API_KEY;
    mockState.tables["email_notifications"] = { count: 3 };
    const { POST } = await load();
    const res = await POST(new Request("http://test/api/notifications/send-queued", {
      method: "POST", headers: { authorization: "Bearer shh" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(false);
    expect(body.deferred).toBe(3);
    // The regression this guards: the old code flipped queued rows to a
    // terminal 'suppressed' status here. No update() may touch the queue.
    expect(mockState.calls.filter((c) => c.table === "email_notifications" && c.method === "update")).toHaveLength(0);
  });
});
