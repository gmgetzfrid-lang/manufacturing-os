// drafting-flow Round G, DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION —
// GAP-105 acceptance 3, TIER-4 (scoped rules), the DCW-6 hand-off, and the
// integrator's rulings under DEC-90 for DF-P19:
//
//   (1) lib/workflow.ts ticketResource carries libraryId / workClass /
//       codeClass, and EVERY mapper that builds a request for the engine
//       (the workflow route's / cron's rowToTicket, the request page's and
//       the requests list's fromRow, lib/inbox.ts rowToTicket, the attention
//       badge's fromDbTicket) spreads the same fields — one row run through
//       every mapper gives one resource and one set of actions.
//   (2) a stored rule scoped to a library / class that the workspace has
//       NOT confirmed only adds: a grant takes effect, a narrowing never
//       takes a working action away (pinned over every status × role ×
//       identity); a confirmed one applies in full; the classification the
//       console and 20261263 report.
//   (3) a request with no library and no class decides exactly as before
//       (every status × role × identity, under policies with and without
//       such rules).
//   GAP-101 acceptance 5: the Review Lanes report (lib/reviewLaneReport.ts).
//   20261263: the counts-only inventory's shape (and its defaults pinned to
//   CAPABILITY_DEFS); the PostgreSQL 16 run is rls/dfP19TicketDimensionInventory.test.ts.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({}), channel: () => ({}), auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({}) }));

import { WorkflowEngine, ticketResource, requiresEngineerApproval, engineerApprovalRequired, type WorkflowAction, type WorkflowContext } from "@/lib/workflow";
import { rowToTicket as routeRowToTicket } from "@/lib/ticketTransitions";
import { rowToTicket as inboxRowToTicket } from "@/lib/inbox";
import { fromDbTicket as badgeFromDbTicket, TICKET_ATTENTION_COLUMNS, TICKET_ATTENTION_COLUMN_LADDER, TICKET_ATTENTION_BASE_COLUMNS, TICKET_ATTENTION_LIBRARY_COLUMNS } from "@/hooks/useTicketNotifications";
import { reviewModelFieldsFromRow } from "@/lib/reviewModel";
import {
  CAPABILITY_DEFS, policyAllows, scopedTokensFor, tokensFor, classifyTicketDimensionRule, ticketDimensionRules,
  carryTicketRuleConfirmation, confirmTicketDimensionRule, capabilityRuleKey, ruleInForce, isTicketDimensionRule,
  normalizeCapabilityEntry, validateCapabilityPolicy,
  type CapabilityPolicy, type CapabilityRule, type CapabilityId,
} from "@/lib/capabilityPolicy";
import { engineerPickRefusal } from "@/lib/ticketPage";
import { ALL_ROLES, type Role, type Ticket, type TicketStatus } from "@/types/schema";
import {
  summarizeReviewLanes, reviewLaneOf, filedInPeriod, periodBound, reviewLaneReportCsv, reviewLaneCoverage, REVIEW_LANES,
} from "@/lib/reviewLaneReport";
import { ticketDimensionRuleStatus, splitPolicyForEditor, joinPolicyFromEditor, CODE_CLASS_RULE_CAPS, rulesDecidingBeforeClassRule } from "@/components/permissions/CapabilityPolicyEditor";
import { isActionRequired } from "@/lib/ticketAttention";
import { reviewLaneCoverageNotice } from "@/components/requests/ReviewLaneReport";

const root = process.cwd();
const read = (f: string) => readFileSync(join(root, f), "utf8");
const NOW = "2026-10-22T09:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const OTHER_LIB = "1b000000-0000-4000-8000-000000000002";

// ── The page mappers, taken from the page sources and run as written ────────
// (App Router pages may export only their component, so their mappers stay
// in the files; the test transpiles the `fromRow` closure itself.)
function pageMapper(file: string): (r: Record<string, unknown>) => Ticket {
  const src = read(file);
  const start = src.indexOf("const fromRow = (r: Record<string, unknown>): Ticket => ({");
  expect(start, `${file}: fromRow`).toBeGreaterThan(0);
  const end = src.indexOf("\n    });", start);
  const snippet = src.slice(start, end + "\n    });".length);
  expect(snippet).toContain("...reviewModelFieldsFromRow(r),");
  const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  return new Function("reviewModelFieldsFromRow", `${js}\nreturn fromRow;`)(reviewModelFieldsFromRow) as (r: Record<string, unknown>) => Ticket;
}
const pageFromRow = pageMapper("app/(protected)/requests/[id]/page.tsx");
const listFromRow = pageMapper("app/(protected)/requests/page.tsx");

const MAPPERS: Record<string, (r: Record<string, unknown>) => Ticket> = {
  "workflow route / cron (lib/ticketTransitions.ts rowToTicket)": routeRowToTicket,
  "request page (app/(protected)/requests/[id]/page.tsx fromRow)": pageFromRow,
  "requests list (app/(protected)/requests/page.tsx fromRow)": listFromRow,
  "inbox (lib/inbox.ts rowToTicket)": inboxRowToTicket,
  "attention badge (hooks/useTicketNotifications.ts fromDbTicket)": badgeFromDbTicket,
};

const DRAFT_ROW = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "submitted", rev: "1A" };
const baseRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "Pump iso", unit: "U-100", request_type: "ISO",
  status: "PENDING_REVIEW", requester_id: "req", requester_role: "Viewer", assigned_drafter_id: "drf", assigned_engineer_id: null,
  attachments: [DRAFT_ROW], comments: [], history: [], unread_by: [], watchers: [], revision_count: 0, created_at: NOW, last_modified: NOW,
  ...over,
});
const DIM_ROW = {
  library_id: LIB, work_class: "w-new", code_class: "c-1",
  engineering_required: true, review_model_filed: true,
  like_in_kind_statement: null, like_in_kind_declared_by: null, like_in_kind_declared_at: null, like_in_kind_signature_id: null,
};

const STATUSES: TicketStatus[] = ["PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_IFC", "FINAL_DRAFT", "PENDING_FINAL_APPROVAL", "CLOSED", "CANCELED"];
const IDENTITIES = ["req", "drf", "eng", "stranger"] as const;
const actionKey = (a: WorkflowAction) => JSON.stringify([a.action, a.label, a.disabledReason ?? null, !!a.engineeringOverride, !!a.requiresComment]);
const actionSet = (acts: WorkflowAction[]) => acts.map(actionKey).sort();
const enabled = (acts: WorkflowAction[]) => new Set(acts.filter((a) => !a.disabledReason).map((a) => a.action));
const ctxFor = (role: Role): WorkflowContext => ({ userRoles: [role], activeMemberCount: 5, requesterRoles: ["Viewer"] });

/** Every engine answer for one ticket under one policy. */
function matrix(ticket: Ticket, policy: CapabilityPolicy | undefined): Map<string, WorkflowAction[]> {
  const out = new Map<string, WorkflowAction[]>();
  for (const status of STATUSES) {
    for (const role of ALL_ROLES) {
      for (const uid of IDENTITIES) {
        const t = { ...ticket, status, assignedEngineerId: uid === "eng" ? "eng" : ticket.assignedEngineerId } as Ticket;
        out.set(`${status}|${role}|${uid}`, WorkflowEngine.getActions(t, role, uid, policy, ctxFor(role)));
      }
    }
  }
  return out;
}

// Rules on every request capability, scoped to the ticket's library / classes.
// NARROWING ones (a role of the base list missing, or direct_approve) and
// GRANTING ones (base list plus Drafter / Viewer).
const narrowRules = (when: CapabilityRule["when"]): Record<string, CapabilityRule[]> => Object.fromEntries(
  CAPABILITY_DEFS.filter((d) => d.id.startsWith("ticket.")).map((d) => [d.id, [
    { tokens: d.critical ? ["Admin"] : ["Engineer-3"], when },
    { tokens: d.defaultRoles },
  ]]),
);
const grantRules = (when: CapabilityRule["when"]): Record<string, CapabilityRule[]> => Object.fromEntries(
  CAPABILITY_DEFS.filter((d) => d.id.startsWith("ticket.") && d.id !== "ticket.direct_approve").map((d) => [d.id, [
    { tokens: [...d.defaultRoles, "Drafter", "Viewer"], when },
    { tokens: d.defaultRoles },
  ]]),
);
const confirmAll = (caps: Record<string, CapabilityRule[]>) => Object.fromEntries(
  Object.entries(caps).map(([k, v]) => [k, v.map((r) => (r.when ? { ...r, confirmedAt: NOW, confirmedBy: "admin" } : r))]),
);
const WHENS: Array<CapabilityRule["when"]> = [{ libraryId: [LIB] }, { workClass: ["w-new"] }, { codeClass: ["c-1"] }, { libraryId: [LIB], requestType: ["ISO"] }];

