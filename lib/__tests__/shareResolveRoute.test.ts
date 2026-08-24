// /api/share/resolve org-join (EGRESS-1 Done-when 1/2).
//
// The resolve route joins the document lookup to the share's org_id, so a
// cross-org share (an org A member naming org B's document UUID) resolves to
// nothing and 404s instead of leaking B's metadata.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const rs = vi.hoisted(() => ({
  share: null as null | Record<string, unknown>,
  doc: null as null | Record<string, unknown>,
  authorized: true,
  documentEqCalls: [] as Array<[string, unknown]>,
}));

vi.mock("@supabase/supabase-js", () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
        return (...args: unknown[]) => {
          if (prop === "eq" && table === "documents") rs.documentEqCalls.push([args[0] as string, args[1]]);
          if (prop === "maybeSingle") {
            if (table === "document_shares") return Promise.resolve({ data: rs.share, error: null });
            if (table === "documents") return Promise.resolve({ data: rs.doc, error: null });
            if (table === "orgs") return Promise.resolve({ data: { name: "Org A" }, error: null });
            return Promise.resolve({ data: null, error: null });
          }
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return {
    createClient: () => ({ from: (t: string) => chain(t), rpc: vi.fn(async () => ({ data: null, error: null })) }),
  };
});

vi.mock("@/lib/shareAuthorization", () => ({
  shareStillAuthorized: vi.fn(async () => rs.authorized),
}));

beforeEach(() => {
  rs.share = null; rs.doc = null; rs.authorized = true; rs.documentEqCalls = [];
});

describe("GET /api/share/resolve org-join (EGRESS-1)", () => {
  const validToken = "a".repeat(32);
  const load = () => import("@/app/api/share/resolve/route");

  it("joins the document lookup to the share's org_id and 404s a cross-org miss", async () => {
    rs.share = { id: "s1", org_id: "orgA", document_id: "docB", created_by: "u1", expires_at: null, revoked_at: null };
    rs.doc = null; // org-scoped lookup misses the cross-org document
    const { GET } = await load();
    const res = await GET(new NextRequest(`https://app/api/share/resolve?token=${validToken}`));
    expect(res.status).toBe(404);
    expect(rs.documentEqCalls).toContainEqual(["org_id", "orgA"]);
  });

  it("410s when the creator's authority has lapsed even for a same-org document", async () => {
    rs.share = { id: "s1", org_id: "orgA", document_id: "docA", created_by: "u1", expires_at: null, revoked_at: null };
    rs.doc = { id: "docA", document_number: "P-1", title: "T", name: "T", rev: "1", current_version_id: null };
    rs.authorized = false;
    const { GET } = await load();
    const res = await GET(new NextRequest(`https://app/api/share/resolve?token=${validToken}`));
    expect(res.status).toBe(410);
  });
});
