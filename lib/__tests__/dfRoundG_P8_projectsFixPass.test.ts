// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P8 PROJECTS — fix pass on the independent review:
//
//   * PROJ-6 (minor 3): the snapshot's open-drafting-requests count is the
//     WHOLE count only for a viewer who reads every request of the workspace;
//     a viewer under AUTHZ-13's Contractor-only scope (20261166) — or one
//     whose scope could not be confirmed — gets a count marked visible-only,
//     and the closeout gate never records "No open drafting requests" for it.
//   * PROJ-13 (minor 6): when "Create project from this request" made the
//     project but the link did not land, the Create button gives way to
//     "Link to <project>" — the same link, retried with converted:true — so
//     a second click never makes a second project naming the request.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  ticketCount: null as number | null,
  ticketErr: null as null | { code?: string; message: string },
  session: { user: { id: "u-1" } } as null | { user: { id: string } },
  memberErr: null as null | { message: string },
  fromCalls: [] as string[],
  convert: null as unknown,
  links: [] as Array<Record<string, unknown>>,
  linkResult: { ok: true, projectId: "p-new" } as Record<string, unknown>,
}));

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const eqs: Array<[string, unknown]> = [];
    const rows = () => (state.tables[table] ?? []).filter((r) => eqs.every(([k, v]) => r[k] === v));
    const settle = () => {
      if (table === "tickets") return Promise.resolve(state.ticketErr ? { data: null, error: state.ticketErr, count: null } : { data: [], error: null, count: state.ticketCount });
      return Promise.resolve({ data: rows(), error: null });
    };
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => settle().then(resolve, reject);
        return (...args: unknown[]) => {
          if (prop === "eq") eqs.push([String(args[0]), args[1]]);
          if (prop === "maybeSingle") {
            if (table === "org_members" && state.memberErr) return Promise.resolve({ data: null, error: state.memberErr });
            return Promise.resolve({ data: rows()[0] ?? null, error: null });
          }
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return {
    supabase: {
      from: (t: string) => { state.fromCalls.push(t); return chain(t); },
      auth: { getSession: async () => ({ data: { session: state.session } }) },
    },
  };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })), logCheckoutEvent: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined), notifyMany: vi.fn(async () => undefined) }));
vi.mock("@/lib/watches", () => ({ listFollowerIds: vi.fn(async () => []) }));
vi.mock("@/lib/ticketProjectClient", () => ({
  postProjectLink: vi.fn(async (input: Record<string, unknown>) => { state.links.push(input); return state.linkResult; }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true) }));

import { gatherProjectSnapshotUncached } from "@/lib/projectSnapshot";
import { closeoutGateLines } from "@/lib/projects";
import TicketProjectActions from "@/components/requests/TicketProjectActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  state.tables = {}; state.ticketCount = null; state.ticketErr = null; state.session = { user: { id: "u-1" } };
  state.memberErr = null; state.fromCalls = []; state.links = []; state.convert = null;
  state.linkResult = { ok: true, projectId: "p-new" };
});

