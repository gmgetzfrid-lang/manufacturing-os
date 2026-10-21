// drafting-flow Round G, DF-P8 PROJECTS — GAP-114 / DEC-40: projects ↔
// requests BY REFERENCE (tickets.project_id, 20261256), and the package's
// remainders (PROJ-*, LEAK-4 / EVID-1 / PERS-2, DCW-4, SM-4, SM-7, DELIV-16).
//
//   * the migration's DEC-30 shape (one paste; counts-only inventory before
//     the transaction; one final SELECT) and its guard (invoker, pinned,
//     revoked); ticket_update_guard is NOT re-created;
//   * /api/tickets/project-link: who may link / unlink / record a project
//     created from the request; one compare-and-set carrying the reference,
//     the ONE history line and metadata.project_link; audit first; the
//     project feed; before the paste a 503 with nothing written;
//   * the pure helpers (projectRefOf, deliverableReference, the closeout
//     gate, the library-less deliverable state, SM-4's archive claim);
//   * the SM-7 drain (mirrors from the JSONB; _NOT_APPLIED from history);
//   * source pins: convertTicketToProject no longer writes `history` from the
//     browser; CheckInPanel's review_requested goes through emit()'s
//     compliance leg (notifyCompliance, N15) to exactly the same audience.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { freshState, resetState, makeSupabase, type MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({
  admin: null as unknown as MemoryState,
  caller: null as unknown as MemoryState,
  user: { id: "u-req", email: "req@plant.io" } as { id: string; email: string } | null,
  policy: { ok: true, policy: undefined, version: null } as Record<string, unknown>,
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const mem = await import("./helpers/memoryDb");
  h.admin = mem.freshState();
  const sb = mem.makeSupabase(h.admin) as Record<string, unknown>;
  sb.auth = { getUser: async () => (h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) };
  return { supabaseAdmin: sb };
});
vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/memoryDb");
  h.caller = mem.freshState();
  return { callerScopedClient: () => mem.makeSupabase(h.caller) };
});
vi.mock("@/lib/notify/dispatch", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify/dispatch")>()),
  emit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<typeof import("@/lib/capabilityPolicy")>()),
  loadCapabilityPolicyStrict: vi.fn(async () => h.policy),
}));

import { POST as projectLink } from "@/app/api/tickets/project-link/route";
import { POST as handback } from "@/app/api/tickets/handback/route";
import { projectRefOf } from "@/lib/ticketPage";
import { callerHoldsRegisterAuthority, callerMayStampDocAdded, REQUEST_DELIVERABLE_REFERENCED, requestHolderLabel, deliverableReference, isMissingProjectColumn, projectLinkAllowed, projectLinkHistoryEntry, projectsTouched, recordedRegisterAuthority, referenceDeliverableInProject } from "@/lib/ticketProject";
import { deliverableStateOf, noteDeliverableNotInAnyRegister } from "@/lib/ticketHandback";
import { closeoutGateLines } from "@/lib/projects";
import { computeTransition, rowToTicket } from "@/lib/ticketTransitions";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { runTicketAuditDrain, mirrorRowFor, historyNamesAttempt } from "@/lib/ticketAuditDrain";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";
import { noProjectMatrix, noProjectRow, MATRIX_NOW, MATRIX_STATUSES } from "./helpers/noProjectTransitionMatrix";

type Row = Record<string, unknown>;
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ORG = "o-1";
const T = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const LM = "2026-10-21T09:00:00.000Z";

const req = (body: unknown) => new NextRequest("https://app.plant.io/api/tickets/project-link", {
  method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body),
});
const ticketRow = (over: Row = {}): Row => ({
  id: T, org_id: ORG, ticket_id: "KE-26-0042", title: "Re-route flare header", project_id: null, metadata: {},
  history: [{ action: "Created", user: "req@plant.io", date: LM }], last_modified: LM, archived_at: null,
  requester_id: "u-req", assigned_drafter_id: null, assigned_engineer_id: null, watchers: ["u-req"], ...over,
});
const seed = (ticket: Row = {}) => {
  resetState(h.admin); resetState(h.caller);
  h.user = { id: "u-req", email: "req@plant.io" };
  h.policy = { ok: true, policy: undefined, version: null };
  h.admin.tables.tickets = [ticketRow(ticket)];
  h.admin.tables.org_members = [
    { org_id: ORG, uid: "u-req", role: "Viewer", roles: [], email: "req@plant.io", status: "active" },
    { org_id: ORG, uid: "u-mgr", role: "Manager", roles: [], email: "mgr@plant.io", status: "active" },
    { org_id: ORG, uid: "u-other", role: "Viewer", roles: [], email: "other@plant.io", status: "active" },
  ];
  h.admin.tables.projects = [{ id: P1, org_id: ORG, name: "Turnaround" }, { id: P2, org_id: ORG, name: "Old job" }];
  h.caller.tables.projects = [{ id: P1, org_id: ORG, name: "Turnaround", status: "active", linked_ticket_id: null }, { id: P2, org_id: ORG, name: "Old job", status: "active", linked_ticket_id: null }];
};
const ticket = () => h.admin.tables.tickets[0];
const audits = () => (h.admin.tables.audit_logs ?? []) as Row[];
const activity = () => (h.admin.tables.project_activity ?? []) as Row[];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  seed();
});

