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
  hang: new Set<number>(),
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
    // a render that never returns (a pathological page, a wedged canvas)
    if (pdf.hang.has(page)) return new Promise<ArrayBuffer>(() => undefined);
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
  onceUnlessRejected, rendersWaiting, DEFAULT_RENDER_BUDGET_MS, PAGE_RENDER_TIMEOUT_MS,
} from "@/lib/knowledgePageRender";

beforeEach(() => {
  Object.assign(pdf, { numPages: 10, inFlight: 0, maxInFlight: 0, delayMs: 5, fail: new Set<number>(), widths: [], started: [], destroyed: 0, openFails: false, hang: new Set<number>() });
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

describe("PERF-6 — the shared slots are always given back (a hung render, a wait past the deadline, a caller with no deadline)", () => {
  it("regression pin: a normal render through renderKnowledgePages (the ask route's deep read, quality-manual, checklist, cost-docs) is unchanged — every page, in the order asked, at 1400 px, no slot held after", async () => {
    const images = await renderKnowledgePages("k", [3, 1, 2], 6);
    expect(images.map((i) => i.page)).toEqual([3, 1, 2]);
    expect(images.every((i) => i.mediaType === "image/png")).toBe(true);
    expect(pdf.widths).toEqual([1400, 1400, 1400]);
    expect(pdf.destroyed).toBe(1);
    expect(rendersInFlight()).toBe(0);
  });

  it("regression pin: a caller with no deadline still waits for a busy slot and renders every page, as before", async () => {
    pdf.delayMs = 30;
    const [a, b] = await Promise.all([
      renderKnowledgePagesReport("a", [1, 2, 3, 4], { maxPages: 6 }),
      renderKnowledgePages("b", [5, 6], 6),
    ]);
    expect(a.images.map((i) => i.page)).toEqual([1, 2, 3, 4]);
    expect(b.map((i) => i.page)).toEqual([5, 6]);
    expect(pdf.maxInFlight).toBeLessThanOrEqual(RENDER_SLOTS);
    expect(rendersInFlight()).toBe(0);
    expect(rendersWaiting()).toBe(0);
  });

  it("a deadline beyond setTimeout's range waits, never gives up at once", async () => {
    pdf.delayMs = 30;
    const [a, b] = await Promise.all([
      renderKnowledgePagesReport("a", [1, 2], { maxPages: 6 }),
      renderKnowledgePagesReport("b", [3, 4], { maxPages: 6, deadlineAt: Number.MAX_SAFE_INTEGER }),
    ]);
    expect(a.images.map((i) => i.page)).toEqual([1, 2]);
    expect(b.images.map((i) => i.page)).toEqual([3, 4]);
    expect(b.notStarted).toEqual([]);
  });

  it("the defaults are generous: a page has 45 s, a read with no deadline 60 s", () => {
    expect(PAGE_RENDER_TIMEOUT_MS).toBe(45_000);
    expect(DEFAULT_RENDER_BUDGET_MS).toBe(60_000);
  });

  it("a hung render releases its slot: that page is failed, the others render, and the next read gets a slot", async () => {
    pdf.hang = new Set([2]);
    const r = await renderKnowledgePagesReport("k", [1, 2, 3], { maxPages: 6, pageTimeoutMs: 40 });
    expect(r.images.map((i) => i.page)).toEqual([1, 3]);
    expect(r.failed).toEqual([2]);
    expect(rendersInFlight()).toBe(0);
    pdf.hang = new Set();
    const next = await renderKnowledgePagesReport("k2", [4, 5], { maxPages: 6 });
    expect(next.images.map((i) => i.page)).toEqual([4, 5]);
    expect(rendersInFlight()).toBe(0);
  }, 3000);

  it("a read waiting for a slot stops waiting at its deadline: its pages are not started, its waiter is removed, and no slot leaks", async () => {
    pdf.hang = new Set([1, 2]);
    let aDone = false;
    const a = renderKnowledgePagesReport("a", [1, 2], { maxPages: 6, pageTimeoutMs: 1500 }).then((r) => { aDone = true; return r; });
    for (let i = 0; i < 200 && rendersInFlight() < RENDER_SLOTS; i++) await new Promise((res) => setTimeout(res, 2));
    expect(rendersInFlight()).toBe(RENDER_SLOTS);
    const t0 = Date.now();
    const b = await renderKnowledgePagesReport("b", [7, 8], { maxPages: 6, deadlineAt: t0 + 40 });
    // B gave up at ITS deadline — not when A's hung renders were abandoned
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(aDone).toBe(false);
    // A still holds both slots: B returned without ever being handed one
    expect(rendersInFlight()).toBe(RENDER_SLOTS);
    expect(b.images).toEqual([]);
    expect(b.notStarted).toEqual([7, 8]);
    expect(rendersWaiting()).toBe(0);
    const ra = await a;
    expect(ra.failed).toEqual([1, 2]);
    // every slot came back — none was handed to B's abandoned wait
    expect(rendersInFlight()).toBe(0);
    expect(rendersWaiting()).toBe(0);
    expect(pdf.started).not.toContain(7);
  }, 5000);

  it("renderKnowledgePages gives a caller that names no deadline the default budget: past it, nothing starts", async () => {
    const real = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValueOnce(real - DEFAULT_RENDER_BUDGET_MS - 1000);
    try {
      await expect(renderKnowledgePages("k", [1, 2], 6)).resolves.toEqual([]);
    } finally { spy.mockRestore(); }
    expect(pdf.started).toEqual([]);
    expect(rendersInFlight()).toBe(0);
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