describe("DEC-90 ruling (1) — every mapper that builds a request for the engine presents the same resource", () => {
  for (const row of [baseRow(DIM_ROW), baseRow(), baseRow({ ...DIM_ROW, library_id: null, work_class: null, code_class: null }), baseRow({ engineering_required: false, review_model_filed: false })]) {
    it(`one row → one resource and one engineering gate (${row.library_id ? "with" : "without"} a library, ${row.engineering_required === undefined ? "before 20261250" : "after"})`, () => {
      const resources = Object.entries(MAPPERS).map(([name, m]) => [name, ticketResource(m(row))] as const);
      for (const [name, res] of resources) expect(res, name).toStrictEqual(resources[0][1]);
      expect(resources[0][1]).toStrictEqual({
        requestType: "ISO", unit: "U-100",
        libraryId: (row.library_id as string | undefined) ?? null, workClass: (row.work_class as string | undefined) ?? null, codeClass: (row.code_class as string | undefined) ?? null,
      });
      const gate = (t: Ticket) => JSON.stringify([t.engineeringRequired, t.reviewModelFiled, t.likeInKindStatement, t.likeInKindDeclaredAt, t.libraryId, t.workClass, t.codeClass]);
      for (const [name, m] of Object.entries(MAPPERS)) expect(gate(m(row)), name).toBe(gate(routeRowToTicket(row)));
    });
  }

  it("the page, the list, the inbox, the badge and the route decide alike — every status × role × identity, under scoped rules confirmed and not, and none", () => {
    const row = baseRow(DIM_ROW);
    const policies: Array<CapabilityPolicy | undefined> = [
      undefined,
      { caps: narrowRules({ libraryId: [LIB] }) },
      { caps: confirmAll(narrowRules({ codeClass: ["c-1"] })) },
      { caps: grantRules({ workClass: ["w-new"] }) },
    ];
    for (const policy of policies) {
      const reference = matrix(routeRowToTicket(row), policy);
      for (const [name, m] of Object.entries(MAPPERS)) {
        const got = matrix(m(row), policy);
        for (const [k, acts] of reference) expect(actionSet(got.get(k)!), `${name} ${k}`).toEqual(actionSet(acts));
      }
    }
  });

  it("source pins: every mapper spreads reviewModelFieldsFromRow (the one mapper of the library, the classes and the review-model columns)", () => {
    expect(read("lib/ticketTransitions.ts")).toContain("...reviewModelFieldsFromRow(row),");
    expect(read("lib/inbox.ts")).toContain("...reviewModelFieldsFromRow(r),");
    expect(read("hooks/useTicketNotifications.ts")).toContain("...reviewModelFieldsFromRow(row),");
    expect(read("app/(protected)/requests/page.tsx")).toContain("...reviewModelFieldsFromRow(r),");
    expect(read("app/(protected)/requests/[id]/page.tsx")).toContain("...reviewModelFieldsFromRow(r),");
    // the server routes that evaluate a request read it through rowToTicket or present the same fields
    expect(read("app/api/tickets/workflow-action/route.ts")).toMatch(/rowToTicket\(/);
    expect(read("app/api/tickets/equipment/route.ts")).toContain("libraryId: t.library_id ?? null, workClass: t.work_class ?? null, codeClass: t.code_class ?? null");
  });

  it("the badge reads the columns the mapper needs, falling back a rung at a time (no 20261250, then no 20261208, then '*') — never comments / history", () => {
    for (const col of ["library_id", "engineering_required", "review_model_filed", "like_in_kind_statement", "like_in_kind_declared_at", "work_class", "code_class"]) {
      expect(TICKET_ATTENTION_COLUMNS).toContain(col);
    }
    expect(TICKET_ATTENTION_COLUMN_LADDER).toEqual([TICKET_ATTENTION_COLUMNS, TICKET_ATTENTION_LIBRARY_COLUMNS, TICKET_ATTENTION_BASE_COLUMNS, "*"]);
    expect(TICKET_ATTENTION_BASE_COLUMNS).toBe("id, org_id, ticket_id, title, status, unit, request_type, requester_id, requester_role, assigned_drafter_id, assigned_engineer_id, attachments, unread_by, created_at, last_modified");
    expect(TICKET_ATTENTION_COLUMNS).not.toMatch(/comments|history|\*/);
  });
});

describe("DEC-90 ruling (3) — a request with no library and no class decides exactly as today", () => {
  const dimless = routeRowToTicket(baseRow({ ...DIM_ROW, library_id: null, work_class: null, code_class: null }));
  const prePaste = routeRowToTicket(baseRow());
  it("its resource presents null for the three keys, so no scoped rule can match it", () => {
    expect(ticketResource(dimless)).toMatchObject({ libraryId: null, workClass: null, codeClass: null });
    expect(ticketResource(prePaste)).toMatchObject({ libraryId: null, workClass: null, codeClass: null });
  });
  for (const when of WHENS) {
    it(`every status × role × identity: a policy holding rules scoped to ${JSON.stringify(when)} (narrowing and granting, confirmed and not) answers as the same policy without them`, () => {
      const typeRule = { "ticket.reopen": [{ tokens: ["Admin"], when: { requestType: ["ISO"] } }, { tokens: ["Admin", "Manager", "Supervisor"] }] };
      const without: CapabilityPolicy = { caps: typeRule };
      for (const t of [dimless, prePaste]) {
        const reference = matrix(t, without);
        for (const caps of [narrowRules(when), confirmAll(narrowRules(when)), grantRules(when), confirmAll(grantRules(when))]) {
          const got = matrix(t, { caps: { ...caps, ...typeRule } });
          for (const [k, acts] of reference) expect(actionSet(got.get(k)!), k).toEqual(actionSet(acts));
        }
      }
    });
  }
});

describe("DEC-90 ruling (2) — an unconfirmed library / class rule only adds; a confirmed one applies in full", () => {
  const dimTicket = routeRowToTicket(baseRow(DIM_ROW));
  const otherLib = routeRowToTicket(baseRow({ ...DIM_ROW, library_id: OTHER_LIB, work_class: "w-other", code_class: "c-other" }));

  for (const when of WHENS) {
    it(`NO working action is taken away by an unconfirmed narrowing rule scoped to ${JSON.stringify(when)} (every status × role × identity)`, () => {
      const before = matrix(dimTicket, undefined);
      const after = matrix(dimTicket, { caps: narrowRules(when) });
      for (const [k, acts] of before) {
        const now = enabled(after.get(k)!);
        for (const a of enabled(acts)) expect(now.has(a), `${k} lost ${a}`).toBe(true);
      }
    });
  }

  it("the same narrowing rule CONFIRMED does take actions away where it matches — and nowhere else", () => {
    const confirmed: CapabilityPolicy = { caps: confirmAll(narrowRules({ libraryId: [LIB] })) };
    const before = matrix(dimTicket, undefined);
    const after = matrix(dimTicket, confirmed);
    let lost = 0;
    for (const [k, acts] of before) for (const a of enabled(acts)) if (!enabled(after.get(k)!).has(a)) lost++;
    expect(lost).toBeGreaterThan(0);
    const elsewhere = matrix(otherLib, confirmed);
    const elsewhereBefore = matrix(otherLib, undefined);
    for (const [k, acts] of elsewhereBefore) expect(actionSet(elsewhere.get(k)!), k).toEqual(actionSet(acts));
  });

  it("an unconfirmed GRANT takes effect at once (someone gains an action where it matches)", () => {
    const before = matrix(dimTicket, undefined);
    const after = matrix(dimTicket, { caps: grantRules({ libraryId: [LIB] }) });
    let gained = 0;
    for (const [k, acts] of before) for (const a of enabled(after.get(k)!)) if (!enabled(acts).has(a)) gained++;
    expect(gained).toBeGreaterThan(0);
    expect(policyAllows({ caps: grantRules({ libraryId: [LIB] }) }, "ticket.assign", "Drafter", null, null, ticketResource(dimTicket))).toBe(true);
    expect(policyAllows(undefined, "ticket.assign", "Drafter", null, null, ticketResource(dimTicket))).toBe(false);
  });

  it("policyAllows / tokensFor / scopedTokensFor: unconfirmed narrowing keeps the old answer and the old 'scoped' state; confirmed replaces", () => {
    const rule = { tokens: ["Engineer-3"], when: { libraryId: [LIB] } };
    const pending: CapabilityPolicy = { caps: { "ticket.direct_approve": [rule, { tokens: ["Engineer"] }] } };
    const confirmed: CapabilityPolicy = { caps: { "ticket.direct_approve": [{ ...rule, confirmedAt: NOW }, { tokens: ["Engineer"] }] } };
    const res = ticketResource(dimTicket);
    expect(policyAllows(pending, "ticket.direct_approve", "Engineer-2", null, null, res)).toBe(true);
    expect(policyAllows(confirmed, "ticket.direct_approve", "Engineer-2", null, null, res)).toBe(false);
    expect(policyAllows(confirmed, "ticket.direct_approve", "Engineer-3", null, null, res)).toBe(true);
    expect(tokensFor(pending, "ticket.direct_approve", res).sort()).toEqual(["Engineer", "Engineer-3"]);
    // no request-type rule applied before, so the requester is not "scoped out" by an unconfirmed rule
    expect(scopedTokensFor(pending, "ticket.direct_approve", res)).toBeNull();
    expect(scopedTokensFor(confirmed, "ticket.direct_approve", res)).toEqual(["Engineer-3"]);
    // behind a request-type rule that applied before: the old scoped list, joined
    const typed: CapabilityPolicy = { caps: { "ticket.direct_approve": [rule, { tokens: ["DocCtrl"], when: { requestType: ["ISO"] } }, { tokens: ["Engineer"] }] } };
    expect(scopedTokensFor(typed, "ticket.direct_approve", res)?.sort()).toEqual(["DocCtrl", "Engineer-3"]);
    // a capability that is not a request capability is untouched: a library rule there binds as it always did
    const tx: CapabilityPolicy = { caps: { "transmittal.issue": [{ tokens: ["Admin"], when: { libraryId: [LIB] } }, { tokens: ["Admin", "DocCtrl"] }] } };
    expect(policyAllows(tx, "transmittal.issue", "DocCtrl", null, null, { libraryId: LIB })).toBe(false);
  });

  it("the requester's own approval is not scoped out by an unconfirmed library rule on direct approval; it is once confirmed", () => {
    const rule = { tokens: ["Engineer-3"], when: { libraryId: [LIB] } };
    const t = { ...dimTicket, status: "PENDING_REVIEW", engineeringRequired: false, likeInKindStatement: "same gasket", likeInKindDeclaredAt: NOW, likeInKindDeclaredBy: "req" } as Ticket;
    const offered = (p: CapabilityPolicy) => enabled(WorkflowEngine.getActions(t, "Viewer", "req", p, ctxFor("Viewer" as Role))).has("approve_draft_ifc");
    expect(offered({})).toBe(true);
    expect(offered({ caps: { "ticket.direct_approve": [rule, { tokens: ["Engineer"] }] } })).toBe(true);
    expect(offered({ caps: { "ticket.direct_approve": [{ ...rule, confirmedAt: NOW }, { tokens: ["Engineer"] }] } })).toBe(false);
  });

  it("the engineer pick: an unconfirmed narrowing rule refuses nobody it did not refuse before; a confirmed one does", () => {
    const rule = { tokens: ["Engineer-3"], when: { codeClass: ["c-1"] } };
    const res = ticketResource(dimTicket);
    expect(engineerPickRefusal(["Engineer-2"], { caps: { "ticket.final_approve": [rule, { tokens: ["Engineer"] }] } }, "ticket.final_approve", "e2", res)).toBeNull();
    expect(engineerPickRefusal(["Engineer-2"], { caps: { "ticket.final_approve": [{ ...rule, confirmedAt: NOW }, { tokens: ["Engineer"] }] } }, "ticket.final_approve", "e2", res)).toMatch(/outside the group/);
  });
});

describe("fix pass (review major 2) — on ticket.engineer_gate_exempt an unconfirmed library / class rule does nothing", () => {
  const EXEMPT_DEFAULTS = CAPABILITY_DEFS.find((d) => d.id === "ticket.engineer_gate_exempt")!.defaultRoles;
  // a pre-DF-P6 widening: Viewers and Requesters filing in library L would skip engineer sign-off
  const widen: CapabilityRule = { tokens: [...EXEMPT_DEFAULTS, "Viewer", "Requester"], when: { libraryId: [LIB] } };
  const pending: CapabilityPolicy = { caps: { "ticket.engineer_gate_exempt": [widen, { tokens: [...EXEMPT_DEFAULTS] }] } };
  const confirmed: CapabilityPolicy = { caps: { "ticket.engineer_gate_exempt": [{ ...widen, confirmedAt: NOW, confirmedBy: "admin" }, { tokens: [...EXEMPT_DEFAULTS] }] } };
  // the legacy path: filed before the review model, so the role-based gate decides
  const legacy = routeRowToTicket(baseRow({ ...DIM_ROW, engineering_required: false, review_model_filed: false }));
  const res = ticketResource(legacy);

  it("an unconfirmed widening changes no engineer-approval answer (requiresEngineerApproval / engineerApprovalRequired)", () => {
    for (const role of ALL_ROLES) {
      expect(requiresEngineerApproval(role, [role], pending, "req", res), role).toBe(requiresEngineerApproval(role, [role], undefined, "req", res));
      expect(engineerApprovalRequired(role, [role], pending, "req", res), role).toBe(engineerApprovalRequired(role, [role], undefined, "req", res));
    }
    expect(requiresEngineerApproval("Viewer", ["Viewer"], pending, "req", res)).toBe(true);
    expect(tokensFor(pending, "ticket.engineer_gate_exempt", res).sort()).toEqual([...EXEMPT_DEFAULTS].sort());
    expect(scopedTokensFor(pending, "ticket.engineer_gate_exempt", res)).toBeNull();
    // once an Admin confirms it, it applies
    expect(requiresEngineerApproval("Viewer", ["Viewer"], confirmed, "req", res)).toBe(false);
  });

  it("every status × role × identity: the engine answers as without the rule (Viewer requester on the legacy path)", () => {
    const before = matrix(legacy, undefined);
    const after = matrix(legacy, pending);
    for (const [k, acts] of before) expect(actionSet(after.get(k)!), k).toEqual(actionSet(acts));
    // the fixture does reach the gate: the same rule CONFIRMED changes answers
    const conf = matrix(legacy, confirmed);
    expect([...before].some(([k, acts]) => JSON.stringify(actionSet(conf.get(k)!)) !== JSON.stringify(actionSet(acts)))).toBe(true);
  });

  it("an unconfirmed narrowing there does nothing either (no join), and a later in-force rule still decides", () => {
    const narrow: CapabilityPolicy = { caps: { "ticket.engineer_gate_exempt": [{ tokens: ["Admin"], when: { libraryId: [LIB] } }, { tokens: ["DocCtrl"], when: { requestType: ["ISO"] } }, { tokens: [...EXEMPT_DEFAULTS] }] } };
    expect(scopedTokensFor(narrow, "ticket.engineer_gate_exempt", res)).toEqual(["DocCtrl"]);
  });

  it("classification: any such rule is NARROW (confirm first) unless its roles are exactly the base list; the console says it is not in force", () => {
    expect(classifyTicketDimensionRule(undefined, "ticket.engineer_gate_exempt", widen)).toBe("narrow");
    expect(classifyTicketDimensionRule(undefined, "ticket.engineer_gate_exempt", { tokens: ["*"], when: { libraryId: [LIB] } })).toBe("narrow");
    expect(classifyTicketDimensionRule(undefined, "ticket.engineer_gate_exempt", { tokens: ["Admin"], when: { codeClass: ["c"] } })).toBe("narrow");
    expect(classifyTicketDimensionRule(undefined, "ticket.engineer_gate_exempt", { tokens: [...EXEMPT_DEFAULTS].reverse(), when: { workClass: ["w"] } })).toBe("same");
    const [state] = ticketDimensionRules(pending);
    expect(state).toMatchObject({ cap: "ticket.engineer_gate_exempt", inForce: false, effect: "narrow" });
    expect(ticketDimensionRuleStatus(state)).toBe("Not in force until an Admin confirms it — it changes whose own requests skip engineer sign-off");
  });
});

describe("fix pass (review minor 3) — an unconfirmed rule never shadows a later confirmed one", () => {
  const dimTicket = routeRowToTicket(baseRow(DIM_ROW));
  const res = ticketResource(dimTicket);
  const policy: CapabilityPolicy = { caps: { "ticket.final_approve": [
    { tokens: ["Engineer-3"], when: { libraryId: [LIB] } },                                   // unconfirmed (only adds)
    { tokens: ["Engineer-4"], when: { codeClass: ["c-1"] }, confirmedAt: NOW, confirmedBy: "admin" }, // confirmed: "In force"
    { tokens: ["Engineer"] },
  ] } };
  it("the scan goes on past the unconfirmed rule: the confirmed code-class rule decides, joined with the unconfirmed rule's tokens", () => {
    expect(scopedTokensFor(policy, "ticket.final_approve", res)?.sort()).toEqual(["Engineer-3", "Engineer-4"]);
    expect(policyAllows(policy, "ticket.final_approve", "Engineer-2", null, null, res)).toBe(false);
    expect(policyAllows(policy, "ticket.final_approve", "Engineer-4", null, null, res)).toBe(true);
    expect(policyAllows(policy, "ticket.final_approve", "Engineer-3", null, null, res)).toBe(true);
    expect(engineerPickRefusal(["Engineer-2"], policy, "ticket.final_approve", "e2", res)).toMatch(/outside the group/);
    // the console calls the confirmed rule "In force", and the evaluator agrees
    expect(ticketDimensionRules(policy).map((s) => s.inForce)).toEqual([false, true]);
    // where only the unconfirmed rule matches, the base answer (joined) still stands
    const otherClass = { ...res, codeClass: "c-other" };
    expect(policyAllows(policy, "ticket.final_approve", "Engineer-2", null, null, otherClass)).toBe(true);
  });
});

describe("fix pass (review minor 4) — a grid save keeps the stored order of conditional rules", () => {
  const stored: CapabilityPolicy = { caps: { "ticket.assign": [
    { tokens: ["Admin", "Manager", "Supervisor", "DraftingSupervisor"] },
    { tokens: ["DraftingSupervisor"], when: { libraryId: [LIB] }, confirmedAt: NOW, confirmedBy: "a1" },
    { tokens: ["Manager"], when: { requestType: ["ISO", "MOC"] } },
    { tokens: ["Admin"], when: { unit: ["U-100"] } },
  ] } };
  it("toggling an unrelated cell leaves the library rule ahead of the ISO rule (and its stamp on it)", () => {
    const s = splitPolicyForEditor(stored);
    const base = { ...s.base, "ticket.assign": ["Admin", "Manager"] };
    const j = joinPolicyFromEditor(base, s.overrides, s.opaque, s.projectOverrides, stored);
    expect(j["ticket.assign"]).toEqual([
      { tokens: ["Admin", "Manager"] },
      { tokens: ["DraftingSupervisor"], when: { libraryId: [LIB] }, confirmedAt: NOW, confirmedBy: "a1" },
      { tokens: ["Manager"], when: { requestType: ["ISO"] } },
      { tokens: ["Manager"], when: { requestType: ["MOC"] } },
      { tokens: ["Admin"], when: { unit: ["U-100"] } },
    ]);
    // ISO requests in L are still assigned by the library rule's list
    const res = { requestType: "ISO", unit: "U-1", libraryId: LIB, workClass: null, codeClass: null };
    expect(tokensFor({ caps: j }, "ticket.assign", res)).toEqual(["DraftingSupervisor"]);
    // without the stored order (the old layout) the ISO row would have moved ahead of it
    const old = joinPolicyFromEditor(base, s.overrides, s.opaque, s.projectOverrides);
    expect(tokensFor({ caps: old }, "ticket.assign", res)).toEqual(["Manager"]);
  });
  it("an edited row keeps its place, a removed one drops out, a new one goes last; a loaded-then-saved grid is the stored entry", () => {
    const s = splitPolicyForEditor(stored);
    const overrides = { ...s.overrides, "ticket.assign": [{ type: "MOC", tokens: ["Supervisor"] }, { type: "NEW", tokens: ["Admin"] }] };
    const j = joinPolicyFromEditor(s.base, overrides, s.opaque, s.projectOverrides, stored);
    expect((j["ticket.assign"] as CapabilityRule[]).map((r) => JSON.stringify(r.when ?? null))).toEqual([
      "null", JSON.stringify({ libraryId: [LIB] }), JSON.stringify({ requestType: ["MOC"] }), JSON.stringify({ unit: ["U-100"] }), JSON.stringify({ requestType: ["NEW"] }),
    ]);
    const canonical = joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides, stored);
    const again = splitPolicyForEditor({ caps: canonical });
    expect(joinPolicyFromEditor(again.base, again.overrides, again.opaque, again.projectOverrides, { caps: canonical })).toEqual(canonical);
  });
  it("the editor passes the stored policy on every join (load baseline, save, conflict re-read)", () => {
    const editor = read("components/permissions/CapabilityPolicyEditor.tsx");
    // second fix pass: and the code-class rows on every join
    expect(editor).toContain("joinPolicyFromEditor(split.base, split.overrides, split.opaque, split.projectOverrides, stored, split.codeClassOverrides)");
    expect(editor).toContain("joinPolicyFromEditor(policy, overrides, opaque, projectOverrides, storedPolicy, codeClassOverrides)");
    expect(editor).toContain("joinPolicyFromEditor(s2.base, s2.overrides, s2.opaque, s2.projectOverrides, fresh.policy, s2.codeClassOverrides)");
  });
});

