// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P11 fix pass 2 — HAND-2: the hold's own opener is
// a TOKEN on holds.release ("$opener", HOLD_OPENER_TOKEN), so an Admin decides
// it in the grid like any role. RENDERED: the editor shows it as its own
// labelled checkbox on the "Release a hold" row (never as an unexplained
// "also stored" token), ticked under the shipped default and unticked for a
// stored "only Admins" list; unticking it saves a list without it.
//
// Fix pass 3: a row equal to its shipped default is not written on save (it
// used to be, for every capability, which froze holds.release at the old
// ["*"] in every workspace that ever saved the grid); a holds.release row
// still exactly ["*"] is named on the row as the old default, with a "Use
// the shipped default" action that is saved like any other change.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => {
  const db = { tables: {} as Record<string, Array<Record<string, unknown>>> };
  function table(name: string) {
    const filters: Array<[string, unknown]> = [];
    const run = () => ({ data: (db.tables[name] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)).map((r) => ({ ...r })), error: null });
    const q: Record<string, unknown> = {
      select() { return q; },
      eq(k: string, v: unknown) { filters.push([k, v]); return q; },
      order() { return q; },
      maybeSingle() { const out = run(); return Promise.resolve({ data: out.data[0] ?? null, error: null }); },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    return q;
  }
  return { db, table, fetchCalls: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => h.table(t),
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
  },
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "o1", uid: "a1", userEmail: "a@x", roles: ["Admin"], hasAnyRole: (rs: string[]) => rs.includes("Admin") }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true) }));
vi.mock("@/lib/requestTypes", () => ({ loadRequestTypeOptions: vi.fn(async () => []) }));

import { __resetCapabilityPolicyCache, HOLD_OPENER_TOKEN, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import CapabilityPolicyEditor, { tokensOutsideGrid, joinPolicyFromEditor, splitPolicyForEditor, holdsReleaseOnOldDefault } from "@/components/permissions/CapabilityPolicyEditor";
import { CAPABILITY_DEFS, policyAllows } from "@/lib/capabilityPolicy";

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const policyRow = (caps: CapabilityPolicy["caps"]): Row =>
  ({ org_id: "o1", key: "capability_policy", data: { caps, grants: [] }, updated_at: "2026-10-01T00:00:00+00:00" });
const openerBox = () => host.querySelector('input[aria-label="The hold\'s own opener may release or re-date it"]') as HTMLInputElement | null;
const releaseRow = () => [...host.querySelectorAll("tr")].find((r) => r.querySelector("td")?.textContent?.startsWith("Release a hold"))!;
const mount = async () => { await act(async () => { root.render(React.createElement(CapabilityPolicyEditor, { canEdit: true })); }); await flush(); };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  __resetCapabilityPolicyCache();
  h.db.tables = {};
  h.fetchCalls = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    h.fetchCalls.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ ok: true, policy: {}, version: "2026-10-07T00:00:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as never;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("HAND-2 fix pass 2 — the opener token in the permissions grid", () => {
  it("tokensOutsideGrid never lists the opener token (it has its own control)", () => {
    expect(tokensOutsideGrid(["Admin", HOLD_OPENER_TOKEN, "Engineer-2"])).toEqual(["Engineer-2"]);
  });

  it("the shipped default: the opener box is ticked on the Release-a-hold row, and no 'also stored' token is shown there", async () => {
    h.db.tables.org_configurations = [];
    await mount();
    expect(openerBox()).not.toBeNull();
    expect(openerBox()!.checked).toBe(true);
    expect(releaseRow().contains(openerBox())).toBe(true);
    expect(releaseRow().textContent).not.toContain("Also stored");
    expect(releaseRow().textContent).not.toContain("$opener");
  });

  it("a stored 'only Admins' list shows it unticked; ticking it and saving stores the token", async () => {
    h.db.tables.org_configurations = [policyRow({ "holds.release": ["Admin"] })];
    await mount();
    expect(openerBox()!.checked).toBe(false);
    await act(async () => { openerBox()!.click(); });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /Save policy/.test(b.textContent ?? ""))!.click(); });
    await flush();
    expect(h.fetchCalls).toHaveLength(1);
    expect((h.fetchCalls[0].caps as Record<string, unknown>)["holds.release"]).toEqual(["Admin", HOLD_OPENER_TOKEN]);
  });

  it("unticking it under the default saves a list without it — controller-only release", async () => {
    h.db.tables.org_configurations = [];
    await mount();
    await act(async () => { openerBox()!.click(); });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /Save policy/.test(b.textContent ?? ""))!.click(); });
    await flush();
    expect((h.fetchCalls[0].caps as Record<string, unknown>)["holds.release"]).toEqual(["Admin", "DocCtrl"]);
  });
});

