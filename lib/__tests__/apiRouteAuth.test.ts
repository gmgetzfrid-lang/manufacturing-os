// API-route authorization tests — the paths that must never regress silently.
//
// CI previously ran zero tests above lib/, so a broken auth check on a route
// shipped green. These tests exercise the route handlers directly with a
// mocked Supabase layer: who gets 401/403, what the no-config email path
// does to the queue, and that the AI execute endpoint refuses non-write
// tools and malformed parameters.
//
// projects Round G (REL-6 / SEC-10 / PERF-6): the four project-controls
// routes — cost-docs, checklist, quality-manual and the intake upload door —
// each with its own authority model, pinned here; the checklist and
// quality-manual routes' service-role document reads are gated on the
// CALLER's content decision (a member the ACL excludes gets 403 and nothing
// is rendered); and a read that runs out of time answers with a readable
// 504 instead of the platform's bare one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock the admin client the routes use ────────────────────────────────────
// A permissive chainable builder: every method returns the chain; awaiting it
// resolves the queued result for that table (default: empty). Tests set
// per-table results and the auth user.

const mockState = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  tables: {} as Record<string, { data?: unknown; error?: unknown; count?: number }>,
  // `chain` numbers each from(table) builder, so a test can ask what ONE
  // query did (its select AND its filters), not what the table saw overall.
  calls: [] as Array<{ table: string; method: string; args: unknown[]; chain: number }>,
  chainSeq: 0,
  // Tables whose single-row reads honour .eq() filters against the fixture:
  // a filter on a column the fixture carries, with a different value,
  // resolves no row (as the database would). Opt-in per test.
  honourEq: new Set<string>(),
  // Per-table override for .maybeSingle()/.single() — for a table read both
  // as one row and as a list in the same request (documents in the
  // checklist assess path).
  single: {} as Record<string, { data?: unknown; error?: unknown }>,
  rpc: {} as Record<string, { data?: unknown; error?: unknown }>,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  // The page renderer and the governed model call (checklist / quality-manual).
  render: (async () => [{ page: 1, mediaType: "image/png", base64: "AA==" }]) as () => Promise<unknown[]>,
  renderCalls: 0,
  aiText: "",
  aiError: null as unknown,
  aiCalls: [] as Array<Record<string, unknown>>,
  r2Sends: 0,
}));

function makeChain(table: string) {
  const result = () => mockState.tables[table] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  const id = ++mockState.chainSeq;
  const eqs: Array<[string, unknown]> = [];
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = result();
        return (resolve: (v: unknown) => void) =>
          resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
      }
      return (...args: unknown[]) => {
        mockState.calls.push({ table, method: prop, args, chain: id });
        if (prop === "eq") eqs.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") {
          const r = mockState.single[table] ?? result();
          const row = r.data as Record<string, unknown> | null | undefined;
          const filteredOut = mockState.honourEq.has(table) && !!row && !Array.isArray(row)
            && eqs.some(([col, val]) => col in row && row[col] !== val);
          return Promise.resolve({ data: filteredOut ? null : r.data ?? null, error: r.error ?? null });
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
    rpc: vi.fn(async (fn: string, args: unknown) => {
      mockState.rpcCalls.push({ fn, args });
      return mockState.rpc[fn] ?? { data: null, error: null };
    }),
  },
}));

vi.mock("@/lib/knowledgePageRender", () => ({
  MAX_DEEP_READ_PAGES: 6,
  renderKnowledgePages: vi.fn(async () => { mockState.renderCalls++; return mockState.render(); }),
}));

vi.mock("@/lib/ai/governedCall", () => {
  class GovernedCallError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  }
  return {
    GovernedCallError,
    governedAiCall: vi.fn(async (input: Record<string, unknown>) => {
      mockState.aiCalls.push(input);
      if (mockState.aiError) throw mockState.aiError;
      return { text: mockState.aiText, usage: { inputTokens: 1, outputTokens: 1 } };
    }),
  };
});

