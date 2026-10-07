// @vitest-environment jsdom
//
// admin-and-org Round G — package P9 (permissions console truth), RENDERED:
// the three console components with the real capability-policy module, over a
// PostgREST stand-in.
//
//   ViewAsSimulator   ORG-10 dw3 — team-derived access shows (and the team
//                     read is scoped to the active org); ALOG-1 dw2 — an
//                     unreadable policy is said and no grant is offered;
//                     ORG-14 — quality sign-off for a controller, the owner,
//                     a project-scoped grantee and an ungranted member;
//                     DACL-5 — the picker names the whole collection.
//   CapabilityPolicyEditor  ALOG-1 — an unreadable policy is said, no grid, no
//                     Save; ALOG-12 — the save carries the loaded version; a
//                     409 policy_changed retries when only grants moved and
//                     shows the other admin's grid otherwise; ALOG-9 — a stored
//                     token with no column is named; QUAL-14 — a project rule
//                     is listed by project name and saved as a projectId rule.
//   PermissionsExplorer  ALOG-14 — derived and snapshot sections, labelled; an
//                     unreadable policy shows the defaults LABELLED as such.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => {
  const db = {
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    readError: {} as Record<string, { message: string } | undefined>,
    reads: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  };
  function table(name: string) {
    const filters: Array<[string, unknown]> = [];
    let cols: string[] | null = null;
    const run = () => {
      db.reads.push({ table: name, filters: [...filters] });
      if (db.readError[name]) return { data: null, error: db.readError[name] };
      const hit = (db.tables[name] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
      return { data: hit.map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r })), error: null };
    };
    const q: Record<string, unknown> = {
      select(c?: string) { cols = c && c.trim() !== "*" ? c.split(",").map((x) => x.trim()) : null; return q; },
      eq(k: string, v: unknown) { filters.push([k, v]); return q; },
      order() { return q; },
      maybeSingle() { const out = run(); return Promise.resolve({ data: (out.data as unknown[] | null)?.[0] ?? null, error: out.error }); },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    return q;
  }
  const role = { activeOrgId: "o1", uid: "a1", userEmail: "a@x", roles: ["Admin"] as string[] };
  return {
    db, table, role, fetchCalls: [] as Array<Record<string, unknown>>, fetchReplies: [] as Array<{ status: number; body: Record<string, unknown> }>,
    /** the answer to every supabase.rpc call (ORG-14: the 20261136 probe) */
    rpc: { data: null as unknown, error: null as null | { message: string; code?: string } },
    rpcCalls: [] as string[],
  };
});

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => h.table(t),
    rpc: async (fn: string) => { h.rpcCalls.push(fn); return h.rpc; },
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
  },
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ ...h.role, hasAnyRole: (rs: string[]) => rs.some((r) => h.role.roles.includes(r)) }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true) }));
vi.mock("@/lib/requestTypes", () => ({ loadRequestTypeOptions: vi.fn(async () => []) }));

