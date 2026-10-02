// @vitest-environment jsdom
//
// notifications Round G, N7 CORNER (2026-10-01) — the jobs in the corner and
// the dismissals that stick. STACK-1 / STACK-2 / STACK-3 / STACK-6 / STACK-8 /
// STACK-13 / TAX-8.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const auth = vi.hoisted(() => ({ cb: null as null | ((event: string) => void) }));
const db = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, queries: [] as Array<Array<{ m: string; a: unknown[] }>> }));
vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    const calls: Array<{ m: string; a: unknown[] }> = [{ m: "from", a: [table] }];
    db.queries.push(calls);
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: db.rows, error: null });
        return (...a: unknown[]) => { calls.push({ m: prop, a }); return new Proxy({}, h); };
      },
    };
    return new Proxy({}, h);
  };
  return {
    supabase: {
      from,
      auth: {
        getSession: async () => ({ data: { session: { access_token: "t" } } }),
        onAuthStateChange: (cb: (event: string) => void) => { auth.cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
      },
    },
  };
});

import { useDismissed, useDismissedSet, clearDismissals, DISMISSED_PREFIX, parseSet } from "@/hooks/useDismissed";
import {
  beginTransfer, endTransfer, beginUpload, endUpload, hasUploadsInFlight, releaseUploadUnloadGuard, UPLOAD_UNLOAD_MESSAGE,
} from "@/lib/uploadActivity";
import { uploadToPath, subscribeUploads, UploadCancelledError, type UploadActivity } from "@/lib/storage";
import { confirmReloadDuringUploads } from "@/components/system/UpdatePill";
import { confirmCancelBackup } from "@/components/providers/BackupIndicator";
import { ingestFailureOf } from "@/components/providers/KnowledgeIndexIndicator";
import {
  overlapKey, overlapFormedAt, overlapMark, overlapMarkAt, latestOverlapMark, OVERLAP_HEADSUP_WINDOW_DAYS,
} from "@/components/documents/EditOverlapBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  window.localStorage.clear();
  db.rows = []; db.queries = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

// ── STACK-2: the user's Stop is "cancelled", never a red "Failed" ───────────

describe("STACK-2 — lib/storage emits 'cancelled' for UploadCancelledError on every catch site", () => {
  const record = () => {
    const seen: UploadActivity[] = [];
    const off = subscribeUploads((e) => seen.push(e));
    return { seen, off };
  };

  it("single-PUT path: a Stop before the slot is granted emits uploading → cancelled, with no error text, and rethrows the cancel", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { seen, off } = record();
    await expect(uploadToPath(new Blob(["x"]), "orgs/o1/a.pdf", { signal: ctl.signal })).rejects.toBeInstanceOf(UploadCancelledError);
    off();
    expect(seen.map((e) => e.status)).toEqual(["uploading", "cancelled"]);
    expect(seen[1].error).toBeUndefined();
  });

  it("multipart path: the same — it used to have no cancel branch at all", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const big = { size: 200 * 1024 * 1024, type: "application/pdf", slice: () => new Blob(["x"]) } as unknown as Blob;
    const { seen, off } = record();
    await expect(uploadToPath(big, "orgs/o1/big.dwg", { signal: ctl.signal })).rejects.toBeInstanceOf(UploadCancelledError);
    off();
    expect(seen.map((e) => e.status)).toEqual(["uploading", "cancelled"]);
  });

  it("a real failure is still a failure with its reason", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("network down"), { name: "TypeError" }));
    const { seen, off } = record();
    await expect(uploadToPath(new Blob(["x"]), "orgs/o1/a.pdf")).rejects.toThrow(/network down/);
    off();
    expect(seen.map((e) => e.status)).toEqual(["uploading", "error"]);
    expect(seen[1].error).toMatch(/network down/);
  });
});

describe("STACK-2 — UploadIndicator renders a cancelled upload as a neutral 'Stopped' that clears on the 'Done' timing", () => {
  it("'Stopped', no rose, no 'Failed', gone after 2.5s; a failure still says 'Failed' with its reason", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const listeners = new Set<(e: unknown) => void>();
    vi.doMock("@/lib/storage", () => ({ subscribeUploads: (cb: (e: unknown) => void) => { listeners.add(cb); return () => listeners.delete(cb); } }));
    vi.resetModules();
    const { default: Indicator } = await import("@/components/providers/UploadIndicator");
    await act(async () => { root.render(React.createElement(Indicator)); });
    await act(async () => {
      for (const l of listeners) {
        l({ id: "s", name: "stopped.dwg", percent: 0, status: "cancelled" });
        l({ id: "f", name: "failed.dwg", percent: 0, status: "error", error: "connection reset" });
      }
    });
    await flush();
    const body = document.body.textContent ?? "";
    expect(body).toContain("stopped.dwg");
    expect(body).toContain("Stopped");
    const stoppedRow = [...document.querySelectorAll("span")].find((s) => s.textContent === "stopped.dwg")!.parentElement!;
    expect(stoppedRow.innerHTML).not.toMatch(/rose/);
    expect(stoppedRow.textContent).not.toContain("Failed");
    expect(body).toContain("Failed");
    expect(body).toContain("connection reset");
    await act(async () => { vi.advanceTimersByTime(2600); });
    await flush();
    expect(document.body.textContent).not.toContain("stopped.dwg");
    expect(document.body.textContent).toContain("failed.dwg");
    await act(async () => { vi.advanceTimersByTime(4600); });
    await flush();
    expect(document.body.textContent).not.toContain("failed.dwg");
    vi.doUnmock("@/lib/storage");
    vi.useRealTimers();
  });
});

