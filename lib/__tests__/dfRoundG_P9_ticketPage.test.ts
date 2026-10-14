// lib/__tests__/dfRoundG_P9_ticketPage.test.ts
//
// drafting-flow Round G, DF-P9 TICKET-PAGE — the request page's and the
// queue's decisions, tested where they are made (pure modules; the pages
// import them):
//
//   UI-7         lib/ticketStatusLabels.ts — every status has words; no snake case
//   FRIC-3/8     ticketUnitDisplay — the unit as a person reads it
//   EDGE-6 / ROUTE-8   drafterCandidates — the route's own assignment test
//   SM-13        missingRequiredFile — the file an action needs, by type
//   DCW-1 / DCW-7      triagePayload — what the assign modal sends
//   PROJ-9       customCategorySections / projectRefOf
//   FRIC-7       loadRequesterRoles + AttentionContext.requesterRoles
//   ROUTE-1 dw2  attentionLabel({ hasDrafter })
//   UI-1         holdersFor / waitingSince / waitedFor (+ a census of the
//                history lines against the engine's labels)
//   UI-4         explainNoActions
//   PROD-4 dw3   computeTransition's default audience includes the engineer

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  TICKET_STATUS_LABELS,
  TICKET_STATUS_FILTER_ORDER,
  ticketStatusLabel,
  ticketUnitDisplay,
  NO_UNIT_RECORDED_LABEL,
} from "@/lib/ticketStatusLabels";
import { UNIT_UNKNOWN_LABEL } from "@/lib/ticketCreate";
import {
  pickRoles,
  drafterCandidates,
  NO_DRAFTER_CANDIDATES,
  REQUESTER_CANNOT_DRAFT,
  requiredFileType,
  missingRequiredFile,
  triagePayload,
  customCategorySections,
  projectRefOf,
} from "@/lib/ticketPage";
import { loadRequesterRoles, REQUESTER_ROLES_CHUNK } from "@/lib/ticketRequesterRoles";
import {
  isActionRequired,
  attentionLabel,
  holdersFor,
  waitingSince,
  waitedFor,
  explainNoActions,
  requesterRolesFor,
  NON_STEP_HISTORY_ACTIONS,
} from "@/lib/ticketAttention";
import { WorkflowEngine, ticketResource } from "@/lib/workflow";
import { computeTransition } from "@/lib/ticketTransitions";
import type { CapabilityPolicy } from "@/lib/capabilityPolicy";
import type { Ticket, TicketStatus, Role, TicketAttachment, CustomCategoryConfig } from "@/types/schema";

const NOW = "2026-10-14T12:00:00.000Z";

function mk(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "t-1",
    orgId: "org-1",
    ticketId: "KE-DDRT-26-0001",
    title: "Pump iso",
    unit: "U-100",
    requestType: "ISO",
    status: "PENDING_ASSIGNMENT",
    requesterId: "u-req",
    requesterName: "Rita Requester",
    requesterRole: "Requester",
    attachments: [],
    comments: [],
    history: [],
    unreadBy: [],
    watchers: [],
    createdAt: "2026-10-01T12:00:00.000Z",
    ...over,
  } as Ticket;
}

const ALL_STATUSES: TicketStatus[] = [
  "PENDING_ASSIGNMENT", "PENDING_ENG_TEAM", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW",
  "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT", "CLOSED", "CANCELED",
];

// ── UI-7 ─────────────────────────────────────────────────────────────────────

describe("UI-7 — a status is shown in words, never as its database identifier", () => {
  it("every status has a label, none is SHOUTED_SNAKE_CASE, and the filter offers each once in workflow order", () => {
    for (const s of ALL_STATUSES) {
      const label = TICKET_STATUS_LABELS[s];
      expect(label, s).toBeTruthy();
      expect(label, s).not.toMatch(/_/);
      expect(label, s).not.toBe(s);
      expect(ticketStatusLabel(s)).toBe(label);
    }
    expect([...TICKET_STATUS_FILTER_ORDER].sort()).toEqual([...ALL_STATUSES].sort());
    expect(new Set(TICKET_STATUS_FILTER_ORDER).size).toBe(ALL_STATUSES.length);
  });
  it("FINAL_DRAFT no longer reads as unfinished: it says the package was issued and awaits acknowledgement", () => {
    expect(ticketStatusLabel("FINAL_DRAFT")).toBe("Issued — awaiting acknowledgement");
    expect(ticketStatusLabel("FINAL_DRAFT")).not.toMatch(/draft/i);
    expect(ticketStatusLabel("PENDING_ASSIGNMENT")).toBe("Awaiting drafter");
    expect(ticketStatusLabel("PENDING_IFC")).toBe("Ready to issue (IFC)");
  });
  it("a value this build does not know is shown in words; a missing one says so", () => {
    expect(ticketStatusLabel("SOME_NEW_STATE")).toBe("Some new state");
    expect(ticketStatusLabel(null)).toBe("Unknown status");
    expect(ticketStatusLabel(undefined)).toBe("Unknown status");
    expect(ticketStatusLabel("")).toBe("Unknown status");
  });
});

// ── FRIC-3 / FRIC-8 readers ──────────────────────────────────────────────────