describe("DF-P19 — the rule's state: classification, confirmation, the server-owned stamp", () => {
  const cap: CapabilityId = "ticket.assign";
  it("classify: narrow / grant / same against the base list and the request-type rules; direct approval narrows unless '*'", () => {
    const base = (extra: CapabilityRule[] = []): CapabilityPolicy => ({ caps: { [cap]: [...extra, { tokens: ["Admin", "Manager"] }] } });
    expect(classifyTicketDimensionRule(base(), cap, { tokens: ["Admin"], when: { libraryId: [LIB] } })).toBe("narrow");
    expect(classifyTicketDimensionRule(base(), cap, { tokens: ["Admin", "Manager", "Drafter"], when: { libraryId: [LIB] } })).toBe("grant");
    expect(classifyTicketDimensionRule(base(), cap, { tokens: ["Manager", "Admin"], when: { workClass: ["w"] } })).toBe("same");
    expect(classifyTicketDimensionRule(base([{ tokens: ["DocCtrl"], when: { requestType: ["ISO"] } }]), cap, { tokens: ["Admin", "Manager"], when: { codeClass: ["c"] } })).toBe("narrow");
    expect(classifyTicketDimensionRule(base(), cap, { tokens: ["*"], when: { libraryId: [LIB] } })).toBe("grant");
    expect(classifyTicketDimensionRule(undefined, "ticket.direct_approve", { tokens: ["Engineer", "Drafter"], when: { libraryId: [LIB] } })).toBe("narrow");
    expect(classifyTicketDimensionRule(undefined, "ticket.direct_approve", { tokens: ["*"], when: { libraryId: [LIB] } })).toBe("grant");
    // absent entry: the shipped default is the base
    expect(classifyTicketDimensionRule(undefined, "ticket.reopen", { tokens: ["Admin", "Manager", "Supervisor"], when: { libraryId: [LIB] } })).toBe("same");
  });

  it("what counts as a dimension rule, and when it is in force", () => {
    expect(isTicketDimensionRule("ticket.assign", { tokens: ["Admin"], when: { libraryId: [LIB] } })).toBe(true);
    expect(isTicketDimensionRule("ticket.assign", { tokens: ["Admin"], when: { requestType: ["ISO"] } })).toBe(false);
    expect(isTicketDimensionRule("transmittal.issue", { tokens: ["Admin"], when: { libraryId: [LIB] } })).toBe(false);
    expect(ruleInForce("ticket.assign", { tokens: ["Admin"], when: { libraryId: [LIB] } })).toBe(false);
    expect(ruleInForce("ticket.assign", { tokens: ["Admin"], when: { libraryId: [LIB] }, confirmedAt: NOW })).toBe(true);
    expect(ruleInForce("ticket.assign", { tokens: ["Admin"], when: { requestType: ["ISO"] } })).toBe(true);
  });

  it("the stamp survives a stored round trip (normalizeCapabilityEntry) and is not part of the rule's identity", () => {
    const stored = normalizeCapabilityEntry([{ tokens: ["Admin"], when: { libraryId: [LIB] }, confirmedAt: NOW, confirmedBy: "a1", junk: 1 }, { tokens: ["Admin"] }]) as CapabilityRule[];
    expect(stored[0]).toEqual({ tokens: ["Admin"], when: { libraryId: [LIB] }, confirmedAt: NOW, confirmedBy: "a1" });
    expect(capabilityRuleKey(stored[0])).toBe(capabilityRuleKey({ tokens: ["Admin"], when: { libraryId: [LIB] } }));
    expect(validateCapabilityPolicy({ caps: { [cap]: stored } })).toBeNull();
  });

  it("carry: a stored rule keeps its stamp (or none), a new one is stamped, a client's stamp is ignored, other rules carry none", () => {
    const stored = { [cap]: [{ tokens: ["Admin"], when: { libraryId: [LIB] } }, { tokens: ["Admin"], when: { workClass: ["w"] }, confirmedAt: "2026-10-01T00:00:00.000Z", confirmedBy: "a0" }, { tokens: ["Admin", "Manager"] }] } as CapabilityPolicy["caps"];
    const incoming = { [cap]: [
      { tokens: ["Admin"], when: { libraryId: [LIB] }, confirmedAt: NOW },                  // forged stamp on a stored rule
      { tokens: ["Admin"], when: { workClass: ["w"] } },                                    // stored, confirmed — the client dropped the stamp
      { tokens: ["Admin", "Drafter"], when: { codeClass: ["c"] } },                         // new
      { tokens: ["DocCtrl"], when: { requestType: ["ISO"] }, confirmedAt: NOW },            // not a dimension rule
      { tokens: ["Admin", "Manager"] },
    ] } as CapabilityPolicy["caps"];
    const out = carryTicketRuleConfirmation(incoming, stored, { at: NOW, by: "a1" }, true);
    const rules = out.caps[cap] as CapabilityRule[];
    expect(rules[0]).toEqual({ tokens: ["Admin"], when: { libraryId: [LIB] } });
    expect(rules[1]).toEqual({ tokens: ["Admin"], when: { workClass: ["w"] }, confirmedAt: "2026-10-01T00:00:00.000Z", confirmedBy: "a0" });
    expect(rules[2]).toEqual({ tokens: ["Admin", "Drafter"], when: { codeClass: ["c"] }, confirmedAt: NOW, confirmedBy: "a1" });
    expect(rules[3]).toEqual({ tokens: ["DocCtrl"], when: { requestType: ["ISO"] } });
    expect(out.confirmed).toEqual([{ cap, rule: { tokens: ["Admin", "Drafter"], when: { codeClass: ["c"] } } }]);
  });

  it("second fix pass (review minor 3): a NEW rule saved by a non-Admin is stored UNCONFIRMED — so delete-then-re-add confirms nothing", () => {
    const R: CapabilityRule = { tokens: ["Engineer-3"], when: { libraryId: [LIB] } };
    const base: CapabilityRule = { tokens: ["Admin", "Manager"] };
    const stored = { [cap]: [R, base] } as CapabilityPolicy["caps"];
    // one save without R (allowed on a non-critical capability), then one with R back
    const removed = carryTicketRuleConfirmation({ [cap]: [base] } as CapabilityPolicy["caps"], stored, { at: NOW, by: "c1" }, false);
    expect(removed.caps[cap]).toEqual([base]);
    const readded = carryTicketRuleConfirmation({ [cap]: [R, base] } as CapabilityPolicy["caps"], removed.caps, { at: NOW, by: "c1" }, false);
    expect((readded.caps[cap] as CapabilityRule[])[0]).toEqual(R);            // no stamp
    expect(readded.confirmed).toEqual([]);
    expect(readded.unconfirmedNew).toEqual([{ cap, rule: R }]);
    expect(ruleInForce(cap, (readded.caps[cap] as CapabilityRule[])[0])).toBe(false);
    // the console names it as not in force (a narrowing on direct approval)
    const [state] = ticketDimensionRules({ caps: readded.caps });
    expect(ticketDimensionRuleStatus(state)).toBe("Not yet in force where it would take an action away — confirm to apply");
    // a stored, confirmed rule keeps its stamp on a non-Admin's save
    const confirmedStored = { [cap]: [{ ...R, confirmedAt: "2026-10-01T00:00:00.000Z", confirmedBy: "a0" }, base] } as CapabilityPolicy["caps"];
    expect((carryTicketRuleConfirmation({ [cap]: [R, base] } as CapabilityPolicy["caps"], confirmedStored, { at: NOW, by: "c1" }, false).caps[cap] as CapabilityRule[])[0].confirmedBy).toBe("a0");
    // an Admin's save of the same new rule confirms it
    expect(carryTicketRuleConfirmation({ [cap]: [R, base] } as CapabilityPolicy["caps"], removed.caps, { at: NOW, by: "a1" }, true).confirmed).toHaveLength(1);
  });

  it("confirm: one stored unconfirmed rule, by its key; an unknown or confirmed one is refused", () => {
    const caps = { [cap]: [{ tokens: ["Admin"], when: { libraryId: [LIB] } }, { tokens: ["Admin", "Manager"] }] } as CapabilityPolicy["caps"];
    const key = capabilityRuleKey({ tokens: ["Admin"], when: { libraryId: [LIB] } });
    const ok = confirmTicketDimensionRule(caps, cap, key, { at: NOW, by: "a1" });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect((ok.caps[cap] as CapabilityRule[])[0]).toEqual({ tokens: ["Admin"], when: { libraryId: [LIB] }, confirmedAt: NOW, confirmedBy: "a1" });
    expect(confirmTicketDimensionRule(ok.caps, cap, key, { at: NOW, by: "a1" })).toMatchObject({ ok: false, error: /already in force/ });
    expect(confirmTicketDimensionRule(caps, cap, "nope", { at: NOW, by: "a1" }).ok).toBe(false);
  });

  it("the console lists every such rule with its state and the words it shows", () => {
    const policy: CapabilityPolicy = { caps: { [cap]: [{ tokens: ["Admin"], when: { libraryId: [LIB] } }, { tokens: ["Admin", "Manager", "Drafter"], when: { workClass: ["w"] } }, { tokens: ["Admin"], when: { codeClass: ["c"] }, confirmedAt: NOW }, { tokens: ["Admin", "Manager"] }] } };
    const states = ticketDimensionRules(policy);
    expect(states.map((s) => [s.inForce, s.effect])).toEqual([[false, "narrow"], [false, "grant"], [true, "narrow"]]);
    expect(states.map(ticketDimensionRuleStatus)).toEqual([
      "Not yet in force where it would take an action away — confirm to apply",
      "In force (it only adds people) — not yet confirmed",
      "In force",
    ]);
    const editor = read("components/permissions/CapabilityPolicyEditor.tsx");
    expect(editor).toContain('data-testid="ticket-dimension-rules"');
    expect(editor).toContain('hasAnyRole(["Admin"])');
    expect(editor).toContain("await confirmCapabilityRule({ orgId: activeOrgId, cap: r.cap, rule: r.rule });");
  });

  it("the policy route no longer refuses a new library / class-scoped request rule; it carries the confirmation and offers confirm_rule (Admin only)", () => {
    const route = read("app/api/admin/capability-policy/route.ts");
    expect(route).not.toMatch(/newDeadTicketRuleRefusal\(/);
    expect(route).toContain("carryTicketRuleConfirmation(caps, before.caps, { at: nowIso, by: caller.id }, isAdmin)");
    expect(route).toContain('if (!isAdmin) return bad("Only an Admin may confirm a permission rule", 403);');
    // a class-scoped rule on a critical capability is a change (canonicalEntry reads every rule key)
    expect(route).toContain("const keys = RULE_KEYS.filter((k) => (r.when?.[k]?.length ?? 0) > 0);");
  });
});

describe("GAP-101 acceptance 5 — the Review Lanes report (read-only, from what the ticket records)", () => {
  const t = (over: Partial<Ticket>): Ticket => ({ id: "x", ticketId: "REQ-x", title: "T", status: "CLOSED", createdAt: "2026-10-05T10:00:00.000Z", requesterId: "req", requesterName: "Rae Q", ...over } as Ticket);
  const rows = [
    t({ id: "1", ticketId: "REQ-1", engineeringRequired: true, workClass: "new", codeClass: "c1" }),
    t({ id: "2", ticketId: "REQ-2", engineeringRequired: false, likeInKindStatement: "Same gasket", likeInKindDeclaredBy: "req", likeInKindDeclaredAt: "2026-10-05T10:00:00.000Z", workClass: "lik", codeClass: "c1" }),
    t({ id: "3", ticketId: "REQ-3", engineeringRequired: false }),
    t({ id: "4", ticketId: "REQ-4" }),
    t({ id: "5", ticketId: "REQ-5", createdAt: "2026-09-01T10:00:00.000Z", engineeringRequired: false, likeInKindStatement: "=HYPERLINK(\"x\")", likeInKindDeclaredBy: "someone-else", likeInKindDeclaredAt: "2026-09-01T10:00:00.000Z" }),
    // fix pass (review major 1): declared like-in-kind, then raised to engineering review at triage
    // (a class marked "Requires engineering", or flag_engineering) — the engine reviews it as engineered
    t({ id: "6", ticketId: "REQ-6", engineeringRequired: true, likeInKindStatement: "Same valve", likeInKindDeclaredBy: "req", likeInKindDeclaredAt: "2026-10-05T11:00:00.000Z", workClass: "lik", codeClass: "c2" }),
  ];
  it("lanes come from the recorded columns, in the engine's order; they add up to the period's total", () => {
    expect(rows.map(reviewLaneOf)).toEqual(["engineered", "like_in_kind", "legacy_gate", "not_recorded", "like_in_kind", "engineered"]);
    const all = summarizeReviewLanes(rows, { from: null, to: null });
    expect(all.total).toBe(6);
    expect(REVIEW_LANES.reduce((n, l) => n + all.lanes[l], 0)).toBe(6);
    expect(all.lanes).toEqual({ engineered: 2, like_in_kind: 2, legacy_gate: 1, not_recorded: 1 });
    // every declaration is listed, whatever its lane; the overridden one says so
    expect(all.declarations.map((d) => d.ticketId)).toEqual(["REQ-5", "REQ-2", "REQ-6"]);
    expect(all.declarations[1]).toMatchObject({ declaredBy: "req", declaredByName: "Rae Q", statement: "Same gasket", workClass: "lik", codeClass: "c1", lane: "like_in_kind", overridden: false });
    expect(all.declarations[2]).toMatchObject({ statement: "Same valve", lane: "engineered", overridden: true });
    expect(all.declarations[0].declaredByName).toBeNull();
    expect(all.byCodeClass).toEqual([{ value: "c1", count: 2 }, { value: "c2", count: 1 }, { value: null, count: 3 }]);
  });
  it("the lane is the engine's: engineering_required true wins over a declaration, exactly as ticketEngineeringRequired decides", async () => {
    const { ticketEngineeringRequired } = await import("@/lib/reviewModel");
    for (const r of rows) {
      const lane = reviewLaneOf(r);
      if (lane === "engineered") expect(ticketEngineeringRequired(r, () => false), r.ticketId).toBe(true);
      if (lane === "like_in_kind") expect(ticketEngineeringRequired(r, () => true), r.ticketId).toBe(false);
    }
  });
  it("any period: inclusive UTC filing dates, either end open; a bad bound is no bound", () => {
    const oct = summarizeReviewLanes(rows, { from: "2026-10-01", to: "2026-10-31" });
    expect(oct.total).toBe(5);
    expect(oct.lanes).toEqual({ engineered: 2, like_in_kind: 1, legacy_gate: 1, not_recorded: 1 });
    expect(summarizeReviewLanes(rows, { from: "2026-10-06", to: null }).total).toBe(0);
    expect(summarizeReviewLanes(rows, { from: null, to: "2026-09-01" }).total).toBe(1);
    expect(periodBound("2026-13-45x")).toBeNull();
    expect(filedInPeriod(t({ createdAt: "garbage" }), { from: null, to: null })).toBe(true);
    expect(filedInPeriod(t({ createdAt: "garbage" }), { from: "2026-01-01", to: null })).toBe(false);
  });
  it("the CSV encodes every cell through lib/csvSafe (a formula-leading statement is text)", () => {
    const csv = reviewLaneReportCsv(summarizeReviewLanes(rows, { from: null, to: null }), (k, v) => `${k}:${v}`);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain("REQ-2,T,CLOSED,2026-10-05,2026-10-05T10:00:00.000Z,Rae Q,Same gasket,workClasses:lik,codeClasses:c1,No");
    expect(csv).toContain("REQ-6,T,CLOSED,2026-10-05,2026-10-05T11:00:00.000Z,Rae Q,Same valve,workClasses:lik,codeClasses:c2,Yes");
    expect(read("lib/reviewLaneReport.ts")).toContain('import { csvLine } from "@/lib/csvSafe";');
  });
  it("fix pass (review minor 5): the load is newest first with an exact count — a cut at the row limit is said, and a period after the oldest loaded date is complete", () => {
    const loaded = [t({ createdAt: "2026-10-20T10:00:00.000Z" }), t({ createdAt: "2026-10-03T10:00:00.000Z" }), t({ createdAt: "2026-10-03T23:00:00.000Z" })];
    // nothing cut
    expect(reviewLaneCoverage(loaded, 3, { from: null, to: null })).toEqual({ loaded: 3, total: 3, truncated: false, oldestLoaded: "2026-10-03", periodComplete: true });
    expect(reviewLaneCoverageNotice(reviewLaneCoverage(loaded, 3, { from: null, to: null }))).toBeNull();
    // cut: all time is incomplete and the notice names N of M and the date
    const cut = reviewLaneCoverage(loaded, 1500, { from: null, to: null });
    expect(cut).toMatchObject({ truncated: true, periodComplete: false });
    expect(reviewLaneCoverageNotice(cut)).toBe("Showing 3 of 1500 requests (the newest; the server's row limit cut the rest) — requests filed before 2026-10-03 are not counted. Narrow the period to start after 2026-10-03 for complete counts.");
    // a period starting ON the oldest loaded date may be partly loaded; one starting after it is whole
    expect(reviewLaneCoverage(loaded, 1500, { from: "2026-10-03", to: null }).periodComplete).toBe(false);
    expect(reviewLaneCoverage(loaded, 1500, { from: "2026-10-04", to: null }).periodComplete).toBe(true);
    // no count came back: unknown, and said so
    const unknown = reviewLaneCoverage(loaded, null, { from: null, to: null });
    expect(unknown).toMatchObject({ truncated: null, periodComplete: false });
    expect(reviewLaneCoverageNotice(unknown)).toMatch(/did not say how many there are in all/);
    // the route orders the read and returns the count; the page passes it to the panel
    const route = read("app/api/admin/analytics/route.ts");
    expect(route).toContain('asCaller.from("tickets").select("*", { count: "exact" }).eq("org_id", orgId).order("created_at", { ascending: false })');
    expect(route).toContain('ticketsTotal: typeof ticketsTotal === "number" ? ticketsTotal : null');
    expect(read("app/(protected)/admin/analytics/page.tsx")).toContain("<ReviewLaneReport tickets={tickets} ticketsTotal={ticketsTotal}");
    const panel = read("components/requests/ReviewLaneReport.tsx");
    expect(panel).toContain('data-testid="review-lanes-truncated"');
    expect(panel).not.toContain("a very large workspace&rsquo;s oldest requests may be missing");
  });
  it("it is mounted on /admin/analytics beside How Requests Ended, and the page's mapper carries the recorded columns; nothing writes", () => {
    const page = read("app/(protected)/admin/analytics/page.tsx");
    expect(page).toContain("<ReviewLaneReport tickets={tickets}");
    expect(page).toContain("...reviewModelFieldsFromRow(r),");
    const lib = read("lib/reviewLaneReport.ts") + read("components/requests/ReviewLaneReport.tsx");
    expect(lib).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
  });
});

describe("20261263 — the counts-only inventory (DEC-30 shape)", () => {
  const sql = read("supabase/migrations/20261263_df_roundG_ticket_dimension_inventory.sql");
  it("temp inventory before BEGIN / COMMIT, one final SELECT (check, ok, n); no DDL, no write", () => {
    const tmp = sql.indexOf("CREATE TEMP TABLE df_round_g_263_before");
    const begin = sql.indexOf("\nBEGIN;");
    const commit = sql.indexOf("\nCOMMIT;");
    expect(tmp).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(tmp);
    expect(commit).toBeGreaterThan(begin);
    expect(sql.slice(commit)).toMatch(/SELECT "check", ok, n FROM \(/);
    expect((sql.slice(commit).match(/^SELECT "check"/gm) ?? []).length).toBe(1);
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    // every statement that starts a line: only the temp inventory, BEGIN, COMMIT and SELECTs
    const statements = code.split("\n").filter((l) => /^[A-Z]+\b/.test(l)).map((l) => l.split(/\s+/).slice(0, 3).join(" "));
    for (const st of statements) expect(st, st).toMatch(/^(DROP TABLE IF|CREATE TEMP TABLE|WITH|SELECT|UNION ALL|BEGIN;|COMMIT;|FROM|WHERE|ORDER BY)/);
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER|INDEX|TABLE\s+(?!df_round_g_263_before))|ALTER\s+TABLE|INSERT\s+INTO|DELETE\s+FROM|\bUPDATE\s+\w+\s+SET/);
  });
  it("its shipped defaults are CAPABILITY_DEFS' for every request capability", () => {
    const rows = [...sql.matchAll(/\('(ticket\.[a-z_]+)', '(\[[^\]]*\])'::jsonb\)/g)].map((m) => [m[1], JSON.parse(m[2])]);
    const expected = CAPABILITY_DEFS.filter((d) => d.id.startsWith("ticket.")).map((d) => [d.id, d.defaultRoles]);
    expect(rows).toEqual(expected);
  });
  it("it reads the classes through to_jsonb (no 42703 before 20261250) and counts per workspace, never a customer row", () => {
    expect(sql).toContain("to_jsonb(t)->>'work_class'");
    expect(sql).toContain("to_jsonb(t)->>'library_id'");
    expect(sql).toMatch(/workspaces holding at least one such rule/);
    expect(sql).toMatch(/would newly NARROW/);
    expect(sql).toMatch(/would newly GRANT/);
  });
  it("fix pass (review major 2): an engineer_gate_exempt rule is NARROW unless its roles are exactly the base list — never a GRANT", () => {
    expect(sql).toContain("WHEN dm.cap = 'ticket.engineer_gate_exempt'\n             THEN CASE WHEN (dm.rule->'tokens') @> dm.base AND dm.base @> (dm.rule->'tokens') THEN 'same' ELSE 'narrow' END");
    expect(sql.indexOf("WHEN dm.cap = 'ticket.engineer_gate_exempt'")).toBeLessThan(sql.indexOf("WHEN NOT (dm.rule->'tokens' ? '*')"));
    expect(sql).toMatch(/never a ticket\.engineer_gate_exempt rule\) — in force at the deploy/);
  });
});

