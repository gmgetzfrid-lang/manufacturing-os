// drafting-flow Round G, DF-P6 REVIEW-MODEL — the engine, the transitions and
// the pure rules of the review model.
//
//   DEC-33 acceptance: a Manager's / an Admin's / a DocCtrl's UNDECLARED
//   request cannot issue without the engineering sign-off; every issue
//   transition is gated (approve_draft_ifc, approve_minor_correction,
//   engineer_approve_final; submit_final is reached only through one of
//   them); drafting is never blocked; a DECLARED request reaches IFC with no
//   engineer and no added wait; request_eng_review / flag_engineering are a
//   ratchet — nothing writes engineering_required false.
//   REGRESSION (DEC-90 ruling (2) / (8)): a request the column cannot speak
//   for — before 20261250 (undefined) or a pre-paste row left false with no
//   declaration — is offered EXACTLY the actions it is offered today, per
//   transition, for every role (only SM-3's renamed management override
//   differs, and only at PENDING_FINAL_APPROVAL).
//   SM-3: only an engineer signs as the engineer; management overrides, and
//   the override is marked and never stamps engineer_approved_at.
//   TIER-1 done-when 2/3, GAP-110 acceptance 1–3, TIER-4, AUTHZ-6, GAP-102,
//   GAP-105, DEC-35.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WorkflowEngine, engineerApprovalRequired, engineeringGateRequired, ticketResource, ISSUING_APPROVALS, type WorkflowAction, type WorkflowContext } from "@/lib/workflow";
import { computeTransition, rowToTicket, classifyTransitionNotification, type TransitionInput } from "@/lib/ticketTransitions";
import {
  ticketEngineeringRequired, checkDeclarationStatement, declarationSignatureRefusal, declarationSignatureStatement,
  reviewClassOptions, resolveReviewClass, isMissingReviewModelColumn, engineeringBasis, LIKE_IN_KIND_MIN_CHARS, DECLARATION_BLANK_NOTE,
} from "@/lib/reviewModel";
import { CAPABILITY_DEFS, policyAllows, validateCapabilityPolicy, TICKET_RESOURCE_KEYS, RESOURCE_KEYS, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { parseRoutingControl, routingForWorkClass } from "@/lib/routingControl";
import { parseTicketCreateBody } from "@/lib/ticketCreate";
import { engineeringLine } from "@/components/requests/DeclarationCard";
import { parseEquipmentTags } from "@/components/requests/LikeInKindField";
import { editableClasses } from "@/components/requests/ReviewClassesSection";
import { ALL_ROLES, type Role, type Ticket, type TicketAttachment, type TicketStatus } from "@/types/schema";

const NOW = "2026-10-21T12:00:00.000Z";
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "submitted", rev: "1A" } as TicketAttachment;
const mk = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "Pump iso", unit: "U-100", requestType: "ISO",
  status: "PENDING_REVIEW", requesterId: "req", requesterRole: "Viewer", assignedDrafterId: "drf", assignedEngineerId: null,
  attachments: [DRAFT], comments: [], history: [], unreadBy: [], watchers: [], revisionCount: 0, deliverableRev: "1A", createdAt: NOW,
  ...over,
} as unknown as Ticket);
const DECLARED: Partial<Ticket> = {
  engineeringRequired: false,
  likeInKindStatement: "Replacing the 6 inch gasket with an identical spiral-wound gasket",
  likeInKindDeclaredBy: "req", likeInKindDeclaredAt: NOW, likeInKindSignatureId: "5a000000-0000-4000-8000-000000000001",
};
const names = (acts: WorkflowAction[]) => acts.map((a) => a.action);
const live = (acts: WorkflowAction[]) => names(acts.filter((a) => !a.disabledReason));
function inputFor(a: WorkflowAction, actor: { uid: string; role: string }, extra: Partial<TransitionInput> = {}): TransitionInput {
  return {
    actionType: a.action, actionLabel: a.label, variant: a.variant, comment: "note for the record",
    engineer: { id: "eng-new", name: "New Engineer", email: "eng-new@x.io" }, assignment: { id: "drf-new", name: "New Drafter" },
    engineeringOverride: a.engineeringOverride === true, reviewModelColumns: true,
    actor: { uid: actor.uid, email: `${actor.uid}@x.io`, role: actor.role }, now: NOW, ...extra,
  };
}