// ── STACK-13: an upload on the wire guards the tab ──────────────────────────

describe("STACK-13 — a beforeunload guard while an upload is in flight", () => {
  it("installs while a transfer or a declared batch runs, removes when both drain", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    expect(hasUploadsInFlight()).toBe(false);
    beginTransfer();
    expect(hasUploadsInFlight()).toBe(true);
    expect(add.mock.calls.filter((c) => c[0] === "beforeunload")).toHaveLength(1);
    beginUpload();
    beginTransfer();
    expect(add.mock.calls.filter((c) => c[0] === "beforeunload")).toHaveLength(1);
    endTransfer(); endTransfer();
    expect(remove.mock.calls.filter((c) => c[0] === "beforeunload")).toHaveLength(0);
    endUpload();
    expect(hasUploadsInFlight()).toBe(false);
    expect(remove.mock.calls.filter((c) => c[0] === "beforeunload")).toHaveLength(1);
    const handler = add.mock.calls.find((c) => c[0] === "beforeunload")![1] as (e: Event) => void;
    const ev = { preventDefault: vi.fn(), returnValue: "" } as unknown as BeforeUnloadEvent;
    handler(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.returnValue).toBe(UPLOAD_UNLOAD_MESSAGE);
  });

  it("uploadToPath holds a transfer for exactly the life of the call", async () => {
    let release!: (v: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((r) => { release = r; }));
    const p = uploadToPath(new Blob(["x"]), "orgs/o1/a.pdf");
    await Promise.resolve(); await Promise.resolve();
    expect(hasUploadsInFlight()).toBe(true);
    release({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);
    await expect(p).rejects.toThrow();
    expect(hasUploadsInFlight()).toBe(false);
  });

  it("releaseUploadUnloadGuard drops the browser prompt once a person said go, until the work drains", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    beginTransfer();
    releaseUploadUnloadGuard();
    expect(remove.mock.calls.filter((c) => c[0] === "beforeunload")).toHaveLength(1);
    endTransfer();
    const add = vi.spyOn(window, "addEventListener");
    beginTransfer();
    expect(add.mock.calls.filter((c) => c[0] === "beforeunload")).toHaveLength(1);
    endTransfer();
  });

  it("UpdatePill asks before reloading while an upload is in flight; no upload, no question", async () => {
    const confirm = vi.fn(async () => false);
    const release = vi.fn();
    expect(await confirmReloadDuringUploads({ inFlight: () => false, confirm, release })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(await confirmReloadDuringUploads({ inFlight: () => true, confirm, release })).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    expect(await confirmReloadDuringUploads({ inFlight: () => true, confirm, release })).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    const src = readFileSync(resolve("components/system/UpdatePill.tsx"), "utf8");
    expect(src).toContain("if (!(await confirmReloadDuringUploads())) return;");
  });
});

// ── STACK-8: the backup in the dock, minimizable, Cancel confirmed ──────────

describe("STACK-8 — BackupIndicator", () => {
  it("Cancel asks first and cancels only on yes", async () => {
    const cancel = vi.fn();
    expect(await confirmCancelBackup(async () => false, cancel)).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(await confirmCancelBackup(async () => true, cancel)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("renders in the dock's jobs slot, minimizes to a pill that keeps the percent, and the X still dismisses a finished run", async () => {
    let publish!: (p: unknown) => void;
    const dismiss = vi.fn(() => publish(null));
    vi.doMock("@/lib/clientBackup", () => ({
      subscribeBackup: (fn: (p: unknown) => void) => { publish = fn; fn(null); return () => {}; },
      cancelBackup: vi.fn(), dismissBackup: dismiss,
    }));
    vi.resetModules();
    const { default: Backup } = await import("@/components/providers/BackupIndicator");
    const { CornerDock, __resetDockForTests } = await import("@/components/ui/CornerDock");
    __resetDockForTests();
    await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(CornerDock), React.createElement(Backup))); });
    await act(async () => { publish({ phase: "files", filesDone: 10, filesTotal: 40, bytesDone: 0, bytesTotal: 0, part: 1, errors: [] }); });
    await flush();
    const d = document.getElementById("corner-dock")!;
    expect(d.querySelector('[data-dock-slot="jobs"]')!.textContent).toContain("Backup — file 11 of 40");
    await act(async () => { (d.querySelector('button[title^="Minimize"]') as HTMLElement).click(); });
    await flush();
    expect(d.textContent).toContain("Backup 25%");
    await act(async () => { (d.querySelector("button") as HTMLElement).click(); });
    await act(async () => { publish({ phase: "done", filesDone: 40, filesTotal: 40, bytesDone: 0, bytesTotal: 0, part: 2, errors: [] }); });
    await flush();
    await act(async () => { (d.querySelector('button[aria-label="Dismiss"]') as HTMLElement).click(); });
    expect(dismiss).toHaveBeenCalled();
    vi.doUnmock("@/lib/clientBackup");
  });
});

// ── STACK-3: an ingest failure is said, never a green check ─────────────────

describe("STACK-3 — ingestFailureOf", () => {
  it("a park (409: back-off / held vision retry) and another session's claim are not failures; anything else is, with its words", () => {
    expect(ingestFailureOf(Object.assign(new Error("AI vision could not read 2 pages…"), { visionRetryBlocked: true }))).toBeNull();
    expect(ingestFailureOf(Object.assign(new Error("Held for a minute"), { failureRetryBlocked: true }))).toBeNull();
    expect(ingestFailureOf(new Error("Another session is indexing this document right now. It carries on by itself — reopen the library later to see it finish."))).toBeNull();
    expect(ingestFailureOf(new Error("Indexing failed: connection reset"))).toBe("Indexing failed: connection reset");
    expect(ingestFailureOf(new Error("Indexing stalled at page 5 of 40 — …"))).toMatch(/stalled at page 5/);
    expect(ingestFailureOf(null)).toBe("Indexing failed.");
  });

  it("the busy sentence it recognises is lib/knowledge's own (a tripwire if the wording moves)", () => {
    const lib = readFileSync(resolve("lib/knowledge.ts"), "utf8");
    expect(lib).toContain('"Another session is indexing this document right now. It carries on by itself');
  });
});

