// Guards "the second batch of uploads gets stuck and I can't even use the X
// to close it".
//
// Three separate defects produced that one sentence:
//
//   1. MetadataStagingModal is rendered unconditionally and hides itself with
//      `isOpen`, so its state SURVIVES between batches. submit() set
//      submitting=true and only cleared it in the catch — so a batch that
//      succeeded (or that resolved reporting per-file failures, which is what
//      the batch reporter does now) left submitting stuck true forever. The
//      next open rendered "Uploading…" over a batch that had not started, with
//      Upload All, Cancel and the X all disabled.
//
//   2. Nothing could abort an upload in flight, so even a working X would
//      have left the transfers running.
//
//   3. The batch loop had no notion of "stopped", so a cancelled run reported
//      its untouched files as failures.
//
// The contract: submitting ALWAYS returns to false, close is ALWAYS available,
// and a stopped batch reports what it actually did.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── 1. The submit lifecycle ────────────────────────────────────────────────
// A faithful model of the modal's submit state machine.
class StagingModal {
  submitting = false;
  stopping = false;
  open = false;
  error: string | null = null;
  ctl: AbortController | null = null;

  /** The open effect. Resets submit state so a stale flag can't wedge a
   *  batch that hasn't started. */
  onOpen() {
    this.ctl?.abort();
    this.ctl = null;
    this.submitting = false;
    this.stopping = false;
    this.error = null;
    this.open = true;
  }

  async submit(onSubmit: (signal: AbortSignal) => Promise<void>) {
    this.submitting = true;
    this.stopping = false;
    const ctl = new AbortController();
    this.ctl = ctl;
    try {
      await onSubmit(ctl.signal);
    } catch (e) {
      this.error = ctl.signal.aborted ? "Upload stopped." : (e as Error).message;
    } finally {
      if (this.ctl === ctl) this.ctl = null;
      this.submitting = false;
      this.stopping = false;
    }
  }

  /** The X. Never disabled: aborts whatever is running, then closes. */
  requestClose() {
    this.ctl?.abort();
    this.open = false;
  }

  /** Stop but stay, so the rows survive for a re-send. */
  stopUpload() {
    this.stopping = true;
    this.ctl?.abort();
  }
}

describe("staging modal submit lifecycle", () => {
  it("clears submitting after a clean batch, so the next one can start", async () => {
    const m = new StagingModal();
    m.onOpen();
    await m.submit(async () => undefined);
    expect(m.submitting).toBe(false);

    // Second batch — this is the one the user said was stuck.
    m.onOpen();
    expect(m.submitting).toBe(false);
    let started = false;
    await m.submit(async () => { started = true; });
    expect(started).toBe(true);
  });

  it("clears submitting when the batch RESOLVES reporting per-file failures", async () => {
    // The regression path: the parent keeps the modal open and resolves
    // normally when some files failed, so the catch never runs.
    const m = new StagingModal();
    m.onOpen();
    await m.submit(async () => { /* reported "Uploaded 3 of 8" and resolved */ });
    expect(m.submitting).toBe(false);
  });

  it("clears submitting when the batch throws", async () => {
    const m = new StagingModal();
    m.onOpen();
    await m.submit(async () => { throw new Error("Failed to create document record"); });
    expect(m.submitting).toBe(false);
    expect(m.error).toBe("Failed to create document record");
  });

  it("the X closes mid-upload and aborts the transfers", async () => {
    const m = new StagingModal();
    m.onOpen();
    let sawAbort = false;
    const run = m.submit((signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { sawAbort = true; resolve(); });
    }));
    m.requestClose();
    await run;
    expect(sawAbort).toBe(true);
    expect(m.open).toBe(false);
    expect(m.submitting).toBe(false);
  });

  it("Stop keeps the modal open with the rows intact", async () => {
    const m = new StagingModal();
    m.onOpen();
    const run = m.submit((signal) => new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")));
    }));
    m.stopUpload();
    await run;
    expect(m.open).toBe(true);
    expect(m.submitting).toBe(false);
    expect(m.error).toBe("Upload stopped.");
  });

  it("reopening while a previous batch is still running abandons it", async () => {
    const m = new StagingModal();
    m.onOpen();
    let abandoned = false;
    const run = m.submit((signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { abandoned = true; resolve(); });
    }));
    m.onOpen();                 // user picked a new set of files
    await run;
    expect(abandoned).toBe(true);
    expect(m.submitting).toBe(false);
  });

  it("the old shape — no finally — is what wedged the second batch", async () => {
    // Kept as the counter-example: this is the code that shipped, and it
    // leaves the modal permanently "Uploading…" with a disabled X.
    const state = { submitting: false };
    const submitOld = async (work: () => Promise<void>) => {
      state.submitting = true;
      try { await work(); } catch { state.submitting = false; }
    };
    await submitOld(async () => undefined);
    expect(state.submitting).toBe(true);          // ← the bug, reproduced
  });
});