vi.mock("@/lib/r2", () => ({
  r2: { send: vi.fn(async () => { mockState.r2Sends++; return {}; }) },
  R2_BUCKET: "test-bucket",
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
  mockState.honourEq = new Set();
  mockState.single = {};
  mockState.rpc = {};
  mockState.rpcCalls = [];
  mockState.render = async () => [{ page: 1, mediaType: "image/png", base64: "AA==" }];
  mockState.renderCalls = 0;
  mockState.aiText = "";
  mockState.aiError = null;
  mockState.aiCalls = [];
  mockState.r2Sends = 0;
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

  // SURF-5: a session caller must be an org member, and drains only their orgs.
  it("403s a signed-in account that belongs to no org (SURF-5)", async () => {
    process.env.CRON_SECRET = "shh";
    process.env.RESEND_API_KEY = "re_test";
    mockState.user = { id: "u1", email: "u1@example.com" };
    mockState.tables["org_members"] = { data: [] };
    const { POST } = await load();
    const res = await POST(new Request("http://test/api/notifications/send-queued", {
      method: "POST", headers: { authorization: "Bearer usertok" },
    }));
    expect(res.status).toBe(403);
    // It must not have touched the queue at all.
    expect(mockState.calls.filter((c) => c.table === "email_notifications")).toHaveLength(0);
  });

  it("scopes a member's drain to their own orgs (SURF-5)", async () => {
    process.env.CRON_SECRET = "shh";
    process.env.RESEND_API_KEY = "re_test";
    mockState.user = { id: "u1", email: "u1@example.com" };
    mockState.tables["org_members"] = { data: [{ org_id: "o1" }] };
    mockState.tables["email_notifications"] = { data: [] }; // nothing to send
    const { POST } = await load();
    const res = await POST(new Request("http://test/api/notifications/send-queued", {
      method: "POST", headers: { authorization: "Bearer usertok" },
    }));
    expect(res.status).toBe(200);
    // EVERY queue query this run made was org-scoped — the configured path
    // reaches the queue through three query chains before its id-keyed writes
    // (unsuppress, reclaim, candidates; the count query belongs to the
    // unconfigured branch), and each must carry the caller's org filter.
    // Asserting the exact count catches a fourth, unscoped query being added
    // later; ">= 1" would let it drain cross-tenant silently.
    const queueSelectsAndUpdates = mockState.calls.filter(
      (c) => c.table === "email_notifications" && (c.method === "select" || c.method === "update"),
    );
    expect(queueSelectsAndUpdates).toHaveLength(3);
    const orgScopedCalls = mockState.calls.filter(
      (c) => c.table === "email_notifications" && c.method === "in" && c.args[0] === "org_id",
    );
    expect(orgScopedCalls).toHaveLength(3);
    for (const c of orgScopedCalls) {
      expect(c.args[1]).toEqual(["o1"]); // the caller's orgs, nothing wider
    }
  });

  it("cron secret drains every org (unscoped)", async () => {
    process.env.CRON_SECRET = "shh";
    process.env.RESEND_API_KEY = "re_test";
    mockState.tables["email_notifications"] = { data: [] };
    const { POST } = await load();
    const res = await POST(new Request("http://test/api/notifications/send-queued", {
      method: "POST", headers: { authorization: "Bearer shh" },
    }));
    expect(res.status).toBe(200);
    // No org_id scoping applied on the cron path.
    const orgScoped = mockState.calls.filter(
      (c) => c.table === "email_notifications" && c.method === "in" && c.args[0] === "org_id",
    );
    expect(orgScoped).toHaveLength(0);
  });
});

// ── projects Round G: the four project-controls routes (REL-6) ──────────────
// Three authority models — any active member (checklist), controller or
// project owner (cost-docs), controllers only (quality-manual) — and the
// tokened upload door, which has no account at all.

const ORG = "o1";
function post(url: string, body: unknown, token: string | null = "tok"): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return req(url, { method: "POST", headers, body: JSON.stringify(body) });
}
const auditRows = () => mockState.calls
  .filter((c) => c.table === "audit_logs" && c.method === "insert")
  .map((c) => c.args[0] as { action?: string; resource_id?: string; details?: Record<string, unknown> });
const PLAIN_MEMBER = { status: "active", role: "Viewer", roles: [] as string[] };
// ADD-1: a DocCtrl held ADDITIVELY under a higher headline is a controller.
const ADDITIVE_DOCCTRL = { status: "active", role: "Manager", roles: ["Manager", "DocCtrl"] };
function docRow(over: Record<string, unknown> = {}) {
  return {
    id: "d1", document_number: "HSE-7", title: "Incident procedure", name: null,
    current_version_id: "v1", pending_version_id: null,
    visibility: "normal", acl: null, acl_index: null,
    owner_user_id: "someone-else", collection_id: "c1", library_id: "l1",
    ...over,
  };
}
const grant = (uid: string, actions: string[]) =>
  ({ rules: [{ effect: "allow", subject: { type: "user", id: uid }, actions }] });
const teamGrant = (team: string, actions: string[]) =>
  ({ rules: [{ effect: "allow", subject: { type: "team", id: team }, actions }] });
/** SEC-10: the gate reads the library → folder chain above the document
 *  (library l1, folder c1, no ancestors). No ACL on either unless given. */
function seedChain(libraryAcl: unknown = null, folderAcl: unknown = null) {
  mockState.tables.libraries = { data: { id: "l1", acl: libraryAcl } };
  mockState.single.collections = { data: { id: "c1", library_id: "l1", path_ids: [], acl: folderAcl } };
  mockState.tables.collections = { data: [] };
}