describe("STACK-3 / STACK-6 / TAX-8 — the indexing card says failures and keeps dismissals", () => {
  async function mountIndicator(over: { uid?: string } = { uid: "u1" }) {
    vi.doMock("@/components/providers/RoleContext", () => ({
      useRole: () => ({ activeOrgId: "o1", uid: over.uid, hasAnyRole: () => true }),
    }));
    vi.doMock("@/lib/uploadActivity", () => ({ isUploading: () => false, onUploadActivity: () => () => undefined }));
    vi.doMock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement("a", { href }, children) }));
    vi.resetModules();
    const ing = { ingestKnowledgeDocument: vi.fn(), isIngestActive: vi.fn(() => false) };
    vi.doMock("@/lib/knowledge", () => ing);
    const { default: KII } = await import("@/components/providers/KnowledgeIndexIndicator");
    const { CornerDock, __resetDockForTests } = await import("@/components/ui/CornerDock");
    __resetDockForTests();
    return { KII, CornerDock, ing };
  }

  it("a failed document renders the rose 'could not be indexed' branch with the reason and a link to its library — never the green check", async () => {
    const { KII, CornerDock, ing } = await mountIndicator();
    db.rows = [{ id: "k1", name: "API-650.pdf", library_id: "lib1", status: "pending", pages_indexed: 0, error: null, vision_retry_after: null }];
    ing.ingestKnowledgeDocument.mockImplementation(async (_id: string, cb?: (i: number, t: number | null, p?: unknown) => void) => {
      cb?.(5, 40, { visionPages: 0 });
      throw new Error("Indexing stalled at page 5 of 40 — that page is taking longer than one server run allows.");
    });
    await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(CornerDock), React.createElement(KII))); });
    await flush(8);
    const d = document.getElementById("corner-dock")!;
    expect(d.textContent).toContain("1 document could not be indexed");
    expect(d.textContent).toContain("API-650.pdf");
    expect(d.textContent).toContain("Indexing stalled at page 5 of 40");
    expect(d.textContent).not.toContain("caught up");
    expect(d.querySelector(".text-emerald-600")).toBeNull();
    expect(d.querySelector("a")?.getAttribute("href")).toBe("/knowledge/lib1");
    // The queue read now carries the library for that link.
    expect(String(db.queries[0].find((c) => c.m === "select")?.a[0])).toContain("library_id");
    vi.doUnmock("@/lib/knowledge"); vi.doUnmock("@/components/providers/RoleContext"); vi.doUnmock("@/lib/uploadActivity"); vi.doUnmock("next/link");
  });

  it("a document that failed before any progress is still reported (it used to show no card at all)", async () => {
    const { KII, CornerDock, ing } = await mountIndicator();
    db.rows = [{ id: "k2", name: "B31.3.pdf", library_id: "lib2", status: "pending", pages_indexed: 0, error: null, vision_retry_after: null }];
    ing.ingestKnowledgeDocument.mockRejectedValue(new Error("Indexing failed: the file is not a PDF"));
    await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(CornerDock), React.createElement(KII))); });
    await flush(8);
    expect(document.getElementById("corner-dock")!.textContent).toContain("1 document could not be indexed");
    vi.doUnmock("@/lib/knowledge"); vi.doUnmock("@/components/providers/RoleContext"); vi.doUnmock("@/lib/uploadActivity"); vi.doUnmock("next/link");
  });

  it("a dismissal persists for this account in this workspace: after a remount new work shows only the pill, and a clean end nothing", async () => {
    const { KII, CornerDock, ing } = await mountIndicator();
    db.rows = [{ id: "k3", name: "A.pdf", library_id: "lib1", status: "pending", pages_indexed: 0, error: null, vision_retry_after: null }];
    ing.ingestKnowledgeDocument.mockImplementation(async (_id: string, cb?: (i: number, t: number | null, p?: unknown) => void) => { cb?.(10, 10, { visionPages: 0 }); });
    const tree = () => React.createElement(React.Fragment, null, React.createElement(CornerDock), React.createElement(KII, { key: Math.random() }));
    await act(async () => { root.render(tree()); });
    await flush(8);
    const d = () => document.getElementById("corner-dock")!;
    expect(d().textContent).toContain("Knowledge indexing caught up");
    await act(async () => { (d().querySelector('button[title="Dismiss"]') as HTMLElement).click(); });
    expect(window.localStorage.getItem(`${DISMISSED_PREFIX}u1:o1:knowledge-index:dismissed`)).toBe("1");
    // Remount (a reload, in effect) with new work that runs.
    let release!: () => void;
    db.rows = [{ id: "k4", name: "B.pdf", library_id: "lib1", status: "pending", pages_indexed: 0, error: null, vision_retry_after: null }];
    ing.ingestKnowledgeDocument.mockImplementation(async (_id: string, cb?: (i: number, t: number | null, p?: unknown) => void) => {
      cb?.(4, 10, { visionPages: 0 });
      await new Promise<void>((r) => { release = r; });
    });
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(tree()); });
    await flush(8);
    expect(d().textContent).toContain("Indexing 40%");
    expect(d().textContent).not.toContain("Indexing knowledge in the background");
    await act(async () => { release(); });
    await flush(8);
    expect(d().textContent ?? "").toBe("");
    vi.doUnmock("@/lib/knowledge"); vi.doUnmock("@/components/providers/RoleContext"); vi.doUnmock("@/lib/uploadActivity"); vi.doUnmock("next/link");
  });

  it("a failure outlives the drain pass that found it: a later pass that indexes another document never turns the card green", async () => {
    // Before the review fix each pass replaced `failed` with its own list: pass
    // 2 indexing doc B wiped pass 1's failure of doc A (whose row is now
    // `error`, so no pass reads it again) and the card went emerald.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { KII, CornerDock, ing } = await mountIndicator();
      db.rows = [{ id: "kA", name: "API-650.pdf", library_id: "lib1", status: "pending", pages_indexed: 0, error: null, vision_retry_after: null }];
      ing.ingestKnowledgeDocument.mockRejectedValueOnce(new Error("Indexing stalled at page 5 of 40"));
      await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(CornerDock), React.createElement(KII))); });
      await flush(8);
      const d = () => document.getElementById("corner-dock")!;
      expect(d().textContent).toContain("1 document could not be indexed");
      // Pass 2 (the 2-minute poll): A is `error` now and not read; B indexes.
      db.rows = [{ id: "kB", name: "B31.3.pdf", library_id: "lib1", status: "pending", pages_indexed: 0, error: null, vision_retry_after: null }];
      let release!: () => void;
      ing.ingestKnowledgeDocument.mockImplementationOnce(async (_id: string, cb?: (i: number, t: number | null, p?: unknown) => void) => {
        cb?.(10, 10, { visionPages: 0 });
        await new Promise<void>((r) => { release = r; });
      });
      await act(async () => { vi.advanceTimersByTime(120_000); });
      await flush(8);
      // Working on B, the card still says A failed.
      expect(d().textContent).toContain("Indexing knowledge in the background");
      expect(d().textContent).toContain("1 document could not be indexed so far");
      await act(async () => { release(); });
      await flush(8);
      expect(d().textContent).toContain("1 document could not be indexed");
      expect(d().textContent).toContain("API-650.pdf");
      expect(d().textContent).toContain("Indexing stalled at page 5 of 40");
      expect(d().textContent).toContain("1 document indexed.");
      expect(d().textContent).not.toContain("caught up");
      expect(d().querySelector(".text-emerald-600")).toBeNull();
      // A indexes after all (someone resumed it): no longer a failure.
      db.rows = [{ id: "kA", name: "API-650.pdf", library_id: "lib1", status: "pending", pages_indexed: 5, error: null, vision_retry_after: null }];
      ing.ingestKnowledgeDocument.mockImplementationOnce(async (_id: string, cb?: (i: number, t: number | null, p?: unknown) => void) => { cb?.(40, 40, { visionPages: 0 }); });
      await act(async () => { vi.advanceTimersByTime(120_000); });
      await flush(8);
      expect(d().textContent).toContain("Knowledge indexing caught up");
      expect(d().textContent).not.toContain("could not be indexed");
    } finally {
      vi.useRealTimers();
      vi.doUnmock("@/lib/knowledge"); vi.doUnmock("@/components/providers/RoleContext"); vi.doUnmock("@/lib/uploadActivity"); vi.doUnmock("next/link");
    }
  });

  it("dismissing the finished failure card drops the failures with it; a new failure brings the rose pill back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { KII, CornerDock, ing } = await mountIndicator();
      db.rows = [{ id: "kC", name: "C.pdf", library_id: "lib1", status: "pending", pages_indexed: 0, error: null, vision_retry_after: null }];
      ing.ingestKnowledgeDocument.mockRejectedValueOnce(new Error("Indexing failed: connection reset"));
      await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(CornerDock), React.createElement(KII))); });
      await flush(8);
      const d = () => document.getElementById("corner-dock")!;
      await act(async () => { (d().querySelector('button[title="Dismiss"]') as HTMLElement).click(); });
      await flush();
      expect(d().textContent ?? "").toBe("");
      // A clean pass after the dismissal shows nothing — the dropped failure
      // does not come back.
      db.rows = [{ id: "kD", name: "D.pdf", library_id: "lib1", status: "pending", pages_indexed: 0, error: null, vision_retry_after: null }];
      ing.ingestKnowledgeDocument.mockImplementationOnce(async (_id: string, cb?: (i: number, t: number | null, p?: unknown) => void) => { cb?.(3, 3, { visionPages: 0 }); });
      await act(async () => { vi.advanceTimersByTime(120_000); });
      await flush(8);
      expect(d().textContent ?? "").toBe("");
      // A new failure: the rose pill (the person dismissed the card before).
      db.rows = [{ id: "kE", name: "E.pdf", library_id: "lib1", status: "pending", pages_indexed: 0, error: null, vision_retry_after: null }];
      ing.ingestKnowledgeDocument.mockRejectedValueOnce(new Error("Indexing failed: the file is not a PDF"));
      await act(async () => { vi.advanceTimersByTime(120_000); });
      await flush(8);
      expect(d().textContent).toContain("1 not indexed");
    } finally {
      vi.useRealTimers();
      vi.doUnmock("@/lib/knowledge"); vi.doUnmock("@/components/providers/RoleContext"); vi.doUnmock("@/lib/uploadActivity"); vi.doUnmock("next/link");
    }
  });

  it("the drain never re-opens the card: `setHidden(false)` is gone from the loop", () => {
    const src = readFileSync(resolve("components/providers/KnowledgeIndexIndicator.tsx"), "utf8");
    const drain = src.slice(src.indexOf("const drain = async"), src.indexOf("void drain();"));
    expect(drain.length).toBeGreaterThan(100);
    expect(drain).not.toContain("setHidden(");
    expect(src).toContain('useDismissed("knowledge-index:dismissed", scope)');
    expect(src).toContain('useDismissed("knowledge-index:minimized", scope)');
  });
});