describe("FRIC-3 / FRIC-8 — the unit as a person reads it (DF-P2's explicit unknown, unlisted, unchecked)", () => {
  it("a unit on the list is shown as is", () => {
    expect(ticketUnitDisplay("U-100", {})).toEqual({ text: "U-100", note: null, unknown: false });
  });
  it("a kept unit that is not on the workspace's list is marked", () => {
    expect(ticketUnitDisplay("U-999", { unit_unlisted: true })).toEqual({ text: "U-999", note: "not on the unit list", unknown: false });
  });
  it("a unit given but not checked (the list could not be read) is shown with what it is", () => {
    const d = ticketUnitDisplay(null, { unit_unchecked: "U-7" });
    expect(d.text).toBe("U-7");
    expect(d.note).toMatch(/not checked/);
    expect(d.unknown).toBe(true);
  });
  it("an explicitly unknown unit says so; a bare NULL claims nothing", () => {
    expect(ticketUnitDisplay(null, { unit_unknown: true })).toEqual({ text: UNIT_UNKNOWN_LABEL, note: null, unknown: true });
    expect(ticketUnitDisplay(null, null)).toEqual({ text: NO_UNIT_RECORDED_LABEL, note: null, unknown: true });
    expect(ticketUnitDisplay("   ", {})).toEqual({ text: NO_UNIT_RECORDED_LABEL, note: null, unknown: true });
  });
});

// ── EDGE-6 / ROUTE-8 ─────────────────────────────────────────────────────────

describe("EDGE-6 / ROUTE-8 — the drafter picker offers exactly whom the workflow route accepts", () => {
  const ticket = mk({ status: "PENDING_ASSIGNMENT" });
  const resource = ticketResource(ticket);
  it("a member holding Drafter beside a higher-ranked headline is offered (the old `.eq('role','Drafter')` hid them)", () => {
    const out = drafterCandidates([
      { uid: "u-1", email: "pat@x.com", role: "Engineer-2", roles: ["Engineer-2", "Drafter"], display_name: "Pat" },
      { uid: "u-2", email: "drew@x.com", role: "Drafter", roles: ["Drafter"] },
      { uid: "u-3", email: "vic@x.com", role: "Viewer", roles: ["Viewer"] },
    ], undefined, resource);
    expect(out.map((c) => c.uid)).toEqual(["u-2", "u-1"]); // sorted by name: "drew", "Pat"
    expect(out.find((c) => c.uid === "u-1")?.roles).toEqual(["Engineer-2", "Drafter"]);
    expect(out.find((c) => c.uid === "u-2")?.name).toBe("drew");
  });
  it("a legacy row with only the headline is read by its headline (the route's rule)", () => {
    expect(pickRoles({ role: "Drafter", roles: null })).toEqual(["Drafter"]);
    expect(pickRoles({ role: "Drafter", roles: [] })).toEqual(["Drafter"]);
    expect(pickRoles({ role: "Viewer", roles: ["Viewer", "Drafter"] })).toEqual(["Viewer", "Drafter"]);
    expect(pickRoles({})).toEqual([]);
  });
  it("the org's policy decides: a workspace that lets Engineers draft offers them; one that clears Drafter offers no Drafter", () => {
    const members = [
      { uid: "u-1", email: "e@x.com", role: "Engineer-1", roles: ["Engineer-1"] },
      { uid: "u-2", email: "d@x.com", role: "Drafter", roles: ["Drafter"] },
    ];
    const engineersDraft: CapabilityPolicy = { caps: { "ticket.draft_work": ["Engineer"] } };
    expect(drafterCandidates(members, engineersDraft, resource).map((c) => c.uid)).toEqual(["u-1"]);
    // a personal grant counts, as the route's policyAllows(…, uid) does
    const granted: CapabilityPolicy = { caps: { "ticket.draft_work": [] }, grants: [{ cap: "ticket.draft_work", uid: "u-1" } as never] };
    expect(drafterCandidates(members, granted, resource).map((c) => c.uid)).toEqual(["u-1"]);
  });
  it("matches the route's check member by member (policyAllows ticket.draft_work on the held collection)", async () => {
    const { policyAllows } = await import("@/lib/capabilityPolicy");
    const members = [
      { uid: "a", role: "Admin", roles: ["Admin"] },
      { uid: "b", role: "Manager", roles: ["Manager", "Drafter"] },
      { uid: "c", role: "DraftingSupervisor", roles: ["DraftingSupervisor"] },
      { uid: "d", role: "Drafter", roles: null },
      { uid: "e", role: "Requester", roles: ["Requester"] },
    ];
    const offered = new Set(drafterCandidates(members, undefined, resource).map((c) => c.uid));
    for (const m of members) {
      const held = pickRoles(m);
      expect(offered.has(m.uid), m.uid).toBe(policyAllows(undefined, "ticket.draft_work", held[0], held, m.uid, resource));
    }
  });
  it("fix pass — the route's per-ticket refusals: the requester (org of 3+) is shown refused, the current drafter is not offered on a reassignment", () => {
    const members = [
      { uid: "u-req", email: "rita@x.com", role: "Drafter", roles: ["Requester", "Drafter"], display_name: "Rita" },
      { uid: "d-1", email: "hector@x.com", role: "Drafter", roles: ["Drafter"], display_name: "Hector" },
      { uid: "d-2", email: "dee@x.com", role: "Drafter", roles: ["Drafter"], display_name: "Dee" },
    ];
    // 3+ members: the route 403s the requester as their own drafter (GAP-2 / DEC-12) — listed, refused, with the reason
    const sod = drafterCandidates(members, undefined, resource, { requesterId: "u-req", activeMemberCount: 3 });
    expect(sod.find((c) => c.uid === "u-req")?.refusedReason).toBe(REQUESTER_CANNOT_DRAFT);
    expect(sod.filter((c) => c.refusedReason).map((c) => c.uid)).toEqual(["u-req"]);
    // below 3 the single-person loop is legal (DEC-12): the requester is a plain candidate
    const small = drafterCandidates(members, undefined, resource, { requesterId: "u-req", activeMemberCount: 2 });
    expect(small.find((c) => c.uid === "u-req")?.refusedReason).toBeUndefined();
    // a reassignment never lists the drafter already assigned (the route 400s "already assigned", WF-18)
    const re = drafterCandidates(members, undefined, resource, { assignedDrafterId: "d-1", isReassignment: true, activeMemberCount: 3, requesterId: "u-req" });
    expect(re.map((c) => c.uid)).toEqual(["d-2", "u-req"]); // "Dee", "Rita"
    // a first assignment is not a reassignment: the route has no "already assigned" check there
    expect(drafterCandidates(members, undefined, resource, { assignedDrafterId: "d-1", isReassignment: false }).map((c) => c.uid)).toContain("d-1");
    // no context → exactly the policy test, as before
    expect(drafterCandidates(members, undefined, resource).every((c) => !c.refusedReason)).toBe(true);
  });
  it("nobody eligible → empty, and the empty state names the reason and the fix", () => {
    expect(drafterCandidates([{ uid: "v", role: "Viewer", roles: ["Viewer"] }], undefined, resource)).toEqual([]);
    expect(drafterCandidates([{ role: "Drafter" }], undefined, resource)).toEqual([]); // no uid
    expect(NO_DRAFTER_CANDIDATES).toMatch(/Drafter role/);
    expect(NO_DRAFTER_CANDIDATES).toMatch(/Admin → Users/);
  });
});

