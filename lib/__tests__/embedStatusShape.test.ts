// The bug this test exists for: /api/knowledge/embed's status action
// returned a shape MISSING coveredNow — the one field the panel renders —
// so the meaning-index bar showed 0% forever while the database sat at
// 100%. The status response must mirror SemanticProgress exactly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockState = vi.hoisted(() => ({
  coverage: [{ total: 34, embedded: 34 }] as Array<{ total: number; embedded: number }>,
  rpcError: null as { code?: string; message: string } | null,
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })) },
    // The route bounds the count with .abortSignal(); the builder supports it.
    rpc: vi.fn(() => {
      const p = Promise.resolve(mockState.rpcError
        ? { data: null, error: mockState.rpcError }
        : { data: mockState.coverage, error: null });
      return Object.assign(p, { abortSignal: () => p });
    }),
    from: () => { throw new Error("status action must not touch tables"); },
  },
}));

vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async () => ({ isController: true })),
}));

beforeEach(() => {
  mockState.coverage = [{ total: 34, embedded: 34 }];
  mockState.rpcError = null;
});

function statusReq(extra: Record<string, unknown> = {}) {
  return new NextRequest("http://test/api/knowledge/embed", {
    method: "POST",
    headers: { authorization: "Bearer tok" },
    body: JSON.stringify({ orgId: "o1", libraryId: "l1", action: "status", ...extra }),
  });
}

describe("embed status response mirrors SemanticProgress", () => {
  it("carries coveredNow — the field the panel actually renders", async () => {
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(statusReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      embedded: 0,
      total: 34,
      coveredNow: 34,
      remaining: 0,
      done: true,
      error: null,
      spentThisRun: 0,
    });
  });

  it("reports partial coverage faithfully", async () => {
    mockState.coverage = [{ total: 34, embedded: 12 }];
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const body = await (await POST(statusReq())).json();
    expect(body.coveredNow).toBe(12);
    expect(body.remaining).toBe(22);
    expect(body.done).toBe(false);
  });

  it("a count that times out while the index is being written is 'busy', never an error", async () => {
    mockState.rpcError = { code: "57014", message: "canceling statement due to statement timeout" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    const res = await POST(statusReq({ known: { total: 36071, covered: 15926 } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ busy: true, error: null, total: 36071, coveredNow: 15926, done: false });
  });

  it("only a missing function reads as the migration message", async () => {
    mockState.rpcError = { code: "PGRST202", message: "Could not find the function public.semantic_coverage" };
    const { POST } = await import("@/app/api/knowledge/embed/route");
    expect((await POST(statusReq())).status).toBe(424);
  });
});
