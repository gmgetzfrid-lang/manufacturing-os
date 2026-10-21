// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P8 PROJECTS — fix pass 2 on the independent
// review (minor 4): "Create project from this request" runs the REAL
// lib/projects.ts convertTicketToProject. Once createProject has made the
// project, nothing after it throws: a refused requester-membership row is
// said (linkWarning), the project is returned, and the request page offers
// "Link to <project>" — never the Create button again, so a second click
// never makes a second project naming the same request.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const state = vi.hoisted(() => ({
  projectInserts: [] as Array<Record<string, unknown>>,
  memberUpserts: [] as Array<Record<string, unknown>>,
  memberUpsertError: null as null | { code?: string; message: string },
  links: [] as Array<Record<string, unknown>>,
  linkResult: { ok: false, status: 409, error: "The request changed while you were acting — refresh and try again." } as Record<string, unknown>,
}));

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    let op: { kind: string; payload?: Record<string, unknown> } = { kind: "select" };
    const settle = () => {
      if (table === "tickets") {
        return { data: { id: "t-1", ticket_id: "KE-26-0042", title: "Flare header job", description: "Re-route", request_type: "Revision", requester_id: "u-req", requester_name: "Req" }, error: null };
      }
      if (table === "projects" && op.kind === "insert") return { data: { ...op.payload, id: `p-new-${state.projectInserts.length}` }, error: null };
      if (table === "project_members" && op.kind === "upsert") return { data: null, error: state.memberUpsertError };
      return { data: null, error: null };
    };
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(settle()).then(resolve, reject);
        return (...args: unknown[]) => {
          if (prop === "insert" || prop === "upsert") {
            op = { kind: prop, payload: args[0] as Record<string, unknown> };
            if (table === "projects") state.projectInserts.push(op.payload!);
            if (table === "project_members" && prop === "upsert") state.memberUpserts.push(op.payload!);
          }
          if (prop === "single" || prop === "maybeSingle") return Promise.resolve(settle());
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: { access_token: "tok", user: { id: "u-1" } } } }) } } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })), logCheckoutEvent: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined), notifyMany: vi.fn(async () => undefined), notifyBatchChecked: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/watches", () => ({ listFollowerIds: vi.fn(async () => []) }));
vi.mock("@/lib/ticketProjectClient", () => ({
  postProjectLink: vi.fn(async (input: Record<string, unknown>) => { state.links.push(input); return state.linkResult; }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true) }));

import TicketProjectActions from "@/components/requests/TicketProjectActions";
import { convertTicketToProject } from "@/lib/projects";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.projectInserts = []; state.memberUpserts = []; state.links = [];
  state.memberUpsertError = { code: "42501", message: "new row violates row-level security policy for table \"project_members\"" };
  state.linkResult = { ok: false, status: 409, error: "The request changed while you were acting — refresh and try again." };
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

describe("PROJ-13 fix pass 2 — convertTicketToProject never throws once the project exists", () => {
  it("the requester's member row is refused AND the link fails: the project is returned (never thrown), the Create button gives way to 'Link to <project>', and the retry links — no second project", async () => {
    await render();
    await act(async () => { button("Create project from this request")!.click(); });
    expect(state.projectInserts).toHaveLength(1);
    expect(state.memberUpserts).toHaveLength(1); // the refused requester-membership step ran
    expect(button("Create project from this request")).toBeUndefined();
    expect(button("Link to Flare header job")).toBeDefined();
    expect(host.textContent).toMatch(/do not create it again/);
    expect(host.textContent).toMatch(/requester was not added to the project's members/);
    state.linkResult = { ok: true, projectId: "p-new-1" };
    await act(async () => { button("Link to Flare header job")!.click(); });
    expect(state.links.map((l) => l.converted)).toEqual([true, true]);
    expect(state.projectInserts).toHaveLength(1); // never created again
    expect(host.textContent).toContain("Project created and linked.");
  });
  it("a refused member row with a link that lands: linked, and the refusal is said as a warning (not an error)", async () => {
    state.linkResult = { ok: true, projectId: "p-new-1" };
    const r = await convertTicketToProject({ ticketId: "t-1", orgId: "o1", actorUserId: "u-1" });
    expect(r.linked).toBe(true);
    expect(r.project.id).toBe("p-new-1");
    expect(r.linkWarning).toMatch(/requester was not added to the project's members/);
  });
  it("REGRESSION: the member row lands — no warning; the actor who is the requester adds no member row", async () => {
    state.memberUpsertError = null;
    state.linkResult = { ok: true, projectId: "p-new-1" };
    const r = await convertTicketToProject({ ticketId: "t-1", orgId: "o1", actorUserId: "u-1" });
    expect(r).toMatchObject({ linked: true });
    expect(r.linkWarning).toBeUndefined();
    state.memberUpserts = [];
    await convertTicketToProject({ ticketId: "t-1", orgId: "o1", actorUserId: "u-req" });
    expect(state.memberUpserts).toEqual([]);
  });
});