const saveBtn = () => [...host.querySelectorAll("button")].find((b) => /Save policy/.test(b.textContent ?? ""))!;

describe("HAND-2 fix pass 3 — a save no longer freezes shipped defaults; the old [\"*\"] is named", () => {
  it("joinPolicyFromEditor leaves out every row that equals its shipped default (as a set), and keeps every other row", () => {
    const s = splitPolicyForEditor({ caps: { "ticket.assign": ["Admin"], "holds.release": ["*"] } });
    const j = joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides);
    expect(Object.keys(j).sort()).toEqual(["holds.release", "ticket.assign"]);
    expect(j["holds.release"]).toEqual(["*"]);
    // the same answers as a policy that wrote every row out
    const full = Object.fromEntries(CAPABILITY_DEFS.map((d) => [d.id, s.base[d.id]]));
    for (const d of CAPABILITY_DEFS) {
      for (const role of ["Admin", "DocCtrl", "Manager", "Drafter", "Viewer"]) {
        expect(policyAllows({ caps: j }, d.id, role, null, "u"), `${d.id}/${role}`).toBe(policyAllows({ caps: full }, d.id, role, null, "u"));
      }
    }
    // a reordered default is still the default
    const r = splitPolicyForEditor({ caps: { "holds.release": ["$opener", "DocCtrl", "Admin"] } });
    expect(joinPolicyFromEditor(r.base, r.overrides, r.opaque, r.projectOverrides)["holds.release"]).toBeUndefined();
    expect(holdsReleaseOnOldDefault(["*"])).toBe(true);
    expect(holdsReleaseOnOldDefault(["*", "Admin"])).toBe(false);
    expect(holdsReleaseOnOldDefault(undefined)).toBe(false);
  });

  it("changing one row saves only that row — holds.release is not written, so the shipped default (Admin, DocCtrl, the opener) holds", async () => {
    h.db.tables.org_configurations = [];
    await mount();
    expect(host.querySelector('[data-testid="holds-release-old-default"]')).toBeNull();
    const assignRow = [...host.querySelectorAll("tr")].find((r) => r.querySelector("td")?.textContent?.startsWith("Assign drafters"))!;
    const cells = [...assignRow.querySelectorAll("td button")] as HTMLButtonElement[];
    await act(async () => { cells.find((b) => !b.disabled)!.click(); });
    await act(async () => { saveBtn().click(); });
    await flush();
    expect(h.fetchCalls).toHaveLength(1);
    const caps = h.fetchCalls[0].caps as Record<string, unknown>;
    expect(Object.keys(caps)).toEqual(["ticket.assign"]);
    expect("holds.release" in caps).toBe(false);
  });

  it("a stored holds.release of exactly [\"*\"] is named on the row as the old default; it is kept on an unrelated save; \"Use the shipped default\" saves it away", async () => {
    h.db.tables.org_configurations = [policyRow({ "holds.release": ["*"], "ticket.assign": ["Admin", "Manager", "Supervisor"] })];
    await mount();
    const note = host.querySelector('[data-testid="holds-release-old-default"]');
    expect(note).not.toBeNull();
    expect(releaseRow().contains(note)).toBe(true);
    expect(note!.textContent).toContain("old default");
    // the note decides nothing by itself: an unrelated save keeps ["*"]
    const assignRow = [...host.querySelectorAll("tr")].find((r) => r.querySelector("td")?.textContent?.startsWith("Assign drafters"))!;
    const cells = [...assignRow.querySelectorAll("td button")] as HTMLButtonElement[];
    await act(async () => { cells.find((b) => !b.disabled)!.click(); });
    await act(async () => { saveBtn().click(); });
    await flush();
    expect((h.fetchCalls[0].caps as Record<string, unknown>)["holds.release"]).toEqual(["*"]);
    // the Admin adopts the shipped default: the row is no longer written
    const adopt = [...note!.querySelectorAll("button")].find((b) => /Use the shipped default/.test(b.textContent ?? ""))!;
    await act(async () => { adopt.click(); });
    expect(host.querySelector('[data-testid="holds-release-old-default"]')).toBeNull();
    expect(openerBox()!.checked).toBe(true);
    await act(async () => { saveBtn().click(); });
    await flush();
    expect(h.fetchCalls).toHaveLength(2);
    expect("holds.release" in (h.fetchCalls[1].caps as Record<string, unknown>)).toBe(false);
  });
});
