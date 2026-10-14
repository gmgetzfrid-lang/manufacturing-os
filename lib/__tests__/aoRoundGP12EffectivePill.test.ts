// @vitest-environment jsdom
//
// public-surfaces VFY-15 (admin-and-org Round G, P12 review fix, minor 2):
// the badge (EffectivePill) before the workspace's zone has loaded. The
// deployment's calendar can be AHEAD of the workspace's (a Perth deployment,
// a Chicago workspace), so deciding in it on first paint would leave "not
// yet in effect" off a revision that is not in force. While loading, the
// badge decides in the latest calendar (UTC-12) — it can only show a little
// longer, never drop early. Before 20261203 is recorded live the setting is
// not read and the deployment's calendar decides, exactly as before VFY-15.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const st = vi.hoisted(() => ({
  zones: {} as Record<string, string>,
  reads: 0,
  release: null as null | (() => void),
}));

// VFY-15 re-review: in the browser the decision is the server's
// (/api/workspace-effective-zone — it needs the audit trail to know who set
// the zone). The call is held until the test releases it.
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => { throw new Error("the browser no longer reads the setting itself"); },
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
  },
}));
const fetchCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  fetchCalls.push(`${url} ${(init?.headers as Record<string, string> | undefined)?.Authorization ?? ""}`);
  st.reads++;
  const org = new URL(url, "https://app").searchParams.get("orgId") ?? "";
  return new Promise<Response>((res) => {
    st.release = () => res(new Response(JSON.stringify(st.zones[org]
      ? { zone: st.zones[org], honoured: true, reconfirm: false, stored: null }
      : { zone: process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE, honoured: false, reconfirm: false, stored: null }), { status: 200 }));
  });
}) as typeof fetch;
vi.mock("@/lib/complianceNotify", () => ({ notifyCompliance: vi.fn(async () => true), loadScanRetryPlan: vi.fn(async () => ({ only: () => () => true })) }));
vi.mock("@/lib/ownership", () => ({ effectiveOwnerForDocument: vi.fn(async () => null), getOrgControllers: vi.fn(async () => []) }));

import EffectivePill from "@/components/documents/EffectivePill";
import { resetWorkspaceZoneCacheForTests } from "@/lib/effectiveDate";

// 2026-03-01T20:00:00Z: 2 March in Perth, 1 March in Chicago and in UTC-12.
const INSTANT = new Date("2026-03-01T20:00:00Z");
const EFFECTIVE = "2026-03-02";

let host: HTMLDivElement;
let root: Root;
const prev = { zone: process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE, gate: process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE };

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(INSTANT);
  st.zones = { chicago: "America/Chicago" }; st.reads = 0; st.release = null;
  resetWorkspaceZoneCacheForTests();
  process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "Australia/Perth";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  for (const [k, v] of [["NEXT_PUBLIC_FACILITY_TIME_ZONE", prev.zone], ["NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE", prev.gate]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const pill = () => host.textContent ?? "";

describe("VFY-15 review fix — the badge before the workspace zone loads", () => {
  it("a workspace west of the deployment: 'not yet in effect' is shown from the first paint, and stays once Chicago's zone loads", async () => {
    process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE = "20261203";
    await act(async () => { root.render(React.createElement(EffectivePill, { effectiveDate: EFFECTIVE, orgId: "chicago" })); });
    // loading: decided in UTC-12 (1 March) — pending, never dropped early as Perth's 2 March would
    expect(st.reads).toBe(1);
    expect(pill()).toContain(`Effective ${EFFECTIVE}`);
    await act(async () => { st.release!(); });
    expect(pill()).toContain(`Effective ${EFFECTIVE}`);
    // the server decides, asked with the caller's token
    expect(fetchCalls.at(-1)).toBe("/api/workspace-effective-zone?orgId=chicago Bearer tok");
  });

  it("the server says the stored zone is not shown to be an Admin's: the badge follows its deployment calendar (Perth: in effect, no badge)", async () => {
    process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE = "20261203";
    st.zones = {}; // the route answers honoured: false with the deployment's zone
    await act(async () => { root.render(React.createElement(EffectivePill, { effectiveDate: EFFECTIVE, orgId: "legacy" })); });
    expect(pill()).toContain(`Effective ${EFFECTIVE}`); // loading: UTC-12
    await act(async () => { st.release!(); });
    expect(pill()).toBe("");
  });

  it("a workspace whose zone is AHEAD (Perth): shown while loading (late is the safe side), gone once loaded", async () => {
    process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE = "20261203";
    process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
    st.zones = { perth: "Australia/Perth" };
    await act(async () => { root.render(React.createElement(EffectivePill, { effectiveDate: EFFECTIVE, orgId: "perth" })); });
    expect(pill()).toContain(`Effective ${EFFECTIVE}`);
    await act(async () => { st.release!(); });
    expect(pill()).toBe("");
  });

  it("before 20261203 is recorded live: the setting is not read and the deployment's calendar decides at once (Perth: in effect, no badge)", async () => {
    delete process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE;
    await act(async () => { root.render(React.createElement(EffectivePill, { effectiveDate: EFFECTIVE, orgId: "chicago" })); });
    expect(st.reads).toBe(0);
    expect(pill()).toBe("");
  });

  it("REGRESSION: no workspace given decides in the deployment's calendar, as before", async () => {
    process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE = "20261203";
    process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
    await act(async () => { root.render(React.createElement(EffectivePill, { effectiveDate: EFFECTIVE })); });
    expect(st.reads).toBe(0);
    expect(pill()).toContain(`Effective ${EFFECTIVE}`);
  });
});
