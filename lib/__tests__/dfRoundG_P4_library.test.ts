// drafting-flow Round G, DF-P4 LIBRARY — the ticket gets a library (GAP-105 /
// DCW-1), triage sets the library and the unit (DCW-7 / FRIC-3), the intent
// bridge covers every sheet (roles-and-permissions GAP-8 acceptance 2), a
// library-only close is visible (DCW-4), the hand-back's null token is its own
// compare-and-set leg (SM-9 / EDGE-15 class), rowToTicket loses its cast
// (PERS-5 / PERS-6), and the drafting request-form configuration has ONE
// editor set (AUTHZ-10).
//
// Migrations 20261208 / 20261209: DEC-30 shape tests and the byte-fidelity
// lineDiff of every re-created function / policy against its NEWEST earlier
// definition, found by SCANNING supabase/migrations at test time. Both were
// exercised on a throwaway PostgreSQL 16 (cases recorded on DCW-1, AUTHZ-3,
// AUTHZ-10).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import { computeTransition, rowToTicket, type TransitionInput } from "@/lib/ticketTransitions";
import { ticketResource } from "@/lib/workflow";
import { ADMIN_SURFACES, DRAFTING_CONFIG_EDITORS, adminSurfaceAllows } from "@/lib/adminSurfaces";
import { creationNoticeOwed, missingLibraryColumn, offerableLibraries, linkableDocumentQuery, linkableDocumentFilter, libraryLabelForTicket } from "@/lib/ticketLibrary";
import { deliverableStateOf, noteDeliverableNotInLibrary } from "@/lib/ticketHandback";
import type { Ticket, TicketAttachment } from "@/types/schema";

const LM = "2026-10-13T00:00:00.000Z";
const NOW = "2026-10-13T12:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const LIB_FOREIGN = "1b000000-0000-4000-8000-0000000000ff";
const FINAL = { id: "a-f", name: "iso_IFC.pdf", url: "orgs/o1/tickets/REQ-1/iso_IFC.pdf", type: "Final", status: "submitted" } as TicketAttachment;

// ── the route harness (vi.hoisted state + a Proxy chain for supabaseAdmin) ──
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
}));
function chain(table: string) {
  const filters: Array<[string, unknown, "eq" | "is" | "in"]> = [];
  let head = false;
  // documents.id is a uuid column: Postgres matches an `in` list on it
  // case-insensitively (and returns the canonical lower-case text).
  const inMatch = (k: string, list: unknown[], cell: unknown) =>
    table === "documents" && k === "id" && typeof cell === "string"
      ? list.some((x) => typeof x === "string" && x.toLowerCase() === cell.toLowerCase())
      : list.includes(cell);
  const rows = () => (state.rows[table] ?? [])
    .filter((r) => filters.every(([k, v, how]) => (how === "is" ? (r[k] ?? null) === v : how === "in" ? inMatch(k, v as unknown[], r[k]) : r[k] === v)))
    .map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (state.errors[table]) return resolve({ data: null, error: state.errors[table] });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push([String(args[0]), args[1], "eq"]);
        if (prop === "is") filters.push([String(args[0]), args[1], "is"]);
        if (prop === "in") filters.push([String(args[0]), args[1], "in"]);
        if (prop === "maybeSingle" || prop === "single") {
          if (state.errors[table]) return Promise.resolve({ data: null, error: state.errors[table] });
          return Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
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
    rpc: vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({ ContentLength: 4096, ETag: '"e"' })) }, R2_BUCKET: "b" }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "u-1", activeRole: "Admin", roles: ["Admin"] }) }));
vi.mock("@/lib/teams", () => ({ getMyTeamIds: vi.fn(async () => []) }));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryPicker, NO_LIBRARY_LABEL, CURRENT_HIDDEN_LIBRARY_LABEL, OTHER_HIDDEN_LIBRARY_LABEL } from "@/components/requests/LibraryPicker";
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { POST as handback } from "@/app/api/tickets/handback/route";

