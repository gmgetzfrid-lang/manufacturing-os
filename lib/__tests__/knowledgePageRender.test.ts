// intelligence Round G (I-09) — lib/knowledgePageRender.ts.
//
// PERF-6 (the renderer limb): pages render in parallel under a cap shared by
// every read in the process, so two reads at once hold at most RENDER_SLOTS
// page canvases between them; a deadline stops new pages from starting; the
// parsed document is destroyed when the read ends. FLOW-13: the width is a
// parameter (a drawing reader passes the ingester's 1800 px; the default
// stays 1400 for the other callers). FLOW-11: a partial set is reported —
// out of range, failed, not started — never absorbed.

import { describe, it, expect, vi, beforeEach } from "vitest";

const pdf = vi.hoisted(() => ({
  numPages: 10,
  inFlight: 0,
  maxInFlight: 0,
  delayMs: 5,
  fail: new Set<number>(),
  widths: [] as number[],
  started: [] as number[],
  destroyed: 0,
  openFails: false,
}));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({ Body: new Uint8Array([37, 80, 68, 70]) })) }, R2_BUCKET: "b" }));
vi.mock("@aws-sdk/client-s3", () => ({ GetObjectCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@/lib/knowledgeText", () => ({ ensurePdfPolyfills: () => undefined }));
vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn(async () => {
    if (pdf.openFails) throw new Error("not a pdf");
    return { numPages: pdf.numPages, destroy: async () => { pdf.destroyed += 1; } };
  }),
  renderPageAsImage: vi.fn(async (_doc: unknown, page: number, opts: { width: number }) => {
    pdf.started.push(page);
    pdf.widths.push(opts.width);
    pdf.inFlight += 1;
    pdf.maxInFlight = Math.max(pdf.maxInFlight, pdf.inFlight);
    await new Promise((r) => setTimeout(r, pdf.delayMs));
    pdf.inFlight -= 1;
    if (pdf.fail.has(page)) throw new Error("render failed");
    return new Uint8Array([page]).buffer;
  }),
}));

import {
  renderKnowledgePagesReport, renderKnowledgePages, RENDER_SLOTS, DRAWING_RENDER_WIDTH, rendersInFlight,
  onceUnlessRejected,
} from "@/lib/knowledgePageRender";

beforeEach(() => {
  Object.assign(pdf, { numPages: 10, inFlight: 0, maxInFlight: 0, delayMs: 5, fail: new Set<number>(), widths: [], started: [], destroyed: 0, openFails: false });
});

describe("PERF-6 — parallel under a process-wide cap; the document is released", () => {
  it("one read renders in parallel, never more than RENDER_SLOTS at once, and returns pages in the order asked", async () => {
    const r = await renderKnowledgePagesReport("k", [6, 1, 2, 3, 4, 5], { maxPages: 6 });
    expect(r.images.map((i) => i.page)).toEqual([6, 1, 2, 3, 4, 5]);
    expect(pdf.maxInFlight).toBe(RENDER_SLOTS);
    expect(RENDER_SLOTS).toBe(2);
    expect(pdf.destroyed).toBe(1);
    expect(rendersInFlight()).toBe(0);
  });

  it("two concurrent ten-page reads share the cap: at most RENDER_SLOTS page canvases between them", async () => {
    const [a, b] = await Promise.all([
      renderKnowledgePagesReport("a", Array.from({ length: 10 }, (_, i) => i + 1), { maxPages: 10 }),
      renderKnowledgePagesReport("b", Array.from({ length: 10 }, (_, i) => i + 1), { maxPages: 10 }),
    ]);
    expect(a.images).toHaveLength(10);
    expect(b.images).toHaveLength(10);
    expect(pdf.maxInFlight).toBeLessThanOrEqual(RENDER_SLOTS);
    expect(pdf.destroyed).toBe(2);
    expect(rendersInFlight()).toBe(0);
  });

  it("a deadline stops new pages from starting; what was not started is reported", async () => {
    pdf.delayMs = 30;
    const r = await renderKnowledgePagesReport("k", [1, 2, 3, 4, 5, 6], { maxPages: 6, deadlineAt: Date.now() + 40 });
    expect(r.images.length).toBeGreaterThan(0);
    expect(r.images.length).toBeLessThan(6);
    expect(r.notStarted.length).toBe(6 - r.images.length);
    expect(pdf.started).not.toEqual(expect.arrayContaining(r.notStarted));
  });
});

