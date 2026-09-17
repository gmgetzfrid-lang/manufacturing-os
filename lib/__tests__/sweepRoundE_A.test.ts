// Round E, package A-workflow — the ticket-workflow write paths and their
// coherence: WF-9 (attachment / category / watcher writes behind server
// routes with compare-and-set), WF-17 + DEC-14 / DEC-11 (cancel_request,
// the two dead statuses retired, three dormant capabilities marked),
// WF-18 (the Reassign button — reassign_drafter), WF-19 (the assignment
// pool is told on every re-entry; the drain works blank-secret), WF-21 +
// DEC-15 (reopen starts a new cycle; /verify-ticket reports it honestly),
// WF-24 + CHAIN-3 (ONE management tier; attention derived from the engine).
//
// Route tests drive the real handlers against a Proxy-chain supabaseAdmin
// (the sweepRoundD3 pattern) so the refusals and the CAS legs are observed,
// not inferred.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { WorkflowEngine, isManagementRole as engineIsManagementRole, type WorkflowContext } from "@/lib/workflow";
import { MANAGEMENT_ROLES, isManagementRole, holdsManagementRole } from "@/lib/managementRoles";
import { CAPABILITY_DEFS, __resetCapabilityPolicyCache, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { computeTransition, classifyTransitionNotification, issuedRevLabel, draftRevLabel } from "@/lib/ticketTransitions";
import { isActionRequired } from "@/lib/ticketAttention";
import type { Ticket, Role, TicketAttachment, TicketStatus } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}

const NOW = "2026-09-17T12:00:00.000Z";
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "Pump iso", unit: "U-100", requestType: "ISO",
  status: "DRAFTING", requesterId: "req-1", requesterRole: "Requester", assignedDrafterId: "d-1", assignedEngineerId: null,
  attachments: [], comments: [], history: [], unreadBy: [], watchers: [], revisionCount: 0, createdAt: NOW,
  ...over,
} as unknown as Ticket);
const acts = (t: Ticket, role: string, uid?: string, policy?: CapabilityPolicy, ctx?: WorkflowContext) =>
  WorkflowEngine.getActions(t, role as Role, uid, policy, { userRoles: [role] as Role[], ...ctx });
const names = (t: Ticket, role: string, uid?: string, policy?: CapabilityPolicy, ctx?: WorkflowContext) =>
  acts(t, role, uid, policy, ctx).map((a) => a.action);
const file: TicketAttachment = { id: "a-1", name: "iso.pdf", url: "org/REQ-1/iso.pdf", type: "Draft", status: "staged" } as TicketAttachment;

// ── the route harness ────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  onCall: null as null | ((table: string, method: string, args: unknown[]) => void),
}));
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let head = false;
  let payload: unknown = undefined;
  // Copies, never the live objects: a test may mutate state.rows between a
  // route's read and its write to force a CAS conflict.
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)).map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (head) return resolve({ data: null, error: null, count: rows().length });
        if (payload !== undefined && (state.rows[table] ?? []).length === 0 && filters.length === 0) return resolve({ data: [], error: null });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        state.onCall?.(table, prop, args);
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "insert" || prop === "update" || prop === "upsert") payload = args[0];
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
    rpc: vi.fn(async () => ({ error: { code: "PGRST202", message: "Could not find the function" } })),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { PATCH as commentPatch } from "@/app/api/tickets/comment/route";
import { POST as watchPost } from "@/app/api/tickets/watch/route";
import { resolveTicketRecipients } from "@/lib/ticketRouting";

const req = (path: string, method: string, body: unknown, auth = "Bearer t") => new NextRequest(`http://x${path}`, {
  method, headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" }, body: JSON.stringify(body),
});
const post = (body: unknown) => workflowAction(req("/api/tickets/workflow-action", "POST", body));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const LM = "2026-09-17T00:00:00.000Z";
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: "U-100",
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, last_modified: LM, ...over,
});
const updateOf = (table: string) => state.calls.filter((c) => c.table === table && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const insertsOf = (table: string) => state.calls.filter((c) => c.table === table && c.method === "insert").flatMap((c) => (Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Array<Record<string, unknown>>);
const casLegs = () => {
  // the eq() filters recorded on the tickets UPDATE chain, after the update call
  const i = state.calls.findIndex((c) => c.table === "tickets" && c.method === "update");
  return state.calls.slice(i + 1).filter((c) => c.table === "tickets" && c.method === "eq").map((c) => c.args as [string, unknown]);
};

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.onCall = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  delete process.env.CRON_SECRET;
});

