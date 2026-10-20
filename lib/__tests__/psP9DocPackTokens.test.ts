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
//     the download voids the whole print (empty list, fired and not awaited);
//     no QR at all (no public origin) mints nothing;
//   - timeout: the mint and the settle give up after
//     SHEET_TOKEN_FETCH_TIMEOUT_MS (a hung mint stamps today's QR);
//   - integrator at the PS-P9 merge (DEC-90): the post-download settle never
//     holds back the distribution record (EGR-6) or afterDownload (PKG-6) —
//     it is fired after both are written, never awaited, so a hanging settle
//     leaves the download complete; an empty mint (no eligible sheet) is null:
//     no settle request, no warning.

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
    // settled with exactly the sheets in the PDF (fired after the record — awaited by nobody)
    await vi.waitFor(() => expect(settles().map((c) => c.body)).toEqual([{ action: "settle", orgId: "org1", printId: PRINT, printed: [D1, D2] }]));
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
    await vi.waitFor(() => expect(settles().map((c) => c.body?.printed)).toEqual([[D1]]));
  });

  it("a build that fails before the download voids the whole print (empty list) and still throws as before", async () => {
    await expect(buildAndDownloadDocPack({
      ...base,
      buildCoverAfter: async () => { throw new Error("The pack was NOT printed: its print record could not be written"); },
    })).rejects.toThrow(/NOT printed/);
    await vi.waitFor(() => expect(settles().map((c) => c.body)).toEqual([{ action: "settle", orgId: "org1", printId: PRINT, printed: [] }]));
  });
});

describe("PS-P9 — the print never waits on the token route for long", () => {
  it("the mint and the settle each carry an abort signal (SHEET_TOKEN_FETCH_TIMEOUT_MS)", async () => {
    await buildAndDownloadDocPack({ ...base });
    await vi.waitFor(() => expect(settles()).toHaveLength(1));
    expect(mints()[0].signal).toBeInstanceOf(AbortSignal);
    expect(settles()[0].signal).toBeInstanceOf(AbortSignal);
    expect(SHEET_TOKEN_FETCH_TIMEOUT_MS).toBe(8000);
  });

  it("a mint that never answers is given up after the timeout: null — the pack stamps today's QR", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      state.mint = "hang";
      const p = mintSheetTokens({ orgId: "org1", sheets: [{ documentId: D1, versionId: V1 }] });
      await vi.advanceTimersByTimeAsync(SHEET_TOKEN_FETCH_TIMEOUT_MS - 1);
      expect(mints()[0].signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBeNull();
      expect(mints()[0].signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a settle that never answers is given up after the timeout: false (the print stays unsettled, every token live)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      state.settleHangs = true;
      const p = settleSheetTokens({ orgId: "org1", printId: PRINT, printedDocumentIds: [D1] });
      await vi.advanceTimersByTimeAsync(SHEET_TOKEN_FETCH_TIMEOUT_MS);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed build throws at once — it does not wait on the abort settle (fired, not awaited)", async () => {
    state.settleHangs = true;
    await expect(buildAndDownloadDocPack({
      ...base,
      buildCoverAfter: async () => { throw new Error("The pack was NOT printed: its print record could not be written"); },
    })).rejects.toThrow(/NOT printed/);
    // the void was still sent, and is still pending when the user sees the error
    await vi.waitFor(() => expect(settles().map((c) => c.body?.printed)).toEqual([[]]));
    expect(settles()[0].signal?.aborted).toBe(false);
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

describe("PS-P9 — the post-download settle never holds back the record or the pins (the integrator at the PS-P9 merge, DEC-90)", () => {
  it("a settle that never answers: the download completes, recordPackDownloads (EGR-6) and afterDownload (PKG-6) run first, and the settle is fired after them", async () => {
    state.settleHangs = true;
    const afterDownload = vi.fn(async () => { state.log.push("afterDownload"); });
    // resolves although the settle request never answers (it is not awaited)
    const r = await buildAndDownloadDocPack({ ...base, afterDownload });
    expect(r).toEqual({ included: 2, skipped: [], unrecorded: [] });
    expect(afterDownload).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(settles()).toHaveLength(1));
    expect(state.log).toEqual(["click", "insert:download_audits", "afterDownload", "settle"]);
    // still pending: nothing waited on it
    expect(settles()[0].signal?.aborted).toBe(false);
  });

  it("an afterDownload that throws still lets the settle go (fired in a finally) — the paper has left", async () => {
    await expect(buildAndDownloadDocPack({ ...base, afterDownload: async () => { throw new Error("pins"); } })).rejects.toThrow(/pins/);
    await vi.waitFor(() => expect(settles().map((c) => c.body?.printed)).toEqual([[D1, D2]]));
  });
});

describe("PS-P9 — an empty mint settles nothing and warns about nothing (the integrator at the PS-P9 merge, DEC-90)", () => {
  it("the server minted no sheet (none eligible): mintSheetTokens is null — today's QR on every sheet, no settle request, no warning", async () => {
    state.mint = "empty";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await mintSheetTokens({ orgId: "org1", sheets: [{ documentId: D1, versionId: V1 }] })).toBeNull();
      state.calls = [];
      const r = await buildAndDownloadDocPack({ ...base });
      expect(r.included).toBe(2);
      expect(mints()).toHaveLength(1);
      expect(state.stamps.map((s) => s.verifyUrl)).toEqual([todayQr(D1, V1), todayQr(D2, V2)]);
      await new Promise((res) => setTimeout(res, 10));
      expect(settles()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("no eligible sheet on the client (no current version): no mint request, no settle request, no warning", async () => {
    tables.documents = tables.documents.map((d) => ({ ...d, current_version_id: null }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await mintSheetTokens({ orgId: "org1", sheets: [] })).toBeNull();
      await expect(buildAndDownloadDocPack({ ...base })).rejects.toThrow(/No documents could be packed/);
      expect(state.calls).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