describe("POST /api/projects/checklist — any active member, over documents THEY may read (REL-6, SEC-10)", () => {
  const load = () => import("@/app/api/projects/checklist/route");
  const segment = (token: string | null = "tok") => post("http://test/api/projects/checklist",
    { orgId: ORG, projectId: "p1", action: "segment", documentId: "d1" }, token);
  function seed(member: unknown, doc: unknown) {
    mockState.user = { id: "u1", email: "u1@example.com" };
    mockState.tables.org_members = { data: member };
    mockState.tables.team_members = { data: [] };
    mockState.tables.projects = { data: { id: "p1", name: "Unit 4" } };
    mockState.tables.documents = { data: doc };
    mockState.tables.document_versions = { data: { file_url: "orgs/o1/libraries/l1/HSE-7.pdf", file_type: "application/pdf" } };
    seedChain();
    mockState.aiText = '{"items":[{"section":"Documentation","text":"P&IDs updated to as-built"}]}';
  }
  const nothingServed = () => {
    expect(mockState.renderCalls).toBe(0);
    expect(mockState.aiCalls).toHaveLength(0);
    expect(mockState.calls.filter((c) => c.table === "document_versions")).toHaveLength(0);
  };

  it("401s without a bearer token, and with a token that resolves to no user", async () => {
    const { POST } = await load();
    expect((await POST(segment(null))).status).toBe(401);
    mockState.user = null;
    expect((await POST(segment())).status).toBe(401);
  });

  it("403s a non-member and a suspended member", async () => {
    const { POST } = await load();
    seed(null, docRow());
    expect((await POST(segment())).status).toBe(403);
    seed({ ...PLAIN_MEMBER, status: "suspended" }, docRow());
    expect((await POST(segment())).status).toBe(403);
    nothingServed();
  });

  it("404s a project outside the org", async () => {
    seed(PLAIN_MEMBER, docRow());
    mockState.tables.projects = { data: null };
    const { POST } = await load();
    expect((await POST(segment())).status).toBe(404);
  });

  it("a plain member reads a normal document — the checklist reader is member-level (200)", async () => {
    seed(PLAIN_MEMBER, docRow());
    const { POST } = await load();
    const res = await POST(segment());
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; sourceLabel: string; pageCap: number };
    expect(body.items).toHaveLength(1);
    expect(body.sourceLabel).toBe("HSE-7");
    expect(body.pageCap).toBe(10);
    expect(auditRows()).toHaveLength(0);
  });

  it("SEC-10: a member the ACL excludes from a private document gets 403 — nothing resolved, rendered or sent to the model", async () => {
    seed(PLAIN_MEMBER, docRow({ visibility: "private", acl: grant("someone-else", ["discover", "read"]) }));
    const { POST } = await load();
    const res = await POST(segment());
    expect(res.status).toBe(403);
    expect(String((await res.json()).error)).toMatch(/access to read that document/);
    nothingServed();
    // The ownership cascade was asked before refusing (GAP-15 / DEC-7).
    expect(mockState.rpcCalls.map((c) => c.fn)).toEqual(["user_is_effective_owner"]);
  });

  it("SEC-10 / DOCACL-5: a discover-only grant does not yield the pages", async () => {
    seed(PLAIN_MEMBER, docRow({ visibility: "hidden", acl: grant("u1", ["discover"]) }));
    const { POST } = await load();
    expect((await POST(segment())).status).toBe(403);
    nothingServed();
  });

  it("a read grant on the private document admits the member; so does the effective-owner cascade", async () => {
    seed(PLAIN_MEMBER, docRow({ visibility: "private", acl: grant("u1", ["discover", "read"]) }));
    const { POST } = await load();
    expect((await POST(segment())).status).toBe(200);
    seed(PLAIN_MEMBER, docRow({ visibility: "private", acl: null }));
    mockState.rpc.user_is_effective_owner = { data: true };
    expect((await POST(segment())).status).toBe(200);
    expect(auditRows()).toHaveLength(0);
  });

  it("an explicit DOWNLOAD deny on a held role binds, even on a normal document and even for a controller", async () => {
    const { POST } = await load();
    seed(PLAIN_MEMBER, docRow({ acl_index: { deny: { roles: { download: ["Viewer"] } } } }));
    expect((await POST(segment())).status).toBe(403);
    seed(ADDITIVE_DOCCTRL, docRow({ visibility: "private", acl_index: { deny: { users: { download: ["u1"] } } } }));
    expect((await POST(segment())).status).toBe(403);
    nothingServed();
    expect(auditRows()).toHaveLength(0); // refused, so no "read" is recorded
  });

  it("DEC-43: a controller served a restricted document ONLY by the controller tier leaves a CONTROLLER_RESTRICTED_READ row", async () => {
    seed(ADDITIVE_DOCCTRL, docRow({ visibility: "private", acl: grant("someone-else", ["read"]) }));
    const { POST } = await load();
    expect((await POST(segment())).status).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("CONTROLLER_RESTRICTED_READ");
    expect(rows[0].resource_id).toBe("d1");
    expect(rows[0].details).toMatchObject({ channel: "checklist_segment", visibility: "private", path: "orgs/o1/libraries/l1/HSE-7.pdf" });
  });

  it("DEC-43: no row when ownership or the ACL would have served the controller anyway", async () => {
    const { POST } = await load();
    seed(ADDITIVE_DOCCTRL, docRow({ visibility: "private", acl: null }));
    mockState.rpc.user_is_effective_owner = { data: true };
    expect((await POST(segment())).status).toBe(200);
    seed(ADDITIVE_DOCCTRL, docRow({ visibility: "private", acl: grant("u1", ["read"]) }));
    mockState.rpc = {};
    expect((await POST(segment())).status).toBe(200);
    seed(ADDITIVE_DOCCTRL, docRow());
    expect((await POST(segment())).status).toBe(200);
    expect(auditRows()).toHaveLength(0);
  });

  it("SEC-10 (a): a normal document with an allow-list for team-A — a member outside team-A gets 403, nothing rendered; a team-A member is served", async () => {
    const { POST } = await load();
    seed(PLAIN_MEMBER, docRow({ acl: teamGrant("team-A", ["discover", "read"]) }));
    const res = await POST(segment());
    expect(res.status).toBe(403);
    expect(String((await res.json()).error)).toMatch(/access to read that document/);
    nothingServed();
    seed(PLAIN_MEMBER, docRow({ acl: teamGrant("team-A", ["discover", "read"]) }));
    mockState.tables.team_members = { data: [{ team_id: "team-A" }] };
    expect((await POST(segment())).status).toBe(200);
  });

  it("SEC-10: read granted to team-A on the LIBRARY (the finding's HSE library) binds its normal documents — 403 outside team-A", async () => {
    const { POST } = await load();
    seed(PLAIN_MEMBER, docRow());
    seedChain(teamGrant("team-A", ["discover", "read", "download"]));
    expect((await POST(segment())).status).toBe(403);
    nothingServed();
    // The folder rung binds the same way.
    seed(PLAIN_MEMBER, docRow());
    seedChain(null, teamGrant("team-A", ["read"]));
    expect((await POST(segment())).status).toBe(403);
  });

  it("SEC-10 (b): a private document whose read grant is INHERITED from its library serves a team-A member (200)", async () => {
    const { POST } = await load();
    seed(PLAIN_MEMBER, docRow({ visibility: "private", acl: null }));
    seedChain(teamGrant("team-A", ["discover", "read"]));
    mockState.tables.team_members = { data: [{ team_id: "team-A" }] };
    expect((await POST(segment())).status).toBe(200);
    expect(auditRows()).toHaveLength(0);
  });

  it("SEC-10: a library or folder whose ACL cannot be read is 503 — never read as 'no ACL'", async () => {
    const { POST } = await load();
    seed(PLAIN_MEMBER, docRow());
    mockState.tables.libraries = { data: null, error: { message: "boom" } };
    expect((await POST(segment())).status).toBe(503);
    seed(PLAIN_MEMBER, docRow());
    mockState.single.collections = { data: null, error: { message: "boom" } };
    expect((await POST(segment())).status).toBe(503);
    nothingServed();
  });

  it("a membership read that fails is 503 — the gate never guesses", async () => {
    seed(PLAIN_MEMBER, docRow());
    mockState.tables.team_members = { data: null, error: { message: "boom" } };
    const { POST } = await load();
    expect((await POST(segment())).status).toBe(503);
    nothingServed();
  });

  it("SEC-10: a pointer on a readable document naming ANOTHER document's version serves nothing — 404, nothing rendered, no row", async () => {
    const { POST } = await load();
    // d1 is readable to each reader — a normal document with no ACL to the
    // member; a private one to the controller, whose served read WOULD write
    // a DEC-43 row — and its member-writable pending pointer names private
    // document dB's version.
    for (const [member, visibility] of [[PLAIN_MEMBER, "normal"], [ADDITIVE_DOCCTRL, "private"]] as const) {
      seed(member, docRow({ visibility, current_version_id: null, pending_version_id: "vB" }));
      mockState.honourEq = new Set(["document_versions"]);
      mockState.tables.document_versions = { data: { id: "vB", record_id: "dB", file_url: "orgs/o1/libraries/l1/HSE-private.pdf", file_type: "application/pdf" } };
      const res = await POST(segment());
      expect(res.status).toBe(404);
      expect(String((await res.json()).error)).toMatch(/no stored file/);
      expect(mockState.renderCalls).toBe(0);
      expect(mockState.aiCalls).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    }
    // The same pointer naming d1's OWN version is served.
    seed(PLAIN_MEMBER, docRow({ current_version_id: null, pending_version_id: "v1" }));
    mockState.honourEq = new Set(["document_versions"]);
    mockState.tables.document_versions = { data: { id: "v1", record_id: "d1", file_url: "orgs/o1/libraries/l1/HSE-7.pdf", file_type: "application/pdf" } };
    expect((await POST(segment())).status).toBe(200);
  });

  it("a folder chain with a rung that no longer exists is 409 naming it — not 'try again', and a controller gets it too", async () => {
    const { POST } = await load();
    for (const member of [PLAIN_MEMBER, ADDITIVE_DOCCTRL]) {
      seed(member, docRow());
      mockState.single.collections = { data: { id: "c1", library_id: "l1", path_ids: ["c0-gone"], acl: null } };
      const res = await POST(segment());
      expect(res.status).toBe(409);
      const error = String((await res.json()).error);
      expect(error).toMatch(/folder chain is broken \(folder c0-gone no longer exists\)/);
      expect(error).toMatch(/document controller needs to repair/);
      expect(error).not.toMatch(/try again\.?$/);
      nothingServed();
    }
  });

  describe("assess — only what the caller may see reaches the model", () => {
    function seedAssess(member: unknown) {
      seed(member, [
        { title: "General arrangement", name: null, document_number: "P-1", visibility: "normal", acl: null, owner_user_id: null },
        { title: "Incident procedure", name: null, document_number: "HSE-7", visibility: "hidden", acl: null, owner_user_id: null },
      ]);
      mockState.single.documents = { data: docRow({ id: "sow1", document_number: "SOW-9", title: "Confidential SOW", visibility: "private" }) };
      mockState.tables.projects = { data: { id: "p1", name: "Unit 4", sow_document_id: "sow1", intake_collection_id: "c1" } };
      mockState.tables.project_checklists = { data: { id: "cl1", title: "PSSR", kind: "pssr" } };
      mockState.tables.checklist_items = { data: [{ id: "abcdef12-0000-0000-0000-000000000000", seq: 1, section: null, text: "Weld records on file", manual_note: null }] };
      mockState.tables.milestones = { data: [] };
      mockState.tables.assets = { data: [] };
      mockState.aiText = '{"assessments":[{"ref":"abcdef12","applicability":"applies","rationale":"Welds in scope"}]}';
    }
    const assess = () => post("http://test/api/projects/checklist", { orgId: ORG, projectId: "p1", action: "assess", checklistId: "cl1" });

    it("a plain member's prompt carries neither the restricted SOW's label nor a hidden document's title", async () => {
      seedAssess(PLAIN_MEMBER);
      const { POST } = await load();
      const res = await POST(assess());
      expect(res.status).toBe(200);
      const prompt = String(mockState.aiCalls[0].user);
      expect(prompt).toContain("P-1 General arrangement");
      expect(prompt).not.toContain("HSE-7");
      expect(prompt).not.toContain("Incident procedure");
      expect(prompt).not.toContain("SOW-9");
      expect(prompt).not.toContain("Confidential SOW");
      expect(prompt).toContain("Summary of Work is on file but restricted");
    });

    it("a controller's prompt carries both — and a label-only read leaves no CONTROLLER_RESTRICTED_READ row", async () => {
      seedAssess(ADDITIVE_DOCCTRL);
      const { POST } = await load();
      expect((await POST(assess())).status).toBe(200);
      const prompt = String(mockState.aiCalls[0].user);
      expect(prompt).toContain("Summary of Work document on file: SOW-9");
      expect(prompt).toContain("HSE-7 Incident procedure");
      expect(auditRows()).toHaveLength(0);
    });

    it("the intake folder's titles are read in THIS org only, and filtered over the folder's library → folder chain", async () => {
      seedAssess(PLAIN_MEMBER);
      // The intake folder sits in a library whose read is team-A's only.
      seedChain(teamGrant("team-A", ["discover", "read"]));
      const { POST } = await load();
      expect((await POST(assess())).status).toBe(200);
      const prompt = String(mockState.aiCalls[0].user);
      expect(prompt).not.toContain("P-1 General arrangement");
      expect(prompt).toContain("No project documents on file yet.");
      // The list read ITSELF is org-scoped (a foreign intake_collection_id
      // lists nothing of another tenant's) — asked of the one query that
      // selects the titles, not of every documents read the request made
      // (the SOW's gate read is org-scoped too, and must not mask a gap here).
      const listSelects = mockState.calls.filter((c) => c.table === "documents" && c.method === "select"
        && c.args[0] === "title, name, document_number, visibility, acl, owner_user_id");
      expect(listSelects).toHaveLength(1);
      const listEqs = mockState.calls.filter((c) => c.chain === listSelects[0].chain && c.method === "eq").map((c) => c.args);
      expect(listEqs).toContainEqual(["org_id", ORG]);
      expect(listEqs).toContainEqual(["collection_id", "c1"]);
      // …and so is every chain read.
      const eqsOn = (table: string) => mockState.calls.filter((c) => c.table === table && c.method === "eq").map((c) => c.args);
      expect(eqsOn("collections")).toContainEqual(["org_id", ORG]);
      expect(eqsOn("libraries")).toContainEqual(["org_id", ORG]);
    });

    it("an intake folder whose chain cannot be read lists no titles — failing closed", async () => {
      seedAssess(PLAIN_MEMBER);
      mockState.tables.libraries = { data: null, error: { message: "boom" } };
      const { POST } = await load();
      expect((await POST(assess())).status).toBe(200);
      const prompt = String(mockState.aiCalls[0].user);
      expect(prompt).not.toContain("P-1 General arrangement");
    });

    it("a check that cannot RUN is never told to the model as an absence — the SOW and the titles are 'on file but could not be checked'", async () => {
      const { POST } = await load();
      // A read error on the chain: the SOW's gate answers 503, the intake chain is unreadable.
      seedAssess(PLAIN_MEMBER);
      mockState.tables.libraries = { data: null, error: { message: "boom" } };
      expect((await POST(assess())).status).toBe(200);
      let prompt = String(mockState.aiCalls[0].user);
      expect(prompt).toContain("A Summary of Work is on file but could not be checked — it was not read.");
      expect(prompt).toContain("Project documents may be on file but could not be checked — their titles were not read.");
      expect(prompt).not.toContain("No Summary of Work attached.");
      expect(prompt).not.toContain("No project documents on file yet.");
      expect(prompt).not.toContain("SOW-9");
      // A broken chain (a path_ids rung that no longer exists): the gate's 409, the same honest lines.
      seedAssess(PLAIN_MEMBER);
      mockState.single.collections = { data: { id: "c1", library_id: "l1", path_ids: ["gone"], acl: null } };
      mockState.aiCalls = [];
      expect((await POST(assess())).status).toBe(200);
      prompt = String(mockState.aiCalls[0].user);
      expect(prompt).toContain("A Summary of Work is on file but could not be checked");
      expect(prompt).toContain("their titles were not read");
      // …and the intake list read failing is not "none" either.
      seedAssess(ADDITIVE_DOCCTRL);
      mockState.tables.documents = { data: null, error: { message: "boom" } };
      mockState.aiCalls = [];
      expect((await POST(assess())).status).toBe(200);
      prompt = String(mockState.aiCalls[0].user);
      expect(prompt).toContain("their titles were not read");
      expect(prompt).not.toContain("No project documents on file yet.");
    });

    it("a SOW whose version read fails is 'could not be checked', and one with no readable file is 'linked but has no readable file' — never 'No Summary of Work attached'", async () => {
      const { POST } = await load();
      // A controller may read the SOW; only the version read fails.
      seedAssess(ADDITIVE_DOCCTRL);
      mockState.single.document_versions = { data: null, error: { message: "boom" } };
      expect((await POST(assess())).status).toBe(200);
      let prompt = String(mockState.aiCalls[0].user);
      expect(prompt).toContain("A Summary of Work is on file but could not be checked — it was not read.");
      expect(prompt).not.toContain("No Summary of Work attached.");
      // The same controller, a SOW with no stored file.
      seedAssess(ADDITIVE_DOCCTRL);
      mockState.single.document_versions = { data: null };
      mockState.aiCalls = [];
      expect((await POST(assess())).status).toBe(200);
      prompt = String(mockState.aiCalls[0].user);
      expect(prompt).toContain("A Summary of Work is linked but has no readable file — it was not read.");
      expect(prompt).not.toContain("No Summary of Work attached.");
    });

    it("a project with no SOW and an empty intake folder still says so plainly", async () => {
      seedAssess(PLAIN_MEMBER);
      mockState.tables.projects = { data: { id: "p1", name: "Unit 4", sow_document_id: null, intake_collection_id: "c1" } };
      mockState.tables.documents = { data: [] };
      const { POST } = await load();
      expect((await POST(assess())).status).toBe(200);
      const prompt = String(mockState.aiCalls[0].user);
      expect(prompt).toContain("No Summary of Work attached.");
      expect(prompt).toContain("No project documents on file yet.");
      expect(prompt).not.toContain("could not be checked");
    });
  });
});

