// public-surfaces PS-P9 — the pack print path names each sheet by its
// per-print token (lib/docPack.ts buildAndDownloadDocPack).
//
//   - minted: each sheet's QR is <origin>/verify/<token>, never its document
//     UUID; a sheet the server did not mint keeps today's QR;
//   - REGRESSION / fail-safe (DEC-90 ruling (4)): when the tokens cannot be
//     minted (20261237 not pasted → { available: false }, a 503, a network
//     error, no session) every sheet carries today's QR
//     (/verify/<document>?v=<version>) and the pack prints exactly as before;
//   - settle: after the download the print reports exactly the sheets in the
//     PDF (a fetch-failed sheet's token is voided); a build that fails before
//     the download voids the whole print (empty list); no QR at all (no
//     public origin) mints nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  stamps: [] as Array<{ verifyUrl?: string }>,
  calls: [] as Array<{ url: string; body: Record<string, unknown> | null }>,
  mint: "ok" as "ok" | "unavailable" | "error" | "throw" | "partial",
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
  state.mint = "ok";
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
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url) === "/api/print-sheet-tokens") {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      state.calls.push({ url: String(url), body });
      if (body?.action === "settle") return { ok: true, status: 200, json: async () => ({ settled: true }) };
      if (state.mint === "throw") throw new Error("network down");
      if (state.mint === "unavailable") return { ok: true, status: 200, json: async () => ({ available: false }) };
      if (state.mint === "error") return { ok: false, status: 503, json: async () => ({ error: "Couldn't mint the sheet tokens" }) };
      const tokens = state.mint === "partial" ? { [D1]: T1 } : { [D1]: T1, [D2]: T2 };
      return { ok: true, status: 200, json: async () => ({ available: true, printId: PRINT, tokens }) };
    }
    return state.failUrls.has(String(url)) ? { ok: false, status: 500 } : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
  }));
  vi.stubGlobal("URL", { createObjectURL: () => "blob:pack", revokeObjectURL: () => {} });
  vi.stubGlobal("document", {
    createElement: () => ({ click: () => {}, set href(_: string) {}, set download(_: string) {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
  });
});

const base = { orgId: "org1", packLabel: "pack", documentIds: [D1, D2], userId: "u1" };
const todayQr = (d: string, v: string) => `https://app.example.com/verify/${d}?v=${v}`;
const mints = () => state.calls.filter((c) => c.body?.action === "mint");
const settles = () => state.calls.filter((c) => c.body?.action === "settle");

describe("PS-P9 — a printed pack's sheets are named by their per-print token", () => {
  it("each sheet's QR is <origin>/verify/<token> — no document UUID on the paper; the server minted one per sheet, for the version printed", async () => {
    const r = await buildAndDownloadDocPack({ ...base });
    expect(r.included).toBe(2);
    expect(state.stamps.map((s) => s.verifyUrl)).toEqual([`https://app.example.com/verify/${T1}`, `https://app.example.com/verify/${T2}`]);
    for (const s of state.stamps) expect(s.verifyUrl).not.toContain(D1);
    expect(mints()).toHaveLength(1);
    expect(mints()[0].body).toEqual({ action: "mint", orgId: "org1", sheets: [{ documentId: D1, versionId: V1 }, { documentId: D2, versionId: V2 }] });
    // settled with exactly the sheets in the PDF
    expect(settles().map((c) => c.body)).toEqual([{ action: "settle", orgId: "org1", printId: PRINT, printed: [D1, D2] }]);
  });

  it("a sheet the server did not mint keeps today's QR", async () => {
    state.mint = "partial";
    await buildAndDownloadDocPack({ ...base });
    expect(state.stamps.map((s) => s.verifyUrl)).toEqual([`https://app.example.com/verify/${T1}`, todayQr(D2, V2)]);
  });

  it("a fetch-failed sheet is not reported printed, so its token is voided ('not_printed')", async () => {
    state.failUrls.add("https://files/p102.pdf");
    const r = await buildAndDownloadDocPack({ ...base });
    expect(r.included).toBe(1);
    expect(settles().map((c) => c.body?.printed)).toEqual([[D1]]);
  });

  it("a build that fails before the download voids the whole print (empty list) and still throws as before", async () => {
    await expect(buildAndDownloadDocPack({
      ...base,
      buildCoverAfter: async () => { throw new Error("The pack was NOT printed: its print record could not be written"); },
    })).rejects.toThrow(/NOT printed/);
    expect(settles().map((c) => c.body)).toEqual([{ action: "settle", orgId: "org1", printId: PRINT, printed: [] }]);
  });
});

describe("PS-P9 REGRESSION — when no token can be minted the pack prints exactly as today", () => {
  for (const mode of ["unavailable", "error", "throw"] as const) {
    it(`mint ${mode}: every sheet carries today's /verify/<document>?v=<version> QR; nothing is settled; the print succeeds`, async () => {
      state.mint = mode;
      const r = await buildAndDownloadDocPack({ ...base });
      expect(r.included).toBe(2);
      expect(state.stamps.map((s) => s.verifyUrl)).toEqual([todayQr(D1, V1), todayQr(D2, V2)]);
      expect(settles()).toEqual([]);
    });
  }

  it("no public origin (no QR at all): nothing is minted and no sheet carries a QR, as before", async () => {
    state.origin = "";
    await buildAndDownloadDocPack({ ...base });
    expect(state.calls).toEqual([]);
    expect(state.stamps.map((s) => s.verifyUrl)).toEqual([undefined, undefined]);
  });
});
