// lib/__tests__/ticketRouting.test.ts
//
// Freezes "who gets told when a request lands in a status" — the routing
// policy that drives new-request notifications. Includes a regression test for
// the production bug where listActiveMembers selected a non-existent column
// (org_members.name instead of display_name), which silently emptied the
// recipient list and killed every new-request notification.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable fixture the supabase mock reads from. vi.hoisted so the mock factory
// (which is hoisted above imports) can close over it.
const h = vi.hoisted(() => ({
  members: [] as Array<{ uid: string; role: string; roles?: string[]; display_name?: string | null; email?: string | null }>,
  routing: null as null | { adminsAlsoReceiveWhenSupervisorSet?: boolean },
  selectedColumns: { org_members: "" },
}));

vi.mock("@/lib/supabase", () => {
  const builder = (table: string) => {
    const b = {
      select: (cols: string) => {
        if (table === "org_members") h.selectedColumns.org_members = cols;
        return b;
      },
      eq: () => b,
      maybeSingle: async () => ({
        data: h.routing ? { data: { routing: h.routing } } : null,
        error: null,
      }),
      // Awaiting the builder resolves the list query (org_members path).
      then: (resolve: (v: unknown) => void) =>
        Promise.resolve(
          table === "org_members"
            ? { data: h.members, error: null }
            : { data: [], error: null },
        ).then(resolve),
    };
    return b;
  };
  return { supabase: { from: (t: string) => builder(t) } };
});

import { resolveTicketRecipients, listActiveMembers, isRoutedStatus, routedPool, queuePool, loadRoutingContext, type RoutingClient } from "@/lib/ticketRouting";

const uids = (xs: Array<{ uid: string }>) => xs.map((m) => m.uid).sort();

beforeEach(() => {
  h.members = [];
  h.routing = null;
  h.selectedColumns.org_members = "";
});

describe("listActiveMembers — schema contract", () => {
  it("selects display_name (NOT the non-existent org_members.name column)", async () => {
    h.members = [{ uid: "a", role: "Admin", display_name: "Ada", email: "a@x.com" }];
    const out = await listActiveMembers("org-1");
    expect(h.selectedColumns.org_members).toContain("display_name");
    // A bare `name` column does not exist on org_members; selecting it makes
    // PostgREST reject the whole query and recipients silently become [].
    expect(h.selectedColumns.org_members.split(",").map((s) => s.trim())).not.toContain("name");
    expect(out[0].name).toBe("Ada");
  });
});

describe("resolveTicketRecipients", () => {
  it("PENDING_ASSIGNMENT goes to Admins when no DraftingSupervisor exists", async () => {
    h.members = [
      { uid: "admin1", role: "Admin" },
      { uid: "viewer1", role: "Viewer" },
      { uid: "draft1", role: "Drafter" },
    ];
    const out = await resolveTicketRecipients("org-1", "PENDING_ASSIGNMENT");
    expect(uids(out)).toEqual(["admin1"]);
  });

  it("PENDING_ASSIGNMENT goes to the DraftingSupervisor when one exists (Admins step aside)", async () => {
    h.members = [
      { uid: "admin1", role: "Admin" },
      { uid: "super1", role: "DraftingSupervisor" },
    ];
    const out = await resolveTicketRecipients("org-1", "PENDING_ASSIGNMENT");
    expect(uids(out)).toEqual(["super1"]);
  });

  it("…unless the org toggled adminsAlsoReceiveWhenSupervisorSet", async () => {
    h.members = [
      { uid: "admin1", role: "Admin" },
      { uid: "super1", role: "DraftingSupervisor" },
    ];
    h.routing = { adminsAlsoReceiveWhenSupervisorSet: true };
    const out = await resolveTicketRecipients("org-1", "PENDING_ASSIGNMENT");
    expect(uids(out)).toEqual(["admin1", "super1"]);
  });

  it("WF-19 done-when 2: the supervisor pool matches the FULL role collection, not the headline", async () => {
    // A Manager whose additive collection includes DraftingSupervisor IS the
    // supervisor — the headline-only match silently fell back to Admins and
    // the actual supervisor was never told.
    h.members = [
      { uid: "admin1", role: "Admin", roles: ["Admin"] },
      { uid: "mgr-sup", role: "Manager", roles: ["Manager", "DraftingSupervisor"] },
    ];
    expect(uids(await resolveTicketRecipients("org-1", "PENDING_ASSIGNMENT"))).toEqual(["mgr-sup"]);
  });

  it("the retired PENDING_ENG_INITIAL entry stage has no routing branch (DEC-14)", async () => {
    h.members = [{ uid: "admin1", role: "Admin" }, { uid: "eng1", role: "Engineer-1" }];
    expect(await resolveTicketRecipients("org-1", "PENDING_ENG_INITIAL" as never)).toEqual([]);
  });

  it("never notifies the actor about their own action", async () => {
    h.members = [
      { uid: "admin1", role: "Admin" },
      { uid: "admin2", role: "Admin" },
    ];
    const out = await resolveTicketRecipients("org-1", "PENDING_ASSIGNMENT", "admin1");
    expect(uids(out)).toEqual(["admin2"]);
  });

  it("statuses with no routing policy notify nobody", async () => {
    h.members = [{ uid: "admin1", role: "Admin" }];
    expect(await resolveTicketRecipients("org-1", "DRAFTING")).toEqual([]);
    expect(await resolveTicketRecipients("org-1", "CLOSED")).toEqual([]);
  });

  it("PENDING_IFC routes like assignment (supervisor-targeted)", async () => {
    h.members = [
      { uid: "admin1", role: "Admin" },
      { uid: "super1", role: "DraftingSupervisor" },
    ];
    expect(uids(await resolveTicketRecipients("org-1", "PENDING_IFC"))).toEqual(["super1"]);
  });
});