// ── SM-13 (client half) ──────────────────────────────────────────────────────

describe("SM-13 — the file an action needs, by TYPE (any attachment used to satisfy it)", () => {
  const submitDraft = { action: "submit_draft", requiresFile: true };
  const submitFinal = { action: "submit_final", requiresFile: true };
  const att = (type: TicketAttachment["type"]) => ({ type });
  it("Submit Draft needs a Draft on the ticket — a Reference or Source does not do", () => {
    expect(requiredFileType(submitDraft)).toBe("Draft");
    expect(missingRequiredFile(submitDraft, [])).toMatch(/Draft/);
    expect(missingRequiredFile(submitDraft, [att("Reference"), att("Source")])).toMatch(/no Draft/);
    expect(missingRequiredFile(submitDraft, [att("Reference"), att("Draft")])).toBeNull();
    expect(missingRequiredFile(submitDraft, null)).toMatch(/Draft/);
  });
  it("Issue Final needs the IFC upload's file typed Final; before the upload the modal supplies it", () => {
    expect(requiredFileType(submitFinal)).toBe("Final");
    expect(missingRequiredFile(submitFinal, [])).toBeNull(); // undefined finalFile: the IFC upload modal opens next
    expect(missingRequiredFile(submitFinal, [], att("Final"))).toBeNull();
    expect(missingRequiredFile(submitFinal, [], att("Draft"))).toMatch(/Final/);
    expect(missingRequiredFile(submitFinal, [], null)).toMatch(/Final/);
  });
  it("an action that needs no file is never held", () => {
    expect(requiredFileType({ action: "approve_draft_ifc" })).toBeNull();
    expect(missingRequiredFile({ action: "approve_draft_ifc" }, [])).toBeNull();
    expect(requiredFileType({ action: "something_else", requiresFile: true })).toBeNull();
  });
});

// ── DCW-1 / DCW-7 ────────────────────────────────────────────────────────────

describe("DCW-1 / DCW-7 — the triage fields the assign modal sends", () => {
  it("nothing chosen → nothing sent (neither is ever required, DEC-107)", () => {
    expect(triagePayload(mk(), {})).toEqual({});
    expect(triagePayload(mk(), { libraryId: "", unit: "" })).toEqual({});
  });
  it("a library is sent when chosen; a unit only when it differs or the row carries a unit mark", () => {
    expect(triagePayload(mk({ unit: "U-100" }), { libraryId: "lib-1", unit: "U-100" })).toEqual({ libraryId: "lib-1" });
    expect(triagePayload(mk({ unit: "U-100" }), { unit: "U-200" })).toEqual({ unit: "U-200" });
    expect(triagePayload(mk({ unit: null }), { unit: "U-200" })).toEqual({ unit: "U-200" });
    expect(triagePayload(mk({ unit: "U-100", metadata: { unit_unlisted: true } }), { unit: "U-100" })).toEqual({ unit: "U-100" });
    expect(triagePayload(mk({ unit: null, metadata: { unit_unchecked: "U-7" } }), { unit: " U-7 " })).toEqual({ unit: "U-7" });
  });
});