// ── hooks/useDismissed ──────────────────────────────────────────────────────

describe("useDismissed — localStorage keyed by account+workspace, hydration-safe, never throws", () => {
  function Flag({ k, scope, onApi }: { k: string; scope: string | null; onApi: (api: [boolean, (v: boolean) => void]) => void }) {
    const api = useDismissed(k, scope);
    onApi(api);
    return React.createElement("i", null, api[0] ? "dismissed" : "shown");
  }

  it("persists under dismissed:<scope>:<key> and survives a remount; another scope is untouched", async () => {
    let api!: [boolean, (v: boolean) => void];
    await act(async () => { root.render(React.createElement(Flag, { k: "x", scope: "u1:o1", onApi: (a) => { api = a; } })); });
    expect(host.textContent).toBe("shown");
    await act(async () => { api[1](true); });
    expect(host.textContent).toBe("dismissed");
    expect(window.localStorage.getItem("dismissed:u1:o1:x")).toBe("1");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(React.createElement(Flag, { k: "x", scope: "u1:o1", onApi: (a) => { api = a; } })); });
    expect(host.textContent).toBe("dismissed");
    await act(async () => { root.render(React.createElement(Flag, { k: "x", scope: "u2:o1", onApi: (a) => { api = a; } })); });
    expect(host.textContent).toBe("shown");
  });

  it("the server snapshot is 'dismissed', so a dismissed surface never flashes during hydration", () => {
    const html = renderToString(React.createElement(Flag, { k: "x", scope: "u1:o1", onApi: () => {} }));
    expect(html).toContain("dismissed");
  });

  it("with no scope nothing is persisted — the component's own state only", async () => {
    let api!: [boolean, (v: boolean) => void];
    await act(async () => { root.render(React.createElement(Flag, { k: "y", scope: null, onApi: (a) => { api = a; } })); });
    await act(async () => { api[1](true); });
    expect(host.textContent).toBe("dismissed");
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith(DISMISSED_PREFIX))).toEqual([]);
  });

  it("a storage that throws never breaks it: the dismissal holds for the tab", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    let api!: [boolean, (v: boolean) => void];
    await act(async () => { root.render(React.createElement(Flag, { k: "z", scope: "u1:o1", onApi: (a) => { api = a; } })); });
    expect(host.textContent).toBe("shown");
    await act(async () => { api[1](true); });
    expect(host.textContent).toBe("dismissed");
  });

  it("sign-out clears every dismissal (the same SIGNED_OUT the intel-status- snapshots are cleared on)", async () => {
    let api!: [boolean, (v: boolean) => void];
    await act(async () => { root.render(React.createElement(Flag, { k: "w", scope: "u1:o1", onApi: (a) => { api = a; } })); });
    await act(async () => { api[1](true); });
    window.localStorage.setItem("intel-status-u1-o1", "{}");
    expect(auth.cb).toBeTypeOf("function");
    await act(async () => { auth.cb!("SIGNED_OUT"); });
    expect(window.localStorage.getItem("dismissed:u1:o1:w")).toBeNull();
    expect(host.textContent).toBe("shown");
    // Not ours to clear: RoleContext owns that key.
    expect(window.localStorage.getItem("intel-status-u1-o1")).toBe("{}");
    clearDismissals();
  });

  it("useDismissedSet keeps ids, caps its size, and reads a malformed value as empty", async () => {
    const held: { api: ReturnType<typeof useDismissedSet> | null } = { api: null };
    function S() {
      const set = useDismissedSet("rows", "u1:o1");
      React.useEffect(() => { held.api = set; });
      return null;
    }
    await act(async () => { root.render(React.createElement(S)); });
    const api = new Proxy({} as ReturnType<typeof useDismissedSet>, { get: (_t, k: string) => (held.api as unknown as Record<string, unknown>)[k] });
    expect(api.ready).toBe(true);
    expect(api.has("a")).toBe(false);
    await act(async () => { api.add("a"); });
    expect(api.has("a")).toBe(true);
    expect(parseSet(window.localStorage.getItem("dismissed:u1:o1:rows")!)).toEqual(["a"]);
    await act(async () => { api.remove("a"); });
    expect(api.has("a")).toBe(false);
    expect(parseSet("{not json")).toEqual([]);
    expect(parseSet('["a", 3, "b"]')).toEqual(["a", "b"]);
  });
});