describe("POST /api/companies/quality-manual — controllers only, and still bound by the document's own rules (REL-6, SEC-10)", () => {
  const load = () => import("@/app/api/companies/quality-manual/route");
  const evaluate = (token: string | null = "tok") => post("http://test/api/companies/quality-manual",
    { orgId: ORG, companyId: "co1", documentId: "d1" }, token);
  function seed(member: unknown, doc: unknown) {
    mockState.user = { id: "u1", email: "u1@example.com" };
    mockState.tables.org_members = { data: member };
    mockState.tables.team_members = { data: [] };
    mockState.tables.companies = { data: { id: "co1", name: "Acme Mechanical" } };
    mockState.tables.documents = { data: doc };
    mockState.tables.document_versions = { data: { file_url: "orgs/o1/libraries/l1/QM.pdf", file_type: "application/pdf" } };
    seedChain();
    mockState.aiText = '{"findings":[{"area":"doc_control","covered":true,"finding":"Section 4 defines revision control"}]}';
  }

  it("401s without a bearer token", async () => {
    const { POST } = await load();
    expect((await POST(evaluate(null))).status).toBe(401);
  });

  it("403s a non-member and a member who is not a controller", async () => {
    const { POST } = await load();
    seed(null, docRow());
    expect((await POST(evaluate())).status).toBe(403);
    seed({ status: "active", role: "Manager", roles: ["Manager"] }, docRow());
    expect((await POST(evaluate())).status).toBe(403);
    expect(mockState.renderCalls).toBe(0);
  });

  it("an additively-held DocCtrl is admitted (404 for a company outside the org proves the gate passed)", async () => {
    seed(ADDITIVE_DOCCTRL, docRow());
    mockState.tables.companies = { data: null };
    const { POST } = await load();
    expect((await POST(evaluate())).status).toBe(404);
  });

  it("DEC-43: a manual served only by the controller tier is recorded (channel quality_manual)", async () => {
    seed(ADDITIVE_DOCCTRL, docRow({ visibility: "private", acl: null }));
    const { POST } = await load();
    expect((await POST(evaluate())).status).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "CONTROLLER_RESTRICTED_READ", resource_id: "d1" });
    expect(rows[0].details).toMatchObject({ channel: "quality_manual" });
  });

  it("SEC-10: a manual in a folder whose path_ids names a folder that no longer exists — 409 naming it, not a 'try again' 503", async () => {
    seed({ status: "active", role: "Admin", roles: ["Admin"] }, docRow());
    mockState.single.collections = { data: { id: "c1", library_id: "l1", path_ids: ["c-stale"], acl: null } };
    const { POST } = await load();
    const res = await POST(evaluate());
    expect(res.status).toBe(409);
    expect(String((await res.json()).error)).toMatch(/folder c-stale no longer exists.*repair the folder chain/);
    expect(mockState.renderCalls).toBe(0);
    // A read ERROR on the same rung is still the transient 503.
    seed({ status: "active", role: "Admin", roles: ["Admin"] }, docRow());
    mockState.single.collections = { data: { id: "c1", library_id: "l1", path_ids: ["c-stale"], acl: null } };
    mockState.tables.collections = { data: null, error: { message: "boom" } };
    const retry = await POST(evaluate());
    expect(retry.status).toBe(503);
    expect(String((await retry.json()).error)).toMatch(/try again/);
  });

  it("SEC-10: an explicit download deny binds the controller — 403, nothing rendered", async () => {
    seed(ADDITIVE_DOCCTRL, docRow({ acl_index: { deny: { roles: { download: ["DocCtrl"] } } } }));
    const { POST } = await load();
    expect((await POST(evaluate())).status).toBe(403);
    expect(mockState.renderCalls).toBe(0);
    expect(mockState.aiCalls).toHaveLength(0);
  });

  it("PERF-6: the page cap is in the response — a manual read to the cap says only the first pages were judged", async () => {
    seed(ADDITIVE_DOCCTRL, docRow());
    mockState.render = async () => Array.from({ length: 10 }, (_, i) => ({ page: i + 1, mediaType: "image/png", base64: "AA==" }));
    const { POST } = await load();
    const res = await POST(evaluate());
    expect(res.status).toBe(200);
    const body = await res.json() as { pageCap: number; note: string; pagesRead: number[] };
    expect(body.pageCap).toBe(10);
    expect(body.pagesRead).toHaveLength(10);
    expect(body.note).toMatch(/Only the first 10 pages were read/);
    mockState.render = async () => [{ page: 1, mediaType: "image/png", base64: "AA==" }];
    const short = await (await POST(evaluate())).json() as { note: string };
    expect(short.note).not.toMatch(/Only the first/);
  });
});