// ── DF-P19 second fix pass (review major 2 — TIER-4 done-when 1) ────────────
describe("second fix pass (review major 2) — a code-class review requirement is authored from the permissions console", () => {
  const cap: CapabilityId = "ticket.final_approve";
  it("the console offers code-class rows on exactly the request capabilities", () => {
    expect([...CODE_CLASS_RULE_CAPS].sort()).toEqual(CAPABILITY_DEFS.filter((d) => d.id.startsWith("ticket.")).map((d) => d.id).sort());
  });
  it("split: a rule naming ONE code class (and nothing else) on a request capability is a code-class row; several classes, another key, or a non-request capability stays preserved verbatim", () => {
    const stored: CapabilityPolicy = { caps: {
      [cap]: [{ tokens: ["Engineer"] }, { tokens: ["Engineer-3"], when: { codeClass: ["c-1"] }, confirmedAt: NOW, confirmedBy: "a1" }, { tokens: ["Engineer-2"], when: { codeClass: ["c-2", "c-3"] } }, { tokens: ["Admin"], when: { codeClass: ["c-4"], requestType: ["ISO"] } }],
      "transmittal.issue": [{ tokens: ["Admin", "DocCtrl"] }, { tokens: ["Admin"], when: { codeClass: ["c-1"] } }],
    } as CapabilityPolicy["caps"] };
    const s = splitPolicyForEditor(stored);
    expect(s.codeClassOverrides[cap]).toEqual([{ codeClass: "c-1", tokens: ["Engineer-3"] }]);
    expect(s.opaque[cap]).toHaveLength(2);
    expect(s.codeClassOverrides["transmittal.issue"]).toBeUndefined();
    // a loaded-then-saved grid is the stored entry: the row keeps its place,
    // and the server carries its stamp (the client never sends one)
    const j = joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides, stored, s.codeClassOverrides);
    expect((j[cap] as CapabilityRule[])[1]).toEqual({ tokens: ["Engineer-3"], when: { codeClass: ["c-1"] } });
    const carried = carryTicketRuleConfirmation(j, stored.caps, { at: "2026-10-23T00:00:00.000Z", by: "c9" }, false);
    expect(carried.caps[cap]).toEqual(stored.caps![cap]);
    expect(carried.confirmed).toEqual([]);
    expect(carried.unconfirmedNew).toEqual([]);
  });
  it("an Admin authors 'final approval on code class c-1 only by Engineer-3': the server stamps it, and it binds where the class matches — nowhere else", () => {
    const s = splitPolicyForEditor({});
    const rows = { [cap]: [{ codeClass: "c-1", tokens: ["Engineer-3"] }] };
    const caps = joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides, {}, rows);
    expect(caps[cap]).toEqual([{ tokens: ["Engineer"] }, { tokens: ["Engineer-3"], when: { codeClass: ["c-1"] } }]);
    expect(validateCapabilityPolicy({ caps })).toBeNull();
    const saved = carryTicketRuleConfirmation(caps, {}, { at: NOW, by: "admin" }, true);
    expect(saved.confirmed).toEqual([{ cap, rule: { tokens: ["Engineer-3"], when: { codeClass: ["c-1"] } } }]);
    const policy: CapabilityPolicy = { caps: saved.caps };
    const onCode = { requestType: "ISO", unit: "U-1", libraryId: null, workClass: null, codeClass: "c-1" };
    expect(policyAllows(policy, cap, "Engineer-2", null, null, onCode)).toBe(false);
    expect(policyAllows(policy, cap, "Engineer-3", null, null, onCode)).toBe(true);
    expect(policyAllows(policy, cap, "Engineer-2", null, null, { ...onCode, codeClass: "c-2" })).toBe(true);
    expect(policyAllows(policy, cap, "Engineer-2", null, null, { ...onCode, codeClass: null })).toBe(true);
    // the request page / route decide it on the ticket's recorded code class
    const t = routeRowToTicket(baseRow({ ...DIM_ROW, library_id: null, work_class: null, code_class: "c-1" }));
    expect(policyAllows(policy, cap, "Engineer-2", null, null, ticketResource(t))).toBe(false);
    // the same row added by a DocCtrl is stored unconfirmed: it takes nobody's approval away until an Admin confirms it
    const byController = carryTicketRuleConfirmation(caps, {}, { at: NOW, by: "c1" }, false);
    expect(byController.unconfirmedNew).toHaveLength(1);
    expect(policyAllows({ caps: byController.caps }, cap, "Engineer-2", null, null, onCode)).toBe(true);
  });
  // fifth fix pass (review major 1): a NEW code-class row now goes ahead of
  // the first request-type / project / preserved rule (here the unit rule),
  // after the code-class rows already leading.
  it("a new row goes ahead of the stored request-type / unit rules (after the leading code-class rows); an edited row keeps its place; a removed row drops out", () => {
    const stored: CapabilityPolicy = { caps: { [cap]: [{ tokens: ["Engineer"] }, { tokens: ["Engineer-3"], when: { codeClass: ["c-1"] }, confirmedAt: NOW }, { tokens: ["Admin"], when: { unit: ["U-1"] } }] } as CapabilityPolicy["caps"] };
    const s = splitPolicyForEditor(stored);
    const edited = joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides, stored, { [cap]: [{ codeClass: "c-1", tokens: ["Engineer-2"] }, { codeClass: "c-9", tokens: ["Engineer-3"] }] });
    expect((edited[cap] as CapabilityRule[]).map((r) => JSON.stringify([r.tokens, r.when ?? null]))).toEqual([
      JSON.stringify([["Engineer"], null]), JSON.stringify([["Engineer-2"], { codeClass: ["c-1"] }]), JSON.stringify([["Engineer-3"], { codeClass: ["c-9"] }]), JSON.stringify([["Admin"], { unit: ["U-1"] }]),
    ]);
    const removed = joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides, stored, {});
    expect(removed[cap]).toEqual([{ tokens: ["Engineer"] }, { tokens: ["Admin"], when: { unit: ["U-1"] } }]);
  });
  it("the console renders the rows, reads the workspace's code classes (no code names in the app), and says who puts a rule in force", () => {
    const editor = read("components/permissions/CapabilityPolicyEditor.tsx");
    expect(editor).toContain('data-testid="code-class-rules"');
    expect(editor).toContain('aria-label="Code class"');
    expect(editor).toContain('reviewClassOptions(cfg, "codeClasses")');
    // third fix pass: the wording moved into classRuleTakesEffect (and says
    // "no effect" on the engineer-gate exemption) — pinned below.
    expect(editor).toContain('const takesEffect = classRuleTakesEffect(d.id, hasAnyRole(["Admin"]));');
    expect(editor).toContain("commit(out.version, out.policy?.caps);");
  });
});