// ── TAX-8: the overlap banner remembers ─────────────────────────────────────

describe("TAX-8 — EditOverlapBanner: a dismissal and 'Heads-up sent' survive a remount", () => {
  async function loadBanner(overlaps: Array<{ documentId: string; libraryId: string | null; intents: Array<{ userId: string; userName: string; source: string; createdAt?: string }> }>) {
    const notify = vi.fn(async () => undefined);
    vi.doMock("@/lib/intents", () => ({ listOrgEditOverlaps: async () => overlaps }));
    vi.doMock("@/lib/inAppNotifications", () => ({ notifyMany: notify }));
    vi.resetModules();
    const { default: Banner } = await import("@/components/documents/EditOverlapBanner");
    return { Banner, notify };
  }
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const two = [{ documentId: "d1", libraryId: "L1", intents: [
    { userId: "me", userName: "Me", source: "checkout", createdAt: ago(6) }, { userId: "pat", userName: "Pat", source: "download", createdAt: ago(5) },
  ] }];

  it("'Heads-up sent' is derived from an overlap_advisory row this person received from someone in the overlap", async () => {
    const { Banner } = await loadBanner(two);
    db.rows = [{ id: "d1", document_number: "P-101", resource_id: "d1", actor_user_id: "pat", actor_name: "Pat", created_at: ago(4) }];
    await act(async () => { root.render(React.createElement(Banner, { orgId: "o1", currentUserId: "me" })); });
    await flush(6);
    expect(host.textContent).toContain("Heads-up sent ✓");
    const adv = db.queries.find((q) => q.some((c) => c.m === "from" && c.a[0] === "notifications"))!;
    expect(adv).toBeTruthy();
    expect(adv).toContainEqual({ m: "eq", a: ["kind", "overlap_advisory"] });
    expect(adv).toContainEqual({ m: "eq", a: ["user_id", "me"] });
    expect(adv.find((c) => c.m === "gte")?.a[0]).toBe("created_at");
    expect(String(adv.find((c) => c.m === "select")?.a[0])).toContain("created_at");
    expect(OVERLAP_HEADSUP_WINDOW_DAYS).toBe(14);
    vi.doUnmock("@/lib/intents"); vi.doUnmock("@/lib/inAppNotifications");
  });

  it("this person's own heads-up and their dismissal survive a remount; a new person in the overlap shows it again", async () => {
    const { Banner, notify } = await loadBanner(two);
    db.rows = [];
    const el = () => React.createElement(Banner, { orgId: "o1", currentUserId: "me", key: Math.random() });
    await act(async () => { root.render(el()); });
    await flush(6);
    const send = [...host.querySelectorAll("button")].find((b) => /Send heads-up/.test(b.textContent ?? ""))!;
    await act(async () => { send.click(); });
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Heads-up sent ✓");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(el()); });
    await flush(6);
    expect(host.textContent).toContain("Heads-up sent ✓");
    expect([...host.querySelectorAll("button")].some((b) => /Send heads-up/.test(b.textContent ?? ""))).toBe(false);
    // Dismiss, remount: still dismissed.
    await act(async () => { (host.querySelector('button[aria-label="Dismiss"]') as HTMLElement).click(); });
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(el()); });
    await flush(6);
    expect(host.textContent).toBe("");
    expect(overlapKey("d1", two[0].intents)).toBe("d1:me,pat");
    vi.doUnmock("@/lib/intents"); vi.doUnmock("@/lib/inAppNotifications");
    // Someone new joins: a different overlap, shown again.
    const three = [{ ...two[0], intents: [...two[0].intents, { userId: "sam", userName: "Sam", source: "ticket", createdAt: ago(1) }] }];
    const again = await loadBanner(three);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(React.createElement(again.Banner, { orgId: "o1", currentUserId: "me" })); });
    await flush(6);
    expect(host.textContent).toContain("you and Pat, Sam both have active edit work");
    expect([...host.querySelectorAll("button")].some((b) => /Send heads-up/.test(b.textContent ?? ""))).toBe(true);
    vi.doUnmock("@/lib/intents"); vi.doUnmock("@/lib/inAppNotifications");
  });
});

