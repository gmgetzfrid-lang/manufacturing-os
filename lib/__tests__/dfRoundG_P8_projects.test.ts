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
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<typeof import("@/lib/capabilityPolicy")>()),
  loadCapabilityPolicyStrict: vi.fn(async () => h.policy),
}));

import { POST as projectLink } from "@/app/api/tickets/project-link/route";
import { projectRefOf } from "@/lib/ticketPage";
import { deliverableReference, isMissingProjectColumn, projectLinkAllowed, projectLinkHistoryEntry, referenceDeliverableInProject } from "@/lib/ticketProject";
import { deliverableStateOf, noteDeliverableNotInAnyRegister } from "@/lib/ticketHandback";
import { closeoutGateLines } from "@/lib/projects";
import { computeTransition, rowToTicket } from "@/lib/ticketTransitions";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { runTicketAuditDrain, mirrorRowFor, historyNamesAttempt } from "@/lib/ticketAuditDrain";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";

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
  h.caller.tables.projects = [{ id: P1, org_id: ORG, name: "Turnaround", status: "active" }, { id: P2, org_id: ORG, name: "Old job", status: "active" }];
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
  it("a published deliverable of a request linked later is put on the project's register as a REFERENCE (doc_added) — never a copy", async () => {
    seed({ metadata: { deliverable: { state: "published", version_id: "v-1", revision_label: "2", document_id: "d-1" } } });
    const upserts: Row[] = [];
    const sb = h.admin as MemoryState;
    sb.afterWrite = undefined;
    const r = await referenceDeliverableInProject({
      from: (t: string) => ({
        upsert: (row: Row, opts: Row) => { upserts.push({ t, row, opts }); return { select: async () => ({ data: [{ id: "pd-1" }], error: null }) }; },
        insert: async (row: Row) => { upserts.push({ t, row }); return { error: null }; },
      }),
    }, { orgId: ORG, projectId: P1, documentId: "d-1", ticketId: T, ticketNumber: "KE-26-0042", revisionLabel: "2", actorId: "u-req", actorName: "req@plant.io" });
    expect(r).toBeNull();
    expect(upserts[0]).toMatchObject({ t: "project_documents", row: { project_id: P1, document_id: "d-1", source: "manual" }, opts: { onConflict: "project_id,document_id", ignoreDuplicates: true } });
    expect(upserts[1]).toMatchObject({ t: "project_activity", row: { type: "doc_added", metadata: expect.objectContaining({ documentId: "d-1", ticketId: T }) } });
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

describe("pure helpers", () => {
  it("projectRefOf: the column first; before the paste (undefined) the intake collision's project as today; a recorded unlink means none", () => {
    expect(projectRefOf({ intake_collision: { projectId: P2 } }, P1)).toBe(P1);
    expect(projectRefOf({ intake_collision: { projectId: P2 } }, undefined)).toBe(P2);
    expect(projectRefOf({ intake_collision: { projectId: P2 } }, null)).toBe(P2);
    expect(projectRefOf({ intake_collision: { projectId: P2 }, project_link: { projectId: null } }, null)).toBeNull();
    expect(projectRefOf(undefined)).toBeNull();
  });
  it("isMissingProjectColumn / projectLinkAllowed / the history line", () => {
    expect(isMissingProjectColumn({ code: "42703", message: 'column "project_id" does not exist' })).toBe(true);
    expect(isMissingProjectColumn({ code: "PGRST204", message: "" })).toBe(true);
    expect(isMissingProjectColumn({ code: "42703", message: 'column "library_id" does not exist' })).toBe(false);
    expect(isMissingProjectColumn({ code: "23514", message: "project_id" })).toBe(false);
    expect(projectLinkAllowed({ isRequester: false, managesTickets: false, managesProject: false })).toBe(false);
    expect(projectLinkAllowed({ isRequester: false, managesTickets: false, managesProject: true })).toBe(true);
    expect(projectLinkHistoryEntry({ kind: "unlinked", projectName: "X", email: "a@b", role: "Viewer", now: LM })).toMatchObject({ action: "Unlinked from project", user: "a@b", date: LM });
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
  it("SM-4: a reopen clears the archive's claim (archive_id) in the same update; REGRESSION: no claim → the updates carry no archive_id; a terminal transition never clears one", () => {
    const actor = { uid: "u-req", email: "req@plant.io", role: "Viewer" };
    const row = { id: T, org_id: ORG, ticket_id: "KE", title: "t", request_type: "Revision", status: "CLOSED", requester_id: "u-req", history: [], attachments: [], comments: [], archive_id: "arch-1", archived_at: null, last_modified: LM, revision_count: 1 };
    const input = { actionType: "reopen_ticket", actionLabel: "Reopen Ticket", actor, comment: "again" } as unknown as Parameters<typeof computeTransition>[1];
    expect(computeTransition(rowToTicket(row), input).updates.archive_id).toBeNull();
    expect("archive_id" in computeTransition(rowToTicket({ ...row, archive_id: null }), input).updates).toBe(false);
    const cancel = { actionType: "cancel_request", actionLabel: "Cancel Request", actor, comment: "dup", outcome: "duplicate" } as unknown as Parameters<typeof computeTransition>[1];
    expect("archive_id" in computeTransition(rowToTicket({ ...row, status: "DRAFTING", archive_id: null }), cancel).updates).toBe(false);
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
  const OLD = "2026-10-21T10:00:00.000Z"; // past the settle time
  const drainDb = () => {
    const s = freshState();
    return { s, client: makeSupabase(s) as unknown as Parameters<typeof runTicketAuditDrain>[0]["client"] };
  };
  it("pure: the mirror row is the route's shape; history proves an attempt landed only by its id", () => {
    expect(mirrorRowFor({ id: T, org_id: ORG }, { id: "c-1", user: "a@b", role: "Engineer", text: "fix", type: "Revision", date: OLD, authorUid: "u-1" }))
      .toEqual({ id: "c-1", org_id: ORG, ticket_id: T, author_uid: "u-1", author_email: "a@b", author_role: "Engineer", body: "fix", type: "Revision", category: null, mentioned_uids: [], created_at: OLD });
    expect(mirrorRowFor({ id: T, org_id: ORG }, { text: "no id" })).toBeNull();
    expect(historyNamesAttempt([{ action: "x", attempt: "a-1" }], "a-1")).toBe(true);
    expect(historyNamesAttempt([{ action: "x" }], "a-1")).toBe(false);
  });
  it("(a) a JSONB comment with no ticket_comments row is mirrored; one already there (even soft-deleted) is never touched", async () => {
    const { s, client } = drainDb();
    s.tables.tickets = [{ id: T, org_id: ORG, last_modified: OLD, archived_at: null, comments: [
      { id: "c-1", user: "a@b", text: "lost mirror", date: OLD }, { id: "c-2", user: "a@b", text: "mirrored", date: OLD },
    ] }];
    s.tables.ticket_comments = [{ id: "c-2", ticket_id: T, deleted_at: OLD }];
    s.tables.audit_logs = [];
    const r = await runTicketAuditDrain({ client, deadlineAt: Date.now() + 10_000, now: NOW });
    expect(r.mirrorsReconciled).toBe(1);
    expect(s.tables.ticket_comments.map((c) => c.id).sort()).toEqual(["c-1", "c-2"]);
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