// ── DF-P19 second fix pass (review minor 4) ─────────────────────────────────
describe("second fix pass (review minor 4) — the list, inbox and badge now read the review-model columns for every request", () => {
  // Before DF-P19 those three mappers carried none of the review-model
  // fields, so they decided every request by the legacy role gate. Now they
  // spread reviewModelFieldsFromRow, so a review-model request with NO library
  // and NO class can answer differently from before — the route's answer.
  const REVIEW_KEYS = Object.keys(reviewModelFieldsFromRow({}));
  const preDfP19 = (t: Ticket): Ticket => {
    const copy = { ...t } as Record<string, unknown>;
    for (const k of REVIEW_KEYS) delete copy[k];
    return copy as unknown as Ticket;
  };
  const NO_DIM = { library_id: null, work_class: null, code_class: null };
  const ROWS: Array<[string, Record<string, unknown>]> = [
    ["declared like-in-kind (engineering_required false)", { ...NO_DIM, engineering_required: false, review_model_filed: true, like_in_kind_statement: "same as before", like_in_kind_declared_by: "req", like_in_kind_declared_at: NOW, requester_role: "Viewer" }],
    ["filed under the review model with engineering_required true (today's role gate says exempt)", { ...NO_DIM, engineering_required: true, review_model_filed: true, requester_role: "Engineer-3" }],
  ];
  const ATTENTION_MAPPERS = {
    "requests list": listFromRow,
    "inbox": inboxRowToTicket,
    "attention badge": badgeFromDbTicket,
  };
  for (const [label, over] of ROWS) {
    it(`${label}: the list / inbox / badge engine answers and isActionRequired equal the route's — and the engine answers differ from the pre-DF-P19 mappers'`, () => {
      const row = baseRow(over);
      const route = routeRowToTicket(row);
      let differs = 0;
      for (const status of STATUSES) {
        for (const role of ALL_ROLES) {
          for (const uid of IDENTITIES) {
            const at = (t: Ticket) => ({ ...t, status, assignedEngineerId: uid === "eng" ? "eng" : t.assignedEngineerId } as Ticket);
            const acts = (t: Ticket) => actionSet(WorkflowEngine.getActions(at(t), role, uid, undefined, { userRoles: [role], activeMemberCount: 5, requesterRoles: [String(row.requester_role)] }));
            const ctx = { uid, roles: [role], policy: null, activeMemberCount: 5, requesterRoles: new Map([["req", [String(row.requester_role)]]]) };
            const want = acts(route);
            const wantNeeds = isActionRequired(at(route), ctx);
            for (const [name, m] of Object.entries(ATTENTION_MAPPERS)) {
              expect(acts(m(row)), `${name} ${status}|${role}|${uid}`).toEqual(want);
              expect(isActionRequired(at(m(row)), ctx), `${name} needs-me ${status}|${role}|${uid}`).toBe(wantNeeds);
            }
            if (JSON.stringify(acts(preDfP19(inboxRowToTicket(row)))) !== JSON.stringify(want)) differs++;
          }
        }
      }
      // what the list and inbox offer (approve vs override, the engineer
      // hand-off) changed for these requests; the needs-me answer follows
      // the route's wherever it differs
      expect(differs).toBeGreaterThan(0);
    });
  }
});

