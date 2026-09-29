// Document-control Round F — P10 EDGES: /api/templates/generate render.
//
//   XEDGE-2   a literal em dash in the zip name, and any non-Latin-1
//             character in a document name, made NextResponse throw AFTER
//             the production record and audit row were written. Now the
//             Content-Disposition is ASCII (`filename=` folded) plus RFC 5987
//             `filename*`, and the record is written only after the response
//             has been constructed.
//   XEDGE-11  the render action is capped at MAX_ROWS_PER_CALL (25) like the
//             draft path, and values are filtered to the template's declared
//             placeholder tags before they reach the renderer.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  rendered: [] as Array<Record<string, unknown>>,
  log: [] as Array<{ table: string; calls: Array<{ m: string; args: unknown[] }> }>,
  placeholders: [{ tag: "name", label: "Name", kind: "data" }, { tag: "title", label: "Title", kind: "ai" }] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1", email: "u1@x" } }, error: null })) },
    from: (table: string) => {
      const calls: Array<{ m: string; args: unknown[] }> = [];
      const resolve = () => {
        state.log.push({ table, calls });
        if (table === "output_templates") {
          return { data: { id: "tpl1", org_id: "orgA", name: "RFQ", kind: "docx", template_file_key: "orgs/orgA/output-templates/t.docx", placeholders: state.placeholders, mode: "per_row", column_map: {}, filename_pattern: null }, error: null };
        }
        if (table === "output_generations") return { data: { id: "gen-1" }, error: null };
        return { data: null, error: null };
      };
      const proxy: Record<string, unknown> = new Proxy(function () {} as unknown as Record<string, unknown>, {
        get(_t, p: string) {
          if (p === "then") return (res: (v: unknown) => void) => res(resolve());
          return (...args: unknown[]) => { calls.push({ m: p, args }); return proxy; };
        },
      });
      return proxy;
    },
  },
}));
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async () => ({ uid: "u1", orgId: "orgA", role: "Viewer", isController: false, teamIds: [] })),
}));
vi.mock("@/lib/orgMemberName", () => ({ memberDisplayName: vi.fn(async () => "U One") }));
vi.mock("@/lib/r2Bytes", () => ({ fetchBytes: vi.fn(async () => Buffer.from([0x50, 0x4b])) }));
vi.mock("@/lib/docxRender", () => {
  class TemplateRenderError extends Error { constructor(message: string, public readonly details: unknown[]) { super(message); this.name = "TemplateRenderError"; } }
  return {
    TemplateRenderError,
    renderTemplate: vi.fn((_bytes: Uint8Array, values: Record<string, unknown>) => { state.rendered.push(values); return new Uint8Array([1, 2, 3]); }),
  };
});

import { POST } from "@/app/api/templates/generate/route";

function render(documents: Array<{ values: Record<string, string>; filename?: string }>, extra: Record<string, unknown> = {}): Promise<Response> {
  return POST(new NextRequest("https://app/api/templates/generate", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ orgId: "orgA", templateId: "tpl1", action: "render", documents, ...extra }),
  }));
}

/** Parse both parameters of an RFC 6266 Content-Disposition. */
function parseDisposition(h: string | null): { ascii: string; utf8: string } {
  const value = h ?? "";
  expect(value).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''[!#$&+\-.^_`|~A-Za-z0-9%]+$/);
  for (const ch of value) expect(ch.charCodeAt(0), `non-ASCII byte in header: ${value}`).toBeLessThan(0x80);
  const ascii = value.match(/filename="([^"]+)"/)![1];
  const utf8 = decodeURIComponent(value.match(/filename\*=UTF-8''(.+)$/)![1]);
  return { ascii, utf8 };
}

beforeEach(() => { state.rendered = []; state.log = []; });