describe("TIER-1 / DEC-33 — engineering is required by the WORK, never by who asked", () => {
  it("an UNDECLARED request (engineering_required true) filed by a Manager, an Admin, a Supervisor or DocCtrl: its requester cannot issue it — only Send for Engineer Final Approval, and nothing it is offered lands on PENDING_IFC", () => {
    for (const r of ["Manager", "Admin", "Supervisor", "DocCtrl"] as Role[]) {
      const t = mk({ requesterRole: r, engineeringRequired: true });
      const acts = WorkflowEngine.getActions(t, r, "req", undefined, { userRoles: [r], requesterRoles: [r] });
      expect(names(acts), r).not.toContain("approve_draft_ifc");
      expect(names(acts), r).not.toContain("approve_minor_correction");
      expect(names(acts), r).toContain("request_final_engineer_approval");
      for (const a of acts) expect(computeTransition(t, inputFor(a, { uid: "req", role: r })).newStatus, `${r} / ${a.action}`).not.toBe("PENDING_IFC");
    }
  });
  it("TIER-1 done-when 3: a DECLARED like-in-kind request is approved by its requester whatever their role — a Viewer, a Maintenance planner — straight to IFC, with no PENDING_FINAL_APPROVAL hop (no added wait)", () => {
    for (const r of ["Viewer", "Maintenance", "Operations", "Requester"] as Role[]) {
      const t = mk({ requesterRole: r, ...DECLARED });
      const acts = WorkflowEngine.getActions(t, r, "req", undefined, { userRoles: [r], requesterRoles: [r] });
      expect(live(acts), r).toContain("approve_draft_ifc");
      expect(names(acts), r).not.toContain("request_final_engineer_approval");
      const res = computeTransition(t, inputFor(acts.find((a) => a.action === "approve_draft_ifc")!, { uid: "req", role: r }));
      expect(res.newStatus).toBe("PENDING_IFC");
      expect(res.updates.engineer_approved_at).toBeUndefined();
    }
  });
  it("ticketEngineeringRequired: true is required; false WITH a declaration is not; undefined or false WITHOUT one is the seed (the legacy gate, evaluated)", () => {
    const yes = () => true, no = () => false;
    expect(ticketEngineeringRequired({ engineeringRequired: true }, no)).toBe(true);
    expect(ticketEngineeringRequired({ ...DECLARED }, yes)).toBe(false);
    expect(ticketEngineeringRequired({ engineeringRequired: undefined }, yes)).toBe(true);
    expect(ticketEngineeringRequired({ engineeringRequired: undefined }, no)).toBe(false);
    expect(ticketEngineeringRequired({ engineeringRequired: false }, yes)).toBe(true);
    expect(ticketEngineeringRequired({ engineeringRequired: false }, no)).toBe(false);
    // a declaration whose statement is blank is no declaration
    expect(ticketEngineeringRequired({ engineeringRequired: false, likeInKindDeclaredAt: NOW, likeInKindStatement: "  " }, yes)).toBe(true);
  });
  it("engineeringGateRequired for a request the column cannot speak for IS engineerApprovalRequired (the seed), for every role and current collection", () => {
    for (const r of ALL_ROLES) {
      for (const current of [null, [] as string[], [r], [r, "Engineer-2"]]) {
        for (const er of [undefined, false] as const) {
          const t = mk({ requesterRole: r, engineeringRequired: er });
          expect(engineeringGateRequired(t, current, undefined), `${r} ${JSON.stringify(current)} ${er}`)
            .toBe(engineerApprovalRequired(r, current, undefined, "req", ticketResource(t)));
        }
      }
    }
  });
});

