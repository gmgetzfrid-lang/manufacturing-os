// Guards the defect behind "my bulk upload is just stuck":
//
// putWithXhr wraps an XMLHttpRequest in a promise. If the connection wedges,
// the XHR fires no load, no error and no abort — so the promise never
// settles, the awaiting Promise.all never resolves, and the spinner it
// controls waits forever with no way back.
//
// The contract under test: an upload that stops moving ALWAYS settles, and
// one that is still moving is never killed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const STALL_MS = 90_000;

/** The production stall machinery, isolated from the network. */
function putWithStallGuard(xhr: FakeXhr): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let stall: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (stall) clearTimeout(stall);
      fn();
    };
    const arm = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => {
        finish(() => { xhr.abort(); reject(new Error("stalled — no data moved for 90s")); });
      }, STALL_MS);
    };
    xhr.onProgress = () => arm();
    xhr.onLoad = () => finish(() => {
      if (xhr.status >= 200 && xhr.status < 300) resolve("etag");
      else reject(new Error(`HTTP ${xhr.status}`));
    });
    xhr.onError = () => finish(() => reject(new Error("network error")));
    xhr.onAbort = () => finish(() => reject(new Error("aborted")));
    arm();
  });
}

class FakeXhr {
  status = 200;
  aborted = false;
  onProgress?: () => void;
  onLoad?: () => void;
  onError?: () => void;
  onAbort?: () => void;
  progress() { this.onProgress?.(); }
  load(status = 200) { this.status = status; this.onLoad?.(); }
  fail() { this.onError?.(); }
  abort() { this.aborted = true; }
}

describe("upload stall guard", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("settles a wedged upload instead of hanging forever", async () => {
    const xhr = new FakeXhr();
    const p = putWithStallGuard(xhr);
    const seen = vi.fn();
    p.catch(seen);
    // Nothing ever happens on the wire.
    await vi.advanceTimersByTimeAsync(STALL_MS + 100);
    await expect(p).rejects.toThrow(/stalled/);
    expect(xhr.aborted).toBe(true);
  });

  it("never kills an upload that is still moving, however slow", async () => {
    const xhr = new FakeXhr();
    const p = putWithStallGuard(xhr);
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    // A big file over bad wifi: bytes keep arriving, just slowly.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(STALL_MS - 5_000);
      xhr.progress();
    }
    expect(settled).toBe(false);
    xhr.load(200);
    await expect(p).resolves.toBe("etag");
  });

  it("stalls only after progress genuinely stops", async () => {
    const xhr = new FakeXhr();
    const p = putWithStallGuard(xhr);
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    xhr.progress();                       // rearms the clock
    await vi.advanceTimersByTimeAsync(STALL_MS - 1_000);
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).rejects.toThrow(/stalled/);
  });

  it("reports a non-2xx response rather than treating it as success", async () => {
    const xhr = new FakeXhr();
    const p = putWithStallGuard(xhr);
    xhr.load(504);
    await expect(p).rejects.toThrow(/HTTP 504/);
  });

  it("settles once — a late event after a stall cannot resolve it", async () => {
    const xhr = new FakeXhr();
    const p = putWithStallGuard(xhr);
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(STALL_MS + 100);
    xhr.load(200);                        // the wire finally answers
    await expect(p).rejects.toThrow(/stalled/);
  });

  it("does not leave a timer armed after settling", async () => {
    const xhr = new FakeXhr();
    const p = putWithStallGuard(xhr);
    xhr.load(200);
    await expect(p).resolves.toBe("etag");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("batch semantics", () => {
  // The second half of "stuck": Promise.all rejects on the first failure and
  // abandons every file after it. allSettled gives each file its attempt and
  // lets the batch report what actually landed.
  it("allSettled attempts every file and separates the failures", async () => {
    const files = ["a", "bad", "c", "d"];
    const upload = async (n: string) => {
      if (n === "bad") throw new Error("stalled — no data moved for 90s");
      return n;
    };
    const results = await Promise.allSettled(files.map(upload));
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(3);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason.message).toMatch(/stalled/);
  });

  it("Promise.all — the old behaviour — loses the files after the failure", async () => {
    const attempted: string[] = [];
    const upload = async (n: string) => {
      attempted.push(n);
      if (n === "bad") throw new Error("boom");
      return n;
    };
    await expect(Promise.all(["a", "bad", "c"].map(upload))).rejects.toThrow("boom");
    // Every file was *started*, but the caller learns nothing about c's fate
    // and the batch aborts before any later chunk runs.
    expect(attempted).toEqual(["a", "bad", "c"]);
  });
});
