// @vitest-environment jsdom
//
// projects Round G — J14 PROJECTS FOLLOW-UPS, projects-tab PERF-5 (done-when
// 1 on a slow CPU): each change of the drag's day offset re-rendered every
// windowed Bar and OutlineRow (plain components handed fresh inline
// closures) and rebuilt the dependency arrows' geometry (a plain function
// component — a parent re-render re-ran it whatever its props). Bar,
// OutlineRow and DependencyArrows are React.memo'd now, and every row gets
// stable handlers (one object per task id, calling the board's latest
// callbacks through a ref), so a drag frame re-renders the dragged bar only.
//
// Counted, not timed: the work a component does per render is observed
// through two pure helpers it calls on every render — Bar and OutlineRow ask
// `isImportedMilestone` of their task, and the arrows ask
// `resolveVisibleDepIndex` for every task and link. Before the change one
// drag frame on the 400-task board below called the first 80 times (40
// windowed outline rows + 40 bars) and re-ran the second over every task;
// now once (the dragged bar) and never — checked by running this file
// against the board before the change (80 > 1, the assertion fails).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const spy = vi.hoisted(() => ({ imported: 0, deps: 0 }));
vi.mock("@/lib/supabase", () => {
  const chain: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return () => chain;
    },
  });
  return { supabase: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(), logMilestoneEvent: vi.fn() }));
vi.mock("@/lib/projects", () => ({ listMembers: vi.fn(async () => []) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true), appAlert: vi.fn(), appPrompt: vi.fn() }));
const upd = vi.hoisted(() => ({ updateMilestone: vi.fn(async (_args: unknown) => undefined) }));
vi.mock("@/lib/milestones", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/milestones")>()), updateMilestone: upd.updateMilestone, listMilestoneNotes: vi.fn(async () => []) }));
vi.mock("@/lib/milestoneLiveness", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/milestoneLiveness")>();
  return { ...real, isImportedMilestone: (...a: Parameters<typeof real.isImportedMilestone>) => { spy.imported++; return real.isImportedMilestone(...a); } };
});
vi.mock("@/lib/scheduleDeps", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/scheduleDeps")>();
  return { ...real, resolveVisibleDepIndex: (...a: Parameters<typeof real.resolveVisibleDepIndex>) => { spy.deps++; return real.resolveVisibleDepIndex(...a); } };
});

import ExecutionView from "@/components/projects/ExecutionView";
import TaskDetailPanel, { matchPredecessors, PREDECESSOR_PICKER_LIMIT } from "@/components/projects/TaskDetailPanel";
import type { Milestone } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class RO { observe() {} disconnect() {} unobserve() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); spy.imported = 0; spy.deps = 0; });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const mk = (o: Partial<Milestone>): Milestone => ({
  orgId: "o", projectId: "p", name: "t", weight: 1, plannedAt: "2026-03-10T00:00:00Z",
  status: "planned", source: "manual", createdBy: "u", dependsOn: [], ...o,
});
// 400 tasks, every third linked to the one before it (≈130 links).
const many = Array.from({ length: 400 }, (_, i) => mk({
  id: `t${i}`, name: `Task ${i}`,
  plannedStartAt: `2026-03-${String(1 + (i % 20)).padStart(2, "0")}T00:00:00Z`,
  plannedAt: `2026-03-${String(2 + (i % 20)).padStart(2, "0")}T00:00:00Z`,
  dependsOn: i > 0 && i % 3 === 0 ? [`t${i - 1}`] : [],
}));
const onMoveMany = vi.fn(async () => ({ ok: true }));
async function renderBoard() {
  await act(async () => {
    root.render(React.createElement(ExecutionView, {
      milestones: many, canEdit: true, orgId: "o", projectId: "p", userId: "u",
      onRefresh: () => undefined, onMoveMany, onSetStatus: async () => true, onSetProgress: async () => true,
    }));
  });
  await act(async () => { await Promise.resolve(); });
}
const barOf = (name: string) => [...host.querySelectorAll<HTMLElement>(".cursor-grab")].find((el) => (el.getAttribute("title") ?? "").startsWith(`${name}\n`))!;
const fire = async (el: Element, type: string, clientX: number) => {
  await act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 })); });
};

