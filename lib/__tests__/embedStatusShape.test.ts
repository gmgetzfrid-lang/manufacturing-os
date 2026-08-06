// The bug this test exists for: /api/knowledge/embed's status action
// returned a shape MISSING coveredNow — the one field the panel renders —
// so the meaning-index bar showed 0% forever while the database sat at
// 100%. The status response must mirror SemanticProgress exactly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockState = vi.hoisted(() => ({
  coverage: [{ total: 34, embedded: 34 }] as Array<{ total: number; embedded: number }>,
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })) },
    rpc: vi.fn(async () => ({ data: mockState.coverage, error: null })),
    from: () => { throw new Error("status action must not touch tables"); },
  },
}));

vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async () => ({ isController: true })),
}));

beforeEach(() => {
  mockState.coverage = [{ total: 34, embedded: 34 }];
});

function statusReq() {
  return new NextRequest("http://test/api/knowledge/embed", {
    method: "POST",
    headers: { authorization: "Bearer tok" },
    body: JSON.stringify({ orgId: "o1", libraryId: "l1", action: "status" }),
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
});
