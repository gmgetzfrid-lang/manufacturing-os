// public-surfaces PS-P10 SHEET TOKEN PRINT LINK — the pack print path links
// its sheet tokens to the cover's print BEFORE the download (lib/docPack.ts
// buildAndDownloadDocPack; PHYS-19 done-when 3, rulings under DEC-90).
//
//   - a work-package pack: the cover AWAITS `cover.linkPrint(printId)` after
//     recording its snapshot; the link request (`action: "link"`) goes out
//     before the download click, and the post-download settle is PS-P9's
//     exactly (review fix: the link first rode on that settle, which is
//     fired and never awaited — a dropped settle left the print unlinked);
//   - a link the server REFUSES (400) STOPS the print: no click, no
//     distribution record, the whole print voided (print_aborted), a
//     SheetTokenCoverLinkError; a refusal is never retried;
//   - REGRESSION FIRST (third review fix): a link that only FAILS — no
//     answer or a 5xx twice (one retry), or a 401 / 404 / 409 — FAILS OPEN:
//     the pack downloads unlinked, exactly as before PS-P10, with one
//     console warning; before 20261240 ({ available: false }) the pack prints
//     as today;
//   - REGRESSION: a pack whose cover does not link (or has no cover — the
//     asset hub's pack) sends no link and PS-P9's settle; no token minted →
//     no link and no settle, every sheet carries today's QR.
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
  /** how the link route answers, in order (the last one repeats) */
  link: ["ok"] as Array<"ok" | "unavailable" | "refused" | "error" | "throw" | "signedout" | "unknown" | "conflict">,
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
import { buildAndDownloadDocPack, SheetTokenCoverLinkError } from "@/lib/docPack";
import { linkSheetTokensToCover, settleSheetTokens } from "@/lib/printSheetTokensClient";

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
  state.link = ["ok"];
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
      if (body?.action === "link") {
        state.log.push("link");
        const mode = state.link.length > 1 ? state.link.shift()! : state.link[0];
        if (mode === "throw") throw new Error("network down");
        if (mode === "unavailable") return { ok: true, status: 200, json: async () => ({ available: false, linked: false }) };
        if (mode === "refused") return { ok: false, status: 400, json: async () => ({ error: "That cover does not list the sheets of this print" }) };
        if (mode === "error") return { ok: false, status: 503, json: async () => ({ error: "Couldn't link the sheets to the cover — try again" }) };
        if (mode === "signedout") return { ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) };
        if (mode === "unknown") return { ok: false, status: 404, json: async () => ({ error: "Unknown or already settled print" }) };
        if (mode === "conflict") return { ok: false, status: 409, json: async () => ({ error: "The print changed while it was linked — try again" }) };
        return { ok: true, status: 200, json: async () => ({ linked: true, sheets: 2 }) };
      }
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
const links = () => state.calls.filter((c) => c.body?.action === "link");
const linkingCover = async (_i: unknown, _s: unknown, cover: { linkPrint: (id: string) => Promise<void> }) => { await cover.linkPrint(COVER); return null; };