// ── third fix pass ──────────────────────────────────────────────────────────
describe("third fix pass (review major 1) — a request's library and classes never decide a capability outside ticket.*", () => {
  // A library-scoped rule stored for the DOCUMENT side (DEC-13 stage 2) on a
  // non-ticket capability a routing slot can name.
  const DOC_SIDE: CapabilityPolicy = {
    caps: {
      "transmittal.issue": [{ tokens: ["DocCtrl", "Admin"] }, { tokens: ["Admin"], when: { libraryId: [LIB] } }],
      "holds.release": [{ tokens: ["DocCtrl", "Admin"] }, { tokens: ["Admin"], when: { libraryId: [LIB] } }],
    },
  };
  const members = [
    { uid: "dc", role: "DocCtrl", roles: ["DocCtrl"] },
    { uid: "ad", role: "Admin", roles: ["Admin"] },
    { uid: "mg", role: "Manager", roles: ["Manager"] },
    { uid: "req", role: "Requester", roles: ["Requester"] },
  ];
  const control = { slots: [{ kind: "release", label: "Doc control release", mode: "blocking" as const, fill: { capability: "transmittal.issue" as CapabilityId }, waivable_by: { capability: "holds.release" as CapabilityId } }] };
  const open = async (resource: ReturnType<typeof ticketResource> | { requestType: string | null; unit: string | null }) => {
    const { openRoster } = await import("@/lib/ticketRoster");
    const r = openRoster({ id: "r", control, level: "library", cycle: "1A", files: [], ctx: { members, policy: DOC_SIDE, resource, requesterId: "req" }, openedBy: "d", now: NOW });
    if (!r.ok) throw new Error(r.error);
    return r.roster.slots.find((s) => s.kind === "release")!;
  };

  it("the reviewer's case: the library-carrying request opens the same occupants as on 82f2ed6 (the pre-DF-P19 resource)", async () => {
    const withLib = await open(ticketResource({ requestType: "ISO", unit: "U1", libraryId: LIB, workClass: "W", codeClass: "B313" }));
    const before = await open({ requestType: "ISO", unit: "U1" });
    expect(withLib.primaries).toEqual(["ad", "dc"]);
    expect(withLib.primaries).toEqual(before.primaries);
    expect(withLib.overriders).toEqual(before.overriders);
    // the evaluator itself still reads the library for that capability (a document's resource)
    expect(policyAllows(DOC_SIDE, "transmittal.issue", "DocCtrl", null, null, { libraryId: LIB })).toBe(false);
  });

  it("requestResourceFor: ticket.* sees the whole request resource; any other capability sees requestType and unit only", async () => {
    const { requestResourceFor } = await import("@/lib/capabilityPolicy");
    const res = ticketResource({ requestType: "ISO", unit: "U1", libraryId: LIB, workClass: "W", codeClass: "B313" });
    expect(requestResourceFor("ticket.final_approve", res)).toEqual(res);
    expect(requestResourceFor("transmittal.issue", res)).toEqual({ requestType: "ISO", unit: "U1" });
    expect(requestResourceFor("holds.open", res)).toEqual({ requestType: "ISO", unit: "U1" });
    expect(requestResourceFor("holds.open", null)).toBeNull();
    expect(res.libraryId).toBe(LIB); // never mutated
  });

  it("a ticket.* slot fill still reads the library: a confirmed library rule on ticket.final_approve decides who fills the engineering slot", async () => {
    const { openRoster } = await import("@/lib/ticketRoster");
    const pol: CapabilityPolicy = { caps: { "ticket.final_approve": [{ tokens: ["Engineer"] }, { tokens: ["Engineer-3"], when: { libraryId: [LIB] }, confirmedAt: NOW, confirmedBy: "a" }] } };
    const engs = [{ uid: "e1", role: "Engineer", roles: ["Engineer"] }, { uid: "e3", role: "Engineer-3", roles: ["Engineer-3"] }];
    const r = openRoster({ id: "r", control: { slots: [{ kind: "eng", mode: "blocking", fill: { capability: "ticket.final_approve" } }] }, level: "library", cycle: "1A", files: [],
      ctx: { members: engs, policy: pol, resource: ticketResource({ requestType: "ISO", unit: null, libraryId: LIB, workClass: null, codeClass: null }), requesterId: null }, openedBy: "d", now: NOW });
    expect(r.ok && r.roster.slots[0].primaries).toEqual(["e3"]);
  });

  it("source pin: resolveFill evaluates the capability against requestResourceFor(capability, ctx.resource)", () => {
    const src = read("lib/ticketRoster.ts");
    expect(src).toContain("const resource = fill.capability ? requestResourceFor(fill.capability, ctx.resource) : null;");
    expect(src).toContain("policyAllows(ctx.policy, fill.capability, held[0], held, uid, resource)");
    expect(src).not.toContain("held, uid, ctx.resource)");
  });
});

describe("third fix pass (review major 2) — an in-force library / class rule is Admin's to change or remove", () => {
  const STAMP = { confirmedAt: NOW, confirmedBy: "a1" };
  const stored: CapabilityPolicy = { caps: {
    "ticket.final_approve": [{ tokens: ["Engineer"] }, { tokens: ["Engineer-3"], when: { codeClass: ["B313"] }, ...STAMP }, { tokens: ["Engineer-2"], when: { codeClass: ["B311"] } }],
    "ticket.engineer_gate_exempt": [{ tokens: ["Admin", "Manager"] }, { tokens: ["Admin"], when: { codeClass: ["B313"] }, ...STAMP }],
  } };

  it("the reviewer's reproduction: what a DocCtrl's edit would have stored (unconfirmed) lets every Engineer approve — the reason the edit is refused", () => {
    const edited = { ...stored.caps, "ticket.final_approve": [{ tokens: ["Engineer"] }, { tokens: ["Engineer-3", "Engineer-2"], when: { codeClass: ["B313"] } }] } as CapabilityPolicy["caps"];
    const carried = carryTicketRuleConfirmation(edited, stored.caps, { at: NOW, by: "c1" }, false);
    expect(tokensFor({ caps: carried.caps }, "ticket.final_approve", { codeClass: "B313" }).sort()).toEqual(["Engineer", "Engineer-2", "Engineer-3"]);
  });

  it("inForceTicketRulesDropped names an edited or removed in-force rule, never an unconfirmed one or one carried unchanged", async () => {
    const { inForceTicketRulesDropped } = await import("@/lib/capabilityPolicy");
    expect(inForceTicketRulesDropped(stored.caps, stored.caps)).toEqual([]);
    // the stamp is not part of the rule: a save that carries it bare is unchanged
    const bareCaps = { "ticket.final_approve": [{ tokens: ["Engineer"] }, { tokens: ["Engineer-3"], when: { codeClass: ["B313"] } }], "ticket.engineer_gate_exempt": [{ tokens: ["Admin", "Manager"] }, { tokens: ["Admin"], when: { codeClass: ["B313"] } }] } as CapabilityPolicy["caps"];
    expect(inForceTicketRulesDropped(bareCaps, stored.caps)).toEqual([]);
    const edited = { ...bareCaps, "ticket.final_approve": [{ tokens: ["Engineer"] }, { tokens: ["Engineer-3", "Engineer-2"], when: { codeClass: ["B313"] } }] } as CapabilityPolicy["caps"];
    expect(inForceTicketRulesDropped(edited, stored.caps).map((d) => d.cap)).toEqual(["ticket.final_approve"]);
    const removed = { ...bareCaps, "ticket.engineer_gate_exempt": [{ tokens: ["Admin", "Manager"] }] } as CapabilityPolicy["caps"];
    expect(inForceTicketRulesDropped(removed, stored.caps).map((d) => d.cap)).toEqual(["ticket.engineer_gate_exempt"]);
    // the unconfirmed B311 rule may be dropped by anyone (it only added)
    expect(inForceTicketRulesDropped(bareCaps, stored.caps).some((d) => d.rule.when?.codeClass?.[0] === "B311")).toBe(false);
    // a request-type rule is not a dimension rule: never listed
    expect(inForceTicketRulesDropped({}, { "ticket.assign": [{ tokens: ["Admin"] }, { tokens: ["Admin"], when: { requestType: ["ISO"] } }] })).toEqual([]);
  });

  it("the editor: an in-force code-class row is locked for a non-Admin; the preview says what a non-Admin's rule does", async () => {
    const { inForceClassRule, classRuleTakesEffect } = await import("@/components/permissions/CapabilityPolicyEditor");
    expect(inForceClassRule(stored, "ticket.final_approve", "B313")).toBe(true);
    expect(inForceClassRule(stored, "ticket.final_approve", "B311")).toBe(false);
    expect(inForceClassRule(stored, "ticket.engineer_gate_exempt", "B313")).toBe(true);
    expect(inForceClassRule(null, "ticket.final_approve", "B313")).toBe(false);
    expect(classRuleTakesEffect("ticket.final_approve", true)).toBe("in force once saved");
    expect(classRuleTakesEffect("ticket.final_approve", false)).toBe("adds people only until an Admin confirms it");
    expect(classRuleTakesEffect("ticket.engineer_gate_exempt", false)).toBe("no effect at all until an Admin confirms it");
    const src = read("components/permissions/CapabilityPolicyEditor.tsx");
    expect(src).toContain("const dropped = inForceTicketRulesDropped(caps, storedPolicy?.caps);");
    expect(src).toContain("const adminOnly = !mayConfirm && inForceClassRule(storedPolicy, def.id, row.codeClass);");
    expect(src).toContain("in force — only an Admin may change or remove it");
    expect(src).toContain("const takesEffect = classRuleTakesEffect(d.id, hasAnyRole([\"Admin\"]));");
  });
});

