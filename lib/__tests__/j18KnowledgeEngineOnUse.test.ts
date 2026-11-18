// @vitest-environment jsdom
//
// projects-tab PERF-12 (projects-joint J18) — the knowledge indicator stays in
// the app shell and starts its drain at mount, as before; the indexing engine
// it drives (lib/knowledge.ts) is fetched on use instead of with every route.
//   * a tab that is not a controller's never fetches the engine;
//   * a controller's first pass fetches it alongside the queue read and
//     indexes the queued document, with the same call as before;
//   * a fetch that fails (offline before the engine was ever loaded) ends the
//     pass as an empty queue would — nothing shown, nothing thrown — and the
//     next poll fetches it again and indexes.
// The drain's own rules are pinned, through this same on-use engine, by
// knowledgeIndexIndicator.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const st = vi.hoisted(() => ({
  controller: true,
  engineFails: false,
  engineFetches: 0,
  rows: [] as Array<Record<string, unknown>>,
  ingest: [] as string[],
}));

vi.mock("@/lib/supabase", () => {
  const from = () => {
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: st.rows, error: null });
        return () => new Proxy({}, h);
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from } };
});
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "o1", uid: "u1", hasAnyRole: (rs: string[]) => st.controller && rs.includes("DocCtrl") }),
}));
vi.mock("@/lib/uploadActivity", () => ({ isUploading: () => false, onUploadActivity: () => () => undefined }));
vi.mock("@/components/ui/CornerDock", () => ({
  CornerPortal: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  useDockAllowance: (_slot: string, _priority: number, count: number) => count,
  DOCK_PRIORITY: { backup: 10, knowledge: 20, upload: 30, toast: 10 },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const poll = async () => { await act(async () => { vi.advanceTimersByTime(120_000); }); await flush(); };
const FRESH = { id: "fresh", name: "API-650.pdf", status: "pending", pages_indexed: 0, page_count: null, error: null, vision_retry_after: null };

async function mount() {
  const { default: KnowledgeIndexIndicator } = await import("@/components/providers/KnowledgeIndexIndicator");
  await act(async () => { root.render(React.createElement(KnowledgeIndexIndicator)); });
  await flush();
}

// Registered per test, after the module reset, so each test starts with the
// engine not yet fetched and a failed fetch can be retried.
const engineFactory = () => {
  st.engineFetches++;
  if (st.engineFails) throw new Error("Failed to fetch dynamically imported module");
  return {
    isIngestActive: () => false,
    ingestKnowledgeDocument: async (id: string, onIndex?: (i: number, t: number | null, p?: { visionPages: number }) => void) => {
      st.ingest.push(id);
      onIndex?.(10, 10, { visionPages: 0 });
    },
  };
};

beforeEach(() => {
  vi.resetModules(); // a cold shell: the engine not yet fetched
  vi.doMock("@/lib/knowledge", engineFactory);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  Object.assign(st, { controller: true, engineFails: false, engineFetches: 0, rows: [FRESH], ingest: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PERF-12 — the indexing engine loads on use", () => {
  it("a tab that is not a controller's never fetches the engine", async () => {
    st.controller = false;
    await mount();
    await poll();
    expect(st.engineFetches).toBe(0);
    expect(st.ingest).toEqual([]);
  });

  it("a controller's first pass, at mount, fetches the engine and indexes the queued document", async () => {
    await mount();
    expect(st.engineFetches).toBe(1);
    expect(st.ingest).toEqual(["fresh"]);
    expect(host.textContent).toContain("1 document indexed");
  });

  it("a failed fetch ends the pass quietly; the next poll fetches again and indexes", async () => {
    st.engineFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    process.on("unhandledRejection", onRejection);
    try {
      await mount();
      expect(st.engineFetches).toBe(1);
      expect(st.ingest).toEqual([]);
      expect(host.textContent).toBe(""); // nothing shown, as with an empty queue
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not load the indexing engine"), expect.anything());
      st.engineFails = false;
      await poll();
      expect(st.engineFetches).toBe(2);
      expect(st.ingest).toEqual(["fresh"]);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
