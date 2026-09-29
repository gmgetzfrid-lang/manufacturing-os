// Document-control Round F — P10 EDGES (fix pass): a >25-document batch is
// rendered in server-sized slices, and every document keeps a name that is
// unique across the WHOLE batch — not just within its slice.
//
//   The server de-duplicates names per call (uniqueFilenames in
//   app/api/templates/generate/route.ts). A template with no filename
//   pattern names every row "<template>.docx", so each slice used to restart
//   at "RFQ (2).docx": the client-assembled zip (JSZip replaces a same-name
//   entry) silently dropped 35 of 60 documents and the filing path filed 60
//   documents under 25 repeated numbers. Now the client decides one
//   batch-unique name per document BEFORE slicing and sends it explicitly,
//   and the zip assembly de-duplicates once more before adding entries.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import JSZip from "jszip";
import { uniqueFilenames } from "@/lib/outputTemplateText";

const state = vi.hoisted(() => ({
  requests: [] as Array<{ documents: Array<{ values: Record<string, string>; filename?: string }>; returnJson?: boolean }>,
  filed: [] as Array<{ documentNumber: string; fileName: string }>,
  downloads: [] as Array<{ name: string; blob: Blob }>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "jwt" } } }) } },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn() }));
vi.mock("@/lib/revisions", () => ({
  createDocumentWithFile: vi.fn(async (input: { documentNumber: string; file: File }) => {
    state.filed.push({ documentNumber: input.documentNumber, fileName: input.file.name });
    return { id: `doc-${state.filed.length}` };
  }),
}));

import { batchFilenames, assembleClientZip, renderDocuments, fileDocumentsToLibrary, RENDER_CHUNK } from "@/lib/outputTemplates";

/** The server's render branch, as far as names go: per-call de-duplication
 *  of `filename ?? "<template>.docx"` (the pattern-less renderFilename). */
function serverRender(body: { documents: Array<{ filename?: string }>; returnJson?: boolean }) {
  if (body.documents.length > RENDER_CHUNK) return new Response(JSON.stringify({ error: "too many" }), { status: 413 });
  const names = uniqueFilenames(body.documents.map((d) => d.filename?.trim() || "RFQ.docx"));
  const files = names.map((name) => ({
    name, contentType: "application/octet-stream", base64: Buffer.from(`bytes of ${name}`).toString("base64"),
  }));
  return new Response(JSON.stringify({ generationId: `gen-${state.requests.length}`, files }), { status: 200 });
}

let lastBlob: Blob | null = null;
beforeEach(() => {
  state.requests = []; state.filed = []; state.downloads = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { action: string; documents: Array<{ values: Record<string, string>; filename?: string }>; returnJson?: boolean };
    if (body.action === "filed") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    state.requests.push({ documents: body.documents, returnJson: body.returnJson });
    return serverRender(body);
  }));
  // renderDocuments hands the zip to the browser; capture it instead.
  vi.stubGlobal("document", { createElement: () => ({ click() { /* captured below */ }, set href(_v: string) { /* noop */ }, set download(name: string) { state.downloads.push({ name, blob: lastBlob! }); } }) });
  vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: (b: Blob) => { lastBlob = b; return "blob:x"; }, revokeObjectURL: () => undefined }));
});
afterEach(() => vi.unstubAllGlobals());

const sixty = (filename?: string) => Array.from({ length: 60 }, (_, i) => ({ values: { row: String(i + 1) }, filename }));