import { __resetCapabilityPolicyCache, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import ViewAsSimulator from "@/components/permissions/ViewAsSimulator";
import CapabilityPolicyEditor from "@/components/permissions/CapabilityPolicyEditor";
import PermissionsExplorer from "@/components/permissions/PermissionsExplorer";

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const text = () => host.textContent ?? "";
const select = (pred: (s: HTMLSelectElement) => boolean) => [...host.querySelectorAll("select")].find(pred) as HTMLSelectElement;
async function choose(sel: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(sel, value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}
const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
const policyRow = (caps: CapabilityPolicy["caps"], updated_at = "2026-10-01T00:00:00+00:00", grants: unknown[] = []): Row =>
  ({ org_id: "o1", key: "capability_policy", data: { caps, grants }, updated_at });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  __resetCapabilityPolicyCache();
  h.db.tables = {}; h.db.readError = {}; h.db.reads = [];
  h.fetchCalls = []; h.fetchReplies = [];
  h.role.roles = ["Admin"];
  h.rpc = { data: null, error: null }; h.rpcCalls = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    h.fetchCalls.push(JSON.parse(String(init?.body ?? "{}")));
    const r = h.fetchReplies.shift() ?? { status: 200, body: { ok: true, policy: {}, version: "2026-10-07T00:00:00.000Z" } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as never;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

// ═══════════════════════════════════════════════════════════════════════════
describe("ViewAsSimulator", () => {
  const members = [
    { org_id: "o1", uid: "adm", display_name: "Ada Admin", role: "Admin", roles: ["Admin"], status: "active" },
    { org_id: "o1", uid: "dc", display_name: "Dee Control", role: "Manager", roles: ["Manager", "DocCtrl"], status: "active" },
    { org_id: "o1", uid: "own", display_name: "Owen Owner", role: "Drafter", roles: ["Drafter"], status: "active" },
    { org_id: "o1", uid: "saf", display_name: "Sam Safety", role: "Requester", roles: ["Requester", "Safety"], status: "active" },
    { org_id: "o1", uid: "eng", display_name: "Eve Eng", role: "Engineer-2", roles: ["Engineer-2"], status: "active" },
  ];
  const seed = () => {
    h.db.tables = {
      org_members: members,
      libraries: [{ org_id: "o1", id: "L1", name: "As-Built", visibility: "private", owner_user_id: null, acl_index: null,
        acl: { rules: [{ effect: "allow", subject: { type: "team", id: "t1" }, actions: ["read", "discover"] },
                       { effect: "allow", subject: { type: "role", id: "Safety" }, actions: ["read"] }] } }],
      teams: [{ org_id: "o1", id: "t1", name: "Contract crew" }],
      team_members: [{ org_id: "o1", team_id: "t1", uid: "eng" }, { org_id: "o2", team_id: "tX", uid: "eng" }],
      projects: [{ org_id: "o1", id: "p1", name: "PSSR Unit 200", owner_user_id: "own", visibility: "public" },
                 { org_id: "o1", id: "p2", name: "Turnaround", owner_user_id: "adm", visibility: "public" }],
      project_members: [],
      org_configurations: [policyRow({ "quality.sign_off": [{ tokens: [] }, { tokens: ["Safety"], when: { projectId: ["p1"] } }] })],
    };
  };
  const mount = async (canEdit = true) => { await act(async () => { root.render(React.createElement(ViewAsSimulator, { canEdit })); }); await flush(); };
  const pickMember = async (uid: string) => choose(select((s) => [...s.options].some((o) => o.value === "adm")), uid);
  const pickProject = async (id: string) => choose(select((s) => [...s.options].some((o) => o.value === "p1")), id);
  const qualityOk = () => host.querySelector('[data-cap="quality.sign_off"]')?.getAttribute("data-ok");

  it("DACL-5: the picker names each member's whole role collection, not the headline alone", async () => {
    seed(); await mount();
    const opts = [...select((s) => [...s.options].some((o) => o.value === "dc")).options].map((o) => o.textContent);
    expect(opts).toContain("Dee Control — Manager, DocCtrl");
    expect(opts).toContain("Sam Safety — Requester, Safety");
  });

  it("ORG-10 done-when 3: a member whose only access is a team grant shows as SEEING the library; the team read is scoped to the active org", async () => {
    seed(); await mount();
    await pickMember("eng");
    const lib = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes("As-Built"))!;
    expect(lib.textContent).toContain("visible");
    const teamRead = h.db.reads.find((r) => r.table === "team_members")!;
    expect(teamRead.filters).toEqual([["uid", "eng"], ["org_id", "o1"]]);
    expect(text()).toContain("via team Contract crew"); // DACL-5: which team the rule reaches them by
    // …and without the team, the same member is walled off
    h.db.tables.team_members = [];
    await pickMember("own"); await pickMember("eng");
    const again = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes("As-Built"))!;
    expect(again.textContent).toContain("hidden");
  });

  it("ORG-10: a failed team read is said, never shown as 'no team access'", async () => {
    seed(); h.db.readError.team_members = { message: "timeout" };
    await mount(); await pickMember("eng");
    expect(text()).toContain("Team memberships could not be loaded (timeout)");
  });

  it("DACL-5: a role rule names the held role it matches", async () => {
    seed(); await mount(); await pickMember("saf");
    expect(text()).toContain("via their role Safety");
  });

  it("ORG-14: with no project picked, a controller (by the collection) holds sign-off; with a project, the owner and the project-scoped grantee do — on that project only", async () => {
    seed(); await mount();
    await pickMember("dc");
    expect(qualityOk()).toBe("yes"); // headline Manager, DocCtrl in the collection
    await pickMember("own");
    expect(qualityOk()).toBe("no");
    await pickProject("p1");
    expect(qualityOk()).toBe("yes");
    expect(text()).toContain("on PSSR Unit 200: they own the project");
    await pickMember("saf");
    expect(qualityOk()).toBe("yes");
    expect(text()).toContain("granted by the policy for this project");
    await pickProject("p2");
    expect(qualityOk()).toBe("no"); // the grant names p1, not p2
    await pickMember("eng");
    await pickProject("p1");
    expect(qualityOk()).toBe("no"); // ungranted
    await pickMember("adm");
    expect(qualityOk()).toBe("yes");
  });

  it("ORG-14 (review fix): with no project picked, a base-list holder is NOT told 'every project' when a project rule replaces the base list and excludes them", async () => {
    seed();
    h.db.tables.org_configurations = [policyRow({ "quality.sign_off": [{ tokens: ["Safety"] }, { tokens: ["Engineer"], when: { projectId: ["p1"] } }] })];
    await mount();
    await pickMember("saf");
    const li = () => host.querySelector('[data-cap="quality.sign_off"]')!.textContent ?? "";
    expect(qualityOk()).toBe("yes");
    expect(li()).toContain("granted where no project rule applies — not on PSSR Unit 200, whose project rule replaces the base list (pick a project)");
    expect(li()).not.toContain("granted on every project they can see");
    await pickProject("p1");
    expect(qualityOk()).toBe("no"); // the database refuses them there
    await pickProject("p2");
    expect(qualityOk()).toBe("yes");
    // the other way round: an Engineer outside the base list is granted on p1 by its rule
    await pickProject("");
    await pickMember("eng");
    expect(qualityOk()).toBe("no");
    expect(li()).toContain("not by the base list — granted on PSSR Unit 200 by a project rule");
    // no project rules at all: the old sentence stands
    __resetCapabilityPolicyCache();
    h.db.tables.org_configurations = [policyRow({ "quality.sign_off": ["Safety"] })];
    act(() => root.unmount()); root = createRoot(host);
    await mount(); await pickMember("saf");
    expect(li()).toContain("granted on every project they can see");
  });

  it("ORG-14 (fix pass 2): before 20261136 is pasted, a picked project says the database admits only the controllers and the owner today", async () => {
    seed();
    h.rpc = { data: null, error: { message: "Could not find the function public.quality_signoff_status(p_project) in the schema cache", code: "PGRST202" } };
    await mount(); await pickMember("saf");
    expect(host.querySelector("[data-signoff-pending]")).toBeNull(); // not asked until a project is picked
    await pickProject("p1");
    expect(h.rpcCalls).toEqual(["quality_signoff_status"]);
    expect(host.querySelector("[data-signoff-pending]")!.textContent).toContain("migration 20261136 is not applied");
  });
  it("ORG-14 (fix pass 2) regression: with 20261136 live (the probe answers), no such note", async () => {
    seed();
    h.rpc = { data: { maySign: true, otherSigners: 1 }, error: null };
    await mount(); await pickMember("saf"); await pickProject("p1");
    expect(host.querySelector("[data-signoff-pending]")).toBeNull();
    // and a probe that fails for another reason claims nothing either way
    act(() => root.unmount()); root = createRoot(host);
    h.rpc = { data: null, error: { message: "timeout" } };
    await mount(); await pickMember("saf"); await pickProject("p1");
    expect(host.querySelector("[data-signoff-pending]")).toBeNull();
  });

  it("ALOG-1 done-when 2: an unreadable policy is SAID, and no grant is offered", async () => {
    seed(); h.db.readError.org_configurations = { message: "upstream timeout" };
    await mount(); await pickMember("eng");
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("could not be read (upstream timeout)");
    expect(alert.textContent).toContain("NOT this org's policy");
    expect(button(/^\s*Grant\s*$/)).toBeUndefined();
    expect(text()).toContain("Grants are unavailable until the policy can be read.");
  });

  it("regression: a readable policy shows no banner and offers the grant form to an editor", async () => {
    seed(); await mount(); await pickMember("eng");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button(/Grant/)).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("CapabilityPolicyEditor", () => {
  const mount = async () => { await act(async () => { root.render(React.createElement(CapabilityPolicyEditor, { canEdit: true })); }); await flush(); };
  const cellButton = (capLabel: string, colIndex: number) => {
    const tr = [...host.querySelectorAll("tr")].find((r) => r.querySelector("td")?.textContent?.startsWith(capLabel))!;
    return tr.querySelectorAll("td")[colIndex + 1].querySelector("button") as HTMLButtonElement;
  };
  const save = async () => { await act(async () => { button(/Save policy/)!.click(); }); await flush(); };
  const V = "2026-10-01T00:00:00+00:00";

  it("ALOG-1: an unreadable policy is said with Retry — no grid, no Save — and Retry loads it", async () => {
    h.db.readError.org_configurations = { message: "connection reset" };
    await mount();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("this workspace's policy could not be read");
    expect(text()).toContain("(connection reset)");
    expect(button(/Save policy/)).toBeUndefined();
    h.db.readError = {};
    h.db.tables.org_configurations = [policyRow({ "ticket.assign": ["Admin"] }, V)];
    await act(async () => { button(/Retry/)!.click(); }); await flush();
    expect(button(/Save policy/)).toBeDefined();
  });

  it("ALOG-12: the save carries the version the grid was loaded at", async () => {
    h.db.tables.org_configurations = [policyRow({ "ticket.assign": ["Admin"] }, V)];
    await mount();
    await act(async () => { cellButton("Assign drafters", 2).click(); }); // DocCtrl
    await save();
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0]).toMatchObject({ op: "save", orgId: "o1", version: V });
    expect(text()).toContain("Saved — validated and audited on the server");
  });

  it("ALOG-12: a 409 policy_changed where only GRANTS moved re-saves on the new version (no lost edit, no false conflict)", async () => {
    h.db.tables.org_configurations = [policyRow({ "ticket.assign": ["Admin"] }, V)];
    await mount();
    await act(async () => { cellButton("Assign drafters", 2).click(); });
    // meanwhile a grant landed: the row's stamp moved, its role grid did not
    h.db.tables.org_configurations = [policyRow({ "ticket.assign": ["Admin"] }, "2026-10-02T00:00:00+00:00", [{ cap: "ticket.assign", uid: "x", expiresAt: null }])];
    h.fetchReplies = [{ status: 409, body: { error: "changed", code: "policy_changed" } }];
    await save();
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.fetchCalls[1]).toMatchObject({ op: "save", version: "2026-10-02T00:00:00+00:00" });
    expect((h.fetchCalls[1].caps as Record<string, unknown>)["ticket.assign"]).toEqual(["Admin", "DocCtrl"]);
    expect(text()).toContain("Saved");
  });

  it("ALOG-12: a 409 policy_changed where another admin changed the GRID shows their grid and saves nothing over it", async () => {
    h.db.tables.org_configurations = [policyRow({ "ticket.assign": ["Admin"] }, V)];
    await mount();
    await act(async () => { cellButton("Assign drafters", 2).click(); });
    h.db.tables.org_configurations = [policyRow({ "ticket.assign": ["Admin", "Supervisor"] }, "2026-10-02T00:00:00+00:00")];
    h.fetchReplies = [{ status: 409, body: { error: "changed", code: "policy_changed" } }];
    await save();
    expect(h.fetchCalls).toHaveLength(1);
    expect(text()).toContain("Another admin changed the action permissions since you opened this page");
    // the grid now shows THEIR row: Supervisor ticked, DocCtrl not
    expect(cellButton("Assign drafters", 4).className).toContain("bg-emerald-500"); // Supervisor column
    expect(cellButton("Assign drafters", 2).className).not.toContain("bg-emerald-500"); // DocCtrl
  });

  it("ALOG-9: a stored token with no column is named on its row", async () => {
    h.db.tables.org_configurations = [policyRow({ "ticket.assign": ["Admin", "Engineer-2"] }, V)];
    await mount();
    expect(text()).toContain("Also stored, no column here: Engineer-2 — still live");
  });

  it("QUAL-14: a project rule is listed by project name and saved as a projectId rule through the route", async () => {
    h.db.tables.org_configurations = [policyRow({}, V)];
    h.db.tables.projects = [{ org_id: "o1", id: "p1", name: "PSSR Unit 200" }];
    await mount();
    await choose(select((s) => [...s.options].some((o) => o.value === "p1")), "p1");
    await act(async () => { button(/Add project rule/)!.click(); }); await flush();
    const row = host.querySelector('[data-project-rule="p1"]')!;
    expect(row.textContent).toContain("PSSR Unit 200");
    const safety = [...row.querySelectorAll("button")].find((b) => b.textContent === "Safety (dept)")!;
    await act(async () => { safety.click(); });
    await save();
    expect(h.fetchCalls[0].caps).toMatchObject({ "quality.sign_off": [{ tokens: [] }, { tokens: ["Safety"], when: { projectId: ["p1"] } }] });
  });

  it("QUAL-14 done-when 3: a stored project rule shows which project and for whom; removing it saves without it", async () => {
    h.db.tables.org_configurations = [policyRow({ "quality.sign_off": [{ tokens: [] }, { tokens: ["Operations"], when: { projectId: ["p1"] } }] }, V)];
    h.db.tables.projects = [{ org_id: "o1", id: "p1", name: "PSSR Unit 200" }];
    await mount();
    const row = host.querySelector('[data-project-rule="p1"]')!;
    expect(row.textContent).toContain("PSSR Unit 200");
    expect([...row.querySelectorAll("button")].find((b) => b.textContent === "Operations (dept)")!.className).toContain("bg-emerald-500");
    await act(async () => { (row.querySelector('button[title^="Remove this project rule"]') as HTMLButtonElement).click(); });
    await save();
    expect((h.fetchCalls[0].caps as Record<string, unknown>)["quality.sign_off"]).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("PermissionsExplorer", () => {
  const mount = async () => { await act(async () => { root.render(React.createElement(PermissionsExplorer)); }); await flush(); };
  it("ALOG-14: three labelled sections — the org's policy, the admin-surface registry, and a dated snapshot", async () => {
    h.db.tables.org_configurations = [policyRow({ "holds.open": ["Admin"] })];
    await mount();
    const sections = [...host.querySelectorAll("tr[data-section]")].map((r) => r.getAttribute("data-section"));
    expect(sections).toEqual(["policy", "surface", "snapshot"]);
    expect(text()).toContain("Action permissions — this org's policy");
    expect(text()).toContain("Documentation snapshot — hand-maintained; rows marked SNAPSHOT were checked against the code on 2026-10-07, rows marked NOT RE-CHECKED were not");
    expect(host.querySelectorAll("span").length).toBeGreaterThan(0);
    // the stored narrowing is what the row shows
    const row = [...host.querySelectorAll("tr")].find((r) => r.querySelector("td")?.textContent?.startsWith("Place a hold"))!;
    const marks = [...row.querySelectorAll("td")].slice(1).map((td) => td.textContent);
    expect(marks[0]).toBe("✓");
    expect(marks[11]).toBe("—"); // Viewer
  });
  it("fix pass 2: a snapshot row not checked against the code says so on screen; a checked one does not", async () => {
    h.db.tables.org_configurations = [policyRow({})];
    await mount();
    const rowOf = (cap: string) => [...host.querySelectorAll("tr")].find((r) => r.querySelector("td")?.textContent?.startsWith(cap))!;
    expect(rowOf("Manage sets & binders").querySelector("[data-unchecked]")?.textContent).toBe("NOT RE-CHECKED");
    expect(rowOf("Per-library permission (ACL) drawer").querySelector("[data-unchecked]")).toBeNull();
    expect(rowOf("Per-library permission (ACL) drawer").textContent).toContain("SNAPSHOT");
    // the composed rows (blocker): a Manager approves drawings
    const marks = [...rowOf("Direct engineering approval").querySelectorAll("td")].slice(1).map((td) => td.textContent);
    expect(marks[2]).toBe("✓"); // Manager
  });
  it("ALOG-1 / DEC-89: an unreadable policy shows the shipped defaults LABELLED, never as the org's", async () => {
    h.db.readError.org_configurations = { message: "boom" };
    await mount();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("show the SHIPPED DEFAULTS, not this org's policy");
    expect(text()).toContain("(shipped defaults — the org's policy could not be read)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// fix pass 2 — the page's panels move together, and a failed list is said
// ═══════════════════════════════════════════════════════════════════════════
describe("/admin/permissions panels after a save (ALOG-14 fix pass 2)", () => {
  it("a policy-editor save re-reads the explorer and View-as on the same page — the matrix never shows the pre-save policy", async () => {
    h.db.tables = {
      org_configurations: [policyRow({ "checkout.force_release": ["Admin", "DocCtrl"] }, "2026-10-01T00:00:00+00:00")],
      org_members: [{ org_id: "o1", uid: "dc", display_name: "Dee Control", role: "DocCtrl", roles: ["DocCtrl"], status: "active" }],
      libraries: [], teams: [], team_members: [], projects: [], project_members: [],
    };
    // the policy route stands in for the database write
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      h.fetchCalls.push(body);
      h.db.tables.org_configurations = [policyRow(body.caps, "2026-10-07T00:00:00+00:00")];
      return new Response(JSON.stringify({ ok: true, version: "2026-10-07T00:00:00+00:00" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as never;
    await act(async () => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement("div", { id: "ed" }, React.createElement(CapabilityPolicyEditor, { canEdit: true })),
        React.createElement("div", { id: "ex" }, React.createElement(PermissionsExplorer)),
        React.createElement("div", { id: "va" }, React.createElement(ViewAsSimulator, { canEdit: true }))));
    });
    await flush();
    const within = (id: string) => host.querySelector(`#${id}`)!;
    const exRow = () => [...within("ex").querySelectorAll("tr")].find((r) => r.querySelector("td")?.textContent?.startsWith("Force-release a checkout"))!;
    const exMark = (i: number) => [...exRow().querySelectorAll("td")].slice(1)[i].textContent;
    await choose([...within("va").querySelectorAll("select")].find((x) => [...x.options].some((o) => o.value === "dc")) as HTMLSelectElement, "dc");
    const vaOk = () => within("va").querySelector('[data-cap="checkout.force_release"]')?.getAttribute("data-ok");
    expect(exMark(1)).toBe("✓"); // DocCtrl, before
    expect(vaOk()).toBe("yes");
    const edRow = [...within("ed").querySelectorAll("tr")].find((r) => r.querySelector("td")?.textContent?.startsWith("Force-release a checkout"))!;
    await act(async () => { (edRow.querySelectorAll("td")[3].querySelector("button") as HTMLButtonElement).click(); }); // DocCtrl column
    await act(async () => { button(/Save policy/)!.click(); });
    await flush();
    expect(h.fetchCalls).toHaveLength(1);
    expect(exMark(1)).toBe("—"); // the explorer re-read the saved policy
    expect(vaOk()).toBe("no"); // so did View-as
  }, 30_000); // three panels mounted together: give a loaded machine room

  it("View-as: a projects (or team names) read that failed is said — never an empty picker read as 'no projects'", async () => {
    h.db.tables = {
      org_configurations: [policyRow({})],
      org_members: [{ org_id: "o1", uid: "eng", display_name: "Eve Eng", role: "Engineer-2", roles: ["Engineer-2"], status: "active" }],
      libraries: [], teams: [], team_members: [], projects: [], project_members: [],
    };
    h.db.readError.projects = { message: "timeout" };
    h.db.readError.teams = { message: "denied" };
    await act(async () => { root.render(React.createElement(ViewAsSimulator, { canEdit: false })); });
    await flush();
    const alert = [...host.querySelectorAll('[role="alert"]')].map((n) => n.textContent).join(" ");
    expect(alert).toContain("Some lists could not be read: projects (timeout); team names (denied)");
  });

  it("View-as: a Manager approves drawings via the management override (the composed rows), said on the line", async () => {
    h.db.tables = {
      org_configurations: [policyRow({})],
      org_members: [{ org_id: "o1", uid: "mgr", display_name: "Max Manager", role: "Manager", roles: ["Manager"], status: "active" },
                    { org_id: "o1", uid: "dr", display_name: "Dan Drafter", role: "Drafter", roles: ["Drafter"], status: "active" }],
      libraries: [], teams: [], team_members: [], projects: [], project_members: [],
    };
    await act(async () => { root.render(React.createElement(ViewAsSimulator, { canEdit: false })); });
    await flush();
    await choose(select((x) => [...x.options].some((o) => o.value === "mgr")), "mgr");
    const li = (cap: string) => host.querySelector(`[data-cap="${cap}"]`)!;
    for (const cap of ["ticket.direct_approve", "ticket.final_approve", "ticket.eng_review", "ticket.requester_review"]) {
      expect(li(cap).getAttribute("data-ok"), cap).toBe("yes");
    }
    expect(li("ticket.direct_approve").textContent).toContain("via Management override (ticket.manage)");
    await choose(select((x) => [...x.options].some((o) => o.value === "mgr")), "dr");
    expect(li("ticket.direct_approve").getAttribute("data-ok")).toBe("no");
  });

  it("the editor: a projects read that failed is said to a READ-ONLY viewer too, and a stored rule's project is 'could not be listed', not 'not visible to you'", async () => {
    h.db.tables = { org_configurations: [policyRow({ "quality.sign_off": [{ tokens: [] }, { tokens: ["Safety"], when: { projectId: ["p1"] } }] })] };
    h.db.readError.projects = { message: "timeout" };
    await act(async () => { root.render(React.createElement(CapabilityPolicyEditor, { canEdit: false })); });
    await flush();
    expect(text()).toContain("Projects could not be listed (timeout)");
    const rule = host.querySelector('[data-project-rule="p1"]')!;
    expect(rule.textContent).toContain("project p1… (projects could not be listed)");
    expect(rule.textContent).not.toContain("not visible to you");
  });
});