describe("POST /api/projects/cost-docs — a controller or the project owner (REL-6; the route is P3's, tests only)", () => {
  const load = () => import("@/app/api/projects/cost-docs/route");
  const read = (token: string | null = "tok") => post("http://test/api/projects/cost-docs",
    { orgId: ORG, projectId: "p1", costDocId: "cd1" }, token);
  function seed(member: unknown, ownerUid = "owner-uid") {
    mockState.user = { id: "u1" };
    mockState.tables.org_members = { data: member };
    mockState.tables.projects = { data: { id: "p1", owner_user_id: ownerUid } };
    mockState.tables.cost_documents = { data: null };
  }

  it("401s without a token and with a token that resolves to no user", async () => {
    const { POST } = await load();
    expect((await POST(read(null))).status).toBe(401);
    expect((await POST(read())).status).toBe(401);
  });

  it("403s a non-member", async () => {
    seed(null);
    const { POST } = await load();
    expect((await POST(read())).status).toBe(403);
  });

  it("404s a project outside the org", async () => {
    seed(PLAIN_MEMBER);
    mockState.tables.projects = { data: null };
    const { POST } = await load();
    expect((await POST(read())).status).toBe(404);
  });

  it("403s a member who is neither the project owner nor a controller", async () => {
    seed({ status: "active", role: "Manager", roles: ["Manager"] });
    const { POST } = await load();
    const res = await POST(read());
    expect(res.status).toBe(403);
    expect(String((await res.json()).error)).toMatch(/project owner or a document controller/);
    expect(mockState.calls.filter((c) => c.table === "cost_documents")).toHaveLength(0);
  });

  it("admits the project owner and an additively-held DocCtrl (the cost row lookup is reached)", async () => {
    const { POST } = await load();
    seed(PLAIN_MEMBER, "u1");
    let res = await POST(read());
    expect(res.status).toBe(404);
    expect(String((await res.json()).error)).toMatch(/Cost document not found/);
    seed(ADDITIVE_DOCCTRL);
    res = await POST(read());
    expect(res.status).toBe(404);
    expect(mockState.calls.some((c) => c.table === "cost_documents")).toBe(true);
    expect(mockState.renderCalls).toBe(0);
  });
});

