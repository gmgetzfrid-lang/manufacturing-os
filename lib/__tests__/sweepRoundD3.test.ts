// Round D3 — DEC-13 stage 2: the capability policy's RESOURCE dimension
// (DRAFT-1 / WF-13 / GAP-1), the "engineering first" request-type flag
// (DRAFT-2) and the recorded self-assign default (DRAFT-5).
//
//   * policyAllows(policy, cap, role, extraRoles, uid, resource): a rule
//     `{tokens, when}` scoped to a resource REPLACES the base list; no rule /
//     no resource = the base list, byte-identical to before.
//   * All four evaluators move together: getActions, holds, the simulator
//     and the SQL org_capability_allows_for (20261052) — pinned by source.
//   * The workflow-action route REFUSES a type-scoped approval and a
//     reviewer pick outside the scoped group (driven end-to-end below).
//   * The migration's default CASE and token/grant loops are byte-faithful
//     to the live 20261038 body.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
  CAPABILITY_DEFS, RESOURCE_KEYS, policyAllows, tokensFor, scopedTokensFor, baseTokensFor, ruleMatches,
  normalizeCapabilityEntry, validateCapabilityPolicy, describeWhen, __resetCapabilityPolicyCache,
  type CapabilityPolicy,
} from "@/lib/capabilityPolicy";
import { WorkflowEngine, ticketResource, type WorkflowContext } from "@/lib/workflow";
import { requestTypeOptionsFrom, flaggedRequestTypes } from "@/lib/requestTypes";
import { splitPolicyForEditor, joinPolicyFromEditor } from "@/components/permissions/CapabilityPolicyEditor";
import { rowToTicket } from "@/lib/ticketTransitions";
import type { Ticket, Role } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

const ticket = (over: Partial<Ticket>): Ticket => ({
  id: "t1", orgId: "o1", status: "PENDING_REVIEW", requesterId: "req-1", requesterRole: "Requester",
  requestType: "ISO", unit: "U-100", assignedDrafterId: "d-1", assignedEngineerId: null, attachments: [],
  ...over,
} as unknown as Ticket);

/** "ASBUILT may only be approved by DocCtrl" — the DEC-13 acceptance policy. */
const ASBUILT_DOCCTRL: CapabilityPolicy = {
  caps: {
    "ticket.direct_approve": [{ tokens: ["Engineer"] }, { tokens: ["DocCtrl"], when: { requestType: ["ASBUILT"] } }],
    "ticket.manage": [{ tokens: ["Admin", "Manager", "Supervisor"] }, { tokens: ["Admin", "DocCtrl"], when: { requestType: ["ASBUILT"] } }],
    "ticket.final_approve": [{ tokens: ["Engineer"] }, { tokens: ["Engineer-4"], when: { requestType: ["ASBUILT"] } }],
  },
};

