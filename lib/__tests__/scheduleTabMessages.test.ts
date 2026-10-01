// @vitest-environment jsdom
//
// projects Round G — J6b SCHEDULE-ENGINE review fix: what ScheduleTab says
// after an action is still on screen after the reload that follows it.
//
//   Every handler set its message and then reloaded — and refresh() began
//   with setError(null), so the message was wiped in the same tick: the
//   named SCH-7 refusal ("changed by someone else … not moved") and the
//   Planning list's delete error (SCH-17) never reached the screen, and a
//   realtime event (20261106) would clear any message at any moment.
//   Now a reload never clears an ACTION's message; the next action or
//   Dismiss does. A failed load is its own message.
//
// Rendered: ScheduleTab with lib/milestones' writers stubbed and
// ExecutionView replaced by a probe that hands its onMoveMany back.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Milestone } from "@/types/schema";

const h = vi.hoisted(() => ({
  rows: [] as Milestone[],
  listCalls: 0,
  listFails: null as null | string,
  moveResult: null as unknown,
  deleteError: null as null | string,
  realtime: [] as Array<() => void>,
  board: null as null | { onMoveMany: (changes: Array<{ id: string; plannedStartAt: string; plannedAt: string }>) => Promise<unknown> },
}));

vi.mock("@/lib/supabase", () => {
  const channel = {
    on: (_ev: string, _filter: unknown, cb: () => void) => { h.realtime.push(cb); return channel; },
    subscribe: () => channel,
  };
  const chain: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return () => chain;
    },
  });
  return { supabase: { channel: () => channel, removeChannel: async () => undefined, from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(), logMilestoneEvent: vi.fn() }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true), appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock("@/lib/milestones", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/milestones")>();
  return {
    ...real,
    listMilestones: vi.fn(async () => {
      h.listCalls++;
      if (h.listFails) throw new Error(h.listFails);
      return h.rows.map((r) => ({ ...r }));
    }),
    applyMilestoneMoves: vi.fn(async () => h.moveResult),
    deleteMilestone: vi.fn(async () => { if (h.deleteError) throw new Error(h.deleteError); return { reparented: 0, unlinked: 0 }; }),
  };
});
vi.mock("@/components/projects/ExecutionView", () => ({
  default: (props: { onMoveMany: (changes: Array<{ id: string; plannedStartAt: string; plannedAt: string }>) => Promise<unknown> }) => {
    h.board = { onMoveMany: props.onMoveMany };
    return React.createElement("div", { "data-testid": "board" });
  },
}));

import ScheduleTab from "@/components/projects/ScheduleTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const mk = (o: Partial<Milestone>): Milestone => ({
  orgId: "o", projectId: "p", name: "t", weight: 1, plannedAt: "2026-06-05T00:00:00Z",
  status: "planned", source: "manual", createdBy: "u", dependsOn: [], updatedAt: "2026-09-30T08:00:00+00:00", ...o,
});
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}
async function mount() {
  await act(async () => {
    root.render(React.createElement(ScheduleTab, { orgId: "o", projectId: "p", userId: "u", userRole: "Admin" }));
  });
  await settle();
}

