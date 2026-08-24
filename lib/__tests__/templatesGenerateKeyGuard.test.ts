// /api/templates/generate — draft-source key guard (XEDGE-1).
//
// The draft branch fetches and PARSES a caller-supplied sourceFileKey. Without
// a key guard it would read any object in the bucket, past document ACLs. The
// source is only ever an output-data/output-examples upload for the caller's
// own org, so the key is pinned to those prefixes; a foreign key is refused
// before any bucket read.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ fetched: [] as string[] }));

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1", email: "u1@x" } }, error: null })) },
    from: () => {
      const c: Record<string, unknown> = {};
      const h: ProxyHandler<Record<string, unknown>> = {
        get(_t, p: string) {
          if (p === "maybeSingle") return () => Promise.resolve({
            data: { id: "tpl1", org_id: "orgA", name: "RFQ", template_file_key: "orgs/orgA/output-templates/t.docx", placeholders: [], mode: "per_row", column_map: {} },
            error: null,
          });
          return () => new Proxy(c, h);
        },
      };
      return new Proxy(c, h);
    },
  },
}));
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async () => ({ uid: "u1", orgId: "orgA", role: "Viewer", isController: false, teamIds: [] })),
}));
vi.mock("@/lib/r2Bytes", () => ({
  fetchBytes: vi.fn(async (key: string) => { state.fetched.push(key); return Buffer.from([]); }),
}));
vi.mock("@/lib/xlsxData", () => ({
  parseWorkbook: vi.fn(() => ({ headers: ["A"], rows: [{ A: "1" }], sheetNames: ["S"] })),
}));

import { POST } from "@/app/api/templates/generate/route";

function draft(sourceFileKey: string): Promise<Response> {
  return POST(new NextRequest("https://app/api/templates/generate", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ orgId: "orgA", templateId: "tpl1", action: "draft", sourceFileKey }),
  }));
}

beforeEach(() => { state.fetched = []; });

describe("POST /api/templates/generate draft key guard (XEDGE-1)", () => {
  it("refuses a sourceFileKey under another org's prefix (403, no bucket read)", async () => {
    const res = await draft("orgs/orgB/documents/lib/secret.xlsx");
    expect(res.status).toBe(403);
    expect(state.fetched).toHaveLength(0);
  });

  it("refuses a sourceFileKey outside the output-data folders even in-org (403)", async () => {
    const res = await draft("orgs/orgA/documents/lib/native-source.xlsx");
    expect(res.status).toBe(403);
    expect(state.fetched).toHaveLength(0);
  });

  it("accepts a legitimate output-data upload for the caller's org", async () => {
    const res = await draft("orgs/orgA/output-data/1700000000000-data.xlsx");
    expect(res.status).toBe(200);
    expect(state.fetched).toEqual(["orgs/orgA/output-data/1700000000000-data.xlsx"]);
  });
});
