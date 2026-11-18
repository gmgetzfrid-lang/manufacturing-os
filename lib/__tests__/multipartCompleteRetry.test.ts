// drafting-flow EVID-17 / document-control PKG-15 follow-up (F7-EVID12 last
// pass): /api/storage/multipart's `complete` now reads the version ledger and
// the request lookup and answers 503 when it cannot — transient. The browser's
// multipart upload retries `complete` ONCE after a short wait on a 503, so a
// read hiccup does not throw away a multi-GB upload; a 409 (refused) aborts at
// once, exactly as any failure did before. Driven end to end through
// lib/storage.ts uploadToPath (fetch and XMLHttpRequest stood in).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } },
}));

import { uploadToPath, completeMultipartWithRetry, UploadCancelledError, COMPLETE_RETRY_DELAY_MS } from "@/lib/storage";

const BIG = 64 * 1024 * 1024 + 1; // two parts, through the multipart door
const calls: string[] = [];
let completeAnswers: Array<[number, unknown]> = [];

class FakeXhr {
  status = 200;
  timeout = 0;
  private on: Record<string, Array<() => void>> = {};
  upload = { addEventListener: () => undefined };
  addEventListener(ev: string, fn: () => void) { (this.on[ev] ??= []).push(fn); }
  open() { /* PUT */ }
  setRequestHeader() { /* type */ }
  getResponseHeader() { return '"etag"'; }
  abort() { (this.on.abort ?? []).forEach((f) => f()); }
  send() { setTimeout(() => (this.on.load ?? []).forEach((f) => f()), 0); }
}

beforeEach(() => {
  calls.length = 0;
  completeAnswers = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { action: string };
    calls.push(body.action);
    if (body.action === "create") return new Response(JSON.stringify({ uploadId: "u" }), { status: 200 });
    if (body.action === "sign") return new Response(JSON.stringify({ url: "https://r2/put" }), { status: 200 });
    if (body.action === "complete") {
      const [status, json] = completeAnswers.shift() ?? [200, { ok: true }];
      return new Response(JSON.stringify(json), { status });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const bigFile = () => ({ size: BIG, type: "application/pdf", slice: () => new Blob(["x"]) }) as unknown as Blob;
const path = "orgs/12345678-1234-1234-1234-123456789abc/libraries/l1/scan__rev0__1.e57";

describe("multipart complete: one retry on a 503, none on a 409", () => {
  it("a 503 then success: complete is retried once after the wait, nothing aborted, the upload succeeds", async () => {
    completeAnswers = [[503, { error: "Couldn't verify the target key; upload refused." }], [200, { ok: true }]];
    const t0 = Date.now();
    const out = await uploadToPath(bigFile(), path, { contentType: "application/pdf" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(COMPLETE_RETRY_DELAY_MS - 50);
    expect(out).toEqual({ path, url: path, size: BIG, contentType: "application/pdf" });
    expect(calls).toEqual(["create", "sign", "sign", "complete", "complete"]);
  });

  it("two 503s: the second failure aborts the upload and the person sees the route's words", async () => {
    completeAnswers = [[503, { error: "Couldn't verify the target key; upload refused." }], [503, { error: "Couldn't verify the target key; upload refused." }]];
    await expect(uploadToPath(bigFile(), path, { contentType: "application/pdf" })).rejects.toThrow("Couldn't verify the target key; upload refused.");
    expect(calls).toEqual(["create", "sign", "sign", "complete", "complete", "abort"]);
  });

  it("a 409 (refused) aborts at once — no wait, no retry, as before", async () => {
    completeAnswers = [[409, { error: "That file already belongs to a published revision and cannot be overwritten. Publish a new revision instead." }]];
    const t0 = Date.now();
    await expect(uploadToPath(bigFile(), path, { contentType: "application/pdf" })).rejects.toThrow(/already belongs to a published revision/);
    expect(Date.now() - t0).toBeLessThan(COMPLETE_RETRY_DELAY_MS);
    expect(calls).toEqual(["create", "sign", "sign", "complete", "abort"]);
  });
});

describe("completeMultipartWithRetry", () => {
  const err = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  it("retries only a 503, once, after the wait", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    let n = 0;
    await expect(completeMultipartWithRetry(async () => { n++; if (n === 1) throw err(503); return "ok"; }, { sleep })).resolves.toBe("ok");
    expect([n, sleeps]).toEqual([2, [COMPLETE_RETRY_DELAY_MS]]);
    n = 0; sleeps.length = 0;
    await expect(completeMultipartWithRetry(async () => { n++; throw err(409); }, { sleep })).rejects.toThrow("HTTP 409");
    expect([n, sleeps]).toEqual([1, []]);
    n = 0;
    await expect(completeMultipartWithRetry(async () => { n++; throw new Error("network error"); }, { sleep })).rejects.toThrow("network error");
    expect(n).toBe(1);
  });
  it("a cancel during the wait is a cancel (no second complete)", async () => {
    const ac = new AbortController();
    let n = 0;
    await expect(completeMultipartWithRetry(async () => { n++; throw err(503); }, { signal: ac.signal, sleep: async () => { ac.abort(); } })).rejects.toBeInstanceOf(UploadCancelledError);
    expect(n).toBe(1);
  });
});