describe("POST /api/intake/upload — the token is the only credential (REL-6; the route is P1's, tests only)", () => {
  const load = () => import("@/app/api/intake/upload/route");
  const TOKEN = "a".repeat(32);
  function upload(fields: Record<string, string | File>): NextRequest {
    // projects Round G J1 (INTK-8): the token travels in a header and is
    // checked before the body is read — never a multipart field.
    const fd = new FormData();
    let token = "";
    for (const [k, v] of Object.entries(fields)) {
      if (k === "token") token = String(v); else fd.set(k, v);
    }
    return req("http://test/api/intake/upload", { method: "POST", body: fd, headers: { "x-intake-token": token } });
  }
  const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "a.pdf", { type: "application/pdf" });
  const LINK = { id: "l1", org_id: ORG, project_id: "p1", company_name: "Acme", contact_email: null, allow_auto_supersede: false, expires_at: null, revoked_at: null, assigned_doc_ids: [], created_by: "u9" };

  it("a malformed token is refused before any lookup", async () => {
    const { POST } = await load();
    const res = await POST(upload({ token: "short", file: pdf(), title: "x" }));
    expect(res.status).toBe(400);
    expect(mockState.calls.filter((c) => c.table === "project_intake_links")).toHaveLength(0);
    expect(mockState.r2Sends).toBe(0);
  });

  it("an unknown token is 404 and stores nothing", async () => {
    mockState.tables.project_intake_links = { data: null };
    const { POST } = await load();
    expect((await POST(upload({ token: TOKEN, file: pdf(), title: "x" }))).status).toBe(404);
    expect(mockState.r2Sends).toBe(0);
  });

  it("a revoked or expired link is 410 and stores nothing", async () => {
    const { POST } = await load();
    mockState.tables.project_intake_links = { data: { ...LINK, revoked_at: "2026-09-01T00:00:00Z" } };
    expect((await POST(upload({ token: TOKEN, file: pdf(), title: "x" }))).status).toBe(410);
    mockState.tables.project_intake_links = { data: { ...LINK, expires_at: "2020-01-01T00:00:00Z" } };
    expect((await POST(upload({ token: TOKEN, file: pdf(), title: "x" }))).status).toBe(410);
    expect(mockState.r2Sends).toBe(0);
  });

  it("a live link passes the gate — the next refusal is about the payload, not the credential", async () => {
    mockState.tables.project_intake_links = { data: LINK };
    const { POST } = await load();
    const res = await POST(upload({ token: TOKEN, title: "x" }));
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toMatch(/file is required/);
    expect(mockState.r2Sends).toBe(0);
  });
});