describe("policyAllows with a resource — a scoped rule replaces the base list; nothing else moves", () => {
  it("bare lists and absent entries are unchanged, with or without a resource", () => {
    for (const d of CAPABILITY_DEFS) {
      expect(tokensFor({}, d.id)).toEqual(d.defaultRoles);
      expect(tokensFor({}, d.id, { requestType: "ASBUILT" })).toEqual(d.defaultRoles);
      expect(tokensFor({ caps: { [d.id]: ["Viewer"] } }, d.id, { requestType: "X", unit: "Y" })).toEqual(["Viewer"]);
    }
    expect(tokensFor({ caps: { "ticket.assign": [] } }, "ticket.assign", { requestType: "ASBUILT" })).toEqual([]);
  });
  it("a rule list with no `when` is exactly its base list; a scoped rule applies only to its resource", () => {
    const p = ASBUILT_DOCCTRL;
    expect(baseTokensFor(p, "ticket.direct_approve")).toEqual(["Engineer"]);
    expect(scopedTokensFor(p, "ticket.direct_approve", undefined)).toBeNull();
    expect(scopedTokensFor(p, "ticket.direct_approve", { requestType: "ISO" })).toBeNull();
    expect(scopedTokensFor(p, "ticket.direct_approve", { requestType: "ASBUILT" })).toEqual(["DocCtrl"]);
    expect(policyAllows(p, "ticket.direct_approve", "Engineer-2", null, "e1")).toBe(true);
    expect(policyAllows(p, "ticket.direct_approve", "Engineer-2", null, "e1", { requestType: "ISO" })).toBe(true);
    expect(policyAllows(p, "ticket.direct_approve", "Engineer-2", null, "e1", { requestType: "ASBUILT" })).toBe(false);
    expect(policyAllows(p, "ticket.direct_approve", "DocCtrl", null, "c1", { requestType: "ASBUILT" })).toBe(true);
    expect(policyAllows(p, "ticket.direct_approve", "DocCtrl", null, "c1", { requestType: "ISO" })).toBe(false);
    // additive collection counts under a scoped rule exactly as under the base
    expect(policyAllows(p, "ticket.direct_approve", "Viewer", ["DocCtrl"], "c2", { requestType: "ASBUILT" })).toBe(true);
    // a rule list with only an unconditional rule = a bare list
    expect(policyAllows({ caps: { "ticket.assign": [{ tokens: ["Drafter"] }] } }, "ticket.assign", "Drafter", null, "d", { requestType: "ASBUILT" })).toBe(true);
    expect(policyAllows({ caps: { "ticket.assign": [{ tokens: ["Drafter"] }] } }, "ticket.assign", "Admin", null, "a")).toBe(false);
  });
  it("`when` is AND across keys, OR within a list; a missing resource value never matches; first match wins", () => {
    const r = { tokens: ["DocCtrl"], when: { requestType: ["ASBUILT", "MOC"], unit: ["U-100"] } };
    expect(ruleMatches(r, { requestType: "MOC", unit: "U-100" })).toBe(true);
    expect(ruleMatches(r, { requestType: "ASBUILT", unit: "U-200" })).toBe(false);
    expect(ruleMatches(r, { requestType: "ASBUILT" })).toBe(false);
    expect(ruleMatches(r, {})).toBe(false);
    expect(ruleMatches({ tokens: ["X"], when: { requestType: [] } }, { requestType: "ASBUILT" })).toBe(false);
    const p: CapabilityPolicy = { caps: { "ticket.assign": [
      { tokens: ["A"] },
      { tokens: ["First"], when: { requestType: ["ASBUILT"] } },
      { tokens: ["Second"], when: { requestType: ["ASBUILT"] } },
    ] } };
    expect(tokensFor(p, "ticket.assign", { requestType: "ASBUILT" })).toEqual(["First"]);
  });
  it("a scoped rule with only a base-less list falls to the shipped default; grants still ride the same evaluator", () => {
    const p: CapabilityPolicy = { caps: { "ticket.assign": [{ tokens: ["DocCtrl"], when: { requestType: ["ASBUILT"] } }] } };
    expect(tokensFor(p, "ticket.assign")).toEqual(["Admin", "Manager", "Supervisor", "DraftingSupervisor"]);
    expect(tokensFor(p, "ticket.assign", { requestType: "ASBUILT" })).toEqual(["DocCtrl"]);
    const g: CapabilityPolicy = { ...ASBUILT_DOCCTRL, grants: [{ cap: "ticket.direct_approve", uid: "e1", expiresAt: null }] };
    // WF-13 row 6: a personal grant has no scope — it confers the capability everywhere.
    expect(policyAllows(g, "ticket.direct_approve", "Engineer-2", null, "e1", { requestType: "ASBUILT" })).toBe(true);
    expect(policyAllows(g, "ticket.direct_approve", "Engineer-2", null, "e2", { requestType: "ASBUILT" })).toBe(false);
  });
});