describe("TAX-8 (review fix) — 'Heads-up sent' counts only a heads-up sent after the overlap formed", () => {
  async function loadBanner(overlaps: Array<{ documentId: string; libraryId: string | null; intents: Array<{ userId: string; userName: string; source: string; createdAt?: string }> }>) {
    const notify = vi.fn(async () => undefined);
    vi.doMock("@/lib/intents", () => ({ listOrgEditOverlaps: async () => overlaps }));
    vi.doMock("@/lib/inAppNotifications", () => ({ notifyMany: notify }));
    vi.resetModules();
    const { default: Banner } = await import("@/components/documents/EditOverlapBanner");
    return { Banner, notify };
  }
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const offered = () => [...host.querySelectorAll("button")].some((b) => /Send heads-up/.test(b.textContent ?? ""));
  const withSam = (samJoined: string) => [{ documentId: "d1", libraryId: "L1", intents: [
    { userId: "me", userName: "Me", source: "checkout", createdAt: ago(6) },
    { userId: "pat", userName: "Pat", source: "download", createdAt: ago(5) },
    { userId: "sam", userName: "Sam", source: "ticket", createdAt: samJoined },
  ] }];

  it("overlapFormedAt is when the last person joined (each person's earliest live intent); an unreadable date claims nothing", () => {
    const t = (d: string) => Date.parse(d);
    expect(overlapFormedAt([
      { userId: "me", createdAt: "2026-09-01T00:00:00Z" },
      { userId: "pat", createdAt: "2026-09-03T00:00:00Z" },
      { userId: "pat", createdAt: "2026-09-05T00:00:00Z" }, // a second intent of someone already in it
    ])).toBe(t("2026-09-03T00:00:00Z"));
    expect(overlapFormedAt([{ userId: "me", createdAt: "2026-09-01T00:00:00Z" }, { userId: "pat", createdAt: "garbage" }])).toBe(Infinity);
    expect(latestOverlapMark([overlapMark("d1:me,pat", 5), overlapMark("d1:me,pat", 9), overlapMark("d1:me,pat,sam", 20), "d1:me,pat"], "d1:me,pat")).toBe(9);
    expect(latestOverlapMark([], "d1:me,pat")).toBe(-Infinity);
  });

  it("a heads-up from Pat sent BEFORE Sam joined leaves the button offered — Sam never got it", async () => {
    const { Banner } = await loadBanner(withSam(ago(3)));
    db.rows = [{ id: "d1", document_number: "P-101", resource_id: "d1", actor_user_id: "pat", actor_name: "Pat", created_at: ago(4) }];
    await act(async () => { root.render(React.createElement(Banner, { orgId: "o1", currentUserId: "me" })); });
    await flush(6);
    expect(host.textContent).toContain("you and Pat, Sam both have active edit work");
    expect(host.textContent).not.toContain("Heads-up sent");
    expect(offered()).toBe(true);
    vi.doUnmock("@/lib/intents"); vi.doUnmock("@/lib/inAppNotifications");
  });

  it("one sent AFTER Sam joined reached everyone in the overlap now: 'Heads-up sent'", async () => {
    const { Banner } = await loadBanner(withSam(ago(3)));
    db.rows = [{ id: "d1", document_number: "P-101", resource_id: "d1", actor_user_id: "pat", actor_name: "Pat", created_at: ago(2) }];
    await act(async () => { root.render(React.createElement(Banner, { orgId: "o1", currentUserId: "me" })); });
    await flush(6);
    expect(host.textContent).toContain("Heads-up sent ✓");
    expect(offered()).toBe(false);
    vi.doUnmock("@/lib/intents"); vi.doUnmock("@/lib/inAppNotifications");
  });

  it("this person's own send and dismissal are stamped: the same people overlapping again later is a new overlap", async () => {
    const key = "d1:me,pat";
    // Sent and dismissed 20 days ago, for an overlap of the same two people
    // that has since dissolved; the one live now formed 5 days ago.
    window.localStorage.setItem(`${DISMISSED_PREFIX}me:o1:overlap-headsup-sent`, JSON.stringify([overlapMark(key, Date.now() - 20 * DAY)]));
    const live = [{ documentId: "d1", libraryId: "L1", intents: [
      { userId: "me", userName: "Me", source: "checkout", createdAt: ago(6) }, { userId: "pat", userName: "Pat", source: "download", createdAt: ago(5) },
    ] }];
    const { Banner } = await loadBanner(live);
    db.rows = [];
    await act(async () => { root.render(React.createElement(Banner, { orgId: "o1", currentUserId: "me" })); });
    await flush(6);
    expect(offered()).toBe(true);
    // A dismissal from that old overlap does not hide this one either.
    await act(async () => root.unmount());
    root = createRoot(host);
    window.localStorage.setItem(`${DISMISSED_PREFIX}me:o1:overlap-banner`, JSON.stringify([overlapMark(key, Date.now() - 20 * DAY)]));
    await act(async () => { root.render(React.createElement(Banner, { orgId: "o1", currentUserId: "me" })); });
    await flush(6);
    expect(host.textContent).toContain("you and Pat both have active edit work");
    // Sending now marks it once (an earlier mark for the overlap is replaced).
    const send = [...host.querySelectorAll("button")].find((b) => /Send heads-up/.test(b.textContent ?? ""))!;
    await act(async () => { send.click(); });
    await flush();
    expect(host.textContent).toContain("Heads-up sent ✓");
    const marks = parseSet(window.localStorage.getItem(`${DISMISSED_PREFIX}me:o1:overlap-headsup-sent`)!);
    expect(marks).toHaveLength(1);
    // Stamped with the live overlap's formed time (Pat joined 5 days ago),
    // which replaces the old overlap's mark.
    expect(latestOverlapMark(marks, key)).toBe(overlapFormedAt(live[0].intents));
    expect(latestOverlapMark(marks, key)).toBeGreaterThan(Date.now() - 20 * DAY);
    vi.doUnmock("@/lib/intents"); vi.doUnmock("@/lib/inAppNotifications");
  });
});