describe("PS-P10 — a work-package pack's sheet tokens are linked to its cover's print before the download", () => {
  it("the cover links its print: the link names the print, the cover and the sheets in the PDF, and is answered BEFORE the click; the settle is PS-P9's", async () => {
    let seen: { included: number; skipped: number } | null = null;
    const r = await buildAndDownloadDocPack({
      ...base,
      buildCoverAfter: async (included, skipped, cover) => {
        seen = { included: included.length, skipped: skipped.length };
        await cover.linkPrint(COVER);
        return null;
      },
    });
    expect(r.included).toBe(2);
    expect(seen).toEqual({ included: 2, skipped: 0 });
    expect(links().map((c) => c.body)).toEqual([{ action: "link", orgId: "org1", printId: PRINT, coverPrintId: COVER, printed: [D1, D2] }]);
    expect(state.log.indexOf("link")).toBeLessThan(state.log.indexOf("click"));
    await vi.waitFor(() => expect(settles().map((c) => c.body)).toEqual([{ action: "settle", orgId: "org1", printId: PRINT, printed: [D1, D2] }]));
    expect(Object.keys(settles()[0].body ?? {})).not.toContain("coverPrintId");
  });

  it("a sheet left out of the PDF is not in the link's `printed` (the cover lists it as left out)", async () => {
    state.failUrls.add("https://files/p102.pdf");
    const r = await buildAndDownloadDocPack({ ...base, buildCoverAfter: linkingCover });
    expect(r.included).toBe(1);
    expect(links().map((c) => c.body?.printed)).toEqual([[D1]]);
  });

  it("a REFUSED link (400 — the cover is not this print's; never retried) STOPS the print: no click, no distribution record, the whole print voided, a SheetTokenCoverLinkError", async () => {
    state.link = ["refused"];
    const err = await buildAndDownloadDocPack({ ...base, buildCoverAfter: linkingCover }).catch((e) => e);
    expect(err).toBeInstanceOf(SheetTokenCoverLinkError);
    expect((err as Error).message).toMatch(/nothing was downloaded and no pin moved/);
    expect(links()).toHaveLength(1);
    expect(state.log).not.toContain("click");
    expect(state.log).not.toContain("insert:download_audits");
    await vi.waitFor(() => expect(settles().map((c) => c.body)).toEqual([{ action: "settle", orgId: "org1", printId: PRINT, printed: [] }]));
  });

  for (const [what, modes, sent] of [
    ["two 503s (one retry)", ["error", "error"], 2],
    ["a link that cannot be sent twice (no answer)", ["throw", "throw"], 2],
    ["a 401 (session lapsed; not retried)", ["signedout"], 1],
    ["a 404 (not retried)", ["unknown"], 1],
    ["a 409 (not retried)", ["conflict"], 1],
    ["a 503 then a 409", ["error", "conflict"], 2],
  ] as Array<[string, Array<"error" | "throw" | "signedout" | "unknown" | "conflict">, number]>) {
    it(`REGRESSION FIRST: ${what} FAILS OPEN — the pack downloads unlinked as before PS-P10, with one warning, and PS-P9's settle`, async () => {
      state.link = [...modes];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const r = await buildAndDownloadDocPack({ ...base, buildCoverAfter: linkingCover });
        expect(r.included).toBe(2);
        expect(links()).toHaveLength(sent);
        expect(state.log).toContain("click");
        expect(state.log).toContain("insert:download_audits");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toMatch(/printing unlinked/);
        await vi.waitFor(() => expect(settles().map((c) => c.body)).toEqual([{ action: "settle", orgId: "org1", printId: PRINT, printed: [D1, D2] }]));
      } finally {
        warn.mockRestore();
      }
    });
  }

  it("one transient failure is retried once and the print goes on", async () => {
    state.link = ["error", "ok"];
    const r = await buildAndDownloadDocPack({ ...base, buildCoverAfter: linkingCover });
    expect(r.included).toBe(2);
    expect(links()).toHaveLength(2);
    expect(state.log).toContain("click");
  });

  it("BEFORE 20261240 ({ available: false }) the pack prints exactly as today, unlinked", async () => {
    state.link = ["unavailable"];
    const r = await buildAndDownloadDocPack({ ...base, buildCoverAfter: linkingCover });
    expect(r.included).toBe(2);
    expect(links()).toHaveLength(1);
    expect(state.log).toContain("click");
    await vi.waitFor(() => expect(settles()).toHaveLength(1));
  });

  it("a build that fails AFTER the cover linked its print voids the whole print (the abort settle)", async () => {
    vi.stubGlobal("document", {
      createElement: () => { throw new Error("no DOM"); },
      body: { appendChild: () => {}, removeChild: () => {} },
    });
    await expect(buildAndDownloadDocPack({ ...base, buildCoverAfter: linkingCover })).rejects.toThrow(/no DOM/);
    expect(links()).toHaveLength(1);
    await vi.waitFor(() => expect(settles().map((c) => c.body)).toEqual([{ action: "settle", orgId: "org1", printId: PRINT, printed: [] }]));
  });

  it("REGRESSION: a cover that does not link, and a pack with no cover, send no link and PS-P9's settle exactly", async () => {
    await buildAndDownloadDocPack({ ...base, buildCoverAfter: async () => null });
    await buildAndDownloadDocPack({ ...base });
    await vi.waitFor(() => expect(settles()).toHaveLength(2));
    expect(links()).toEqual([]);
    for (const s of settles()) expect(s.body).toEqual({ action: "settle", orgId: "org1", printId: PRINT, printed: [D1, D2] });
  });

  it("REGRESSION: no token minted (20261237 not pasted) → linkPrint resolves without a request, no settle; every sheet carries today's QR", async () => {
    state.mint = "unavailable";
    const r = await buildAndDownloadDocPack({ ...base, buildCoverAfter: linkingCover });
    expect(r.included).toBe(2);
    expect(state.stamps.map((s) => s.verifyUrl)).toEqual([todayQr(D1, V1), todayQr(D2, V2)]);
    await new Promise((res) => setTimeout(res, 10));
    expect(links()).toEqual([]);
    expect(settles()).toEqual([]);
  });

  it("linkSheetTokensToCover says what came back and never throws; settleSheetTokens never sends a cover id", async () => {
    const input = { orgId: "org1", printId: PRINT, coverPrintId: COVER, printedDocumentIds: [D1] };
    state.link = ["ok"];
    expect(await linkSheetTokensToCover(input)).toEqual({ ok: true, linked: true });
    state.link = ["unavailable"];
    expect(await linkSheetTokensToCover(input)).toEqual({ ok: true, linked: false });
    state.link = ["refused"];
    expect(await linkSheetTokensToCover(input)).toEqual({ ok: false, status: 400, error: "That cover does not list the sheets of this print" });
    state.link = ["throw"];
    expect(await linkSheetTokensToCover(input)).toMatchObject({ ok: false, status: 0 });
    await settleSheetTokens({ orgId: "org1", printId: PRINT, printedDocumentIds: [D1] });
    expect(settles().map((c) => c.body)).toEqual([{ action: "settle", orgId: "org1", printId: PRINT, printed: [D1] }]);
  });
});
