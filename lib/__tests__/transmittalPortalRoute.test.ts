// /api/transmittal — the external portal file resolver (EGR-1).
//
// `items` is browser-written JSONB, so the portal must resolve an item's file
// only within the transmittal's OWN org — otherwise an issuer could name any
// document version in any tenant and the service-role portal would sign its
// bytes. Both version lookups are org-scoped; a cross-org id resolves no file.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  transmittal: null as Record<string, unknown> | null,
  // keyed by a composite of the filters applied, resolved by the mock below
  versionRow: null as Record<string, unknown> | null,
  versionOrgFilter: null as string | null,
  audits: [] as Array<Record<string, unknown>>,
  signed: 0,
}));

function chain(table: string) {
  const filters: Record<string, unknown> = {};
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => {
          if (table === "document_versions") {
            // Only return the row when the org filter matches its org.
            const ok = state.versionRow && filters.org_id === (state.versionRow.org_id ?? null);
            resolve({ data: ok ? [state.versionRow] : [], error: null });
          } else {
            resolve({ data: [], error: null });
          }
        };
      }
      return (...args: unknown[]) => {
        if (prop === "eq") filters[args[0] as string] = args[1];
        if (prop === "insert" && table === "audit_logs") { state.audits.push(args[0] as Record<string, unknown>); return { then: (r: (v: unknown) => void) => r(undefined), catch: () => undefined }; }
        if (prop === "maybeSingle") {
          if (table === "transmittals") return Promise.resolve({ data: state.transmittal, error: null });
          if (table === "orgs") return Promise.resolve({ data: { name: "Acme" }, error: null });
          const ok = state.versionRow && filters.org_id === (state.versionRow.org_id ?? null);
          return Promise.resolve({ data: ok ? state.versionRow : null, error: null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: { from: (t: string) => chain(t) },
}));
vi.mock("@/lib/r2", () => ({ r2: {}, R2_BUCKET: "b" }));
vi.mock("@aws-sdk/client-s3", () => ({ GetObjectCommand: class {} }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => { state.signed += 1; return "https://signed/get"; }),
}));

import { GET } from "@/app/api/transmittal/route";

const TOKEN = "abcdefabcdefabcdefabcdefabcdefab";
const DOC = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function get(file?: string): Promise<Response> {
  const u = new URL("https://app/api/transmittal");
  u.searchParams.set("token", TOKEN);
  if (file) u.searchParams.set("file", file);
  return GET(new NextRequest(u));
}

beforeEach(() => {
  state.transmittal = {
    id: "t1", org_id: "orgA", status: "issued", number: "T-1",
    items: [{ documentId: DOC, number: "P-101", rev: "3" }],
    created_by: "issuer1",
  };
  state.versionRow = null;
  state.audits = [];
  state.signed = 0;
});

describe("GET /api/transmittal file resolver (EGR-1)", () => {
  it("signs the file when the named version is in the transmittal's org", async () => {
    state.versionRow = { file_url: `orgs/orgA/d/${DOC}.pdf`, org_id: "orgA", created_at: "2026-01-01" };
    const res = await get(DOC);
    expect(res.status).toBe(200);
    expect(state.signed).toBe(1);
    // audit attributes to the issuer, not null
    expect(state.audits[0]?.user_id).toBe("issuer1");
  });

  it("refuses to resolve a version that belongs to another org (404, no signature)", async () => {
    // Same document id on the item, but the version row is in org B.
    state.versionRow = { file_url: `orgs/orgB/d/${DOC}.pdf`, org_id: "orgB", created_at: "2026-01-01" };
    const res = await get(DOC);
    expect(res.status).toBe(404);
    expect(state.signed).toBe(0); // no cross-tenant bytes signed
  });

  it("rejects a file not listed on the transmittal (403)", async () => {
    const res = await get("99999999-9999-9999-9999-999999999999");
    expect(res.status).toBe(403);
    expect(state.signed).toBe(0);
  });
});