// drafting-flow Round G, DF-P3 ROUTING — LEAK-1 / ROUTE-5 / ROUTE-1: every
// routed status's pool, as the workflow route and the SLA clock read it.
describe("DF-P3 — the routed statuses (LEAK-1)", () => {
  const ctx = (members: Array<{ uid: string; roles: string[] }>, also = false) => ({
    members: members.map((m) => ({ uid: m.uid, role: m.roles[0] as never, roles: m.roles as never[] })),
    routing: { adminsAlsoReceiveWhenSupervisorSet: also },
  });
  it("PENDING_IFC → the queue's owners + the originating engineer (its own header's promise, now kept)", async () => {
    h.members = [
      { uid: "admin1", role: "Admin" },
      { uid: "super1", role: "DraftingSupervisor" },
      { uid: "eng1", role: "Engineer-2" },
    ];
    expect(uids(await resolveTicketRecipients("org-1", "PENDING_IFC", undefined, undefined, { assignedEngineerId: "eng1" }))).toEqual(["eng1", "super1"]);
    // an engineer who is no longer an active member is not addressed
    expect(uids(await resolveTicketRecipients("org-1", "PENDING_IFC", undefined, undefined, { assignedEngineerId: "gone" }))).toEqual(["super1"]);
  });
  it("a REVISION_REQ nobody drafts routes to the queue; one with a drafter routes nowhere (the drafter is the transition's own recipient)", async () => {
    h.members = [{ uid: "super1", role: "DraftingSupervisor" }];
    expect(uids(await resolveTicketRecipients("org-1", "REVISION_REQ", undefined, undefined, { assignedDrafterId: null }))).toEqual(["super1"]);
    expect(await resolveTicketRecipients("org-1", "REVISION_REQ", undefined, undefined, { assignedDrafterId: "d1" })).toEqual([]);
  });
  it("isRoutedStatus names exactly those three", () => {
    expect(isRoutedStatus("PENDING_ASSIGNMENT")).toBe(true);
    expect(isRoutedStatus("PENDING_IFC")).toBe(true);
    expect(isRoutedStatus("REVISION_REQ", { assignedDrafterId: null })).toBe(true);
    expect(isRoutedStatus("REVISION_REQ", { assignedDrafterId: "d1" })).toBe(false);
    for (const s of ["PENDING_ENG_TEAM", "DRAFTING", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "FINAL_DRAFT", "CLOSED", "CANCELED"]) {
      expect(isRoutedStatus(s), s).toBe(false);
    }
  });
  it("queuePool / routedPool are the same policy, pure (the SLA clock reads them once per org)", () => {
    const c = ctx([{ uid: "a1", roles: ["Admin"] }, { uid: "s1", roles: ["Manager", "DraftingSupervisor"] }]);
    expect(queuePool(c)).toEqual(["s1"]);
    expect(queuePool({ ...c, routing: { adminsAlsoReceiveWhenSupervisorSet: true } }).sort()).toEqual(["a1", "s1"]);
    expect(queuePool(ctx([{ uid: "a1", roles: ["Admin"] }]))).toEqual(["a1"]);
    expect(routedPool(c, "PENDING_ASSIGNMENT", "s1")).toEqual([]);
    expect(routedPool(c, "DRAFTING")).toEqual([]);
  });
  it("loadRoutingContext REPORTS a failed member read (an escalation must never read an outage as 'nobody to tell')", async () => {
    const client = { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: null, error: { message: "boom" } }) }) }) }) } as unknown as RoutingClient;
    expect(await loadRoutingContext("org-1", client)).toEqual({ ok: false, error: "boom" });
  });
});