describe("shape: parsing and validation of rule lists", () => {
  it("normalizeCapabilityEntry accepts both shapes, drops unknown when-keys and unusable rules", () => {
    expect(normalizeCapabilityEntry(["Admin", "DocCtrl"])).toEqual(["Admin", "DocCtrl"]);
    expect(normalizeCapabilityEntry([])).toEqual([]);
    expect(normalizeCapabilityEntry("Admin")).toBeUndefined();
    expect(normalizeCapabilityEntry([{ tokens: ["A"], when: { requestType: ["X"], projectId: ["p"], unit: [] } }, { tokens: "bad" }, null]))
      .toEqual([{ tokens: ["A"], when: { requestType: ["X"] } }]);
    expect(normalizeCapabilityEntry([{ tokens: ["A"], when: { unit: [] } }])).toEqual([{ tokens: ["A"] }]);
    expect(normalizeCapabilityEntry([{ nope: 1 }])).toBeUndefined();
    expect(RESOURCE_KEYS).toEqual(["requestType", "unit", "libraryId", "discipline"]);
  });
  it("validate: Admin is required on EVERY rule of a critical capability, and unknown keys are refused", () => {
    expect(validateCapabilityPolicy({ caps: { "ticket.manage": [{ tokens: ["Admin"] }, { tokens: ["DocCtrl"], when: { requestType: ["ASBUILT"] } }] } }))
      .toMatch(/Management override \(rule 2: requestType ∈ \{ASBUILT\}\): Admin cannot be removed/);
    expect(validateCapabilityPolicy({ caps: { "ticket.manage": [{ tokens: ["Manager"] }, { tokens: ["Admin"], when: { requestType: ["ASBUILT"] } }] } }))
      .toMatch(/Management override: Admin cannot be removed/);
    expect(validateCapabilityPolicy(ASBUILT_DOCCTRL)).toBeNull();
    expect(validateCapabilityPolicy({ caps: { "ticket.assign": [{ tokens: ["A"], when: { projectId: ["p"] } as never }] } }))
      .toMatch(/unknown resource key "projectId"/);
    expect(validateCapabilityPolicy({ caps: { "ticket.assign": [{ tokens: "A" } as never] } })).toMatch(/invalid value/);
    expect(describeWhen({ requestType: ["A", "B"], unit: ["U"] })).toBe("requestType ∈ {A, B} and unit ∈ {U}");
    expect(describeWhen(undefined)).toBe("always");
  });
  it("the editor's split/join round-trips: no override → the bare list (byte-compatible); overrides → rules; opaque rules preserved", () => {
    const legacy: CapabilityPolicy = { caps: { "ticket.assign": ["Admin", "DocCtrl"], "ticket.self_assign": [] } };
    const s1 = splitPolicyForEditor(legacy);
    expect(s1.base["ticket.assign"]).toEqual(["Admin", "DocCtrl"]);
    expect(s1.overrides).toEqual({});
    const j1 = joinPolicyFromEditor(s1.base, s1.overrides, s1.opaque);
    expect(j1["ticket.assign"]).toEqual(["Admin", "DocCtrl"]);
    expect(j1["ticket.self_assign"]).toEqual([]);
    expect(j1["ticket.manage"]).toEqual(["Admin", "Manager", "Supervisor"]);
    const rich: CapabilityPolicy = { caps: { "ticket.direct_approve": [
      { tokens: ["Engineer"] },
      { tokens: ["DocCtrl"], when: { requestType: ["ASBUILT", "MOC"] } },
      { tokens: ["Engineer-4"], when: { unit: ["U-100"] } },
    ] } };
    const s2 = splitPolicyForEditor(rich);
    expect(s2.base["ticket.direct_approve"]).toEqual(["Engineer"]);
    expect(s2.overrides["ticket.direct_approve"]).toEqual([{ type: "ASBUILT", tokens: ["DocCtrl"] }, { type: "MOC", tokens: ["DocCtrl"] }]);
    expect(s2.opaque["ticket.direct_approve"]).toEqual([{ tokens: ["Engineer-4"], when: { unit: ["U-100"] } }]);
    const j2 = joinPolicyFromEditor(s2.base, s2.overrides, s2.opaque);
    expect(j2["ticket.direct_approve"]).toEqual([
      { tokens: ["Engineer"] },
      { tokens: ["DocCtrl"], when: { requestType: ["ASBUILT"] } },
      { tokens: ["DocCtrl"], when: { requestType: ["MOC"] } },
      { tokens: ["Engineer-4"], when: { unit: ["U-100"] } },
    ]);
    // the split shape evaluates identically to the stored shape
    for (const rt of ["ASBUILT", "MOC", "ISO"]) {
      expect(policyAllows({ caps: j2 }, "ticket.direct_approve", "DocCtrl", null, "c", { requestType: rt }))
        .toBe(policyAllows(rich, "ticket.direct_approve", "DocCtrl", null, "c", { requestType: rt }));
    }
  });
});