describe("TAX-8 (N7 third review) — a re-formed overlap is new only once its lapsed intent rows are pruned", () => {
  it("recordIntent re-upserts a lapsed row without touching created_at, so the re-formed overlap keeps its formed time and an old mark still covers it", () => {
    // Pinned as it is (lib/intents is not this package's file): the upsert
    // refreshes refreshed_at / expires_at on the conflict key and never
    // sends created_at, so the row keeps the time it was first declared.
    const intents = readFileSync(resolve("lib/intents.ts"), "utf8");
    const upsert = intents.slice(intents.indexOf('.from("document_intents")\n      .upsert('), intents.indexOf('{ onConflict: "document_id,user_id,kind,source" }'));
    expect(upsert.startsWith('.from("document_intents")')).toBe(true);
    expect(upsert).toContain("user_id: input.userId,");
    expect(upsert).toContain("refreshed_at: new Date(now).toISOString(),");
    expect(upsert).toContain("expires_at: computeIntentExpiry(input.kind, input.source, now),");
    expect(upsert).not.toContain("created_at");
    // The prune that makes a later overlap a new one: the maintenance cron
    // deletes expired rows (vercel.json: daily).
    const cron = readFileSync(resolve("app/api/cron/maintenance/route.ts"), "utf8");
    expect(cron).toMatch(/\.from\("document_intents"\)\s*\.delete\(\)\s*\.lt\("expires_at"/);
    // So: B dismissed the overlap (stamped with its formed time F); B's
    // intent lapsed; B re-declared before the prune — B's row still says F.
    const F = "2026-09-20T09:00:00.000Z";
    const reformed = [{ userId: "a", createdAt: "2026-09-19T08:00:00.000Z" }, { userId: "b", createdAt: F }];
    const dismissal = overlapMark(overlapKey("d1", reformed), overlapMarkAt(Date.parse(F)));
    expect(latestOverlapMark([dismissal], overlapKey("d1", reformed)) >= overlapFormedAt(reformed)).toBe(true);
    // After the prune B's re-declaration is a new row with a new created_at:
    // the overlap forms later and the old mark no longer covers it.
    const fresh = [{ userId: "a", createdAt: "2026-09-19T08:00:00.000Z" }, { userId: "b", createdAt: "2026-09-22T10:00:00.000Z" }];
    expect(latestOverlapMark([dismissal], overlapKey("d1", fresh)) >= overlapFormedAt(fresh)).toBe(false);
    // The banner's header says exactly this (it used to claim the opposite).
    const banner = readFileSync(resolve("components/documents/EditOverlapBanner.tsx"), "utf8");
    expect(banner).toContain("but only once the lapsed\n//     intent rows are gone");
  });
});

describe("TAX-8 (N7 review) — marks never mix the browser's clock with the server's", () => {
  async function loadBanner(overlaps: Array<{ documentId: string; libraryId: string | null; intents: Array<{ userId: string; userName: string; source: string; createdAt?: string }> }>) {
    const notify = vi.fn(async () => undefined);
    vi.doMock("@/lib/intents", () => ({ listOrgEditOverlaps: async () => overlaps }));
    vi.doMock("@/lib/inAppNotifications", () => ({ notifyMany: notify }));
    vi.resetModules();
    const { default: Banner } = await import("@/components/documents/EditOverlapBanner");
    return { Banner, notify };
  }
  const offered = () => [...host.querySelectorAll("button")].some((b) => /Send heads-up/.test(b.textContent ?? ""));

  it("overlapMarkAt stamps the overlap's formed time; an unreadable one falls back to now (it is never covered anyway)", () => {
    expect(overlapMarkAt(1_000, 5_000)).toBe(1_000);
    expect(overlapMarkAt(9_000, 5_000)).toBe(9_000);
    expect(overlapMarkAt(Infinity, 5_000)).toBe(5_000);
  });

  it("on a PC whose clock runs 3 minutes behind the server, a sent heads-up and a dismissal still stick across a remount", async () => {
    // The overlap formed one minute ago by the server's clock — two minutes
    // AFTER this browser's Date.now(). Before: the marks were Date.now()
    // stamps, earlier than "formed", so neither ever counted.
    const formedIso = new Date(Date.now() + 2 * 60_000).toISOString();
    const overlap = [{ documentId: "d1", libraryId: "L1", intents: [
      { userId: "me", userName: "Me", source: "checkout", createdAt: new Date(Date.now() - 60_000).toISOString() },
      { userId: "pat", userName: "Pat", source: "download", createdAt: formedIso },
    ] }];
    const { Banner, notify } = await loadBanner(overlap);
    db.rows = [];
    const el = () => React.createElement(Banner, { orgId: "o1", currentUserId: "me", key: Math.random() });
    await act(async () => { root.render(el()); });
    await flush(6);
    const send = [...host.querySelectorAll("button")].find((b) => /Send heads-up/.test(b.textContent ?? ""))!;
    await act(async () => { send.click(); });
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(el()); });
    await flush(6);
    expect(host.textContent).toContain("Heads-up sent ✓");
    expect(offered()).toBe(false);
    const marks = parseSet(window.localStorage.getItem(`${DISMISSED_PREFIX}me:o1:overlap-headsup-sent`)!);
    expect(latestOverlapMark(marks, "d1:me,pat")).toBe(Date.parse(formedIso));
    await act(async () => { (host.querySelector('button[aria-label="Dismiss"]') as HTMLElement).click(); });
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(el()); });
    await flush(6);
    expect(host.textContent).toBe("");
    vi.doUnmock("@/lib/intents"); vi.doUnmock("@/lib/inAppNotifications");
  });
});