beforeEach(() => {
  h.rows = [
    mk({ id: "weld", name: "Weld", plannedStartAt: "2026-06-01T00:00:00Z", plannedAt: "2026-06-03T00:00:00Z" }),
    mk({ id: "nde", name: "NDE", plannedStartAt: "2026-06-04T00:00:00Z", plannedAt: "2026-06-05T00:00:00Z", dependsOn: ["weld"] }),
  ];
  h.listCalls = 0; h.listFails = null; h.moveResult = null; h.deleteError = null; h.realtime = []; h.board = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("SCH-7 · a refused move is NAMED on screen, after the reload that follows it", () => {
  it("a stale view refused whole: the message names the task and survives the reload (was wiped in the same tick)", async () => {
    await mount();
    expect(h.board).not.toBeNull();
    h.moveResult = { count: 0, matched: [], unmatched: ["weld"], refused: true };
    const before = h.listCalls;
    let out: unknown;
    await act(async () => { out = await h.board!.onMoveMany([{ id: "weld", plannedStartAt: "2026-06-02T00:00:00Z", plannedAt: "2026-06-04T00:00:00Z" }]); });
    await settle();
    expect(h.listCalls).toBeGreaterThan(before); // the board was reloaded …
    expect(host.textContent).toMatch(/1 task was changed by someone else and was not moved: Weld — nothing was moved\. The schedule has been reloaded/); // … and the message is still there
    expect(out).toMatchObject({ ok: false, matched: [], error: "Weld was changed by someone else — nothing was moved" });
  });
  it("a realtime reload does not clear it either; Dismiss does; the next action starts clean", async () => {
    await mount();
    h.moveResult = { count: 0, matched: [], unmatched: ["weld"], refused: true };
    await act(async () => { await h.board!.onMoveMany([{ id: "weld", plannedStartAt: "2026-06-02T00:00:00Z", plannedAt: "2026-06-04T00:00:00Z" }]); });
    await settle();
    // A colleague's edit arrives (20261106): the debounced reload runs.
    vi.useFakeTimers();
    try {
      for (const cb of h.realtime) cb();
      await act(async () => { vi.advanceTimersByTime(700); });
    } finally { vi.useRealTimers(); }
    await settle();
    expect(host.textContent).toMatch(/changed by someone else and was not moved: Weld/);
    const dismiss = host.querySelector('button[aria-label="Dismiss this message"]') as HTMLButtonElement;
    expect(dismiss).not.toBeNull();
    await act(async () => { dismiss.click(); });
    expect(host.textContent).not.toMatch(/changed by someone else/);
    // A move that works shows nothing stale.
    h.moveResult = { count: 1, matched: ["weld"], unmatched: [], updatedAt: { weld: "2026-09-30T09:00:00+00:00" } };
    await act(async () => { await h.board!.onMoveMany([{ id: "weld", plannedStartAt: "2026-06-02T00:00:00Z", plannedAt: "2026-06-04T00:00:00Z" }]); });
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("'Moved, but the audit …' survives the reload that follows when the new locks could not be read back", async () => {
    await mount();
    h.moveResult = { count: 1, matched: ["weld"], unmatched: [], auditError: "the audit row could not be written" };
    await act(async () => { await h.board!.onMoveMany([{ id: "weld", plannedStartAt: "2026-06-02T00:00:00Z", plannedAt: "2026-06-04T00:00:00Z" }]); });
    await settle();
    expect(host.textContent).toMatch(/Moved, but the audit row could not be written\./);
  });
  it("a failed load is its own message, cleared by the next load that works — and it never clears an action's message", async () => {
    await mount();
    h.moveResult = { count: 0, matched: [], unmatched: ["weld"], refused: true };
    h.listFails = "network down";
    await act(async () => { await h.board!.onMoveMany([{ id: "weld", plannedStartAt: "2026-06-02T00:00:00Z", plannedAt: "2026-06-04T00:00:00Z" }]); });
    await settle();
    expect(host.textContent).toMatch(/not moved: Weld .* · network down/);
    h.listFails = null;
    vi.useFakeTimers();
    try {
      for (const cb of h.realtime) cb();
      await act(async () => { vi.advanceTimersByTime(700); });
    } finally { vi.useRealTimers(); }
    await settle();
    expect(host.textContent).not.toMatch(/network down/);
    expect(host.textContent).toMatch(/not moved: Weld/);
  });
});

describe("SCH-17 · the Planning list's delete error reaches the screen", () => {
  it("a refused delete says so, after the reload", async () => {
    await mount();
    const planning = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Planning") as HTMLButtonElement;
    await act(async () => { planning.click(); });
    await settle();
    h.deleteError = "“Weld” was not deleted — you do not have the right to delete it (Admin or Manager, its creator, or someone who manages this project may), or it is already gone. Nothing was changed.";
    const before = h.listCalls;
    const del = host.querySelector('button[title="Delete milestone"]') as HTMLButtonElement;
    expect(del).not.toBeNull();
    await act(async () => { del.click(); });
    await settle();
    expect(h.listCalls).toBeGreaterThan(before);
    expect(host.textContent).toMatch(/“Weld” was not deleted — you do not have the right to delete it .* Nothing was changed\./);
  });
});