// ── PROJ-9 ───────────────────────────────────────────────────────────────────

describe("PROJ-9 — the request's write-only metadata is rendered", () => {
  const config: CustomCategoryConfig[] = [{
    id: "cat-1", label: "Hazards", enabled: true,
    fields: [
      { key: "h2s", label: "H2S present", type: "checkbox" as never },
      { key: "zone", label: "Electrical zone", type: "select" as never, options: [{ value: "z1", label: "Zone 1" }, { value: "z2", label: "Zone 2" }] as never },
    ],
  }];
  it("answers carry their configured labels; option values read as their labels; booleans as Yes/No", () => {
    const out = customCategorySections({ custom_categories: { "cat-1": { h2s: true, zone: "z2", blank: "" } } }, config);
    expect(out).toEqual([{ id: "cat-1", label: "Hazards", fields: [
      { key: "h2s", label: "H2S present", value: "Yes" },
      { key: "zone", label: "Electrical zone", value: "Zone 2" },
    ] }]);
  });
  it("an answer whose question was renamed or removed is still shown (its key in words), never hidden", () => {
    const out = customCategorySections({ custom_categories: { "gone-cat": { line_size: "6in", tags: ["a", "b"] } } }, config);
    expect(out).toEqual([{ id: "gone-cat", label: "Request details", fields: [
      { key: "line_size", label: "Line size", value: "6in" },
      { key: "tags", label: "Tags", value: "a, b" },
    ] }]);
  });
  it("no answers → no section; malformed metadata → nothing", () => {
    expect(customCategorySections({}, config)).toEqual([]);
    expect(customCategorySections({ custom_categories: { "cat-1": { h2s: null } } }, config)).toEqual([]);
    expect(customCategorySections({ custom_categories: [] }, config)).toEqual([]);
    expect(customCategorySections(null, null)).toEqual([]);
  });
  it("the project a request is linked to is read from its intake collision", () => {
    expect(projectRefOf({ intake_collision: { projectId: " p-1 " } })).toBe("p-1");
    expect(projectRefOf({ intake_collision: { projectId: "" } })).toBeNull();
    expect(projectRefOf({ intake_collision: "p-1" })).toBeNull();
    expect(projectRefOf(undefined)).toBeNull();
  });
});

// ── FRIC-7 ───────────────────────────────────────────────────────────────────

function memberClient(rows: Array<{ uid: string; role?: string; roles?: string[] | null }>, opts: { error?: boolean } = {}) {
  const calls: string[][] = [];
  const client = {
    from: (table: string) => {
      expect(table).toBe("org_members");
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => { filters[k] = v; return chain; },
        in: (k: string, ids: string[]) => {
          calls.push(ids);
          expect(filters).toEqual({ org_id: "org-1", status: "active" });
          if (opts.error) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: rows.filter((r) => ids.includes(r.uid)), error: null });
        },
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}

describe("FRIC-7 — the badge is given the requesters' CURRENT roles, as the route and the page are", () => {
  it("loadRequesterRoles: active members' held roles; a requester the read did not return is known gone ([])", async () => {
    const { client, calls } = memberClient([{ uid: "r-1", role: "Requester", roles: ["Requester"] }, { uid: "r-2", role: "Engineer-1", roles: null }]);
    const out = await loadRequesterRoles("org-1", ["r-1", "r-2", "r-gone", "r-1", "", null, undefined], client);
    expect(calls).toEqual([["r-1", "r-2", "r-gone"]]);
    expect(out?.get("r-1")).toEqual(["Requester"]);
    expect(out?.get("r-2")).toEqual(["Engineer-1"]);
    expect(out?.get("r-gone")).toEqual([]);
    expect(out?.has("r-other")).toBe(false);
  });
  it("reads in slices (the URL budget) and a failed read is unknown for all (null) — nothing invents a departure", async () => {
    const ids = Array.from({ length: REQUESTER_ROLES_CHUNK * 2 + 5 }, (_, i) => `r-${i}`);
    const { client, calls } = memberClient([]);
    const out = await loadRequesterRoles("org-1", ids, client);
    expect(calls.map((c) => c.length)).toEqual([REQUESTER_ROLES_CHUNK, REQUESTER_ROLES_CHUNK, 5]);
    expect(out?.size).toBe(ids.length);
    const failing = memberClient([], { error: true });
    expect(await loadRequesterRoles("org-1", ["r-1"], failing.client)).toBeNull();
    expect(await loadRequesterRoles("org-1", [], failing.client)).toEqual(new Map());
  });
  it("a departed requester's co-review is counted for the engineers and management the page offers it to", () => {
    const t = mk({ status: "PENDING_REVIEW", requesterId: "req-1", assignedDrafterId: "d-1" });
    const gone = new Map([["req-1", [] as string[]]]);
    const present = new Map([["req-1", ["Requester"]]]);
    for (const [role, uid] of [["Engineer-2", "e-9"], ["Admin", "a-1"], ["Manager", "m-1"]] as const) {
      expect(isActionRequired(t, { uid, roles: [role] }), `${role} unknown`).toBe(false); // unchanged default
      expect(isActionRequired(t, { uid, roles: [role], requesterRoles: present }), `${role} present`).toBe(false);
      expect(isActionRequired(t, { uid, roles: [role], requesterRoles: gone }), `${role} departed`).toBe(true);
      // exactly the page's engine call with the same input
      const page = WorkflowEngine.getActions(t, role as Role, uid, undefined, { userRoles: [role], requesterRoles: [] });
      expect(page.some((a) => !a.optional && !a.disabledReason)).toBe(true);
    }
    // a requester the map does not cover is unknown → assumed present
    expect(isActionRequired(t, { uid: "e-9", roles: ["Engineer-2"], requesterRoles: new Map([["someone-else", []]]) })).toBe(false);
    expect(requesterRolesFor(t, { requesterRoles: null })).toBeUndefined();
    expect(requesterRolesFor(t, { requesterRoles: gone })).toEqual([]);
  });
});