describe("batchFilenames — one unique name per document, decided before slicing", () => {
  it("60 draft names 'RFQ.docx' become 60 distinct names numbered across the whole batch", () => {
    const names = batchFilenames(sixty("RFQ.docx"), "RFQ");
    expect(names).toHaveLength(60);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(60);
    expect(names[0]).toBe("RFQ.docx");
    expect(names[25]).toBe("RFQ (26).docx");
    expect(names[59]).toBe("RFQ (60).docx");
  });
  it("a document without a draft name gets an index-unique fallback from the template name and kind", () => {
    const names = batchFilenames([{ filename: "" }, {}, { filename: "  " }], "Weekly / Report", "xlsx");
    expect(names).toEqual(["Weekly - Report-1.xlsx", "Weekly - Report-2.xlsx", "Weekly - Report-3.xlsx"]);
    expect(batchFilenames([{}])).toEqual(["document-1.docx"]);
  });
});

describe("assembleClientZip — a zip of N files holds N entries", () => {
  it("de-duplicates names once more before adding, and carries the template name", async () => {
    const files = [
      { name: "RFQ.docx", base64: Buffer.from("a").toString("base64") },
      { name: "RFQ.docx", base64: Buffer.from("b").toString("base64") },
      { name: "rfq.docx", base64: Buffer.from("c").toString("base64") },
    ];
    const zip = await assembleClientZip(files, "RFQ: Q3");
    expect(zip.name).toBe("RFQ- Q3 - 3 documents.zip");
    expect(zip.entries).toEqual(["RFQ.docx", "RFQ (2).docx", "rfq (3).docx"]);
    const loaded = await JSZip.loadAsync(zip.bytes);
    expect(Object.keys(loaded.files).sort()).toEqual(["RFQ (2).docx", "RFQ.docx", "rfq (3).docx"]);
    expect(await loaded.file("RFQ (2).docx")!.async("string")).toBe("b");
  });
});

describe("the >25 download and filing paths (XEDGE-11 done-when 1, cross-slice)", () => {
  it("60 documents all drafted as RFQ.docx download as ONE zip of 60 distinct entries, named after the template", async () => {
    await renderDocuments({ orgId: "o", templateId: "t", templateName: "RFQ", templateKind: "docx", documents: sixty("RFQ.docx") });
    expect(state.requests.map((r) => r.documents.length)).toEqual([25, 25, 10]);
    expect(state.requests.every((r) => r.returnJson && r.documents.every((d) => typeof d.filename === "string" && d.filename.length > 0))).toBe(true);
    expect(state.downloads).toHaveLength(1);
    expect(state.downloads[0].name).toBe("RFQ - 60 documents.zip");
    const loaded = await JSZip.loadAsync(await state.downloads[0].blob.arrayBuffer());
    const entries = Object.keys(loaded.files);
    expect(entries).toHaveLength(60);
    expect(new Set(entries.map((e) => e.toLowerCase())).size).toBe(60);
    expect(entries).toContain("RFQ.docx");
    expect(entries).toContain("RFQ (60).docx");
  });

  it("60 documents all drafted as RFQ.docx file into the library under 60 distinct numbers", async () => {
    const res = await fileDocumentsToLibrary({
      orgId: "o", templateId: "t", templateName: "RFQ", templateKind: "docx",
      documents: sixty("RFQ.docx"), target: { libraryId: "lib" }, actorUserId: "u",
    });
    expect(res).toEqual({ filed: 60, errors: [] });
    const numbers = state.filed.map((f) => f.documentNumber);
    expect(numbers).toHaveLength(60);
    expect(new Set(numbers.map((n) => n.toLowerCase())).size).toBe(60);
    expect(numbers[0]).toBe("RFQ");
    expect(numbers[59]).toBe("RFQ (60)");
  });

  it("a ≤25 batch never reaches the client zip (the server zip path is unchanged)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200, headers: { "content-disposition": "attachment; filename=\"x.zip\"; filename*=UTF-8''RFQ%20-%2025%20documents.zip" },
    })));
    await renderDocuments({ orgId: "o", templateId: "t", templateName: "RFQ", documents: sixty("RFQ.docx").slice(0, 25) });
    expect(state.requests).toHaveLength(0);
    expect(state.downloads.map((d) => d.name)).toEqual(["RFQ - 25 documents.zip"]);
  });
});
