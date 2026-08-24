// /api/storage/upload-url — the signed-PUT gate (PKG-1).
//
// The route signs a PUT for a caller-supplied key. It must refuse to re-sign
// a key that is already the stored bytes of a document version — an in-place
// overwrite of an issued, hash-recorded revision that changes what every QR
// and download serves while the database facts stay untouched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  signed: 0,
}));

function chain(table: string) {
  const result = () => state.tables[table] ?? { data: null, error: null };
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = result();
        return (resolve: (v: unknown) => void) => resolve({ data: r.data ?? null, error: r.error ?? null });
      }
      return (..._args: unknown[]) => {
        if (prop === "maybeSingle" || prop === "single") {
          const r = result();
          const d = Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? null);
          return Promise.resolve({ data: d, error: r.error ?? null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () =>
        state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
    from: (t: string) => chain(t),
  },
}));

vi.mock("@/lib/r2", () => ({ r2: {}, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/client-s3", () => ({ PutObjectCommand: class {} }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => { state.signed += 1; return "https://signed.example/put"; }),
}));

import { POST } from "@/app/api/storage/upload-url/route";

const ORG = "12345678-1234-1234-1234-123456789abc";

function post(path: string): Promise<Response> {
  return POST(new NextRequest("https://app/api/storage/upload-url", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ path }),
  }));
}

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com" };
  state.tables = {};
  state.signed = 0;
});

describe("POST /api/storage/upload-url (PKG-1)", () => {
  it("signs a PUT for a fresh key belonging to the caller's org", async () => {
    state.tables.org_members = { data: { uid: "u1" } };
    state.tables.document_versions = { data: null }; // key not a version's bytes
    const res = await post(`orgs/${ORG}/documents/lib/${Date.now()}-new.pdf`);
    expect(res.status).toBe(200);
    expect(state.signed).toBe(1);
  });

  it("refuses (409) to re-sign a key that is a published version's file_url", async () => {
    state.tables.org_members = { data: { uid: "u1" } };
    state.tables.document_versions = { data: { id: "v1" } }; // key IS a version's bytes
    const res = await post(`orgs/${ORG}/documents/lib/issued-P-101-rev5.pdf`);
    expect(res.status).toBe(409);
    expect(state.signed).toBe(0); // never signed
  });

  it("fails closed (503) when the version-ledger check errors — no signature", async () => {
    state.tables.org_members = { data: { uid: "u1" } };
    state.tables.document_versions = { error: { message: "db down" } };
    const res = await post(`orgs/${ORG}/documents/lib/x.pdf`);
    expect(res.status).toBe(503);
    expect(state.signed).toBe(0);
  });

  it("still refuses a non-member of the key's org before any ledger check", async () => {
    state.tables.org_members = { data: null };
    const res = await post(`orgs/${ORG}/documents/lib/x.pdf`);
    expect(res.status).toBe(403);
    expect(state.signed).toBe(0);
  });
});