// ── ROUTE-1 done-when 2 ──────────────────────────────────────────────────────

describe("ROUTE-1 done-when 2 — a revision nobody owns is not 'in progress'", () => {
  it("without a drafter the label asks for one; with one (or no option) it is what it always was", () => {
    expect(attentionLabel("REVISION_REQ", { hasDrafter: false })).toBe("Revision requested — needs a drafter");
    expect(attentionLabel("DRAFTING", { hasDrafter: false })).toBe("Needs a drafter assigned");
    expect(attentionLabel("PENDING_IFC", { hasDrafter: false })).toMatch(/needs a drafter/i);
    expect(attentionLabel("REVISION_REQ", { hasDrafter: true })).toBe("Drafting in progress");
    expect(attentionLabel("REVISION_REQ")).toBe("Drafting in progress");
    expect(attentionLabel("PENDING_IFC")).toBe("Issue the IFC package");
    expect(attentionLabel("PENDING_REVIEW", { hasDrafter: false })).toBe("Needs review");
  });
});

// ── UI-1 ─────────────────────────────────────────────────────────────────────

describe("UI-1 — who a request waits on, and since when", () => {
  it("the queue (named when resolved), the drafter, the engineer, the requester — by status; terminal waits on nobody", () => {
    expect(holdersFor(mk({ status: "PENDING_ASSIGNMENT" }))).toEqual([{ kind: "queue", uid: null, name: "the assignment queue", part: "assigns a drafter" }]);
    expect(holdersFor(mk({ status: "PENDING_ASSIGNMENT" }), { queueNames: ["Sam", " ", "Alex"] }).map((h) => h.name)).toEqual(["Sam", "Alex"]);
    expect(holdersFor(mk({ status: "DRAFTING", assignedDrafterId: "d-1", assignedDrafterName: "Hector" }))).toEqual([{ kind: "drafter", uid: "d-1", name: "Hector", part: "the drafter" }]);
    expect(holdersFor(mk({ status: "REVISION_REQ", assignedDrafterId: null }))[0].kind).toBe("queue");
    expect(holdersFor(mk({ status: "PENDING_ENG_TEAM", assignedEngineerId: "e-1", assignedEngineerName: "Brady" }))[0]).toMatchObject({ kind: "engineer", uid: "e-1", name: "Brady" });
    expect(holdersFor(mk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: null }))[0]).toMatchObject({ kind: "engineer", uid: null, name: "an engineer" });
    expect(holdersFor(mk({ status: "PENDING_REVIEW" }))[0]).toMatchObject({ kind: "requester", uid: "u-req", name: "Rita Requester" });
    expect(holdersFor(mk({ status: "FINAL_DRAFT", requesterName: undefined, requesterEmail: "rita@x.com" } as Partial<Ticket>))[0].name).toBe("rita");
    expect(holdersFor(mk({ status: "PENDING_REVIEW" }), { requesterRoles: [] })[0].kind).toBe("co_reviewers");
    expect(holdersFor(mk({ status: "PENDING_REVIEW" }), { requesterRoles: null })[0].kind).toBe("requester");
    expect(holdersFor(mk({ status: "CLOSED" }))).toEqual([]);
    expect(holdersFor(mk({ status: "CANCELED" }))).toEqual([]);
  });
  it("fix pass — the co-reviewer pool is described as the ENGINE draws it (direct approvers, management; with no requester, requester-reviewers too)", () => {
    const required = (t: Ticket, role: Role, uid: string, requesterRoles?: string[]) =>
      WorkflowEngine.getActions(t, role, uid, undefined, { userRoles: [role], ...(requesterRoles ? { requesterRoles } : {}) })
        .some((a) => !a.optional && !a.disabledReason);
    for (const status of ["PENDING_REVIEW", "FINAL_DRAFT"] as const) {
      // the requester has left: engineers (ticket.direct_approve) AND management (ticket.manage) must act
      const gone = mk({ status, requesterId: "req-1", assignedDrafterId: "d-1" });
      const goneHolder = holdersFor(gone, { requesterRoles: [] })[0];
      expect(goneHolder.kind).toBe("co_reviewers");
      expect(goneHolder.name).toMatch(/engineer/i);
      expect(goneHolder.name).toMatch(/management/i);
      expect(goneHolder.part).toMatch(/no longer an active member/);
      expect(required(gone, "Engineer-2", "e-9", []), `${status} engineer`).toBe(true);
      expect(required(gone, "Manager", "m-1", []), `${status} manager`).toBe(true);
      expect(required(gone, "Requester", "r-9", []), `${status} another requester`).toBe(false); // not in this pool
      // no requester on the ticket at all: requester-reviewers join the pool
      const none = mk({ status, requesterId: null as never, assignedDrafterId: "d-1" });
      const noneHolder = holdersFor(none)[0];
      expect(noneHolder.kind).toBe("co_reviewers");
      expect(noneHolder.name).toMatch(/requester-reviewer/);
      expect(noneHolder.name).toMatch(/engineer/i);
      expect(noneHolder.name).toMatch(/management/i);
      expect(required(none, "Requester", "r-9"), `${status} requester-reviewer`).toBe(true);
      expect(required(none, "Engineer-2", "e-9"), `${status} engineer, no requester`).toBe(true);
      expect(required(none, "Manager", "m-1"), `${status} manager, no requester`).toBe(true);
    }
    // a party to the request is told it is not their step, without a broken possessive
    const t = mk({ status: "PENDING_REVIEW", requesterId: "req-1", assignedDrafterId: "d-1" });
    const out = explainNoActions(t, { uid: "d-1", roles: ["Drafter"], requesterRoles: new Map([["req-1", []]]), holders: holdersFor(t, { requesterRoles: [] }) });
    expect(out.text).toMatch(/^You are the drafter — this step is not yours \(waiting on a reviewer — engineers or management: needs review\)\.$/);
  });
  it("waitingSince is the newest line that moved the stage or its holder — a file, a save or the triage note does not reset it", () => {
    const t = mk({
      createdAt: "2026-10-01T00:00:00.000Z",
      history: [
        { action: "Created", user: "r", role: "Requester", date: "2026-10-01T00:00:00.000Z" },
        { action: "Assign Drafter", user: "s", role: "DraftingSupervisor", date: "2026-10-03T00:00:00.000Z" },
        { action: "Triage details set", user: "s", role: "DraftingSupervisor", date: "2026-10-03T00:00:00.000Z" },
        { action: "File Uploaded", user: "d", role: "Drafter", date: "2026-10-05T00:00:00.000Z" },
        { action: "Save Progress (Stage Files)", user: "d", role: "Drafter", date: "2026-10-06T00:00:00.000Z" },
      ] as never,
    });
    expect(waitingSince(t)?.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(waitingSince(mk({ history: [], createdAt: "2026-10-02T00:00:00.000Z" }))?.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(waitingSince(mk({ history: [{ action: "Request Revision", date: { seconds: 1_760_000_000 } }] as never }))?.getTime()).toBe(1_760_000_000_000);
    expect(waitingSince(mk({ history: [], createdAt: undefined as never }))).toBeNull();
  });
  it("waitedFor reads in hours under two days, then days", () => {
    const now = new Date("2026-10-14T12:00:00.000Z");
    expect(waitedFor(new Date("2026-10-14T11:30:00.000Z"), now)).toBe("under an hour");
    expect(waitedFor(new Date("2026-10-14T11:00:00.000Z"), now)).toBe("1 hour");
    expect(waitedFor(new Date("2026-10-13T00:00:00.000Z"), now)).toBe("36 hours");
    expect(waitedFor(new Date("2026-10-04T12:00:00.000Z"), now)).toBe("10 days");
    expect(waitedFor(null, now)).toBeNull();
    expect(waitedFor(new Date("2026-10-15T00:00:00.000Z"), now)).toBeNull();
  });

  it("census: every history line the engine's actions write is a step exactly when it moves the stage or its holder", () => {
    const roles: Role[] = ["Admin", "Manager", "DraftingSupervisor", "Engineer-2", "Drafter", "Requester"];
    const uidOf: Record<string, string> = { Admin: "a-1", Manager: "m-1", DraftingSupervisor: "s-1", "Engineer-2": "e-1", Drafter: "d-1", Requester: "u-req" };
    const variants: Partial<Ticket>[] = [
      { assignedDrafterId: "d-1", assignedDrafterName: "D", assignedEngineerId: "e-1", assignedEngineerName: "E" },
      { assignedDrafterId: null, assignedEngineerId: null },
      // a Draft on the ticket (Submit Draft is offered) and a close-without-review type (Answer & Close RFI)
      { assignedDrafterId: "d-1", assignedDrafterName: "D", requestType: "RFI", attachments: [{ id: "x", name: "x.pdf", url: "u", type: "Draft", status: "submitted" } as TicketAttachment] },
    ];
    const seen = new Map<string, boolean>(); // history action → moved?
    for (const status of ALL_STATUSES) {
      for (const v of variants) {
        const t = mk({ status, ...v });
        for (const role of roles) {
          const actions = WorkflowEngine.getActions(t, role, uidOf[role], undefined, { userRoles: [role] });
          for (const a of actions) {
            if (a.disabledReason) continue;
            const res = computeTransition(t, {
              actionType: a.action,
              actionLabel: a.label,
              variant: a.variant,
              comment: "because",
              assignment: { id: "d-new", name: "New Drafter" },
              engineer: { id: "e-new", name: "New Engineer", email: "ne@x.com" },
              attachment: { id: "f", name: "f.pdf", url: "u", type: "Reference", status: "submitted" } as TicketAttachment,
              finalAttachment: { id: "g", name: "g.pdf", url: "u", type: "Final", status: "submitted" } as TicketAttachment,
              outcome: a.outcomes?.[0] ?? null,
              actor: { uid: uidOf[role], email: `${role}@x.com`, role },
              now: NOW,
            });
            const u = res.updates;
            const moved = res.newStatus !== t.status
              || ("assigned_drafter_id" in u && u.assigned_drafter_id !== (t.assignedDrafterId ?? null))
              || ("assigned_engineer_id" in u && u.assigned_engineer_id !== (t.assignedEngineerId ?? null));
            const line = res.historyEntry.action;
            const isNonStep = NON_STEP_HISTORY_ACTIONS.includes(line);
            expect(isNonStep, `${status}/${role}: "${line}" (${a.action}) moved=${moved}`).toBe(!moved);
            seen.set(line, moved);
          }
        }
      }
    }
    // the census reached the non-step lines the engine writes (not a vacuous pass)
    expect(seen.get("File Uploaded")).toBe(false);
    expect(seen.get("Save Progress (Stage Files)")).toBe(false);
    expect(seen.get("Save Progress")).toBe(false);
    expect(seen.get("Submitted for review — Rev 1A")).toBe(true);
    expect(seen.get("Answer & Close RFI")).toBe(true);
    expect(seen.get("Reassign Drafter")).toBe(true); // moves the holder, not the stage
    expect(seen.size).toBeGreaterThan(20);
  });
});