describe("20261256 — DEC-30 one paste; the guard; ticket_update_guard untouched", () => {
  const sql = src("supabase/migrations/20261256_df_roundG_ticket_project.sql");
  it("counts-only TEMP inventory BEFORE BEGIN; one BEGIN / COMMIT; one final SELECT (check, ok, n) after COMMIT", () => {
    const temp = sql.indexOf("CREATE TEMP TABLE df_round_g_256_before");
    const begin = sql.indexOf("\nBEGIN;");
    const commit = sql.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(0);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(sql.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(sql.match(/\nCOMMIT;/g)).toHaveLength(1);
    const tail = sql.slice(commit);
    expect(tail).toMatch(/SELECT "check", ok, n FROM \(/);
    expect(tail.match(/^SELECT "check"/gm)).toHaveLength(1);
    // the inventory reads counts only, never a customer row
    const inv = sql.slice(temp, begin);
    expect(inv).not.toMatch(/SELECT\s+\*|t\.title|t\.description|p\.name/);
    expect((inv.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(6);
  });
  it("the reference: nullable UUID → projects(id) ON DELETE SET NULL, partial index", () => {
    expect(sql).toContain("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS tickets_project_id_idx ON tickets (project_id) WHERE project_id IS NOT NULL;");
  });
  it("the guard: SECURITY INVOKER, search_path pinned, EXECUTE revoked from every client role; the org rail for every caller, the client limb after the service-role return", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION ticket_project_guard\(\)\nRETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS \$\$/);
    expect(sql).toContain("REVOKE ALL ON FUNCTION ticket_project_guard() FROM PUBLIC, anon, authenticated, service_role;");
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION ticket_project_guard"), sql.indexOf("REVOKE ALL ON FUNCTION ticket_project_guard"));
    expect(body.indexOf("p.org_id = NEW.org_id")).toBeLessThan(body.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;"));
    expect(body).toMatch(/pg_trigger_depth\(\) > 1 AND NEW\.project_id IS NULL\s+AND NOT EXISTS \(SELECT 1 FROM projects p WHERE p\.id = OLD\.project_id\)/);
    expect(sql).toMatch(/CREATE TRIGGER trg_ticket_project_guard\s+BEFORE INSERT OR UPDATE ON tickets/);
  });
  it("fix pass 4 (review, minor): checkout_sessions.linked_ticket_id is re-created ON DELETE SET NULL inside the transaction (every non-SET-NULL key on the column dropped by catalog, whatever its name; re-runnable), and a seventh probe says so", () => {
    const body = sql.slice(sql.indexOf("\nBEGIN;"), sql.indexOf("\nCOMMIT;"));
    expect(body).toContain("-- ── 4. checkout_sessions.linked_ticket_id → tickets(id) ON DELETE SET NULL");
    expect(body).toMatch(/c\.conrelid = 'public\.checkout_sessions'::regclass\s+AND c\.confrelid = 'public\.tickets'::regclass AND a\.attname = 'linked_ticket_id'\s+AND c\.confdeltype <> 'n'/);
    expect(body).toContain("EXECUTE format('ALTER TABLE checkout_sessions DROP CONSTRAINT %I', r.conname);");
    expect(body).toContain("FOREIGN KEY (linked_ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;");
    const tail = sql.slice(sql.indexOf("\nCOMMIT;"));
    expect(tail).toContain("SELECT 1, 7, 'a check-in session''s linked_ticket_id references tickets(id) ON DELETE SET NULL only");
    expect(tail.match(/^SELECT 1, \d+, /gm)?.length).toBe(6); // probes 2..7 (probe 1 opens the UNION)
    expect(sql).toContain("-- Probes: ok = true × 7 on a correct paste.");
  });
  it("ticket_update_guard is NOT re-created here (its newest body stays 20261250's) — so no lineDiff is owed", () => {
    expect(sql).not.toMatch(/FUNCTION\s+ticket_update_guard/);
    const newest = readdirSync(join(process.cwd(), "supabase/migrations")).filter((f) => /^\d{8}_.*\.sql$/.test(f)).sort()
      .filter((f) => /CREATE OR REPLACE FUNCTION ticket_update_guard\(\)/.test(src(`supabase/migrations/${f}`))).pop();
    expect(newest).toBe("20261250_df_roundG_review_model.sql");
  });
  it("DEC-90 ruling (2): the backfill writes exactly inventory row 2's rows — a same-workspace project, a UUID, never a request the link route recorded, never touching last_modified", () => {
    const upd = sql.slice(sql.indexOf("UPDATE tickets t"), sql.indexOf("\nCOMMIT;"));
    expect(upd).toContain("t.project_id IS NULL");
    expect(upd).toContain("NOT (t.metadata ? 'project_link')");
    expect(upd).toContain("p.org_id = t.org_id");
    expect(upd).toMatch(/~\* '\^\[0-9a-f\]\{8\}/);
    expect(upd).not.toMatch(/last_modified/);
  });
});

describe("/api/tickets/project-link — GAP-114 / PROJ-13 / LEAK-4 / EVID-1 / PERS-2", () => {
  it("the requester links a request to a project they can see: ONE compare-and-set carries the reference, the ONE history line and metadata.project_link; the audit row is written first; the project feed says so", async () => {
    const res = await projectLink(req({ ticketId: T, projectId: P1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, projectId: P1 });
    expect(ticket().project_id).toBe(P1);
    expect((ticket().metadata as Row).project_link).toMatchObject({ projectId: P1, by: "u-req" });
    const hist = ticket().history as Row[];
    expect(hist).toHaveLength(2);
    expect(hist[1]).toMatchObject({ action: "Linked to project", user: "req@plant.io" });
    const ticketWrites = h.admin.writes.filter((w) => w.table === "tickets");
    expect(ticketWrites).toHaveLength(1);
    expect(ticketWrites[0].filters).toContainEqual(["last_modified", LM]);
    const order = h.admin.writes.map((w) => w.table);
    expect(order.indexOf("audit_logs")).toBeLessThan(order.indexOf("tickets"));
    expect(audits()[0]).toMatchObject({ action: "TICKET_PROJECT_LINKED", resource_id: T, details: expect.objectContaining({ projectId: P1, authority: "requester", recordedBeforeApply: true }) });
    expect(activity()).toEqual([expect.objectContaining({ project_id: P1, type: "request_linked", user_id: "u-req" })]);
  });
  it("PROJ-13: converted — the history line is 'Converted to Project' (written by the server, never the browser)", async () => {
    (h.caller.tables.projects as Row[])[0].linked_ticket_id = T; // the project the browser just created names this request
    const res = await projectLink(req({ ticketId: T, projectId: P1, converted: true }));
    expect(res.status).toBe(200);
    expect((ticket().history as Row[]).at(-1)).toMatchObject({ action: "Converted to Project" });
    expect(activity()[0].body).toMatch(/this project was created from it/);
  });
  it("a member who manages requests (ticket.manage — the default Manager) may link; another member who is neither requester, manager nor the project's manager is refused, nothing written", async () => {
    h.user = { id: "u-other", email: "other@plant.io" };
    h.caller.rpc = { can_manage_project: () => ({ data: false, error: null }) };
    const no = await projectLink(req({ ticketId: T, projectId: P1 }));
    expect(no.status).toBe(403);
    expect(h.admin.writes).toEqual([]);
    h.user = { id: "u-mgr", email: "mgr@plant.io" };
    const yes = await projectLink(req({ ticketId: T, projectId: P1 }));
    expect(yes.status).toBe(200);
    expect(audits()[0].details).toMatchObject({ authority: "ticket.manage" });
  });
  it("the project's manager (can_manage_project, asked AS THE CALLER) may link a request to their project", async () => {
    h.user = { id: "u-other", email: "other@plant.io" };
    h.caller.rpc = { can_manage_project: (a) => ({ data: a.p_project === P1, error: null }) };
    expect((await projectLink(req({ ticketId: T, projectId: P1 }))).status).toBe(200);
    expect(audits()[0].details).toMatchObject({ authority: "project_manager" });
  });
  it("fix pass (major 1a): a MOVE between projects needs a manager of BOTH — the target's manager alone cannot take a request off a project another team manages; nothing written", async () => {
    seed({ project_id: P2 });
    (h.admin.tables.projects as Row[])[1].linked_ticket_id = T;
    h.user = { id: "u-other", email: "other@plant.io" };
    const asked: string[] = [];
    h.caller.rpc = { can_manage_project: (a) => { asked.push(String(a.p_project)); return { data: a.p_project === P1, error: null }; } };
    const no = await projectLink(req({ ticketId: T, projectId: P1 }));
    expect(no.status).toBe(403);
    expect((await no.json()).error).toMatch(/manages both projects/);
    expect(asked).toContain(P2); // the CURRENT project's managers were asked, not only the target's
    expect(h.admin.writes).toEqual([]);
    expect(ticket().project_id).toBe(P2);
    expect((h.admin.tables.projects as Row[])[1].linked_ticket_id).toBe(T); // the old project's origin chip untouched
    // a manager of both projects may move it
    h.caller.rpc = { can_manage_project: () => ({ data: true, error: null }) };
    const yes = await projectLink(req({ ticketId: T, projectId: P1 }));
    expect(yes.status).toBe(200);
    expect(audits()[0].details).toMatchObject({ authority: "project_manager", previousProjectId: P2, projectId: P1 });
    // an unlink asks about the current project only; a link from none about the target only
    expect(projectsTouched(P2, null)).toEqual([P2]);
    expect(projectsTouched(null, P1)).toEqual([P1]);
    expect(projectsTouched(P2, P1)).toEqual([P2, P1]);
  });
  it("fix pass (major 1b): 'Create project from this request' (converted) is the requester's or management's only, and only for a project that names this request as its origin — a forged converted:true writes nothing", async () => {
    // a project manager who is neither requester nor ticket.manage
    h.user = { id: "u-other", email: "other@plant.io" };
    h.caller.rpc = { can_manage_project: () => ({ data: true, error: null }) };
    (h.caller.tables.projects as Row[])[0].linked_ticket_id = T;
    const forged = await projectLink(req({ ticketId: T, projectId: P1, converted: true }));
    expect(forged.status).toBe(403);
    expect(h.admin.writes).toEqual([]);
    // the requester, but the project was not created from this request
    seed();
    const notOrigin = await projectLink(req({ ticketId: T, projectId: P1, converted: true }));
    expect(notOrigin.status).toBe(400);
    expect(h.admin.writes).toEqual([]);
    expect(ticket().project_id).toBeNull();
    // management, on the project that names it
    seed();
    h.user = { id: "u-mgr", email: "mgr@plant.io" };
    (h.caller.tables.projects as Row[])[0].linked_ticket_id = T;
    const ok = await projectLink(req({ ticketId: T, projectId: P1, converted: true }));
    expect(ok.status).toBe(200);
    expect((ticket().history as Row[]).at(-1)).toMatchObject({ action: "Converted to Project" });
    expect(projectLinkAllowed({ isRequester: false, managesTickets: false, managesProject: true, converted: true })).toBe(false);
    expect(projectLinkAllowed({ isRequester: true, managesTickets: false, managesProject: false, converted: true })).toBe(true);
  });
  it("fix pass (minor 7): the link's history line names its audit row (`attempt`) and the row says so (`historyAttempt`) — the SM-7 drain reconciles a link exactly as a transition", async () => {
    expect((await projectLink(req({ ticketId: T, projectId: P1 }))).status).toBe(200);
    const row = audits()[0];
    expect(row.details).toMatchObject({ historyAttempt: true, recordedBeforeApply: true });
    expect((ticket().history as Row[]).at(-1)).toMatchObject({ action: "Linked to project", attempt: row.id });
    expect(historyNamesAttempt(ticket().history, String(row.id))).toBe(true);
  });
  it("an unreadable capability policy refuses a non-requester (503 — DEC-89 item 3, fail closed), nothing written", async () => {
    h.user = { id: "u-mgr", email: "mgr@plant.io" };
    h.policy = { ok: false, error: "timeout" };
    expect((await projectLink(req({ ticketId: T, projectId: P1 }))).status).toBe(503);
    expect(h.admin.writes).toEqual([]);
  });
  it("a project the caller cannot see is 'not found' (never revealed); a closed one is refused; another workspace's is refused — nothing written", async () => {
    h.caller.tables.projects = [{ id: P2, org_id: ORG, name: "Old job", status: "completed" }, { id: P1, org_id: "o-2", name: "X", status: "active" }];
    expect((await projectLink(req({ ticketId: T, projectId: "44444444-4444-4444-8444-444444444444" }))).status).toBe(404);
    expect((await projectLink(req({ ticketId: T, projectId: P2 }))).status).toBe(409);
    expect((await projectLink(req({ ticketId: T, projectId: P1 }))).status).toBe(400);
    expect(h.admin.writes).toEqual([]);
  });
  it("fix pass 4 (review, minor): an unlink or a move off a project the CALLER cannot see writes no service-role feed row into it (project_activity_insert's project_visible_to_me would refuse the caller's own); the origin pointer naming this request is still cleared; nothing about that project is said to the caller", async () => {
    seed({ project_id: P1 });
    (h.admin.tables.projects as Row[])[0].linked_ticket_id = T;
    h.caller.tables.projects = [{ id: P2, org_id: ORG, name: "Old job", status: "active", linked_ticket_id: null }]; // P1 is private to the caller
    const res = await projectLink(req({ ticketId: T, projectId: null }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toBeUndefined();
    expect(ticket().project_id).toBeNull();
    expect(activity()).toEqual([]);
    expect((h.admin.tables.projects as Row[])[0].linked_ticket_id).toBeNull();
    expect(h.caller.calls.some((c) => c.table === "projects")).toBe(true); // visibility asked AS THE CALLER
    // a move: the target the caller sees gets its row; the private previous project gets none
    seed({ project_id: P1 });
    h.caller.tables.projects = [{ id: P2, org_id: ORG, name: "Old job", status: "active", linked_ticket_id: null }];
    expect((await projectLink(req({ ticketId: T, projectId: P2 }))).status).toBe(200);
    expect(activity()).toEqual([expect.objectContaining({ project_id: P2, type: "request_linked" })]);
    // a visibility read that fails is never a yes
    seed({ project_id: P1 });
    h.caller.readError = { projects: { code: "57014", message: "timeout" } };
    expect((await projectLink(req({ ticketId: T, projectId: null }))).status).toBe(200);
    expect(activity()).toEqual([]);
  });
  it("unlink: the reference is removed, the request and its documents untouched; the old project's feed is told; PROJ-13 — a project created from this request stops naming it", async () => {
    seed({ project_id: P1 });
    (h.admin.tables.projects as Row[])[0].linked_ticket_id = T;
    (h.admin.tables.projects as Row[])[1].linked_ticket_id = T; // another project naming it is not touched
    const res = await projectLink(req({ ticketId: T, projectId: null }));
    expect(res.status).toBe(200);
    expect(ticket().project_id).toBeNull();
    expect((ticket().metadata as Row).project_link).toMatchObject({ projectId: null });
    expect((ticket().history as Row[]).at(-1)).toMatchObject({ action: "Unlinked from project" });
    expect(activity()).toEqual([expect.objectContaining({ project_id: P1, type: "request_unlinked" })]);
    expect(h.admin.writes.filter((w) => w.table === "project_documents")).toEqual([]);
    expect((h.admin.tables.projects as Row[])[0].linked_ticket_id).toBeNull();
    expect((h.admin.tables.projects as Row[])[1].linked_ticket_id).toBe(T);
  });
  it("the register helper writes a REFERENCE (doc_added) — never a copy; it writes as the client it is given, so the routes decide authority first (below)", async () => {
    seed({ metadata: { deliverable: { state: "published", version_id: "v-1", revision_label: "2", document_id: "d-1" } } });
    const upserts: Row[] = [];
    const sb = h.admin as MemoryState;
    sb.afterWrite = undefined;
    const r = await referenceDeliverableInProject({
      from: (t: string) => ({
        upsert: (row: Row, opts: Row) => { upserts.push({ t, row, opts }); return { select: async () => ({ data: [{ id: "pd-1" }], error: null }) }; },
        insert: async (row: Row) => { upserts.push({ t, row }); return { error: null }; },
      }),
    }, { orgId: ORG, projectId: P1, documentId: "d-1", ticketId: T, ticketNumber: "KE-26-0042", revisionLabel: "2", actorId: "u-req", actorName: "req@plant.io", actorMayStampDocAdded: true });
    expect(r).toBeNull();
    expect(upserts[0]).toMatchObject({ t: "project_documents", row: { project_id: P1, document_id: "d-1", source: "manual" }, opts: { onConflict: "project_id,document_id", ignoreDuplicates: true } });
    expect(upserts[1]).toMatchObject({ t: "project_activity", row: { type: "doc_added", metadata: expect.objectContaining({ documentId: "d-1", ticketId: T }) } });
  });
  it("fix pass 3 (review, minor): the feed row is doc_added only for an actor project_activity_insert admits for doc_added (controller / owner); a manager who is not the owner gets a request_deliverable_referenced row — the register reference itself is unchanged", async () => {
    const upserts: Row[] = [];
    const sb = {
      from: (t: string) => ({
        upsert: (row: Row, opts: Row) => { upserts.push({ t, row, opts }); return { select: async () => ({ data: [{ id: "pd-1" }], error: null }) }; },
        insert: async (row: Row) => { upserts.push({ t, row }); return { error: null }; },
      }),
    };
    const r = await referenceDeliverableInProject(sb, { orgId: ORG, projectId: P1, documentId: "d-1", ticketId: T, ticketNumber: "KE-26-0042", revisionLabel: "2", actorId: "u-pm", actorName: "pm@plant.io", actorMayStampDocAdded: false });
    expect(r).toBeNull();
    expect(upserts[0]).toMatchObject({ t: "project_documents", row: { project_id: P1, document_id: "d-1" } });
    expect(upserts[1]).toMatchObject({ t: "project_activity", row: { type: REQUEST_DELIVERABLE_REFERENCED, user_id: "u-pm", metadata: expect.objectContaining({ documentId: "d-1", ticketId: T }) } });
    expect(REQUEST_DELIVERABLE_REFERENCED).toBe("request_deliverable_referenced");
    // the feed's own doc_added rule, asked AS THE CALLER; unanswerable is a no
    const asked = (ans: Record<string, { data: unknown; error: unknown }>) => ({ rpc: async (fn: string) => ans[fn] ?? { data: null, error: { message: "missing" } } });
    expect(await callerMayStampDocAdded(asked({ is_org_controller: { data: true, error: null } }), ORG, P1)).toBe(true);
    expect(await callerMayStampDocAdded(asked({ is_org_controller: { data: false, error: null }, is_project_owner: { data: true, error: null } }), ORG, P1)).toBe(true);
    expect(await callerMayStampDocAdded(asked({ is_org_controller: { data: false, error: null }, is_project_owner: { data: false, error: null }, can_manage_project: { data: true, error: null } }), ORG, P1)).toBe(false);
    expect(await callerMayStampDocAdded(asked({}), ORG, P1)).toBe(false);
  });
  const PUBLISHED = { deliverable: { state: "published", version_id: "v-1", revision_label: "2", document_id: "d-1" } };
  // every project_documents call the service role made (the stand-in does not
  // apply an upsert; the helper's own test above pins what it writes)
  const registerWrites = () => h.admin.calls.filter((c) => c.table === "project_documents" && c.method === "upsert");
  it("REGRESSION (fix pass 2, PM-8 / SEC-17): a requester who can SEE a project but does not manage it links their request with a published deliverable — the link lands, but NO project_documents row and NO doc_added row are written; the answer says a project manager can attach it", async () => {
    seed({ metadata: PUBLISHED });
    h.caller.rpc = { is_org_controller: () => ({ data: false, error: null }), can_manage_project: () => ({ data: false, error: null }) };
    const res = await projectLink(req({ ticketId: T, projectId: P1 }));
    expect(res.status).toBe(200);
    expect((await res.json()).warning).toMatch(/only the project's managers \(or Admin \/ Document Control\) add documents to it — a project manager can attach it from the project's Documents card/);
    expect(ticket().project_id).toBe(P1);
    expect(registerWrites()).toEqual([]);
    expect(h.admin.calls.filter((c) => c.table === "project_documents")).toEqual([]);
    expect(activity().map((a) => a.type)).toEqual(["request_linked"]);
    expect((ticket().metadata as Row).project_link).toMatchObject({ projectId: P1, authority: "requester", registerAuthority: false });
    expect(audits()[0].details).toMatchObject({ authority: "requester", registerAuthority: false });
    // asked AS THE CALLER, through the policy's own functions
    expect(h.caller.calls.filter((c) => c.method === "rpc").map((c) => c.table)).toEqual(["rpc:is_org_controller", "rpc:can_manage_project"]);
  });
  it("fix pass 2: the same requester who DOES manage the project (or a controller) gets the register reference and its doc_added row; an unanswerable check is never a yes", async () => {
    seed({ metadata: PUBLISHED });
    h.caller.rpc = { is_org_controller: () => ({ data: false, error: null }), can_manage_project: (a) => ({ data: a.p_project === P1, error: null }) };
    expect((await projectLink(req({ ticketId: T, projectId: P1 }))).status).toBe(200);
    expect(registerWrites()).toHaveLength(1);
    expect(registerWrites()[0].args[0]).toMatchObject({ project_id: P1, document_id: "d-1", source: "manual" });
    expect((ticket().metadata as Row).project_link).toMatchObject({ registerAuthority: true });
    // fix pass 3: whether the feed row may be doc_added is asked AS THE CALLER (the feed's controller / owner rule)
    expect(h.caller.calls.filter((c) => c.method === "rpc").map((c) => c.table)).toEqual(expect.arrayContaining(["rpc:is_project_owner"]));
    seed({ metadata: PUBLISHED });
    h.caller.rpc = { is_org_controller: () => ({ data: true, error: null }) };
    expect((await projectLink(req({ ticketId: T, projectId: P1 }))).status).toBe(200);
    expect(registerWrites()).toHaveLength(1);
    seed({ metadata: PUBLISHED });
    h.caller.rpc = { is_org_controller: () => ({ data: null, error: { message: "timeout" } }), can_manage_project: () => ({ data: false, error: null }) };
    const unsure = await projectLink(req({ ticketId: T, projectId: P1 }));
    expect((await unsure.json()).warning).toMatch(/could not be confirmed/);
    expect(registerWrites()).toEqual([]);
    expect((ticket().metadata as Row).project_link).toMatchObject({ registerAuthority: false });
  });
  it("callerHoldsRegisterAuthority / recordedRegisterAuthority (pure-ish): yes only on a yes; a recorded authority counts only for the project it was recorded for", async () => {
    const asked = (ans: Record<string, { data: unknown; error: unknown }>) => ({ rpc: async (fn: string) => ans[fn] ?? { data: null, error: { message: "missing" } } });
    expect(await callerHoldsRegisterAuthority(asked({ is_org_controller: { data: false, error: null }, can_manage_project: { data: true, error: null } }), ORG, P1)).toBe(true);
    expect(await callerHoldsRegisterAuthority(asked({ is_org_controller: { data: false, error: null }, can_manage_project: { data: false, error: null } }), ORG, P1)).toBe(false);
    expect(await callerHoldsRegisterAuthority(asked({ is_org_controller: { data: false, error: null } }), ORG, P1)).toBeNull();
    expect(recordedRegisterAuthority({ project_link: { projectId: P1, registerAuthority: true } }, P1)).toBe(true);
    expect(recordedRegisterAuthority({ project_link: { projectId: P1, registerAuthority: true } }, P2)).toBe(false);
    expect(recordedRegisterAuthority({ project_link: { projectId: P1, registerAuthority: false } }, P1)).toBe(false);
    expect(recordedRegisterAuthority({ project_link: { projectId: P1 } }, P1)).toBe(false);
    expect(recordedRegisterAuthority(null, P1)).toBe(false);
  });
  it("fix pass 2 (minor 3): the history line names NO project — not the target's name on a link, never a name on an unlink (which is no longer read at all) — and carries the project's id", async () => {
    expect((await projectLink(req({ ticketId: T, projectId: P1 }))).status).toBe(200);
    const linked = (ticket().history as Row[]).at(-1)!;
    expect(JSON.stringify(linked)).not.toContain("Turnaround");
    expect(linked).toMatchObject({ action: "Linked to project", projectId: P1, details: "This request now belongs to a project (a reference — no file is copied)." });
    seed({ project_id: P2 });
    h.admin.tables.projects = [{ id: P2, org_id: ORG, name: "Private capital job" }];
    expect((await projectLink(req({ ticketId: T, projectId: null }))).status).toBe(200);
    const unlinked = (ticket().history as Row[]).at(-1)!;
    expect(JSON.stringify(unlinked)).not.toContain("Private capital job");
    expect(unlinked).toMatchObject({ action: "Unlinked from project", projectId: P2 });
    // the service role never read the old project's name
    expect(h.admin.calls.filter((c) => c.table === "projects" && c.method === "select" && JSON.stringify(c.args).includes("name"))).toEqual([]);
  });
  it("before 20261256: the ticket read answers 42703 naming project_id — 503 not_migrated, nothing written (today's path: the request has no project)", async () => {
    h.admin.readError.tickets = { code: "42703", message: 'column tickets.project_id does not exist' };
    const res = await projectLink(req({ ticketId: T, projectId: P1 }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("not_migrated");
    expect(h.admin.writes).toEqual([]);
  });
  it("an audit row that cannot be written refuses the change (500), the ticket untouched; a lost compare-and-set is a 409 with the attempt's _NOT_APPLIED row", async () => {
    h.admin.tableWriteError = { audit_logs: { message: "down" } };
    expect((await projectLink(req({ ticketId: T, projectId: P1 }))).status).toBe(500);
    expect(ticket().project_id).toBeNull();
    seed();
    h.admin.refuse = ["tickets"]; // the compare-and-set matches no row — somebody moved the request
    const res = await projectLink(req({ ticketId: T, projectId: P1 }));
    expect(res.status).toBe(409);
    expect(audits().map((a) => a.action)).toEqual(["TICKET_PROJECT_LINKED", "TICKET_PROJECT_LINKED_NOT_APPLIED"]);
    expect(ticket().project_id).toBeNull();
  });
  it("already linked to that project: no write at all; an archived request is refused", async () => {
    seed({ project_id: P1 });
    const same = await projectLink(req({ ticketId: T, projectId: P1 }));
    expect(await same.json()).toMatchObject({ ok: true, unchanged: true });
    expect(h.admin.writes).toEqual([]);
    seed({ archived_at: LM });
    expect((await projectLink(req({ ticketId: T, projectId: P1 }))).status).toBe(409);
  });
});

describe("fix pass 2 (PM-8 / SEC-17) — /api/tickets/handback puts the deliverable on the project register only with the register's authority", () => {
  const D = "dddddddd-0000-4000-8000-000000000001";
  const V = "eeeeeeee-0000-4000-8000-000000000001";
  const hbReq = () => new NextRequest("https://app.plant.io/api/tickets/handback", {
    method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ ticketId: T, versionId: V }),
  });
  const seedHb = (projectLink?: Row) => {
    seed({
      status: "FINAL_DRAFT", project_id: P1, assigned_drafter_id: "u-other",
      metadata: { source_document: { id: D, document_number: "P-101" }, ...(projectLink ? { project_link: projectLink } : {}) },
    });
    h.admin.tables.document_versions = [{ id: V, org_id: ORG, record_id: D, revision_label: "2", related_ticket_id: T, review_state: null, created_by: "u-other" }];
    h.user = { id: "u-other", email: "other@plant.io" }; // the drafter: neither a controller nor the project's manager
    h.caller.rpc = { is_org_controller: () => ({ data: false, error: null }), can_manage_project: () => ({ data: false, error: null }) };
  };
  const registerCalls = () => h.admin.calls.filter((c) => c.table === "project_documents" && c.method !== "select");
  it("REGRESSION: a request a requester filed 'into' a project they only SEE (registerAuthority false), handed back by a drafter who does not manage it — recorded, but NO register row and NO doc_added; the answer says a project manager can attach it", async () => {
    seedHb({ projectId: P1, registerAuthority: false, authority: "portal" });
    const res = await handback(hbReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warning).toMatch(/a project manager can attach it from the project's Documents card/);
    expect(registerCalls()).toEqual([]);
    expect(activity().filter((a) => a.type === "doc_added")).toEqual([]);
    expect(((ticket().metadata as Row).deliverable as Row).state).toBe("published"); // the hand-back itself stands
  });
  it("the link was made with the register's authority (recorded, for THIS project) — the reference is written whoever publishes; a link recorded for another project does not count", async () => {
    seedHb({ projectId: P1, registerAuthority: true, authority: "project_manager" });
    expect((await handback(hbReq())).status).toBe(200);
    expect(registerCalls().map((c) => c.method)).toEqual(["upsert"]);
    expect(registerCalls()[0].args[0]).toMatchObject({ project_id: P1, document_id: D, source: "manual" });
    // fix pass 3: the publisher's doc_added standing is asked AS THE CALLER
    expect(h.caller.calls.filter((c) => c.method === "rpc").map((c) => c.table)).toEqual(expect.arrayContaining(["rpc:is_org_controller", "rpc:is_project_owner"]));
    seedHb({ projectId: P2, registerAuthority: true });
    const other = await handback(hbReq());
    expect((await other.json()).warning).toMatch(/only the project's managers/);
    expect(registerCalls()).toEqual([]);
  });
  it("no recorded authority (a link made before this pass, the paste's backfill): the publisher's own authority decides, asked AS THE CALLER; unanswerable is never a yes", async () => {
    seedHb();
    h.caller.rpc = { is_org_controller: () => ({ data: false, error: null }), can_manage_project: (a) => ({ data: a.p_project === P1, error: null }) };
    expect((await handback(hbReq())).status).toBe(200);
    expect(registerCalls().map((c) => c.method)).toEqual(["upsert"]);
    seedHb();
    h.caller.rpc = { is_org_controller: () => ({ data: null, error: { message: "timeout" } }), can_manage_project: () => ({ data: null, error: { message: "timeout" } }) };
    const unsure = await handback(hbReq());
    expect((await unsure.json()).warning).toMatch(/could not be confirmed/);
    expect(registerCalls()).toEqual([]);
  });
});

describe("pure helpers", () => {
  it("fix pass 3 (review, minor): requestHolderLabel — who an open request waits on follows its status and names the role (the engineer in review / sign-off, never the drafter); the card reads the engineer's name too", () => {
    const names = { drafter: "Dana", engineer: "Eli", requester: "Rita" };
    expect(requestHolderLabel("PENDING_FINAL_APPROVAL", names)).toBe("Engineer: Eli");
    expect(requestHolderLabel("PENDING_ENG_TEAM", names)).toBe("Engineer: Eli");
    // fix pass 4 (review, major): PENDING_REVIEW waits on the REQUESTER's review (lib/ticketSla.ts
    // waitingParty; lib/workflow.ts WF-24), never the engineer
    expect(requestHolderLabel("PENDING_REVIEW", names)).toBe("Awaiting review from: Rita");
    expect(requestHolderLabel("PENDING_REVIEW", { drafter: "Dana", engineer: "Eli" })).toBe("Awaiting the requester's review");
    expect(requestHolderLabel("PENDING_REVIEW", names, {})).toBe("Awaiting review from: Rita");
    expect(requestHolderLabel("DRAFTING", names)).toBe("Drafter: Dana");
    expect(requestHolderLabel("REVISION_REQ", names)).toBe("Drafter: Dana");
    expect(requestHolderLabel("PENDING_IFC", names)).toBe("Drafter: Dana");
    expect(requestHolderLabel("FINAL_DRAFT", names)).toBe("Awaiting acknowledgement from: Rita");
    expect(requestHolderLabel("PENDING_ASSIGNMENT", names)).toMatch(/drafting queue/);
    expect(requestHolderLabel("PENDING_FINAL_APPROVAL", { drafter: "Dana" })).toBe("Awaiting an engineer");
    expect(requestHolderLabel("DRAFTING", { engineer: "Eli" })).toBe("No drafter assigned");
    expect(requestHolderLabel("CLOSED", names)).toBeNull();
    expect(requestHolderLabel("CANCELED", names)).toBeNull();
    // every live status this build knows has a line
    for (const st of MATRIX_STATUSES.filter((x) => x !== "CLOSED" && x !== "CANCELED")) expect(requestHolderLabel(st, names)).not.toBeNull();
    const card = src("components/projects/ProjectRequestsCard.tsx");
    expect(card).toContain("assigned_engineer_name");
    expect(card).toContain("requestHolderLabel(status,");
    expect(card).not.toMatch(/>with \{r\.holder\}/);
  });
  it("fix pass 4 (review, major): a ROUTED review (a current metadata.review_roster) waits on its open blocking slots — never one person; a notify-only or satisfied slot never waits; a closed roster, or a roster outside PENDING_REVIEW, is not current", () => {
    const names = { drafter: "Dana", engineer: "Eli", requester: "Rita" };
    const slot = (over: Row) => ({ id: "s", kind: "quality", label: "QA", mode: "blocking", status: "open", primaries: ["u-qa"], alternates: [], ...over });
    const roster = (slots: Row[], over: Row = {}) => ({ review_roster: { v: 1, openedAt: LM, slots, ...over } });
    const meta = roster([
      slot({ id: "a", label: "QA" }),
      slot({ id: "b", kind: "engineering", label: "Engineering" }),
      slot({ id: "c", label: "Ops", mode: "notify_only" }),
      slot({ id: "d", label: "Safety", status: "satisfied" }),
      slot({ id: "e", kind: "process", label: "" }),
    ]);
    expect(requestHolderLabel("PENDING_REVIEW", names, meta)).toBe("Awaiting routed review: QA, Engineering, process");
    // every blocking slot satisfied (the issue is in flight): the roster, never the requester or the engineer
    expect(requestHolderLabel("PENDING_REVIEW", names, roster([slot({ status: "satisfied" })]))).toBe("Reviewers (routed review)");
    // a closed roster is not current — the requester's review again
    expect(requestHolderLabel("PENDING_REVIEW", names, roster([slot({})], { closedAt: LM }))).toBe("Awaiting review from: Rita");
    // a roster read outside PENDING_REVIEW is ignored (currentRoster)
    expect(requestHolderLabel("PENDING_FINAL_APPROVAL", names, meta)).toBe("Engineer: Eli");
    // the card hands the row's metadata over
    expect(src("components/projects/ProjectRequestsCard.tsx")).toContain("}, (t.metadata as Record<string, unknown> | null) ?? null),");
  });
  it("projectRefOf: the column first; before the paste (undefined) the intake collision's project as today; a recorded unlink means none", () => {
    expect(projectRefOf({ intake_collision: { projectId: P2 } }, P1)).toBe(P1);
    expect(projectRefOf({ intake_collision: { projectId: P2 } }, undefined)).toBe(P2);
    expect(projectRefOf({ intake_collision: { projectId: P2 } }, null)).toBe(P2);
    expect(projectRefOf({ intake_collision: { projectId: P2 }, project_link: { projectId: null } }, null)).toBeNull();
    expect(projectRefOf(undefined)).toBeNull();
  });
  it("isMissingProjectColumn / projectLinkAllowed / the history line", () => {
    expect(isMissingProjectColumn({ code: "42703", message: 'column "project_id" does not exist' })).toBe(true);
    // fix pass (minor 5): an answer naming no column is never read as project_id's
    expect(isMissingProjectColumn({ code: "PGRST204", message: "" })).toBe(false);
    expect(isMissingProjectColumn({ code: "42703", message: null })).toBe(false);
    expect(isMissingProjectColumn({ code: "PGRST204", message: "Could not find the 'project_id' column of 'tickets' in the schema cache" })).toBe(true);
    expect(isMissingProjectColumn({ code: "42703", message: 'column "library_id" does not exist' })).toBe(false);
    expect(isMissingProjectColumn({ code: "23514", message: "project_id" })).toBe(false);
    expect(projectLinkAllowed({ isRequester: false, managesTickets: false, managesProject: false })).toBe(false);
    expect(projectLinkAllowed({ isRequester: false, managesTickets: false, managesProject: true })).toBe(true);
    expect(projectLinkHistoryEntry({ kind: "unlinked", projectId: P1, email: "a@b", role: "Viewer", now: LM })).toMatchObject({ action: "Unlinked from project", user: "a@b", date: LM, projectId: P1 });
  });
  it("GAP-114 acceptance 2 / 4: a deliverable reads as a LIVE reference — current, superseded (a later version in force), not current (status / archived); unreadable → exists, cannot be opened", () => {
    const st = { state: "published", document_id: "d-1", version_id: "v-1", revision_label: "1" };
    const doc = { id: "d-1", document_number: "P-101", rev: "1", status: "Issued", library_id: "l-1", current_version_id: "v-1", archived_at: null };
    expect(deliverableReference(st, doc, NOT_CURRENT_STATUSES)).toMatchObject({ kind: "published", canOpen: true, current: true, label: "P-101 Rev 1" });
    expect(deliverableReference(st, { ...doc, current_version_id: "v-2", rev: "2" }, NOT_CURRENT_STATUSES)).toMatchObject({ current: false, note: expect.stringMatching(/Superseded — the register is now at Rev 2/) });
    expect(deliverableReference(st, { ...doc, status: "Superseded" }, NOT_CURRENT_STATUSES)).toMatchObject({ current: false, note: expect.stringMatching(/Not current/) });
    expect(deliverableReference(st, null, NOT_CURRENT_STATUSES)).toMatchObject({ kind: "published", canOpen: false, label: "Rev 1 was published" });
    expect(deliverableReference({ state: "not_in_register" }, null, NOT_CURRENT_STATUSES)).toEqual({ kind: "not_in_register" });
    expect(deliverableReference(null, null, NOT_CURRENT_STATUSES)).toEqual({ kind: "none" });
  });
  it("DCW-4 remainder: the library-less not-in-register shape is written and read back; a published deliverable is never overwritten", () => {
    const m = noteDeliverableNotInAnyRegister({ x: 1 }, { now: LM })!;
    expect(m).toMatchObject({ x: 1, deliverable: { state: "not_in_register", document_id: null, library_id: null, register_rev: null, noted_at: LM } });
    expect(deliverableStateOf(m)).toMatchObject({ state: "not_in_register", library_id: null });
    expect(noteDeliverableNotInAnyRegister({ deliverable: { state: "published", version_id: "v" } })).toBeNull();
  });
  it("PROJ-6: the closeout gates gain an 'open drafting requests' WARNING line; before 20261256 (absent) no line — today's dialog; a failed read is unknown, never clear", () => {
    const base = { punchOpen: 0, turnoverRequired: 0, turnoverAccepted: 0, checklistOpenItems: 0, checklistNeedsEvidence: 0, openChangeOrders: 0 } as unknown as ProjectStateSnapshot;
    expect(closeoutGateLines(base).some((g) => g.key === "draftingRequests")).toBe(false);
    expect(closeoutGateLines({ ...base, openDraftingRequests: 2 }).find((g) => g.key === "draftingRequests")).toEqual({ key: "draftingRequests", ok: false, text: "2 drafting requests still open", openCount: 2 });
    expect(closeoutGateLines({ ...base, openDraftingRequests: 0 }).find((g) => g.key === "draftingRequests")?.ok).toBe(true);
    expect(closeoutGateLines({ ...base, openDraftingRequests: null }).find((g) => g.key === "draftingRequests")?.ok).toBeNull();
  });
  it("PROJ-6 fix pass (minor 3): a count of only the requests the completer can read is never 'clear' — none visible is unknown (ok null), some visible is 'at least' — so the recorded gates never claim nothing was open", () => {
    const base = { punchOpen: 0, turnoverRequired: 0, turnoverAccepted: 0, checklistOpenItems: 0, checklistNeedsEvidence: 0, openChangeOrders: 0 } as unknown as ProjectStateSnapshot;
    expect(closeoutGateLines({ ...base, openDraftingRequests: 0, openDraftingRequestsVisibleOnly: true }).find((g) => g.key === "draftingRequests"))
      .toEqual({ key: "draftingRequests", ok: null, text: "Drafting requests — only those visible to you counted (none of them open)", openCount: null });
    expect(closeoutGateLines({ ...base, openDraftingRequests: 2, openDraftingRequestsVisibleOnly: true }).find((g) => g.key === "draftingRequests"))
      .toEqual({ key: "draftingRequests", ok: false, text: "At least 2 drafting requests still open — only those visible to you counted", openCount: null });
  });
  it("SM-4: a reopen clears the archive's claim (archive_id) in the same update; REGRESSION: no claim → the updates carry no archive_id; a terminal transition never clears one", () => {
    const actor = { uid: "u-req", email: "req@plant.io", role: "Viewer" };
    const row = { id: T, org_id: ORG, ticket_id: "KE", title: "t", request_type: "Revision", status: "CLOSED", requester_id: "u-req", history: [], attachments: [], comments: [], archive_id: "arch-1", archived_at: null, last_modified: LM, revision_count: 1 };
    const input = { actionType: "reopen_ticket", actionLabel: "Reopen Ticket", actor, comment: "again" } as unknown as Parameters<typeof computeTransition>[1];
    expect(computeTransition(rowToTicket(row), input).updates.archive_id).toBeNull();
    expect("archive_id" in computeTransition(rowToTicket({ ...row, archive_id: null }), input).updates).toBe(false);
    const cancel = { actionType: "cancel_request", actionLabel: "Cancel Request", actor, comment: "dup", outcome: "duplicate" } as unknown as Parameters<typeof computeTransition>[1];
    expect("archive_id" in computeTransition(rowToTicket({ ...row, status: "DRAFTING", archive_id: null }), cancel).updates).toBe(false);
  });
  it("DEC-90 ruling (1) pin (fix pass, minor 4): a request with NO project behaves exactly as at db3a1f3 — every status × role × identity × offered action, computeTransition's { newStatus, updates } digest equals the base commit's; no update ever writes project_id or archive_id", () => {
    const base = JSON.parse(src("lib/__tests__/fixtures/dfP8NoProjectBaseline.json")) as { base: string; count: number; keys: string[]; digests: Record<string, string> };
    expect(base.base).toBe("db3a1f3");
    const now = noProjectMatrix();
    expect(Object.keys(now.digests).length).toBe(base.count);
    expect(base.count).toBeGreaterThan(1000); // every status is walked, not a sample
    expect(new Set(Object.keys(now.digests).map((k) => k.split("|")[0]))).toEqual(new Set(MATRIX_STATUSES.filter((st) => st !== "CANCELED")));
    const drift = Object.keys({ ...base.digests, ...now.digests }).filter((k) => base.digests[k] !== now.digests[k]);
    expect(drift).toEqual([]);
    expect(now.keys).toEqual(base.keys);
    expect(now.keys).not.toContain("project_id");
    expect(now.keys).not.toContain("archive_id");
    // not vacuous: a row the archive DOES claim is written differently on its reopen (SM-4)
    const claimed = computeTransition(rowToTicket({ ...noProjectRow("CLOSED"), archive_id: "arch-1" }), {
      actionType: "reopen_ticket", actionLabel: "Reopen Ticket", comment: "again", actor: { uid: "req", email: "req@x.io", role: "Viewer" }, now: MATRIX_NOW,
    } as unknown as Parameters<typeof computeTransition>[1]);
    expect(claimed.updates.archive_id).toBeNull();
  });
  it("rowToTicket maps project_id only when the column is in the row (undefined before the paste)", () => {
    const base = { id: T, org_id: ORG, status: "DRAFTING" };
    expect(rowToTicket(base).projectId).toBeUndefined();
    expect(rowToTicket({ ...base, project_id: null }).projectId).toBeNull();
    expect(rowToTicket({ ...base, project_id: P1 }).projectId).toBe(P1);
  });
});

describe("SM-7 / EVID-12 (DEC-90 ruling (6)): the drain for what the workflow route only logs", () => {
  const NOW = Date.parse("2026-10-21T12:00:00Z");
  const C1 = "c0000000-0000-4000-8000-000000000001";
  const C2 = "c0000000-0000-4000-8000-000000000002";
  const MENTION = "99999999-9999-4999-8999-999999999999";
  const cid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const OLD = "2026-10-21T10:00:00.000Z"; // past the settle time
  const drainDb = () => {
    const s = freshState();
    return { s, client: makeSupabase(s) as unknown as Parameters<typeof runTicketAuditDrain>[0]["client"] };
  };
  it("pure: the mirror row is the route's shape; history proves an attempt landed only by its id", () => {
    expect(mirrorRowFor({ id: T, org_id: ORG }, { id: C1, user: "a@b", role: "Engineer", text: "fix", type: "Revision", date: OLD, authorUid: "u-1" }))
      .toEqual({ id: C1, org_id: ORG, ticket_id: T, author_uid: "u-1", author_email: "a@b", author_role: "Engineer", body: "fix", type: "Revision", category: null, mentioned_uids: [], created_at: OLD });
    expect(mirrorRowFor({ id: T, org_id: ORG }, { text: "no id" })).toBeNull();
    // fix pass 2: a non-UUID id or an unparseable date is never mirrored; mentions (UUIDs only) carry over
    expect(mirrorRowFor({ id: T, org_id: ORG }, { id: "c-1", text: "legacy", date: OLD })).toBeNull();
    expect(mirrorRowFor({ id: T, org_id: ORG }, { id: C1, text: "legacy", date: "yesterday-ish" })).toBeNull();
    expect(mirrorRowFor({ id: T, org_id: ORG }, { id: C1, text: "@c", date: OLD, mentionedUserIds: [MENTION, "not-a-uid", MENTION, 7] })?.mentioned_uids).toEqual([MENTION]);
    expect(historyNamesAttempt([{ action: "x", attempt: "a-1" }], "a-1")).toBe(true);
    expect(historyNamesAttempt([{ action: "x" }], "a-1")).toBe(false);
  });
  it("(a) a JSONB comment with no ticket_comments row is mirrored; one already there (even soft-deleted) is never touched", async () => {
    const { s, client } = drainDb();
    s.tables.tickets = [{ id: T, org_id: ORG, last_modified: OLD, archived_at: null, comments: [
      { id: C1, user: "a@b", text: "lost mirror", date: OLD }, { id: C2, user: "a@b", text: "mirrored", date: OLD },
    ] }];
    s.tables.ticket_comments = [{ id: C2, ticket_id: T, deleted_at: OLD }];
    s.tables.audit_logs = [];
    const r = await runTicketAuditDrain({ client, deadlineAt: Date.now() + 10_000, now: NOW });
    expect(r.mirrorsReconciled).toBe(1);
    expect(s.tables.ticket_comments.map((c) => c.id).sort()).toEqual([C1, C2]);
    expect(s.writes.filter((w) => w.table === "ticket_comments" && w.method !== "insert")).toEqual([]);
  });
  it("(b) an attempt whose ticket history names it LANDED (nothing written); one with no follow-up and no history line gets its _NOT_APPLIED row; one a follow-up names, an archived ticket's, and a pre-DF-P8 attempt are left alone", async () => {
    const { s, client } = drainDb();
    s.tables.tickets = [
      { id: "t-landed", history: [{ action: "Approve", attempt: "a-landed" }], archived_at: null, comments: [], last_modified: "2026-10-01T00:00:00Z" },
      { id: "t-lost", history: [{ action: "Created" }], archived_at: null, comments: [], last_modified: "2026-10-01T00:00:00Z" },
      { id: "t-arch", history: [], archived_at: OLD, comments: [], last_modified: "2026-10-01T00:00:00Z" },
    ];
    const attempt = (id: string, ticket: string, extra: Row = {}) => ({ id, action: "TICKET_APPROVE_DRAFT_IFC", resource_type: "ticket", resource_id: ticket, org_id: ORG, user_id: "u-1", user_email: "a@b", user_role: "Engineer", timestamp: OLD, details: { from: "PENDING_REVIEW", to: "PENDING_IFC", recordedBeforeApply: true, historyAttempt: true, ...extra },
      // the stand-in matches eq() on a column name, so PostgREST's JSON path is mirrored as one
      "details->>historyAttempt": "true" });
    s.tables.audit_logs = [
      attempt("a-landed", "t-landed"), attempt("a-lost", "t-lost"), attempt("a-arch", "t-arch"), attempt("a-named", "t-lost"),
      { id: "f-1", action: "TICKET_APPROVE_DRAFT_IFC_NOT_APPLIED", resource_type: "ticket", resource_id: "t-lost", timestamp: OLD, details: { attempt: "a-named" } },
      // written before DF-P8: no historyAttempt — the ticket cannot decide it, never selected
      { id: "a-pre", action: "TICKET_APPROVE_DRAFT_IFC", resource_type: "ticket", resource_id: "t-lost", org_id: ORG, timestamp: OLD, details: { from: "PENDING_REVIEW", to: "PENDING_IFC", recordedBeforeApply: true } },
    ];
    // the stand-in filters on eq / is / in only; the drain's other filters are PostgREST's
    const r = await runTicketAuditDrain({ client, deadlineAt: Date.now() + 10_000, now: NOW });
    expect(r.attemptsLanded).toBe(1);
    expect(r.undecidable).toBe(1);
    expect(r.notAppliedWritten).toBe(1);
    const written = s.writes.filter((w) => w.table === "audit_logs" && w.method === "insert").map((w) => w.payload as Row);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ action: "TICKET_APPROVE_DRAFT_IFC_NOT_APPLIED", resource_id: "t-lost", details: expect.objectContaining({ attempt: "a-lost", reason: "reconciled" }) });
    expect(r.errors).toEqual([]);
  });
  it("a read that fails writes nothing and says so (never a guess)", async () => {
    const { s, client } = drainDb();
    s.readError.tickets = { message: "timeout" };
    s.readError.audit_logs = { message: "timeout" };
    const r = await runTicketAuditDrain({ client, deadlineAt: Date.now() + 10_000, now: NOW });
    expect(s.writes).toEqual([]);
    expect(r.errors.join(" ")).toMatch(/could not be read/);
  });
  // A PostgREST stand-in that honours what the drain's paging relies on:
  // gte / lte / gt / eq (a JSON path as a column) / like / in / is, the
  // keyset or() the drain writes, order (several keys) and limit — and a
  // row cap of its own, as PostgREST's max-rows is.
  const pagingDb = (tables: Record<string, Row[]>, cap = 1000) => {
    // ticket_comments.id is uuid: PostgREST refuses a whole in() holding one
    // non-UUID value (22P02), as the real column does.
    const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const reads: Array<{ table: string; n: number }> = [];
    const likeRe = (pat: string) => new RegExp(`^${pat.replace(/\\_/g, "\u0000").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".").replace(/\u0000/g, "_")}$`);
    const val = (r: Row, k: string) => {
      const m = /^(\w+)->>(\w+)$/.exec(k);
      if (m) { const v = (r[m[1]] as Row | null)?.[m[2]]; return v === undefined || v === null ? null : String(v); }
      return r[k];
    };
    const client = {
      from: (table: string) => {
        const preds: Array<(r: Row) => boolean> = [];
        const orders: Array<[string, boolean]> = [];
        let limit = Infinity;
        let insert: Row | null = null;
        let castError: { code: string; message: string } | null = null;
        const q: Record<string, unknown> = {
          select: () => q,
          insert: (row: Row) => { insert = row; return q; },
          eq: (k: string, v: unknown) => { preds.push((r) => val(r, k) === v); return q; },
          is: (k: string, v: unknown) => { preds.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; },
          in: (k: string, vs: unknown[]) => {
            if (table === "ticket_comments" && k === "id" && vs.some((v) => !UUIDISH.test(String(v)))) castError = { code: "22P02", message: "invalid input syntax for type uuid" };
            preds.push((r) => vs.includes(r[k])); return q;
          },
          gte: (k: string, v: string) => { preds.push((r) => String(r[k]) >= v); return q; },
          lte: (k: string, v: string) => { preds.push((r) => String(r[k]) <= v); return q; },
          gt: (k: string, v: string) => { preds.push((r) => String(r[k]) > v); return q; },
          like: (k: string, pat: string) => { const re = likeRe(pat); preds.push((r) => re.test(String(r[k]))); return q; },
          or: (f: string) => {
            const m = /^(\w+)\.gt\."([^"]*)",and\(\1\.eq\."([^"]*)",id\.gt\."([^"]*)"\)$/.exec(f);
            if (!m) throw new Error(`unexpected or(): ${f}`);
            const [, col, at, at2, id] = m;
            preds.push((r) => String(r[col]) > at || (String(r[col]) === at2 && String(r.id) > id));
            return q;
          },
          order: (k: string, o?: { ascending?: boolean }) => { orders.push([k, o?.ascending !== false]); return q; },
          limit: (n: number) => { limit = n; return q; },
          then: (resolve: (v: unknown) => void) => {
            if (insert) { (tables[table] ??= []).push(insert); return resolve({ data: null, error: null }); }
            if (castError) return resolve({ data: null, error: castError });
            let rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
            rows = [...rows].sort((a, b) => {
              for (const [k, asc] of orders) { const x = String(a[k]); const y = String(b[k]); if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1); }
              return 0;
            }).slice(0, Math.min(limit, cap));
            reads.push({ table, n: rows.length });
            return resolve({ data: rows.map((r) => ({ ...r })), error: null });
          },
        };
        return q;
      },
    };
    return { client: client as unknown as Parameters<typeof runTicketAuditDrain>[0]["client"], reads };
  };
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const HOUR = 3_600_000;
  const pad = (n: number) => String(n).padStart(6, "0");
  it("fix pass (major 2): leg (b) keyset-pages the WHOLE window, oldest first — a lost attempt 6 days old behind 700 newer landed ones is reached and gets its _NOT_APPLIED; nothing is decided twice", async () => {
    const tickets: Row[] = [];
    const audit: Row[] = [];
    for (let i = 0; i < 700; i++) {
      const id = `a-${pad(i)}`;
      tickets.push({ id: `t-${pad(i)}`, history: [{ action: "Approve", attempt: id }], archived_at: null, comments: [], last_modified: iso(8 * 24 * HOUR) });
      audit.push({ id, action: "TICKET_APPROVE_DRAFT_IFC", resource_type: "ticket", resource_id: `t-${pad(i)}`, org_id: ORG, timestamp: iso(HOUR + i * 1000), details: { historyAttempt: true, from: "PENDING_REVIEW", to: "PENDING_IFC" } });
    }
    tickets.push({ id: "t-lost", history: [{ action: "Created" }], archived_at: null, comments: [], last_modified: iso(8 * 24 * HOUR) });
    audit.push({ id: "a-lost", action: "TICKET_REOPEN_TICKET", resource_type: "ticket", resource_id: "t-lost", org_id: ORG, timestamp: iso(6 * 24 * HOUR), details: { historyAttempt: true } });
    // outside the window / not yet settled: never read
    audit.push({ id: "a-old", action: "TICKET_REOPEN_TICKET", resource_type: "ticket", resource_id: "t-lost", org_id: ORG, timestamp: iso(8 * 24 * HOUR), details: { historyAttempt: true } });
    audit.push({ id: "a-new", action: "TICKET_REOPEN_TICKET", resource_type: "ticket", resource_id: "t-lost", org_id: ORG, timestamp: iso(60_000), details: { historyAttempt: true } });
    const tables = { tickets, audit_logs: audit };
    const { client } = pagingDb(tables);
    const r = await runTicketAuditDrain({ client, deadlineAt: Date.now() + 10_000, now: NOW });
    expect(r.attemptsRead).toBe(701);
    expect(r.attemptsLanded).toBe(700);
    expect(r.notAppliedWritten).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.errors).toEqual([]);
    const written = audit.filter((a) => String(a.action).endsWith("_NOT_APPLIED"));
    expect(written).toEqual([expect.objectContaining({ action: "TICKET_REOPEN_TICKET_NOT_APPLIED", resource_id: "t-lost", details: expect.objectContaining({ attempt: "a-lost", reason: "reconciled" }) })]);
    // a second run: the follow-up now names it — never written twice
    const again = await runTicketAuditDrain({ client: pagingDb(tables).client, deadlineAt: Date.now() + 10_000, now: NOW });
    expect(again.notAppliedWritten).toBe(0);
    expect(audit.filter((a) => String(a.action).endsWith("_NOT_APPLIED"))).toHaveLength(1);
  });
  it("fix pass (major 2): the follow-up read is keyset-paged — past the row cap, a follow-up that names an attempt is still seen (no duplicate _NOT_APPLIED)", async () => {
    const audit: Row[] = [{ id: "a-1", action: "TICKET_REOPEN_TICKET", resource_type: "ticket", resource_id: "t-1", org_id: ORG, timestamp: iso(2 * HOUR), details: { historyAttempt: true } }];
    for (let i = 0; i < 1500; i++) audit.push({ id: `f-${pad(i)}`, action: "TICKET_X_NOT_APPLIED", resource_type: "ticket", resource_id: "t-1", timestamp: iso(HOUR), details: { attempt: `other-${i}` } });
    audit.push({ id: "f-zzzzzz", action: "TICKET_REOPEN_TICKET_NOT_APPLIED", resource_type: "ticket", resource_id: "t-1", timestamp: iso(HOUR), details: { attempt: "a-1" } });
    const tables = { tickets: [{ id: "t-1", history: [], archived_at: null, comments: [], last_modified: iso(9 * 24 * HOUR) }], audit_logs: audit };
    const r = await runTicketAuditDrain({ client: pagingDb(tables, 1000).client, deadlineAt: Date.now() + 10_000, now: NOW });
    expect(r.notAppliedWritten).toBe(0);
    expect(audit).toHaveLength(1502);
    expect(r.errors).toEqual([]);
  });
  it("fix pass (major 2): leg (a) keyset-pages every ticket modified in the window — a lost mirror on the 650th is reconciled", async () => {
    const tickets: Row[] = [];
    for (let i = 0; i < 650; i++) tickets.push({ id: `t-${pad(i)}`, org_id: ORG, archived_at: null, last_modified: iso(2 * HOUR + i * 1000), comments: [{ id: cid(i), user: "a@b", text: "x", date: iso(3 * HOUR) }] });
    const tables: Record<string, Row[]> = { tickets, ticket_comments: tickets.slice(1).map((_t, i) => ({ id: cid(i + 1) })), audit_logs: [] };
    const r = await runTicketAuditDrain({ client: pagingDb(tables).client, deadlineAt: Date.now() + 10_000, now: NOW });
    expect(r.ticketsRead).toBe(650);
    expect(r.mirrorsReconciled).toBe(1);
    expect(tables.ticket_comments.map((c) => c.id)).toContain(cid(0));
    expect(r.errors).toEqual([]);
  });
  it("fix pass (major 2): a run whose time runs out before the end of the window says so as an ERROR line (and truncated), and writes nothing it did not decide", async () => {
    const tables = {
      tickets: [{ id: "t-1", org_id: ORG, archived_at: null, last_modified: iso(HOUR), comments: [{ id: C1, text: "x", date: iso(HOUR) }], history: [] }],
      audit_logs: [{ id: "a-1", action: "TICKET_REOPEN_TICKET", resource_type: "ticket", resource_id: "t-1", org_id: ORG, timestamp: iso(HOUR), details: { historyAttempt: true } }],
    } as Record<string, Row[]>;
    const r = await runTicketAuditDrain({ client: pagingDb(tables).client, deadlineAt: Date.now() - 1, now: NOW });
    expect(r.truncated).toBe(true);
    expect(r.errors).toHaveLength(2);
    expect(r.errors.join(" ")).toMatch(/stopped before the end of the 7-day window of tickets[\s\S]*stopped before the end of the 7-day window of attempt rows/);
    expect(tables.audit_logs).toHaveLength(1);
    expect(tables.ticket_comments).toBeUndefined();
  });
  it("fix pass 2 (minor 5): a legacy comment whose id is not a UUID, or whose date is not ISO, is counted and skipped — it never fails the mirror read (22P02) for the rest; the window is compared on parsed times; a mirror carries the comment's mentions", async () => {
    const tables: Record<string, Row[]> = {
      tickets: [{ id: "t-1", org_id: ORG, archived_at: null, last_modified: iso(HOUR), history: [], comments: [
        { id: "legacy-7", text: "old id, recent date", date: iso(2 * HOUR) },
        { id: cid(1), text: "non-ISO date", date: "Tue Oct garbage" },
        { id: cid(2), text: "older than the window, by parsed time", date: new Date(NOW - 9 * 24 * HOUR).toUTCString() },
        { id: cid(3), text: "lost mirror @contractor", date: new Date(NOW - 2 * HOUR).toUTCString(), mentionedUserIds: [MENTION, "x"] },
      ] }],
      ticket_comments: [], audit_logs: [],
    };
    const r = await runTicketAuditDrain({ client: pagingDb(tables).client, deadlineAt: Date.now() + 10_000, now: NOW });
    expect(r.errors).toEqual([]);
    expect(r.commentsUndecidable).toBe(2);
    expect(r.mirrorsReconciled).toBe(1);
    expect(tables.ticket_comments).toEqual([expect.objectContaining({ id: cid(3), mentioned_uids: [MENTION] })]);
    // the string compare it replaces would have read the RFC-1123 date of cid(2) ("Mon, …") as later than the ISO bound
    expect(new Date(NOW - 9 * 24 * HOUR).toUTCString() > new Date(NOW - 7 * 24 * HOUR).toISOString()).toBe(true);
  });
  it("the cron runs it as one step (no new cron entry)", () => {
    const cron = src("app/api/cron/maintenance/route.ts");
    expect(cron).toContain("await runTicketAuditDrain({ client: sb as unknown as Parameters<typeof runTicketAuditDrain>[0][\"client\"], deadlineAt: auditDrainDeadlineAt });");
    expect(src("vercel.json")).not.toMatch(/ticket-audit/);
  });
});

describe("source pins", () => {
  it("LEAK-4 / EVID-1 / PERS-2: convertTicketToProject no longer reads or writes `history` from the browser — the link route writes the one line", () => {
    const p = src("lib/projects.ts");
    const fn = p.slice(p.indexOf("export async function convertTicketToProject"), p.indexOf("// ─── BULK CHECKOUT"));
    expect(fn).not.toMatch(/\.update\(\{\s*history/);
    expect(fn).not.toMatch(/history\.push\(/);
    expect(fn).not.toMatch(/from\("tickets"\)\s*\.update/);
    expect(fn).toContain('postProjectLink({ ticketId: input.ticketId, projectId: project.id!, converted: true })');
    expect(fn).toContain("linkedTicketId: ticket.id as string");
    expect(src("lib/ticketProjectClient.ts")).toContain('fetch("/api/tickets/project-link"');
  });
  it("DELIV-16 / DELIV-7 dw2: CheckInPanel's review_requested is an emit() of a COMPLIANCE kind, whose in-app leg writes each row through notifyCompliance (N15) — to exactly the audience it had (the owner, or the controllers, never the actor)", () => {
    const panel = src("components/documents/CheckInPanel.tsx");
    expect(panel).toMatch(/kind: "review_requested",[\s\S]{0,700}audience: \{ involved: targets\.filter\(\(u\) => u !== currentUser\.uid\) \},/);
    expect(src("lib/notificationKinds.ts")).toMatch(/review_requested:\s+\{[^}]*compliance: true/);
    expect(src("lib/notify/dispatch.ts")).toMatch(/KIND_META\[input\.kind\]\?\.compliance \|\| input\.inappRetry\)[\s\S]{0,600}notifyCompliance\(/);
  });
  it("PROJ-4: the check-in sends its session's project; PROJ-12: the collision notice links to the request", () => {
    expect(src("components/documents/CheckInPanel.tsx")).toContain("projectId: mySession.projectId ?? null,");
    expect(src("components/projects/IntakePanel.tsx")).toContain("const href = res.ok && res.ticketId ? `/requests/${res.ticketId}` : undefined;");
  });
  it("PROJ-8: the attach picker hides superseded / void / archived matches by default and labels them when shown; the export marks non-current documents", () => {
    const card = src("components/projects/ProjectDocumentsCard.tsx");
    expect(card).toContain(".select(\"id, document_number, title, name, status, archived_at\")");
    expect(card).toContain(".filter((r) => showNotCurrent || !r.notCurrent)");
    expect(src("lib/projectExport.ts")).toContain('notCurrent ? "NOT CURRENT" : "yes"');
  });
  it("GAP-114: the project page mounts the requests card; the request page mounts the project actions only once the column exists", () => {
    expect(src("app/(protected)/projects/[id]/page.tsx")).toContain("<ProjectRequestsCard orgId={project.orgId} projectId={project.id} />");
    expect(src("app/(protected)/requests/[id]/page.tsx")).toContain("ticket.projectId !== undefined && !ticket.archivedAt && (");
  });
});