describe("getActions honours the resource — DEC-13 acceptance: ASBUILT may only be approved by DocCtrl", () => {
  const asbuilt = ticket({ requestType: "ASBUILT" });
  const iso = ticket({ requestType: "ISO" });
  const acts = (t: Ticket, role: string, uid: string, policy?: CapabilityPolicy, extra?: string[]) =>
    WorkflowEngine.getActions(t, role as Role, uid, policy, { userRoles: (extra ?? [role]) as Role[], activeMemberCount: 5 }).map((a) => a.action);

  it("ticketResource carries request type and unit", () => {
    expect(ticketResource(asbuilt)).toEqual({ requestType: "ASBUILT", unit: "U-100" });
    expect(ticketResource({ requestType: "", unit: "" })).toEqual({ requestType: null, unit: null });
  });
  it("a co-reviewing engineer loses Approve on ASBUILT only; DocCtrl gains it there only; a Manager's override is scoped too", () => {
    expect(acts(iso, "Engineer-2", "e1", ASBUILT_DOCCTRL)).toContain("approve_draft_ifc");
    expect(acts(asbuilt, "Engineer-2", "e1", ASBUILT_DOCCTRL)).not.toContain("approve_draft_ifc");
    expect(acts(asbuilt, "Engineer-2", "e1", ASBUILT_DOCCTRL)).not.toContain("approve_minor_correction");
    expect(acts(asbuilt, "DocCtrl", "c1", ASBUILT_DOCCTRL)).toContain("approve_draft_ifc");
    expect(acts(iso, "DocCtrl", "c1", ASBUILT_DOCCTRL)).not.toContain("approve_draft_ifc");
    expect(acts(iso, "Manager", "m1", ASBUILT_DOCCTRL)).toContain("approve_draft_ifc");
    expect(acts(asbuilt, "Manager", "m1", ASBUILT_DOCCTRL)).not.toContain("approve_draft_ifc");
    expect(acts(asbuilt, "Admin", "a1", ASBUILT_DOCCTRL)).toContain("approve_draft_ifc");
    // unconfigured: byte-identical to today on the same tickets
    expect(acts(asbuilt, "Engineer-2", "e1")).toContain("approve_draft_ifc");
    expect(acts(asbuilt, "Manager", "m1")).toContain("approve_draft_ifc");
    expect(acts(asbuilt, "DocCtrl", "c1")).not.toContain("approve_draft_ifc");
  });
  it("the requester's OWN approval is bound by a scoped direct-approval rule: an engineer requester sends ASBUILT for engineer approval instead", () => {
    const own = ticket({ requestType: "ASBUILT", requesterId: "e1", requesterRole: "Engineer-2" });
    expect(acts(own, "Engineer-2", "e1")).toContain("approve_draft_ifc");
    const bound = acts(own, "Engineer-2", "e1", ASBUILT_DOCCTRL);
    expect(bound).not.toContain("approve_draft_ifc");
    expect(bound).toContain("request_final_engineer_approval");
    expect(bound).toContain("request_revision"); // identity keeps every review action
    const ownIso = ticket({ requestType: "ISO", requesterId: "e1", requesterRole: "Engineer-2" });
    expect(acts(ownIso, "Engineer-2", "e1", ASBUILT_DOCCTRL)).toContain("approve_draft_ifc");
    const docCtrlOwn = ticket({ requestType: "ASBUILT", requesterId: "c1", requesterRole: "DocCtrl" });
    expect(acts(docCtrlOwn, "DocCtrl", "c1", ASBUILT_DOCCTRL)).toContain("approve_draft_ifc");
  });
  it("the simulator and the route evaluate with the same call shape as the engine (all four evaluators move together)", () => {
    expect(src("lib/workflow.ts")).toContain("const allows = (cap: Parameters<typeof policyAllows>[1]) => policyAllows(policy, cap, userRole, roleCollection, userId, resource);");
    expect(src("lib/workflow.ts")).toContain("const resource = ticketResource(ticket);");
    expect(src("components/permissions/ViewAsSimulator.tsx")).toContain("ok: policyAllows(policy, d.id, who.role, who.roles, who.uid, resource),");
    expect(src("components/permissions/ViewAsSimulator.tsx")).toContain("scoped: scopedTokensFor(policy, d.id, resource) !== null,");
    expect(src("lib/holds.ts")).toContain("if (!policyAllows(policy, cap, role, extra, uid, resource)) {");
    const r = src("app/api/tickets/workflow-action/route.ts");
    expect(r).toContain("const resource = ticketResource(ticket);");
    expect(r).toContain("const scoped = scopedTokensFor(capPolicy, pickCap, resource);");
    expect(r).toContain('(held[0] ?? "Viewer") as Role, held as Role[], ref, resource);');
    expect(r).toMatch(/engineeringFirstTypes,\s*\n\s*closeWithoutReviewTypes,\s*\n\s*requesterRoles,\s*\n\s*\}\);/);
    expect(src("app/(protected)/requests/[id]/page.tsx")).toMatch(/engineeringFirstTypes,\s*\n\s*closeWithoutReviewTypes,\s*\n\s*requesterRoles,\s*\n\s*\}\);/);
    // the only policyAllows call sites, every one resource-aware or deliberately base-only
    const sites = ["lib/workflow.ts", "lib/holds.ts", "components/permissions/ViewAsSimulator.tsx", "app/api/tickets/workflow-action/route.ts",
      "app/(protected)/admin/archive-view/page.tsx", "app/(protected)/admin/analytics/page.tsx"];
    for (const f of sites) expect(src(f)).toMatch(/policyAllows\(/);
  });
});