// ═════════════════════════════════════════════════════════════════════════════
describe("WF-9 — attaching a file is a workflow action: engine authority, route CAS, page affordance", () => {
  it("attach_file is offered to the participants by identity, to the pool while unassigned, to management — and to no other role", () => {
    const t = ticket({ assignedDrafterId: "d-1", assignedEngineerId: "e-1" });
    expect(names(t, "Requester", "req-1")).toContain("attach_file");
    expect(names(t, "Drafter", "d-1")).toContain("attach_file");
    expect(names(t, "Engineer-2", "e-1")).toContain("attach_file");
    expect(names(t, "Admin", "a-1")).toContain("attach_file");
    // the WF-9 hole: any Drafter / Requester in the org could attach to any ticket
    expect(names(t, "Drafter", "d-other")).not.toContain("attach_file");
    expect(names(t, "Requester", "r-other")).not.toContain("attach_file");
    expect(names(t, "Engineer-2", "e-other")).not.toContain("attach_file");
    expect(names(t, "DocCtrl", "c-1")).not.toContain("attach_file");
    // the unassigned pool (WF-8) may attach, exactly as it may work the ticket
    expect(names(ticket({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null }), "Drafter", "d-other")).toContain("attach_file");
    // terminal tickets take no files
    expect(names(ticket({ status: "CLOSED" }), "Requester", "req-1")).not.toContain("attach_file");
    expect(names(ticket({ status: "CANCELED" }), "Admin", "a-1")).not.toContain("attach_file");
    // it is never an action ITEM (WF-24)
    expect(acts(t, "Requester", "req-1").find((a) => a.action === "attach_file")?.optional).toBe(true);
  });
  it("computeTransition appends the file with a 'File Uploaded' history line and moves nothing else", () => {
    const t = ticket({ attachments: [{ ...file, id: "a-0", name: "old.pdf" } as TicketAttachment] });
    const r = computeTransition(t, { actionType: "attach_file", actionLabel: "Add File", attachment: file, actor: { uid: "d-1", email: "d@x.io", role: "Drafter" }, now: NOW });
    expect(r.newStatus).toBe("DRAFTING");
    expect(r.updates.status).toBeUndefined();
    expect((r.updates.attachments as TicketAttachment[]).map((a) => a.id)).toEqual(["a-0", "a-1"]);
    expect(r.historyEntry.action).toBe("File Uploaded");
    expect(r.historyEntry.details).toBe("Uploaded Draft file: iso.pdf");
    expect(r.updates.last_modified).toBe(NOW);
  });
  it("route: a foreign Drafter is refused (403) and nothing is written; the attachment record is required (400)", async () => {
    state.user = { id: "d-other" };
    state.rows.org_members = [member("d-other", "Drafter"), member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "attach_file", attachment: file });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not available to you at status DRAFTING/);
    expect(updateOf("tickets")).toHaveLength(0);
    state.user = { id: "d-1" };
    const missing = await post({ ticketId: "t1", actionType: "attach_file" });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/requires its name, type and storage URL/);
    const badType = await post({ ticketId: "t1", actionType: "attach_file", attachment: { ...file, type: "Malware" } });
    expect(badType.status).toBe(400);
  });
  it("route: the assigned drafter's attachment rides the (status, last_modified) compare-and-set and the server audit row", async () => {
    state.user = { id: "d-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow({ history: [{ action: "Assigned", user: "a", role: "Admin", date: LM }] })];
    const res = await post({ ticketId: "t1", actionType: "attach_file", attachment: file });
    expect(res.status).toBe(200);
    const [upd] = updateOf("tickets");
    expect((upd.attachments as TicketAttachment[]).map((a) => a.id)).toEqual(["a-1"]);
    expect((upd.history as Array<{ action: string }>).map((h) => h.action)).toEqual(["Assigned", "File Uploaded"]);
    expect(upd.status).toBeUndefined();
    expect(casLegs()).toEqual(expect.arrayContaining([["id", "t1"], ["status", "DRAFTING"], ["last_modified", LM]]));
    const audit = insertsOf("audit_logs").find((a) => a.action === "TICKET_ATTACH_FILE");
    expect(audit?.details).toMatchObject({ from: "DRAFTING", to: "DRAFTING", attachment: { id: "a-1", name: "iso.pdf", type: "Draft" } });
  });
  it("route: a concurrent transition between read and write yields 409 — the stale arrays never land", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [ticketRow()];
    state.onCall = (table, method) => { if (table === "tickets" && method === "update") state.rows.tickets[0].last_modified = "2026-09-17T00:00:01.000Z"; };
    const res = await post({ ticketId: "t1", actionType: "attach_file", attachment: { ...file, type: "Reference" } });
    expect(res.status).toBe(409);
    expect((await res.json()).conflict).toBe(true);
    expect(insertsOf("audit_logs")).toHaveLength(0);
  });
  it("comment route PATCH: the root-cause category is author-or-Admin, compare-and-set, mirrored to the table and audited", async () => {
    state.user = { id: "a-1" };
    state.rows.org_members = [member("a-1", "Admin"), member("v-1", "Viewer")];
    state.rows.tickets = [ticketRow({ comments: [{ id: "c-1", text: "leak", user: "req-1@x.io", role: "Requester", category: null, authorUid: "req-1" }] })];
    const res = await commentPatch(req("/api/tickets/comment", "PATCH", { ticketId: "t1", commentId: "c-1", category: "Vendor data" }));
    expect(res.status).toBe(200);
    const [upd] = updateOf("tickets");
    expect((upd.comments as Array<{ id: string; category: string | null; text: string }>)[0]).toMatchObject({ id: "c-1", category: "Vendor data", text: "leak" });
    expect(casLegs()).toEqual(expect.arrayContaining([["id", "t1"], ["last_modified", LM]]));
    expect(updateOf("ticket_comments")[0]).toEqual({ category: "Vendor data" });
    expect(insertsOf("audit_logs").find((a) => a.action === "TICKET_ROOT_CAUSE_UPDATE")?.details).toMatchObject({ commentId: "c-1", previousCategory: null, newCategory: "Vendor data" });
    // a member who is neither the author nor an Admin is refused
    state.calls = []; state.user = { id: "v-1" };
    const denied = await commentPatch(req("/api/tickets/comment", "PATCH", { ticketId: "t1", commentId: "c-1", category: "x" }));
    expect(denied.status).toBe(403);
    expect(updateOf("tickets")).toHaveLength(0);
    // neither text nor category → 400
    state.user = { id: "a-1" };
    expect((await commentPatch(req("/api/tickets/comment", "PATCH", { ticketId: "t1", commentId: "c-1" }))).status).toBe(400);
  });
  it("watch route: membership-checked, only the caller's own follow, compare-and-set on last_modified, idempotent, 409 on repeated conflict", async () => {
    expect((await watchPost(req("/api/tickets/watch", "POST", { ticketId: "t1", watching: true }, ""))).status).toBe(401);
    state.user = { id: "v-1" };
    state.rows.org_members = [member("d-1", "Drafter")];
    state.rows.tickets = [ticketRow({ watchers: ["d-1"] })];
    expect((await watchPost(req("/api/tickets/watch", "POST", { ticketId: "t1", watching: true }))).status).toBe(403);
    state.rows.org_members.push(member("v-1", "Viewer"));
    const res = await watchPost(req("/api/tickets/watch", "POST", { ticketId: "t1", watching: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).watchers).toEqual(["d-1", "v-1"]);
    const [upd] = updateOf("tickets");
    expect(upd.watchers).toEqual(["d-1", "v-1"]);
    expect(typeof upd.last_modified).toBe("string");
    expect(casLegs()).toEqual(expect.arrayContaining([["id", "t1"], ["last_modified", LM]]));
    // already following → no write
    state.calls = []; state.rows.tickets = [ticketRow({ watchers: ["d-1", "v-1"] })];
    expect((await watchPost(req("/api/tickets/watch", "POST", { ticketId: "t1", watching: true }))).status).toBe(200);
    expect(updateOf("tickets")).toHaveLength(0);
    // unfollow removes only the caller
    state.calls = [];
    const off = await watchPost(req("/api/tickets/watch", "POST", { ticketId: "t1", watching: false }));
    expect((await off.json()).watchers).toEqual(["d-1"]);
    // a ticket that keeps moving under us: re-read once, then 409
    state.calls = []; state.rows.tickets = [ticketRow({ watchers: ["d-1"] })];
    state.onCall = (table, method) => { if (table === "tickets" && method === "update") state.rows.tickets[0].last_modified = `${Date.now()}-${Math.random()}`; };
    const conflict = await watchPost(req("/api/tickets/watch", "POST", { ticketId: "t1", watching: true }));
    expect(conflict.status).toBe(409);
    expect(updateOf("tickets")).toHaveLength(2);
  });
  it("the page no longer writes tickets.attachments / comments / watchers itself, and the upload affordance is derived from the engine", () => {
    const p = src("app/(protected)/requests/[id]/page.tsx");
    expect(p).not.toMatch(/from\('tickets'\)\.update\(\{\s*attachments/);
    expect(p).not.toMatch(/from\('tickets'\)\.update\(\{ comments: updatedComments \}\)/);
    expect(p).not.toMatch(/from\("tickets"\)\.update\(\{ watchers: next \}\)/);
    expect(p).toContain("body: JSON.stringify({ ticketId, actionType: 'attach_file', attachment: newAttachment }),");
    expect(p).toContain("await callCommentApi('PATCH', { ticketId, commentId, category: editCategoryVal });");
    expect(p).toContain("const res = await fetch('/api/tickets/watch', {");
    expect(p).toContain("const canAttach = availableActions.some((a) => a.action === 'attach_file');");
    expect(p).toContain("{canAttach && (");
    expect(p).not.toContain("hasAnyRole(['Drafter', 'Requester', 'Admin'])");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("WF-17 / DEC-14 — cancel_request exists; NEW and PENDING_ENG_INITIAL are gone", () => {
  it("the requester (identity) and the management tier can cancel from the queue or during drafting, with a reason — nobody else, nowhere else", () => {
    for (const status of ["PENDING_ASSIGNMENT", "DRAFTING"] as TicketStatus[]) {
      const t = ticket({ status, assignedDrafterId: status === "DRAFTING" ? "d-1" : null });
      const own = acts(t, "Requester", "req-1").find((a) => a.action === "cancel_request");
      expect(own, status).toBeDefined();
      expect(own?.requiresComment).toBe(true);
      expect(own?.optional).toBe(true);
      expect(names(t, "Manager", "m-1")).toContain("cancel_request");
      expect(names(t, "Requester", "r-other")).not.toContain("cancel_request");
      expect(names(t, "Drafter", "d-1")).not.toContain("cancel_request");
      expect(names(t, "DraftingSupervisor", "s-1")).not.toContain("cancel_request");
    }
    for (const status of ["REVISION_REQ", "PENDING_ENG_TEAM", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT", "CLOSED"] as TicketStatus[]) {
      expect(names(ticket({ status }), "Requester", "req-1"), status).not.toContain("cancel_request");
      expect(names(ticket({ status }), "Admin", "a-1"), status).not.toContain("cancel_request");
    }
    // CANCELED is terminal: not even the Admin's force close or reopen
    expect(names(ticket({ status: "CANCELED" }), "Admin", "a-1")).toEqual([]);
    expect(names(ticket({ status: "CANCELED" }), "Requester", "req-1")).toEqual([]);
  });
  it("computeTransition: cancel_request → CANCELED, closed_at stamped, the reason in the thread", () => {
    const r = computeTransition(ticket({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null }), {
      actionType: "cancel_request", actionLabel: "Cancel Request", comment: "scope withdrawn", variant: "destructive",
      actor: { uid: "req-1", email: "r@x.io", role: "Requester" }, now: NOW,
    });
    expect(r.newStatus).toBe("CANCELED");
    expect(typeof r.updates.closed_at).toBe("string");
    expect(r.newComment).toMatchObject({ text: "scope withdrawn" });
    expect(classifyTransitionNotification({ actionType: "cancel_request", actionLabel: "Cancel Request", ticketLabel: "T" }).eventType).toBe("ticket_closed");
  });
  it("route: the requester cancels their own request with a reason (audited); without one it is 400; a stranger is 403", async () => {
    state.user = { id: "req-1" };
    state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("a-1", "Admin")];
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    expect((await post({ ticketId: "t1", actionType: "cancel_request" })).status).toBe(400);
    const res = await post({ ticketId: "t1", actionType: "cancel_request", comment: "no longer needed" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("CANCELED");
    expect(updateOf("tickets")[0].status).toBe("CANCELED");
    expect(insertsOf("audit_logs").find((a) => a.action === "TICKET_CANCEL_REQUEST")?.details).toMatchObject({ from: "PENDING_ASSIGNMENT", to: "CANCELED" });
    state.calls = []; state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    expect((await post({ ticketId: "t1", actionType: "cancel_request", comment: "x" })).status).toBe(403);
    expect(updateOf("tickets")).toHaveLength(0);
  });
  it("no code path names the retired statuses as a literal; the union, the engine, routing, attention and the page are clean", () => {
    const files = [
      "types/schema.ts", "lib/workflow.ts", "lib/ticketTransitions.ts", "lib/ticketRouting.ts", "lib/ticketAttention.ts",
      "lib/impact.ts", "lib/search.ts", "app/api/intake/resolve/route.ts", "components/dashboard/widgets.tsx",
      "components/requests/WorkflowDiagramModal.tsx", "components/requests/EngineerPickerModal.tsx",
      "app/(protected)/requests/page.tsx", "app/(protected)/requests/[id]/page.tsx", "hooks/useTicketNotifications.ts",
    ];
    for (const f of files) {
      const s = src(f);
      expect(s, f).not.toMatch(/["']PENDING_ENG_INITIAL["']/);
      expect(s, f).not.toMatch(/["']NEW["']/);
    }
    expect(between(src("types/schema.ts"), "export type TicketStatus =", ";")).not.toMatch(/NEW|PENDING_ENG_INITIAL/);
    expect(src("lib/workflow.ts")).not.toContain("action: 'approve_initial'");
    expect(src("lib/ticketTransitions.ts")).not.toContain('case "approve_initial"');
    expect(src("app/(protected)/requests/[id]/page.tsx")).not.toMatch(/['"]approve_initial['"]/);
    // metadata.minor_correction is kept (DEC-11: provenance on a PSM record)
    expect(src("components/documents/CheckInPanel.tsx")).toContain("minor_correction: true");
  });
  it("DEC-11: initial_review / eng_review / final_approve are marked dormant with a reason and the editor greys them; defaults are untouched", () => {
    for (const id of ["ticket.initial_review", "ticket.eng_review", "ticket.final_approve"]) {
      const d = CAPABILITY_DEFS.find((x) => x.id === id)!;
      expect(d.dormant, id).toBe(true);
      expect(d.dormantNote, id).toMatch(/Dormant/);
    }
    expect(CAPABILITY_DEFS.filter((d) => d.dormant).map((d) => d.id)).toEqual(["ticket.initial_review", "ticket.eng_review", "ticket.final_approve"]);
    expect(CAPABILITY_DEFS.find((d) => d.id === "ticket.initial_review")?.defaultRoles).toEqual(["Admin", "Manager", "Supervisor", "Engineer"]);
    const editor = src("components/permissions/CapabilityPolicyEditor.tsx");
    expect(editor).toContain('title={d.dormant ? d.dormantNote : undefined}');
    expect(editor).toContain('${d.dormant ? "opacity-50" : ""}');
    expect(editor).toContain('title={d.dormantNote}>DORMANT</span>');
    expect(src("components/requests/WorkflowDiagramModal.tsx")).toMatch(/CANCELED[\s\S]*Withdrawn by the requester \(or management\) with a reason/);
  });
  it("20261053: inventory in a temp table before the transaction, migrate the two statuses, flip the default, ONE final result set — no CHECK, no customer rows", () => {
    const m = mig("20261053_rp_roundE_dead_statuses.sql");
    expect(m.indexOf("CREATE TEMP TABLE rp_roundE_dead_status_inventory")).toBeLessThan(m.indexOf("BEGIN;"));
    expect(m).toMatch(/CREATE TEMP TABLE rp_roundE_dead_status_inventory AS\s*\nSELECT status, COUNT\(\*\)::bigint AS n\s*\nFROM tickets\s*\nWHERE status IN \('NEW', 'PENDING_ENG_INITIAL'\)/);
    const ddl = between(m, "BEGIN;", "COMMIT;");
    expect(ddl).toMatch(/UPDATE tickets\s*\nSET status = 'PENDING_ASSIGNMENT',/);
    expect(ddl).toMatch(/WHERE status IN \('NEW', 'PENDING_ENG_INITIAL'\);/);
    expect(ddl).toContain("'action', 'Moved to the assignment queue'");
    expect(ddl).toContain("ALTER TABLE tickets ALTER COLUMN status SET DEFAULT 'PENDING_ASSIGNMENT';");
    expect(ddl).not.toMatch(/CHECK|DROP|DELETE|CREATE (OR REPLACE )?FUNCTION|POLICY|SECURITY DEFINER/);
    const tail = m.slice(m.indexOf("COMMIT;") + "COMMIT;".length);
    expect((tail.match(/\bSELECT\b/g) ?? []).length).toBeGreaterThan(0);
    const outsideLiterals = tail.replace(/'(?:[^']|'')*'/g, "''"); // a probe pattern may itself carry a ';'
    expect((outsideLiterals.match(/;/g) ?? []).length).toBe(1); // ONE statement: the editor shows only the last result set
    expect(tail.trim().endsWith(";")).toBe(true);
    expect((tail.match(/UNION ALL/g) ?? []).length).toBe(6);
    expect(tail).toContain("AS check,");
    expect(tail).toContain("::text AS ok");
    expect(tail).toMatch(/inventory: tickets migrated from NEW/);
    expect(tail).toMatch(/inventory: tickets migrated from PENDING_ENG_INITIAL/);
    expect(tail).not.toMatch(/SELECT \*|SELECT id\b|SELECT title/);
    expect(tail).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/);
    expect(tail).toContain("'PENDING_ENG_TEAM', 'PENDING_ASSIGNMENT', 'DRAFTING', 'REVISION_REQ'");
    expect(tail).toContain("'CLOSED', 'CANCELED'");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("WF-18 — the Reassign button carries an action the route accepts: reassign_drafter", () => {
  it("offered to the queue owners (ticket.assign) once a drafter is set, at every live status; never unassigned, never terminal, never to DocCtrl", () => {
    for (const status of ["DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT"] as TicketStatus[]) {
      const t = ticket({ status, assignedEngineerId: "e-1" });
      const a = acts(t, "Admin", "a-1").find((x) => x.action === "reassign_drafter");
      expect(a, status).toBeDefined();
      expect(a?.requiresComment).toBe(true);
      expect(a?.optional).toBe(true);
      expect(names(t, "DraftingSupervisor", "s-1"), status).toContain("reassign_drafter");
      expect(names(t, "DocCtrl", "c-1"), status).not.toContain("reassign_drafter");
      expect(names(t, "Drafter", "d-1"), status).not.toContain("reassign_drafter");
    }
    expect(names(ticket({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null }), "Admin", "a-1")).not.toContain("reassign_drafter");
    expect(names(ticket({ status: "CLOSED" }), "Admin", "a-1")).not.toContain("reassign_drafter");
    expect(names(ticket({ status: "CANCELED" }), "Admin", "a-1")).not.toContain("reassign_drafter");
    // the old button posted `assign`, which is still only a queue action
    expect(names(ticket({ status: "DRAFTING" }), "Admin", "a-1")).not.toContain("assign");
  });
  it("computeTransition: only the drafter slot changes; the new drafter is told; the history names them and the reason; the comment is a Reassignment", () => {
    const r = computeTransition(ticket({ status: "PENDING_IFC", watchers: ["w-1"] }), {
      actionType: "reassign_drafter", actionLabel: "Reassign Drafter", comment: "Hector is out this week",
      assignment: { id: "d-2", name: "Sam" }, actor: { uid: "a-1", email: "a@x.io", role: "Admin" }, now: NOW,
    });
    expect(r.newStatus).toBe("PENDING_IFC");
    expect(r.updates.status).toBeUndefined();
    expect(r.updates.assigned_drafter_id).toBe("d-2");
    expect(r.updates.assigned_drafter_name).toBe("Sam");
    expect(r.recipients).toEqual(expect.arrayContaining(["d-2", "w-1"]));
    expect(r.historyEntry.details).toBe("Reassigned to Sam [Reason: Hector is out this week]");
    expect((r.updates.comments as Array<{ type: string }>)[0].type).toBe("Reassignment");
    expect(classifyTransitionNotification({ actionType: "reassign_drafter", actionLabel: "Reassign Drafter", ticketLabel: "REQ-1" }))
      .toMatchObject({ eventType: "assignment", emailSubject: "You were assigned to REQ-1", inAppKind: "ticket_assigned" });
  });
  it("route: an Admin reassigns at DRAFTING and at PENDING_FINAL_APPROVAL (200, audited, new drafter notified); same drafter / no reason / no drafting authority are refused", async () => {
    state.user = { id: "a-1" };
    state.rows.org_members = [member("a-1", "Admin"), member("req-1", "Requester"), member("d-1", "Drafter"), member("d-2", "Drafter"), member("v-1", "Viewer"), member("e-1", "Engineer-2")];
    for (const status of ["DRAFTING", "PENDING_FINAL_APPROVAL"]) {
      state.calls = [];
      state.rows.tickets = [ticketRow({ status, assigned_engineer_id: status === "PENDING_FINAL_APPROVAL" ? "e-1" : null })];
      const res = await post({ ticketId: "t1", actionType: "reassign_drafter", comment: "out sick", assignment: { id: "d-2", name: "Sam" }, isReassigning: true });
      expect(res.status, status).toBe(200);
      expect((await res.json()).status).toBe(status);
      const [upd] = updateOf("tickets");
      expect(upd.assigned_drafter_id).toBe("d-2");
      expect(upd.status).toBeUndefined();
      expect(upd.unread_by).toEqual(["d-2"]);
      expect(casLegs()).toEqual(expect.arrayContaining([["status", status], ["last_modified", LM]]));
      expect(insertsOf("audit_logs").find((a) => a.action === "TICKET_REASSIGN_DRAFTER")?.details)
        .toMatchObject({ from: status, to: status, from_drafter_id: "d-1", to_drafter_id: "d-2", reason: "out sick" });
      expect(insertsOf("notifications").map((n) => n.user_id)).toEqual(["d-2"]);
      expect(insertsOf("notifications")[0]).toMatchObject({ kind: "ticket_assigned", metadata: { action: "reassign_drafter", status } });
    }
    state.calls = []; state.rows.tickets = [ticketRow()];
    expect((await post({ ticketId: "t1", actionType: "reassign_drafter", comment: "x", assignment: { id: "d-1", name: "Hector" } })).status).toBe(400);
    expect((await post({ ticketId: "t1", actionType: "reassign_drafter", assignment: { id: "d-2", name: "Sam" } })).status).toBe(400);
    const noAuth = await post({ ticketId: "t1", actionType: "reassign_drafter", comment: "x", assignment: { id: "v-1", name: "Vic" } });
    expect(noAuth.status).toBe(400);
    expect((await noAuth.json()).error).toMatch(/does not hold drafting authority/);
    expect(updateOf("tickets")).toHaveLength(0);
    // a DocCtrl (no ticket.assign) is refused by the state machine, not by a hidden button
    state.rows.org_members.push(member("c-1", "DocCtrl")); state.user = { id: "c-1" };
    expect((await post({ ticketId: "t1", actionType: "reassign_drafter", comment: "x", assignment: { id: "d-2", name: "Sam" } })).status).toBe(403);
  });
  it("route: an Admin reassigns the ENGINEER reviewer at PENDING_FINAL_APPROVAL (the existing override now proven end to end)", async () => {
    state.user = { id: "a-1" };
    state.rows.org_members = [member("a-1", "Admin"), member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("e-2", "Engineer-3")];
    state.rows.tickets = [ticketRow({ status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1" })];
    const res = await post({ ticketId: "t1", actionType: "reassign_engineer", engineer: { id: "e-2", name: "Eve", email: "e-2@x.io" } });
    expect(res.status).toBe(200);
    const [upd] = updateOf("tickets");
    expect(upd.assigned_engineer_id).toBe("e-2");
    expect(upd.status).toBeUndefined();
    expect(insertsOf("audit_logs").find((a) => a.action === "TICKET_REASSIGN_ENGINEER")).toBeDefined();
    expect(insertsOf("notifications").map((n) => n.user_id)).toEqual(["e-2"]);
  });
  it("the page's Reassign button is the engine's action, never a hand-built `assign`", () => {
    const p = src("app/(protected)/requests/[id]/page.tsx");
    expect(p).not.toContain("setPendingAction({ action: 'assign', label: 'Reassign Ticket', variant: 'warning' });");
    expect(p).toContain("const handleReassignClick = (action: WorkflowAction) => {");
    expect(p).toContain("const reassignAction = availableActions.find((a) => a.action === 'reassign_drafter');");
    expect(p).toContain("{reassignAction && (");
    expect(p).toContain("onClick={() => handleReassignClick(reassignAction)}");
    expect(p).toContain("if (action.action === 'reassign_drafter') { handleReassignClick(action); return; }");
    expect(p).not.toMatch(/isAdmin && ticket\.assignedDrafterId && ticket\.status !== 'CLOSED'/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("WF-19 — the assignment pool is told on every (re-)entry into PENDING_ASSIGNMENT", () => {
  it("route: engineering review complete → the DraftingSupervisor is notified (in-app + email) and joins unread_by; Admins step aside; the actor is excluded", async () => {
    state.user = { id: "e-1" };
    state.rows.org_members = [member("e-1", "Engineer-2"), member("req-1", "Requester"), member("a-1", "Admin"), member("sup-1", "DraftingSupervisor"), member("mgr-sup", "Manager", ["Manager", "DraftingSupervisor"])];
    state.rows.tickets = [ticketRow({ status: "PENDING_ENG_TEAM", assigned_drafter_id: null, assigned_engineer_id: "e-1", engineer_review_requested_at: LM })];
    const res = await post({ ticketId: "t1", actionType: "approve_team" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("PENDING_ASSIGNMENT");
    const [upd] = updateOf("tickets");
    expect((upd.unread_by as string[]).sort()).toEqual(["mgr-sup", "req-1", "sup-1"]);
    const told = insertsOf("notifications").map((n) => n.user_id).sort();
    expect(told).toEqual(["mgr-sup", "req-1", "sup-1"]); // the collection-held supervisor too (done-when 2)
    expect(insertsOf("notifications")[0]).toMatchObject({ metadata: { action: "approve_team", status: "PENDING_ASSIGNMENT" } });
    expect(insertsOf("email_notifications").map((e) => e.to_user_id).sort()).toEqual(["mgr-sup", "req-1", "sup-1"]);
  });
  it("route: with no supervisor the Admins are the pool; a non-entry action in the queue does not re-notify it", async () => {
    state.user = { id: "e-1" };
    state.rows.org_members = [member("e-1", "Engineer-2"), member("req-1", "Requester"), member("a-1", "Admin"), member("a-2", "Admin")];
    state.rows.tickets = [ticketRow({ status: "PENDING_ENG_TEAM", assigned_drafter_id: null, assigned_engineer_id: "e-1" })];
    expect((await post({ ticketId: "t1", actionType: "approve_team" })).status).toBe(200);
    expect(insertsOf("notifications").map((n) => n.user_id).sort()).toEqual(["a-1", "a-2", "req-1"]);
    state.calls = []; state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    expect((await post({ ticketId: "t1", actionType: "attach_file", attachment: { ...file, type: "Reference" } })).status).toBe(200);
    expect(insertsOf("notifications").map((n) => n.user_id)).toEqual([]); // requester is the actor; drafter unassigned; no queue re-entry
  });
  it("resolveTicketRecipients takes the caller's client (the route passes supabaseAdmin) and reads the full collection", async () => {
    const seen: string[] = [];
    const client = { from: (t: string) => { seen.push(t); return chain(t); } } as unknown as Parameters<typeof resolveTicketRecipients>[3];
    state.rows.org_members = [member("a-1", "Admin"), member("mgr-sup", "Manager", ["Manager", "DraftingSupervisor"])];
    const out = await resolveTicketRecipients("o1", "PENDING_ASSIGNMENT", "a-1", client);
    expect(out.map((m) => m.uid)).toEqual(["mgr-sup"]);
    expect(seen).toEqual(expect.arrayContaining(["org_members", "org_configurations"]));
    const r = src("app/api/tickets/workflow-action/route.ts");
    expect(r).toContain('await resolveTicketRecipients(ticket.orgId, "PENDING_ASSIGNMENT", caller.id, supabaseAdmin)');
    expect(r).toContain('if (newStatus === "PENDING_ASSIGNMENT" && ticket.status !== "PENDING_ASSIGNMENT") {');
    expect(src("lib/ticketRouting.ts")).not.toContain("PENDING_ENG_INITIAL");
  });
  it("done-when 3: the post-action drain falls back to the caller's session token when CRON_SECRET ships blank", () => {
    for (const f of ["app/api/tickets/workflow-action/route.ts", "app/api/tickets/comment/route.ts"]) {
      const s = src(f);
      expect(s, f).toContain("const drainToken = process.env.CRON_SECRET || authHeader.slice(7);");
      expect(s, f).toContain("headers: { Authorization: `Bearer ${drainToken}` },");
      expect(s, f).not.toContain('Bearer ${process.env.CRON_SECRET || ""}');
    }
    // SURF-5's drain accepts a session bearer and scopes it to the caller's orgs
    expect(src("app/api/notifications/send-queued/route.ts")).toContain("const { data: { user } } = await supabase.auth.getUser(token);");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("WF-21 / DEC-15 — a reopen starts a new revision cycle, and the QR endpoint says so", () => {
  const drafter = { uid: "d-1", email: "d@x.io", role: "Drafter" };
  const admin = { uid: "a-1", email: "a@x.io", role: "Admin" };
  it("two approvals of the same ticket can no longer produce the same issued label: issue 2 → reopen → 3A → 3", () => {
    const issued = computeTransition(ticket({ status: "PENDING_REVIEW", revisionCount: 1, draftIteration: 1, deliverableRev: "2A" }),
      { actionType: "approve_draft_ifc", actionLabel: "Approve", actor: admin, now: NOW });
    expect(issued.updates.deliverable_rev).toBe("2");
    const closed = ticket({ status: "CLOSED", revisionCount: 1, draftIteration: 1, deliverableRev: "2" });
    const reopened = computeTransition(closed, { actionType: "reopen_ticket", actionLabel: "Reopen Ticket", comment: "missed detail", actor: admin, now: NOW });
    expect(reopened.newStatus).toBe("PENDING_REVIEW");
    expect(reopened.updates).toMatchObject({ revision_count: 2, draft_iteration: 0, deliverable_rev: null, closed_at: null });
    const resubmitted = computeTransition(ticket({ status: "REVISION_REQ", revisionCount: 2, draftIteration: 0, deliverableRev: null }),
      { actionType: "submit_draft", actionLabel: "Submit Draft for Review", actor: drafter, now: NOW });
    expect(resubmitted.updates.deliverable_rev).toBe("3A");
    const reissued = computeTransition(ticket({ status: "PENDING_REVIEW", revisionCount: 2, draftIteration: 1, deliverableRev: "3A" }),
      { actionType: "approve_draft_ifc", actionLabel: "Approve", actor: admin, now: NOW });
    expect(reissued.updates.deliverable_rev).toBe("3");
    expect(issuedRevLabel(2)).not.toBe(issuedRevLabel(1));
    expect(draftRevLabel(2, 1)).toBe("3A");
  });
  it("approve_minor_correction at PENDING_FINAL_APPROVAL stamps engineer_approved_at (the sign-off dot resolves); at PENDING_REVIEW it does not", () => {
    const eng = { uid: "e-1", email: "e@x.io", role: "Engineer-2" };
    const final = computeTransition(ticket({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "e-1", revisionCount: 0, draftIteration: 1, deliverableRev: "1A" }),
      { actionType: "approve_minor_correction", actionLabel: "Approve with Minor Correction", comment: "typo", actor: eng, now: NOW });
    expect(final.updates.engineer_approved_at).toBe(NOW);
    expect(final.updates.deliverable_rev).toBe("1");
    const review = computeTransition(ticket({ status: "PENDING_REVIEW", revisionCount: 0, draftIteration: 1, deliverableRev: "1A" }),
      { actionType: "approve_minor_correction", actionLabel: "Approve with Minor Correction", comment: "typo", actor: admin, now: NOW });
    expect(review.updates.engineer_approved_at).toBeUndefined();
  });
  it("/api/verify-ticket: a reopened ticket reads revision_in_progress for the last issue, superseded for older, never current; closed-without-issue stays unknown", async () => {
    const { GET } = await import("@/app/api/verify-ticket/route");
    const T = "11111111-1111-1111-1111-111111111111";
    const verify = async (r: string) => {
      const u = new URL("https://app/api/verify-ticket"); u.searchParams.set("t", T); u.searchParams.set("r", r);
      return (await (await GET(new NextRequest(u))).json()) as Record<string, unknown>;
    };
    const row = (over: Record<string, unknown>) => ({ id: T, ticket_id: "REQ-1", title: "x", unit: "U", status: "PENDING_REVIEW", deliverable_rev: null, revision_count: 2, last_modified: LM, ...over });
    state.rows.tickets = [row({})]; // reopened after Rev 2 was issued
    expect((await verify("2")).verdict).toBe("revision_in_progress");
    expect((await verify("2")).latestIssuedRev).toBe("2");
    expect((await verify("2")).inReview).toBe(true);
    expect((await verify("1")).verdict).toBe("superseded");
    expect((await verify("2A")).verdict).toBe("draft_copy");
    state.rows.tickets = [row({ status: "CLOSED" })]; // closed again with no new issue
    expect((await verify("2")).verdict).toBe("unknown");
    state.rows.tickets = [row({ status: "PENDING_IFC", deliverable_rev: "2", revision_count: 1 })]; // an ordinary issue is still current
    expect((await verify("2")).verdict).toBe("current");
    state.rows.tickets = [row({ status: "PENDING_REVIEW", deliverable_rev: "3A", revision_count: 2 })]; // the resubmission after the reopen
    expect((await verify("2")).verdict).toBe("revision_in_progress");
    state.rows.tickets = [row({ status: "DRAFTING", deliverable_rev: null, revision_count: 0 })]; // never issued
    expect((await verify("1")).verdict).toBe("unknown");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("WF-24 / CHAIN-3 — ONE management tier; attention is derived from the engine", () => {
  it("the three former lists are one: engine, capability defaults and attention all read lib/managementRoles.ts", () => {
    expect(MANAGEMENT_ROLES).toEqual(["Admin", "Manager", "Supervisor"]);
    expect(engineIsManagementRole).toBe(isManagementRole);
    expect(isManagementRole("DraftingSupervisor")).toBe(false);
    expect(holdsManagementRole(["Viewer", "Supervisor"])).toBe(true);
    for (const id of ["ticket.manage", "ticket.reopen", "ticket.force_close"]) {
      expect(CAPABILITY_DEFS.find((d) => d.id === id)?.defaultRoles, id).toEqual([...MANAGEMENT_ROLES]);
    }
    expect(src("lib/capabilityPolicy.ts")).toContain("const MGMT = [...MANAGEMENT_ROLES];");
    expect(src("lib/workflow.ts")).toContain('import { isManagementRole } from "@/lib/managementRoles";');
    expect(src("lib/workflow.ts")).not.toMatch(/role === "Admin" \|\| role === "Manager" \|\| role === "Supervisor"/);
    const att = src("lib/ticketAttention.ts");
    expect(att).not.toMatch(/export const MANAGEMENT_ROLES/);
    expect(att).toContain('import { WorkflowEngine } from "@/lib/workflow";');
    expect(att).toContain("return actions.some((a) => !a.optional && !a.disabledReason);");
    expect(att).not.toMatch(/status === "PENDING_IFC"[\s\S]*return true/);
  });
  it("the badge hook and the portal evaluate under the org's own policy and use the visibility scope, not the tier", () => {
    const hook = src("hooks/useTicketNotifications.ts");
    expect(hook).toContain("isActionRequired(t, { uid, roles, policy })");
    expect(hook).toContain("isQueueViewer(roles) || isEngineerRole(roles) || roles.includes('DocCtrl')");
    expect(hook).toContain("void loadCapabilityPolicy(activeOrgId).then((p) => { if (alive) setPolicy(p); }).catch(() => {});");
    const portal = src("app/(protected)/requests/page.tsx");
    expect(portal).toContain("ticketNeedsAction(ticket, { uid, roles, policy: capPolicy })");
    expect(portal).toContain("const isSupervisorView = isQueueViewer(roles);");
  });
  it("the three surfaces agree at the queue: everyone routing tells is offered `assign`; attention flags exactly the engine's actors", async () => {
    state.rows.org_members = [member("a-1", "Admin"), member("sup-1", "DraftingSupervisor"), member("m-1", "Manager"), member("d-1", "Drafter"), member("v-1", "Viewer")];
    const queue = ticket({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null, requesterId: "req-1" });
    for (const cfg of [null, { org_id: "o1", key: "drafting", data: { routing: { adminsAlsoReceiveWhenSupervisorSet: true } } }]) {
      state.rows.org_configurations = cfg ? [cfg] : [];
      const told = await resolveTicketRecipients("o1", "PENDING_ASSIGNMENT", undefined, { from: (t: string) => chain(t) } as unknown as Parameters<typeof resolveTicketRecipients>[3]);
      expect(told.length).toBeGreaterThan(0);
      for (const m of told) {
        expect(names(queue, m.role, m.uid), m.uid).toContain("assign");
        expect(isActionRequired(queue, { uid: m.uid, roles: m.roles }), m.uid).toBe(true);
      }
    }
    // a Manager can assign (engine) and is flagged (attention) but is not TOLD (routing's narrower policy) — recorded, deliberate
    expect(names(queue, "Manager", "m-1")).toContain("assign");
    expect(isActionRequired(queue, { uid: "m-1", roles: ["Manager"] })).toBe(true);
    // the WF-24 case: a DraftingSupervisor at PENDING_REVIEW / PENDING_FINAL_APPROVAL — page offers nothing, badge stays off
    for (const status of ["PENDING_REVIEW", "PENDING_FINAL_APPROVAL"] as TicketStatus[]) {
      const t = ticket({ status, assignedEngineerId: "e-1" });
      expect(names(t, "DraftingSupervisor", "sup-1").filter((a) => a !== "reassign_drafter"), status).toEqual([]);
      expect(isActionRequired(t, { uid: "sup-1", roles: ["DraftingSupervisor"] }), status).toBe(false);
    }
  });
});