describe("third fix pass (review minor 3) — the permissions explorer says what an unconfirmed library / class rule does", () => {
  it("a not-yet-confirmed rule is noted as only adding (nothing on the engineer-gate exemption); a confirmed or request-type rule replaces the row", async () => {
    const { capabilityRow } = await import("@/components/permissions/PermissionsExplorer");
    const def = (id: CapabilityId) => CAPABILITY_DEFS.find((d) => d.id === id)!;
    const pol: CapabilityPolicy = { caps: {
      "ticket.final_approve": [{ tokens: ["Engineer"] }, { tokens: ["Engineer-3"], when: { codeClass: ["B313"] } }, { tokens: ["Engineer-2"], when: { requestType: ["ISO"] } }],
      "ticket.engineer_gate_exempt": [{ tokens: ["Admin"] }, { tokens: ["Admin", "Manager"], when: { codeClass: ["B313"] } }],
      "ticket.assign": [{ tokens: ["Admin"] }, { tokens: ["Manager"], when: { libraryId: [LIB] }, confirmedAt: NOW, confirmedBy: "a" }],
    } };
    const fa = capabilityRow(def("ticket.final_approve"), pol).note ?? "";
    expect(fa).toContain("1 scoped rule replace this row where they match (requestType ∈ {ISO})");
    expect(fa).toContain("1 library / class rule not yet in force — only add people where they match until an Admin confirms (codeClass ∈ {B313})");
    expect(capabilityRow(def("ticket.engineer_gate_exempt"), pol).note).toContain("not yet in force — no effect until an Admin confirms");
    expect(capabilityRow(def("ticket.assign"), pol).note).toContain("1 scoped rule replace this row where they match (libraryId ∈");
  });
});

// ── DF-P19 fourth fix pass ──────────────────────────────────────────────────
describe("fourth fix pass (review major 1) — no rule may be put ahead of an in-force library / class rule but by an Admin", () => {
  const STAMP = { confirmedAt: NOW, confirmedBy: "a1" };
  const C = { tokens: ["Admin"], when: { codeClass: ["B313"] }, ...STAMP };
  const Cbare = { tokens: ["Admin"], when: { codeClass: ["B313"] } };
  const BASE = { tokens: ["Engineer", "Admin"] };
  const stored: CapabilityPolicy["caps"] = { "ticket.final_approve": [C, BASE] };

  it("the reviewer's two reproductions are named; nothing is reported dropped for either (why the dropped check alone was not enough)", async () => {
    const { inForceTicketRulesShadowed, inForceTicketRulesDropped } = await import("@/lib/capabilityPolicy");
    const a = { "ticket.final_approve": [{ tokens: ["Engineer"], when: { codeClass: ["B313"] } }, Cbare, BASE] } as CapabilityPolicy["caps"];
    const b = { "ticket.final_approve": [{ tokens: ["Engineer", "Admin"], when: { requestType: ["EWR"] } }, Cbare, BASE] } as CapabilityPolicy["caps"];
    for (const caps of [a, b]) {
      expect(inForceTicketRulesDropped(caps, stored)).toEqual([]);
      expect(inForceTicketRulesShadowed(caps, stored).map((x) => [x.cap, capabilityRuleKey(x.rule)])).toEqual([["ticket.final_approve", capabilityRuleKey(C)]]);
    }
  });

  it("an existing rule moved ahead, or a rule ahead edited or removed, is named too", async () => {
    const { inForceTicketRulesShadowed } = await import("@/lib/capabilityPolicy");
    const R = { tokens: ["Engineer"], when: { requestType: ["EWR"] } };
    const s2 = { "ticket.final_approve": [R, C, BASE] } as CapabilityPolicy["caps"];
    expect(inForceTicketRulesShadowed({ "ticket.final_approve": [R, Cbare, BASE] } as CapabilityPolicy["caps"], s2)).toEqual([]);
    expect(inForceTicketRulesShadowed({ "ticket.final_approve": [{ ...R, tokens: ["Engineer", "Drafter"] }, Cbare, BASE] } as CapabilityPolicy["caps"], s2)).toHaveLength(1);
    expect(inForceTicketRulesShadowed({ "ticket.final_approve": [Cbare, BASE] } as CapabilityPolicy["caps"], s2)).toHaveLength(1);
    const moved = { "ticket.final_approve": [Cbare, R, BASE] } as CapabilityPolicy["caps"];
    const s3 = { "ticket.final_approve": [C, R, BASE] } as CapabilityPolicy["caps"];
    expect(inForceTicketRulesShadowed({ "ticket.final_approve": [R, Cbare, BASE] } as CapabilityPolicy["caps"], s3)).toHaveLength(1);
    expect(inForceTicketRulesShadowed(moved, s3)).toEqual([]);
  });

  it("a rule after the last in-force one, the base moving, a multi-type rule written back one per type, or a capability with none in force — not named", async () => {
    const { inForceTicketRulesShadowed } = await import("@/lib/capabilityPolicy");
    expect(inForceTicketRulesShadowed({ "ticket.final_approve": [Cbare, { tokens: ["Drafter"], when: { codeClass: ["B313"] } }, BASE] } as CapabilityPolicy["caps"], stored)).toEqual([]);
    expect(inForceTicketRulesShadowed({ "ticket.final_approve": [BASE, Cbare] } as CapabilityPolicy["caps"], stored)).toEqual([]);
    const multi = { "ticket.final_approve": [{ tokens: ["Engineer"], when: { requestType: ["EWR", "ISO"] } }, C, BASE] } as CapabilityPolicy["caps"];
    const split = { "ticket.final_approve": [{ tokens: ["Engineer"], when: { requestType: ["EWR"] } }, { tokens: ["Engineer"], when: { requestType: ["ISO"] } }, Cbare, BASE] } as CapabilityPolicy["caps"];
    expect(inForceTicketRulesShadowed(split, multi)).toEqual([]);
    // … but a split that changes a piece is still a change
    const splitEdited = { "ticket.final_approve": [{ tokens: ["Engineer"], when: { requestType: ["EWR"] } }, { tokens: ["Drafter"], when: { requestType: ["ISO"] } }, Cbare, BASE] } as CapabilityPolicy["caps"];
    expect(inForceTicketRulesShadowed(splitEdited, multi)).toHaveLength(1);
    // no in-force dimension rule stored: any order is the grid's
    const unconfirmed = { "ticket.final_approve": [Cbare, BASE] } as CapabilityPolicy["caps"];
    expect(inForceTicketRulesShadowed({ "ticket.final_approve": [{ tokens: ["Engineer"], when: { requestType: ["EWR"] } }, Cbare, BASE] } as CapabilityPolicy["caps"], unconfirmed)).toEqual([]);
    expect(inForceTicketRulesShadowed({}, { "ticket.assign": [{ tokens: ["Admin"] }, { tokens: ["Admin"], when: { requestType: ["ISO"] } }] })).toEqual([]);
  });

  it("the property the check stands for: with the prefix unchanged, a request the in-force rule matches gets the stored answer, whatever is added after", () => {
    const after = { caps: { "ticket.final_approve": [C, { tokens: ["Engineer", "Drafter"], when: { codeClass: ["B313"] } }, { tokens: ["Drafter"], when: { requestType: ["EWR"] } }, BASE] } } as CapabilityPolicy;
    for (const requestType of ["EWR", "ISO", "RFI"]) {
      expect(tokensFor(after, "ticket.final_approve", { requestType, codeClass: "B313" })).toEqual(tokensFor({ caps: stored }, "ticket.final_approve", { requestType, codeClass: "B313" }));
    }
  });

  it("the route and the editor run it for a non-Admin, after the dropped check", () => {
    const route = read("app/api/admin/capability-policy/route.ts");
    expect(route).toContain("const shadowed = inForceTicketRulesShadowed(caps, before.caps);");
    expect(route.indexOf("const shadowed = inForceTicketRulesShadowed")).toBeGreaterThan(route.indexOf("const dropped = inForceTicketRulesDropped"));
    expect(route.indexOf("const shadowed = inForceTicketRulesShadowed")).toBeLessThan(route.indexOf("const carried = carryTicketRuleConfirmation"));
    const editor = read("components/permissions/CapabilityPolicyEditor.tsx");
    expect(editor).toContain("const shadowed = inForceTicketRulesShadowed(caps, storedPolicy?.caps);");
  });
});