// ── UI-4 ─────────────────────────────────────────────────────────────────────

describe("UI-4 — 'View Only' explained: not your turn vs not permitted, naming who to talk to", () => {
  const explain = (t: Ticket, uid: string, roles: Role[]) => explainNoActions(t, { uid, roles, holders: holdersFor(t, { queueNames: ["Sam"] }) });
  it("terminal requests say nothing waits", () => {
    expect(explain(mk({ status: "CLOSED" }), "v-1", ["Viewer"]).kind).toBe("terminal");
    expect(explain(mk({ status: "CANCELED" }), "v-1", ["Viewer"]).text).toMatch(/canceled/);
  });
  it("the requester while the drafter works: not your turn, naming the drafter", () => {
    const t = mk({ status: "DRAFTING", assignedDrafterId: "d-1", assignedDrafterName: "Hector" });
    const out = explain(t, "u-req", ["Requester"]);
    expect(out.kind).toBe("not_your_turn");
    expect(out.text).toMatch(/You are the requester/);
    expect(out.text).toMatch(/Hector/);
  });
  it("a drafter on a request in review: not your turn — they act at another stage (the pick-up)", () => {
    const t = mk({ status: "PENDING_REVIEW", assignedDrafterId: "d-1" });
    const out = explain(t, "d-9", ["Drafter"]);
    expect(out.kind).toBe("not_your_turn");
    expect(out.text).toMatch(/Rita Requester/);
  });
  it("a viewer: not permitted, naming the holder and pointing at Admin → Permissions", () => {
    const t = mk({ status: "PENDING_ASSIGNMENT" });
    const out = explain(t, "v-1", ["Viewer"]);
    expect(out.kind).toBe("not_permitted");
    expect(out.text).toMatch(/Sam/);
    expect(out.text).toMatch(/Admin → Permissions/);
  });
});

