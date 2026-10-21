// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P8 PROJECTS — fix pass 4 on the independent
// review: the project page's Drafting requests card, rendered.
//   * (major) who a request waits on: PENDING_REVIEW names the requester's
//     review (lib/ticketSla.ts waitingParty), or a routed review's open slots
//     — never the engineer;
//   * (minor) the header's open / closed figures are the project's totals
//     (exact counts), never only the newest PROJECT_REQUESTS_LIMIT rows shown;
//     a total that cannot be read is labelled as the newest-N view it is;
//   * (minor) the card hides itself only on a 42703 / PGRST204 that NAMES
//     project_id (isMissingProjectColumn); any other refusal is said.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Res = { data: unknown; error: { code?: string; message: string } | null; count?: number | null };
const state = vi.hoisted(() => ({
  list: { data: [], error: null, count: 0 } as Res,
  open: { data: null, error: null, count: 0 } as Res,
  queries: [] as Array<{ table: string; head: boolean; calls: Array<[string, unknown[]]> }>,
}));

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const q = { table, head: false, calls: [] as Array<[string, unknown[]]> };
    state.queries.push(q);
    const settle = (): Res => {
      if (table === "documents") return { data: [], error: null };
      return q.head ? state.open : state.list;
    };
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(settle()).then(resolve, reject);
        return (...args: unknown[]) => {
          q.calls.push([prop, args]);
          if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) q.head = true;
          return proxy;
        };
      },
    };
    const proxy: Record<string, unknown> = new Proxy({}, handler);
    return proxy;
  }
  return { supabase: { from: (t: string) => chain(t) } };
});

import ProjectRequestsCard, { PROJECT_REQUESTS_LIMIT } from "@/components/projects/ProjectRequestsCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (over: Record<string, unknown> = {}) => ({
  id: `t-${Math.random().toString(36).slice(2)}`, ticket_id: "KE-26-0042", title: "Re-route flare header", status: "DRAFTING",
  assigned_drafter_name: "Dana", assigned_engineer_name: "Eli", requester_name: "Rita", metadata: {}, created_at: "2026-10-21T09:00:00Z", ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.list = { data: [], error: null, count: 0 };
  state.open = { data: null, error: null, count: 0 };
  state.queries = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = async () => {
  await act(async () => { root.render(React.createElement(ProjectRequestsCard, { orgId: "o1", projectId: "p1" })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const holders = () => [...host.querySelectorAll('[data-testid="request-holder"]')].map((n) => n.textContent);
const countLine = () => host.querySelector('[data-testid="project-requests-count"]')?.textContent ?? null;

describe("fix pass 4 (major): who an open request waits on", () => {
  it("PENDING_REVIEW names the requester's review — never the engineer; a routed review names its open slots; drafting names the drafter", async () => {
    state.list = {
      data: [
        row({ status: "PENDING_REVIEW" }),
        row({ status: "PENDING_REVIEW", requester_name: null }),
        row({ status: "PENDING_REVIEW", metadata: { review_roster: { v: 1, slots: [
          { id: "a", kind: "quality", label: "QA", mode: "blocking", status: "open", primaries: ["u-qa"] },
          { id: "b", kind: "ops", label: "Ops", mode: "notify_only", status: "open", primaries: ["u-ops"] },
        ] } } }),
        row({ status: "DRAFTING" }),
      ],
      error: null, count: 4,
    };
    state.open = { data: null, error: null, count: 4 };
    await render();
    expect(holders()).toEqual(["Awaiting review from: Rita", "Awaiting the requester's review", "Awaiting routed review: QA", "Drafter: Dana"]);
    expect(host.textContent).not.toContain("Engineer: Eli");
  });
});

describe("fix pass 4 (minor): the header counts the project's totals, not only the rows shown", () => {
  it("260 linked requests, 30 of the oldest still open, 200 shown: the header reads the totals and says only the newest are listed", async () => {
    state.list = { data: Array.from({ length: PROJECT_REQUESTS_LIMIT }, () => row({ status: "CLOSED" })), error: null, count: 260 };
    state.open = { data: null, error: null, count: 30 };
    await render();
    expect(countLine()).toBe(`30 open · 230 closed · newest ${PROJECT_REQUESTS_LIMIT} shown`);
    // the open count is its own exact head query, filtered as the project's open requests
    const head = state.queries.find((q) => q.table === "tickets" && q.head)!;
    expect(head.calls).toEqual(expect.arrayContaining([
      ["eq", ["org_id", "o1"]], ["eq", ["project_id", "p1"]], ["is", ["archived_at", null]],
      ["not", ["status", "in", "(CLOSED,CANCELED)"]],
    ]));
    expect(head.calls.find(([m]) => m === "select")?.[1]).toEqual(["id", { count: "exact", head: true }]);
  });
  it("a total that cannot be read: the figures are labelled as the newest-N view, never presented as the project's totals", async () => {
    state.list = { data: Array.from({ length: PROJECT_REQUESTS_LIMIT }, (_, i) => row({ status: i < 12 ? "DRAFTING" : "CLOSED" })), error: null, count: 260 };
    state.open = { data: null, error: { code: "57014", message: "timeout" }, count: null };
    await render();
    expect(countLine()).toBe(`newest ${PROJECT_REQUESTS_LIMIT} shown — 12 open · ${PROJECT_REQUESTS_LIMIT - 12} closed of those shown`);
  });
  it("a short list (under the limit) reads exactly as before when the totals agree", async () => {
    state.list = { data: [row({ status: "DRAFTING" }), row({ status: "CLOSED" })], error: null, count: 2 };
    state.open = { data: null, error: null, count: 1 };
    await render();
    expect(countLine()).toBe("1 open · 1 closed");
  });
});

describe("fix pass 4 (minor): the card hides itself only when project_id itself is missing", () => {
  it("42703 naming project_id: nothing rendered (20261256 not pasted — today's page)", async () => {
    state.list = { data: null, error: { code: "42703", message: 'column tickets.project_id does not exist' }, count: null };
    await render();
    expect(host.querySelector('[data-testid="project-requests"]')).toBeNull();
  });
  it("42703 naming another column, or PGRST204 naming none: the card says the read failed — never silently gone", async () => {
    state.list = { data: null, error: { code: "42703", message: 'column tickets.assigned_engineer_name does not exist' }, count: null };
    await render();
    expect(host.querySelector('[data-testid="project-requests"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/could not be read/);
    act(() => root.unmount());
    root = createRoot(host);
    state.list = { data: null, error: { code: "PGRST204", message: "" }, count: null };
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/could not be read/);
  });
});
