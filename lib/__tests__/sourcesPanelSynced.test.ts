// @vitest-environment jsdom
//
// intelligence Round G (I-06b) — ILIFE-13: the knowledge library's Sources
// strip says when the library last synced with Document Control, from the
// sources route's lastSyncedAt; where the database does not record it (the
// route answers syncTracked false, or predates the field) it says nothing
// rather than invent a time.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const list = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({}), auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock("@/lib/knowledge", async (orig) => ({ ...(await orig<typeof import("@/lib/knowledge")>()), listKnowledgeSources: list.fn }));

import SourcesPanel from "@/components/knowledge/SourcesPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = {
  id: "s1", sourceType: "library", sourceId: "lib-dc", sourceName: "Piping", createdByName: "Dana",
  createdAt: "2026-09-01T00:00:00Z", documentCount: 12,
};
let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(answer: Record<string, unknown>) {
  list.fn.mockResolvedValue(answer);
  await act(async () => { root.render(React.createElement(SourcesPanel, { orgId: "o1", libraryId: "kl-1", isController: true, onChanged: () => undefined })); });
  await flush();
}
const line = () => host.querySelector('[data-testid="sources-last-synced"]');

beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("ILIFE-13 — the Sources strip shows the library's last sync", () => {
  it("how long ago, with the time itself on hover", async () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    await mount({ sources: [{ ...SOURCE, lastSyncedAt: at }], canManage: true, lastSyncedAt: at, syncTracked: true });
    expect(line()?.textContent).toBe("Last synced with Document Control 5 minutes ago.");
    expect(line()?.getAttribute("title")).toBe(new Date(at).toLocaleString());
  });

  it("a library never synced (or due first) says the nightly run reaches it first", async () => {
    await mount({ sources: [{ ...SOURCE, lastSyncedAt: null }], canManage: true, lastSyncedAt: null, syncTracked: true });
    expect(line()?.textContent).toMatch(/^Not synced with Document Control yet — the nightly run reaches it first/);
  });

  it("nothing is invented where the database does not record it, or the route predates the field", async () => {
    await mount({ sources: [SOURCE], canManage: true, lastSyncedAt: null, syncTracked: false });
    expect(line()).toBeNull();
    await mount({ sources: [SOURCE], canManage: true });
    expect(line()).toBeNull();
    expect(host.textContent).toContain("Piping");
  });

  it("a library with no sources shows no sync line", async () => {
    await mount({ sources: [], canManage: true, lastSyncedAt: null, syncTracked: true });
    expect(line()).toBeNull();
  });
});