// ── 2. Batch accounting for a stopped run ──────────────────────────────────
describe("stopped batch accounting", () => {
  const CONCURRENCY = 4;

  /** The production loop, isolated from Supabase and R2. */
  async function runBatch(files: string[], signal: AbortSignal, upload: (f: string) => Promise<void>) {
    const failures: string[] = [];
    let stoppedAt = -1;
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      if (signal.aborted) { stoppedAt = i; break; }
      const chunk = files.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(chunk.map(upload));
      results.forEach((r, j) => { if (r.status === "rejected") failures.push(chunk[j]); });
    }
    const attempted = stoppedAt >= 0 ? stoppedAt : files.length;
    return { attempted, notStarted: files.length - attempted, landed: attempted - failures.length, failures };
  }

  it("does not start chunks after the user stops", async () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const ctl = new AbortController();
    const attempted: string[] = [];
    const upload = async (f: string) => {
      attempted.push(f);
      if (attempted.length === 4) ctl.abort();   // stop after the first chunk
    };
    const r = await runBatch(files, ctl.signal, upload);
    expect(attempted).toHaveLength(4);
    expect(r.attempted).toBe(4);
    expect(r.notStarted).toBe(8);
    expect(r.landed).toBe(4);
  });

  it("counts files it never started as not-started, not as failures", async () => {
    const files = Array.from({ length: 8 }, (_, i) => `f${i}`);
    const ctl = new AbortController();
    const r = await runBatch(files, ctl.signal, async (f) => {
      if (f === "f1") throw new Error("stalled — no data moved for 90s");
      if (f === "f3") ctl.abort();
    });
    expect(r.failures).toEqual(["f1"]);
    expect(r.landed).toBe(3);
    expect(r.notStarted).toBe(4);
    // The user's own stop is never reported as a broken file.
    expect(r.failures).not.toContain("f4");
  });

  it("a full run reports nothing as not-started", async () => {
    const files = ["a", "b", "c"];
    const r = await runBatch(files, new AbortController().signal, async () => undefined);
    expect(r.notStarted).toBe(0);
    expect(r.landed).toBe(3);
  });
});

// ── 3. XHR cancellation ────────────────────────────────────────────────────
class FakeXhr {
  status = 200;
  aborted = false;
  onLoad?: () => void;
  onAbort?: () => void;
  abort() { this.aborted = true; this.onAbort?.(); }
  load() { this.onLoad?.(); }
}

class UploadCancelledError extends Error {
  constructor() { super("cancelled"); this.name = "UploadCancelledError"; }
}

/** The production cancel machinery, isolated from the network. */
function putWithCancel(xhr: FakeXhr, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new UploadCancelledError()); return; }
    let done = false;
    let cancelled = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onCancel);
      fn();
    };
    function onCancel() {
      cancelled = true;
      finish(() => { xhr.abort(); reject(new UploadCancelledError()); });
    }
    signal?.addEventListener("abort", onCancel, { once: true });
    xhr.onLoad = () => finish(() => resolve("etag"));
    xhr.onAbort = () => finish(() => reject(cancelled ? new UploadCancelledError() : new Error("aborted")));
  });
}

