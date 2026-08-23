// Team Management "Add member" route — the identity-collision and role-merge
// contracts (audit findings IDENT-2, IDENT-3, ORGSEL-3, ORGSEL-5).
//
// Defects pinned here:
//  · IDENT-2 — the profile lookup used maybeSingle() and discarded its error,
//    so two profiles sharing an email read as "no profile" and the fallback
//    attached the role to whichever identity listUsers paged first. The
//    contract: two profiles → 409 naming both uids, and NO membership write.
//  · ORGSEL-3 — the re-add path wrote `roles: [role]`, an assignment that
//    silently deleted every other hat the member held. The contract: re-add
//    MERGES into the collection and the headline is recomputed from the
//    merged set.
//  · ORGSEL-5 — the same write nulled display_name when none was provided.
//  · IDENT-3 — the lookup matches case-insensitively on the normalized email.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type QueuedResult = { data?: unknown; error?: unknown };

const mockState = vi.hoisted(() => ({
  authUser: null as null | { id: string; email?: string },
  createUserResult: { data: { user: null as null | { id: string } }, error: null as null | { message: string; code?: string } },
  listUsersPages: [] as Array<Array<{ id: string; email: string }>>,
  // FIFO of results per table — each awaited terminal (then/maybeSingle/
  // single) consumes the next queued result for its table.
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
          resolve({ data: r.data ?? null, error: r.error ?? null });
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
      getUser: vi.fn(async () =>
        mockState.authUser
          ? { data: { user: mockState.authUser }, error: null }
          : { data: { user: null }, error: { message: "bad token" } }),
      admin: {
        createUser: vi.fn(async () => mockState.createUserResult),
        listUsers: vi.fn(async ({ page }: { page: number }) => ({
          data: { users: mockState.listUsersPages[page - 1] ?? [] },
          error: null,
        })),
        deleteUser: vi.fn(async () => ({ data: null, error: null })),
      },
    },
    from: (table: string) => makeChain(table),
  },
}));

import { POST } from "@/app/api/admin/create-user/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/create-user", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function memberWrites() {
  return mockState.calls.filter(
    (c) => c.table === "org_members" && (c.method === "insert" || c.method === "update")
  );
}

beforeEach(() => {
  mockState.authUser = { id: "admin-1", email: "admin@corp.com" };
  mockState.createUserResult = { data: { user: null }, error: { message: "should not be called" } };
  mockState.listUsersPages = [];
  mockState.queues = {};
  mockState.calls = [];
});