describe("REGRESSION (DEC-90 rulings (2) and (8)) — every issue transition is gated exactly where it is gated today for a request the column cannot speak for", () => {
  const STATUSES: TicketStatus[] = ["PENDING_ASSIGNMENT", "DRAFTING", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT"];
  it("per transition (approve_draft_ifc, approve_minor_correction, engineer_approve_final, submit_final) the same actors are offered it whether the column is absent (before the paste) or left false without a declaration (a pre-paste row) — the flag is the only addition, and only where the column exists", () => {
    let compared = 0;
    for (const req of ["Viewer", "Manager", "Engineer-2", "DocCtrl"] as Role[]) {
      for (const status of STATUSES) {
        for (const actorRole of ALL_ROLES) {
          for (const uid of ["req", "drf", "eng", "x"]) {
            const base = { status, requesterRole: req, assignedEngineerId: status === "PENDING_FINAL_APPROVAL" ? "eng" : null };
            const ctx: WorkflowContext = { userRoles: [actorRole], requesterRoles: [req] };
            const absent = WorkflowEngine.getActions(mk({ ...base }), actorRole, uid, undefined, ctx);
            const legacyFalse = WorkflowEngine.getActions(mk({ ...base, engineeringRequired: false }), actorRole, uid, undefined, ctx);
            const strip = (a: WorkflowAction[]) => a.filter((x) => x.action !== "flag_engineering").map((x) => `${x.action}:${x.disabledReason ?? ""}:${x.optional ? "o" : ""}`);
            expect(strip(legacyFalse), `${req}@${status} ${actorRole}/${uid}`).toEqual(strip(absent));
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });
  it("the requester branch at PENDING_REVIEW is exactly today's for a request the column cannot speak for: a gated requester is routed to an engineer, an exempt one approves directly", () => {
    expect(names(WorkflowEngine.getActions(mk({ requesterRole: "Viewer" }), "Viewer", "req", undefined, { userRoles: ["Viewer"], requesterRoles: ["Viewer"] }))).toEqual(["request_final_engineer_approval", "request_revision", "attach_file"]);
    expect(names(WorkflowEngine.getActions(mk({ requesterRole: "Manager" }), "Manager", "req", undefined, { userRoles: ["Manager"], requesterRoles: ["Manager"] }))).toEqual(["approve_draft_ifc", "approve_minor_correction", "request_revision", "close_ticket", "reassign_drafter", "attach_file"]);
  });
  it("submit_final at PENDING_IFC is offered to the drafter exactly as today, whatever the column says (it is reached only through a gated approval)", () => {
    for (const er of [undefined, false, true] as const) {
      const acts = WorkflowEngine.getActions(mk({ status: "PENDING_IFC", engineeringRequired: er }), "Drafter", "drf", undefined, { userRoles: ["Drafter"] });
      expect(live(acts), String(er)).toContain("submit_final");
    }
  });
  it("drafting is never blocked by the requirement: a required request in DRAFTING keeps save_progress and submit_draft for its drafter", () => {
    const acts = WorkflowEngine.getActions(mk({ status: "DRAFTING", engineeringRequired: true, attachments: [{ ...DRAFT, status: "staged" }] }), "Drafter", "drf", undefined, { userRoles: ["Drafter"] });
    expect(live(acts)).toEqual(expect.arrayContaining(["save_progress", "submit_draft"]));
  });
});

describe("GAP-111 — the binding flag, and the ratchet", () => {
  it("flag_engineering is offered to the assignment queue at PENDING_ASSIGNMENT, DRAFTING, REVISION_REQ and PENDING_REVIEW only while the column says false; it needs a reason and is optional", () => {
    for (const status of ["PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW"] as TicketStatus[]) {
      const flag = WorkflowEngine.getActions(mk({ status, ...DECLARED }), "DraftingSupervisor", "ds", undefined, { userRoles: ["DraftingSupervisor"] }).find((a) => a.action === "flag_engineering");
      expect(flag, status).toMatchObject({ requiresComment: true, optional: true });
    }
    for (const over of [{ engineeringRequired: true }, {}, { status: "PENDING_IFC" as TicketStatus, ...DECLARED }]) {
      expect(names(WorkflowEngine.getActions(mk({ status: "DRAFTING", ...over }), "DraftingSupervisor", "ds", undefined, { userRoles: ["DraftingSupervisor"] }))).not.toContain("flag_engineering");
    }
    // a Requester cannot flag
    expect(names(WorkflowEngine.getActions(mk({ status: "DRAFTING", ...DECLARED }), "Requester", "x", undefined, { userRoles: ["Requester"] }))).not.toContain("flag_engineering");
  });
  it("request_eng_review and flag_engineering write engineering_required = true (columns present); approve_team writes nothing for it; flag_engineering changes no status", () => {
    const t = mk({ status: "PENDING_ASSIGNMENT", ...DECLARED });
    const rer = computeTransition(t, { ...inputFor({ action: "request_eng_review", label: "Flag", variant: "secondary" }, { uid: "ds", role: "DraftingSupervisor" }) });
    expect(rer.updates.engineering_required).toBe(true);
    const flag = computeTransition(mk({ status: "DRAFTING", ...DECLARED }), inputFor({ action: "flag_engineering", label: "Require", variant: "secondary" }, { uid: "ds", role: "DraftingSupervisor" }));
    expect(flag.updates.engineering_required).toBe(true);
    expect(flag.updates.status).toBeUndefined();
    expect(flag.historyEntry).toMatchObject({ action: "Engineering sign-off required — flagged", details: "note for the record" });
    const team = computeTransition(mk({ status: "PENDING_ENG_TEAM", engineeringRequired: true }), inputFor({ action: "approve_team", label: "Done", variant: "success" }, { uid: "eng", role: "Engineer-2" }));
    expect("engineering_required" in team.updates).toBe(false);
    // before the paste nothing is written for the column
    expect("engineering_required" in computeTransition(t, inputFor({ action: "request_eng_review", label: "Flag", variant: "secondary" }, { uid: "ds", role: "DraftingSupervisor" }, { reviewModelColumns: false })).updates).toBe(false);
  });
  it("NO transition writes engineering_required false — every action name, every status", () => {
    const actions = ["save_progress", "attach_file", "cancel_request", "request_eng_review", "flag_engineering", "approve_team", "assign", "self_assign", "reassign_drafter", "submit_draft", "mark_issue_ready", "clear_issue_ready", "approve_draft_ifc", "approve_minor_correction", "request_final_engineer_approval", "engineer_approve_final", "override_engineer_final", "engineer_request_revision", "engineer_return_to_requester", "reassign_engineer", "request_revision", "reject", "reject_final", "submit_final", "close_ticket", "close_rfi", "reopen_ticket"];
    for (const status of ["PENDING_ASSIGNMENT", "DRAFTING", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT", "CLOSED"] as TicketStatus[]) {
      for (const action of actions) {
        for (const base of [{ engineeringRequired: true }, DECLARED]) {
          const res = computeTransition(mk({ status, ...base }), inputFor({ action, label: action, variant: "default" }, { uid: "x", role: "Admin" }, { reviewClass: { workClass: { value: "w", label: "W" } } }));
          expect(res.updates.engineering_required, `${status} ${action}`).not.toBe(false);
        }
      }
    }
  });
});

describe("SM-3 — only an engineer signs as the engineer; management overrides, recorded", () => {
  const atFinal = mk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "eng", requesterRole: "Viewer" });
  it("a Supervisor (and a Manager) at PENDING_FINAL_APPROVAL is NOT offered engineer_approve_final; they get override_engineer_final — optional, marked an override", () => {
    for (const r of ["Supervisor", "Manager", "Admin"] as Role[]) {
      const acts = WorkflowEngine.getActions(atFinal, r, "boss", undefined, { userRoles: [r] });
      expect(names(acts), r).not.toContain("engineer_approve_final");
      expect(acts.find((a) => a.action === "override_engineer_final"), r).toMatchObject({ optional: true, engineeringOverride: true });
      expect(acts.find((a) => a.action === "approve_minor_correction"), r).toMatchObject({ engineeringOverride: true });
    }
  });
  it("the assigned engineer, and a manager who holds an Engineer role, sign as the engineer (engineer_approve_final, stamped); with no engineer assigned a ticket.final_approve holder occupies the slot", () => {
    expect(names(WorkflowEngine.getActions(atFinal, "Engineer-2", "eng", undefined, { userRoles: ["Engineer-2"] }))).toContain("engineer_approve_final");
    const engMgr = WorkflowEngine.getActions(atFinal, "Manager", "boss", undefined, { userRoles: ["Manager", "Engineer-3"] });
    expect(names(engMgr)).toContain("engineer_approve_final");
    expect(names(engMgr)).not.toContain("override_engineer_final");
    const unassigned = mk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: null, requesterRole: "Viewer" });
    expect(names(WorkflowEngine.getActions(unassigned, "Engineer-1", "e9", undefined, { userRoles: ["Engineer-1"] }))).toContain("engineer_approve_final");
    const res = computeTransition(atFinal, inputFor(WorkflowEngine.getActions(atFinal, "Engineer-2", "eng", undefined, { userRoles: ["Engineer-2"] }).find((a) => a.action === "engineer_approve_final")!, { uid: "eng", role: "Engineer-2" }));
    expect(res.updates.engineer_approved_at).toBe(NOW);
  });
  it("the override issues (PENDING_IFC, the issued rev) WITHOUT engineer_approved_at, says so on its history line, and notifies as an approval; a management minor correction at final approval does not stamp either", () => {
    const acts = WorkflowEngine.getActions(atFinal, "Supervisor", "boss", undefined, { userRoles: ["Supervisor"] });
    const res = computeTransition(atFinal, inputFor(acts.find((a) => a.action === "override_engineer_final")!, { uid: "boss", role: "Supervisor" }));
    expect(res.newStatus).toBe("PENDING_IFC");
    expect(res.updates.deliverable_rev).toBe("1");
    expect(res.updates.engineer_approved_at).toBeUndefined();
    expect(res.historyEntry.details).toMatch(/Management override — issued without the engineer's sign-off/);
    expect(classifyTransitionNotification({ actionType: "override_engineer_final", actionLabel: "x", ticketLabel: "REQ-1" }).eventType).toBe("ticket_approved");
    const minor = computeTransition(atFinal, inputFor(acts.find((a) => a.action === "approve_minor_correction")!, { uid: "boss", role: "Supervisor" }));
    expect(minor.updates.engineer_approved_at).toBeUndefined();
    // the engineer's own minor correction still stamps (DEC-15)
    const engMinor = computeTransition(atFinal, inputFor(WorkflowEngine.getActions(atFinal, "Engineer-2", "eng", undefined, { userRoles: ["Engineer-2"] }).find((a) => a.action === "approve_minor_correction")!, { uid: "eng", role: "Engineer-2" }));
    expect(engMinor.updates.engineer_approved_at).toBe(NOW);
  });
  it("a non-engineer management co-reviewer's approval at PENDING_REVIEW of a request that requires engineering is kept (today's path) and marked an override", () => {
    const t = mk({ requesterRole: "Viewer", engineeringRequired: true });
    const acts = WorkflowEngine.getActions(t, "Supervisor", "boss", undefined, { userRoles: ["Supervisor"], requesterRoles: ["Viewer"] });
    expect(acts.find((a) => a.action === "approve_draft_ifc")).toMatchObject({ engineeringOverride: true, optional: true });
    // an engineer co-reviewer is not an override
    const eng = WorkflowEngine.getActions(t, "Engineer-2", "eng", undefined, { userRoles: ["Engineer-2"], requesterRoles: ["Viewer"] });
    expect(eng.find((a) => a.action === "approve_draft_ifc")?.engineeringOverride).toBeUndefined();
  });
});

describe("GAP-110 / DEC-34 — the declaration", () => {
  it("a typed statement of at least ~20 characters; blank / short / non-string refused with the reason (and the blank line on the form)", () => {
    expect(checkDeclarationStatement("Replacing the gasket with an identical one").ok).toBe(true);
    for (const bad of ["", "same", "x".repeat(LIKE_IN_KIND_MIN_CHARS - 1), 42, null]) {
      const r = checkDeclarationStatement(bad);
      expect(r.ok, String(bad)).toBe(false);
    }
    expect((checkDeclarationStatement("short") as { error: string }).error).toContain(DECLARATION_BLANK_NOTE);
    expect(checkDeclarationStatement("  Replacing   the gasket\n with an identical one  ")).toEqual({ ok: true, statement: "Replacing the gasket with an identical one" });
  });
  it("the contract: a declaration needs its statement, its signature and the id it is filed under; absent / null is no declaration (never a refusal)", () => {
    const portal = { orgId: "0a000000-0000-4000-8000-000000000001", title: "T", description: "D", requestType: "ISO", origin: { kind: "portal" } };
    const ok = parseTicketCreateBody({ ...portal, declaration: { statement: "Replacing the gasket with an identical one", signatureId: "5a000000-0000-4000-8000-000000000001", ticketKey: "7a000000-0000-4000-8000-000000000001" } });
    expect(ok.ok && ok.input.declaration?.statement).toBe("Replacing the gasket with an identical one");
    for (const d of [{ statement: "short", signatureId: "5a000000-0000-4000-8000-000000000001", ticketKey: "7a000000-0000-4000-8000-000000000001" }, { statement: "Replacing the gasket with an identical one" }, "text"]) {
      const r = parseTicketCreateBody({ ...portal, declaration: d });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.field).toBe("declaration");
    }
    const none = parseTicketCreateBody({ ...portal });
    expect(none.ok && none.input.declaration).toBeFalsy();
  });
  it("the signature must be the requester's, for THIS request id, in this workspace, over the statement typed, with the declaration intent, and recent", () => {
    const ctx = { orgId: "o1", ticketKey: "7A000000-0000-4000-8000-000000000001", requesterId: "u1", statement: "Replacing the gasket with an identical one", now: Date.parse(NOW) };
    const good = { id: "s", org_id: "o1", resource_type: "ticket", resource_id: "7a000000-0000-4000-8000-000000000001", signer_user_id: "u1", statement: declarationSignatureStatement(ctx.statement), intent: "Acknowledged", signed_at: NOW };
    expect(declarationSignatureRefusal(good, ctx)).toBeNull();
    expect(declarationSignatureRefusal(null, ctx)).toMatch(/not found/);
    expect(declarationSignatureRefusal({ ...good, org_id: "o2" }, ctx)).toMatch(/another workspace/);
    expect(declarationSignatureRefusal({ ...good, resource_id: "other" }, ctx)).toMatch(/different request/);
    expect(declarationSignatureRefusal({ ...good, signer_user_id: "u2" }, ctx)).toMatch(/Only the requester/);
    expect(declarationSignatureRefusal({ ...good, intent: "Approved" }, ctx)).toMatch(/does not record a declaration/);
    expect(declarationSignatureRefusal({ ...good, statement: declarationSignatureStatement("Something else entirely different") }, ctx)).toMatch(/changed after it was signed/);
    expect(declarationSignatureRefusal({ ...good, signed_at: "2026-10-21T10:00:00.000Z" }, ctx)).toMatch(/expired/);
  });
  it("GAP-110 acceptance 1: every ticket INSERT in the app is the create route's (all three doors post there), so every door either carries a declaration or records its absence (the column's default)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (n === "node_modules" || n === "__tests__") continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n) && /from\(\s*["']tickets["']\s*\)\s*\.insert\(/.test(readFileSync(p, "utf8"))) hits.push(p.replace(process.cwd() + "/", ""));
      }
    };
    for (const d of ["app", "lib", "components"]) walk(join(process.cwd(), d));
    expect(hits).toEqual(["app/api/tickets/create/route.ts"]);
  });
  it("rowToTicket maps the columns; undefined engineering_required (before the paste) stays undefined — the seed's signal", () => {
    const t = rowToTicket({ id: "t", engineering_required: false, like_in_kind_statement: "s", like_in_kind_declared_at: NOW, work_class: "w", code_class: "c" });
    expect(t).toMatchObject({ engineeringRequired: false, likeInKindStatement: "s", workClass: "w", codeClass: "c" });
    expect(rowToTicket({ id: "t" }).engineeringRequired).toBeUndefined();
  });
  it("the card says why — declared, required, or the earlier rule — and nothing before the paste", () => {
    expect(engineeringLine({ ...DECLARED })?.required).toBe(false);
    expect(engineeringLine({ engineeringRequired: true })?.text).toMatch(/no like-in-kind declaration was made/);
    expect(engineeringLine({ ...DECLARED, engineeringRequired: true })?.text).toMatch(/raised after the requester's like-in-kind declaration/);
    expect(engineeringLine({ engineeringRequired: false })?.text).toMatch(/earlier rule/);
    expect(engineeringLine({})).toBeNull();
    expect(engineeringBasis({ ...DECLARED }).kind).toBe("declared");
  });
  it("isMissingReviewModelColumn: 42703 / PGRST204 naming a 20261250 column only", () => {
    expect(isMissingReviewModelColumn({ code: "PGRST204", message: "Could not find the 'engineering_required' column of 'tickets' in the schema cache" })).toBe(true);
    expect(isMissingReviewModelColumn({ code: "42703", message: 'column "like_in_kind_statement" of relation "tickets" does not exist' })).toBe(true);
    expect(isMissingReviewModelColumn({ code: "42703", message: 'column "library_id" does not exist' })).toBe(false);
    expect(isMissingReviewModelColumn({ code: "23505", message: "engineering_required" })).toBe(false);
  });
});

