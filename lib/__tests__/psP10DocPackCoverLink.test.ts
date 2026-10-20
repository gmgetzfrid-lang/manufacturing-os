// public-surfaces PS-P10 SHEET TOKEN PRINT LINK — the pack print path sends
// the cover's print id with the post-download settle (lib/docPack.ts
// buildAndDownloadDocPack; PHYS-19 done-when 3, rulings under DEC-90).
//
//   - a work-package pack: the cover calls `cover.linkPrint(printId)` after
//     recording its snapshot, and the settle carries `coverPrintId` (the
//     server checks it and links the token print by key);
//   - REGRESSION: a pack whose cover does not link (or has no cover — the
//     asset hub's pack) sends exactly PS-P9's settle, with no coverPrintId
//     key; a build that fails before the download voids the whole print
//     WITHOUT a cover id (no cover lists an empty pack); no token minted →
//     no settle at all, the pack prints as before.
// (Harness: the one lib/__tests__/psP9DocPackTokens.test.ts uses.)

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  stamps: [] as Array<{ verifyUrl?: string }>,
  calls: [] as Array<{ url: string; body: Record<string, unknown> | null; signal: AbortSignal | null }>,
  mint: "ok" as "ok" | "unavailable" | "error" | "throw" | "partial" | "hang" | "empty",
  /** the order things happened in: the download click, each insert, afterDownload, each settle request */
  log: [] as string[],
  /** a settle that never answers until its signal aborts */
  settleHangs: false,
  failUrls: new Set<string>(),
  coverThrows: false,
  origin: "https://app.example.com",
}));

vi.mock("@/lib/supabase", () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: tables[table] ?? [], error: null });
        if (prop === "insert") return () => { state.log.push(`insert:${table}`); return new Proxy(c, handler); };
        return () => new Proxy(c, handler);
      },
    };
    return new Proxy(c, handler);
  }
  const supabase = {
    from: (t: string) => chain(t),
    auth: { getSession: async () => ({ data: { session: { access_token: "jwt" } } }) },
    __tables: tables,
  };
  return { supabase };
});
vi.mock("@/lib/stamping", () => ({
  applyStampToPdfDoc: vi.fn(async (_doc: unknown, opts: { verifyUrl?: string }) => { state.stamps.push({ verifyUrl: opts.verifyUrl }); return { mapped: [] }; }),
}));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => state.origin }));
vi.mock("pdf-lib", () => {
  const doc = () => ({
    copyPages: async () => ["page"],
    addPage: () => {},
    insertPage: () => {},
    getPageIndices: () => [0],
    getPageCount: () => 1,
    save: async () => new Uint8Array([1]),
  });
  return { PDFDocument: { create: async () => doc(), load: async () => doc() } };
});

import { supabase } from "@/lib/supabase";
import { buildAndDownloadDocPack } from "@/lib/docPack";
import { mintSheetTokens, settleSheetTokens, SHEET_TOKEN_FETCH_TIMEOUT_MS } from "@/lib/printSheetTokensClient";

const tables = (supabase as unknown as { __tables: Record<string, Array<Record<string, unknown>>> }).__tables;
const D1 = "d1d1d1d1-0000-0000-0000-000000000001";
const D2 = "d2d2d2d2-0000-0000-0000-000000000002";
const V1 = "e1e1e1e1-0000-0000-0000-000000000001";
const V2 = "e2e2e2e2-0000-0000-0000-000000000002";
const T1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const T2 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";
const PRINT = "f0f0f0f0-0000-0000-0000-000000000000";

