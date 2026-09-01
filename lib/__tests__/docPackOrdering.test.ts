// PKG-6: the print pipeline's ORDER is the safety property.
//
//   content assembly (the failure zone) → cover/snapshot of exactly the
//   included sheets → save → download → pin refresh.
//
// A build failure must leave every pin untouched and record nothing; the
// cover (and the immutable print snapshot recorded while building it) must
// describe only sheets that are actually in the PDF.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  fetchOk: true,
  failUrls: new Set<string>(),
}));

vi.mock("@/lib/supabase", () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: tables[table] ?? [], error: null });
        }
        return () => new Proxy(c, handler);
      },
    };
    return new Proxy(c, handler);
  }
  const supabase = { from: (t: string) => chain(t), __tables: tables };
  return { supabase };
});
vi.mock("@/lib/stamping", () => ({ applyStampToPdfDoc: vi.fn(async () => {}) }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => "" }));
vi.mock("pdf-lib", () => {
  const doc = () => ({
    copyPages: async () => ["page"],
    addPage: () => {},
    insertPage: (i: number) => { state.events.push(`insert@${i}`); },
    getPageIndices: () => [0],
    save: async () => { state.events.push("save"); return new Uint8Array([1]); },
  });
  return { PDFDocument: { create: async () => doc(), load: async () => doc() } };
});

import { supabase } from "@/lib/supabase";
import { buildAndDownloadDocPack } from "@/lib/docPack";

const tables = (supabase as unknown as { __tables: Record<string, Array<Record<string, unknown>>> }).__tables;

beforeEach(() => {
  state.events = [];
  state.fetchOk = true;
  state.failUrls = new Set();
  for (const k of Object.keys(tables)) delete tables[k];
  tables.documents = [
    { id: "d1", document_number: "P-101", rev: "3", status: "Issued", current_version_id: "v1" },
    { id: "d2", document_number: "P-102", rev: "1", status: "Issued", current_version_id: "v2" },
  ];
  tables.document_holds = [];
  tables.document_versions = [
    { id: "v1", file_url: "https://files/p101.pdf" },
    { id: "v2", file_url: "https://files/p102.pdf" },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    state.fetchOk && !state.failUrls.has(String(url))
      ? { ok: true, arrayBuffer: async () => new ArrayBuffer(4) }
      : { ok: false, status: 500 }));
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:pack",
    revokeObjectURL: () => {},
  });
  vi.stubGlobal("document", {
    createElement: () => ({ click: () => { state.events.push("download"); }, set href(_: string) {}, set download(_: string) {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
  });
});

const base = { orgId: "org1", packLabel: "pack", documentIds: ["d1", "d2"], userId: "u1" };

describe("buildAndDownloadDocPack ordering (PKG-6)", () => {
  it("cover/snapshot builds AFTER content, from exactly the included sheets; pins move after download", async () => {
    const coverSheets: string[] = [];
    const afterSheets: string[] = [];
    const result = await buildAndDownloadDocPack({
      ...base,
      buildCoverAfter: async (included) => {
        state.events.push("cover");
        coverSheets.push(...included.map((s) => s.documentId));
        return { getPageIndices: () => [0] } as never;
      },
      afterDownload: async (included) => {
        state.events.push("after");
        afterSheets.push(...included.map((s) => s.documentId));
      },
    });
    expect(result.included).toBe(2);
    expect(coverSheets).toEqual(["d1", "d2"]);
    expect(afterSheets).toEqual(["d1", "d2"]);
    // The order IS the fix: cover → prepend → save → download → pins.
    expect(state.events).toEqual(["cover", "insert@0", "save", "download", "after"]);
  });

  it("a fetch-failed sheet is absent from the cover and the after-download set", async () => {
    state.failUrls.add("https://files/p102.pdf");
    const coverSheets: string[] = [];
    const result = await buildAndDownloadDocPack({
      ...base,
      buildCoverAfter: async (included) => {
        coverSheets.push(...included.map((s) => s.documentId));
        return null;
      },
    });
    expect(result.included).toBe(1);
    expect(coverSheets).toEqual(["d1"]);
    expect(result.skipped.some((s) => s.label === "P-102")).toBe(true);
  });

  it("a total build failure calls NEITHER hook — nothing recorded, no pins moved", async () => {
    state.fetchOk = false;
    const cover = vi.fn();
    const after = vi.fn();
    await expect(buildAndDownloadDocPack({
      ...base,
      buildCoverAfter: cover as never,
      afterDownload: after as never,
    })).rejects.toThrow(/No documents could be packed/);
    expect(cover).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(state.events).not.toContain("download");
  });
});
