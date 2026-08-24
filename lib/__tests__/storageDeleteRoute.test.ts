// /api/storage/delete authorization (SURF-2).
//
// Deleting stored bytes must require controller authority, a safe key, and a
// clear hold status, and must be audited. These tests pin each Done-when
// criterion; several FAIL against the pre-SURF-2 route (which deleted for any
// active member, with no key check, no hold check, and no audit row).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  r2sends: 0,
  audits: [] as Array<Record<string, unknown>>,
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
      return (...args: unknown[]) => {
        if (prop === "insert" && table === "audit_logs") state.audits.push(args[0] as Record<string, unknown>);
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

vi.mock("@/lib/r2", () => ({
  r2: { send: vi.fn(async () => { state.r2sends += 1; }) },
  R2_BUCKET: "test-bucket",
}));

import { DELETE } from "@/app/api/storage/delete/route";

const ORG = "12345678-1234-1234-1234-123456789abc";
const KEY = `orgs/${ORG}/libraries/l1/P-101.pdf`;

function del(path: string): Promise<Response> {
  return DELETE(new NextRequest("https://app/api/storage/delete", {
    method: "DELETE",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ path }),
  }));
}

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com" };
  state.tables = {};
  state.r2sends = 0;
  state.audits = [];
});

describe("DELETE /api/storage/delete (SURF-2)", () => {
  it("refuses a Viewer — controller authority required (Done-when 1)", async () => {
    state.tables.org_members = { data: { role: "Viewer", roles: [] } };
    const res = await del(KEY);
    expect(res.status).toBe(403);
    expect(state.r2sends).toBe(0);
  });

  it("refuses a traversal key before any prefix reasoning (Done-when 2)", async () => {
    state.tables.org_members = { data: { role: "Admin", roles: [] } };
    const res = await del(`orgs/${ORG}/../../orgs/other/x.pdf`);
    expect(res.status).toBe(400);
    expect(state.r2sends).toBe(0);
  });

  it("refuses a non-org-prefixed key outright", async () => {
    state.tables.org_members = { data: { role: "Admin", roles: [] } };
    const res = await del("stray.bin");
    expect(res.status).toBe(403);
    expect(state.r2sends).toBe(0);
  });

  it("refuses deletion of a legally-held document's bytes, fail-closed (Done-when 3)", async () => {
    state.tables.org_members = { data: { role: "DocCtrl", roles: [] } };
    state.tables.document_versions = { data: { id: "v1", record_id: "doc1" } };
    state.tables.documents = { data: { legal_hold: true } };
    state.tables.document_holds = { data: [] };
    const res = await del(KEY);
    expect(res.status).toBe(423);
    expect(state.r2sends).toBe(0);
  });

  it("refuses when an active hold exists", async () => {
    state.tables.org_members = { data: { role: "DocCtrl", roles: [] } };
    state.tables.document_versions = { data: { id: "v1", record_id: "doc1" } };
    state.tables.documents = { data: { legal_hold: false } };
    state.tables.document_holds = { data: [{ id: "h1" }] };
    const res = await del(KEY);
    expect(res.status).toBe(423);
    expect(state.r2sends).toBe(0);
  });

  it("refuses when hold status cannot be verified — fail closed", async () => {
    state.tables.org_members = { data: { role: "Admin", roles: [] } };
    state.tables.document_versions = { error: { message: "db down" } };
    const res = await del(KEY);
    expect(res.status).toBe(503);
    expect(state.r2sends).toBe(0);
  });

  it("deletes and writes an audit row for a controller on a clear document (Done-when 4)", async () => {
    state.tables.org_members = { data: { role: "Admin", roles: [] } };
    state.tables.document_versions = { data: { id: "v1", record_id: "doc1" } };
    state.tables.documents = { data: { legal_hold: false } };
    state.tables.document_holds = { data: [] };
    const res = await del(KEY);
    expect(res.status).toBe(200);
    expect(state.r2sends).toBe(1);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0].action).toBe("STORAGE_OBJECT_DELETE");
    expect(state.audits[0].org_id).toBe(ORG);
  });

  it("admits a ['Manager','DocCtrl'] member — additive role read, not headline-only", async () => {
    state.tables.org_members = { data: { role: "Manager", roles: ["Manager", "DocCtrl"] } };
    state.tables.document_versions = { data: null }; // key not tied to a document
    const res = await del(KEY);
    expect(res.status).toBe(200);
    expect(state.r2sends).toBe(1);
  });

  it("refuses the delete when the audit row cannot be written — custody before destruction", async () => {
    // The custody record is written BEFORE r2 destruction and the route fails
    // closed on it: bytes destroyed with no audit row is the unrecoverable
    // ordering. (postgrest resolves failures into { error } — the route must
    // CHECK it, not rely on a catch.)
    state.tables.org_members = { data: { role: "Admin", roles: [] } };
    state.tables.document_versions = { data: null };
    state.tables.audit_logs = { error: { message: "insert failed" } };
    const res = await del(KEY);
    expect(res.status).toBe(503);
    expect(state.r2sends).toBe(0); // nothing was destroyed
  });
});
