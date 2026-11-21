import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// A small stand-in for the database: tables of rows, and the filters the
// route uses (eq, in, not-null, ilike, range, limit).
const db: Record<string, Array<Record<string, unknown>>> = {};
const asked: Array<{ table: string; filters: string[] }> = [];
function query(table: string) {
  let rows = [...(db[table] ?? [])];
  const filters: string[] = [];
  asked.push({ table, filters });
  const q = {
    select: () => q,
    eq: (k: string, v: unknown) => { filters.push(`eq:${k}`); rows = rows.filter((r) => r[k] === v); return q; },
    in: (k: string, vs: unknown[]) => { filters.push(`in:${k}`); rows = rows.filter((r) => vs.includes(r[k])); return q; },
    not: (k: string) => { rows = rows.filter((r) => r[k] != null); return q; },
    ilike: (k: string, pat: string) => { const needle = pat.replace(/%/g, "").toLowerCase(); rows = rows.filter((r) => String(r[k] ?? "").toLowerCase().includes(needle)); return q; },
    order: () => q,
    range: (from: number, to: number) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
    limit: (n: number) => Promise.resolve({ data: rows.slice(0, n), error: null }),
    then: (ok: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok),
  };
  return q;
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (t: string) => query(t),
    auth: { getUser: async (tok: string) => (tok === "good" ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
  },
}));
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: async (org: string, uid: string) => (org === ORG && uid === "u1" ? { orgId: org, uid } : null),
  // The person can open drawing d1 only.
  readableControlledDocIds: async (_p: unknown, ids: string[]) => new Set(ids.filter((i) => i === "d1")),
}));

const ORG = "215b762d-7be4-4cbd-bdb1-4b2703d81296";
const get = async (qs: string, token = "good") => {
  const { GET } = await import("@/app/api/drawings/readings/route");
  const res = await GET(new NextRequest(`http://x/api/drawings/readings?${qs}`, { headers: { authorization: `Bearer ${token}` } }));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  asked.length = 0;
  db.knowledge_documents = [
    { id: "k1", org_id: ORG, source_document_id: "d1" },
    { id: "k2", org_id: ORG, source_document_id: "d2" },
  ];
  db.knowledge_page_entities = [
    { id: "e1", org_id: ORG, document_id: "k1", page: 1, kind: "xref", tag: "2002-D 2001 SH 3", raw: "TO 2002-D 2001 SH 3" },
    { id: "e2", org_id: ORG, document_id: "k1", page: 1, kind: "equipment", tag: "X-31", raw: "X-31 (2030.31) CRUDE TOWER" },
    { id: "e3", org_id: ORG, document_id: "k2", page: 2, kind: "equipment", tag: "X-31", raw: "X-31 (2030.31)" },
    { id: "e4", org_id: ORG, document_id: "k1", page: 1, kind: "self", tag: "2002-D 2001", raw: null },
  ];
});

describe("drawing readings for the browser", () => {
  it("returns only what's on drawings the person can open, under the drawing's own id", async () => {
    const r = await get(`orgId=${ORG}`);
    expect(r.status).toBe(200);
    expect(r.body.readings.map((x: { documentId: string; tag: string }) => `${x.documentId}:${x.tag}`).sort()).toEqual(["d1:2002-D 2001 SH 3", "d1:X-31"]);
    // Every bulk read of the readings names its kinds.
    expect(asked.filter((a) => a.table === "knowledge_page_entities").every((a) => a.filters.includes("in:kind") && a.filters.includes("eq:org_id"))).toBe(true);
  });

  it("finds where sheets print an equipment ID, still only on drawings the person can open", async () => {
    const r = await get(`orgId=${ORG}&id=2030.31`);
    expect(r.body.readings).toEqual([{ documentId: "d1", page: 1, kind: "equipment", tag: "X-31", raw: "X-31 (2030.31) CRUDE TOWER" }]);
  });

  it("refuses anyone not signed in or not in the workspace", async () => {
    expect((await get(`orgId=${ORG}`, "nope")).status).toBe(401);
    expect((await get(`orgId=00000000-0000-0000-0000-000000000000`)).status).toBe(403);
    expect((await get(`orgId=not-an-id`)).status).toBe(400);
  });
});