describe("fourth fix pass (review minor 2) — a NARROW rule that also names new roles grants them at the deploy", () => {
  it("narrowTicketRuleAddedRoles: the reviewer's case (Drafter on final approval, base Engineer) — Drafters have it at once, the removal waits", async () => {
    const { narrowTicketRuleAddedRoles } = await import("@/lib/capabilityPolicy");
    const pol: CapabilityPolicy = { caps: { "ticket.final_approve": [{ tokens: ["Engineer"] }, { tokens: ["Drafter"], when: { codeClass: ["X"] } }] } };
    const rule = (pol.caps!["ticket.final_approve"] as CapabilityRule[])[1];
    expect(classifyTicketDimensionRule(pol, "ticket.final_approve", rule)).toBe("narrow");
    expect(narrowTicketRuleAddedRoles(pol, "ticket.final_approve", rule)).toEqual(["Drafter"]);
    expect(tokensFor(pol, "ticket.final_approve", { codeClass: "X" }).sort()).toEqual(["Drafter", "Engineer"]);
  });
  it("none for a grant, a same, a narrowing that only removes, a confirmed rule, or any rule on ticket.engineer_gate_exempt", async () => {
    const { narrowTicketRuleAddedRoles } = await import("@/lib/capabilityPolicy");
    const pol: CapabilityPolicy = { caps: {
      "ticket.final_approve": [{ tokens: ["Engineer", "Admin"] }],
      "ticket.engineer_gate_exempt": [{ tokens: ["Admin", "Manager"] }],
    } };
    const r = (tokens: string[], extra: Partial<CapabilityRule> = {}): CapabilityRule => ({ tokens, when: { codeClass: ["X"] }, ...extra });
    expect(narrowTicketRuleAddedRoles(pol, "ticket.final_approve", r(["Engineer", "Admin", "Drafter"]))).toEqual([]); // grant
    expect(narrowTicketRuleAddedRoles(pol, "ticket.final_approve", r(["Admin", "Engineer"]))).toEqual([]);           // same
    expect(narrowTicketRuleAddedRoles(pol, "ticket.final_approve", r(["Admin"]))).toEqual([]);                       // narrow, removes only
    expect(narrowTicketRuleAddedRoles(pol, "ticket.final_approve", r(["Admin", "Drafter"], { confirmedAt: NOW }))).toEqual([]); // in force wholly
    expect(narrowTicketRuleAddedRoles(pol, "ticket.engineer_gate_exempt", r(["Admin", "Viewer"]))).toEqual([]);      // ignored until confirmed
    expect(narrowTicketRuleAddedRoles(pol, "ticket.final_approve", r(["Admin", "Drafter"]))).toEqual(["Drafter"]);
  });
  it("20261263 counts them in their own row (13) and rows 10 / 11 say which half waits", () => {
    const sql = read("supabase/migrations/20261263_df_roundG_ticket_dimension_inventory.sql");
    expect(sql).toMatch(/SELECT 13, 'inventory \(before apply\): … of the NARROW ones, unconfirmed and outside ticket\.engineer_gate_exempt, that also name a role not on the base list — their added roles are IN FORCE at the deploy; only the removal waits for an Admin''s confirmation'/);
    expect(sql).toContain("WHERE effect = 'narrow' AND NOT confirmed AND cap <> 'ticket.engineer_gate_exempt'");
    expect(sql).toMatch(/its narrowing half is NOT in force until an Admin confirms it/);
  });
});

describe("fourth fix pass (review minor 4) — the Review Lanes panel reads the server only for a chosen period or on request", () => {
  it("periodReadWanted: no loader → never; a bound → yes; no period → only after 'Count all time'", async () => {
    const { periodReadWanted } = await import("@/components/requests/ReviewLaneReport");
    const loader = async () => ({ rows: [], total: 0, complete: true });
    expect(periodReadWanted(undefined, { from: "2026-01-01", to: null }, null)).toBe(false);
    expect(periodReadWanted(loader, { from: null, to: null }, null)).toBe(false);
    expect(periodReadWanted(loader, { from: "2026-01-01", to: null }, null)).toBe(true);
    expect(periodReadWanted(loader, { from: null, to: "2026-02-01" }, null)).toBe(true);
    expect(periodReadWanted(loader, { from: null, to: null }, "|")).toBe(true);
  });
  it("the panel: the read waits on periodReadWanted; with none wanted, the counts are the page's load with its coverage notice and a 'Count all time' button", () => {
    const panel = read("components/requests/ReviewLaneReport.tsx");
    expect(panel).toContain("const wanted = periodReadWanted(loadPeriod, { from: pFrom, to: pTo }, allTimeKey === periodKey ? periodKey : null);");
    expect(panel).toContain("if (!loadPeriod || !wanted) return;");
    expect(panel).toContain("const reading = wanted && current === null;");
    expect(panel).toContain('data-testid="review-lanes-count-all"');
  });
});

// ── DF-P19 fifth fix pass ───────────────────────────────────────────────────
describe("fifth fix pass (review major 1) — a code-class rule authored in Admin → Permissions decides before the request-type rows", () => {
  const cap: CapabilityId = "ticket.final_approve";
  // the reviewer's case: a stored EWR override, then an Admin adds B313 → Engineer-3
  const stored: CapabilityPolicy = { caps: { [cap]: [{ tokens: ["Engineer", "Manager"] }, { tokens: ["Engineer", "Manager"], when: { requestType: ["EWR"] } }] } as CapabilityPolicy["caps"] };
  const authored = (isAdmin: boolean) => {
    const s = splitPolicyForEditor(stored);
    const caps = joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides, stored, { [cap]: [{ codeClass: "B313", tokens: ["Engineer-3"] }] });
    return { caps, saved: carryTicketRuleConfirmation(caps, stored.caps, { at: NOW, by: isAdmin ? "admin" : "c1" }, isAdmin) };
  };

  it("the join writes the new code-class row AHEAD of the stored EWR row", () => {
    const { caps } = authored(true);
    expect(caps[cap]).toEqual([
      { tokens: ["Engineer", "Manager"] },
      { tokens: ["Engineer-3"], when: { codeClass: ["B313"] } },
      { tokens: ["Engineer", "Manager"], when: { requestType: ["EWR"] } },
    ]);
    expect(rulesDecidingBeforeClassRule(cap, caps[cap], "B313")).toEqual([]);
  });

  it("an Admin's rule binds for an EWR request of class B313 as for any other type — a Manager can no longer final-approve it", () => {
    const { saved } = authored(true);
    expect(saved.confirmed).toHaveLength(1);
    const policy: CapabilityPolicy = { caps: saved.caps };
    for (const requestType of ["EWR", "DCN", "ISO"]) {
      expect(tokensFor(policy, cap, { requestType, codeClass: "B313" })).toEqual(["Engineer-3"]);
      expect(policyAllows(policy, cap, "Manager", null, null, { requestType, codeClass: "B313" })).toBe(false);
      expect(policyAllows(policy, cap, "Engineer-3", null, null, { requestType, codeClass: "B313" })).toBe(true);
    }
    // the EWR override still decides EWR requests of any other class, or none
    expect(tokensFor(policy, cap, { requestType: "EWR", codeClass: "B999" })).toEqual(["Engineer", "Manager"]);
    expect(tokensFor(policy, cap, { requestType: "EWR" })).toEqual(["Engineer", "Manager"]);
    // the engine reads the same ticket resource
    const t = routeRowToTicket(baseRow({ ...DIM_ROW, request_type: "EWR", library_id: null, work_class: null, code_class: "B313" }));
    expect(policyAllows(policy, cap, "Manager", null, null, ticketResource(t))).toBe(false);
  });

  it("a DocCtrl's same row is stored unconfirmed ahead: it only adds (the EWR answer stands, joined), and no in-force rule is shadowed", async () => {
    const { inForceTicketRulesShadowed } = await import("@/lib/capabilityPolicy");
    const { caps, saved } = authored(false);
    expect(saved.unconfirmedNew).toHaveLength(1);
    expect(inForceTicketRulesShadowed(caps, stored.caps)).toEqual([]);
    expect(tokensFor({ caps: saved.caps }, cap, { requestType: "EWR", codeClass: "B313" }).sort()).toEqual(["Engineer", "Engineer-3", "Manager"]);
  });

  it("with an in-force code-class rule already leading, a DocCtrl's new code-class row goes after it and is accepted by the shadow check", async () => {
    const { inForceTicketRulesShadowed } = await import("@/lib/capabilityPolicy");
    const lead: CapabilityPolicy = { caps: { [cap]: [{ tokens: ["Engineer"] }, { tokens: ["Engineer-3"], when: { codeClass: ["B313"] }, confirmedAt: NOW, confirmedBy: "a1" }, { tokens: ["Engineer"], when: { requestType: ["EWR"] } }] } as CapabilityPolicy["caps"] };
    const s = splitPolicyForEditor(lead);
    const caps = joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides, lead, { [cap]: [...(s.codeClassOverrides[cap] ?? []), { codeClass: "B16", tokens: ["Engineer-2"] }] });
    expect((caps[cap] as CapabilityRule[]).map((r) => r.when ?? null)).toEqual([null, { codeClass: ["B313"] }, { codeClass: ["B16"] }, { requestType: ["EWR"] }]);
    expect(inForceTicketRulesShadowed(caps, lead.caps)).toEqual([]);
  });

  it("with nothing stored as a rule list, code-class rows come first too", () => {
    const s = splitPolicyForEditor({});
    const caps = joinPolicyFromEditor(s.base, { [cap]: [{ type: "EWR", tokens: ["Engineer"] }] }, s.opaque, s.projectOverrides, {}, { [cap]: [{ codeClass: "B313", tokens: ["Engineer-3"] }] });
    expect((caps[cap] as CapabilityRule[]).map((r) => r.when ?? null)).toEqual([null, { codeClass: ["B313"] }, { requestType: ["EWR"] }]);
  });

  it("a STORED code-class rule behind a request-type / unit rule keeps its place, and the console names the rules that decide first", () => {
    const legacy: CapabilityPolicy = { caps: { [cap]: [
      { tokens: ["Engineer"] },
      { tokens: ["Engineer", "Manager"], when: { requestType: ["EWR"] } },
      { tokens: ["Admin"], when: { codeClass: ["B16"] } },
      { tokens: ["Admin"], when: { unit: ["U-1"] } },
      { tokens: ["Engineer-3"], when: { codeClass: ["B313"] }, confirmedAt: NOW, confirmedBy: "a1" },
    ] } as CapabilityPolicy["caps"] };
    const s = splitPolicyForEditor(legacy);
    const caps = joinPolicyFromEditor(s.base, s.overrides, s.opaque, s.projectOverrides, legacy, s.codeClassOverrides);
    expect((caps[cap] as CapabilityRule[]).map((r) => r.when ?? null)).toEqual([null, { requestType: ["EWR"] }, { codeClass: ["B16"] }, { unit: ["U-1"] }, { codeClass: ["B313"] }]);
    // the B16 rule names only another class, so it cannot match a B313 request
    expect(rulesDecidingBeforeClassRule(cap, caps[cap], "B313").map((r) => r.when)).toEqual([{ requestType: ["EWR"] }, { unit: ["U-1"] }]);
    expect(rulesDecidingBeforeClassRule(cap, caps[cap], "B16").map((r) => r.when)).toEqual([{ requestType: ["EWR"] }]);
    expect(rulesDecidingBeforeClassRule(cap, caps[cap], "nope")).toEqual([]);
    // what that note says is what the evaluator does
    const policy: CapabilityPolicy = { caps: legacy.caps };
    expect(tokensFor(policy, cap, { requestType: "EWR", codeClass: "B313" })).toEqual(["Engineer", "Manager"]);
    expect(tokensFor(policy, cap, { requestType: "DCN", codeClass: "B313" })).toEqual(["Engineer-3"]);
  });

  it("the console wires the note and the preview to rulesDecidingBeforeClassRule, and the copy says the first match decides", () => {
    const editor = read("components/permissions/CapabilityPolicyEditor.tsx");
    expect(editor).toContain("const draftCaps = joinPolicyFromEditor(policy, overrides, opaque, projectOverrides, storedPolicy, codeClassOverrides);");
    expect(editor).toContain("rulesDecidingBeforeClassRule(def.id, draftCaps[def.id], row.codeClass)");
    expect(editor).toContain("data-class-rule-decided-first");
    expect(editor).toContain("const ahead = rulesDecidingBeforeClassRule(d.id, caps[d.id], r.codeClass);");
    expect(editor).toContain("a new code-class rule is written ahead of the request-type and unit rules, so it applies whatever the request type");
  });
});