beforeEach(() => {
  state.stamps = [];
  state.calls = [];
  state.log = [];
  state.mint = "ok";
  state.settleHangs = false;
  state.failUrls = new Set();
  state.coverThrows = false;
  state.origin = "https://app.example.com";
  for (const k of Object.keys(tables)) delete tables[k];
  tables.documents = [
    { id: D1, document_number: "P-101", rev: "3", status: "Issued", current_version_id: V1 },
    { id: D2, document_number: "P-102", rev: "1", status: "Issued", current_version_id: V2 },
  ];
  tables.document_holds = [];
  tables.document_versions = [
    { id: V1, file_url: "https://files/p101.pdf" },
    { id: V2, file_url: "https://files/p102.pdf" },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
    if (String(url) === "/api/print-sheet-tokens") {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      state.calls.push({ url: String(url), body, signal: init?.signal ?? null });
      if (body?.action === "settle") state.log.push("settle");
      const hang = () => new Promise<never>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      if (body?.action === "settle" && state.settleHangs) return hang();
      if (body?.action === "mint" && state.mint === "hang") return hang();
      if (body?.action === "settle") return { ok: true, status: 200, json: async () => ({ settled: true }) };
      if (state.mint === "throw") throw new Error("network down");
      if (state.mint === "unavailable") return { ok: true, status: 200, json: async () => ({ available: false }) };
      if (state.mint === "error") return { ok: false, status: 503, json: async () => ({ error: "Couldn't mint the sheet tokens" }) };
      if (state.mint === "empty") return { ok: true, status: 200, json: async () => ({ available: true, printId: PRINT, tokens: {} }) };
      const tokens = state.mint === "partial" ? { [D1]: T1 } : { [D1]: T1, [D2]: T2 };
      return { ok: true, status: 200, json: async () => ({ available: true, printId: PRINT, tokens }) };
    }
    return state.failUrls.has(String(url)) ? { ok: false, status: 500 } : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
  }));
  vi.stubGlobal("URL", { createObjectURL: () => "blob:pack", revokeObjectURL: () => {} });
  vi.stubGlobal("document", {
    createElement: () => ({ click: () => { state.log.push("click"); }, set href(_: string) {}, set download(_: string) {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
  });
});

const base = { orgId: "org1", packLabel: "pack", documentIds: [D1, D2], userId: "u1" };
const todayQr = (d: string, v: string) => `https://app.example.com/verify/${d}?v=${v}`;
const settles = () => state.calls.filter((c) => c.body?.action === "settle");


const COVER = "c1c1c1c1-0000-0000-0000-000000000001";

describe("PS-P10 — a work-package pack's settle carries its cover's print id", () => {
  it("the cover links its print: the settle names the sheets in the PDF AND the cover's print id", async () => {
    let seen: { included: number; skipped: number } | null = null;
    const r = await buildAndDownloadDocPack({
      ...base,
      buildCoverAfter: async (included, skipped, cover) => {
        seen = { included: included.length, skipped: skipped.length };
        cover.linkPrint(COVER);
        return null;
      },
    });
    expect(r.included).toBe(2);
    expect(seen).toEqual({ included: 2, skipped: 0 });
    await vi.waitFor(() => expect(settles().map((c) => c.body)).toEqual([
      { action: "settle", orgId: "org1", printId: PRINT, printed: [D1, D2], coverPrintId: COVER },
    ]));
    // still after the distribution record and the click (PS-P9's order)
    expect(state.log.indexOf("click")).toBeLessThan(state.log.indexOf("settle"));
    expect(state.log.indexOf("insert:download_audits")).toBeLessThan(state.log.indexOf("settle"));
  });

  it("REGRESSION: a cover that does not link, and a pack with no cover, send PS-P9's settle exactly (no coverPrintId key)", async () => {
    await buildAndDownloadDocPack({ ...base, buildCoverAfter: async () => null });
    await buildAndDownloadDocPack({ ...base });
    await vi.waitFor(() => expect(settles()).toHaveLength(2));
    for (const s of settles()) {
      expect(s.body).toEqual({ action: "settle", orgId: "org1", printId: PRINT, printed: [D1, D2] });
      expect(Object.keys(s.body ?? {})).not.toContain("coverPrintId");
    }
  });

  it("a build that fails AFTER the cover linked its print voids the whole print without the cover id", async () => {
    vi.stubGlobal("document", {
      createElement: () => { throw new Error("no DOM"); },
      body: { appendChild: () => {}, removeChild: () => {} },
    });
    await expect(buildAndDownloadDocPack({
      ...base,
      buildCoverAfter: async (_i, _s, cover) => { cover.linkPrint(COVER); return null; },
    })).rejects.toThrow(/no DOM/);
    await vi.waitFor(() => expect(settles().map((c) => c.body)).toEqual([{ action: "settle", orgId: "org1", printId: PRINT, printed: [] }]));
  });

  it("REGRESSION: no token minted (20261237 not pasted) → no settle at all, even with a linked cover; every sheet carries today's QR", async () => {
    state.mint = "unavailable";
    const r = await buildAndDownloadDocPack({ ...base, buildCoverAfter: async (_i, _s, cover) => { cover.linkPrint(COVER); return null; } });
    expect(r.included).toBe(2);
    expect(state.stamps.map((s) => s.verifyUrl)).toEqual([todayQr(D1, V1), todayQr(D2, V2)]);
    await new Promise((res) => setTimeout(res, 10));
    expect(settles()).toEqual([]);
  });

  it("settleSheetTokens: coverPrintId rides only when given", async () => {
    await settleSheetTokens({ orgId: "org1", printId: PRINT, printedDocumentIds: [D1], coverPrintId: COVER });
    await settleSheetTokens({ orgId: "org1", printId: PRINT, printedDocumentIds: [D1], coverPrintId: null });
    await settleSheetTokens({ orgId: "org1", printId: PRINT, printedDocumentIds: [D1] });
    expect(settles().map((c) => c.body)).toEqual([
      { action: "settle", orgId: "org1", printId: PRINT, printed: [D1], coverPrintId: COVER },
      { action: "settle", orgId: "org1", printId: PRINT, printed: [D1] },
      { action: "settle", orgId: "org1", printId: PRINT, printed: [D1] },
    ]);
    expect(mintSheetTokens).toBeTypeOf("function");
    expect(SHEET_TOKEN_FETCH_TIMEOUT_MS).toBe(8000);
  });
});