describe("XEDGE-2 — filenames with an em dash and CJK download with a parseable Content-Disposition", () => {
  it("two documents → 200, an ASCII zip name plus the exact UTF-8 name as filename*", async () => {
    const res = await render([
      { values: { name: "A" }, filename: "Bericht — Nord.docx" },
      { values: { name: "B" }, filename: "報告書 — 2.docx" },
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const { ascii, utf8 } = parseDisposition(res.headers.get("content-disposition"));
    expect(utf8).toBe("RFQ - 2 documents.zip");
    expect(ascii).toBe("RFQ - 2 documents.zip");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("a single document whose name carries an em dash and CJK → 200 with both parameters", async () => {
    const res = await render([{ values: { name: "A" }, filename: "報告書 — Nord Süd.docx" }]);
    expect(res.status).toBe(200);
    const { ascii, utf8 } = parseDisposition(res.headers.get("content-disposition"));
    expect(utf8).toBe("報告書 — Nord Süd.docx");
    expect(ascii).toBe("_ _ Nord Sud.docx");
  });

  it("the production record and audit row are written only after the response is constructed (source pin)", () => {
    const src = readFileSync(join(process.cwd(), "app/api/templates/generate/route.ts"), "utf8");
    // download path: both NextResponse constructions precede the record write
    const record = src.lastIndexOf("await recordProduction();");
    const construct = src.lastIndexOf("response = new NextResponse(");
    expect(construct).toBeGreaterThan(0);
    expect(record).toBeGreaterThan(construct);
    // JSON path: the body is built before the record is written
    const jsonBody = src.indexOf("const files = rendered.map(");
    const jsonRecord = src.indexOf("const generationId = await recordProduction();");
    expect(jsonBody).toBeGreaterThan(0);
    expect(jsonRecord).toBeGreaterThan(jsonBody);
    // no record write survives above the response construction
    expect(src.indexOf("from(\"output_generations\").insert(")).toBeGreaterThan(src.indexOf("const recordProduction = async"));
    expect(src).not.toMatch(/ — \$\{rendered\.length\} documents\.zip/);
    expect(src).toMatch(/"content-disposition": contentDispositionAttachment\(/);
  });

  it("the JSON (filing) path still returns the generation id and every file", async () => {
    const res = await render([{ values: { name: "A" } }, { values: { name: "B" } }], { returnJson: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generationId).toBe("gen-1");
    expect(body.files).toHaveLength(2);
    expect(state.log.filter((l) => l.table === "output_generations")).toHaveLength(1);
  });
});

describe("XEDGE-11 — render is bounded and values are filtered to declared tags", () => {
  it("26 documents → 413 and nothing is rendered or recorded", async () => {
    const res = await render(Array.from({ length: 26 }, (_, i) => ({ values: { name: `n${i}` } })));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/at most 25 documents per call \(26 sent\)/);
    expect(state.rendered).toEqual([]);
    expect(state.log.filter((l) => l.table === "output_generations" || l.table === "audit_logs")).toEqual([]);
  });

  it("25 documents render; a caller-invented tag never reaches the renderer", async () => {
    const docs = Array.from({ length: 25 }, (_, i) => ({ values: { name: `n${i}`, title: "t", evil: "<w:p><w:r><w:t>INJECTED</w:t></w:r></w:p>" } }));
    const res = await render(docs, { returnJson: true });
    expect(res.status).toBe(200);
    expect(state.rendered).toHaveLength(25);
    expect(state.rendered[0]).toEqual({ name: "n0", title: "t" });
    expect(state.rendered.every((v) => !("evil" in v))).toBe(true);
  });

  it("an undeclared template (no placeholders) renders nothing injectable", async () => {
    state.placeholders = [];
    const res = await render([{ values: { anything: "x" } }], { returnJson: true });
    expect(res.status).toBe(200);
    expect(state.rendered).toEqual([{}]);
    state.placeholders = [{ tag: "name", label: "Name", kind: "data" }, { tag: "title", label: "Title", kind: "ai" }];
  });
});