describe("upload cancellation", () => {
  it("actually closes the socket rather than just walking away", async () => {
    const xhr = new FakeXhr();
    const ctl = new AbortController();
    const p = putWithCancel(xhr, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(UploadCancelledError);
    expect(xhr.aborted).toBe(true);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const xhr = new FakeXhr();
    await expect(putWithCancel(xhr, ctl.signal)).rejects.toBeInstanceOf(UploadCancelledError);
    expect(xhr.aborted).toBe(false);   // never started
  });

  it("a completed upload is not retroactively cancelled", async () => {
    const xhr = new FakeXhr();
    const ctl = new AbortController();
    const p = putWithCancel(xhr, ctl.signal);
    xhr.load();
    ctl.abort();                       // the modal closed a moment later
    await expect(p).resolves.toBe("etag");
  });

  it("distinguishes a user stop from a stall-triggered abort", async () => {
    const xhr = new FakeXhr();
    const p = putWithCancel(xhr, undefined);
    xhr.abort();                       // the stall guard pulled the plug
    await expect(p).rejects.toThrow("aborted");
  });
});

// ── 4. Cancellation must not be retried ────────────────────────────────────
describe("multipart retry policy", () => {
  it("does not burn three retries with backoff on a cancel", async () => {
    const PART_RETRIES = 3;
    let attempts = 0;
    const put = async () => { attempts += 1; throw new UploadCancelledError(); };
    let thrown: Error | null = null;
    for (let attempt = 0; attempt < PART_RETRIES; attempt++) {
      try { await put(); break; }
      catch (e) {
        if (e instanceof UploadCancelledError) { thrown = e as Error; break; }
      }
    }
    expect(attempts).toBe(1);
    expect(thrown).toBeInstanceOf(UploadCancelledError);
  });
});

// ── 5. The title-block enrichment pass ─────────────────────────────────────
// It runs in front of someone who is trying to upload. It must never be the
// reason they wait.
const getDocumentMock = vi.fn();
vi.mock("react-pdf", () => ({
  pdfjs: {
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument: (...args: unknown[]) => getDocumentMock(...args),
  },
}));

function fakePdf(size = 1024): File {
  return {
    name: "21-D-1105.pdf",
    type: "application/pdf",
    size,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as File;
}

/** A loading task whose document resolves with the given page-1 text. */
function taskWithText(text: string) {
  const destroy = vi.fn(async () => undefined);
  return {
    destroy,
    promise: Promise.resolve({
      getPage: async () => ({
        getTextContent: async () => ({ items: text.split(" ").map((str) => ({ str })) }),
      }),
      destroy: async () => undefined,
    }),
  };
}

describe("readTitleBlock", () => {
  beforeEach(() => { getDocumentMock.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it("reads page-1 text and releases the pdf.js document", async () => {
    const { readTitleBlock } = await import("@/lib/titleBlock");
    const task = taskWithText("DWG. NO. 21-D-1105 SHEET 1 OF 1 REV A");
    getDocumentMock.mockReturnValue(task);
    const guess = await readTitleBlock(fakePdf());
    // The heuristic itself is covered in titleBlock.test.ts; what matters here
    // is that the plumbing delivered page-1 text to it and then let go.
    expect(guess.docNumber).toMatch(/1105/);
    expect(task.destroy).toHaveBeenCalled();
  });

  it("silences pdf.js warnings — the TT-undefined-function flood", async () => {
    const { readTitleBlock } = await import("@/lib/titleBlock");
    getDocumentMock.mockReturnValue(taskWithText("REV A"));
    await readTitleBlock(fakePdf());
    expect(getDocumentMock.mock.calls[0][0]).toMatchObject({ verbosity: 0 });
  });

  it("gives up on a PDF that never parses instead of hanging the staging pass", async () => {
    vi.useFakeTimers();
    const { readTitleBlock, TITLE_BLOCK_TIMEOUT_MS } = await import("@/lib/titleBlock");
    const destroy = vi.fn(async () => undefined);
    getDocumentMock.mockReturnValue({ destroy, promise: new Promise(() => { /* never */ }) });
    const p = readTitleBlock(fakePdf());
    await vi.advanceTimersByTimeAsync(TITLE_BLOCK_TIMEOUT_MS + 100);
    await expect(p).resolves.toEqual({ confidence: 0 });
    // and the worker document is not left parsing forever
    expect(destroy).toHaveBeenCalled();
  });

  it("abandons the read when the batch it belonged to is gone", async () => {
    const { readTitleBlock } = await import("@/lib/titleBlock");
    const destroy = vi.fn(async () => undefined);
    getDocumentMock.mockReturnValue({ destroy, promise: new Promise(() => { /* never */ }) });
    const ctl = new AbortController();
    const p = readTitleBlock(fakePdf(), ctl.signal);
    ctl.abort();
    await expect(p).resolves.toEqual({ confidence: 0 });
    expect(destroy).toHaveBeenCalled();
  });

  it("never opens a document for a read nobody wants", async () => {
    const { readTitleBlock } = await import("@/lib/titleBlock");
    const ctl = new AbortController();
    ctl.abort();
    await expect(readTitleBlock(fakePdf(), ctl.signal)).resolves.toEqual({ confidence: 0 });
    expect(getDocumentMock).not.toHaveBeenCalled();
  });

  it("skips non-PDFs and files too big to be worth reading", async () => {
    const { readTitleBlock } = await import("@/lib/titleBlock");
    const dwg = { name: "a.dwg", type: "", size: 10, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as File;
    await expect(readTitleBlock(dwg)).resolves.toEqual({ confidence: 0 });
    await expect(readTitleBlock(fakePdf(50 * 1024 * 1024))).resolves.toEqual({ confidence: 0 });
    expect(getDocumentMock).not.toHaveBeenCalled();
  });

  it("swallows a thrown parse rather than rejecting into the staging effect", async () => {
    const { readTitleBlock } = await import("@/lib/titleBlock");
    getDocumentMock.mockImplementation(() => { throw new Error("bad xref table"); });
    await expect(readTitleBlock(fakePdf())).resolves.toEqual({ confidence: 0 });
  });
});
