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
  members: [] as Array<{ uid: string; role: string; display_name?: string | null; email?: string | null }>,
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

import { resolveTicketRecipients, listActiveMembers } from "@/lib/ticketRouting";

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

  it("PENDING_ENG_INITIAL goes to engineers, falling back to Admins when none", async () => {
    h.members = [
      { uid: "admin1", role: "Admin" },
      { uid: "eng1", role: "Engineer-1" },
      { uid: "eng4", role: "Engineer-4" },
    ];
    expect(uids(await resolveTicketRecipients("org-1", "PENDING_ENG_INITIAL"))).toEqual(["eng1", "eng4"]);

    h.members = [{ uid: "admin1", role: "Admin" }, { uid: "v", role: "Viewer" }];
    expect(uids(await resolveTicketRecipients("org-1", "PENDING_ENG_INITIAL"))).toEqual(["admin1"]);
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