describe("GAP-101 / TIER-4 / GAP-105 — classes and the resource", () => {
  it("the class lists are the workspace's own, seeded empty; a value off the list is unknown; absent is none", () => {
    expect(reviewClassOptions(null, "workClasses")).toEqual([]);
    const opts = reviewClassOptions({ workClasses: { options: [{ value: "lik", label: "Like-for-like" }, { value: "new", label: "", engineering: true }, { value: "lik", label: "dup" }] } }, "workClasses");
    expect(opts).toEqual([{ value: "lik", label: "Like-for-like" }, { value: "new", label: "new", engineering: true }]);
    expect(resolveReviewClass("new", opts)).toEqual({ kind: "ok", option: { value: "new", label: "new", engineering: true } });
    expect(resolveReviewClass("x", opts).kind).toBe("unknown");
    expect(resolveReviewClass("", opts).kind).toBe("none");
    expect(editableClasses({ codeClasses: { options: [{ value: "c", label: "C", engineering: true }] } } as never, "codeClasses").options).toEqual([{ value: "c", label: "C", engineering: true }]);
  });
  it("the resource carries the library, the work class and the code class only when the ticket has them", () => {
    expect(ticketResource({ requestType: "ISO", unit: "U" })).toStrictEqual({ requestType: "ISO", unit: "U" });
    expect(ticketResource({ requestType: "ISO", unit: "U", libraryId: "L", workClass: "w", codeClass: "c" })).toStrictEqual({ requestType: "ISO", unit: "U", libraryId: "L", workClass: "w", codeClass: "c" });
  });
  it("a rule scoped to a code class narrows a ticket capability there (TIER-4: 'this code's approvals by these people'); a work/code-class rule is refused on a capability the database evaluates", () => {
    const policy: CapabilityPolicy = { caps: { "ticket.direct_approve": [{ tokens: ["Engineer-3"], when: { codeClass: ["c1"] } }, { tokens: ["Engineer"] }] } };
    expect(validateCapabilityPolicy(policy)).toBeNull();
    expect(policyAllows(policy, "ticket.direct_approve", "Engineer-2", null, null, { codeClass: "c1" })).toBe(false);
    expect(policyAllows(policy, "ticket.direct_approve", "Engineer-3", null, null, { codeClass: "c1" })).toBe(true);
    expect(policyAllows(policy, "ticket.direct_approve", "Engineer-2", null, null, { codeClass: "c2" })).toBe(true);
    expect(validateCapabilityPolicy({ caps: { "holds.release": [{ tokens: ["Admin"], when: { workClass: ["w"] } }, { tokens: ["Admin"] }] } })).toMatch(/drafting-request capability only/);
    // the SQL-mirrored key list is unchanged (org_capability_allows_for is not re-created)
    expect(RESOURCE_KEYS).toEqual(["requestType", "unit", "libraryId", "discipline", "projectId"]);
    expect(TICKET_RESOURCE_KEYS).toEqual(["workClass", "codeClass"]);
  });
  it("TIER-4 done-when 3 / HAND-7: an approval says the code class and a moved source before it is taken, and asks for the acknowledgement", () => {
    const t = mk({ requesterRole: "Manager", codeClass: "Code 1" });
    const acts = WorkflowEngine.getActions(t, "Manager", "req", undefined, { userRoles: ["Manager"], requesterRoles: ["Manager"], sourceDrift: ["P-101 raised on Rev 3, now Rev 4"] });
    for (const a of acts.filter((x) => ISSUING_APPROVALS.has(x.action))) {
      expect(a.description, a.action).toMatch(/Code class: Code 1\./);
      expect(a.description, a.action).toMatch(/source revision has moved/);
      expect(a.requiresSourceDriftAck, a.action).toBe(true);
    }
    expect(acts.find((a) => a.action === "request_revision")?.requiresSourceDriftAck).toBeUndefined();
  });
});