describe("PERF-5 (J14) — a change of the drag's day offset re-renders the dragged bar only", () => {
  it("one drag frame: no outline row, no other bar and no arrow geometry is recomputed; the bar still moves and the move still asks to be confirmed", async () => {
    await renderBoard();
    const bar = barOf("Task 20");
    expect(bar).toBeTruthy();
    const windowed = host.querySelectorAll('[id^="exec-row-"]').length;
    expect(windowed).toBeGreaterThan(10);

    await fire(bar, "pointerdown", 100);
    await fire(bar, "pointermove", 100 + 400);   // the first frame of the drag
    spy.imported = 0; spy.deps = 0;
    await fire(bar, "pointermove", 100 + 1600);   // another day offset: one frame
    // The dragged bar re-rendered (its title carries the live offset)…
    expect(barOf("Task 20").getAttribute("title")).toMatch(/\nmove \+\d+d/);
    // …and nothing else did: the bar's own render asks once; no outline row
    // asks, no other bar asks, and the arrows are not rebuilt.
    expect(spy.imported).toBeLessThanOrEqual(1);
    expect(spy.deps).toBe(0);

    // Releasing still hands the move to the confirmation sheet (unchanged).
    await fire(barOf("Task 20"), "pointerup", 100 + 1600);
    expect(host.textContent).toMatch(/Move “Task 20” \d+ days later/);
    // (J14 fix pass) a 400-task board under a loaded host can pass the 5 s default; the counts, not the clock, are the test
  }, 30_000);

  it("data that changes still re-renders: a status change re-draws its row (the memo never holds a stale row)", async () => {
    await renderBoard();
    const before = host.querySelector("#exec-row-t20")?.textContent;
    await act(async () => {
      root.render(React.createElement(ExecutionView, {
        milestones: many.map((m) => (m.id === "t20" ? { ...m, name: "Task 20 renamed" } : m)), canEdit: true, orgId: "o", projectId: "p", userId: "u",
        onRefresh: () => undefined, onMoveMany, onSetStatus: async () => true, onSetProgress: async () => true,
      }));
    });
    await act(async () => { await Promise.resolve(); });
    const after = host.querySelector("#exec-row-t20")?.textContent;
    expect(before).toContain("Task 20");
    expect(after).toContain("Task 20 renamed");
  });
});