describe("POST /api/admin/create-user — identity collisions (IDENT-2)", () => {
  it("returns 409 naming both uids and writes NO membership when two profiles share the email", async () => {
    mockState.queues = {
      org_members: [{ data: { role: "Admin" } }], // caller membership
      users: [{ data: [{ id: "uid-a", email: "greg@corp.com" }, { id: "uid-b", email: "Greg@Corp.com" }] }],
    };
    const res = await POST(makeRequest({ email: "greg@corp.com", password: "x", orgId: "org-1", role: "DocCtrl" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.collidingUids).toEqual(["uid-a", "uid-b"]);
    expect(String(body.error)).toContain("Multiple accounts");
    expect(memberWrites()).toHaveLength(0);
  });

  it("refuses to guess when the auth fallback finds two identities on one address", async () => {
    mockState.queues = {
      org_members: [{ data: { role: "Admin" } }],
      users: [{ data: [] }], // no profile rows
    };
    mockState.createUserResult = { data: { user: null }, error: { message: "A user with this email address has already been registered" } };
    mockState.listUsersPages = [[
      { id: "uid-a", email: "greg@corp.com" },
      { id: "uid-b", email: "Greg@Corp.com" },
      { id: "uid-z", email: "other@corp.com" },
    ]];
    const res = await POST(makeRequest({ email: "GREG@corp.com", password: "x", orgId: "org-1", role: "Drafter" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.collidingUids).toEqual(["uid-a", "uid-b"]);
    expect(memberWrites()).toHaveLength(0);
  });

  it("fails closed (500, no writes) when the profile lookup itself errors", async () => {
    mockState.queues = {
      org_members: [{ data: { role: "Admin" } }],
      users: [{ error: { message: "connection reset" } }],
    };
    const res = await POST(makeRequest({ email: "new@corp.com", password: "x", orgId: "org-1", role: "Viewer" }));
    expect(res.status).toBe(500);
    expect(memberWrites()).toHaveLength(0);
  });

  it("matches the profile case-insensitively on the normalized address (IDENT-3)", async () => {
    mockState.queues = {
      org_members: [
        { data: { role: "Admin" } },            // caller membership
        { data: null },                           // no existing member
        { data: null, error: null },              // insert
        { data: null, error: null },              // roles seed update
      ],
      users: [
        { data: [{ id: "uid-a", email: "greg@corp.com" }] }, // profile found
        { data: null },                           // profile upsert
      ],
    };
    const res = await POST(makeRequest({ email: "  GREG@CORP.COM ", password: "x", orgId: "org-1", role: "Drafter" }));
    expect(res.status).toBe(200);
    const ilikeCall = mockState.calls.find((c) => c.table === "users" && c.method === "ilike");
    expect(ilikeCall).toBeDefined();
    expect(ilikeCall!.args).toEqual(["email", "greg@corp.com"]);
  });
});

describe("POST /api/admin/create-user — re-add merges roles (ORGSEL-3)", () => {
  it("re-adding a two-hat member with one role keeps both hats and recomputes the headline", async () => {
    mockState.queues = {
      org_members: [
        { data: { role: "Admin" } }, // caller membership
        { data: { uid: "uid-a", role: "DraftingSupervisor", roles: ["DraftingSupervisor", "DocCtrl"], display_name: "Greg" } },
        { data: null, error: null }, // the update
      ],
      users: [
        { data: [{ id: "uid-a", email: "greg@corp.com" }] }, // profile lookup
        { data: null },                                       // profile upsert
      ],
    };
    const res = await POST(makeRequest({ email: "greg@corp.com", password: "x", orgId: "org-1", role: "Requester" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toBe(true);
    expect(body.roles).toEqual(expect.arrayContaining(["DraftingSupervisor", "DocCtrl", "Requester"]));

    const update = mockState.calls.find((c) => c.table === "org_members" && c.method === "update");
    expect(update).toBeDefined();
    const payload = update!.args[0] as { role: string; roles: string[]; display_name: string | null };
    expect(payload.roles).toEqual(expect.arrayContaining(["DraftingSupervisor", "DocCtrl", "Requester"]));
    expect(payload.roles).toHaveLength(3);
    // Headline recomputed from the merged set — never the (lower) granted role.
    expect(payload.role).toBe("DraftingSupervisor");
  });

  it("preserves the stored display name when the caller provides none (ORGSEL-5)", async () => {
    mockState.queues = {
      org_members: [
        { data: { role: "Admin" } },
        { data: { uid: "uid-a", role: "Drafter", roles: ["Drafter"], display_name: "Greg G" } },
        { data: null, error: null },
      ],
      users: [
        { data: [{ id: "uid-a", email: "greg@corp.com" }] },
        { data: null },
      ],
    };
    const res = await POST(makeRequest({ email: "greg@corp.com", password: "x", orgId: "org-1", role: "Drafter" }));
    expect(res.status).toBe(200);
    const update = mockState.calls.find((c) => c.table === "org_members" && c.method === "update");
    expect((update!.args[0] as { display_name: string | null }).display_name).toBe("Greg G");
  });

  it("still refuses a non-Admin altering an existing Admin", async () => {
    mockState.authUser = { id: "docctrl-1" };
    mockState.queues = {
      org_members: [
        { data: { role: "DocCtrl" } },
        { data: { uid: "uid-a", role: "Admin", roles: ["Admin"], display_name: null } },
      ],
      users: [{ data: [{ id: "uid-a", email: "boss@corp.com" }] }],
    };
    const res = await POST(makeRequest({ email: "boss@corp.com", password: "x", orgId: "org-1", role: "Viewer" }));
    expect(res.status).toBe(403);
    expect(memberWrites()).toHaveLength(0);
  });
});