describe("DRAFT-2 — an 'engineering first' request type gates assignment until engineering has been in the loop", () => {
  const queue = ticket({ status: "PENDING_ASSIGNMENT", requestType: "DATASHEET", assignedDrafterId: null });
  const ctx: WorkflowContext = { userRoles: ["Admin"] as Role[], activeMemberCount: 5, engineeringFirstTypes: ["DATASHEET"] };
  const find = (t: Ticket, role: string, uid: string, c: WorkflowContext = ctx) =>
    Object.fromEntries(WorkflowEngine.getActions(t, role as Role, uid, undefined, { ...c, userRoles: [role] as Role[] }).map((a) => [a.action, a]));

  it("assign / pick-up render DISABLED with the reason; flagging for engineering review stays live", () => {
    const admin = find(queue, "Admin", "a1");
    expect(admin.assign?.disabledReason).toMatch(/routes through engineering first/);
    expect(admin.request_eng_review).toBeDefined();
    expect(admin.request_eng_review?.disabledReason).toBeUndefined();
    const drafter = find(queue, "Drafter", "d1");
    expect(drafter.self_assign?.disabledReason).toMatch(/routes through engineering first/);
  });
  it("after the review (requested → completed back into the queue) the gate lifts; other types are untouched", () => {
    const reviewed = ticket({ ...queue, engineerReviewRequestedAt: "2026-09-03T00:00:00Z" as never, assignedEngineerId: "e1" });
    expect(find(reviewed, "Admin", "a1").assign?.disabledReason).toBeUndefined();
    expect(find(reviewed, "Drafter", "d1").self_assign?.disabledReason).toBeUndefined();
    const iso = ticket({ ...queue, requestType: "ISO" });
    expect(find(iso, "Admin", "a1").assign?.disabledReason).toBeUndefined();
    expect(find(queue, "Admin", "a1", { ...ctx, engineeringFirstTypes: [] }).assign?.disabledReason).toBeUndefined();
    expect(find(queue, "Admin", "a1", { userRoles: [], activeMemberCount: 5 }).assign?.disabledReason).toBeUndefined();
  });
  it("the SoD reason still applies to a requester picking up their own request once the type gate is clear", () => {
    const own = ticket({ status: "PENDING_ASSIGNMENT", requestType: "ISO", requesterId: "d1", assignedDrafterId: null });
    expect(find(own, "Drafter", "d1").self_assign?.disabledReason).toMatch(/Needs a second person/);
  });
  it("the flag is a property of the configured type (SelectOption.engineeringFirst) and the shared parser reads it", () => {
    expect(src("types/schema.ts")).toMatch(/engineeringFirst\?: boolean;/);
    expect(src("app/(protected)/admin/requests/page.tsx")).toContain("updateOption('requestTypes', i, 'engineeringFirst', e.target.checked)");
    const cfg = { requestTypes: { options: [
      { label: "ISO", value: "ISO" }, { label: "RFI", value: "RFI", closeWithoutReview: true },
      { label: "Datasheet", value: "DATASHEET", engineeringFirst: true }, { label: "", value: 7 }, { value: "" }, null,
    ] } };
    expect(requestTypeOptionsFrom(cfg).map((o) => o.value)).toEqual(["ISO", "RFI", "DATASHEET", "7"]);
    expect(requestTypeOptionsFrom(cfg)[3].label).toBe("7");
    expect(flaggedRequestTypes(cfg, "engineeringFirst")).toEqual(["DATASHEET"]);
    expect(flaggedRequestTypes(cfg, "closeWithoutReview")).toEqual(["RFI"]);
    expect(requestTypeOptionsFrom(null)).toEqual([]);
    expect(requestTypeOptionsFrom({ requestTypes: { options: "x" } })).toEqual([]);
  });
  it("getInitialStatus takes nothing; rowToTicket now maps the engineering-review stamps the gate reads", () => {
    expect(WorkflowEngine.getInitialStatus.length).toBe(0);
    expect(WorkflowEngine.getInitialStatus()).toBe("PENDING_ASSIGNMENT");
    const t = rowToTicket({ id: "t", engineer_review_requested_at: "2026-09-03T00:00:00Z", engineer_approved_at: null, engineer_review_reason: "scope" });
    expect(t.engineerReviewRequestedAt).toBe("2026-09-03T00:00:00Z");
    expect(t.engineerApprovedAt).toBeNull();
    expect(t.engineerReviewReason).toBe("scope");
  });
});