// PERF-5 remediation 4 (J14): the dependency picker was a <select> of every
// task (a 5,000-task schedule drew 5,000 <option>s on opening the panel). It
// is a search box now: at most PREDECESSOR_PICKER_LIMIT matches are drawn,
// the rest counted; the candidates are unchanged (no cycle, not already a
// dependency, never the task itself — SCH-9's test pins those).
describe("PERF-5 remediation 4 (J14) — a searchable dependency picker that never draws every task", () => {
  const panel = (m: Milestone, all: Milestone[]) => React.createElement(TaskDetailPanel, {
    milestone: m, subtasks: [], allTasks: all, childCount: () => 0,
    canEdit: true, userId: "u", onClose: () => undefined, onChanged: () => undefined,
  });
  const type = async (el: HTMLInputElement, v: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  it("400 tasks: no <select> of tasks; the open picker draws 20 and counts the rest; a word narrows it; picking saves the link", async () => {
    upd.updateMilestone.mockClear();
    await act(async () => { root.render(panel(many[0], many)); });
    await act(async () => { await Promise.resolve(); });
    expect([...host.querySelectorAll("option")].some((o) => /^Task \d+/.test(o.textContent ?? ""))).toBe(false);
    const search = host.querySelector('input[aria-label^="Add a predecessor"]') as HTMLInputElement;
    expect(host.querySelector('[data-testid="dep-candidates"]')).toBeNull();   // closed until asked
    await act(async () => { search.focus(); });
    const drawn = () => [...host.querySelectorAll('[data-testid="dep-candidates"] [role="option"]')].map((b) => b.textContent);
    expect(drawn()).toHaveLength(PREDECESSOR_PICKER_LIMIT);
    expect(host.textContent).toMatch(/Showing 20 of 399 — type to narrow\./);
    await type(search, "task 39");
    // Every word is a substring match: "39" also finds 139, 239 and 339.
    expect(drawn().sort()).toEqual(["Task 39", "Task 139", "Task 239", "Task 339", "Task 390", "Task 391", "Task 392", "Task 393", "Task 394", "Task 395", "Task 396", "Task 397", "Task 398", "Task 399"].sort());
    expect(host.textContent).toMatch(/14 tasks\./);
    const pick = [...host.querySelectorAll<HTMLElement>('[data-testid="dep-candidates"] [role="option"]')].find((b) => b.textContent === "Task 391")!;
    await act(async () => { pick.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(upd.updateMilestone).toHaveBeenCalledWith({ id: "t0", patch: { dependsOn: ["t391"] }, updatedBy: "u" });
  });
  it("(J14 last review) tabbing in and pressing Enter writes nothing: with no active option Enter picks nothing (an empty query, a typed one, even a single match) — only an option ArrowDown highlighted is accepted", async () => {
    upd.updateMilestone.mockClear();
    await act(async () => { root.render(panel(many[0], many)); });
    await act(async () => { await Promise.resolve(); });
    const search = host.querySelector('input[aria-label^="Add a predecessor"]') as HTMLInputElement;
    const enter = async () => {
      const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      await act(async () => { search.dispatchEvent(ev); });
      await act(async () => { await Promise.resolve(); });
      return ev;
    };
    // just focused: the list opens on focus, nothing is active — Enter writes nothing
    await act(async () => { search.focus(); });
    expect(host.querySelectorAll('[role="listbox"] > [role="option"]').length).toBe(PREDECESSOR_PICKER_LIMIT);
    expect(search.getAttribute("aria-activedescendant")).toBeNull();
    await enter();
    expect(upd.updateMilestone).not.toHaveBeenCalled();
    // closed by Escape, Enter re-opens the list and still writes nothing
    await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(search.getAttribute("aria-expanded")).toBe("false");
    await enter();
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(upd.updateMilestone).not.toHaveBeenCalled();
    // a typed query, many matches or exactly one: no active option, nothing written
    await type(search, "Task 7");
    await enter();
    await type(search, "Task 399");
    expect(host.querySelectorAll('[role="listbox"] > [role="option"]').length).toBe(1);
    await enter();
    expect(upd.updateMilestone).not.toHaveBeenCalled();
  });
  it("ArrowDown then Enter takes the first match; a word that matches nothing says so", async () => {
    upd.updateMilestone.mockClear();
    await act(async () => { root.render(panel(many[0], many)); });
    await act(async () => { await Promise.resolve(); });
    const search = host.querySelector('input[aria-label^="Add a predecessor"]') as HTMLInputElement;
    await act(async () => { search.focus(); });
    await type(search, "zzz");
    expect(host.textContent).toContain("No task matches — try another word.");
    await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(upd.updateMilestone).not.toHaveBeenCalled();
    await type(search, "Task 7");
    await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(upd.updateMilestone).toHaveBeenCalledTimes(1);
    const first = matchPredecessors(many.filter((t) => t.id !== "t0").sort((a, b) => (Date.parse(a.plannedAt as string) - Date.parse(b.plannedAt as string)) || a.name.localeCompare(b.name)), "Task 7")[0];
    expect(upd.updateMilestone.mock.calls[0][0]).toEqual({ id: "t0", patch: { dependsOn: [first.id] }, updatedBy: "u" });
  });
  it("(J14 fix pass, A11Y) the ARIA 1.2 combobox: the input is a combobox that owns a listbox of options; ArrowDown / ArrowUp / Home / End move the active option (aria-activedescendant, aria-selected) and Enter picks it; Escape closes", async () => {
    upd.updateMilestone.mockClear();
    await act(async () => { root.render(panel(many[0], many)); });
    await act(async () => { await Promise.resolve(); });
    const search = host.querySelector('input[aria-label^="Add a predecessor"]') as HTMLInputElement;
    const key = async (k: string) => { await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); };
    const listbox = () => host.querySelector('[role="listbox"]') as HTMLElement | null;
    const opts = () => [...host.querySelectorAll<HTMLElement>('[role="listbox"] > [role="option"]')];
    const activeOpt = () => { const id = search.getAttribute("aria-activedescendant"); return id ? document.getElementById(id) : null; };
    // closed: a combobox, collapsed, no active option; no buttons pose as options
    expect(search.getAttribute("role")).toBe("combobox");
    expect(search.getAttribute("aria-autocomplete")).toBe("list");
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(search.getAttribute("aria-activedescendant")).toBeNull();
    // open: expanded, aria-controls names the listbox, every match an option, none selected yet
    await act(async () => { search.focus(); });
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(listbox()).not.toBeNull();
    expect(search.getAttribute("aria-controls")).toBe(listbox()!.id);
    expect(opts()).toHaveLength(PREDECESSOR_PICKER_LIMIT);
    expect(listbox()!.querySelectorAll("button")).toHaveLength(0);
    expect(opts().every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    await type(search, "task 39");
    expect(opts()).toHaveLength(14);
    // ArrowDown: the first option is active and selected; again: the second
    await key("ArrowDown");
    expect(activeOpt()).toBe(opts()[0]);
    expect(opts()[0].getAttribute("aria-selected")).toBe("true");
    await key("ArrowDown");
    expect(activeOpt()).toBe(opts()[1]);
    expect(opts().filter((o) => o.getAttribute("aria-selected") === "true")).toEqual([opts()[1]]);
    // End / Home / ArrowUp, clamped at the ends
    await key("End");
    expect(activeOpt()).toBe(opts()[13]);
    await key("ArrowDown");
    expect(activeOpt()).toBe(opts()[13]);
    await key("Home");
    expect(activeOpt()).toBe(opts()[0]);
    await key("ArrowUp");
    expect(activeOpt()).toBe(opts()[0]);
    await key("ArrowDown"); await key("ArrowDown");
    const chosen = activeOpt()!.textContent;
    expect(chosen).toBe(opts()[2].textContent);
    // Enter picks the ACTIVE option, not the first match
    await key("Enter");
    await act(async () => { await Promise.resolve(); });
    expect(upd.updateMilestone).toHaveBeenCalledTimes(1);
    const picked = (upd.updateMilestone.mock.calls[0][0] as { patch: { dependsOn: string[] } }).patch.dependsOn[0];
    expect(many.find((t) => t.id === picked)?.name).toBe(chosen);
    // typing resets the active option; Escape closes and collapses
    await act(async () => { search.focus(); });
    await type(search, "task 1");
    await key("ArrowDown");
    expect(activeOpt()).not.toBeNull();
    await type(search, "task 12");
    expect(search.getAttribute("aria-activedescendant")).toBeNull();
    await key("Escape");
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(listbox()).toBeNull();
    // closed, ArrowDown opens it on the first option
    await key("ArrowDown");
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(activeOpt()).toBe(opts()[0]);
  });
  it("(J14 fix pass) a press on an option keeps the input focused, so the list is not closed under the click", async () => {
    await act(async () => { root.render(panel(many[0], many)); });
    await act(async () => { await Promise.resolve(); });
    const search = host.querySelector('input[aria-label^="Add a predecessor"]') as HTMLInputElement;
    await act(async () => { search.focus(); });
    const opt = host.querySelector<HTMLElement>('[role="listbox"] > [role="option"]')!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    opt.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });
  it("matchPredecessors: every word, case aside; an empty query is every candidate, in order", () => {
    const c = [mk({ id: "a", name: "Hydrotest loop 4" }), mk({ id: "b", name: "Fit-up loop 4" }), mk({ id: "c", name: "Hydrotest loop 5" })];
    expect(matchPredecessors(c, "").map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(matchPredecessors(c, "LOOP 4").map((t) => t.id)).toEqual(["a", "b"]);
    expect(matchPredecessors(c, "hydro 5").map((t) => t.id)).toEqual(["c"]);
  });
});