// ── PERF-6: a page read answers before its own function limit ───────────────

describe("PERF-6 — running out of time is a readable 504 naming the page cap, never the platform's", () => {
  const segment = () => post("http://test/api/projects/checklist",
    { orgId: ORG, projectId: "p1", action: "segment", documentId: "d1" });
  function seed() {
    mockState.user = { id: "u1", email: "u1@example.com" };
    mockState.tables.org_members = { data: PLAIN_MEMBER };
    mockState.tables.team_members = { data: [] };
    mockState.tables.projects = { data: { id: "p1", name: "Unit 4" } };
    mockState.tables.documents = { data: docRow() };
    mockState.tables.document_versions = { data: { file_url: "orgs/o1/x.pdf", file_type: "application/pdf" } };
    seedChain();
    mockState.aiText = '{"items":[{"section":null,"text":"Weld records on file"}]}';
  }
  afterEach(() => { vi.useRealTimers(); });

  it("the model is budgeted from the time left (deadline = maxDuration − 15 s), capped at 90 s", async () => {
    seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    const { POST } = await import("@/app/api/projects/checklist/route");
    expect((await POST(segment())).status).toBe(200);
    expect(mockState.aiCalls[0].timeoutMs).toBe(90_000);
    // A 40 s render leaves 65 s of the 105 s budget.
    mockState.render = async () => { vi.setSystemTime(Date.now() + 40_000); return [{ page: 1, mediaType: "image/png", base64: "AA==" }]; };
    expect((await POST(segment())).status).toBe(200);
    expect(mockState.aiCalls[1].timeoutMs).toBe(65_000);
  });

  it("too little time left after the render: 504 with the readable message — the caller's key is never spent", async () => {
    seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    mockState.render = async () => { vi.setSystemTime(Date.now() + 100_000); return [{ page: 1, mediaType: "image/png", base64: "AA==" }]; };
    const { POST } = await import("@/app/api/projects/checklist/route");
    const res = await POST(segment());
    expect(res.status).toBe(504);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(String((await res.json()).error)).toBe(
      "The document was too large to read in time — try fewer pages (this reader reads at most the first 10).");
    expect(mockState.aiCalls).toHaveLength(0);
  });

  it("a render that never finishes is abandoned at the deadline", async () => {
    seed();
    vi.useFakeTimers();
    mockState.render = () => new Promise(() => undefined);
    const { POST } = await import("@/app/api/projects/checklist/route");
    const pending = POST(segment());
    await vi.advanceTimersByTimeAsync(105_000);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(String((await res.json()).error)).toMatch(/too large to read in time.*first 10/);
    expect(mockState.aiCalls).toHaveLength(0);
  });

  it("a model call that times out is the same readable 504, on both page-reading routes", async () => {
    seed();
    mockState.aiError = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const checklist = await import("@/app/api/projects/checklist/route");
    const res = await checklist.POST(segment());
    expect(res.status).toBe(504);
    expect(String((await res.json()).error)).toMatch(/too large to read in time/);
    mockState.tables.org_members = { data: ADDITIVE_DOCCTRL };
    mockState.tables.companies = { data: { id: "co1", name: "Acme" } };
    const qm = await import("@/app/api/companies/quality-manual/route");
    const res2 = await qm.POST(post("http://test/api/companies/quality-manual", { orgId: ORG, companyId: "co1", documentId: "d1" }));
    expect(res2.status).toBe(504);
    expect(String((await res2.json()).error)).toMatch(/too large to read in time.*first 10/);
  });
});