// ── PROD-4 done-when 3 ───────────────────────────────────────────────────────

describe("notifications PROD-4 done-when 3 — a transition's default audience includes the assigned engineer", () => {
  const t = mk({ status: "PENDING_FINAL_APPROVAL", requesterId: "u-req", assignedDrafterId: "d-1", assignedEngineerId: "e-1", attachments: [] });
  it("the drafter acting tells the requester AND the engineer the ticket waits on", () => {
    const { updates } = computeTransition(mk({ status: "REVISION_REQ", assignedDrafterId: "d-1", assignedEngineerId: "e-1" }), {
      actionType: "save_progress", actionLabel: "Save Progress", actor: { uid: "d-1", email: "d@x.com", role: "Drafter" }, now: NOW,
    });
    expect([...(updates.unread_by as string[])].sort()).toEqual(["e-1", "u-req"]);
  });
  it("the engineer acting is never told of their own act; one person in two parts is told once", () => {
    const { updates } = computeTransition(t, {
      actionType: "save_progress", actionLabel: "Save Progress", actor: { uid: "e-1", email: "e@x.com", role: "Engineer-2" }, now: NOW,
    });
    expect([...(updates.unread_by as string[])].sort()).toEqual(["d-1", "u-req"]);
    const same = computeTransition(mk({ status: "DRAFTING", requesterId: "e-1", assignedDrafterId: "d-1", assignedEngineerId: "e-1" }), {
      actionType: "save_progress", actionLabel: "Save Progress", actor: { uid: "d-1", email: "d@x.com", role: "Drafter" }, now: NOW,
    });
    expect(same.updates.unread_by).toEqual(["e-1"]);
  });
  it("no engineer assigned → exactly the audience it always was", () => {
    const { updates } = computeTransition(mk({ status: "DRAFTING", assignedDrafterId: "d-1", assignedEngineerId: null }), {
      actionType: "save_progress", actionLabel: "Save Progress", actor: { uid: "d-1", email: "d@x.com", role: "Drafter" }, now: NOW,
    });
    expect(updates.unread_by).toEqual(["u-req"]);
  });
});

