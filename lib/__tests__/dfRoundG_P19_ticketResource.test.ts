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

import { WorkflowEngine, ticketResource, type WorkflowAction, type WorkflowContext } from "@/lib/workflow";
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
  summarizeReviewLanes, reviewLaneOf, filedInPeriod, periodBound, reviewLaneReportCsv, REVIEW_LANES,
} from "@/lib/reviewLaneReport";
import { ticketDimensionRuleStatus } from "@/components/permissions/CapabilityPolicyEditor";

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
    const out = carryTicketRuleConfirmation(incoming, stored, { at: NOW, by: "a1" });
    const rules = out.caps[cap] as CapabilityRule[];
    expect(rules[0]).toEqual({ tokens: ["Admin"], when: { libraryId: [LIB] } });
    expect(rules[1]).toEqual({ tokens: ["Admin"], when: { workClass: ["w"] }, confirmedAt: "2026-10-01T00:00:00.000Z", confirmedBy: "a0" });
    expect(rules[2]).toEqual({ tokens: ["Admin", "Drafter"], when: { codeClass: ["c"] }, confirmedAt: NOW, confirmedBy: "a1" });
    expect(rules[3]).toEqual({ tokens: ["DocCtrl"], when: { requestType: ["ISO"] } });
    expect(out.confirmed).toEqual([{ cap, rule: { tokens: ["Admin", "Drafter"], when: { codeClass: ["c"] } } }]);
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
    expect(route).toContain("carryTicketRuleConfirmation(caps, before.caps, { at: nowIso, by: caller.id })");
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
  ];
  it("lanes come from the recorded columns; they add up to the period's total", () => {
    expect(rows.map(reviewLaneOf)).toEqual(["engineered", "like_in_kind", "legacy_gate", "not_recorded", "like_in_kind"]);
    const all = summarizeReviewLanes(rows, { from: null, to: null });
    expect(all.total).toBe(5);
    expect(REVIEW_LANES.reduce((n, l) => n + all.lanes[l], 0)).toBe(5);
    expect(all.declarations.map((d) => d.ticketId)).toEqual(["REQ-5", "REQ-2"]);
    expect(all.declarations[1]).toMatchObject({ declaredBy: "req", declaredByName: "Rae Q", statement: "Same gasket", workClass: "lik", codeClass: "c1" });
    expect(all.declarations[0].declaredByName).toBeNull();
    expect(all.byCodeClass).toEqual([{ value: "c1", count: 2 }, { value: null, count: 3 }]);
  });
  it("any period: inclusive UTC filing dates, either end open; a bad bound is no bound", () => {
    const oct = summarizeReviewLanes(rows, { from: "2026-10-01", to: "2026-10-31" });
    expect(oct.total).toBe(4);
    expect(oct.lanes).toEqual({ engineered: 1, like_in_kind: 1, legacy_gate: 1, not_recorded: 1 });
    expect(summarizeReviewLanes(rows, { from: "2026-10-06", to: null }).total).toBe(0);
    expect(summarizeReviewLanes(rows, { from: null, to: "2026-09-01" }).total).toBe(1);
    expect(periodBound("2026-13-45x")).toBeNull();
    expect(filedInPeriod(t({ createdAt: "garbage" }), { from: null, to: null })).toBe(true);
    expect(filedInPeriod(t({ createdAt: "garbage" }), { from: "2026-01-01", to: null })).toBe(false);
  });
  it("the CSV encodes every cell through lib/csvSafe (a formula-leading statement is text)", () => {
    const csv = reviewLaneReportCsv(summarizeReviewLanes(rows, { from: null, to: null }), (k, v) => `${k}:${v}`);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain("REQ-2,T,CLOSED,2026-10-05,2026-10-05T10:00:00.000Z,Rae Q,Same gasket,workClasses:lik,codeClasses:c1");
    expect(read("lib/reviewLaneReport.ts")).toContain('import { csvLine } from "@/lib/csvSafe";');
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
});