const req = (path: string, body: unknown) => new NextRequest(`http://x${path}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});
const post = (body: unknown) => workflowAction(req("/api/tickets/workflow-action", body));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "PENDING_ASSIGNMENT", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: null, assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, last_modified: LM,
  library_id: null, ...over,
});
const ticketUpdates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const seedQueue = (cfg?: Record<string, unknown>) => {
  state.user = { id: "a-1" };
  state.rows.org_members = [member("a-1", "Admin"), member("req-1", "Requester"), member("d-1", "Drafter")];
  state.rows.libraries = [{ id: LIB, org_id: "o1", name: "P&IDs" }, { id: LIB_FOREIGN, org_id: "o2", name: "Theirs" }];
  if (cfg) state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: cfg }];
};
const assign = (over: Record<string, unknown> = {}) => post({ ticketId: "t1", actionType: "assign", assignment: { id: "d-1", name: "D" }, ...over });

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {};
});

// ═════════════════════════════════════════════════════════════════════════════
describe("PERS-5 / PERS-6 — rowToTicket has no cast, maps what the server reads, and a NULL unit stays NULL", () => {
  it("maps library_id, the archive stamps, closed_at, updated_at, search keywords; unit NULL is null (not '')", () => {
    const t = rowToTicket({ id: "t", org_id: "o", ticket_id: "R", unit: null, library_id: LIB, closed_at: NOW, archived_at: null, archive_id: "ar", updated_at: NOW, search_keywords: ["a"], created_at: NOW });
    expect(t).toMatchObject({ unit: null, libraryId: LIB, closedAt: NOW, archivedAt: null, archiveId: "ar", updatedAt: NOW, searchKeywords: ["a"] });
    expect(rowToTicket({ id: "t", unit: "U-1" }).unit).toBe("U-1");
    expect(rowToTicket({ id: "t" }).libraryId).toBeNull();   // before 20261208: no column, no library
  });
  it("source pin: the `} as Ticket` cast is gone (the literal is checked against the type) and Ticket.unit is string | null", () => {
    const src = readFileSync(join(process.cwd(), "lib", "ticketTransitions.ts"), "utf8");
    expect(src).not.toContain("} as Ticket;");
    expect(src).toContain("  const ticket: Ticket = {");
    expect(readFileSync(join(process.cwd(), "types", "schema.ts"), "utf8")).toContain("  unit: string | null;");
  });
});

describe("GAP-105 (fix pass) — the library is NOT in the capability resource yet: the page and the badge build Tickets without it", () => {
  // DF-P6 re-pin (the hand-off this test recorded has landed): the library
  // joins the resource once the request page's mapper carries it (it does —
  // DF-P9's fromRow) and 20261250's inventory counts the stored ticket.*
  // rules scoped to a library; a ticket WITHOUT a library presents exactly
  // the old resource.
  it("ticketResource presents the library when the ticket carries one (DF-P6), and exactly request type and unit when it does not", () => {
    const withLib = { requestType: "ISO", unit: "U", libraryId: LIB } as Pick<Ticket, "requestType" | "unit" | "libraryId">;
    expect(ticketResource(withLib)).toStrictEqual({ requestType: "ISO", unit: "U", libraryId: LIB });
    expect(ticketResource({ requestType: "ISO", unit: "U" })).toStrictEqual({ requestType: "ISO", unit: "U" });
    expect(readFileSync(join(process.cwd(), "lib", "workflow.ts"), "utf8")).toContain("...(ticket.libraryId ? { libraryId: ticket.libraryId } : {}),");
  });
  it("the restore clears a ticket's library that is not in the target workspace (ON DELETE SET NULL's answer), never refuses the ticket", async () => {
    const { restoreParentRulesFor } = await import("@/lib/dataRestore");
    expect(restoreParentRulesFor("tickets")).toEqual([{ column: "library_id", parent: "libraries", clearWhenMissing: true }]);
  });
});

const mk = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "x", unit: null, requestType: "ISO", status: "PENDING_ASSIGNMENT",
  requesterId: "req-1", createdAt: NOW, history: [], attachments: [], comments: [], watchers: [], unreadBy: [], ...over,
});
const input = (over: Partial<TransitionInput> = {}): TransitionInput => ({
  actionType: "assign", actionLabel: "Assign Drafter", assignment: { id: "d-1", name: "D" },
  actor: { uid: "a-1", email: "a@x.io", role: "Admin" }, now: NOW, ...over,
});

describe("DCW-1 / DCW-7 — computeTransition: triage records the library and the unit with the assignment", () => {
  it("sets library_id and unit, clears the intake's unknown / unlisted / unchecked marks, and writes its own history line", () => {
    const t = mk({ metadata: { unit_unknown: true, unit_unchecked: "20-X", keep: 1 } });
    const r = computeTransition(t, input({ triage: { library: { id: LIB, name: "P&IDs" }, unit: "200" } }));
    expect(r.newStatus).toBe("DRAFTING");
    expect(r.updates.library_id).toBe(LIB);
    expect(r.updates.unit).toBe("200");
    expect(r.updates.metadata).toEqual({ keep: 1 });
    const h = r.updates.history as Array<Record<string, unknown>>;
    expect(h).toHaveLength(2);
    expect(h[1]).toMatchObject({ action: "Triage details set", user: "a@x.io", details: "Library: P&IDs · Unit: 200 (was unknown)" });
  });
  it("request_eng_review at the queue carries them too; a library already set is changed and says so", () => {
    const t = mk({ libraryId: "old", unit: "100" });
    const r = computeTransition(t, input({ actionType: "request_eng_review", engineer: { id: "e-1", name: "E", email: "e@x" }, comment: "scope?", triage: { library: { id: LIB, name: "P&IDs" } } }));
    expect(r.newStatus).toBe("PENDING_ENG_TEAM");
    expect(r.updates.library_id).toBe(LIB);
    expect((r.updates.history as Array<{ details?: string }>).at(-1)?.details).toBe("Library: P&IDs (changed)");
    expect("unit" in r.updates).toBe(false);
  });
  it("REGRESSION: with no triage input — or at any other status — the update is exactly what it was", () => {
    const base = computeTransition(mk(), input());
    expect("library_id" in base.updates || "unit" in base.updates || "metadata" in base.updates).toBe(false);
    expect((base.updates.history as unknown[]).length).toBe(1);
    const drafting = computeTransition(mk({ status: "REVISION_REQ" }), input({ triage: { library: { id: LIB, name: "L" }, unit: "200" } }));
    expect("library_id" in drafting.updates || "unit" in drafting.updates).toBe(false);
    const same = computeTransition(mk({ libraryId: LIB, unit: "200" }), input({ triage: { library: { id: LIB, name: "L" }, unit: "200" } }));
    expect("library_id" in same.updates || "unit" in same.updates).toBe(false);
    expect((same.updates.history as unknown[]).length).toBe(1);
  });
});

describe("DCW-1 / DCW-7 — the workflow route: triage's library and unit, validated, on the same compare-and-set", () => {
  it("assign with a library of the ticket's org and a unit on the list: both land with the assignment", async () => {
    seedQueue({ units: { options: [{ label: "Unit 200", value: "200" }] } });
    state.rows.tickets = [ticketRow({ metadata: { unit_unknown: true } })];
    const res = await assign({ libraryId: LIB, unit: "unit 200" });
    expect(res.status).toBe(200);
    const u = ticketUpdates()[0];
    expect(u).toMatchObject({ status: "DRAFTING", library_id: LIB, unit: "200", assigned_drafter_id: "d-1" });
    expect(u.metadata).toEqual({});
  });
  it("REGRESSION: an assignment that names neither writes neither, exactly as before", async () => {
    seedQueue();
    state.rows.tickets = [ticketRow()];
    expect((await assign()).status).toBe(200);
    const u = ticketUpdates()[0];
    expect("library_id" in u || "unit" in u || "metadata" in u).toBe(false);
  });
  it("a library of another workspace, or not a library id at all, is a 400 with nothing written", async () => {
    seedQueue();
    state.rows.tickets = [ticketRow()];
    for (const libraryId of [LIB_FOREIGN, "not-a-uuid"]) {
      state.calls = [];
      const res = await assign({ libraryId });
      expect(res.status).toBe(400);
      expect(ticketUpdates()).toHaveLength(0);
      expect(state.calls.some((c) => c.table === "audit_logs" && c.method === "insert")).toBe(false);
    }
  });
  it("fix pass: a PRIVATE / hidden library the assigner cannot discover is refused exactly as a foreign one (400, nothing written, no audit row) — the picker's rule, on the server", async () => {
    seedQueue();
    state.rows.org_members = [member("s-1", "Supervisor"), member("req-1", "Requester"), member("d-1", "Drafter")];
    state.user = { id: "s-1" };
    state.rows.libraries = [
      { id: LIB, org_id: "o1", name: "Legal / M&A", visibility: "private", acl: null, owner_user_id: "someone" },
    ];
    state.rows.tickets = [ticketRow()];
    for (const visibility of ["private", "hidden"]) {
      state.calls = [];
      state.rows.libraries[0].visibility = visibility;
      const res = await assign({ libraryId: LIB });
      expect(res.status, visibility).toBe(400);
      expect((await res.json()).error).toBe("That library is not one of this workspace's");
      expect(ticketUpdates()).toHaveLength(0);
      expect(state.calls.some((c) => c.table === "audit_logs" && c.method === "insert")).toBe(false);
    }
  });
  it("fix pass: the private library's OWNER, a controller (additive DocCtrl too) and an ACL grantee by team are admitted — and the history line says 'the target library', never its name", async () => {
    const privateLib = (over: Record<string, unknown> = {}) => ({ id: LIB, org_id: "o1", name: "Legal / M&A", visibility: "private", acl: null, owner_user_id: "own-1", ...over });
    const cases: Array<{ uid: string; members: ReturnType<typeof member>[]; lib: Record<string, unknown>; teams?: Array<Record<string, unknown>> }> = [
      { uid: "own-1", members: [member("own-1", "Supervisor")], lib: privateLib() },
      { uid: "a-1", members: [member("a-1", "Admin")], lib: privateLib() },
      { uid: "s-2", members: [member("s-2", "Supervisor", ["Supervisor", "DocCtrl"])], lib: privateLib() },
      { uid: "s-3", members: [member("s-3", "Supervisor")], teams: [{ uid: "s-3", team_id: "team-legal" }],
        lib: privateLib({ acl: { rules: [{ subject: { type: "team", id: "team-legal" }, effect: "allow", actions: ["discover"] }] } }) },
    ];
    for (const c of cases) {
      state.calls = [];
      state.user = { id: c.uid };
      state.rows.org_members = [...c.members, member("req-1", "Requester"), member("d-1", "Drafter")];
      state.rows.team_members = c.teams ?? [];
      state.rows.libraries = [c.lib];
      state.rows.tickets = [ticketRow()];
      const res = await assign({ libraryId: LIB });
      expect(res.status, c.uid).toBe(200);
      const u = ticketUpdates()[0];
      expect(u.library_id, c.uid).toBe(LIB);
      const line = (u.history as Array<{ action: string; details?: string }>).find((h) => h.action === "Triage details set");
      expect(line?.details, c.uid).toBe("Library: the target library");
      expect(JSON.stringify(u.history)).not.toContain("Legal");
    }
  });
  it("intelligence DACL-13 R1 (I-31 merge, DEC-90): the library check decides on the EFFECTIVE ACL — a legacy library (no ACL, restricted lists) answers the same before and after migration 20261228 writes its lists into the ACL", async () => {
    const legacy = { id: LIB, org_id: "o1", name: "HR records", visibility: "normal", acl: null, owner_user_id: null,
      read_access: ["HR"], visible_to: [], write_access: ["Engineer"], admin_access: [] };
    // what 20261228 writes for that row: the rung, exactly
    const written = { ...legacy, acl: { inherit: true, visibility: "normal", rules: [
      { effect: "allow", subject: { type: "role", id: "HR" }, actions: ["discover", "read", "download"] },
      { effect: "allow", subject: { type: "role", id: "Engineer" }, actions: ["discover", "read", "download"] },
    ] } };
    const cases: Array<{ uid: string; role: string; roles?: string[]; status: number }> = [
      { uid: "s-1", role: "Supervisor", status: 400 },                       // outside the lists: refused, before and after
      { uid: "h-1", role: "Supervisor", roles: ["Supervisor", "HR"], status: 200 }, // a listed role held additively
      { uid: "e-1", role: "Supervisor", roles: ["Supervisor", "Engineer"], status: 200 }, // the upload list reads too (the rung)
      { uid: "a-1", role: "Admin", status: 200 },                             // a controller
    ];
    for (const lib of [legacy, written]) {
      for (const c of cases) {
        const tag = `${lib.acl ? "after" : "before"} / ${c.uid}`;
        state.calls = [];
        state.user = { id: c.uid };
        state.rows.org_members = [member(c.uid, c.role, c.roles ?? [c.role]), member("req-1", "Requester"), member("d-1", "Drafter")];
        state.rows.team_members = [];
        state.rows.libraries = [{ ...lib }];
        state.rows.tickets = [ticketRow()];
        const res = await assign({ libraryId: LIB });
        expect(res.status, tag).toBe(c.status);
        expect(state.calls.find((x) => x.table === "libraries" && x.method === "select")?.args[0], tag)
          .toBe("id, name, owner_user_id, acl, visibility, read_access, visible_to, write_access, admin_access");
        if (c.status === 400) { expect(ticketUpdates(), tag).toHaveLength(0); continue; }
        const line = (ticketUpdates()[0].history as Array<{ action: string; details?: string }>).find((h) => h.action === "Triage details set");
        expect(line?.details, tag).toBe("Library: the target library");
      }
    }
  });
  it("fix pass 2: the ticket's CURRENT library sent back unchanged is no change — a non-controller assigner who cannot discover it still assigns (200), library_id untouched, the library never read", async () => {
    for (const role of ["DraftingSupervisor", "Supervisor"]) {
      state.calls = [];
      state.user = { id: "s-1" };
      state.rows.org_members = [member("s-1", role), member("req-1", "Requester"), member("d-1", "Drafter")];
      state.rows.team_members = [];
      // A requester's discover grant set it (DCW-5 → create route); the assigner holds none.
      state.rows.libraries = [{ id: LIB, org_id: "o1", name: "Unit 300 P&IDs", visibility: "private", acl: null, owner_user_id: "someone" }];
      state.rows.tickets = [ticketRow({ library_id: LIB })];
      for (const libraryId of [LIB, LIB.toUpperCase(), ` ${LIB} `]) {
        state.calls = [];
        state.rows.tickets = [ticketRow({ library_id: LIB })];
        const res = await assign({ libraryId });
        expect(res.status, `${role} ${libraryId}`).toBe(200);
        const u = ticketUpdates()[0];
        expect(u).toMatchObject({ status: "DRAFTING", assigned_drafter_id: "d-1" });
        expect("library_id" in u).toBe(false);
        expect(JSON.stringify(u.history)).not.toContain("Library:");
        expect(state.calls.some((c) => c.table === "libraries")).toBe(false);
      }
    }
    // A DIFFERENT library the same assigner cannot discover is still refused.
    const OTHER = "1b000000-0000-4000-8000-000000000002";
    state.calls = [];
    state.rows.libraries.push({ id: OTHER, org_id: "o1", name: "Other", visibility: "private", acl: null, owner_user_id: "someone" });
    state.rows.tickets = [ticketRow({ library_id: LIB })];
    expect((await assign({ libraryId: OTHER })).status).toBe(400);
    expect(ticketUpdates()).toHaveLength(0);
  });
  it("fix pass 2: a NORMAL library whose ACL carries any rule (a deny hiding it from a role) is 'the target library' in the triage history", async () => {
    seedQueue();
    state.rows.libraries = [{ id: LIB, org_id: "o1", name: "Confidential Projects", visibility: "normal", owner_user_id: null,
      acl: { rules: [{ subject: { type: "role", id: "Requester" }, effect: "deny", actions: ["discover"] }] } }];
    state.rows.tickets = [ticketRow()];
    const res = await assign({ libraryId: LIB });
    expect(res.status).toBe(200);
    const u = ticketUpdates()[0];
    expect(u.library_id).toBe(LIB);
    const line = (u.history as Array<{ action: string; details?: string }>).find((h) => h.action === "Triage details set");
    expect(line?.details).toBe("Library: the target library");
    expect(JSON.stringify(u)).not.toContain("Confidential");
  });
  it("fix pass: a membership or team read that fails is a 503 with nothing written — never a guess", async () => {
    seedQueue();
    state.rows.tickets = [ticketRow()];
    state.errors.team_members = { code: "57014", message: "timeout" };
    expect((await assign({ libraryId: LIB })).status).toBe(503);
    expect(ticketUpdates()).toHaveLength(0);
  });
  it("a library or unit outside triage (any other action or status) is a 400 with nothing written", async () => {
    seedQueue();
    state.rows.tickets = [ticketRow({ status: "DRAFTING", assigned_drafter_id: "d-1" })];
    state.user = { id: "d-1" };
    const res = await post({ ticketId: "t1", actionType: "save_progress", libraryId: LIB });
    expect(res.status).toBe(400);
    expect(ticketUpdates()).toHaveLength(0);
  });
  it("a unit not on the org's list is a 400 naming the field; with no list (no units, empty codebook) free text is kept; an unreadable codebook is a 503", async () => {
    seedQueue({ units: { options: [{ label: "Unit 200", value: "200" }] } });
    state.rows.tickets = [ticketRow()];
    const bad = await assign({ unit: "999" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe("unit");
    expect(ticketUpdates()).toHaveLength(0);

    state.calls = [];
    state.rows.org_configurations = [];
    state.rows.codebook_entries = [];
    expect((await assign({ unit: "20-CRUDE" })).status).toBe(200);
    expect(ticketUpdates()[0].unit).toBe("20-CRUDE");

    state.calls = [];
    state.rows.tickets = [ticketRow()];
    state.errors.codebook_entries = { code: "57014", message: "timeout" };
    expect((await assign({ unit: "20-CRUDE" })).status).toBe(503);
    expect(ticketUpdates()).toHaveLength(0);
  });
  it("before 20261208 is pasted (the row has no library_id column) the assignment applies as today, with no library, and the answer says so", async () => {
    seedQueue();
    const row = ticketRow();
    delete (row as Record<string, unknown>).library_id;
    state.rows.tickets = [row];
    const res = await assign({ libraryId: LIB });
    expect(res.status).toBe(200);
    expect((await res.json()).warning).toMatch(/20261208/);
    expect("library_id" in ticketUpdates()[0]).toBe(false);
  });
});

describe("roles-and-permissions GAP-8 acceptance 2 — assigning a drafter registers an intent on EVERY sheet, each read in the ticket's org", () => {
  it("a three-sheet request: an intent per sheet in this org; a sheet from another org registers nothing (SM-14)", async () => {
    seedQueue();
    state.rows.documents = [
      { id: "doc-1", org_id: "o1", current_version_id: "v1", library_id: LIB },
      { id: "doc-2", org_id: "o1", current_version_id: "v2", library_id: LIB },
      { id: "doc-x", org_id: "o2", current_version_id: "vx", library_id: null },
    ];
    state.rows.tickets = [ticketRow({ metadata: {
      source_document: { id: "doc-1" },
      source_documents: [{ id: "doc-1" }, { id: "doc-2" }, { id: "doc-x" }],
    } })];
    expect((await assign()).status).toBe(200);
    const upCalls = state.calls.filter((c) => c.table === "document_intents" && c.method === "upsert");
    expect(upCalls).toHaveLength(1);   // fix pass 3: one batched upsert
    const ups = upCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(ups.map((u) => u.document_id)).toEqual(["doc-1", "doc-2"]);
    expect(ups.every((u) => u.user_id === "d-1" && u.source === "ticket" && u.ticket_id === "t1" && u.org_id === "o1")).toBe(true);
    expect(upCalls[0].args[1]).toEqual({ onConflict: "document_id,user_id,kind,source" });
  });

  // ── fix pass 3: a book request never costs a round trip per sheet ──
  const BOOK = 150;
  const sheetIds = Array.from({ length: BOOK }, (_, i) => `doc-${String(i).padStart(3, "0")}`);
  const bookMeta = () => ({ source_document: { id: sheetIds[0] }, source_documents: sheetIds.map((id) => ({ id })) });
  const seedBook = () => {
    state.rows.documents = [
      ...sheetIds.map((id, i) => ({ id, org_id: "o1", current_version_id: `v-${i}`, library_id: LIB })),
      { id: "doc-x", org_id: "o2", current_version_id: "vx", library_id: null },
    ];
  };
  const bridgeCalls = () => state.calls.filter((c) =>
    (c.table === "documents" && c.method === "select") ||
    (c.table === "document_intents" && (c.method === "upsert" || c.method === "delete")));

  it("fix pass 4: assigning a 150-sheet book is TWO reads (`.in` slices of 100 — the create route's SOURCE_READ_CHUNK, inside the URL budget — in the ticket's org) and TWO upserts — never 300 round trips", async () => {
    seedQueue();
    seedBook();
    const named = [...sheetIds, "doc-x"];
    state.rows.tickets = [ticketRow({ metadata: { ...bookMeta(), source_documents: [...bookMeta().source_documents, { id: "doc-x" }] } })];
    expect((await assign()).status).toBe(200);
    const calls = bridgeCalls();
    expect(calls.map((c) => `${c.table}.${c.method}`)).toEqual(["documents.select", "documents.select", "document_intents.upsert", "document_intents.upsert"]);
    for (const [n, slice] of [[0, named.slice(0, 100)], [1, named.slice(100)]] as const) {
      const read = state.calls.indexOf(calls[n]);
      expect(state.calls[read + 1]).toMatchObject({ table: "documents", method: "in", args: ["id", slice] });
      expect(state.calls[read + 2]).toMatchObject({ table: "documents", method: "eq", args: ["org_id", "o1"] });
    }
    const first = calls[2].args[0] as Array<Record<string, unknown>>;
    const second = calls[3].args[0] as Array<Record<string, unknown>>;
    expect(first).toHaveLength(100);
    expect([...first, ...second].map((r) => r.document_id)).toEqual(sheetIds);   // doc-x (another org) registers nothing
    expect(second[49]).toMatchObject({ user_id: "d-1", library_id: LIB, base_version_id: "v-149", ticket_id: "t1", kind: "edit", source: "ticket" });
    const route = readFileSync(join(process.cwd(), "app", "api", "tickets", "workflow-action", "route.ts"), "utf8");
    expect(route).toContain("const INTENT_BRIDGE_CHUNK = 100;");
    expect(readFileSync(join(process.cwd(), "app", "api", "tickets", "create", "route.ts"), "utf8")).toContain("const SOURCE_READ_CHUNK = 100;");
  });

  it("fix pass 4: a sheet named with an UPPER-CASE id is matched case-insensitively — its intent row carries the database's own id; two spellings of one sheet are one row", async () => {
    seedQueue();
    const SHEET = "5a000000-0000-4000-8000-0000000000ab";
    state.rows.documents = [{ id: SHEET, org_id: "o1", current_version_id: "v-ab", library_id: LIB }];
    const upserted = () => state.calls.filter((c) => c.table === "document_intents" && c.method === "upsert");
    // Only the upper-case spelling: the sheet is found and registered.
    state.rows.tickets = [ticketRow({ metadata: { source_document: { id: SHEET.toUpperCase() } } })];
    expect((await assign()).status).toBe(200);
    expect(upserted()).toHaveLength(1);
    expect(upserted()[0].args[0]).toEqual([expect.objectContaining({ document_id: SHEET, base_version_id: "v-ab", library_id: LIB, user_id: "d-1", ticket_id: "t1" })]);
    // Both spellings: one row, never one conflict key twice in one upsert.
    state.calls = [];
    state.rows.tickets = [ticketRow({ metadata: {
      source_document: { id: SHEET.toUpperCase() },
      source_documents: [{ id: SHEET.toUpperCase() }, { id: SHEET }],
    } })];
    expect((await assign()).status).toBe(200);
    expect(upserted()).toHaveLength(1);
    expect(upserted()[0].args[0]).toEqual([expect.objectContaining({ document_id: SHEET, base_version_id: "v-ab" })]);
  });

  it("fix pass 4: a delete leg the database refuses is logged (non-blocking) — the close still applies", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("a-1", "Admin")];
    seedBook();
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", assigned_drafter_id: "d-1", attachments: [FINAL], metadata: bookMeta() })];
    state.errors.document_intents = { code: "42501", message: "permission denied" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await post({ ticketId: "t1", actionType: "close_ticket" })).status).toBe(200);
    expect(ticketUpdates()[0]).toMatchObject({ status: "CLOSED" });
    const logged = warn.mock.calls.filter((a) => String(a[0]).includes("intents not cleared for ticket t1"));
    expect(logged).toHaveLength(2);   // one per slice
    expect(logged[0][1]).toBe("permission denied");
    warn.mockRestore();
  });

  it("fix pass 4: reassigning the book is two retirement deletes + two reads + two upserts; closing it is two deletes — slices of 100 covering every sheet", async () => {
    state.user = { id: "a-1" };
    state.rows.org_members = [member("a-1", "Admin"), member("req-1", "Requester"), member("d-1", "Drafter"), member("d-2", "Drafter")];
    seedBook();
    state.rows.tickets = [ticketRow({ status: "DRAFTING", assigned_drafter_id: "d-1", metadata: bookMeta() })];
    expect((await post({ ticketId: "t1", actionType: "reassign_drafter", comment: "out", assignment: { id: "d-2", name: "Sam" } })).status).toBe(200);
    let calls = bridgeCalls();
    expect(calls.map((c) => `${c.table}.${c.method}`)).toEqual([
      "document_intents.delete", "document_intents.delete", "documents.select", "documents.select", "document_intents.upsert", "document_intents.upsert",
    ]);
    for (const [n, slice] of [[0, sheetIds.slice(0, 100)], [1, sheetIds.slice(100)]] as const) {
      const del = state.calls.indexOf(calls[n]);
      expect(state.calls.slice(del + 1, del + 5).map((c) => [c.method, ...c.args])).toEqual([
        ["in", "document_id", slice], ["eq", "ticket_id", "t1"], ["eq", "source", "ticket"], ["eq", "user_id", "d-1"],
      ]);
    }
    const upserted = [...(calls[4].args[0] as Array<Record<string, unknown>>), ...(calls[5].args[0] as Array<Record<string, unknown>>)];
    expect(upserted.every((r) => r.user_id === "d-2")).toBe(true);
    expect(upserted.length).toBe(BOOK);

    state.calls = [];
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", assigned_drafter_id: "d-2", attachments: [FINAL], metadata: bookMeta() })];
    expect((await post({ ticketId: "t1", actionType: "close_ticket" })).status).toBe(200);
    calls = bridgeCalls().filter((c) => c.table === "document_intents");
    expect(calls.map((c) => c.method)).toEqual(["delete", "delete"]);
    for (const [n, slice] of [[0, sheetIds.slice(0, 100)], [1, sheetIds.slice(100)]] as const) {
      const clr = state.calls.indexOf(calls[n]);
      expect(state.calls.slice(clr + 1, clr + 4).map((c) => [c.method, ...c.args])).toEqual([
        ["in", "document_id", slice], ["eq", "ticket_id", "t1"], ["eq", "source", "ticket"],
      ]);
    }
  });

  it("fix pass 3: the bridge runs AFTER the fan-out — the drafter's notice is written before any intent call; an unreadable sheet read registers nothing and never fails the assignment", async () => {
    seedQueue();
    seedBook();
    state.rows.tickets = [ticketRow({ metadata: bookMeta() })];
    expect((await assign()).status).toBe(200);
    const notice = state.calls.findIndex((c) => c.table === "notifications" && c.method === "insert");
    const firstBridge = state.calls.findIndex((c) => c.table === "document_intents" || (c.table === "documents" && c.method === "select"));
    expect(notice).toBeGreaterThan(-1);
    expect(firstBridge).toBeGreaterThan(notice);
    const route = readFileSync(join(process.cwd(), "app", "api", "tickets", "workflow-action", "route.ts"), "utf8");
    expect(route.indexOf("const sheetIds = parseSourceDocuments(ticket.metadata)")).toBeGreaterThan(route.indexOf("await fanOut({ ticket, ticketId: body.ticketId"));
    expect(route).not.toMatch(/for \(const srcDoc of parseSourceDocuments/);

    state.calls = [];
    state.rows.tickets = [ticketRow({ metadata: bookMeta() })];
    state.errors.documents = { code: "57014", message: "timeout" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await assign()).status).toBe(200);
    expect(ticketUpdates()[0]).toMatchObject({ status: "DRAFTING", assigned_drafter_id: "d-1" });
    expect(state.calls.some((c) => c.table === "document_intents")).toBe(false);
    warn.mockRestore();
  });
});

describe("DCW-4 (DF-P4 limb) — a request with a library but no source document closes visibly not in the register", () => {
  it("close: metadata.deliverable names the library as not_in_register, with a history line; REGRESSION: no library, no source → closes as before", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("a-1", "Admin")];
    state.rows.libraries = [{ id: LIB, org_id: "o1", name: "P&IDs" }];
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", assigned_drafter_id: "d-1", attachments: [FINAL], library_id: LIB })];
    const res = await post({ ticketId: "t1", actionType: "close_ticket" });
    expect(res.status).toBe(200);
    const u = ticketUpdates()[0];
    expect(deliverableStateOf(u.metadata as Record<string, unknown>)).toMatchObject({ state: "not_in_register", document_id: null, library_id: LIB });
    expect((u.history as Array<{ action: string; details?: string }>).at(-1)).toMatchObject({ action: "Closed — deliverable not in the register", details: expect.stringContaining("P&IDs") });

    state.calls = [];
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", assigned_drafter_id: "d-1", attachments: [FINAL] })];
    expect((await post({ ticketId: "t1", actionType: "close_ticket" })).status).toBe(200);
    expect("metadata" in ticketUpdates()[0]).toBe(false);
  });
  it("fix pass: a private library is 'the target library' in the close note and the history — its name never reaches the requester or the watchers", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("a-1", "Admin")];
    state.rows.libraries = [{ id: LIB, org_id: "o1", name: "Legal / M&A", visibility: "private" }];
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", assigned_drafter_id: "d-1", attachments: [FINAL], library_id: LIB })];
    expect((await post({ ticketId: "t1", actionType: "close_ticket" })).status).toBe(200);
    const u = ticketUpdates()[0];
    expect((u.history as Array<{ details?: string }>).at(-1)?.details).toBe("Closed without a register document: the deliverable was not published into the target library.");
    expect(JSON.stringify(u)).not.toContain("Legal");
  });
  it("fix pass 2: a NORMAL library with an ACL rule is 'the target library' in the close note — the ACL hides it from some readers", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("a-1", "Admin")];
    state.rows.libraries = [{ id: LIB, org_id: "o1", name: "Confidential Projects", visibility: "normal",
      acl: { rules: [{ subject: { type: "team", id: "team-x" }, effect: "deny", actions: ["discover"] }] } }];
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", assigned_drafter_id: "d-1", attachments: [FINAL], library_id: LIB })];
    expect((await post({ ticketId: "t1", actionType: "close_ticket" })).status).toBe(200);
    const u = ticketUpdates()[0];
    expect((u.history as Array<{ details?: string }>).at(-1)?.details).toBe("Closed without a register document: the deliverable was not published into the target library.");
    expect(JSON.stringify(u)).not.toContain("Confidential");
    expect(state.calls.some((c) => c.table === "libraries" && c.method === "select" && String(c.args[0]).includes("acl"))).toBe(true);
  });
  it("fix pass 2: libraryLabelForTicket names a normal library only when its ACL is absent or carries no rule and no restricted visibility", () => {
    expect(libraryLabelForTicket({ name: "P&IDs", visibility: "normal", acl: null })).toBe("P&IDs");
    expect(libraryLabelForTicket({ name: "P&IDs", visibility: "normal", acl: { rules: [] } })).toBe("P&IDs");
    expect(libraryLabelForTicket({ name: "P&IDs", visibility: "normal", acl: { inherit: true } })).toBe("P&IDs");
    const deny = { rules: [{ subject: { type: "role", id: "Requester" }, effect: "deny", actions: ["discover"] }] };
    const allow = { rules: [{ subject: { type: "team", id: "t" }, effect: "allow", actions: ["read"] }] };
    for (const acl of [deny, allow, { rules: [], visibility: "private" }, { rules: [], visibility: "hidden" }, { rules: "x" }, "garbage", [1]]) {
      expect(libraryLabelForTicket({ name: "Confidential", visibility: "normal", acl }), JSON.stringify(acl)).toBe("the target library");
    }
  });
  it("libraryLabelForTicket: a normal (or unknown-visibility) library keeps its name; hidden / private / missing / blank is 'the target library'", () => {
    expect(libraryLabelForTicket({ name: "P&IDs", visibility: "normal" })).toBe("P&IDs");
    expect(libraryLabelForTicket({ name: "P&IDs" })).toBe("P&IDs");
    for (const v of ["private", "hidden"]) expect(libraryLabelForTicket({ name: "Secret", visibility: v })).toBe("the target library");
    expect(libraryLabelForTicket(null)).toBe("the target library");
    expect(libraryLabelForTicket({ name: "  ", visibility: "normal" })).toBe("the target library");
  });
  it("noteDeliverableNotInLibrary never overwrites a published deliverable", () => {
    expect(noteDeliverableNotInLibrary({ deliverable: { state: "published", version_id: "v" } }, { libraryId: LIB })).toBeNull();
  });
});

describe("SM-9 / EDGE-15 class (DF-P4) — the hand-back route's null token is its own compare-and-set leg", () => {
  it("a ticket whose last_modified is NULL is written only where it is still NULL (`.is`), never with no leg", async () => {
    state.user = { id: "a-1" };
    state.rows.org_members = [member("a-1", "Admin")];
    state.rows.tickets = [ticketRow({ last_modified: null, status: "CLOSED", metadata: { source_document: { id: "doc-1" } } })];
    state.rows.document_versions = [{ id: "v9", org_id: "o1", record_id: "doc-1", revision_label: "5", related_ticket_id: "t1", review_state: null }];
    state.rows.audit_logs = [];
    const res = await handback(req("/api/tickets/handback", { ticketId: "t1", versionId: "v9" }));
    expect(res.status).toBe(200);
    const i = state.calls.findIndex((c) => c.table === "tickets" && c.method === "update");
    const legs = state.calls.slice(i + 1).filter((c) => c.table === "tickets" && (c.method === "eq" || c.method === "is")).map((c) => [c.method, ...c.args]);
    expect(legs).toEqual([["eq", "id", "t1"], ["is", "last_modified", null]]);
  });
  it("with a token the leg is the token, as before", () => {
    const src = readFileSync(join(process.cwd(), "app", "api", "tickets", "handback", "route.ts"), "utf8");
    expect(src).toContain('q = ticket.lastModified ? q.eq("last_modified", String(ticket.lastModified)) : q.is("last_modified", null);');
  });
});

describe("lib/ticketLibrary — pure helpers", () => {
  it("missingLibraryColumn: 42703 / PGRST204 naming library_id only", () => {
    expect(missingLibraryColumn({ code: "42703", message: 'column "library_id" of relation "tickets" does not exist' })).toBe(true);
    expect(missingLibraryColumn({ code: "PGRST204", message: "Could not find the 'library_id' column" })).toBe(true);
    expect(missingLibraryColumn({ code: "42703", message: 'column "outcome" does not exist' })).toBe(false);
    expect(missingLibraryColumn({ code: "23505", message: "library_id" })).toBe(false);
    expect(missingLibraryColumn(null)).toBe(false);
  });
  it("creationNoticeOwed: only a marked, unstamped request still in the queue — never one filed before the mark", () => {
    expect(creationNoticeOwed("PENDING_ASSIGNMENT", { created_notice_owed: true })).toBe(true);
    expect(creationNoticeOwed("PENDING_ASSIGNMENT", { created_notice_owed: true, created_notice_at: NOW })).toBe(false);
    expect(creationNoticeOwed("PENDING_ASSIGNMENT", {})).toBe(false);
    expect(creationNoticeOwed("PENDING_ASSIGNMENT", null)).toBe(false);
    expect(creationNoticeOwed("DRAFTING", { created_notice_owed: true })).toBe(false);
  });
  it("offerableLibraries: a library the caller cannot discover is never offered; controllers and the owner see a private one; no principal, nothing", () => {
    const rows = [
      { id: "l-open", name: "Open" },
      { id: "l-priv", name: "Private", visibility: "private" },
      { id: "l-granted", name: "Granted", visibility: "private", acl: { rules: [{ subject: { type: "user", id: "u-1" }, effect: "allow", actions: ["discover"] }] } as never },
      { id: "l-owned", name: "Owned", visibility: "hidden", ownerUserId: "u-1" },
    ];
    const ids = (p: Parameters<typeof offerableLibraries>[1]) => offerableLibraries(rows, p).map((l) => l.id).sort();
    expect(ids({ uid: "u-1", role: "Requester", roles: ["Requester"], orgId: "o1" })).toEqual(["l-granted", "l-open", "l-owned"]);
    expect(ids({ uid: "u-2", role: "Requester", roles: ["Requester"], orgId: "o1" })).toEqual(["l-open"]);
    expect(ids({ uid: "u-3", role: "DocCtrl", roles: ["DocCtrl"], orgId: "o1" })).toEqual(["l-granted", "l-open", "l-owned", "l-priv"]);
    expect(offerableLibraries(rows, null)).toEqual([]);
  });
  it("linkableDocumentQuery: PostgREST separators removed, too short → null; the filter matches number or title", () => {
    expect(linkableDocumentQuery("P-1")).toBe("P-1");
    expect(linkableDocumentQuery("a")).toBeNull();
    expect(linkableDocumentQuery("P-1,title.eq.x)")).toBe("P-1 title.eq.x");
    expect(linkableDocumentFilter("P-1")).toBe("document_number.ilike.%P-1%,title.ilike.%P-1%");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTHZ-10 — one editor set for the drafting request-form configuration
const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
function lineDiff(a: string, b: string) {
  const L = a.split("\n"), R = b.split("\n");
  return { onlyInA: L.filter((l) => !R.includes(l)), onlyInB: R.filter((l) => !L.includes(l)) };
}
const code = (lines: string[]) => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));

describe("AUTHZ-10 — the page's entry set equals the database's write set (one predicate, pinned)", () => {
  const F209 = "20261209_df_roundG_drafting_config_writes.sql";
  const M = mig(F209);
  it("the requests surface admits exactly DRAFTING_CONFIG_EDITORS (Admin, DocCtrl, DraftingSupervisor) — entry and writes", () => {
    const surf = ADMIN_SURFACES.find((s) => s.key === "requests")!;
    expect(DRAFTING_CONFIG_EDITORS).toEqual(["Admin", "DocCtrl", "DraftingSupervisor"]);
    expect(surf.entry).toEqual(DRAFTING_CONFIG_EDITORS);
    expect(surf.writes).toEqual(DRAFTING_CONFIG_EDITORS);
    for (const r of ["Admin", "DocCtrl", "DraftingSupervisor"]) expect(adminSurfaceAllows(surf, [r], null, "u"), r).toBe(true);
    for (const r of ["Manager", "Supervisor", "Drafter", "Requester", "Engineer-2"]) expect(adminSurfaceAllows(surf, [r], null, "u"), r).toBe(false);
    expect(adminSurfaceAllows(surf, ["Requester", "DocCtrl"], null, "u")).toBe(true);   // additive collection
  });
  it("every 'drafting' branch of the three RESTRICTIVE policies names the SAME set", () => {
    const branches = [...stripComments(M).matchAll(/WHEN 'drafting' THEN caller_holds_any_role\(org_id, ARRAY\[([^\]]+)\]::text\[\]\)/g)].map((m) => m[1].split(",").map((x) => x.trim().replace(/'/g, "")));
    expect(branches).toHaveLength(4);   // ins, upd USING, upd WITH CHECK, del
    for (const b of branches) expect(b).toEqual(DRAFTING_CONFIG_EDITORS);
    expect(stripComments(between(M, "\nBEGIN;\n", "\nCOMMIT;\n"))).not.toContain("is_org_assign_drafters");
  });
  it("lineDiff: the policies are 20261203's (the newest earlier definition, found by scanning) with only the 'drafting' predicate changed", () => {
    const HEAD = "CREATE POLICY org_config_key_writes_ins ON org_configurations";
    const definers = files.filter((f) => stripComments(mig(f)).includes(HEAD));
    expect(definers.at(-1)).toBe(F209);
    const prev = definers[definers.indexOf(F209) - 1];
    expect(prev >= "20261203_ao_roundG_team_members_org_rail.sql").toBe(true);
    const block = (t: string) => between(t, "DROP POLICY IF EXISTS org_config_key_writes_ins ON org_configurations;", "    ELSE true END);\n\nDROP POLICY IF EXISTS org_config_key_writes_del");
    const tail = (t: string) => between(t, "CREATE POLICY org_config_key_writes_del ON org_configurations", "    ELSE true END);");
    const live = block(mig(prev)) + tail(mig(prev));
    const next = block(M) + tail(M);
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect([...new Set(code(onlyInA))]).toEqual(["    WHEN 'drafting' THEN is_org_assign_drafters(org_id)"]);
    expect([...new Set(code(onlyInB))]).toEqual(["    WHEN 'drafting' THEN caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[])"]);
    expect(next.replaceAll("caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[])", "is_org_assign_drafters(org_id)")).toBe(live);
  });
  it("DEC-30 shape: prerequisite refusal, counts-only inventory BEFORE the transaction, BEGIN/COMMIT, ONE final SELECT (check, ok, n)", () => {
    expect(M.indexOf("RAISE EXCEPTION '20261209 needs 20261203")).toBeLessThan(M.indexOf("CREATE TEMP TABLE df_round_g_209_before"));
    expect(M.indexOf("CREATE TEMP TABLE df_round_g_209_before")).toBeLessThan(M.indexOf("\nBEGIN;\n"));
    expect(M.indexOf("\nBEGIN;\n")).toBeLessThan(M.indexOf("\nCOMMIT;\n"));
    const after = M.slice(M.indexOf("\nCOMMIT;\n"));
    expect((stripComments(after).replace(/UNION ALL\s*\nSELECT/g, "UNION ALL SELECT").match(/^SELECT /gm) ?? []).length).toBe(1);
    expect(after).toContain("AS check,");
    expect(after).toContain("AS ok,");
    expect(after).toContain("NULL::text AS n");
    expect(stripComments(M)).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    // inventory rows are counts, never customer rows
    expect(between(M, "CREATE TEMP TABLE df_round_g_209_before", "\nBEGIN;")).not.toMatch(/SELECT\s+(m\.|t\.)?(uid|email|display_name)\b/);
  });
  it("fix pass 2 (CHAIN-7 / SURF-9 census): the sidebar shows 'Request forms' to the same set — the controllers' section, and exactly that entry to a non-controller DRAFTING_CONFIG_EDITORS holder", () => {
    const sb = readFileSync(join(process.cwd(), "components", "navigation", "Sidebar.tsx"), "utf8");
    expect(sb).toContain("import { DRAFTING_CONFIG_EDITORS } from '@/lib/adminSurfaces';");
    expect(sb).toContain("const requestsEntry: NavLeaf = { label: 'Request forms', href: '/admin/requests', icon: FileText, tone: 'orange' };");
    expect(sb).toContain("    if (!isAdmin && hasAnyRole(DRAFTING_CONFIG_EDITORS as Role[])) admin.push(requestsEntry);");
    expect(sb.match(/href: '\/admin\/requests'/g)).toHaveLength(1);
    expect(sb).toMatch(/usersEntry,\n\s+\{ label: 'Teams'[^\n]*\n[^\n]*Library config[^\n]*\n\s+requestsEntry,\n/);
    // The non-controllers the entry adds are exactly the registry's set minus the controllers.
    expect(DRAFTING_CONFIG_EDITORS.filter((r) => r !== "Admin" && r !== "DocCtrl")).toEqual(["DraftingSupervisor"]);
  });
  it("the page has no client redirect (the layout's server gate decides) and says the database's own reason on a refused save", () => {
    const page = readFileSync(join(process.cwd(), "app", "(protected)", "admin", "requests", "page.tsx"), "utf8");
    expect(page).not.toContain("router.push('/dashboard')");
    expect(page).not.toContain("hasAnyRole(['Admin', 'DocCtrl'])");
    expect(page).not.toContain('"Failed to save configuration."');
    expect(page).toContain("Not saved: the database refused the change");
    expect(page).toContain("DRAFTING_CONFIG_EDITORS");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("20261208 — tickets.library_id, the backfill, the guard re-creations, tickets_org_insert dropped", () => {
  const F208 = "20261208_df_roundG_ticket_library.sql";
  const M = mig(F208);
  const GUARD = "CREATE OR REPLACE FUNCTION ticket_update_guard()";
  const INS = "CREATE OR REPLACE FUNCTION ticket_insert_integrity()";
  const prevOf = (head: string) => {
    const d = files.filter((f) => stripComments(mig(f)).includes(head));
    expect(d).toContain(F208);
    return d[d.indexOf(F208) - 1];
  };
  it("the bases are the newest earlier definitions (20261195 today — the scan decides)", () => {
    expect(prevOf(GUARD) >= "20261195_df_roundG_outcome_and_departure.sql").toBe(true);
    expect(prevOf(INS) >= "20261195_df_roundG_outcome_and_departure.sql").toBe(true);
  });
  it("ticket_update_guard lineDiff: nothing removed; the added lines are exactly the library_id rule (the library's own deletion passes)", () => {
    const live = between(mig(prevOf(GUARD)), GUARD, "\n$$;");
    const next = between(M, GUARD, "\n$$;");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(code(onlyInB)).toEqual([
      "  IF NEW.library_id IS DISTINCT FROM OLD.library_id",
      "     AND NOT (pg_trigger_depth() > 1 AND NEW.library_id IS NULL",
      "              AND NOT EXISTS (SELECT 1 FROM libraries l WHERE l.id = OLD.library_id)) THEN",
      "    v_bad := array_append(v_bad, 'library_id');",
    ]);
    // placement: right after the outcome line, before the refusal
    const start = next.indexOf("  -- DF-P4 (drafting-flow GAP-105 / DCW-1)");
    const end = next.indexOf("    v_bad := array_append(v_bad, 'library_id');\n  END IF;\n") + "    v_bad := array_append(v_bad, 'library_id');\n  END IF;\n".length;
    expect(next.slice(0, start).endsWith("array_append(v_bad, 'outcome'); END IF;\n")).toBe(true);
    expect(next.slice(0, start) + next.slice(end)).toBe(live);
  });
  it("ticket_insert_integrity lineDiff: nothing removed; DF-P3's three lines kept contiguous; added: v_name, the library cleared, the member's own name", () => {
    const live = between(mig(prevOf(INS)), INS, "\n$$;");
    const next = between(M, INS, "\n$$;");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(code(onlyInB)).toEqual([
      "  v_name  TEXT;",
      "  NEW.library_id := NULL;",
      "  SELECT NULLIF(btrim(display_name), '') INTO v_name",
      "  WHERE org_id = NEW.org_id AND uid = auth.uid() AND status = 'active'",
      "  NEW.requester_name := COALESCE(v_name, NULLIF(split_part(COALESCE(v_email, ''), '@', 1), ''), 'Unknown');",
    ].filter((l) => !live.split("\n").includes(l)));
    expect(next).toContain("  NEW.sla_breached_at := NULL;\n  NEW.sla_breach_warned_at := NULL;\n  NEW.outcome := NULL;\n");
  });
  it("both functions: definer, search_path pinned, trigger restated, EXECUTE revoked from every client role (DRLS-16)", () => {
    for (const head of [GUARD, INS]) expect(between(M, head, "\n$$;")).toContain("RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(M).toContain("REVOKE ALL ON FUNCTION ticket_update_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(M).toContain("REVOKE ALL ON FUNCTION ticket_insert_integrity() FROM PUBLIC, anon, authenticated, service_role;");
    expect(M).toContain("CREATE TRIGGER trg_ticket_update_guard\n  BEFORE UPDATE ON tickets\n  FOR EACH ROW EXECUTE FUNCTION ticket_update_guard();");
    expect(M).toContain("CREATE TRIGGER trg_ticket_insert_integrity\n  BEFORE INSERT ON tickets\n  FOR EACH ROW EXECUTE FUNCTION ticket_insert_integrity();");
  });
  it("the column: library FK ON DELETE SET NULL + partial index, added before the guard reads it; the backfill is own-org, UUID-guarded and only fills NULLs", () => {
    expect(M).toContain("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS library_id UUID REFERENCES libraries(id) ON DELETE SET NULL;");
    expect(M).toContain("CREATE INDEX IF NOT EXISTS tickets_library_idx ON tickets(library_id) WHERE library_id IS NOT NULL;");
    expect(M.indexOf("ADD COLUMN IF NOT EXISTS library_id")).toBeLessThan(M.indexOf(GUARD));
    const fill = between(M, "UPDATE tickets t\n   SET library_id = d.library_id", "AND d.library_id IS NOT NULL;");
    expect(fill).toContain("WHERE t.library_id IS NULL");
    expect(fill).toContain("AND d.org_id = t.org_id");
    expect(fill).toContain("~ '^[0-9a-fA-F]{8}-");
  });
  it("AUTHZ-3: tickets_org_insert is dropped inside the transaction; the probe checks no INSERT policy remains", () => {
    const tx = between(M, "\nBEGIN;\n", "\nCOMMIT;\n");
    expect(tx).toContain("DROP POLICY IF EXISTS tickets_org_insert ON tickets;");
    expect(stripComments(M)).not.toMatch(/CREATE POLICY tickets_org_insert/);
    expect(M).toContain("NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND cmd IN ('INSERT', 'ALL'))");
  });
  it("DEC-30 shape: prerequisite refusal, counts-only inventory before BEGIN, ONE final SELECT; no 'library_id' refusal before the column exists", () => {
    expect(M.indexOf("RAISE EXCEPTION '20261208 needs 20261195")).toBeLessThan(M.indexOf("CREATE TEMP TABLE df_round_g_208_before"));
    expect(M.indexOf("CREATE TEMP TABLE df_round_g_208_before")).toBeLessThan(M.indexOf("\nBEGIN;\n"));
    const after = M.slice(M.indexOf("\nCOMMIT;\n"));
    expect((stripComments(after).replace(/UNION ALL\s*\nSELECT/g, "UNION ALL SELECT").match(/^SELECT /gm) ?? []).length).toBe(1);
    const inv = between(M, "CREATE TEMP TABLE df_round_g_208_before", "\nBEGIN;");
    expect((inv.match(/COUNT\(/g) ?? []).length).toBeGreaterThanOrEqual(7);
    expect(inv).not.toMatch(/SELECT\s+t\.(id|title|requester_name)\b/);
  });
});

describe("DCW-5 / LibraryPicker — source pins (the component is mounted by DF-P9)", () => {
  it("renders: the 'No library — decide later' choice first and selected, the select held while the libraries load", () => {
    const html = renderToStaticMarkup(createElement(LibraryPicker, { orgId: "o1", value: null, onChange: () => undefined }));
    expect(html).toContain(`<option value="" selected="">${NO_LIBRARY_LABEL}</option>`);
    expect(html).toMatch(/<select[^>]*disabled=""/);
    expect(html).toContain("Target library");
  });
  it("fix pass 2 / 4: a current library the assigner is not offered shows as 'the target library (current)', selected — never 'No library', never its name; an unoffered value that is NOT the current library is 'a library you cannot see (selected)'", () => {
    const cur = renderToStaticMarkup(createElement(LibraryPicker, { orgId: "o1", currentLibraryId: LIB, value: LIB, onChange: () => undefined }));
    expect(cur).toContain(`<option value="${LIB}" selected="">${CURRENT_HIDDEN_LIBRARY_LABEL}</option>`);
    expect(cur).not.toContain(`<option value="" selected="">`);
    expect(CURRENT_HIDDEN_LIBRARY_LABEL).toBe("the target library (current)");
    // fix pass 4: a value with no current library is never called the ticket's current one.
    const html = renderToStaticMarkup(createElement(LibraryPicker, { orgId: "o1", value: LIB, onChange: () => undefined }));
    expect(html).toContain(`<option value="${LIB}" selected="">${OTHER_HIDDEN_LIBRARY_LABEL}</option>`);
    expect(html).not.toContain(CURRENT_HIDDEN_LIBRARY_LABEL);
    expect(OTHER_HIDDEN_LIBRARY_LABEL).toBe("a library you cannot see (selected)");
    // No value → no extra option.
    expect(renderToStaticMarkup(createElement(LibraryPicker, { orgId: "o1", value: null, onChange: () => undefined }))).not.toContain(CURRENT_HIDDEN_LIBRARY_LABEL);
  });
  it("fix pass 3: on a ticket that HAS a library (currentLibraryId) there is no 'No library' choice — triage never clears a library — and the current library is selected for a null value", () => {
    const html = renderToStaticMarkup(createElement(LibraryPicker, { orgId: "o1", currentLibraryId: LIB, value: null, onChange: () => undefined }));
    expect(html).not.toContain(NO_LIBRARY_LABEL);
    expect(html).not.toContain(`<option value=""`);
    expect(html).toContain(`<option value="${LIB}" selected="">${CURRENT_HIDDEN_LIBRARY_LABEL}</option>`);
    // REGRESSION: a ticket with no library keeps 'No library — decide later' first and selected.
    const none = renderToStaticMarkup(createElement(LibraryPicker, { orgId: "o1", currentLibraryId: null, value: null, onChange: () => undefined }));
    expect(none).toContain(`<option value="" selected="">${NO_LIBRARY_LABEL}</option>`);
  });
  it("fix pass 3: the current option is keyed on currentLibraryId — after the selection moves to another library it is still there to choose again", () => {
    const OTHER = "1b000000-0000-4000-8000-000000000002";
    const html = renderToStaticMarkup(createElement(LibraryPicker, { orgId: "o1", currentLibraryId: LIB, value: OTHER, onChange: () => undefined }));
    expect(html).toContain(`<option value="${LIB}">${CURRENT_HIDDEN_LIBRARY_LABEL}</option>`);
    expect(html).toContain(`<option value="${OTHER}" selected="">`);
    expect(html).not.toContain(NO_LIBRARY_LABEL);
    // value === current: one option, not two.
    const same = renderToStaticMarkup(createElement(LibraryPicker, { orgId: "o1", currentLibraryId: LIB, value: LIB, onChange: () => undefined }));
    expect(same.split(`value="${LIB}"`).length - 1).toBe(1);
  });
  it("fix pass 4: current ≠ value, BOTH hidden — the current is 'the target library (current)', the value is 'a library you cannot see (selected)' and selected; neither by name", () => {
    const OTHER = "1b000000-0000-4000-8000-000000000002";
    const html = renderToStaticMarkup(createElement(LibraryPicker, { orgId: "o1", currentLibraryId: LIB, value: OTHER, onChange: () => undefined }));
    expect(html).toContain(`<option value="${LIB}">${CURRENT_HIDDEN_LIBRARY_LABEL}</option>`);
    expect(html).toContain(`<option value="${OTHER}" selected="">${OTHER_HIDDEN_LIBRARY_LABEL}</option>`);
    expect(html.split(CURRENT_HIDDEN_LIBRARY_LABEL).length - 1).toBe(1);
    expect(html).not.toContain(NO_LIBRARY_LABEL);
  });
  it("the picker offers only offerableLibraries (canDiscover) plus 'No library — decide later', the default when the ticket has no library", () => {
    const src = readFileSync(join(process.cwd(), "components", "requests", "LibraryPicker.tsx"), "utf8");
    expect(src).toContain("offerableLibraries(rows, principal)");
    expect(src).toContain('{!current && <option value="">{NO_LIBRARY_LABEL}</option>}');
    expect(src).toContain('export const NO_LIBRARY_LABEL = "No library — decide later";');
  });
  it("the request form names a document by number through the requester's own session, selecting no file column, and links it as the primary source", () => {
    const page = readFileSync(join(process.cwd(), "app", "(protected)", "requests", "new", "page.tsx"), "utf8");
    expect(page).toContain(".from('documents').select('id, document_number, title, rev')");
    expect(page).toContain("sourceDocuments.push({ id: linkedDoc.id, documentNumber: linkedDoc.number, title: linkedDoc.title, rev: linkedDoc.rev, versionId: null });");
    expect(page).toContain("Linked by number only — no file is attached and none of the document&apos;s content is copied into the request");
  });
});