describe("PROJ-6 fix pass — the open-requests gate says when it counted only what the completer can see", () => {
  const gate = async () => closeoutGateLines(await gatherProjectSnapshotUncached("o1", "p1")).find((g) => g.key === "draftingRequests");
  it("a completer who reads every request: the whole count, as before (0 → clear; 2 → still open)", async () => {
    state.tables.org_members = [{ org_id: "o1", uid: "u-1", role: "Manager", roles: ["Manager"] }];
    state.ticketCount = 0;
    expect(await gate()).toEqual({ key: "draftingRequests", ok: true, text: "No open drafting requests", openCount: 0 });
    state.ticketCount = 2;
    expect(await gate()).toMatchObject({ ok: false, text: "2 drafting requests still open", openCount: 2 });
  });
  it("a Contractor-only completer (AUTHZ-13's narrower scope): 0 visible is unknown, never 'No open drafting requests'", async () => {
    state.tables.org_members = [{ org_id: "o1", uid: "u-1", role: "Contractor", roles: ["Contractor"] }];
    state.ticketCount = 0;
    const snap = await gatherProjectSnapshotUncached("o1", "p1");
    expect(snap).toMatchObject({ openDraftingRequests: 0, openDraftingRequestsVisibleOnly: true });
    expect(await gate()).toMatchObject({ ok: null, text: "Drafting requests — only those visible to you counted (none of them open)" });
  });
  it("a scope that cannot be confirmed (member read refused, no session) is treated as visible-only — never a whole count it did not confirm", async () => {
    state.ticketCount = 0;
    state.memberErr = { message: "timeout" };
    expect((await gate())?.ok).toBeNull();
    state.memberErr = null;
    state.session = null;
    expect((await gate())?.ok).toBeNull();
  });
  it("before 20261256 (42703) no line and no scope read — today's dialog; a failed count reads nothing more", async () => {
    state.ticketErr = { code: "42703", message: "column tickets.project_id does not exist" };
    expect(await gate()).toBeUndefined();
    expect(state.fromCalls).not.toContain("org_members");
    state.ticketErr = { code: "57014", message: "timeout" };
    state.fromCalls = [];
    expect(await gate()).toMatchObject({ ok: null, text: "Drafting requests — could not be read" });
    expect(state.fromCalls).not.toContain("org_members");
    // fix pass 4 (review, minor): a 42703 / PGRST204 that does NOT name project_id is a read
    // failure, never "20261256 not pasted" — the line says it could not be read, never vanishes
    state.ticketErr = { code: "42703", message: 'column tickets.archived_at does not exist' };
    expect(await gate()).toMatchObject({ ok: null, text: "Drafting requests — could not be read" });
    state.ticketErr = { code: "PGRST204", message: "" };
    expect(await gate()).toMatchObject({ ok: null, text: "Drafting requests — could not be read" });
    state.ticketErr = { code: "PGRST204", message: "Could not find the 'project_id' column of 'tickets' in the schema cache" };
    expect(await gate()).toBeUndefined();
  });
});

vi.mock("@/lib/projects", async (orig) => ({
  ...(await orig<typeof import("@/lib/projects")>()),
  convertTicketToProject: vi.fn(async () => state.convert),
}));

describe("PROJ-13 fix pass — a created project whose link failed is linked, never created again", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = async () => {
    await act(async () => {
      root.render(React.createElement(TicketProjectActions, { ticketId: "t-1", orgId: "o1", linkedProjectId: null, canAct: true, actorUserId: "u-1" }));
    });
  };
  const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

  it("the link fails after the project is made: the Create button is replaced by 'Link to <project>', which retries the link (converted) — and gives way once it lands", async () => {
    state.convert = { project: { id: "p-new", name: "Flare header job" }, linked: false, linkError: "The request changed while you were acting — refresh and try again." };
    await render();
    await act(async () => { button("Create project from this request")!.click(); });
    expect(button("Create project from this request")).toBeUndefined();
    expect(button("Link to Flare header job")).toBeDefined();
    expect(host.textContent).toMatch(/do not create it again/);
    state.linkResult = { ok: false, status: 503, error: "Couldn't read the request — try again in a moment." };
    await act(async () => { button("Link to Flare header job")!.click(); });
    expect(state.links).toEqual([{ ticketId: "t-1", projectId: "p-new", converted: true }]);
    expect(button("Create project from this request")).toBeUndefined(); // still the retry
    state.linkResult = { ok: true, projectId: "p-new" };
    await act(async () => { button("Link to Flare header job")!.click(); });
    expect(state.links).toHaveLength(2);
    expect(host.textContent).toContain("Project created and linked.");
  });
  it("a create whose link lands shows no retry button (as before)", async () => {
    state.convert = { project: { id: "p-new", name: "Flare header job" }, linked: true };
    await render();
    await act(async () => { button("Create project from this request")!.click(); });
    expect(button("Link to Flare header job")).toBeUndefined();
    expect(host.textContent).toContain("Project created and linked.");
  });
});