describe("FLOW-13 / FLOW-11 — the width is the caller's; a partial set is reported", () => {
  it("a drawing reader renders at 1800 px; the default stays 1400 for the deep-read callers", async () => {
    await renderKnowledgePagesReport("k", [1], { width: DRAWING_RENDER_WIDTH });
    expect(pdf.widths).toEqual([1800]);
    pdf.widths = [];
    await renderKnowledgePages("k", [1], 6);
    expect(pdf.widths).toEqual([1400]);
  });

  it("out of range, failed and rendered pages are each named; the report carries the page count and width", async () => {
    pdf.fail = new Set([3]);
    const r = await renderKnowledgePagesReport("k", [2, 3, 12, 4], { maxPages: 6, width: 1800 });
    expect(r.images.map((i) => i.page)).toEqual([2, 4]);
    expect(r.failed).toEqual([3]);
    expect(r.outOfRange).toEqual([12]);
    expect(r).toMatchObject({ numPages: 10, width: 1800, openFailed: false });
  });

  it("a file that cannot be opened is openFailed, never a throw; the old wrapper returns [] as before", async () => {
    pdf.openFails = true;
    const r = await renderKnowledgePagesReport("k", [1, 2]);
    expect(r).toMatchObject({ images: [], openFailed: true, numPages: null });
    await expect(renderKnowledgePages("k", [1])).resolves.toEqual([]);
  });

  it("the page cap still binds (maxPages), and duplicates are read once", async () => {
    const r = await renderKnowledgePagesReport("k", [1, 1, 2, 3, 4, 5, 6, 7, 8], { maxPages: 6 });
    expect(r.images.map((i) => i.page)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("the engine is loaded once per process — and a failed load is not cached", () => {
  it("a successful load is shared: the loader runs once for every caller", async () => {
    let runs = 0;
    const load = onceUnlessRejected(async () => { runs += 1; return { engine: runs }; });
    const [a, b] = await Promise.all([load(), load()]);
    expect(await load()).toBe(a);
    expect(b).toBe(a);
    expect(runs).toBe(1);
  });

  it("one rejected load (a cold-start hiccup) is forgotten: the next call loads again and succeeds, and that result is then shared", async () => {
    let runs = 0;
    const load = onceUnlessRejected(async () => {
      runs += 1;
      if (runs === 1) throw new Error("transient WASM init failure");
      return { engine: runs };
    });
    await expect(load()).rejects.toThrow("transient WASM init failure");
    const ok = await load();
    expect(ok).toEqual({ engine: 2 });
    expect(await load()).toBe(ok);
    expect(runs).toBe(2);
  });

  it("the renderer's PDF engine is loaded through it (no bare ??= import cache that would keep a rejection)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/lib/knowledgePageRender.ts`, "utf8");
    expect(src).toContain('const loadUnpdf = onceUnlessRejected(() => import("unpdf"));');
    expect(src).not.toMatch(/\?\?= import\("unpdf"\)/);
  });

  it("a synchronous throw from the loader is a rejection, forgotten the same way", async () => {
    let runs = 0;
    const load = onceUnlessRejected<number>(() => { runs += 1; if (runs === 1) throw new Error("sync"); return Promise.resolve(7); });
    await expect(load()).rejects.toThrow("sync");
    await expect(load()).resolves.toBe(7);
  });
});