describe("DRAFT-5 — the self-assign default is a recorded decision", () => {
  it("ticket.self_assign stays ['Drafter'] (pull model) and says so; the description names the engineering-first exception", () => {
    const def = CAPABILITY_DEFS.find((d) => d.id === "ticket.self_assign")!;
    expect(def.defaultRoles).toEqual(["Drafter"]);
    expect(def.description).toMatch(/pull model, on by default \(DRAFT-5\)/);
    expect(def.description).toMatch(/Clear this list to make assignment supervisor-only/);
  });
});

// ── the workflow-action route refuses server-side ───────────────────────────
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let head = false;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(head ? { data: null, error: null, count: rows().length } : { data: rows(), error: null, count: rows().length });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: rows()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => undefined) }));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const ticketRow = (over: Record<string, unknown>) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "PENDING_REVIEW", request_type: "ASBUILT", unit: "U-100",
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [], history: [], watchers: [], unread_by: [], ...over,
});
const config = (key: string, data: unknown) => ({ org_id: "o1", key, data });

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = [];
});

describe("/api/tickets/workflow-action — the refusal is server-side, not just a hidden button", () => {
  it("403: a Manager may not approve an ASBUILT draft under the scoped policy (and may on ISO — the gate is the type)", async () => {
    state.user = { id: "m1" };
    state.rows.org_members = [member("m1", "Manager"), member("req-1", "Requester"), member("d-1", "Drafter"), member("e4", "Engineer-4")];
    state.rows.org_configurations = [config("capability_policy", ASBUILT_DOCCTRL)];
    state.rows.tickets = [ticketRow({})];
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not available to you at status PENDING_REVIEW/);
    expect(state.calls.filter((c) => c.table === "tickets" && c.method === "update")).toHaveLength(0);
    // the same caller on an ISO ticket gets PAST the state-machine gate (the
    // next refusal is the transition's own input check, not authority)
    state.rows.tickets = [ticketRow({ request_type: "ISO" })];
    const iso = await post({ ticketId: "t1", actionType: "approve_minor_correction" });
    expect(iso.status).toBe(400);
    expect((await iso.json()).error).toMatch(/requires a comment/);
  });
  it("400: a reviewer picked for an ASBUILT ticket must be inside the scoped final-approval group", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e2", "Engineer-2"), member("e4", "Engineer-4")];
    state.rows.org_configurations = [config("capability_policy", ASBUILT_DOCCTRL)];
    state.rows.tickets = [ticketRow({})];
    const pick = (id: string) => post({ ticketId: "t1", actionType: "request_final_engineer_approval", engineer: { id, name: id, email: `${id}@x.io` } });
    const outside = await pick("e2");
    expect(outside.status).toBe(400);
    expect((await outside.json()).error).toMatch(/outside the group this workspace allows to review ASBUILT requests \(ticket\.final_approve: Engineer-4\)/);
    // Engineer-4 passes the scoped check; the next refusal is SoD (the
    // assigned drafter cannot be the reviewer) — proof the pick check passed.
    state.rows.tickets = [ticketRow({ assigned_drafter_id: "e4" })];
    const inside = await pick("e4");
    expect(inside.status).toBe(403);
    expect((await inside.json()).error).toMatch(/drafter can't be the engineer/);
    expect(state.calls.filter((c) => c.table === "tickets" && c.method === "update")).toHaveLength(0);
  });
  it("403: 'engineering first' assignment is refused with the reason until engineering has been in the loop", async () => {
    state.user = { id: "a1" };
    state.rows.org_members = [member("a1", "Admin"), member("req-1", "Requester"), member("d-1", "Drafter")];
    state.rows.org_configurations = [config("drafting", { requestTypes: { options: [{ label: "Datasheet", value: "DATASHEET", engineeringFirst: true }] } })];
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", request_type: "DATASHEET", assigned_drafter_id: null })];
    const body = { ticketId: "t1", actionType: "assign", assignment: { id: "nobody", name: "n" } };
    const gated = await post(body);
    expect(gated.status).toBe(403);
    expect((await gated.json()).error).toMatch(/routes through engineering first/);
    // once the review has happened the gate lifts: the next refusal is the
    // referenced-member check (the assignee is not a member) — past the gate.
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", request_type: "DATASHEET", assigned_drafter_id: null, engineer_review_requested_at: "2026-09-03T00:00:00Z", assigned_engineer_id: "e1" })];
    const lifted = await post(body);
    expect(lifted.status).toBe(400);
    expect((await lifted.json()).error).toMatch(/not an active member/);
  });
});