// ── STACK-1: the semantic build cannot outlive its Stop ─────────────────────

describe("STACK-1 — SemanticIndexPanel stops its build when it unmounts", () => {
  it("leaving the page flips the loop's stop channel; the outcome is said in a toast that outlives the page", async () => {
    const toast = vi.fn();
    let shouldStop: (() => boolean) | null = null;
    let finish!: (v: unknown) => void;
    vi.doMock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: toast }) }));
    vi.doMock("@/lib/knowledge", () => ({
      semanticStatus: async () => ({ total: 10, coveredNow: 2, remaining: 8, done: false, error: null, embedded: 0, spentThisRun: 0 }),
      buildSemanticIndex: (_o: string, _l: string, _p: unknown, stop: () => boolean) => { shouldStop = stop; return new Promise((r) => { finish = r; }); },
      resetSemanticIndex: vi.fn(), retryFailedPassages: vi.fn(), setKeepIndexCurrent: vi.fn(), releaseBackgroundBuild: vi.fn(),
      acceptAiAgreement: vi.fn(), releaseOutcome: vi.fn(), keepCurrentOutcome: vi.fn(), retryOutcome: vi.fn(),
    }));
    vi.resetModules();
    const { default: Panel } = await import("@/components/knowledge/SemanticIndexPanel");
    await act(async () => { root.render(React.createElement(Panel, { orgId: "o1", libraryId: "L1", isController: true })); });
    await flush(6);
    const build = [...host.querySelectorAll("button")].find((b) => /Build index/.test(b.textContent ?? ""))!;
    await act(async () => { build.click(); });
    await flush();
    expect(shouldStop!()).toBe(false);
    await act(async () => root.unmount());
    expect(shouldStop!()).toBe(true);
    await act(async () => { finish({ total: 10, coveredNow: 4, remaining: 6, done: false, error: null, embedded: 2, spentThisRun: 0 }); });
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/stopped when you left the page — 6 passage/) }));
    root = createRoot(host);
    vi.doUnmock("@/components/providers/ToastProvider"); vi.doUnmock("@/lib/knowledge");
  });
});
