// @vitest-environment jsdom
// drafting-flow Round G, DF-P11 fix pass — projects-and-cost QUAL-14: the
// permissions explorer counts a personal grant that names a project as a
// grant ON THAT PROJECT (named), never as an org-wide "live personal grant".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

const s = vi.hoisted(() => ({
  policy: {} as Record<string, unknown>,
  projectQueries: [] as Array<{ ids: unknown }>,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    let ids: unknown = null;
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => void) => {
            if (table === "projects") {
              s.projectQueries.push({ ids });
              res({ data: [{ id: P1, name: "Unit 4 turnaround" }], error: null });
            } else res({ data: [], error: null });
          };
        }
        return (...args: unknown[]) => { if (prop === "in") ids = args[1]; return new Proxy(c, h); };
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ activeOrgId: "o1" }) }));
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<typeof import("@/lib/capabilityPolicy")>()),
  loadCapabilityPolicyEntry: vi.fn(async () => ({ policy: s.policy })),
  onCapabilityPolicyChanged: () => () => undefined,
}));

import PermissionsExplorer, { capabilityRow } from "@/components/permissions/PermissionsExplorer";
import { CAPABILITY_DEFS } from "@/lib/capabilityPolicy";

const QUALITY = CAPABILITY_DEFS.find((d) => d.id === "quality.sign_off")!;

describe("QUAL-14 (fix pass): capabilityRow splits project-scoped grants from org-wide ones", () => {
  it("a grant on one project is named as that project's, not counted as a live personal grant", () => {
    const row = capabilityRow(QUALITY, { grants: [{ cap: "quality.sign_off", uid: "u1", projectId: P1, expiresAt: null }] },
      { projectNames: new Map([[P1, "Unit 4 turnaround"]]) });
    expect(row.note).toContain("1 personal grant on project Unit 4 turnaround only");
    expect(row.note).not.toMatch(/live personal grant/);
  });
  it("org-wide and scoped grants are said separately; an unknown project shows its id; expired grants are not counted", () => {
    const row = capabilityRow(QUALITY, { grants: [
      { cap: "quality.sign_off", uid: "u1", expiresAt: null },
      { cap: "quality.sign_off", uid: "u2", projectId: P1, expiresAt: null },
      { cap: "quality.sign_off", uid: "u3", projectId: P2, expiresAt: null },
      { cap: "quality.sign_off", uid: "u4", projectId: P2, expiresAt: "2020-01-01T00:00:00Z" },
    ] }, { projectNames: new Map([[P1, "Unit 4 turnaround"]]) });
    expect(row.note).toContain("1 live personal grant");
    expect(row.note).toContain(`2 personal grants on projects Unit 4 turnaround, ${P2} only`);
  });
});

describe("QUAL-14 (fix pass): the rendered explorer names the project of a scoped grant", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    s.projectQueries = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("reads the scoped grants' project names and draws 'on project <name> only' on the Quality row", async () => {
    s.policy = { grants: [{ cap: "quality.sign_off", uid: "u1", projectId: P1, expiresAt: null }] };
    await act(async () => { root.render(React.createElement(PermissionsExplorer)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(s.projectQueries.some((q) => Array.isArray(q.ids) && (q.ids as string[]).includes(P1))).toBe(true);
    const text = host.textContent ?? "";
    expect(text).toContain("1 personal grant on project Unit 4 turnaround only");
    expect(text).not.toMatch(/1 live personal grant/);
  });
});