// ── Source census over the request surfaces ──────────────────────────────────

describe("census — the request surfaces read the shared rules (no local stand-ins left)", () => {
  const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  const PAGES = ["app/(protected)/requests/page.tsx", "app/(protected)/requests/[id]/page.tsx"];
  it("no headline-only drafter filter, no 'unknown' actor stand-in, no status shown as its identifier", () => {
    for (const f of PAGES) {
      const code = src(f).replace(/\/\/[^\n]*/g, "");
      expect(code, f).not.toMatch(/\.eq\(\s*['"]role['"]\s*,\s*['"]Drafter['"]\s*\)/);
      expect(code, f).not.toMatch(/uid\s*\|\|\s*['"]unknown['"]/);
      expect(code, f).not.toMatch(/\.status\.replace\(\/_\/g/);
    }
  });
  it("one overdue rule on the queue (lib/notifications.ts isPastDue) — the board, its cards and the table", () => {
    const portal = src("app/(protected)/requests/page.tsx");
    expect(portal).toContain("overdue: count(g.tickets, (t) => isPastDue(t)),");
    expect(portal).toContain("const overdue = isPastDue(t);");
    expect(portal).toContain("const past = isPastDue(ticket);");
    expect(portal).not.toMatch(/new Date\(t\.targetCompletionAt as string\) < new Date\(\)/);
  });
  it("the workflow map's stage names are the status labels (one list), and the request form links the map", () => {
    expect(src("components/requests/WorkflowDiagramModal.tsx")).toContain('import { TICKET_STATUS_LABELS } from "@/lib/ticketStatusLabels";');
    const form = src("app/(protected)/requests/new/page.tsx");
    expect(form).toContain("import WorkflowDiagramModal from '@/components/requests/WorkflowDiagramModal';");
    expect(form).toMatch(/See how a request flows/);
  });
  it("ROUTE-7 (out-of-plan one-liner, recorded in 99-fix-sequencing): the feed says 'longest-waiting' only when the hook read oldest-first", () => {
    expect(src("components/cockpit/AttentionFeed.tsx")).toContain('{status.ticketsOldestFirst ? "longest-waiting" : "most recently active"}');
  });
  it("PERS-7 fix pass: the redline's uid check runs before its upload, and its audit row follows the accepted action", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    const uidCheck = page.indexOf(`if (!uid) throw new Error("You're not signed in, so the redline was not uploaded.");`);
    const upload = page.indexOf("const result = await uploadTicketAttachment({ file: redlineFile");
    const accepted = page.indexOf("if (res.status === 409) {\n        setActionLoading(null);");
    const audit = page.indexOf("action: 'TICKET_REDLINE_CREATED'");
    expect(uidCheck).toBeGreaterThan(0);
    expect(uidCheck).toBeLessThan(upload);
    expect(accepted).toBeGreaterThan(upload);
    expect(audit).toBeGreaterThan(accepted);
  });
  it("PERS-6: the badge hook maps a NULL unit as null, never a cast string", () => {
    const hook = src("hooks/useTicketNotifications.ts");
    expect(hook).toContain("unit: typeof row.unit === 'string' ? row.unit : null,");
    expect(hook).not.toContain("unit: row.unit as string");
  });
});

describe("PERS-3 done-when 3 — no unchecked supabase write in the /requests tree", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(n) ? [f] : [];
  });
  it("every .update / .insert / .upsert / .delete on a supabase chain destructures its error (and the census is not empty)", () => {
    const root = join(process.cwd(), "app/(protected)/requests");
    const sites: string[] = [];
    const unchecked: string[] = [];
    for (const f of walk(root)) {
      const code = readFileSync(f, "utf8").replace(/\/\/[^\n]*/g, "");
      const re = /\.from\(\s*['"][a-z_]+['"]\s*\)\s*\.(update|insert|upsert|delete)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        const at = `${f.slice(root.length + 1)}@${code.slice(0, m.index).split("\n").length}`;
        sites.push(at);
        // the statement's result is read: `{ … error … }` destructured within the next few hundred characters
        if (!/\{[^{}]*\berror\b[^{}]*\}/.test(code.slice(m.index, m.index + 600))) unchecked.push(at);
      }
    }
    expect(sites.length).toBeGreaterThanOrEqual(3); // the unread clear, the notifications read mark, mark urgent
    expect(unchecked).toEqual([]);
  });
});