// ── 20261052: the SQL evaluator moves with the other three ──────────────────
describe("20261052 — org_capability_allows_for + the 3-argument wrapper", () => {
  const m52 = mig("20261052_rp_phase7_capability_resource_dimension.sql");
  const m38 = mig("20261038_rp_phase4_ticket_workflow_rails.sql");
  const forFn = between(m52, "CREATE OR REPLACE FUNCTION org_capability_allows_for", "CREATE OR REPLACE FUNCTION org_capability_allows(");
  const wrapper = between(m52, "CREATE OR REPLACE FUNCTION org_capability_allows(", "COMMIT;");
  const liveFn = between(m38, "CREATE OR REPLACE FUNCTION org_capability_allows", "CREATE OR REPLACE FUNCTION ticket_insert_integrity");

  it("the wrapper keeps the 3-argument signature every policy depends on and passes an empty resource", () => {
    expect(wrapper).toMatch(/org_capability_allows\(p_org UUID, p_cap TEXT, p_uid UUID\)\s*\nRETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public/);
    expect(wrapper).toContain("RETURN org_capability_allows_for(p_org, p_cap, p_uid, '{}'::jsonb);");
    expect(m52).not.toMatch(/DROP FUNCTION/);
  });
  it("the evaluator reads exactly RESOURCE_KEYS, in order, and resolves rules as tokensFor does", () => {
    expect(forFn).toMatch(/org_capability_allows_for\(p_org UUID, p_cap TEXT, p_uid UUID, p_resource JSONB\)\s*\nRETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public/);
    const keys = `ARRAY[${RESOURCE_KEYS.map((k) => `'${k}'`).join(", ")}]`;
    expect(forFn.split(keys).length - 1).toBe(2); // the match pass and the base pass
    expect(forFn).toContain("IF p_resource->>v_key IS NULL OR NOT (v_list ? (p_resource->>v_key)) THEN");
    expect(forFn).toContain("IF v_cond AND v_hit THEN");
    expect(forFn).toContain("IF NOT v_cond THEN");
    expect(forFn).toContain("IF jsonb_array_length(v_entry) > 0 AND jsonb_typeof(v_entry->0) = 'object' THEN");
    expect(forFn).toContain("v_tokens := v_entry;");
    expect(forFn).toContain("p_resource := COALESCE(p_resource, '{}'::jsonb);");
  });
  it("the default CASE is byte-identical to the live 20261038 body and still mirrors CAPABILITY_DEFS", () => {
    const caseNew = between(forFn, "v_tokens := CASE p_cap", "END;");
    const caseLive = between(liveFn, "v_tokens := CASE p_cap", "END;");
    expect(caseNew).toBe(caseLive);
    const sqlDefaults = new Map<string, string[]>();
    for (const m of caseNew.matchAll(/WHEN '([^']+)'\s+THEN '(\[[^\]]*\])'::jsonb/g)) sqlDefaults.set(m[1], JSON.parse(m[2]) as string[]);
    for (const def of CAPABILITY_DEFS) expect(sqlDefaults.get(def.id), def.id).toEqual(def.defaultRoles);
    expect(sqlDefaults.size).toBe(CAPABILITY_DEFS.length);
  });
  it("the token loop and the grants loop are byte-identical to the live body", () => {
    const loopsNew = between(forFn, "FOR t IN SELECT jsonb_array_elements_text(v_tokens) LOOP", "END;\n$$;");
    const loopsLive = between(liveFn, "FOR t IN SELECT jsonb_array_elements_text(v_tokens) LOOP", "END;\n$$;");
    expect(loopsNew).toBe(loopsLive);
    // and the membership read
    expect(between(forFn, "SELECT role, COALESCE(roles, ARRAY[role])", "IF v_role IS NULL THEN RETURN FALSE; END IF;"))
      .toBe(between(liveFn, "SELECT role, COALESCE(roles, ARRAY[role])", "IF v_role IS NULL THEN RETURN FALSE; END IF;"));
    // every live line survives somewhere in the new evaluator (only additions)
    const { onlyInA } = lineDiff(liveFn, forFn);
    expect(onlyInA.filter((l) => l.trim() !== "" && !l.startsWith("--") && !l.trim().startsWith("--")).map((l) => l.trim()))
      .toEqual([
        "CREATE OR REPLACE FUNCTION org_capability_allows(p_org UUID, p_cap TEXT, p_uid UUID)",
        "v_tokens := COALESCE(v_val->'caps'->p_cap, v_val->p_cap);",
      ]);
  });
  it("verification probes: 5, read-only, deparsed-safe; inventory is aggregate only", () => {
    const verify = between(m52, "-- ── Verification", "-- ── Inventory");
    expect((verify.match(/UNION ALL/g) ?? []).length).toBe(4);
    expect(verify).toContain("pronargs = 4");
    expect(verify).toMatch(/document_holds_insert', 'document_holds_update'/);
    expect(verify).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/);
    const inv = m52.slice(m52.indexOf("-- ── Inventory"));
    expect(inv).toMatch(/COUNT\(\*\)::text/);
    expect(inv).not.toMatch(/SELECT \*|SELECT data\b/);
  });
});