describe("AUTHZ-6 — the capability descriptions state their reach", () => {
  const d = (id: string) => CAPABILITY_DEFS.find((x) => x.id === id)!.description;
  it("requester_review and draft_work act only where there is no requester / no drafter; direct_approve reaches every request in review", () => {
    expect(d("ticket.requester_review")).toMatch(/NO requester/);
    expect(d("ticket.requester_review")).toMatch(/never acts on another person's request/);
    expect(d("ticket.draft_work")).toMatch(/NO assigned drafter/);
    expect(d("ticket.draft_work")).toMatch(/never acts on another drafter's request/);
    expect(d("ticket.direct_approve")).toMatch(/ANY request in review/);
    expect(d("ticket.engineer_gate_exempt")).toMatch(/declared it like-in-kind/);
  });
});

describe("GAP-102 / TIER-3 — a notify-only slot per work class; never a condition on a sign-off", () => {
  it("work_classes is accepted on a notify-only slot, refused on a blocking one; a request of another class does not get the slot; an unclassified one does; blocking slots are never dropped", () => {
    const parsed = parseRoutingControl({ slots: [
      { kind: "eng", mode: "blocking", fill: { roles: ["Engineer"] } },
      { kind: "watch", label: "Told on issue", mode: "notify_only", fill: { capability: "ticket.final_approve" }, work_classes: ["new"] },
    ] });
    expect(parsed?.ok).toBe(true);
    const control = (parsed as { ok: true; control: Parameters<typeof routingForWorkClass>[0] }).control;
    expect(routingForWorkClass(control, "lik").slots.map((s) => s.kind)).toEqual(["eng"]);
    expect(routingForWorkClass(control, "new").slots.map((s) => s.kind)).toEqual(["eng", "watch"]);
    expect(routingForWorkClass(control, null).slots.map((s) => s.kind)).toEqual(["eng", "watch"]);
    const bad = parseRoutingControl({ slots: [{ kind: "eng", mode: "blocking", fill: { roles: ["Engineer"] }, work_classes: ["new"] }] });
    expect(bad?.ok).toBe(false);
  });
});

describe("GAP-312 — the equipment field", () => {
  it("tags split on commas, semicolons and new lines, de-duplicated case-insensitively, capped", () => {
    expect(parseEquipmentTags("P-101, fv-2201;\nP-101 , ")).toEqual(["P-101", "fv-2201"]);
    expect(parseEquipmentTags(Array.from({ length: 40 }, (_, i) => `T-${i}`).join(","))).toHaveLength(25);
  });
  it("the contract keeps a resolved asset only by its id shape; a bad entry is dropped, never a refusal", () => {
    const portal = { orgId: "0a000000-0000-4000-8000-000000000001", title: "T", description: "D", requestType: "ISO", origin: { kind: "portal" } };
    const r = parseTicketCreateBody({ ...portal, equipment: [{ tag: "P-101", assetId: "5a000000-0000-4000-8000-000000000001" }, { tag: "XV-9", assetId: "nope" }, { nope: true }, { tag: "p-101" }] });
    expect(r.ok && r.input.equipment).toEqual([{ tag: "P-101", assetId: "5a000000-0000-4000-8000-000000000001" }, { tag: "XV-9", assetId: null }]);
  });
});

describe("DEC-35 — no facility vocabulary in the files this package wrote", () => {
  it("the review model names no QA/QC, code, NDE or radiograph word (words built from fragments so this file adds no hit)", () => {
    const words = ["QA" + "QC", "QA/" + "QC", "B" + "31", "N" + "DE", "radio" + "graph"];
    for (const f of ["lib/reviewModel.ts", "components/requests/DeclarationCard.tsx", "components/requests/LikeInKindField.tsx", "components/requests/ReviewClassesSection.tsx", "supabase/migrations/20261250_df_roundG_review_model.sql", "supabase/migrations/20261251_df_roundG_ticket_equipment.sql"]) {
      const s = readFileSync(join(process.cwd(), f), "utf8");
      for (const w of words) expect(new RegExp(`\\b${w.replace("/", "\\/")}\\b`).test(s), `${f}: ${w}`).toBe(false);
    }
  });
});

describe("DCW-2 / GAP-104 — document control as a party: a per-library slot on the parallel roster, no added status", () => {
  it("a library whose routing names a document-control slot puts DocCtrl on the roster: they are offered the sign-off at the SAME status as the technical review, the badge counts it, and the request does not issue until they sign", async () => {
    const { openRoster } = await import("@/lib/ticketRoster");
    const { isActionRequired } = await import("@/lib/ticketAttention");
    const members = [
      { uid: "req", role: "Viewer", roles: ["Viewer"], email: "req@x.io", display_name: "req" },
      { uid: "drf", role: "Drafter", roles: ["Drafter"], email: "drf@x.io", display_name: "drf" },
      { uid: "eng", role: "Engineer-2", roles: ["Engineer-2"], email: "eng@x.io", display_name: "eng" },
      { uid: "dc", role: "DocCtrl", roles: ["DocCtrl"], email: "dc@x.io", display_name: "dc" },
    ];
    const parsed = parseRoutingControl({ slots: [
      { kind: "check", label: "Engineering check", mode: "blocking", fill: { roles: ["Engineer"] } },
      { kind: "release", label: "Document control release", mode: "blocking", fill: { roles: ["DocCtrl"] } },
    ] });
    if (!parsed || !parsed.ok) throw new Error("bad control");
    const r = openRoster({ id: "r-1", control: parsed.control, level: "library", cycle: "1A",
      files: [{ id: "a-d", name: "iso_1A.pdf", url: DRAFT.url, sha256: "f".repeat(64) }],
      ctx: { members, policy: null, resource: { requestType: "ISO", unit: null }, requesterId: "req" }, openedBy: "drf", now: NOW });
    if (!r.ok) throw new Error(r.error);
    const t = mk({ status: "PENDING_REVIEW", libraryId: "1b000000-0000-4000-8000-000000000001", metadata: { review_roster: r.roster } } as Partial<Ticket>);
    const dc = WorkflowEngine.getActions(t, "DocCtrl" as Role, "dc", undefined, { userRoles: ["DocCtrl"] });
    const eng = WorkflowEngine.getActions(t, "Engineer-2" as Role, "eng", undefined, { userRoles: ["Engineer-2"] });
    expect(live(dc)).toContain("sign_slot");
    expect(live(eng)).toContain("sign_slot");
    // no new status anywhere (no PENDING_DOC_CTRL — 99-fix-sequencing "Do not")
    expect(JSON.stringify(dc) + JSON.stringify(eng)).not.toMatch(/PENDING_DOC_CTRL/);
    // the badge reflects work DocCtrl can actually do
    expect(isActionRequired(t, { uid: "dc", roles: ["DocCtrl" as Role] })).toBe(true);
    // DocCtrl's sign-off alone does not issue: the engineering slot still waits
    const sign = dc.find((a) => a.action === "sign_slot")!;
    const res = computeTransition(t, inputFor(sign, { uid: "dc", role: "DocCtrl" }));
    expect(res.updates.status).toBeUndefined();
  });
});
